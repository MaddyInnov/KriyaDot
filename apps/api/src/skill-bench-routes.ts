// SPDX-License-Identifier: Apache-2.0
// Skill bench routes (§1.20): run the agent-runtime skill-bench against a
// stored skill using a bot's configured provider.
//
//   POST /:name/bench { botId, cases: [{ prompt, expectContains?, expectTool? }] }
//
// The turn runner is INJECTED by the host: in production it builds the
// bot's provider from the provider factory and runs one isolated turn
// with the skill's instructions prepended; in tests it is a mock. This
// module never constructs providers itself.
//
// HOST WIRING (index.ts):
//   app.use('/api/skills', createSkillBenchRouter({
//     store: userSkillStore,
//     getBot: (id) => botsById.get(id),
//     runTurn: async (bot, req) => { /* provider-factory-backed turn */ },
//     audit: (action, fields) => governance.audit(action, fields),
//   }));

import express, { type Router } from 'express';
import { runSkillBench, validateSkillBenchCases, type SkillBenchCase } from '@mvp/agent-runtime';
import type { BotConfig, UserSkillStore } from '@mvp/agent-runtime';

export interface SkillBenchRouterDeps {
  store: UserSkillStore;
  getBot: (botId: string) => BotConfig | undefined;
  /** Run one bench turn for the bot (host injects the provider factory). */
  runTurn: (
    bot: BotConfig,
    req: { prompt: string; skillName: string; skillInstructions: string; caseId: string },
  ) => Promise<{ response: string; toolsUsed?: string[] }>;
  audit?: (action: string, fields: { actor?: string; botId?: string; detail?: unknown }) => void;
}

export function createSkillBenchRouter(deps: SkillBenchRouterDeps): Router {
  const router = express.Router();

  router.post('/:name/bench', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const botId = typeof body.botId === 'string' ? body.botId : '';
    const bot = deps.getBot(botId);
    if (!bot) {
      res.status(404).json({ error: `Unknown bot: "${botId}"` });
      return;
    }
    const rec = deps.store.get(req.params.name);
    if (!rec) {
      res.status(404).json({ error: `Unknown skill: "${req.params.name}"` });
      return;
    }
    if (rec.status === 'draft' || rec.status === 'rejected') {
      res.status(400).json({ error: `Cannot bench a ${rec.status} skill proposal.` });
      return;
    }
    const caseErrors = validateSkillBenchCases(body.cases);
    if (caseErrors.length) {
      res.status(400).json({ error: `Invalid bench cases: ${caseErrors.join('; ')}` });
      return;
    }
    let instructions: string;
    try {
      instructions = deps.store.readSkillFileContent(rec.name).instructions;
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
    try {
      const report = await runSkillBench({
        skill: { name: rec.name, instructions },
        cases: body.cases as SkillBenchCase[],
        runTurn: (benchReq) =>
          deps.runTurn(bot, {
            prompt: benchReq.prompt,
            skillName: benchReq.skillName,
            skillInstructions: benchReq.skillInstructions,
            caseId: benchReq.caseId,
          }),
      });
      deps.audit?.('skill.bench_run', {
        botId,
        detail: { skill: rec.name, total: report.total, passed: report.passed, passRate: report.passRate },
      });
      res.json({ ok: true, report });
    } catch (err) {
      res.status(500).json({ error: `Skill bench failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  return router;
}
