// SPDX-License-Identifier: Apache-2.0
// Memory upkeep HTTP API (OpenMausBot parity — background capture, nightly
// tidy, about-me, undoable journal).
//
//   POST /api/memory/upkeep/capture   { botId } → background capture pass
//   POST /api/memory/upkeep/distill   { botId, sessionId } → explicit
//        grounded distill pipeline over that session (#77)
//   POST /api/memory/upkeep/tidy      { botId } → dedupe + contradiction check
//   GET  /api/memory/upkeep/journal?botId&limit → recent journal entries
//   POST /api/memory/upkeep/journal/undo { botId } → undo the last change
//   GET  /api/memory/about-me        → the user-editable profile
//   PUT  /api/memory/about-me        { text } → save the profile
//   GET  /api/memory/atoms?botId     → provenance inspector: atoms + origins
//   GET  /api/memory/atoms/:id?botId → one atom with provenance
//   DELETE /api/memory/atoms/:id?botId → forget one atom
//
// HOST WIRING (index.ts):
//   import { createMemoryUpkeepRouter, startMemoryUpkeep } from './memory-upkeep-routes.js';
//   router.use('/memory', createMemoryUpkeepRouter({
//     dataDir: config.dataDir,
//     tieredMemoryStore,
//     getBots: () => bots,
//   }));
//   startMemoryUpkeep({
//     dataDir: config.dataDir,
//     tieredMemoryStore,
//     getBots: () => bots,
//     isIdle: () => <true when no turn/routine is running>,
//     audit: (action, fields) => governance.audit(action, fields),
//   });
//   // About-me in context:
//   agentRuntime.addContextProvider(({ bot }) => aboutMeContext(config.dataDir, bot.id));
//
// The idle capture pass and the nightly tidy are timer-driven here (they
// are host-level maintenance, not user routines). Both are cheap,
// deterministic, and zero-LLM.

import express, { type Router } from 'express';
import type { TieredMemoryStore } from '@mvp/agent-runtime';
import {
  MemoryJournal,
  capturePass,
  readAboutMe,
  runUpkeepPassWithLearning,
  syncAboutMeToOrientation,
  tidyMemory,
  writeAboutMe,
} from '@mvp/agent-runtime';
import { MemoryBackupStore, adoptMemoryPack, doctorMemory, exportMemoryPack, type MemoryPack } from './memory-pack.js';

export interface MemoryUpkeepRouterDeps {
  dataDir: string;
  tieredMemoryStore: TieredMemoryStore;
  getBots: () => Array<{ id: string }>;
  /** Verifier gate for near-duplicate merges (#80). Defaults to buildGroundedMergeVerifier() so the gate is LIVE. */
  mergeVerifier?: (keep: import('@mvp/agent-runtime').AtomCard, duplicate: import('@mvp/agent-runtime').AtomCard, similarity: number) => boolean;
  /** Per-privacy-tier hot-atom budgets (#80 watermarks). */
  watermarkBudgets?: Partial<Record<string, number>>;
}

/**
 * Grounded merge verifier (#80): approve a near-duplicate merge ONLY when
 * the facts share an entity, overlap strongly (token Jaccard >= 0.5), and
 * carry no conflicting numbers. Anything else is vetoed (fail-closed).
 */
export function buildGroundedMergeVerifier(): NonNullable<MemoryUpkeepRouterDeps['mergeVerifier']> {
  const tokens = (t: string) => new Set(t.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2));
  const numbers = (t: string) => new Set(t.match(/\d+(?:\.\d+)?/g) ?? []);
  return (keep, duplicate) => {
    const keepEntities = new Set(keep.entities.map((e) => e.toLowerCase()));
    if (keepEntities.size === 0 || !duplicate.entities.some((e) => keepEntities.has(e.toLowerCase()))) return false;
    const a = tokens(keep.fact); const b = tokens(duplicate.fact);
    if (a.size === 0 || b.size === 0) return false;
    let inter = 0; for (const t of a) if (b.has(t)) inter += 1;
    if (inter / (a.size + b.size - inter) < 0.5) return false;
    const na = numbers(keep.fact); const nb = numbers(duplicate.fact);
    if (na.size > 0 && nb.size > 0 && ![...na].every((n) => nb.has(n))) return false;
    return true;
  };
}

