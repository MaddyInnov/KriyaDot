// SPDX-License-Identifier: Apache-2.0
// BYO VPS API (OpenMausBot parity P1 #24).
//
//   GET    /api/bots/:id/vps              — profile (no secrets) + connection status
//   PUT    /api/bots/:id/vps              — save profile; { privateKey } is stored
//                                          into the vault ONCE (never echoed back)
//   DELETE /api/bots/:id/vps              — disconnect + delete profile
//   POST   /api/bots/:id/vps/test         — { password? } → OS info + desktop-tool check
//   POST   /api/bots/:id/vps/connect      — { password?, trustFingerprint? }
//   POST   /api/bots/:id/vps/disconnect
//   GET    /api/bots/:id/vps/status       — connection status
//   GET    /api/vps/default               — global default profile
//   PUT    /api/vps/default               — save global default profile
//
// Secrets: private keys live in the SecureVault ('default-user' namespace,
// like provider keys); passwords are request-scoped only and never persisted.

import type { Request, Response, Router } from 'express';
import { SecureVault } from '@mvp/vault';
import type {
  BotConfig,
  VpsConnectionPool,
  VpsProfile,
} from '@mvp/agent-runtime';
import {
  VpsAuthError,
  VpsFingerprintMismatchError,
  VpsPasswordRequiredError,
  VpsProfileError,
  VpsSandbox,
  VpsTrustRequiredError,
} from '@mvp/agent-runtime';
import {
  deleteVpsProfile,
  loadVpsProfiles,
  resolveVpsProfile,
  saveVpsDefaultProfile,
  saveVpsFingerprint,
  saveVpsProfile,
} from './vps-profiles.js';

export interface VpsRouteDeps {
  bots: BotConfig[];
  dataDir: string;
  pool: VpsConnectionPool;
  audit: (action: string, fields: Record<string, unknown>) => void;
  errorBody: (error: string, detail?: string) => { error: string; detail?: string };
}

const BOT_ID_RE = /^[A-Za-z0-9_:-]{1,128}$/;
const VAULT_NAMESPACE = 'default-user';

function vaultOf(deps: VpsRouteDeps): SecureVault {
  return new SecureVault(deps.dataDir, VAULT_NAMESPACE, 'vps');
}

function botOf(deps: VpsRouteDeps, id: string): BotConfig | undefined {
  return deps.bots.find((b) => b.id === id);
}

/** Vault secret name for a bot's pasted private key. */
function keySecretName(botId: string): string {
  return `vps-ssh-key-${botId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)}`;
}

function looksLikePem(key: string): boolean {
  const t = key.trim();
  return (
    t.includes('-----BEGIN ') &&
    t.includes('PRIVATE KEY-----') &&
    t.length < 32 * 1024
  );
}

/**
 * PUT body: profile fields + optional one-time `privateKey` (PEM text).
 * The key is moved into the vault and replaced by a privateKeyRef.
 */
function extractProfileInput(
  deps: VpsRouteDeps,
  botId: string | null,
  body: unknown,
): { profileInput: Record<string, unknown>; keyStored: boolean } {
  const o = (body ?? {}) as Record<string, unknown>;
  const profileInput: Record<string, unknown> = { ...o };
  let keyStored = false;
  if (o.privateKey !== undefined) {
    if (typeof o.privateKey !== 'string' || !looksLikePem(o.privateKey)) {
      throw new VpsProfileError('privateKey must be PEM text ("-----BEGIN ... PRIVATE KEY-----")');
    }
    const name =
      typeof o.privateKeyRef === 'string' && o.privateKeyRef.trim()
        ? o.privateKeyRef.trim()
        : botId
          ? keySecretName(botId)
          : 'vps-ssh-key-default';
    const vault = vaultOf(deps);
    const existing = vault.get(name);
    if (existing) vault.update(name, o.privateKey, 'VPS SSH private key (BYO VPS)');
    else vault.create(name, o.privateKey, 'VPS SSH private key (BYO VPS)');
    profileInput.privateKeyRef = name;
    keyStored = true;
  }
  delete profileInput.privateKey;
  // Never accept a password in the profile body.
  delete profileInput.password;
  return { profileInput, keyStored };
}

