---
name: driving-kriyadot
description: Drive a KriyaDot instance from an external agent — via its HTTP API, the kriyadot CLI, or its MCP server — to run bot turns, manage threads and routines, and handle approval-gated actions.
activation:
  keywords: ["drive kriyadot", "kriyadot api", "kriyadot cli", "external agent"]
  patterns: ["\\bcontrol (the )?kriyadot\\b"]
  exclude: ["inside kriyadot"]
---

# Driving KriyaDot

KriyaDot is a local-first AI agent platform: bots with tools, skills,
and MCP servers, behind deny-by-default governance (sensitive actions
pause for a human approval). This skill teaches an **external** agent —
Claude Code, Cursor, or any agent that can run shell commands or make
HTTP calls — how to operate a KriyaDot instance it does **not** run
inside of. No KriyaDot runtime or extension is required: everything
below is plain HTTP, a plain CLI, or a plain MCP server.

Pick one surface and stick to it per task:

| Surface | Use when |
| --- | --- |
| `kriyadot` CLI | You have a shell. Simplest, handles auth for local servers automatically. |
| HTTP API | You are writing code, or the CLI is not installed. |
| MCP server | Your host already speaks MCP and you want KriyaDot's tools as native tools. |

## 0. Prerequisites and auth

- A KriyaDot server must be running. Default base URL:
  `http://localhost:4000` (the desktop app serves the same API on
  `http://127.0.0.1:4567`).
- Health check (no auth needed): `GET /api/health` → `{"ok":true,...}`.
- Every other `/api/*` route requires the loopback bearer token:

  ```
  Authorization: Bearer <token>
  ```

  The server mints a fresh token on every boot and writes it to
  `<dataDir>/.api-token` (mode 0600; `dataDir` defaults to `./data`
  under the server's working directory, or `$DATA_DIR`). Read it from
  that file — never guess it, never print it into logs or chat, and
  never send it anywhere except the KriyaDot API itself.
- The CLI resolves this token automatically for loopback URLs. For a
  remote server: `kriyadot login --api <url> --token <t>` once, or set
  `KRIYADOT_API_URL` / `KRIYADOT_TOKEN`.

## 1. The `kriyadot` CLI

Installed as the `kriyadot` binary (from a source checkout:
`node packages/cli/dist/cli.js …` after `npm run build`).

```sh
kriyadot bots list                                   # see bot ids first — never guess one
kriyadot chat coder "fix the failing cart tests"     # one-shot ask (interactive REPL on a TTY with no message)
kriyadot run --bot coder --message "run the test suite" --format json
kriyadot run --bot coder --message "watch the deploy" --daemon deploy   # named, resumable session
kriyadot send deploy "did it finish?"                # follow-up to a named session
kriyadot sessions                                    # list named sessions
kriyadot threads list --bot coder                    # past conversations
kriyadot threads show <threadId>
kriyadot routines list                               # scheduled automations
kriyadot routines run <routineId>                    # trigger one now
kriyadot models list                                 # what models/providers are usable
kriyadot mcp list                                    # installed MCP servers + health
kriyadot status                                      # global pause state
kriyadot pause                                       # pause ALL new work (chat, routines, watchers)
kriyadot resume
```

Rules for CLI use:

- Prefer `--format json` for `run`/`chat` in scripts (one JSON object:
  `ok`, `bot`, `content`, `usage`, or `error`); `--format jsonl`
  streams every runtime event as one JSON object per line.
- Exit codes: 0 success, 1 error, 2 usage error. A spend-cap /
  usage-limit stop is a distinct resumable outcome — report it, do not
  retry in a loop.
- Tool approvals during an interactive turn ask `[y/N]` on the TTY.
  In non-interactive runs, an approval-gated tool call pauses the turn
  until a human decides it via the API/UI (see §2) — do not pass
  `--auto-approve` unless the user explicitly asked for unattended
  approval.

## 2. The HTTP API

Base: `<base>/api`. All requests carry the bearer header above;
bodies are JSON. Verified core routes:

| Method & path | Purpose |
| --- | --- |
| `GET /api/health` | Liveness (auth-exempt) |
| `GET /api/bots` | List bots (`id`, `name`, `model`, `provider`) |
| `GET /api/models` | List usable models |
| `POST /api/chat` | Run one bot turn — **streaming SSE**, see below |
| `GET /api/chat/threads?botId=<id>&limit=<n>` | List chat threads |
| `GET /api/chat/threads/<id>/messages` | Read a thread |
| `POST /api/chat/threads/<id>/branch` | Fork a thread: body `{"fromMessageId": <n>, "title": "..."}` |
| `DELETE /api/chat/threads/<id>` | Delete a thread |
| `GET /api/routines` | List routines |
| `POST /api/routines/<id>/run-now` | Trigger a routine run |
| `GET /api/routines/<id>/runs?limit=<n>` | Past runs of a routine |
| `POST /api/approvals/<approvalId>` | Decide a pending approval: body `{"decision":"approved"}` or `{"decision":"denied"}` |
| `GET /api/mcp/servers` | Installed MCP servers + health |
| `GET /api/mcp/tools` | Tools the platform MCP server exposes |
| `GET /api/system/pause-state` | Global pause state |
| `POST /api/system/pause` / `POST /api/system/resume` | Pause / resume all new work |

### Running a turn: `POST /api/chat`

```sh
curl -N -X POST "$BASE/api/chat" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"botId":"coder","message":"The cart tests are failing. Find the bug and fix it."}'
```

Body fields: `botId` (required), `message` (required), `sessionId`
(optional — reuse one to continue a conversation), `model`,
`providerId`, `autoApprove` (optional booleans/strings; leave
`autoApprove` unset unless the user asked).

The response is **server-sent events**: lines of `data: {json}` where
each event has a `type`:

- `token` — assistant text chunk (`content`).
- `tool_call` — a tool is about to run (`call.name`,
  `approvalRequired`).
- `approval_required` — the turn is **paused** on a governance card
  (`approvalId`, `call`). It resumes only when a human decides via
  `POST /api/approvals/<approvalId>` (or the web UI). Surface the
  pending action to the user; do not decide it yourself unless the
  user explicitly delegated that specific approval.
- `tool_result` — a tool finished (`call.name`, `denied` when refused).
- `done` — turn complete (`usage` with token counts).
- `spend_cap_reached`, then `error` — a hard, resumable stop. Report
  it; do not retry.
- `error` — turn failed (`message`).

## 3. The platform MCP server

KriyaDot also serves its own tool registry **as** an MCP server, so an
MCP host can call KriyaDot's tools (and chat with a bot) natively,
with the same governance approvals enforced — require-approval tools
never execute silently over MCP either.

Stdio (the host spawns the process):

```json
{
  "mcpServers": {
    "kriyadot": {
      "command": "mvp-server",
      "args": ["--mcp-stdio"]
    }
  }
}
```

Or HTTP: start the server with `MCP_SERVER_PORT=<port>` set and the
platform MCP server is served on that port.

What you get:

- One MCP tool per tool in KriyaDot's registry (file, shell, web,
  notes, workflow, delegation tools — the exact list is live at
  `GET /api/mcp/tools`).
