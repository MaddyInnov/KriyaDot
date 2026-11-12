// SPDX-License-Identifier: Apache-2.0
// In-app subscription sign-in for native CLI drivers (OpenMausBot parity).
//
//   GET  /api/cli-auth/status                    → { ok, clis: CliLoginStatus[] }
//   POST /api/cli-auth/:cliId/login              → { ok, loginId, url, acceptsCode } (waits ≤60s for the URL)
//   GET  /api/cli-auth/:cliId/login/:loginId     → { ok, status, reason? }
//   POST /api/cli-auth/:cliId/login/:loginId/code → { ok } (paste-code flows: hand the browser-shown code to the waiting CLI)
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
  bridgeAccountCredentialsPath,
  bridgeAccountSpawnEnv,
  getBridgeAccountStore,
  isBridgeAccountBridge,
  listNativeCliSessions,
  type ActiveLogin,
  type CliAccountContext,
  type CliAuthId,
} from '@mvp/agent-runtime';

// A2: the five manifest-first bridges join the sign-in surface (copilot
// was already here pre-bridge; grok / kimi / pi / hermes are new).
const CLI_IDS: CliAuthId[] = [
  'claude',
  'codex',
  'opencode',
  'antigravity',
  'copilot',
  'grok',
  'kimi',
  'pi',
  'hermes',
];

/**
 * A6: resolve a non-default account id for a bridge CLI into the
 * sign-in context (config-dir env + the account's credential file).
 * Returns undefined for the machine default (today's behaviour,
 * unchanged), or null when the account id names no stored account.
 */
function accountContextFor(cliId: CliAuthId, accountId: unknown): CliAccountContext | undefined | null {
  if (accountId === undefined || accountId === null || accountId === '' || accountId === 'default') {
    return undefined;
  }
  if (typeof accountId !== 'string' || !isBridgeAccountBridge(cliId)) return null;
  const account = getBridgeAccountStore().get(cliId, accountId);
  if (!account || account.machineDefault) return null;
  return {
    env: bridgeAccountSpawnEnv(account),
    credentialsPath: bridgeAccountCredentialsPath(account),
  };
}

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
  /** A6: the account this login signs into ('default' = machine default). */
  accountId: string;
}

export function createCliAuthRouter(): Router {
  const router = express.Router();
  const manager = new CliAuthManager();
  // Active logins, keyed `${cliId}:${loginId}`. Per-process by design.
  const logins = new Map<string, TrackedLogin>();
  let loginSeq = 0;

  const keyOf = (cliId: string, loginId: string): string => `${cliId}:${loginId}`;

  router.get('/status', async (req, res) => {
    try {
      // A6: ?cliId=<bridge>&accountId=<id> probes ONE non-default
      // account's sign-in state, independently of the machine default.
      const accountId = req.query.accountId;
      if (accountId !== undefined) {
        const cliId = asCliAuthId(String(req.query.cliId ?? ''));
        if (!cliId) {
          res.status(400).json(errorBody('cliId is required with accountId.'));
          return;
        }
        const ctx = accountContextFor(cliId, accountId);
        if (ctx === null) {
          res.status(404).json(errorBody(`No bridge account "${String(accountId)}" for ${cliId}.`));
          return;
        }
        const c = await manager.getStatus(cliId, ctx);
        res.json({
          ok: true,
          clis: [
            {
              cliId: c.cliId,
              accountId: String(accountId),
              cliPresent: c.cliPresent,
              credentialsPresent: c.credentialsPresent,
              signedIn: c.signedIn,
              ...(c.accountHint ? { accountHint: c.accountHint } : {}),
              ...(c.expired !== undefined ? { expired: c.expired } : {}),
              ...(c.namesakeWarning ? { namesakeWarning: c.namesakeWarning } : {}),
            },
          ],
        });
        return;
      }
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
          ...(c.namesakeWarning ? { namesakeWarning: c.namesakeWarning } : {}),
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
    // A6: an optional { accountId } in the body signs into THAT bridge
    // account (the login runs under its fresh config dir); absent =
    // the machine default, exactly as before. Concurrent logins are
    // tracked per (cli, account) — two accounts may sign in at once.
    const accountIdRaw = (req.body as { accountId?: unknown } | undefined)?.accountId;
    const ctx = accountContextFor(cliId, accountIdRaw);
    if (ctx === null) {
      res.status(404).json(errorBody(`No bridge account "${String(accountIdRaw)}" for ${cliId}. Add the account first.`));
      return;
    }
    const accountId = typeof accountIdRaw === 'string' && accountIdRaw ? accountIdRaw : 'default';
    for (const [k, t] of logins) {
      if (k.startsWith(`${cliId}:`) && t.status === 'waiting' && t.accountId === accountId) {
        res.status(409).json(errorBody(`A login is already in progress for ${cliId} account "${accountId}". Cancel it first.`));
        return;
      }
    }
    const loginId = `login_${Date.now().toString(36)}_${(loginSeq += 1)}`;
    const tracked: TrackedLogin = { login: manager.startLogin(cliId, ctx), status: 'waiting', accountId };
    logins.set(keyOf(cliId, loginId), tracked);
    // Prune terminal logins so the map stays small.
    for (const [k, t] of [...logins]) {
      if (t.status !== 'waiting' && k !== keyOf(cliId, loginId)) logins.delete(k);
    }
    try {
      const url = await tracked.login.url;
      tracked.url = url;
      // acceptsCode: paste-code flows (Claude Code) — after authorizing,
      // the browser page shows a code the UI collects and POSTs to the
      // /code endpoint below.
      res.json({ ok: true, loginId, url, accountId, acceptsCode: tracked.login.submitCode !== undefined });
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

  router.post('/:cliId/login/:loginId/code', (req, res) => {
    const tracked = logins.get(keyOf(req.params.cliId, req.params.loginId));
    if (!tracked) {
      res.status(404).json(errorBody('Unknown or expired login id.'));
      return;
    }
    if (tracked.status !== 'waiting') {
      res.status(409).json(errorBody('This login is no longer waiting for a code.'));
      return;
    }
    if (!tracked.login.submitCode) {
      res.status(400).json(errorBody('This sign-in does not take a code — finish it in the browser page it opened.'));
      return;
    }
    const code = (req.body as { code?: unknown } | undefined)?.code;
    // The code is a one-time secret the user pasted: validate shape only,
    // hand it straight to the waiting CLI process, never log or store it.
    if (typeof code !== 'string' || code.trim().length === 0 || code.length > 512) {
      res.status(400).json(errorBody('A non-empty code is required.'));
      return;
    }
    tracked.login.submitCode(code);
    res.json({ ok: true });
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
