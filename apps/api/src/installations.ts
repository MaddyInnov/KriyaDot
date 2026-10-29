// SPDX-License-Identifier: Apache-2.0
// Installations registry (enterprise pack) — a REAL local registry surface.
//
// This instance self-registers on boot (registerSelf) into
// <dataDir>/installations.json: { id, version, hostnameHash, startedAt,
// lastHeartbeatAt }. Other KriyaDot instances in a fleet may register with
// THIS deployment by POSTing to /installations/register with the shared
// registration token (env KRIYADOT_REGISTRATION_TOKEN, compared in constant
// time; when unset, registration from non-self callers is disabled).
// GET /installations is admin-only (org owner/admin or loopback bearer).
// Hostnames are stored only as SHA-256 hashes — never in plaintext.
//
// This is a deployment-local registry, not a cloud service: it lists only
// installations that have registered to THIS deployment's endpoint.
//
// HOST WIRING (index.ts):
//   import { createInstallationsRouter, registerSelfInstallation } from './installations.js';
//   registerSelfInstallation(config.dataDir, pkgVersion);
//   app.use('/api/installations', createInstallationsRouter({ dataDir: config.dataDir, tenancyDbPath }));

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import express, { type Router } from 'express';
import { TenantStore, canAct } from '@mvp/tenancy';

export interface InstallationRecord {
  id: string;
  version: string;
  hostnameHash: string;
  startedAt: number;
  lastHeartbeatAt: number;
  self?: boolean;
}

export function hashHostname(hostname: string): string {
  return createHash('sha256').update(hostname).digest('hex').slice(0, 32);
}

export class InstallationRegistry {
  private readonly file: string;
  constructor(dataDir: string) {
    this.file = join(dataDir, 'installations.json');
  }

  private read(): InstallationRecord[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown;
      return Array.isArray(parsed) ? (parsed as InstallationRecord[]) : [];
    } catch {
      return [];
    }
  }

  private write(records: InstallationRecord[]): void {
    fs.mkdirSync(join(this.file, '..'), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(records, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  register(input: { id?: string; version: string; hostname?: string; hostnameHash?: string; self?: boolean }): InstallationRecord {
    const records = this.read();
    const id = input.id && /^[A-Za-z0-9_-]{8,64}$/.test(input.id) ? input.id : `inst_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const now = Date.now();
    const existing = records.find((r) => r.id === id);
    const record: InstallationRecord = {
      id,
      version: String(input.version ?? '0.0.0').slice(0, 40),
      hostnameHash: input.hostnameHash ?? hashHostname(input.hostname ?? 'unknown'),
      startedAt: existing?.startedAt ?? now,
      lastHeartbeatAt: now,
      ...(input.self || existing?.self ? { self: true } : {}),
    };
    const next = records.filter((r) => r.id !== id);
    next.push(record);
    this.write(next);
    return record;
  }

  heartbeat(id: string): InstallationRecord | undefined {
    const records = this.read();
    const rec = records.find((r) => r.id === id);
    if (!rec) return undefined;
    rec.lastHeartbeatAt = Date.now();
    this.write(records);
    return rec;
  }

  list(): InstallationRecord[] {
    return this.read().sort((a, b) => a.startedAt - b.startedAt);
  }
}

const SELF_ID_FILE = '.installation-id';

export function registerSelfInstallation(dataDir: string, version: string): InstallationRecord {
  fs.mkdirSync(dataDir, { recursive: true });
  const idFile = join(dataDir, SELF_ID_FILE);
  let id: string;
  try {
    id = fs.readFileSync(idFile, 'utf8').trim();
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) throw new Error('bad id');
  } catch {
    id = `inst_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    fs.writeFileSync(idFile, `${id}\n`, { mode: 0o600 });
  }
  return new InstallationRegistry(dataDir).register({ id, version, hostname: os.hostname(), self: true });
}

export interface InstallationsDeps {
  dataDir: string;
  tenancyDbPath?: string;
  /** Defaults to env KRIYADOT_REGISTRATION_TOKEN. */
  registrationToken?: string;
  audit?: (action: string, fields: { actor?: string; detail?: unknown }) => void;
}

function callerOf(req: express.Request): string {
  const h = req.header('x-user-id');
  return typeof h === 'string' && h ? h : 'default-user';
}

export function createInstallationsRouter(deps: InstallationsDeps): Router {
  const router = express.Router();
  const registry = new InstallationRegistry(deps.dataDir);
  const tenants = new TenantStore(deps.tenancyDbPath ?? join(deps.dataDir, 'tenancy.db'));
  const expectedToken = deps.registrationToken ?? process.env.KRIYADOT_REGISTRATION_TOKEN ?? '';

  function tokenOk(provided: unknown): boolean {
    if (!expectedToken || typeof provided !== 'string') return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(expectedToken);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  function isAdmin(req: express.Request): boolean {
    if ((req as express.Request & { loopbackAuthed?: boolean }).loopbackAuthed) return true;
    return tenants.listOrgsForUser(callerOf(req)).some((o) => canAct(o.role, 'admin'));
  }

  router.post('/register', (req, res) => {
    const body = (req.body ?? {}) as { id?: string; version?: unknown; hostname?: string; token?: unknown };
    const headerToken = req.header('x-registration-token');
    if (!tokenOk(body.token ?? headerToken)) {
      res.status(401).json({ ok: false, error: 'invalid or missing registration token' });
      return;
    }
    if (typeof body.version !== 'string' || !body.version) {
      res.status(400).json({ ok: false, error: 'version is required' });
      return;
    }
    const record = registry.register({ id: body.id, version: body.version, hostname: body.hostname });
    deps.audit?.('installations.registered', { actor: 'installation', detail: { id: record.id, version: record.version } });
    res.status(201).json({ ok: true, installation: record });
  });

  router.post('/:id/heartbeat', (req, res) => {
    const body = (req.body ?? {}) as { token?: unknown };
    if (!tokenOk(body.token ?? req.header('x-registration-token'))) {
      res.status(401).json({ ok: false, error: 'invalid or missing registration token' });
      return;
    }
    const rec = registry.heartbeat(req.params.id);
    if (!rec) {
      res.status(404).json({ ok: false, error: 'unknown installation' });
      return;
    }
    res.json({ ok: true, installation: rec });
  });

  router.get('/', (req, res) => {
    if (!isAdmin(req)) {
      res.status(403).json({ ok: false, error: 'installations list requires an org admin/owner (or the loopback token)' });
      return;
    }
    res.json({ ok: true, installations: registry.list() });
  });

  return router;
}