- A `chat` tool: `{ "message": "..." }` runs one turn with the
  platform's default bot and returns its reply.
- Read-only telemetry resources under `kriyadot://telemetry/*` for
  diagnosing runs.
- Optional lockdown: with `MCP_CONNECTION_CLASS=read-only-assistant`
  on the server, external clients can read freely but the only write
  permitted is appending quarantined annotations.

## 4. Operating rules

1. **Discover before you act.** `GET /api/bots` / `kriyadot bots list`
   first; bot ids in this skill (`coder`, `helper`) are seed examples,
   not guarantees.
2. **Approvals belong to the human.** An `approval_required` event is
   a governance pause, not an error and not a prompt for you to
   self-approve. Report what is being asked (tool, arguments) and wait
   for the user's decision unless they explicitly delegated it.
3. **One conversation = one sessionId.** Reuse it for follow-ups;
   minting a new one starts a fresh conversation with no memory of the
   previous turn.
4. **Respect the global pause.** If `pause-state` says paused, new
   work will not start — say so instead of retrying.
5. **Keep the token secret.** It is a full-control credential for the
   instance. Read it from `.api-token` at runtime; do not copy it into
   files, prompts, or messages.
6. **Verify outcomes, don't assume them.** After asking a bot to
   change something, check the result (thread messages, a follow-up
   turn, or the underlying artefact) before reporting success.

See `references/api-endpoints.md` in this pack for the endpoint table
in copy-paste form.
