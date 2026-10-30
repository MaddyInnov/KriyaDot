// SPDX-License-Identifier: Apache-2.0
// CN-7: cross-merchant catalog — provider interface, Meta Catalog adapter
// (stubbed fetch; ZERO live calls), aggregator merge/dedupe/ranking, and
// the honest-fallback contract (mock rows are never presented as real).

import { describe, it, expect, vi } from 'vitest';
import {
  CrossMerchantCatalog,
  MetaCatalogProvider,
  MockCatalogProvider,
  createCrossMerchantCatalog,
  parsePriceToCents,
  type CatalogProduct,
  type ProductCatalogProvider,
} from './catalog.js';

function stubFetch(rows: unknown[], ok = true, status = 200): typeof fetch {
  return vi.fn(async () => ({
    ok,
    status,
    json: async () => ({ data: rows }),
  })) as unknown as typeof fetch;
}

const META_ENV = { META_CATALOG_ID: 'cat-123', META_CATALOG_ACCESS_TOKEN: 'tok-secret' };

describe('parsePriceToCents', () => {
  it('parses numbers, numeric strings and currency strings', () => {
    expect(parsePriceToCents(19.99)).toEqual({ priceCents: 1999, currency: 'USD' });
    expect(parsePriceToCents('19.99 USD')).toEqual({ priceCents: 1999, currency: 'USD' });
    expect(parsePriceToCents('EUR 1,250.50')).toEqual({ priceCents: 125050, currency: 'EUR' });
    expect(parsePriceToCents({ amount: '10.00', currency: 'gbp' })).toEqual({ priceCents: 1000, currency: 'GBP' });
  });
  it('returns null for unparseable prices (rows get dropped, never guessed)', () => {
    expect(parsePriceToCents('free')).toBeNull();
    expect(parsePriceToCents(undefined)).toBeNull();
    expect(parsePriceToCents({})).toBeNull();
  });
});

describe('MockCatalogProvider', () => {
  it('exposes the fixture behind the provider interface with provenance', async () => {
    const p = new MockCatalogProvider();
    expect(p.isConfigured()).toBe(true);
    const rows = await p.search('lamp');
    expect(rows).toHaveLength(1);
    expect(rows[0].providerId).toBe('mock');
    expect(rows[0].externalId).toBe('prod-001');
    expect(rows[0].merchant).toMatch(/fixture/i);
  });
});

describe('MetaCatalogProvider (env-gated adapter, stubbed fetch)', () => {
  it('is unconfigured without id+token and refuses to search', async () => {
    const p = new MetaCatalogProvider({ catalogId: '', accessToken: '' });
    expect(p.isConfigured()).toBe(false);
    await expect(p.search('lamp')).rejects.toThrow(/not configured/);
  });

  it('normalizes Graph rows, filters by query, and never leaks the token into rows', async () => {
    const fetchFn = stubFetch([
      { id: 'm1', name: 'Aurora Desk Lamp Pro', description: 'Brighter lamp', price: '59.99 USD', currency: 'USD', url: 'https://shop.example/lamp', image_url: 'https://img.example/lamp.jpg', availability: 'in stock' },
      { id: 'm2', name: 'Trail Backpack', description: 'Trail gear', price: 89.99, availability: 'out of stock' },
      { id: 'm3', name: 'Mystery Lamp', description: 'No price', price: 'free' },
    ]);
    const p = new MetaCatalogProvider({ catalogId: 'cat-123', accessToken: 'tok-secret', merchantName: 'Acme Store', fetchFn });
    const rows = await p.search('lamp');
    expect(rows.map((r) => r.externalId)).toEqual(['m1']); // backpack filtered out, priceless row dropped
    expect(rows[0]).toMatchObject({
      id: 'meta-catalog:m1',
      priceCents: 5999,
      currency: 'USD',
      merchant: 'Acme Store',
      productUrl: 'https://shop.example/lamp',
      availability: 'in_stock',
      providerId: 'meta-catalog',
    });
    expect(JSON.stringify(rows)).not.toContain('tok-secret');
    const calledUrl = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledUrl).toContain('/cat-123/products');
    expect(calledUrl).not.toContain('tok-secret'); // token travels in the header only
  });

  it('surfaces HTTP failures as errors (aggregator decides the fallback)', async () => {
    const p = new MetaCatalogProvider({ catalogId: 'c', accessToken: 't', fetchFn: stubFetch([], false, 401) });
    await expect(p.search('x')).rejects.toThrow(/HTTP 401/);
  });
});

