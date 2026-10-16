// SPDX-License-Identifier: Apache-2.0
// Tests for the saved-login API endpoints (type_login support):
//   GET  /api/vault/logins  → LoginMeta[] (never passwords)
//   POST /api/vault/logins  → LoginMeta (201)
//   DELETE /api/vault/:name → removes logins too
//   GET  /api/vault/:name   → 404 for login-kind records (no raw JSON reads)

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, GovernanceGateway } from '@mvp/governance';
import type { AppConfig } from '../src/config.js';
import { registerVaultRoutes } from '../src/vault.js';

const PASSWORD = 's3cr3t-p@ssw0rd-xyz';

interface ApiResult {
  status: number;
  json: any;
}

describe('vault login endpoints', () => {
  let baseUrl: string;
  let server: ReturnType<import('node:http').Server> | null = null;

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vault-login-api-'));
    const governance = new GovernanceGateway({ dbPath: ':memory:', policy: DEFAULT_POLICY });
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerVaultRoutes(router, { config: { dataDir: dir } as AppConfig, governance });
    app.use('/api', router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}/api`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) =>
      (server as unknown as { close(cb: () => void): void }).close(() => resolve()),
    );
    server = null;
  });

  async function api(method: string, path: string, body?: unknown): Promise<ApiResult> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-user-id': 'alice' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  }

  it('creates and lists logins without ever returning passwords', async () => {
    const created = await api('POST', '/vault/logins', {
      name: 'gh',
      site: 'github.com',
      username: 'octocat',
      password: PASSWORD,
    });
    expect(created.status).toBe(201);
    expect(created.json.site).toBe('github.com');
    expect(created.json.username).toBe('octocat');
    expect(JSON.stringify(created.json)).not.toContain(PASSWORD);

    const listed = await api('GET', '/vault/logins');
    expect(listed.status).toBe(200);
    expect(listed.json).toHaveLength(1);
    expect(listed.json[0].name).toBe('gh');
    expect(JSON.stringify(listed.json)).not.toContain(PASSWORD);
  });

  it('rejects invalid login payloads', async () => {
    expect((await api('POST', '/vault/logins', { name: 'x', site: '', username: 'u', password: 'p' })).status).toBe(400);
    expect((await api('POST', '/vault/logins', { name: 'x', site: 'example.com', username: 'u' })).status).toBe(400);
  });

  it('raw secret reads 404 for login-kind records', async () => {
    await api('POST', '/vault/logins', { name: 'gh', site: 'github.com', username: 'octocat', password: PASSWORD });
    const raw = await api('GET', '/vault/gh');
    expect(raw.status).toBe(404);
  });

  it('logins are deletable via DELETE /vault/:name', async () => {
    await api('POST', '/vault/logins', { name: 'gh', site: 'github.com', username: 'octocat', password: PASSWORD });
    const del = await api('DELETE', '/vault/gh');
    expect(del.status).toBe(200);
    expect((await api('GET', '/vault/logins')).json).toHaveLength(0);
  });

  it('plain secrets and logins coexist; secrets list hides nothing new', async () => {
    await api('POST', '/vault', { name: 'api-key', value: 'shh' });
    await api('POST', '/vault/logins', { name: 'gh', site: 'github.com', username: 'u', password: PASSWORD });
    const secrets = await api('GET', '/vault');
    expect(secrets.json.map((s: any) => s.name).sort()).toEqual(['api-key', 'gh']);
    const logins = await api('GET', '/vault/logins');
    expect(logins.json.map((l: any) => l.name)).toEqual(['gh']);
  });
});
