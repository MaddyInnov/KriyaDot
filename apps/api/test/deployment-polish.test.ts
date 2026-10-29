// SPDX-License-Identifier: Apache-2.0
// Deployment polish: subpath middleware, interactive API docs, TLS options,
// storage admin routes.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createBasePathMiddleware, normalizeBasePath, basePathWebConfig } from '../src/base-path.js';
import { buildOpenApiDocument, createApiDocsRouter, API_SPEC_REGISTRY } from '../src/api-docs.js';
import { buildTlsOptions } from '../src/tls-options.js';
import { saveCertificateToStore } from '../src/acme.js';
import { createStorageAdminRouter, type StorageBackendLike } from '../src/storage-admin-routes.js';

async function serve(app: express.Express): Promise<{ server: ReturnType<express.Express['listen']>; base: string; close: () => Promise<void> }> {
  let server!: ReturnType<express.Express['listen']>;
  await new Promise<void>((r) => {
    server = app.listen(0, '127.0.0.1', r);
  });
  return {
    server,
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe('base path', () => {
  it('normalizes prefixes', () => {
    expect(normalizeBasePath('')).toBe('');
    expect(normalizeBasePath('/')).toBe('');
    expect(normalizeBasePath('kriyadot')).toBe('/kriyadot');
    expect(normalizeBasePath('/kriyadot/')).toBe('/kriyadot');
    expect(() => normalizeBasePath('/a/../b')).toThrow();
    const web = basePathWebConfig({ KRIYADOT_BASE_PATH: '/kd' } as NodeJS.ProcessEnv);
    expect(web).toMatchObject({ basePath: '/kd', nextConfigBasePath: '/kd', env: { NEXT_PUBLIC_BASE_PATH: '/kd' } });
  });

  it('strips the prefix for routed requests and rejects outside-prefix paths', async () => {
    const app = express();
    app.use(createBasePathMiddleware('/kd'));
    app.get('/api/ping', (_req, res) => res.json({ pong: true }));
    const { base, close } = await serve(app);
    try {
      const ok = await fetch(`${base}/kd/api/ping`);
      expect(ok.status).toBe(200);
      expect((await ok.json()) as unknown).toEqual({ pong: true });
      const root = await fetch(`${base}/kd`);
      expect(root.status).toBe(404); // '/' after strip → no route, but reached the app
      const outside = await fetch(`${base}/api/ping`);
      expect(outside.status).toBe(404);
      const outsideBody = (await outside.json()) as { error: string };
      expect(outsideBody.error).toContain('/kd');
    } finally {
      await close();
    }
  });
});

describe('api docs', () => {
  it('OpenAPI document parses and contains the new workstream paths in detail', () => {
    const doc = buildOpenApiDocument() as { openapi: string; paths: Record<string, Record<string, { description?: string }>> };
    expect(doc.openapi).toBe('3.1.0');
    for (const p of ['/api/kb', '/api/kb/{id}/documents', '/api/kb/{id}/share', '/api/storage', '/api/storage/health', '/api/docs.json', '/.well-known/acme-challenge/{token}']) {
      expect(doc.paths[p], p).toBeTruthy();
    }
    expect(doc.paths['/api/kb/{id}/documents'].post.description).toContain('Original text is retained');
    expect(API_SPEC_REGISTRY.length).toBeGreaterThan(15);
  });

  it('serves docs.json + a self-contained HTML explorer with no external URLs', async () => {
    const app = express();
    app.use('/api', createApiDocsRouter());
    const { base, close } = await serve(app);
    try {
      const json = await (await fetch(`${base}/api/docs.json`)).json() as { openapi: string };
      expect(json.openapi).toBe('3.1.0');
      const html = await (await fetch(`${base}/api/docs`)).text();
      expect(html).toContain('KriyaDot API');
      expect(html).not.toMatch(/https?:\/\//);
      expect(html).not.toMatch(/src\s*=\s*"\/\//);
      expect(html).not.toContain('cdn');
    } finally {
      await close();
    }
  });
});

describe('tls options', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tls-opts-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns undefined with no config or missing files', () => {
    expect(buildTlsOptions({})).toBeUndefined();
    expect(buildTlsOptions({ certPath: join(dir, 'no.pem'), keyPath: join(dir, 'no.key') })).toBeUndefined();
    expect(buildTlsOptions({ acmeStoreDir: join(dir, 'acme-empty') })).toBeUndefined();
  });

  it('loads static paths and the ACME store layout', () => {
    const certPath = join(dir, 'cert.pem');
    const keyPath = join(dir, 'key.pem');
    writeFileSync(certPath, 'CERT-PEM');
    writeFileSync(keyPath, 'KEY-PEM');
    const statics = buildTlsOptions({ certPath, keyPath });
    expect(statics?.cert.toString()).toBe('CERT-PEM');
    expect(statics?.key.toString()).toBe('KEY-PEM');

    const acmeDir = join(dir, 'acme');
    saveCertificateToStore(acmeDir, { certPem: 'ACME-CERT', keyPem: 'ACME-KEY', domains: ['x.test'], obtainedAt: '' });
    const fromAcme = buildTlsOptions({ acmeStoreDir: acmeDir });
    expect(fromAcme?.cert.toString()).toBe('ACME-CERT');
    expect(fromAcme?.key.toString()).toBe('ACME-KEY');
  });
});

describe('storage admin routes', () => {
  it('lists backends, health probes, and counts objects', async () => {
    const objects = ['a.txt', 'b/c.txt'];
    const good: StorageBackendLike = {
      kind: 'local',
      list: async () => [...objects],
      health: async () => ({ ok: true, detail: 'fine' }),
    };
    const bad: StorageBackendLike = {
      kind: 's3',
      list: async () => {
        throw new Error('boom');
      },
      health: async () => ({ ok: false, detail: 'down' }),
    };
    const app = express();
    app.use('/api/storage', createStorageAdminRouter({ backends: { main: good, remote: bad }, assignments: { 'bot-1': 'main' } }));
    const { base, close } = await serve(app);
    try {
      const list = (await (await fetch(`${base}/api/storage`)).json()) as { backends: Array<{ name: string; assignedBots: string[] }> };
      expect(list.backends).toHaveLength(2);
      expect(list.backends.find((b) => b.name === 'main')?.assignedBots).toEqual(['bot-1']);
      const health = (await (await fetch(`${base}/api/storage/health`)).json()) as { backends: Array<{ name: string; ok: boolean; objectCount?: number }> };
      expect(health.backends.find((b) => b.name === 'main')).toMatchObject({ ok: true, objectCount: 2 });
      expect(health.backends.find((b) => b.name === 'remote')).toMatchObject({ ok: false });
      const count = (await (await fetch(`${base}/api/storage/main/count`)).json()) as { objectCount: number };
      expect(count.objectCount).toBe(2);
      expect((await fetch(`${base}/api/storage/ghost/count`)).status).toBe(404);
    } finally {
      await close();
    }
  });
});
