// SPDX-License-Identifier: Apache-2.0
// Self-update REST API (Atomic Agent parity: in-app updates).
//
//   GET  /api/updates/status     → { ok, status: UpdateStatus }
//   POST /api/updates/check      → { ok, status } (manual "check now"; never downloads)
//   POST /api/updates/download   → { ok, status } (explicit consent; requires 'available')
//   POST /api/updates/install    → { ok, status } (explicit consent; requires 'ready')
//   GET  /api/updates/settings   → { ok, settings }
//   PUT  /api/updates/settings   → { ok, settings } ({autoCheck?, checkIntervalHours?})
//
// The update source is pinned to MaddyInnov/KriyaDot GitHub releases inside
// the manager — the client cannot point it at arbitrary URLs. Download and
// install only proceed on explicit user action (consent gating lives in the
// manager; these routes just forward).
//
// HOST WIRING (index.ts):
//   import { createSelfUpdateRouter } from './self-update-routes.js';
//   import { SelfUpdateManager } from '@mvp/agent-runtime';
//   const updater = new SelfUpdateManager({ dataDir: config.dataDir, currentVersion: APP_VERSION });
//   app.use('/api/updates', createSelfUpdateRouter(updater));

import express, { type Router } from 'express';
import type { SelfUpdateManager, UpdateSettings } from '@mvp/agent-runtime';

function errorBody(message: string): Record<string, unknown> {
  return { ok: false, error: message };
}

function clientError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // Never leak absolute host paths in API errors.
  return msg.replace(/[A-Za-z]:\\[^\s"']+|\/[^\s"']+/g, (p) => p.split(/[\\/]/).pop() ?? p);
}

export function createSelfUpdateRouter(updater: SelfUpdateManager): Router {
  const router = express.Router();

  router.get('/status', async (_req, res) => {
    try {
      res.json({ ok: true, status: await updater.getStatus() });
    } catch (err) {
      res.status(500).json(errorBody(clientError(err)));
    }
  });

  router.post('/check', async (_req, res) => {
    try {
      res.json({ ok: true, status: await updater.checkNow() });
    } catch (err) {
      res.status(500).json(errorBody(clientError(err)));
    }
  });

  router.post('/download', async (_req, res) => {
    try {
      res.json({ ok: true, status: await updater.download() });
    } catch (err) {
      // 409: no update available — the client asked to download without consent state.
      res.status(409).json(errorBody(clientError(err)));
    }
  });

  router.post('/install', async (_req, res) => {
    try {
      res.json({ ok: true, status: await updater.install() });
    } catch (err) {
      res.status(409).json(errorBody(clientError(err)));
    }
  });

  router.get('/settings', async (_req, res) => {
    try {
      res.json({ ok: true, settings: await updater.getSettings() });
    } catch (err) {
      res.status(500).json(errorBody(clientError(err)));
    }
  });

  router.put('/settings', async (req, res) => {
    try {
      const body = (req.body ?? {}) as Partial<UpdateSettings>;
      const settings = await updater.saveSettings({
        autoCheck: body.autoCheck,
        checkIntervalHours: body.checkIntervalHours,
      });
      res.json({ ok: true, settings });
    } catch (err) {
      res.status(500).json(errorBody(clientError(err)));
    }
  });

  return router;
}
