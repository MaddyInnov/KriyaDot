// SPDX-License-Identifier: Apache-2.0
// models.dev catalog refresh HTTP routes (OpenMausBot parity P1 #23):
// catalog-info, refresh with mocked fetch (success + failure keeps the old
// cache), and /api/models merge behavior.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeModelsDevCache, type ModelsDevCatalog } from '@mvp/agent-runtime';
import { registerModelsDevRoutes } from '../src/models-dev-routes.js';

let dataDir: string;
let server: { close(cb: () => void): void } | undefined;
let baseUrl = '';

function sampleCatalog(): ModelsDevCatalog {
  return {
    fetchedAt: new Date(Date.now() - 3 * 24 * 3600_000).toISOString(),
    providers: [
      {
        id: 'groq',
        name: 'Groq',
        models: [{ id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B', inputPer1M: 0.59, outputPer1M: 0.79 }],
      },
    ],
  };
}

function stubModelsDevFetch(raw: unknown, status = 200) {
  const realFetch = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('models.dev')) {
        return new Response(typeof raw === 'string' ? raw : JSON.stringify(raw), { status });
      }
      return realFetch(url as string, init);
    }),
  );
}

function makeApp() {
  const app = express();
  app.use(express.json());
  const router = express.Router();
  registerModelsDevRoutes(router, { dataDir });
  app.use('/api', router);
  return app;
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'models-dev-routes-test-'));
  const app = makeApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve()) as unknown as { close(cb: () => void): void };
  });
  const port = (server as unknown as { address(): { port: number } }).address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  rmSync(dataDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

async function api(path: string, init?: RequestInit) {
  const res = await fetch(baseUrl + path, init);
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

describe('models.dev routes', () => {
  it('catalog-info reports never-updated when no cache', async () => {
    const { status, body } = await api('/api/models/catalog-info');
    expect(status).toBe(200);
    expect(body.fetchedAt).toBeNull();
    expect(body.ageLabel).toBe('never updated');
    expect(body.providerCount).toBe(0);
  });

  it('catalog-info reports age for a cached catalog', async () => {
    writeModelsDevCache(dataDir, sampleCatalog());
    const { status, body } = await api('/api/models/catalog-info');
    expect(status).toBe(200);
    expect(body.ageLabel).toBe('3 days ago');
    expect(body.providerCount).toBe(1);
    expect(body.modelCount).toBe(1);
  });

  it('refresh fetches, validates, and caches', async () => {
    const raw = {
      groq: {
        id: 'groq',
        name: 'Groq',
        models: {
          'llama-3.3-70b-versatile': {
            id: 'llama-3.3-70b-versatile',
            name: 'Llama 3.3 70B',
            cost: { input: 0.59, output: 0.79 },
          },
        },
      },
    };
    stubModelsDevFetch(raw);
    const { status, body } = await api('/api/models/refresh', { method: 'POST' });
    expect(status).toBe(200);
    expect(body.providerCount).toBe(1);
    expect(body.modelCount).toBe(1);
    const info = (await api('/api/models/catalog-info')).body;
    expect(info.ageLabel).toBe('just now');
    expect(info.modelCount).toBe(1);
  });

  it('refresh failure keeps the old cache and surfaces 502', async () => {
    writeModelsDevCache(dataDir, sampleCatalog());
    stubModelsDevFetch('bad', 500);
    const { status, body } = await api('/api/models/refresh', { method: 'POST' });
    expect(status).toBe(502);
    expect(String(body.error)).toMatch(/previous catalog kept/);
    const info = (await api('/api/models/catalog-info')).body;
    expect(info.ageLabel).toBe('3 days ago');
    expect(info.modelCount).toBe(1);
  });

  it('refresh rejects invalid payloads without clobbering the cache', async () => {
    writeModelsDevCache(dataDir, sampleCatalog());
    stubModelsDevFetch({ nope: true });
    const { status } = await api('/api/models/refresh', { method: 'POST' });
    expect(status).toBe(502);
    expect((await api('/api/models/catalog-info')).body.modelCount).toBe(1);
  });
});
