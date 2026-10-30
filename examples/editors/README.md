<!-- SPDX-License-Identifier: Apache-2.0 -->

# Editor integration snippets

Machine-usable configuration snippets for running KriyaDot as an
external ACP agent in your editor. Full setup + verification guide:
[`docs/editor-integrations.md`](../../docs/editor-integrations.md).

| File | Editor | Where it goes |
| --- | --- | --- |
| `zed-settings.json` | Zed | Merge the `agent_servers` block into `~/.config/zed/settings.json` |
| `jetbrains-acp.json` | JetBrains IDEs (2025.3+, ACP support) | `~/.jetbrains/acp.json` (Linux) — see file comments for macOS/Windows |
| `neovim-avante.lua` | Neovim (avante.nvim) | Add the `acp_providers` entry to your `avante.setup()` call |

Every snippet runs the same verified command:

```sh
mvp-server acp --bot coder
```

(`mvp-server` = the standalone binary from
`scripts/build-server-binary.sh`; from a source checkout use
`node apps/api/dist/index.js acp --bot coder` as the command/args.)