function fakeRealProvider(id: string, rows: CatalogProduct[], fail = false): ProductCatalogProvider {
  return {
    id,
    displayName: id,
    kind: 'real',
    isConfigured: () => true,
    search: async () => {
      if (fail) throw new Error(`${id} exploded`);
      return rows;
    },
  };
}

function row(id: string, name: string, priceCents: number, providerId: string): CatalogProduct {
  return {
    id: `${providerId}:${id}`,
    name,
    description: '',
    priceCents,
    currency: 'USD',
    imageUrl: '',
    merchant: `Merchant ${providerId}`,
    externalId: id,
    availability: 'unknown',
    providerId,
  };
}

describe('CrossMerchantCatalog', () => {
  it('with no real provider configured, answers from the mock and says so', async () => {
    const catalog = createCrossMerchantCatalog({});
    expect(catalog.configuredProviders()).toHaveLength(0);
    const result = await catalog.search('lamp');
    expect(result.usedFallback).toBe(true);
    expect(result.degraded).toBe('no-real-provider');
    expect(result.products).toHaveLength(1);
    expect(result.products[0].providerId).toBe('mock');
  });

  it('merges merchants, dedupes by (merchant, external id), ranks name hits first', async () => {
    const a = fakeRealProvider('pa', [row('1', 'Desk Lamp', 5000, 'pa'), row('1', 'Desk Lamp', 5000, 'pa')]);
    const b = fakeRealProvider('pb', [row('9', 'Lamp for desks, deluxe edition', 3000, 'pb'), row('2', 'A lamp-shaped vase', 1000, 'pb')]);
    // pb rows match only by description semantics here: names contain "lamp" too,
    // so make the rank check explicit below with a description-only hit.
    const c = fakeRealProvider('pc', [{ ...row('7', 'Reading Light', 500, 'pc'), description: 'a lamp alternative' }]);
    const catalog = new CrossMerchantCatalog([a, b, c]);
    const result = await catalog.search('lamp');
    expect(result.usedFallback).toBe(false);
    expect(result.degraded).toBeUndefined();
    expect(result.sources.filter((s) => s.ok)).toHaveLength(3);
    const ids = result.products.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length); // deduped
    expect(result.products[result.products.length - 1].id).toBe('pc:7'); // description-only hit ranks last
  });

  it('falls back honestly when every real provider fails', async () => {
    const catalog = new CrossMerchantCatalog([fakeRealProvider('bad', [], true)]);
    const result = await catalog.search('lamp');
    expect(result.usedFallback).toBe(true);
    expect(result.degraded).toBe('real-providers-failed');
    expect(result.sources[0]).toMatchObject({ providerId: 'bad', ok: false });
    expect(result.sources[0].error).toMatch(/exploded/);
    expect(result.products[0].providerId).toBe('mock');
  });

  it('builds the Meta provider from env only when both vars are set', async () => {
    const fetchFn = stubFetch([{ id: 'm1', name: 'Lamp', description: '', price: '10.00 USD' }]);
    const withEnv = createCrossMerchantCatalog(META_ENV, fetchFn);
    expect(withEnv.configuredProviders().map((p) => p.id)).toEqual(['meta-catalog']);
    const result = await withEnv.search('lamp');
    expect(result.usedFallback).toBe(false);
    expect(result.products[0].merchant).toBeTruthy();
    const partial = createCrossMerchantCatalog({ META_CATALOG_ID: 'cat-123' });
    expect(partial.configuredProviders()).toHaveLength(0);
  });
});
