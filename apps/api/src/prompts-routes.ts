// SPDX-License-Identifier: Apache-2.0
// Stage-prompt overrides HTTP API (feature #9: prompt overrides with a
// hot-reload path).
//
//   GET  /api/prompts          → { ok, stages: [{ stage, source, path? }], overrides: [{ stage, path, mtimeMs }] }
//                                stages = the known pipeline stages; source is
//                                'override' when ~/.kriyadot/prompts/<stage>.md
//                                wins, 'builtin' otherwise.
//   POST /api/prompts/refresh  → { ok, invalidated } — drops the override
//                                cache so the next resolve() re-reads the
//                                files (mtime checks already hot-reload;
//                                this is the manual "reload now" lever).
//
// The store is the same default store the summarizer stage resolves
// through (summarizer.ts), so what this endpoint reports is what the
// pipeline actually uses.
//
// Mounted by the integrator (routes.ts), e.g.:
//
//   import { registerPromptRoutes } from './prompts-routes.js';
//   registerPromptRoutes(router, {});

import type { Request, Response, Router } from 'express';
import {
  KNOWN_STAGES,
  defaultPromptStore,
  logActivePromptOverrides,
  type PromptOverrideStore,
} from '@mvp/agent-runtime';

export interface PromptRouteDeps {
  /** Override store; defaults to the shared default store (same one the summarizer uses). */
  store?: PromptOverrideStore;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Snapshot of stage → active source for every known stage. */
export function describeStagePrompts(store: PromptOverrideStore = defaultPromptStore): {
  stages: { stage: string; source: 'override' | 'builtin'; path?: string }[];
  overrides: { stage: string; path: string; mtimeMs: number }[];
} {
  const stages = KNOWN_STAGES.map((stage) => {
    const resolved = store.resolve(stage);
    return {
      stage,
      source: resolved.source,
      ...(resolved.path ? { path: resolved.path } : {}),
    };
  });
  return { stages, overrides: store.activeOverrides() };
}

export function registerPromptRoutes(router: Router, deps: PromptRouteDeps = {}): void {
  const store = deps.store ?? defaultPromptStore;

  router.get('/prompts', (_req: Request, res: Response) => {
    try {
      res.json({ ok: true, ...describeStagePrompts(store) });
    } catch (err) {
      res.status(500).json({ error: 'Failed to list stage prompts', detail: errMessage(err) });
    }
  });

  router.post('/prompts/refresh', (_req: Request, res: Response) => {
    try {
      store.invalidate();
      logActivePromptOverrides(() => {}, store);
      const after = describeStagePrompts(store);
      res.json({
        ok: true,
        invalidated: true,
        stages: after.stages,
        overrides: after.overrides,
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to refresh prompt overrides', detail: errMessage(err) });
    }
  });
}

export default registerPromptRoutes;
