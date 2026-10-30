<!-- SPDX-License-Identifier: Apache-2.0 -->

# KriyaDot in JetBrains IDEs (CA-29, ACP bridge)

JetBrains IDEs (2025.3+) speak ACP natively, so there is no plugin to
build: the bridge is configuration. Copy `../jetbrains-acp.json` (repo
root `examples/editors/jetbrains-acp.json`) to your IDE's `acp.json`:

- Linux: `~/.jetbrains/acp.json`
- macOS: `~/Library/Application Support/JetBrains/acp.json`
- Windows: `%APPDATA%\JetBrains\acp.json`

```json
{
  "agent_servers": {
    "KriyaDot": {
      "command": "mvp-server",
      "args": ["acp", "--bot", "coder"],
      "env": {}
    }
  }
}
```

Then pick **KriyaDot** in the AI chat agent selector. What maps where:

| JetBrains surface | KriyaDot side |
| --- | --- |
| Agent chat panel | ACP `session/prompt` turns on the `coder` bot |
| Permission popups | ACP `session/request_permission` = KriyaDot governance approvals |
| Editor selection in chat context | The IDE attaches selection context to ACP prompts (embeddedContext capability) |
| Problems panel | Ask the agent in chat; for an automated flow use the VS Code extension's diagnostics push as the reference implementation |

Full verification steps (probe the ACP handshake before debugging IDE
settings) live in `docs/editor-integrations.md`.