export const DEFAULT_WATERMARK_BUDGETS: Record<string, number> = { 'local-only': 500, 'cloud-ok': 2000, public: 2000 };

export function resolveWatermarkBudgets(deps?: { watermarkBudgets?: Partial<Record<string, number>> }): Record<string, number> {
  const out: Record<string, number> = { ...DEFAULT_WATERMARK_BUDGETS };
  for (const tier of Object.keys(out)) {
    const envVal = Number(process.env['MEMORY_WATERMARK_' + tier.replace(/-/g, '_').toUpperCase()]);
    if (Number.isFinite(envVal) && envVal > 0) out[tier] = Math.floor(envVal);
  }
  if (deps?.watermarkBudgets) for (const [k, v] of Object.entries(deps.watermarkBudgets)) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = Math.floor(v);
  }
  return out;
}

/** Enforce per-tier budgets: oldest unpinned hot atoms beyond budget move to the cold archive (#80). */
export function applyWatermarkBudgets(store: TieredMemoryStore, botId: string, budgets: Record<string, number>): { budgets: Record<string, number>; counts: Record<string, number>; archived: number } {
  const atoms = store.getAtoms(botId, 20000);
  const counts: Record<string, number> = {};
  for (const a of atoms) counts[a.tier] = (counts[a.tier] ?? 0) + 1;
  let archived = 0;
  const archiveAtom = (store as unknown as { archiveAtom?: (b: string, id: string) => boolean }).archiveAtom;
  if (typeof archiveAtom === 'function') {
    for (const [tier, budget] of Object.entries(budgets)) {
      const inTier = atoms.filter((a) => a.tier === tier && !a.pinned).sort((x, y) => x.createdAt - y.createdAt);
      const excess = inTier.length - budget;
      for (let i = 0; i < excess; i++) { if (archiveAtom.call(store, botId, inTier[i]!.id)) archived += 1; }
    }
  }
  return { budgets, counts, archived };
}


function errorBody(error: string, detail?: string): { error: string; detail?: string } {
  return detail ? { error, detail } : { error };
}

/**
 * Outcome provenance for the inspector (#86): where an atom came from
 * AND what became of it — grounding kind, verbatim quote + its source,
 * session evidence links, and its material-use outcome (useCredit > 0
 * means recall actually used it; archived atoms are cold-tier). Derived
 * from the atom's own stored fields at read time; nothing is invented —
 * absent source fields stay null.
 */
export function atomProvenance(atom: import('@mvp/agent-runtime').AtomCard): {
  sourceTurn: string | null;
  grounding: string | null;
  quote: string | null;
  quoteSource: string | null;
  evidenceLinks: string[];
  outcome: 'used-in-recall' | 'archived-cold' | 'stored-unused';
  useCredit: number;
} {
  const useCredit = typeof atom.useCredit === 'number' ? atom.useCredit : 0;
  return {
    sourceTurn: atom.sourceTurn ?? null,
    grounding: atom.grounding ?? null,
    quote: atom.quote ?? null,
    quoteSource: atom.quoteSource ?? null,
    evidenceLinks: atom.evidenceLinks ?? [],
    outcome: atom.archived ? 'archived-cold' : useCredit > 0 ? 'used-in-recall' : 'stored-unused',
    useCredit,
  };
}

/** An atom as the inspector returns it: the atom plus its provenance block. */
export function atomWithProvenance<T extends import('@mvp/agent-runtime').AtomCard>(atom: T): T & { provenance: ReturnType<typeof atomProvenance> } {
  return { ...atom, provenance: atomProvenance(atom) };
}

function requireBotId(body: unknown, getBots: () => Array<{ id: string }>): string {
  const b = (body ?? {}) as { botId?: unknown };
  if (typeof b.botId !== 'string' || !b.botId.trim()) throw new Error('"botId" is required');
  const id = b.botId.trim();
  if (!getBots().some((bot) => bot.id === id)) throw new Error(`Unknown bot "${id}"`);
  return id;
}

