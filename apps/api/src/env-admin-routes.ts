// SPDX-License-Identifier: Apache-2.0
// Env-var management (Octop #184): admin endpoints over a MANAGED env file
// at <dataDir>/managed.env. This file is KriyaDot-owned configuration — it
// is NOT process.env: changes are written to the file and apply on the
// next server restart (the response says so; nothing pretends otherwise).
//
// Safety contract:
//   - Values of secret-looking keys (KEY/TOKEN/SECRET/PASSWORD/AUTH/
//     CREDENTIAL/PRIVATE/BEARER/SESSION/COOKIE …) are ALWAYS masked in
//     responses; non-secret values are shown only when they are short and
//     single-line, otherwise masked too.
//   - Set/delete responses NEVER echo the submitted value back.
//   - Key names are validated ([A-Za-z_][A-Za-z0-9_]*, max 128).
//   - Every mutation is audit-logged (key name only, never the value) via
//     the injected audit fn. Parent mounts this behind normal admin auth.

import fs from 'node:fs';
import path from 'node:path';
import express, { type Request, type Response, type Router } from 'express';

export const MANAGED_ENV_FILE = 'managed.env';
export const KEY_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export const SECRET_KEY_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL|PRIVATE|BEARER|SESSION|COOKIE|IBAN|SSN)/i;
export const MASK = '••••••••';

export function managedEnvPath(dataDir: string): string {
  return path.join(dataDir, MANAGED_ENV_FILE);
}

export function isValidEnvKey(key: unknown): key is string {
  return typeof key === 'string' && KEY_NAME_RE.test(key);
}

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}

/** Parse a dotenv-style file into ordered entries (comments/blanks dropped). */
export function parseManagedEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim().replace(/^export\s+/, '');
    if (!KEY_NAME_RE.test(key)) continue;
    let value = t.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out.set(key, value);
  }
  return out;
}

export function serializeManagedEnv(entries: Map<string, string>): string {
  const lines = ['# KriyaDot managed environment — changes apply on restart.'];
  for (const [k, v] of [...entries.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const needsQuote = /[\s#"'\\]/.test(v) || v.includes('\n');
    lines.push(needsQuote ? `${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"` : `${k}=${v}`);
  }
  return lines.join('\n') + '\n';
}

/** Display form of one entry: secret-looking keys are always masked. */
export function maskEntry(key: string, value: string): { key: string; value: string | null; masked: boolean; secret: boolean } {
  const secret = isSecretKey(key);
  if (secret) return { key, value: null, masked: true, secret: true };
  if (value.length > 200 || value.includes('\n')) return { key, value: null, masked: true, secret: false };
  return { key, value, masked: false, secret: false };
}

export class ManagedEnvStore {
  constructor(private readonly dataDir: string) {}
  get filePath(): string { return managedEnvPath(this.dataDir); }
  read(): Map<string, string> {
    try { return parseManagedEnv(fs.readFileSync(this.filePath, 'utf8')); } catch { return new Map(); }
  }
  private write(entries: Map<string, string>): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.filePath, serializeManagedEnv(entries), { mode: 0o600 });
  }
  list(): Array<ReturnType<typeof maskEntry>> {
    return [...this.read().entries()].map(([k, v]) => maskEntry(k, v)).sort((a, b) => (a.key < b.key ? -1 : 1));
  }
  set(key: string, value: string): void {
    if (!isValidEnvKey(key)) throw new Error(`invalid key name "${key}"`);
    if (value.length > 8192 || value.includes('\0')) throw new Error('value too large or invalid');
    const entries = this.read();
    entries.set(key, value);
    this.write(entries);
  }
  delete(key: string): boolean {
    if (!isValidEnvKey(key)) throw new Error(`invalid key name "${key}"`);
    const entries = this.read();
    const had = entries.delete(key);
    if (had) this.write(entries);
    return had;
  }
}

export interface EnvAdminRouteDeps {
  dataDir: string;
  store?: ManagedEnvStore;
  audit?: (action: string, fields: { actor?: string; toolName?: string; detail?: unknown }) => void;
  actor?: (req: Request) => string;
}

/**
 * Router factory — parent mounts behind normal admin auth, e.g.
 *   app.use('/api/admin/env', createEnvAdminRouter({ dataDir, audit }))
 * Routes: GET / (masked list); PUT / {key, value}; DELETE /:key.
 * Responses never contain a submitted secret value.
 */
export function createEnvAdminRouter(deps: EnvAdminRouteDeps): Router {
  const store = deps.store ?? new ManagedEnvStore(deps.dataDir);
  const router = express.Router();
  const note = 'Changes are written to managed.env and apply on restart.';
  const audit = (req: Request, action: string, key: string): void => {
    try { deps.audit?.(`env.${action}`, { actor: deps.actor?.(req) ?? 'user', toolName: 'env-admin', detail: { key } }); } catch { /* ignore */ }
  };
  router.get('/', (_req: Request, res: Response) => {
    res.json({ ok: true, file: MANAGED_ENV_FILE, appliesOnRestart: true, note, entries: store.list() });
  });
  router.put('/', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { key?: unknown; value?: unknown };
    if (!isValidEnvKey(body.key)) { res.status(400).json({ error: 'invalid_key', detail: 'Key names must match [A-Za-z_][A-Za-z0-9_]* (max 128 chars).' }); return; }
    if (typeof body.value !== 'string') { res.status(400).json({ error: 'invalid_value', detail: '"value" must be a string.' }); return; }
    try {
      store.set(body.key, body.value);
    } catch (err) {
      res.status(400).json({ error: 'set_failed', detail: err instanceof Error ? err.message : String(err) });
      return;
    }
    audit(req, 'set', body.key);
    // Never echo the value back — only that the key is set (+ masked view).
    res.json({ ok: true, key: body.key, set: true, secret: isSecretKey(body.key), appliesOnRestart: true, note });
  });
  router.delete('/:key', (req: Request, res: Response) => {
    const key = req.params.key;
    if (!isValidEnvKey(key)) { res.status(400).json({ error: 'invalid_key' }); return; }
    const removed = store.delete(key);
    if (removed) audit(req, 'delete', key);
    res.json({ ok: true, key, removed, appliesOnRestart: true, note });
  });
  return router;
}
