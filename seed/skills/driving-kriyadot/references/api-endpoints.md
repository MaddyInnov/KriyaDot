<!-- SPDX-License-Identifier: Apache-2.0 -->

# KriyaDot HTTP API — endpoint reference

Companion reference for the `driving-kriyadot` skill. Base URL
defaults to `http://localhost:4000` (desktop app: `http://127.0.0.1:4567`).
Every route below is under `/api` and — except `GET /api/health` —
requires `Authorization: Bearer <token>`, where the token is the
per-boot loopback token the server writes to `<dataDir>/.api-token`.

| Method & path | Body / query | Returns |
| --- | --- | --- |
| `GET /api/health` | — (auth-exempt) | `{"ok":true,...}` |
| `GET /api/bots` | — | array of bots (`id`, `name`, `model`, `provider`, …) |
| `GET /api/models` | — | array of models (`providerId`, `id`, `name`, `free?`) |
| `POST /api/chat` | `{"botId","message","sessionId"?,"model"?,"providerId"?,"autoApprove"?}` | SSE stream of `data:` events (`token`, `tool_call`, `approval_required`, `tool_result`, `done`, `spend_cap_reached`, `error`) |
| `GET /api/chat/threads` | `?botId=&limit=` | `{"ok":true,"threads":[…]}` |
| `GET /api/chat/threads/<id>/messages` | — | `{"ok":true,"messages":[…]}` |
| `POST /api/chat/threads/<id>/branch` | `{"fromMessageId":<n>,"title"?}` | `{"ok":true,"thread":{…}}` |
| `DELETE /api/chat/threads/<id>` | — | `{"ok":true}` |
| `GET /api/routines` | — | `{"ok":true,"routines":[…]}` |
| `POST /api/routines/<id>/run-now` | — | `{"ok":true,"runId":"…"}` |
| `GET /api/routines/<id>/runs` | `?limit=` | `{"ok":true,"runs":[…]}` |
| `POST /api/approvals/<approvalId>` | `{"decision":"approved"\|"denied"}` | decides a governance card; a paused chat turn resumes |
| `GET /api/mcp/servers` | — | array of MCP servers (`id`, `label`, `enabled`, `health`) |
| `GET /api/mcp/tools` | — | tools exposed by the platform MCP server |
| `GET /api/system/pause-state` | — | `{"paused":bool,"pausedAt":…,"reason":…}` |
| `POST /api/system/pause` | `{"actor":"…"}` | pauses ALL new work |
| `POST /api/system/resume` | `{"actor":"…"}` | resumes after a global pause |

Errors are JSON: `{"ok":false,"error":"…"}` with the matching HTTP
status (401 without a valid bearer token).