export function createMemoryUpkeepRouter(deps: MemoryUpkeepRouterDeps): Router {
  const router = express.Router();
  const journal = new MemoryJournal(deps.dataDir);

  router.post('/upkeep/capture', (req, res) => {
    let botId: string;
    try {
      botId = requireBotId(req.body, deps.getBots);
    } catch (err) {
      res.status(400).json(errorBody(err instanceof Error ? err.message : 'Invalid request'));
      return;
    }
    try {
      const result = capturePass(deps.tieredMemoryStore, journal, botId);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json(errorBody('Capture pass failed', err instanceof Error ? err.message : String(err)));
    }
  });

  // Explicit distill pipeline trigger (#77): run the grounded distill
  // pipeline over ONE session's recorded turns on demand — the API
  // counterpart of the /done command's learning kickoff. Body:
  // { botId, sessionId }. Reflection is skipped (no chat fn on this
  // route) and the result says so via `reflection: null`.
  router.post('/upkeep/distill', async (req, res) => {
    let botId: string;
    try {
      botId = requireBotId(req.body, deps.getBots);
    } catch (err) {
      res.status(400).json(errorBody(err instanceof Error ? err.message : 'Invalid request'));
      return;
    }
    const sessionId = (req.body as { sessionId?: unknown })?.sessionId;
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      res.status(400).json(errorBody('"sessionId" is required'));
      return;
    }
    const store = deps.tieredMemoryStore as unknown as {
      runDistillPipeline?: (b: string, s: string) => Promise<unknown>;
    };
    if (typeof store.runDistillPipeline !== 'function') {
      res.status(501).json(errorBody('distill pipeline is not available on this memory store'));
      return;
    }
    try {
      const result = await store.runDistillPipeline(botId, sessionId.trim());
      res.json({ ok: true, ...(result as Record<string, unknown>) });
    } catch (err) {
      res.status(500).json(errorBody('Distill pipeline failed', err instanceof Error ? err.message : String(err)));
    }
  });

  router.post('/upkeep/tidy', (req, res) => {
    let botId: string;
    try {
      botId = requireBotId(req.body, deps.getBots);
    } catch (err) {
      res.status(400).json(errorBody(err instanceof Error ? err.message : 'Invalid request'));
      return;
    }
    try {
      const result = tidyMemory(deps.tieredMemoryStore, journal, botId, { mergeVerifier: deps.mergeVerifier ?? buildGroundedMergeVerifier() });
      const watermarks = applyWatermarkBudgets(deps.tieredMemoryStore, botId, resolveWatermarkBudgets(deps));
      res.json({ ok: true, ...result, watermarks });
    } catch (err) {
      res.status(500).json(errorBody('Tidy pass failed', err instanceof Error ? err.message : String(err)));
    }
  });

  router.get('/upkeep/watermarks', (req, res) => {
    const botId = typeof req.query.botId === 'string' ? req.query.botId : '';
    if (!botId || !deps.getBots().some((b) => b.id === botId)) { res.status(400).json(errorBody('query param "botId" (a known bot) is required')); return; }
    res.json({ ok: true, botId, ...applyWatermarkBudgets(deps.tieredMemoryStore, botId, resolveWatermarkBudgets(deps)) });
  });

  router.get('/upkeep/journal', (req, res) => {
    const botId = typeof req.query.botId === 'string' ? req.query.botId : '';
    if (!botId) {
      res.status(400).json(errorBody('query param "botId" is required'));
      return;
    }
    const rawLimit = typeof req.query.limit === 'string' ? Number(req.query.limit) : NaN;
    const limit = Number.isSafeInteger(rawLimit) ? rawLimit : 20;
    try {
      res.json({ ok: true, botId, entries: journal.list(botId, limit) });
    } catch (err) {
      res.status(500).json(errorBody('Failed to list journal', err instanceof Error ? err.message : String(err)));
    }
  });

  router.post('/upkeep/journal/undo', (req, res) => {
    let botId: string;
    try {
      botId = requireBotId(req.body, deps.getBots);
    } catch (err) {
      res.status(400).json(errorBody(err instanceof Error ? err.message : 'Invalid request'));
      return;
    }
    try {
      const undone = journal.undoLast(botId, deps.tieredMemoryStore);
      if (!undone) {
        res.status(404).json(errorBody('Nothing to undo — the journal is empty'));
        return;
      }
      res.json({ ok: true, undone });
    } catch (err) {
      res.status(500).json(errorBody('Undo failed', err instanceof Error ? err.message : String(err)));
    }
  });

  // -- Provenance inspector (learning hardening) ------------------------------
  // Every atom with where it came from: source turn, verbatim quote +
  // quote source when grounded, category/confidence/tier. DELETE is the
  // forget path (removes the atom and its search rows).
  router.get('/atoms', (req, res) => {
    const botId = typeof req.query.botId === 'string' ? req.query.botId : '';
    if (!botId || !deps.getBots().some((b) => b.id === botId)) {
      res.status(400).json(errorBody('query param "botId" (a known bot) is required'));
      return;
    }
    const rawLimit = typeof req.query.limit === 'string' ? Number(req.query.limit) : NaN;
    const limit = Number.isSafeInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 1000) : 200;
    const includeInactive = req.query.includeInactive === '1' || req.query.includeInactive === 'true';
    try {
      let atoms = deps.tieredMemoryStore.getAtoms(botId, limit, { includeInactive });
      const pattern = typeof req.query.pattern === 'string' ? req.query.pattern : '';
      if (pattern) {
        const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
        atoms = atoms.filter((a) => re.test(a.fact));
      }
      res.json({
        ok: true,
        botId,
        droppedUngroundedQuotes: deps.tieredMemoryStore.droppedUngroundedQuotes,
        atoms: atoms.map(atomWithProvenance),
      });
    } catch (err) {
      res.status(500).json(errorBody('Failed to list atoms', err instanceof Error ? err.message : String(err)));
    }
  });

  // Clear-all (#86): forget every atom for a bot.
  router.delete('/atoms', (req, res) => {
    const botId = typeof req.query.botId === 'string' ? req.query.botId : '';
    if (!botId) { res.status(400).json(errorBody('query param "botId" is required')); return; }
    const atoms = deps.tieredMemoryStore.getAtoms(botId, 20000, { includeInactive: true });
    let cleared = 0;
    for (const a of atoms) if (deps.tieredMemoryStore.deleteAtom(botId, a.id)) cleared += 1;
    res.json({ ok: true, botId, cleared });
  });

  router.get('/atoms/:id', (req, res) => {
    const botId = typeof req.query.botId === 'string' ? req.query.botId : '';
    if (!botId) {
      res.status(400).json(errorBody('query param "botId" is required'));
      return;
    }
    const atom = deps.tieredMemoryStore.getAtom(botId, req.params.id);
    if (!atom) {
      res.status(404).json(errorBody('Atom not found'));
      return;
    }
    res.json({ ok: true, atom: atomWithProvenance(atom) });
  });

  router.delete('/atoms/:id', (req, res) => {
    const botId = typeof req.query.botId === 'string' ? req.query.botId : '';
    if (!botId) {
      res.status(400).json(errorBody('query param "botId" is required'));
      return;
    }
    const removed = deps.tieredMemoryStore.deleteAtom(botId, req.params.id);
    if (!removed) {
      res.status(404).json(errorBody('Atom not found'));
      return;
    }
    res.json({ ok: true, deleted: req.params.id });
  });

  // -- Memory portability (item 12) ------------------------------------------
  const backups = new MemoryBackupStore(deps.dataDir);
  const botFromBodyOrQuery = (req: express.Request): string => {
    const id = (typeof req.body?.botId === 'string' ? req.body.botId : typeof req.query.botId === 'string' ? req.query.botId : '');
    if (!id || !deps.getBots().some((b) => b.id === id)) throw new Error('"botId" (a known bot) is required');
    return id;
  };
  router.post('/pack/export', (req, res) => { try { const botId = botFromBodyOrQuery(req); res.json({ ok: true, pack: exportMemoryPack(deps.tieredMemoryStore, botId) }); } catch (err) { res.status(400).json(errorBody(err instanceof Error ? err.message : 'export failed')); } });
  router.post('/pack/adopt', (req, res) => { try { const botId = botFromBodyOrQuery(req); const pack = (req.body as { pack?: MemoryPack }).pack as MemoryPack; const decisions = ((req.body as { decisions?: Record<string, 'overwrite'|'skip'> }).decisions ?? {}) as Record<string, 'overwrite'|'skip'>; res.json({ ok: true, ...adoptMemoryPack(deps.tieredMemoryStore, botId, pack, decisions) }); } catch (err) { res.status(400).json(errorBody(err instanceof Error ? err.message : 'adopt failed')); } });
  router.get('/pack/doctor', (req, res) => { try { const botId = botFromBodyOrQuery(req); res.json({ ok: true, report: doctorMemory(deps.tieredMemoryStore, botId) }); } catch (err) { res.status(400).json(errorBody(err instanceof Error ? err.message : 'doctor failed')); } });
  router.post('/pack/backup', (req, res) => { try { const botId = botFromBodyOrQuery(req); const { id } = backups.create(deps.tieredMemoryStore, botId); res.status(201).json({ ok: true, backupId: id, backups: backups.list(botId) }); } catch (err) { res.status(400).json(errorBody(err instanceof Error ? err.message : 'backup failed')); } });
  router.post('/pack/restore', (req, res) => { try { const botId = botFromBodyOrQuery(req); const backupId = typeof req.body?.backupId === 'string' ? req.body.backupId : ''; if (!backupId) throw new Error('"backupId" is required'); res.json({ ok: true, ...backups.restore(deps.tieredMemoryStore, botId, backupId) }); } catch (err) { res.status(400).json(errorBody(err instanceof Error ? err.message : 'restore failed')); } });
  router.post('/upkeep/slim', (req, res) => { let botId: string; try { botId = requireBotId(req.body, deps.getBots); } catch (err) { res.status(400).json(errorBody(err instanceof Error ? err.message : 'Invalid request')); return; } try { const report = tidyMemory(deps.tieredMemoryStore, journal, botId, { mergeVerifier: deps.mergeVerifier ?? buildGroundedMergeVerifier() }); res.json({ ok: true, slim: true, report, watermarks: applyWatermarkBudgets(deps.tieredMemoryStore, botId, resolveWatermarkBudgets(deps)), doctor: doctorMemory(deps.tieredMemoryStore, botId) }); } catch (err) { res.status(500).json(errorBody('Slim failed', err instanceof Error ? err.message : String(err))); } });

  router.get('/about-me', (_req, res) => {
    try {
      res.json({ ok: true, ...readAboutMe(deps.dataDir) });
    } catch (err) {
      res.status(500).json(errorBody('Failed to read about-me', err instanceof Error ? err.message : String(err)));
    }
  });

  router.put('/about-me', (req, res) => {
    const body = (req.body ?? {}) as { text?: unknown };
    if (typeof body.text !== 'string') {
      res.status(400).json(errorBody('"text" (string) is required'));
      return;
    }
    try {
      const profile = writeAboutMe(deps.dataDir, body.text);
      // #76: mirror the saved profile into every bot's orientation
      // store, so orientation-based recall serves the same profile the
      // file-backed API does. Best-effort per bot — a sync failure must
      // never fail the save itself.
      let orientationSynced = 0;
      for (const bot of deps.getBots()) {
        try {
          if (syncAboutMeToOrientation(deps.tieredMemoryStore, bot.id, deps.dataDir)) {
            orientationSynced += 1;
          }
        } catch {
          // Orientation sync is best-effort.
        }
      }
      res.json({ ok: true, ...profile, orientationSynced });
    } catch (err) {
      res.status(400).json(errorBody(err instanceof Error ? err.message : 'Failed to save about-me'));
    }
  });

  // On-demand cold recall (#81): the archive (cold tier) searched and
  // rendered for a query — the read side of the cold loop, so archived
  // atoms are reachable without waiting for a chat turn to surface them.
  router.get('/cold', (req, res) => {
    let botId: string;
    try {
      botId = botFromBodyOrQuery(req);
    } catch (err) {
      res.status(400).json(errorBody(err instanceof Error ? err.message : 'Invalid request'));
      return;
    }
    const query = typeof req.query.q === 'string' ? req.query.q : '';
    try {
      const block = deps.tieredMemoryStore.recallColdForPrompt(botId, query);
      const page = deps.tieredMemoryStore.searchCold(botId, query, { page: 0, pageSize: 10 });
      res.json({ ok: true, block, atoms: page.atoms, total: page.total });
    } catch (err) {
      res.status(500).json(errorBody('Cold recall failed', err instanceof Error ? err.message : String(err)));
    }
  });

  return router;
}

