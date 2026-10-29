// SPDX-License-Identifier: Apache-2.0
// Open-at-login REST API (W12d).
//
//   GET /api/autostart            → { ok, status: AutostartStatus }
//   PUT /api/autostart {enabled}  → { ok, status } (writes/removes the OS entry)
//
// The manager is file-based per OS (see autostart.ts): Linux XDG .desktop,
// macOS LaunchAgent plist, Windows Startup-folder .cmd. No Tauri plugin
// and no native helper — the desktop shell and the standalone server both
// reach this endpoint the same way.
//
// HOST WIRING (index.ts):
//   import { AutostartManager } from './autostart.js';
//   import { createAutostartRouter } from './autostart-routes.js';
//   app.use('/api/autostart', createAutostartRouter(new AutostartManager(), audit));

import express, { type Router } from 'express';
import type { AutostartManager } from './autostart.js';

function errorBody(message: string): Record<string, unknown> {
  return { ok: false, error: message };
}

function clientError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/[A-Za-z]:\\[^\s"']+|\/[^\s"']+/g, (p) => p.split(/[\\/]/).pop() ?? p);
}

export function createAutostartRouter(
  manager: AutostartManager,
  audit?: (action: string, fields: { actor?: string; detail?: unknown }) => void,
): Router {
  const router = express.Router();

  router.get('/', (_req, res) => {
    try {
      res.json({ ok: true, status: manager.status() });
    } catch (err) {
      res.status(500).json(errorBody(clientError(err)));
    }
  });

  router.put('/', (req, res) => {
    try {
      const body = (req.body ?? {}) as { enabled?: unknown };
      if (typeof body.enabled !== 'boolean') {
        res.status(400).json(errorBody('body.enabled (boolean) is required'));
        return;
      }
      const status = manager.setEnabled(body.enabled);
      try {
        audit?.('autostart.updated', {
          actor: 'api',
          detail: { enabled: status.enabled, platform: status.platform },
        });
      } catch {
        // Audit must never break the toggle.
      }
      res.json({ ok: true, status });
    } catch (err) {
      res.status(500).json(errorBody(clientError(err)));
    }
  });

  return router;
}
