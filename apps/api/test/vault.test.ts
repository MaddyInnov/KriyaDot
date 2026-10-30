// SPDX-License-Identifier: Apache-2.0
// Tests for apps/api/src/vault.ts:
// - vault CRUD roundtrip; values never listed, never logged, never in errors
// - per-user namespace isolation (user A's secrets invisible to user B)
// - wallet mock flows: add/list/remove, charge refused, no full PAN on disk
// - /accounts/summary builds on the OAuth framework (no tokens returned)
// Temp data dirs only — never the shared data dir.

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, GovernanceGateway } from '@mvp/governance';
import type { AppConfig } from '../src/config.js';
import { registerVaultRoutes } from '../src/vault.js';

const OWNER_TOKEN = 'test-owner-token'; // loopback owner credential (OPEN-1: tests authenticate as the owner; x-user-id then asserts the local profile)

function freshDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'vault-api-'));
}

interface ApiResult {
  status: number;
  json: any;
}

const CARD = { cardNumber: '4111 1111 1111 1111', expMonth: 12, expYear: 2030 };

describe('vault router', () => {
  let dir: string;
  let baseUrl: string;
  let server: ReturnType<import('node:http').Server> | null = null;

  beforeEach(async () => {
    dir = freshDataDir();
    const governance = new GovernanceGateway({ dbPath: ':memory:', policy: DEFAULT_POLICY });
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerVaultRoutes(router, { config: { dataDir: dir } as AppConfig, governance, loopbackToken: OWNER_TOKEN });
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

  async function api(method: string, path: string, body?: unknown, userId = 'alice'): Promise<ApiResult> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${OWNER_TOKEN}`, 'x-user-id': userId },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  }

  it('stores, reads, updates, deletes — list never returns values', async () => {
    const created = await api('POST', '/vault', { name: 'openai-key', value: 'sk-secret-xyz', description: 'main' });
    expect(created.status).toBe(201);
    expect(created.json.value).toBeUndefined();

    const listed = await api('GET', '/vault');
    expect(listed.json).toHaveLength(1);
    expect(JSON.stringify(listed.json)).not.toContain('sk-secret-xyz');

    const got = await api('GET', '/vault/openai-key');
    expect(got.json.value).toBe('sk-secret-xyz');

    const updated = await api('PUT', '/vault/openai-key', { value: 'sk-rotated' });
    expect(updated.status).toBe(200);
    expect(updated.json.value).toBeUndefined();
    expect((await api('GET', '/vault/openai-key')).json.value).toBe('sk-rotated');

    expect((await api('DELETE', '/vault/openai-key')).status).toBe(200);
    expect((await api('GET', '/vault/openai-key')).status).toBe(404);
    expect((await api('GET', '/vault')).json).toEqual([]);
  });

  it('isolates users: alice secrets invisible to bob', async () => {
    await api('POST', '/vault', { name: 'tok', value: 'alice-secret' }, 'alice');
    expect((await api('GET', '/vault', undefined, 'bob')).json).toEqual([]);
    expect((await api('GET', '/vault/tok', undefined, 'bob')).status).toBe(404);
  });

  it('rejects bad names without leaking the value in the error', async () => {
    const r = await api('POST', '/vault', { name: 'bad name', value: 'my-secret-value' });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.json)).not.toContain('my-secret-value');
  });

  it('wallet: add/list/remove mock methods, charge refused', async () => {
    const added = await api('POST', '/wallet/methods', CARD);
    expect(added.status).toBe(201);
    expect(added.json.brand).toBe('visa');
    expect(added.json.last4).toBe('1111');
    expect(JSON.stringify(added.json)).not.toContain('4111111111111111');

    const methods = await api('GET', '/wallet/methods');
    expect(methods.json).toHaveLength(1);

    const charge = await api('POST', '/wallet/charge', { methodId: added.json.id, amountMinor: 100, currency: 'USD' });
    expect(charge.status).toBe(400);
    expect(charge.json.error).toMatch(/never processes real charges/i);

    expect((await api('DELETE', `/wallet/methods/${added.json.id}`)).status).toBe(200);
    expect((await api('GET', '/wallet/methods')).json).toEqual([]);
  });

  it('accounts summary: no tokens, no secret values, mock wallet', async () => {
    await api('POST', '/vault', { name: 'k', value: 'v' });
    await api('POST', '/wallet/methods', CARD);
    const r = await api('GET', '/accounts/summary');
    expect(r.status).toBe(200);
    expect(r.json.vault.secretCount).toBe(1);
    expect(r.json.wallet).toMatchObject({ provider: 'mock', mock: true, chargesEnabled: false, methodCount: 1 });
    expect(Array.isArray(r.json.oauth)).toBe(true);
    const blob = JSON.stringify(r.json);
    expect(blob).not.toContain('sk-');
    expect(blob).not.toContain('"accessToken"');
    expect(blob).not.toContain('4111111111111111');
  });

  it('encrypts secrets at rest on disk', async () => {
    await api('POST', '/vault', { name: 'k', value: 'on-disk-secret-abc' });
    const raw = readFileSync(join(dir, 'vault.alice.json'), 'utf8');
    expect(raw).not.toContain('on-disk-secret-abc');
    expect(JSON.parse(raw).alg).toBe('aes-256-gcm');
  });

  it('privacy tiers: defaults to local-only, accepts overrides, rejects bad tiers', async () => {
    const created = await api('POST', '/vault', { name: 'k1', value: 'v1' });
    expect(created.status).toBe(201);
    expect(created.json.tier).toBe('local-only');

    const listed = await api('GET', '/vault');
    expect(listed.json[0].tier).toBe('local-only');
    expect((await api('GET', '/vault/k1')).json.tier).toBe('local-only');

    const over = await api('POST', '/vault', { name: 'k2', value: 'v2', tier: 'cloud-ok' });
    expect(over.json.tier).toBe('cloud-ok');

    const upd = await api('PUT', '/vault/k2', { tier: 'metadata' });
    expect(upd.json.tier).toBe('metadata');

    const bad = await api('POST', '/vault', { name: 'k3', value: 'v3', tier: 'secret' });
    expect(bad.status).toBe(400);
  });
});
