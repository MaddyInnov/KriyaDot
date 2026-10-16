# KriyaDot TUI

<!-- SPDX-License-Identifier: Apache-2.0 -->

Terminal client for KriyaDot — chat with your bots, approve tool calls, and
inspect workflows/activity/memory from the command line. Codync parity: Codync
ships a TUI client; this is KriyaDot's.

Built with [Ink](https://github.com/vadimdemedes/ink) (React for CLIs). It
talks to the same local API (`apps/api`) as the web client over HTTP + SSE —
no separate protocol.

## Install

```bash
# from the repo root
npm run build --workspace=@mvp/tui
# run it
node apps/tui/dist/index.js
# or via the bin (after npm install links workspaces)
kriyadot-tui
```

The API must be running first (`npm run dev:api` → default
`http://localhost:4000`).

## Usage

```
kriyadot-tui [--api <url>] [--bot <id>] [--theme <name>]
```

| Flag      | Env                 | Default                |
|-----------|---------------------|------------------------|
| `--api`   | `KRIYADOT_API_URL`  | `http://localhost:4000`|
| `--bot`   | —                   | (bot picker)           |
| `--theme` | `KRIYADOT_TUI_THEME`| `dark`                 |

Config persists to `~/.kriyadot/tui.json` (`apiUrl`, `defaultBot`, `theme`).
Override the config dir with `KRIYADOT_CONFIG_DIR`.

## Keybindings

| Key            | Action                              |
|----------------|-------------------------------------|
| `↑` / `↓`      | Navigate bot / model lists          |
| `Enter`        | Select bot / model, submit message  |
| `y` / `n`      | Approve / deny a pending approval   |
| `Ctrl+T`       | Cancel the running turn             |
| `Esc`          | Back to chat from a sub-view        |
| `Ctrl+C`       | Quit                                |

## Slash commands

| Command      | Action                                  |
|--------------|-----------------------------------------|
| `/bots`      | Pick a bot to chat with                 |
| `/model`     | List models (arrow keys, Enter switches)|
| `/model <id>`| Switch this bot to a model id directly  |
| `/workflows` | Workflows + recent runs (read-only)     |
| `/memory`    | This bot's memory summary (read-only)   |
| `/activity`  | Recent activity from the audit log      |
| `/theme <name>` | `light` `dark` `midnight` `porcelain` `ocean` |
| `/clear`     | Clear the chat transcript               |
| `/help`      | Show commands                           |
| `/quit`      | Exit                                    |

## Approval flow

When a bot wants to run an approval-gated tool, the chat stream pauses with
an inline prompt showing the tool name and its arguments. Press `y` to approve
or `n` to deny — the turn resumes on the same stream. The decision goes
through `POST /api/approvals/:id`, exactly like the web client.

## Themes

The five web-app themes (`apps/web/lib/theme.ts`, `globals.css`) are mapped to
terminal palettes in `src/themes.ts`: `light`, `dark`, `midnight`, `porcelain`,
`ocean`. Switch live with `/theme <name>`; the choice is saved to
`~/.kriyadot/tui.json`.

## Tests

```bash
npm test --workspace=@mvp/tui   # 38 tests: command parser, API client (mocked fetch), SSE pump, themes, config
```
