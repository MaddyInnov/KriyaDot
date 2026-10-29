// SPDX-License-Identifier: Apache-2.0
// Per-expert tool hot toggle (Octop #38): flip ONE tool in a bot's
// tools[] config without resaving the whole bot config.
//
//   PUT /bots/:id/tools/:toolName { enabled: boolean }
//     → { ok, botId, tool, enabled, tools }   (the full resulting list)
//
// The roster is otherwise untouched: enabling appends the tool when
// absent, disabling removes it, and every other field/list on the bot
// is left exactly as it was. When the host supplies its known-tool list
// (the live tool registry), unknown tool names are rejected with 400 so
// typos can't silently create dead config.
//
// HOST WIRING (index.ts):
//   app.use('/api/bots', createBotToolsRouter({
//     getBot: (id) => botsById.get(id),
//     setBotTools: (id, tools) => { /* mutate + persist (roster import) */ },
//     knownTools: () => [...toolRegistry.keys()],
//     audit: (action, fields) => governance.audit(action, fields),
//   }));

import express, { type Router } from 'express';
import type { BotConfig } from '@mvp/agent-runtime';

export interface BotToolsRouterDeps {
  getBot: (botId: string) => BotConfig | undefined;
  /**
   * Persist a bot's new tool list (host mutates the in-memory bot and,
   * for imported bots, rewrites the roster import). Returns the stored
   * list, or void to echo the computed list back.
   */
  setBotTools: (botId: string, tools: string[]) => string[] | void;
  /** Live registry tool names; when provided, unknown names → 400. */
  knownTools?: () => string[];
  audit?: (action: string, fields: { actor?: string; botId?: string; detail?: unknown }) => void;
}

/** Pure toggle: returns the new tools[] (input array is not mutated). */
export function toggleBotTool(tools: string[], toolName: string, enabled: boolean): string[] {
  const has = tools.includes(toolName);
  if (enabled && !has) return [...tools, toolName];
  if (!enabled && has) return tools.filter((t) => t !== toolName);
  return [...tools];
}

export function createBotToolsRouter(deps: BotToolsRouterDeps): Router {
  const router = express.Router();

  router.put('/:id/tools/:toolName', (req, res) => {
    const bot = deps.getBot(req.params.id);
    if (!bot) {
      res.status(404).json({ error: `Unknown bot: "${req.params.id}"` });
      return;
    }
    const toolName = req.params.toolName;
    if (deps.knownTools && !deps.knownTools().includes(toolName)) {
      res.status(400).json({ error: `Unknown tool: "${toolName}"` });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.enabled !== 'boolean') {
      res.status(400).json({ error: '"enabled" must be a boolean' });
      return;
    }
    const next = toggleBotTool(bot.tools ?? [], toolName, body.enabled);
    const stored = deps.setBotTools(bot.id, next) ?? next;
    deps.audit?.('bot.tool_toggled', {
      actor: 'user',
      botId: bot.id,
      detail: { tool: toolName, enabled: body.enabled },
    });
    res.json({ ok: true, botId: bot.id, tool: toolName, enabled: body.enabled, tools: stored });
  });

  return router;
}
