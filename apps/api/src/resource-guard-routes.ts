// SPDX-License-Identifier: Apache-2.0
// Self-monitoring surface for the resource guard (B3).
//
// Mounted on the EXISTING health surface (routes.ts registers these beside
// registerHealthRoutes, so they live under /api/health/* next to the
// run-health endpoints, and Activity → Health renders the snapshot) —
// deliberately not a new page or a new top-level namespace:
//
//   GET /api/health/self            → the self-monitoring snapshot
//   GET /api/health/resource-guard  → guard settings + live state
//   PUT /api/health/resource-guard  → update settings (persisted + live)
//
// A14 SEAM: the wave-6 `doctor` command consumes the snapshot through
// getSelfSnapshot() below (in-process) or GET /api/health/self (over
// HTTP) — it must not re-implement pressure sampling or counting. The
// snapshot shape in resource-guard.ts (SelfSnapshot) is the contract.

import express from 'express';
import {
  buildSelfSnapshot,
  loadResourceGuardSettings,
  sanitizeResourceGuardSettings,
  saveResourceGuardSettings,
  type ResourceGuard,
  type SelfSnapshot,
  type SelfSnapshotCounts,
} from './resource-guard.js';

function errorBody(error: string, detail?: string): { error: string; detail?: string } {
  return detail ? { error, detail } : { error };
}

export interface SelfMonitorRouteDeps {
  guard: ResourceGuard;
  dataDir: string;
  /** Live counters the host already tracks (active turns, runs, …). */
  counts?: () => SelfSnapshotCounts;
}

/** The programmatic snapshot — the exact object GET /health/self serves. */
export function getSelfSnapshot(deps: SelfMonitorRouteDeps): SelfSnapshot {
  return buildSelfSnapshot({ guard: deps.guard, counts: deps.counts?.() ?? {} });
}

export function registerSelfMonitorRoutes(router: express.Router, deps: SelfMonitorRouteDeps): void {
  router.get('/health/self', (_req, res) => {
    try {
      res.json(getSelfSnapshot(deps));
    } catch (err) {
      res.status(500).json(errorBody('Failed to build self snapshot', err instanceof Error ? err.message : String(err)));
    }
  });

  router.get('/health/resource-guard', (_req, res) => {
    try {
      res.json({ settings: loadResourceGuardSettings(deps.dataDir), state: deps.guard.state() });
    } catch (err) {
      res.status(500).json(errorBody('Failed to load resource guard settings', err instanceof Error ? err.message : String(err)));
    }
  });

  router.put('/health/resource-guard', (req, res) => {
    try {
      const next = sanitizeResourceGuardSettings(req.body ?? {}, deps.guard.currentSettings);
      const saved = saveResourceGuardSettings(deps.dataDir, next);
      deps.guard.updateSettings(saved);
      res.json({ ok: true, settings: saved, state: deps.guard.state() });
    } catch (err) {
      res.status(500).json(errorBody('Failed to save resource guard settings', err instanceof Error ? err.message : String(err)));
    }
  });
}