/**
 * Context section injected into every bot turn: the user's about-me
 * profile. Empty string when unset (no noise in the prompt).
 */
export function aboutMeContext(dataDir: string, _botId: string): string {
  try {
    const { text } = readAboutMe(dataDir);
    if (!text.trim()) return '';
    return ['# About the user (their own words — treat as trusted context)', '', text.trim()].join('\n');
  } catch {
    return '';
  }
}

export interface MemoryUpkeepSchedulerDeps {
  dataDir: string;
  tieredMemoryStore: TieredMemoryStore;
  getBots: () => Array<{ id: string }>;
  /** True when no agent turn or routine run is currently executing. */
  isIdle: () => boolean;
  audit: (action: string, fields: { actor?: string; detail?: unknown }) => void;
  mergeVerifier?: MemoryUpkeepRouterDeps['mergeVerifier'];
  watermarkBudgets?: Partial<Record<string, number>>;
  /** Override for tests. */
  captureIntervalMs?: number;
  tidyIntervalMs?: number;
}

export interface MemoryUpkeepScheduler {
  stop: () => void;
}

/**
 * Start the background upkeep timers:
 * - idle capture every 15 min (skipped when the host is busy — runs on
 *   idle, never during a turn),
 * - nightly tidy every 24 h (first run ~1 min after boot so a fresh
 *   install self-organizes, then daily).
 * Returns a stop handle. Timers are unref'd so they never hold the process.
 */
