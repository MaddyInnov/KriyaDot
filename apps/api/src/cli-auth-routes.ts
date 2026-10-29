// SPDX-License-Identifier: Apache-2.0
// In-app subscription sign-in for native CLI drivers (OpenMausBot parity).
//
//   GET  /api/cli-auth/status                    → { ok, clis: CliLoginStatus[] }
//   POST /api/cli-auth/:cliId/login              → { ok, loginId, url } (waits ≤60s for the URL)
//   GET  /api/cli-auth/:cliId/login/:loginId     → { ok, status, reason? }
//   POST /api/cli-auth/:cliId/login/:loginId/cancel → { ok }
//   GET  /api/cli-auth/:cliId/sessions           → { ok, sessions: CliSessionInfo[] }
//
// HOST WIRING (index.ts):
//   import { createCliAuthRouter } from './cli-auth-routes.js';
//   app.use('/api/cli-auth', createCliAuthRouter());
//
// Security: responses never contain token bytes — only booleans, redacted
// hints, and the OAuth authorize URL. Login state is per-process (a restart
// clears in-flight logins).

import express, { type Router } from 'express';
import {
  CliAuthManager,
  listNativeCliSessions,
  type ActiveLogin,
  type CliAuthId,
} from '@mvp/agent-runtime';

const CLI_IDS: CliAuthId[] = ['claude', 'codex', 'opencode', 'antigravity', 'copilot'];

function errorBody(message: string): Record<string, unknown> {
  return { ok: false, error: message };
}

function asCliAuthId(raw: string): CliAuthId | null {
  return (CLI_IDS as string[]).includes(raw) ? (raw as CliAuthId) : null;
}

interface TrackedLogin {
  login: ActiveLogin;
  status: 'waiting' | 'done' | 'failed' | 'cancelled';
  reason?: string;
  url?: string;
}

export function createCliAuthRouter(): Router {
  const router = express.Router();
  const manager = new CliAuthManager();
  // Active logins, keyed `${cliId}:${loginId}`. Per-process by design.
  const logins = new Map<string, TrackedLogin>();
  let loginSeq = 0;

  const keyOf = (cliId: string, loginId: string): string => `${cliId}:${loginId}`;

  router.get('/status', async (_req, res) => {
    try {
      const clis = await Promise.all(CLI_IDS.map((id) => manager.getStatus(id)));
      // Strip to the safe public shape (defense in depth — the manager
      // already returns no token bytes).
      res.json({
        ok: true,
        clis: clis.map((c) => ({
          cliId: c.cliId,
          cliPresent: c.cliPresent,
          credentialsPresent: c.credentialsPresent,
          signedIn: c.signedIn,
          ...(c.accountHint ? { accountHint: c.accountHint } : {}),
          ...(c.expired !== undefined ? { expired: c.expired } : {}),
        })),
      });
    } catch (err) {
      res.status(500).json(errorBody(err instanceof Error ? err.message : 'status check failed'));
    }
  });

  router.post('/:cliId/login', async (req, res) => {
    const cliId = asCliAuthId(req.params.cliId);
    if (!cliId) {
      res.status(400).json(errorBody(`Unknown CLI "${req.params.cliId}". Expected one of ${CLI_IDS.join(', ')}.`));
      return;
    }
    for (const [k, t] of logins) {
      if (k.startsWith(`${cliId}:`) && t.status === 'waiting') {
        res.status(409).json(errorBody(`A login is already in progress for ${cliId}. Cancel it first.`));
        return;
      }
    }
    const loginId = `login_${Date.now().toString(36)}_${(loginSeq += 1)}`;
    const tracked: TrackedLogin = { login: manager.startLogin(cliId), status: 'waiting' };
    logins.set(keyOf(cliId, loginId), tracked);
    // Prune terminal logins so the map stays small.
    for (const [k, t] of [...logins]) {
      if (t.status !== 'waiting' && k !== keyOf(cliId, loginId)) logins.delete(k);
    }
    try {
      const url = await tracked.login.url;
      tracked.url = url;
      res.json({ ok: true, loginId, url });
    } catch (err) {
      tracked.status = 'failed';
      tracked.reason = err instanceof Error ? err.message : String(err);
      res.status(502).json(errorBody(tracked.reason));
      return;
    }
    // Background completion tracking (the UI polls the GET below).
    tracked.login.done.then(
      (r) => {
        tracked.status = r.ok ? 'done' : 'failed';
        tracked.reason = r.reason;
      },
      (err) => {
        tracked.status = 'failed';
        tracked.reason = err instanceof Error ? err.message : String(err);
      },
    );
  });

  router.get('/:cliId/login/:loginId', (req, res) => {
    const tracked = logins.get(keyOf(req.params.cliId, req.params.loginId));
    if (!tracked) {
      res.status(404).json(errorBody('Unknown or expired login id.'));
      return;
    }
    res.json({
      ok: true,
      status: tracked.status,
      ...(tracked.url ? { url: tracked.url } : {}),
      ...(tracked.reason ? { reason: tracked.reason } : {}),
    });
  });

  router.post('/:cliId/login/:loginId/cancel', (req, res) => {
    const k = keyOf(req.params.cliId, req.params.loginId);
    const tracked = logins.get(k);
    if (!tracked) {
      res.status(404).json(errorBody('Unknown or expired login id.'));
      return;
    }
    try {
      tracked.login.cancel();
    } catch {
      // ignore — cancel is best-effort
    }
    tracked.status = 'cancelled';
    logins.delete(k);
    res.json({ ok: true });
  });

  router.get('/:cliId/sessions', (req, res) => {
    const cliId = req.params.cliId;
    if (cliId !== 'claude-code' && cliId !== 'codex' && !CLI_IDS.includes(cliId as CliAuthId)) {
      res.status(400).json(errorBody(`Unknown CLI "${cliId}".`));
      return;
    }
    try {
      // Accept both the driver ids (claude-code/codex) and the auth ids.
      const driverId = cliId === 'claude' ? 'claude-code' : cliId;
      const sessions = listNativeCliSessions(driverId);
      res.json({ ok: true, sessions });
    } catch (err) {
      res.status(500).json(errorBody(err instanceof Error ? err.message : 'session listing failed'));
    }
  });

  return router;
}
