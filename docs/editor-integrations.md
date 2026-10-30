<!-- SPDX-License-Identifier: Apache-2.0 -->

# Editor integrations via ACP (Zed, JetBrains, Neovim)

KriyaDot can run **as an agent inside your editor**. Its ACP server
mode serves any bot as an [Agent Client Protocol](https://agentclientprotocol.com)
agent: the editor spawns the process and speaks newline-delimited
JSON-RPC 2.0 over stdio — `initialize`, `session/new`,
`session/prompt`, `session/cancel` — while tool approvals surface in
the editor as native `session/request_permission` prompts
(`allow_once` / `reject_once`). No KriyaDot window or browser tab is
involved.

Machine-usable snippets for each editor live in
[`examples/editors/`](../examples/editors/).

## The one command every setup uses

```sh
mvp-server acp --bot coder
```

Verified against the source (`apps/api/src/cli.ts`, `ACP_USAGE`) and
the built server:

- `mvp-server` is the standalone server binary produced by
  `scripts/build-server-binary.sh` (output: `dist/mvp-server`).
  Editors spawn processes without your shell's PATH customisations —
  if `mvp-server` is not on the editor's PATH, use the **absolute
  path** to the binary as the command.
- From a source checkout instead of the binary, the identical mode is:

  ```sh
  node /path/to/mvp/apps/api/dist/index.js acp --bot coder
  ```

  (after `npm run build` from the repo root).
- `--bot <id>` picks the bot; any id from `seed/bots.json` works
  (`scout`, `coder`, `helper`, `data-analyst`, `code-reviewer`, …).
  When `--bot` is omitted the default is `helper`. For editor work,
  `coder` is the right default — it is the seed bot with
  read/write/run tools for the workspace.
- `--help` prints the usage text. There are no other flags.
- Stdout is the protocol channel; diagnostics go to stderr. The
  process serves until the client closes stdin.

The bot works in the workspace directory KriyaDot is configured with
(`WORKSPACE_DIR`, else `<DATA_DIR>/workspace`) — point your provider
key setup (Providers page, or `GROQ_API_KEY` etc. in the server
environment) at the same instance configuration you use outside the
editor; editor sessions share the instance's bots, skills, memory and
governance policy.

## Zed

1. Open your Zed settings file (`zed: open settings file`; on
   Linux/macOS it is `~/.config/zed/settings.json`).
2. Merge in the snippet from
   [`examples/editors/zed-settings.json`](../examples/editors/zed-settings.json):

   ```json
   "agent_servers": {
     "KriyaDot": {
       "command": "mvp-server",
       "args": ["acp", "--bot", "coder"],
       "env": {}
     }
   }
   ```
3. Restart Zed (or reload settings) and choose **KriyaDot** in the
   agent panel's external-agent selector. New threads then run
   against the `coder` bot; approval requests appear as Zed's
   native permission prompts.

## JetBrains IDEs (IntelliJ IDEA, WebStorm, PyCharm, …)

JetBrains IDEs with ACP support (2025.3 and later) read external
agents from an `acp.json` configuration file (Settings → Tools →
AI Assistant → Agents links to it):

- Linux: `~/.jetbrains/acp.json`
- macOS: `~/Library/Application Support/JetBrains/acp.json`
- Windows: `%APPDATA%\JetBrains\acp.json`

Put the snippet from
[`examples/editors/jetbrains-acp.json`](../examples/editors/jetbrains-acp.json)
there — the `agent_servers` shape is the same as Zed's:

```json
"agent_servers": {
  "KriyaDot": {
    "command": "mvp-server",
    "args": ["acp", "--bot", "coder"],
    "env": {}
  }
}
```

Then select **KriyaDot** in the AI chat's agent selector. Tool
approvals are presented by the IDE as ACP permission requests.

## Neovim

Any ACP client plugin works with the same command line. For
**avante.nvim**, add the `acp_providers` entry from
[`examples/editors/neovim-avante.lua`](../examples/editors/neovim-avante.lua)
to your `avante.setup()` call:

```lua
require("avante").setup({
  acp_providers = {
    kriyadot = {
      command = "mvp-server",
      args = { "acp", "--bot", "coder" },
      env = {},
    },
  },
})
```

For **CodeCompanion.nvim**, define an ACP adapter with the same pair:
command `mvp-server`, args `{ "acp", "--bot", "coder" }`.

## Verifying the integration

Do this before debugging editor settings — it proves the agent side
works, independent of any editor.

1. The command starts and prints usage:

   ```sh
   mvp-server acp --help
   ```

   Expected output:

   ```text
   Usage: mvp-server acp --bot <id>

   Serve a bot as an ACP (Agent Client Protocol) agent over stdio.
   The ACP client spawns this process; JSON-RPC flows on stdin/stdout,
   diagnostics on stderr.

   Options:
     --bot <id>   Bot id from the seed data (default: helper)
     --help       Show this help
   ```

2. Speak ACP to it directly — send one `initialize` and one
   `session/new` request on stdin:

   ```sh
   printf '%s\n%s\n' \
     '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' \
     '{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/tmp","mcpServers":[]}}' \
     | mvp-server acp --bot coder
   ```

   Expected responses (captured verbatim from the built server; the
   `sessionId` value will differ). Note: a `[seed] loaded …` log line
   may precede the JSON lines on some installs — the JSON-RPC lines
   are the protocol:

   ```json
   {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":false,"promptCapabilities":{"image":false,"audio":false,"embeddedContext":true},"mcpCapabilities":{"http":false,"sse":false}},"authMethods":[],"agentInfo":{"name":"kriyadot","title":"KriyaDot","version":"0.1.0"}}}
   {"jsonrpc":"2.0","id":2,"result":{"sessionId":"sess_mvtxyfek_voese5br"}}
   ```

   `agentInfo.name` is `kriyadot`, `protocolVersion` is `1`, and
   `session/new` returns a session id — the handshake every ACP
   client performs first. If you instead see
   `[acp] unknown bot "<id>"` on stderr and exit code 1, the `--bot`
   id is not in the instance's seed/configured bots.
3. In the editor: open the agent panel, select KriyaDot, and send
   "list the files in this project". A working integration streams
   the reply into the panel and, the first time the bot wants to
   write a file or run a command, shows the editor's permission
   prompt (Approve/Deny) — that prompt **is** KriyaDot's governance
   approval, bridged over ACP.

## Troubleshooting

- **Editor says the agent failed to start** — use the absolute path
  to `mvp-server` (editors don't inherit your shell PATH), and run
  the verification probe above in a terminal to see stderr.
- **Agent starts but answers are empty / provider errors** — the bot
  still needs a model provider key configured for the instance
  (Providers page or environment). ACP changes the *client*, not the
  model setup.
- **Wrong personality/tools** — you are probably on the default
  `helper` bot. Editor coding work wants `--bot coder` (or
  `--bot code-reviewer` for review-only sessions).

## VS Code (Wave-6, CA-29)

VS Code does not embed ACP in the core editor, so KriyaDot ships a
minimal extension in [`examples/editors/vscode/`](../examples/editors/vscode/)
(sideload `.vsix` only — `bash build-vsix.sh`, then
`code --install-extension kriyadot-vscode-0.1.0.vsix`; no marketplace
publish). It spawns the same `mvp-server acp --bot coder` command and
speaks ACP over stdio, adding the VS Code-native surfaces:

- **KriyaDot: Ask About Selection** — the current selection (or file)
  is attached as embedded context to the prompt.
- **KriyaDot: Review Proposal as Diff** — proposed content opens in the
  native `vscode.diff` editor against the original file.
- **KriyaDot: Send Diagnostics to Agent** — pushes the Problems panel
  diagnostics (`vscode.languages.getDiagnostics()`) to the agent.
- ACP `session/request_permission` requests surface as VS Code modal
  Approve/Reject prompts — the governance approval, in-editor.

JetBrains remains configuration-only via ACP (see above and
`examples/editors/jetbrains/README.md`).