export function startMemoryUpkeep(deps: MemoryUpkeepSchedulerDeps): MemoryUpkeepScheduler {
  const journal = new MemoryJournal(deps.dataDir);
  const captureIntervalMs = deps.captureIntervalMs ?? 15 * 60 * 1000;
  const tidyIntervalMs = deps.tidyIntervalMs ?? 24 * 60 * 60 * 1000;

  const runCapture = (): void => {
    let idle = false;
    try {
      idle = deps.isIdle();
    } catch {
      idle = false;
    }
    if (!idle) return; // runs on idle, not every turn
    for (const bot of deps.getBots()) {
      try {
        const r = capturePass(deps.tieredMemoryStore, journal, bot.id, { maxEvents: 100 });
        if (r.atomsStored > 0) {
          deps.audit('memory.upkeep_capture', { actor: 'system', detail: r });
        }
      } catch {
        // upkeep must never break the server
      }
    }
  };

  const runTidy = (): void => {
    for (const bot of deps.getBots()) {
      void (async () => {
        try {
          // #82/#84/#85: the scheduled pass is the composed upkeep +
          // learning entry point — tidy (merge verifier forwarded) and
          // watermark budgets, then the learning-evolution pass
          // (multi-pass synthesis proposals, standing-rule and scoped
          // rule candidates) whose candidates are audit-logged for
          // review. Candidates stay proposals: nothing auto-applies.
          const r = await runUpkeepPassWithLearning(deps.tieredMemoryStore, journal, bot.id, {
            mergeVerifier: deps.mergeVerifier ?? buildGroundedMergeVerifier(),
          });
          applyWatermarkBudgets(deps.tieredMemoryStore, bot.id, resolveWatermarkBudgets(deps));
          deps.audit('memory.upkeep_tidy', { actor: 'system', detail: r.tidy });
          deps.audit('memory.upkeep_learning', {
            actor: 'system',
            detail: {
              candidates: r.learning.candidates.length,
              verified: r.learning.verified,
              shadowed: r.learning.shadowed,
              rejected: r.learning.rejected,
            },
          });
        } catch {
          // upkeep must never break the server
        }
      })();
    }
  };

  const captureTimer = setInterval(runCapture, captureIntervalMs);
  const tidyTimer = setInterval(runTidy, tidyIntervalMs);
  // First tidy shortly after boot so a fresh install self-organizes.
  const firstTidy = setTimeout(runTidy, 60_000);
  for (const t of [captureTimer, tidyTimer, firstTidy]) {
    if (typeof t.unref === 'function') t.unref();
  }
  return {
    stop: () => {
      clearInterval(captureTimer);
      clearInterval(tidyTimer);
      clearTimeout(firstTidy);
      journal.close();
    },
  };
}
