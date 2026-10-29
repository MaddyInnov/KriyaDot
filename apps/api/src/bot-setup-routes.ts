// SPDX-License-Identifier: Apache-2.0
// "Set me up" REST API (W12a) — mounted at /api/bots/setup.
//
//   POST /propose  { sentence }  → { ok, proposal }
//        Runs ONE setup turn (the chief/default bot's provider) and
//        returns a proposed bot config. Creates NOTHING — the proposal
//        is inert data the client holds for the approval card.
//   POST /apply    { proposal }  → { ok, bot, routines, skippedRoutines }
//        The approval action. Re-validates the proposal against the
//        live catalogs (tools filtered to the real registry again),
//        creates the bot via the roster-import persistence path (the
//        same one roster import + approved chief creates use), then
//        creates each suggested routine through RoutineStore — the
//        existing routine path, so schedules validate identically.
//        Rejecting a proposal = never calling /apply; there is no
//        server-side proposal state to clean up.
//
// HOST WIRING (index.ts):
//   app.use('/api/bots/setup', createBotSetupRouter({
//     dataDir: config.dataDir,
//     getBots: () => seed.bots,
//     toolNames: () => [...toolRegistry.keys()],
//     mcpServerNames: () => Object.keys(mcpServers),
//     skillNames: () => seedSkillNames,
//     routineStore,
//     resolveSetupProvider: () => { ...chief/default bot + createProvider... },
//     audit: (action, fields) => governance.audit(action, fields),
//   }));

import express, { type Router } from 'express';
import {
  generateBotSetupProposal,
  sanitizeBotSetupProposal,
  type BotSetupProposal,
  type LLMProvider,
} from '@mvp/agent-runtime';
import type { BotConfig } from '@mvp/agent-runtime';
import type { RoutineStore, BotRoutine } from './bot-routines.js';
import { validateRoutineSchedule, type RoutineSchedule } from './routine-schedules.js';
import { appendRosterImport } from './bot-roster-routes.js';
import { allocateBotWorkspace } from './bot-workspace-alloc.js';

export interface BotSetupRouterDeps {
  dataDir: string;
  getBots: () => BotConfig[];
  toolNames: () => string[];
  mcpServerNames: () => string[];
  skillNames: () => string[];
  routineStore: RoutineStore;
  /** Provider + model for the setup turn (chief preferred, else default bot). */
  resolveSetupProvider: () => {
    provider: LLMProvider;
    model: string;
    providerId: string;
  };
  audit: (action: string, fields: { actor?: string; detail?: unknown }) => void;
}

function errorBody(message: string, detail?: unknown): Record<string, unknown> {
  return { ok: false, error: message, ...(detail !== undefined ? { detail } : {}) };
}

function clientError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/[A-Za-z]:\\[^\s"']+|\/[^\s"']+/g, (p) => p.split(/[\\/]/).pop() ?? p);
}

/** Proposal as served: routine schedules pre-validated for the approval card. */
export interface ServedBotSetupProposal extends Omit<BotSetupProposal, 'routines'> {
  routines: Array<{
    name: string;
    promptTemplate: string;
    schedule?: RoutineSchedule;
    /** Set when the suggested schedule failed validation (routine still offered, unscheduled). */
    scheduleError?: string;
  }>;
}