function poolKey(botId: string): string {
  return `bot:${botId}`;
}

/** Which stored profile backs the effective one (for fingerprint pinning). */
function profileOwner(dataDir: string, botId: string): string | null {
  const file = loadVpsProfiles(dataDir);
  return file.profiles[botId] ? botId : null;
}

function statusOf(deps: VpsRouteDeps, botId: string) {
  const conn = deps.pool.get(poolKey(botId));
  if (!conn) return { status: 'disconnected' as const, reconnectAttempts: 0 };
  return conn.statusInfo();
}

export function registerVpsRoutes(router: Router, deps: VpsRouteDeps): void {
  const needBot = (req: Request, res: Response): BotConfig | null => {
    const id = req.params.id;
    if (!BOT_ID_RE.test(id)) {
      res.status(400).json(deps.errorBody('Invalid bot id'));
      return null;
    }
    const bot = botOf(deps, id);
    if (!bot) {
      res.status(404).json(deps.errorBody('Unknown bot', `No bot with id "${id}"`));
      return null;
    }
    return bot;
  };

  // -- profiles ------------------------------------------------------

  router.get('/bots/:id/vps', (req: Request, res: Response) => {
    const bot = needBot(req, res);
    if (!bot) return;
    const file = loadVpsProfiles(deps.dataDir);
    const profile = file.profiles[bot.id] ?? null;
    res.json({
      ok: true,
      botId: bot.id,
      profile,
      hasDefault: !!file.default,
      effectiveFrom: profile ? 'bot' : file.default ? 'default' : null,
      status: statusOf(deps, bot.id),
    });
  });

  router.put('/bots/:id/vps', (req: Request, res: Response) => {
    const bot = needBot(req, res);
    if (!bot) return;
    try {
      const { profileInput, keyStored } = extractProfileInput(deps, bot.id, req.body);
      const profile = saveVpsProfile(deps.dataDir, bot.id, profileInput);
      // A changed profile invalidates the live connection.
      void deps.pool.drop(poolKey(bot.id)).catch(() => undefined);
      deps.audit('vps.profile_saved', { actor: 'user', botId: bot.id, keyStored });
      res.json({ ok: true, botId: bot.id, profile, keyStored });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = err instanceof VpsProfileError ? 400 : 500;
      res.status(status).json(deps.errorBody('Failed to save VPS profile', message));
    }
  });

  router.delete('/bots/:id/vps', async (req: Request, res: Response) => {
    const bot = needBot(req, res);
    if (!bot) return;
    await deps.pool.drop(poolKey(bot.id));
    const existed = deleteVpsProfile(deps.dataDir, bot.id);
    deps.audit('vps.profile_deleted', { actor: 'user', botId: bot.id });
    res.json({ ok: true, botId: bot.id, deleted: existed });
  });

  router.get('/bots/:id/vps/status', (req: Request, res: Response) => {
    const bot = needBot(req, res);
    if (!bot) return;
    res.json({ ok: true, botId: bot.id, ...statusOf(deps, bot.id) });
  });

  router.get('/vps/default', (_req: Request, res: Response) => {
    const file = loadVpsProfiles(deps.dataDir);
    res.json({ ok: true, profile: file.default ?? null });
  });

  router.put('/vps/default', (req: Request, res: Response) => {
    try {
      const { profileInput, keyStored } = extractProfileInput(deps, null, req.body);
      const profile = saveVpsDefaultProfile(deps.dataDir, profileInput);
      deps.audit('vps.default_profile_saved', { actor: 'user', keyStored });
      res.json({ ok: true, profile, keyStored });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = err instanceof VpsProfileError ? 400 : 500;
      res.status(status).json(deps.errorBody('Failed to save default VPS profile', message));
    }
  });

  // -- connections ---------------------------------------------------

  /** Shared connect logic for /test and /connect. */
  async function doConnect(
    botId: string,
    body: { password?: unknown; trustFingerprint?: unknown },
  ): Promise<
    | { ok: true; fingerprint: string; newlyTrusted: boolean }
    | { ok: false; trustRequired: true; fingerprint: string }
  > {
    const profile: VpsProfile | undefined = resolveVpsProfile(deps.dataDir, botId);
    if (!profile) {
      throw new Error(`no VPS profile configured for bot "${botId}"`);
    }
    const password = typeof body.password === 'string' && body.password ? body.password : undefined;
    const trustFingerprint = body.trustFingerprint === true;
    const conn = deps.pool.getOrCreate(poolKey(botId), profile);
    try {
      const res = await conn.connect({ ...(password ? { password } : {}), trustFingerprint });
      if (res.newlyTrusted) {
        // Persist the TOFU pin so reconnects verify against it.
        saveVpsFingerprint(deps.dataDir, profileOwner(deps.dataDir, botId), res.fingerprint);
      }
      return { ok: true, fingerprint: res.fingerprint, newlyTrusted: res.newlyTrusted };
    } catch (err) {
      if (err instanceof VpsTrustRequiredError) {
        return { ok: false, trustRequired: true, fingerprint: err.fingerprint };
      }
      throw err;
    }
  }

  function connectError(res: Response, err: unknown): void {
    if (err instanceof VpsFingerprintMismatchError) {
      res.status(409).json(
        deps.errorBody('VPS host key mismatch — refusing to connect', err.message),
      );
      return;
    }
    if (err instanceof VpsPasswordRequiredError) {
      res.status(401).json(deps.errorBody('VPS password required', err.message));
      return;
    }
    if (err instanceof VpsAuthError) {
      res.status(401).json(deps.errorBody('VPS authentication failed', err.message));
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    res.status(502).json(deps.errorBody('VPS connection failed', message));
  }

  router.post('/bots/:id/vps/test', async (req: Request, res: Response) => {
    const bot = needBot(req, res);
    if (!bot) return;
    const body = (req.body ?? {}) as { password?: unknown; trustFingerprint?: unknown };
    try {
      const cr = await doConnect(bot.id, body);
      if (!cr.ok) {
        res.status(409).json({
          ok: false,
          trustRequired: true as const,
          fingerprint: cr.fingerprint,
          hint: 'Re-run with trustFingerprint: true after verifying this fingerprint out-of-band.',
        });
        return;
      }
      const conn = deps.pool.get(poolKey(bot.id));
      if (!conn) throw new Error('VPS connection vanished after connect');
      const sandbox = new VpsSandbox(conn);
      const os = await sandbox.osInfo();
      const tools = await sandbox.runCommand('command -v xdotool; command -v import; command -v scrot', {
        timeoutMs: 15_000,
        maxOutputBytes: 2048,
      });
      const lines = tools.stdout.split('\n').map((l) => l.trim());
      res.json({
        ok: true,
        botId: bot.id,
        os,
        newlyTrusted: cr.newlyTrusted,
        fingerprint: cr.fingerprint,
        desktopTools: {
          xdotool: lines.some((l) => l.endsWith('/xdotool')),
          screenshot: lines.some((l) => l.endsWith('/import') || l.endsWith('/scrot')),
        },
      });
    } catch (err) {
      connectError(res, err);
    }
  });

  router.post('/bots/:id/vps/connect', async (req: Request, res: Response) => {
    const bot = needBot(req, res);
    if (!bot) return;
    const body = (req.body ?? {}) as { password?: unknown; trustFingerprint?: unknown };
    try {
      const cr = await doConnect(bot.id, body);
      if (!cr.ok) {
        res.status(409).json({
          ok: false,
          trustRequired: true as const,
          fingerprint: cr.fingerprint,
          hint: 'Re-run with trustFingerprint: true after verifying this fingerprint out-of-band.',
        });
        return;
      }
      deps.audit('vps.connected', {
        actor: 'user',
        botId: bot.id,
        newlyTrusted: cr.newlyTrusted,
      });
      res.json({ ok: true, botId: bot.id, ...statusOf(deps, bot.id) });
    } catch (err) {
      connectError(res, err);
    }
  });

  router.post('/bots/:id/vps/disconnect', async (req: Request, res: Response) => {
    const bot = needBot(req, res);
    if (!bot) return;
    await deps.pool.drop(poolKey(bot.id));
    deps.audit('vps.disconnected', { actor: 'user', botId: bot.id });
    res.json({ ok: true, botId: bot.id, status: 'disconnected' });
  });
}
