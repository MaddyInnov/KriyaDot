// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchModelsDevCatalog,
  formatCatalogAge,
  modelsDevCacheAgeMs,
  normalizeModelsDevPayload,
  readModelsDevCache,
  refreshModelsDevCatalog,
  writeModelsDevCache,
  type ModelsDevCatalog,
} from '../src/providers/models-dev.js';

const dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'models-dev-test-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function sampleRaw() {
  return {
    groq: {
      id: 'groq',
      name: 'Groq',
      env: ['GROQ_API_KEY'],
      models: {
        'llama-3.3-70b-versatile': {
          id: 'llama-3.3-70b-versatile',
          name: 'Llama 3.3 70B Versatile',
          limit: { context: 131072, output: 32768 },
          cost: { input: 0.59, output: 0.79 },
        },
        'openai/gpt-oss-120b': {
          id: 'openai/gpt-oss-120b',
          name: 'GPT OSS 120B',
          cost: { input: 0.15, output: 0.75 },
        },
      },
    },
    anthropic: {
      id: 'anthropic',
      name: 'Anthropic',
      models: {
        'claude-opus-4-5': { id: 'claude-opus-4-5', name: 'Claude Opus 4.5' },
      },
    },
  };
}

function okFetcher(raw: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(raw), { status: 200 }));
}

describe('normalizeModelsDevPayload', () => {
  it('normalizes the real models.dev shape', () => {
    const catalog = normalizeModelsDevPayload(sampleRaw());
    expect(catalog.providers).toHaveLength(2);
    const groq = catalog.providers.find((p) => p.id === 'groq');
    expect(groq?.name).toBe('Groq');
    const llama = groq?.models.find((m) => m.id === 'llama-3.3-70b-versatile');
    expect(llama).toMatchObject({ name: 'Llama 3.3 70B Versatile', contextLength: 131072, inputPer1M: 0.59, outputPer1M: 0.79 });
    const opus = catalog.providers.find((p) => p.id === 'anthropic')?.models[0];
    expect(opus?.inputPer1M).toBeUndefined();
    expect(catalog.fetchedAt).toBeTruthy();
  });

  it('rejects garbage payloads', () => {
    expect(() => normalizeModelsDevPayload(null)).toThrow();
    expect(() => normalizeModelsDevPayload([])).toThrow();
    expect(() => normalizeModelsDevPayload({})).toThrow(/no providers/);
    expect(() => normalizeModelsDevPayload({ x: { id: 'x' } })).toThrow(/no providers/);
  });
});

describe('fetchModelsDevCatalog', () => {
  it('fetches and normalizes on success', async () => {
    const catalog = await fetchModelsDevCatalog({ fetcher: okFetcher(sampleRaw()) as unknown as typeof fetch });
    expect(catalog.providers).toHaveLength(2);
  });

  it('throws on HTTP errors without touching the cache', async () => {
    const dir = freshDir();
    const before: ModelsDevCatalog = { fetchedAt: new Date().toISOString(), providers: [] };
    // write a valid cache manually then confirm a failed refresh keeps it
    writeModelsDevCache(dir, { ...before, providers: [{ id: 'x', name: 'x', models: [{ id: 'm', name: 'm' }] }] });
    const bad = vi.fn(async () => new Response('nope', { status: 500 }));
    await expect(
      refreshModelsDevCatalog(dir, { fetcher: bad as unknown as typeof fetch }),
    ).rejects.toThrow(/HTTP 500/);
    expect(readModelsDevCache(dir)?.providers[0].id).toBe('x');
  });

  it('throws on network failure', async () => {
    const down = vi.fn(async () => { throw new Error('boom'); });
    await expect(
      fetchModelsDevCatalog({ fetcher: down as unknown as typeof fetch }),
    ).rejects.toThrow(/fetch failed/);
  });
});

describe('cache read/write/age', () => {
  it('round-trips and reports age', () => {
    const dir = freshDir();
    expect(readModelsDevCache(dir)).toBeNull();
    expect(modelsDevCacheAgeMs(dir)).toBeNull();
    const catalog: ModelsDevCatalog = {
      fetchedAt: new Date(Date.now() - 3 * 24 * 3600_000).toISOString(),
      providers: [{ id: 'groq', name: 'Groq', models: [{ id: 'm', name: 'm' }] }],
    };
    writeModelsDevCache(dir, catalog);
    const back = readModelsDevCache(dir);
    expect(back?.providers).toHaveLength(1);
    const age = modelsDevCacheAgeMs(dir);
    expect(age).not.toBeNull();
    expect(formatCatalogAge(age)).toBe('3 days ago');
  });

  it('returns null for corrupt cache', () => {
    const dir = freshDir();
    writeFileSync(join(dir, 'models-dev-catalog.json'), '{not json');
    expect(readModelsDevCache(dir)).toBeNull();
  });

  it('formats ages', () => {
    expect(formatCatalogAge(null)).toBe('never updated');
    expect(formatCatalogAge(30_000)).toBe('just now');
    expect(formatCatalogAge(5 * 60_000)).toBe('5 minutes ago');
    expect(formatCatalogAge(2 * 3600_000)).toBe('2 hours ago');
    expect(formatCatalogAge(24 * 3600_000)).toBe('1 day ago');
    expect(formatCatalogAge(45 * 24 * 3600_000)).toBe('1 month ago');
  });
});
