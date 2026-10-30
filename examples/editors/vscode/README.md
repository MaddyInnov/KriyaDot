<!-- SPDX-License-Identifier: Apache-2.0 -->

# KriyaDot for VS Code (CA-29, sideload)

A minimal VS Code extension that talks to KriyaDot over ACP
(`mvp-server acp --bot coder`, stdio JSON-RPC — see
`docs/editor-integrations.md`):

- **Ask About Selection** — selection-as-context prompting.
- **Review Proposal as Diff** — proposed content in the native
  `vscode.diff` editor.
- **Send Diagnostics to Agent** — pushes `vscode.languages.getDiagnostics()`
  to the agent.
- Tool approvals arrive as ACP `session/request_permission` and are
  answered with native modal prompts — governance is not bypassed.

Build a sideloadable package:

```sh
bash build-vsix.sh
code --install-extension kriyadot-vscode-0.1.0.vsix
```

No marketplace publish is performed or implied.
