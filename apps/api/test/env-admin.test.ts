// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { describe, expect, it } from 'vitest';
import { ManagedEnvStore, createEnvAdminRouter, isSecretKey, parseManagedEnv } from '../src/env-admin-routes.js';

describe('ManagedEnvStore + env admin routes', () => {
  it('masks secret-looking keys, validates names, persists, and never echoes secrets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'env-admin-'));
    const audits: unknown[] = [];
    const app = express();
    app.use(express.json());
    app.use('/api/admin/env', createEnvAdminRouter({ dataDir: dir, audit: (_a, f) => audits.push(f.detail) }));
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/admin/env`;
    try {
      const putSecret = await fetch(base, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'X_BEARER_TOKEN', value: 'super-secret-value' }) });
      const putSecretText = await putSecret.text();
      expect(putSecret.status).toBe(200);
      expect(putSecretText).not.toContain('super-secret-value');
      await fetch(base, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'PLAIN_NAME', value: 'visible' }) });
      const bad = await fetch(base, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: '1BAD KEY', value: 'x' }) });
      expect(bad.status).toBe(400);

      const list = await (await fetch(base)).json() as { entries: Array<{ key: string; value: string | null; masked: boolean }>; note: string };
      expect(list.note).toContain('restart');
      const secret = list.entries.find((e) => e.key === 'X_BEARER_TOKEN')!;
      expect(secret).toMatchObject({ value: null, masked: true });
      const plain = list.entries.find((e) => e.key === 'PLAIN_NAME')!;
      expect(plain).toMatchObject({ value: 'visible', masked: false });
      expect(JSON.stringify(list)).not.toContain('super-secret-value');

      // Persisted to the managed file (mode-restricted), parseable back.
      const onDisk = readFileSync(join(dir, 'managed.env'), 'utf8');
      expect(parseManagedEnv(onDisk).get('X_BEARER_TOKEN')).toBe('super-secret-value');
      expect(JSON.stringify(audits)).not.toContain('super-secret-value');

      const del = await (await fetch(`${base}/X_BEARER_TOKEN`, { method: 'DELETE' })).json() as { removed: boolean };
      expect(del.removed).toBe(true);
      expect(new ManagedEnvStore(dir).read().has('X_BEARER_TOKEN')).toBe(false);
    } finally { server.close(); }
  });

  it('secret classification covers common patterns', () => {
    for (const k of ['API_KEY', 'X_BEARER_TOKEN', 'MY_SECRET', 'DB_PASSWORD', 'AUTH_HEADER', 'SESSION_ID']) expect(isSecretKey(k)).toBe(true);
    for (const k of ['PLAIN_NAME', 'PORT', 'REGION']) expect(isSecretKey(k)).toBe(false);
  });
});
