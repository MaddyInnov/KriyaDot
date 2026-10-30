-- SPDX-License-Identifier: Apache-2.0
-- KriyaDot as an ACP provider in Neovim via avante.nvim's ACP support.
--
-- Add this `acp_providers` entry to your avante setup() call (e.g. in
-- your lazy.nvim spec for "yetone/avante.nvim"). The verified part is
-- the command line: avante spawns `mvp-server acp --bot coder` and
-- speaks ACP (JSON-RPC over stdio) to it.
--
-- Use an ABSOLUTE path for `command` if mvp-server is not on your
-- PATH — e.g. "/home/you/kriyadot/dist/mvp-server" for the standalone
-- binary built by scripts/build-server-binary.sh.
--
-- Change the bot with the --bot arg: any bot id from seed/bots.json
-- (helper is the server default when --bot is omitted; coder is the
-- coding bot and the right default for editor use).
--
-- CodeCompanion.nvim users: CodeCompanion's ACP adapters take the
-- same command/args pair — define an ACP adapter whose command is
-- "mvp-server" and whose args are { "acp", "--bot", "coder" }.

require("avante").setup({
  acp_providers = {
    kriyadot = {
      command = "mvp-server",
      args = { "acp", "--bot", "coder" },
      env = {},
    },
  },
  -- Then select it in avante, e.g.:
  -- provider = "kriyadot",
})