function serveProposal(proposal: BotSetupProposal): ServedBotSetupProposal {
  return {
    ...proposal,
    routines: proposal.routines.map((r) => {
      if (!r.schedule) return { name: r.name, promptTemplate: r.promptTemplate };
      try {
        return { name: r.name, promptTemplate: r.promptTemplate, schedule: validateRoutineSchedule(r.schedule) };
      } catch (err) {
        return {
          name: r.name,
          promptTemplate: r.promptTemplate,
          scheduleError: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  };
}

export function createBotSetupRouter(deps: BotSetupRouterDeps): Router {
  const router = express.Router();

  router.post('/propose', async (req, res) => {
    try {
      const body = (req.body ?? {}) as { sentence?: unknown };
      const sentence = typeof body.sentence === 'string' ? body.sentence.trim() : '';
      if (!sentence) {
        res.status(400).json(errorBody('body.sentence (non-empty string) is required'));
        return;
      }
      if (sentence.length > 1000) {
        res.status(400).json(errorBody('body.sentence is too long (max 1000 chars)'));
        return;
      }
      const bots = deps.getBots();
      if (bots.length === 0) {
        res.status(503).json(errorBody('No bot exists yet to run the setup turn.'));
        return;
      }
      const setup = deps.resolveSetupProvider();
      const fallback = bots[0]!;
      const proposal = await generateBotSetupProposal(sentence, {
        provider: setup.provider,
        model: setup.model,
        availableTools: deps.toolNames(),
        availableMcpServers: deps.mcpServerNames(),
        availableSkills: deps.skillNames(),
        defaultProvider: setup.providerId || fallback.provider,
        defaultModel: setup.model || fallback.model,
        existingBotIds: bots.map((b) => b.id),
      });
      deps.audit('bots.setup_proposed', {
        actor: 'api',
        detail: {
          botId: proposal.id,
          tools: proposal.tools.length,
          routines: proposal.routines.length,
          droppedTools: proposal.droppedTools,
        },
      });
      res.json({ ok: true, proposal: serveProposal(proposal) });
    } catch (err) {
      res.status(502).json(errorBody('Setup proposal failed', clientError(err)));
    }
  });

  router.post('/apply', async (req, res) => {
    try {
      const body = (req.body ?? {}) as { proposal?: unknown };
      if (typeof body.proposal !== 'object' || body.proposal === null) {
        res.status(400).json(errorBody('body.proposal (object) is required'));
        return;
      }
      const bots = deps.getBots();
      const setup = deps.resolveSetupProvider();
      const fallback = bots[0];
      // Re-validate EVERYTHING against the live catalogs — the proposal
      // round-tripped through the client and is never trusted as-is.
      const proposal = sanitizeBotSetupProposal(
        body.proposal,
        {
          availableTools: deps.toolNames(),
          availableMcpServers: deps.mcpServerNames(),
          availableSkills: deps.skillNames(),
          defaultProvider: setup.providerId || fallback?.provider || 'groq',
          defaultModel: setup.model || fallback?.model || 'gpt-oss-20b',
          existingBotIds: bots.map((b) => b.id),
        },
        typeof (body.proposal as { sourceSentence?: unknown }).sourceSentence === 'string'
          ? ((body.proposal as { sourceSentence: string }).sourceSentence)
          : '',
      );
      // Provider/model: only honor the proposal's when some existing bot
      // already uses that provider (i.e. it is configured here).
      const knownProviders = new Set(bots.map((b) => b.provider));
      knownProviders.add(setup.providerId);
      const provider = knownProviders.has(proposal.provider)
        ? proposal.provider
        : setup.providerId || fallback?.provider || proposal.provider;
      const model = provider === proposal.provider ? proposal.model : setup.model || proposal.model;

      const bot: BotConfig = {
        id: proposal.id,
        name: proposal.name,
        description: proposal.description,
        systemPrompt: proposal.systemPrompt,
        provider,
        model,
        skills: proposal.skills,
        tools: proposal.tools,
        mcpServers: proposal.mcpServers,
        ...(proposal.persona ? { persona: proposal.persona } : {}),
      };
      try {
        allocateBotWorkspace(bot, deps.dataDir);
      } catch {
        // Invalid id — workspace allocation is best-effort (import parity).
      }
      bots.push(bot);
      appendRosterImport(bot, deps.dataDir);

      // Suggested routines go through the existing RoutineStore path —
      // created (not one-click stubs) because the user approved them on
      // the proposal card. A routine that fails validation is reported
      // in skippedRoutines instead of failing the whole apply.
      const routines: BotRoutine[] = [];
      const skippedRoutines: Array<{ name: string; reason: string }> = [];
      for (const r of proposal.routines) {
        let schedule: RoutineSchedule | null = null;
        if (r.schedule) {
          try {
            schedule = validateRoutineSchedule(r.schedule);
          } catch (err) {
            skippedRoutines.push({
              name: r.name,
              reason: `invalid schedule: ${err instanceof Error ? err.message : String(err)}`,
            });
            continue;
          }
        }
        try {
          routines.push(
            deps.routineStore.create({
              name: r.name,
              botId: bot.id,
              promptTemplate: r.promptTemplate,
              schedule,
            }),
          );
        } catch (err) {
          skippedRoutines.push({
            name: r.name,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }

      deps.audit('bots.setup_applied', {
        actor: 'api',
        detail: {
          botId: bot.id,
          routines: routines.map((r) => r.id),
          skippedRoutines: skippedRoutines.length,
        },
      });
      res.json({ ok: true, bot, routines, skippedRoutines });
    } catch (err) {
      res.status(400).json(errorBody('Could not create the bot from that proposal', clientError(err)));
    }
  });

  return router;
}
