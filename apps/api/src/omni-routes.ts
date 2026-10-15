// SPDX-License-Identifier: Apache-2.0
// Omni rolling summary routes: GET /api/summary/omni (+ ?version=<id>,
// /versions), pins, manual snapshots, and the manual rollup trigger.
//
// The web Omni panel (apps/web/lib/kriyadot-api.ts) reads through
// optionalJson, which maps 404 → null → empty state. So an empty store
// answers 404 here, and any other failure is a 500 with { error }.

import express from 'express';
import type { OmniCollector, OmniStore } from './omni.js';

function errorBody(error: string, detail?: string): { error: string; detail?: string } {
  return detail ? { error, detail } : { error };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface OmniRouteDeps {
  omni: OmniStore;
  collector: OmniCollector;
}

/** Mount the /api/summary/omni* routes. */
export function registerOmniRoutes(router: express.Router, deps: OmniRouteDeps): void {
  const { omni, collector } = deps;

  // Newest-first version list for the panel's time-travel selector.
  router.get('/summary/omni/versions', (_req, res) => {
    try {
      res.json(
        omni.listVersions().map((v) => ({
          id: v.id,
          createdAt: v.createdAt,
          ...(v.label !== undefined ? { label: v.label } : {}),
        })),
      );
    } catch (err) {
      res.status(500).json(errorBody('Failed to list summary versions', errMessage(err)));
    }
  });

  // Current summary, or ?version=<id> for a time-travel snapshot.
  // 404 when the store is empty (panel shows its empty state) or the
  // version id is unknown.
  router.get('/summary/omni', (req, res) => {
    try {
      const versionId = typeof req.query.version === 'string' && req.query.version ? req.query.version : undefined;
      if (versionId) {
        const snapshot = omni.getVersionSummary(versionId);
        if (!snapshot) {
          res.status(404).json(errorBody(`Unknown summary version "${versionId}"`));
          return;
        }
        res.json(snapshot);
        return;
      }
      if (omni.isEmpty()) {
        res.status(404).json(errorBody('No summary yet'));
        return;
      }
      res.json(omni.getSummary());
    } catch (err) {
      res.status(500).json(errorBody('Failed to load omni summary', errMessage(err)));
    }
  });

  // Pin / unpin any item; pins[] in the summary carries pinned items
  // across all layers.
  router.post('/summary/omni/pins', (req, res) => {
    const body = (req.body ?? {}) as { itemId?: unknown; action?: unknown };
    if (typeof body.itemId !== 'string' || !body.itemId) {
      res.status(400).json(errorBody('itemId is required'));
      return;
    }
    if (body.action !== 'pin' && body.action !== 'unpin') {
      res.status(400).json(errorBody('action must be "pin" or "unpin"'));
      return;
    }
    try {
      const ok = omni.setPinned(body.itemId, body.action === 'pin');
      if (!ok) {
        res.status(404).json(errorBody(`Unknown omni item "${body.itemId}"`));
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json(errorBody('Failed to update pin', errMessage(err)));
    }
  });

  // Manual snapshot of the current four layers + pins.
  router.post('/summary/omni/snapshot', (req, res) => {
    const body = (req.body ?? {}) as { label?: unknown };
    const label =
      typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 120) : undefined;
    try {
      const v = omni.createVersion(label, 'manual');
      res.json({
        ok: true,
        version: {
          id: v.id,
          createdAt: v.createdAt,
          ...(v.label !== undefined ? { label: v.label } : {}),
        },
      });
    } catch (err) {
      res.status(500).json(errorBody('Failed to create summary snapshot', errMessage(err)));
    }
  });

  // Manual rollup trigger (the scheduler runs these on day/week
  // boundaries; this endpoint lets ops/the UI force one). kind defaults
  // to "all".
  router.post('/summary/omni/rollup', async (req, res) => {
    const body = (req.body ?? {}) as { kind?: unknown };
    const kind = typeof body.kind === 'string' && body.kind ? body.kind : 'all';
    if (kind !== 'nightly' && kind !== 'weekly' && kind !== 'all') {
      res.status(400).json(errorBody('kind must be "nightly", "weekly" or "all"'));
      return;
    }
    try {
      const now = Date.now();
      const enhance = process.env.OMNI_OLLAMA_ENHANCE === '1';
      // Refresh the live layers first so the rollup sees today's items.
      await collector.collect().catch(() => undefined);
      const stats =
        kind === 'nightly'
          ? { nightly: await omni.rollupNightly(now, { enhance }) }
          : kind === 'weekly'
            ? { weekly: omni.rollupWeekly(now) }
            : { nightly: await omni.rollupNightly(now, { enhance }), weekly: omni.rollupWeekly(now) };
      res.json({ ok: true, kind, stats });
    } catch (err) {
      res.status(500).json(errorBody('Failed to run summary rollup', errMessage(err)));
    }
  });
}
