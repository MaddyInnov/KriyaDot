// SPDX-License-Identifier: Apache-2.0
// Cross-merchant product catalog (Muse parity audit §4.12: CN-7).
//
// Until now shopping search ran over MOCK_CATALOG only (./index.ts) — one
// fake merchant, eight fixture products. This module introduces the real
// shape Muse has: a PROVIDER INTERFACE for product catalogs, one real
// adapter, and an aggregator that searches across merchants and merges
// the results.
//
//   ProductCatalogProvider        the interface every catalog implements
//   MockCatalogProvider           the existing fixture, behind the
//                                 interface (fallback + tests)
//   MetaCatalogProvider           adapter over a Meta (Facebook) product
//                                 catalog via the Graph API — ENV-GATED:
//                                 it is only constructed when
//                                 META_CATALOG_ID + META_CATALOG_ACCESS_TOKEN
//                                 are set, and it is inert otherwise.
//   CrossMerchantCatalog          searches every configured provider,
//                                 dedupes by (merchant, external id),
//                                 ranks name matches above description
//                                 matches, and reports HONEST provenance:
//                                 which providers answered, which failed,
//                                 and whether the answer fell back to the
//                                 sample catalog.
//
// HONESTY RULES (do not soften):
//   - When no real provider is configured, results carry
//     `degraded: 'no-real-provider'` — the UI/agent must be able to tell
//     the user these are sample products, not live listings.
//   - When real providers are configured but ALL fail, the aggregator
//     falls back to the mock catalog and says so (`usedFallback: true`
//     plus the per-provider errors). It never presents mock rows as real.
//   - Prices are normalized to minor units; rows whose price cannot be
//     parsed are dropped rather than guessed.
//
// The Meta adapter's live path is UNVERIFIED in this build (no Meta
// catalog token is available to the build environment): it is covered by
// tests against a stubbed fetch that replays the documented Graph API
// product shape. See the CN-7 section of the wave WIRING note.

import { MOCK_CATALOG, type Product } from './index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A product as returned by a catalog provider: the base Product shape
 *  plus the cross-merchant provenance shopping search needs. */
export interface CatalogProduct extends Product {
  /** Merchant / storefront display name, e.g. "Meta Catalog: Acme Store". */
  merchant: string;
  /** The product's id inside that merchant's catalog. */
  externalId: string;
  /** Canonical product page on the merchant, when the provider gives one. */
  productUrl?: string;
  availability: 'in_stock' | 'out_of_stock' | 'unknown';
  /** Provider id that produced this row (provenance). */
  providerId: string;
}

export interface CatalogSearchOptions {
  /** Max rows per provider (default 25, max 100). */
  limit?: number;
}

export interface ProductCatalogProvider {
  /** Stable provider id, e.g. "meta-catalog", "mock". */
  id: string;
  displayName: string;
  /** 'real' providers reach a live merchant catalog; 'mock' is the fixture. */
  kind: 'real' | 'mock';
  /** True when everything the provider needs (keys, ids) is present. */
  isConfigured(): boolean;
  search(query: string, opts?: CatalogSearchOptions): Promise<CatalogProduct[]>;
}

export interface ProviderOutcome {
  providerId: string;
  kind: 'real' | 'mock';
  ok: boolean;
  count: number;
  error?: string;
}

export interface CrossMerchantSearchResult {
  products: CatalogProduct[];
  /** One entry per provider actually queried, in query order. */
  sources: ProviderOutcome[];
  /** True when real providers were configured but the rows came from the mock fallback. */
  usedFallback: boolean;
  /**
   * Set when the answer is not fully real:
   *   'no-real-provider' — nothing real is configured; sample catalog only.
   *   'real-providers-failed' — real providers configured, all failed.
   * Absent when at least one real provider answered.
   */
  degraded?: 'no-real-provider' | 'real-providers-failed';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampLimit(raw: number | undefined, fallback = 25): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  return Math.min(100, Math.max(1, Math.floor(raw)));
}

/** Parse a provider price into minor units. Accepts numbers (major units),
 *  numeric strings, and "19.99 USD" / "USD 19.99" style strings. Returns
 *  null when no trustworthy number is present — callers drop the row. */
export function parsePriceToCents(
  value: unknown,
): { priceCents: number; currency: string } | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { priceCents: Math.round(value * 100), currency: 'USD' };
  }
  if (typeof value === 'string') {
    const currencyMatch = value.match(/[A-Za-z]{3}/);
    const numMatch = value.replace(/,/g, '').match(/\d+(?:\.\d{1,2})?/);
    if (!numMatch) return null;
    const major = Number(numMatch[0]);
    if (!Number.isFinite(major)) return null;
    return {
      priceCents: Math.round(major * 100),
      currency: currencyMatch ? currencyMatch[0].toUpperCase() : 'USD',
    };
  }
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    // Graph API money shape: { amount, currency } (amount in major units or cents by field).
    if (typeof v.amount === 'string' || typeof v.amount === 'number') {
      const inner = parsePriceToCents(v.amount);
      if (inner) {
        return {
          priceCents: inner.priceCents,
          currency: typeof v.currency === 'string' ? v.currency.toUpperCase() : inner.currency,
        };
      }
    }
  }
  return null;
}

function matchesQuery(p: { name: string; description: string }, q: string): boolean {
  if (!q) return true;
  return p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q);
}

/** Relevance rank: name hit (0) beats description-only hit (1); empty query ties. */
function relevance(p: CatalogProduct, q: string): number {
  if (!q) return 0;
  return p.name.toLowerCase().includes(q) ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Mock provider — the shipped fixture behind the interface.
// ---------------------------------------------------------------------------

export class MockCatalogProvider implements ProductCatalogProvider {
  readonly id = 'mock';
  readonly displayName = 'Built-in sample catalog';
  readonly kind = 'mock' as const;

  isConfigured(): boolean {
    return true;
  }

  async search(query: string, opts?: CatalogSearchOptions): Promise<CatalogProduct[]> {
    const q = (query ?? '').trim().toLowerCase();
    const limit = clampLimit(opts?.limit);
    return MOCK_CATALOG.filter((p) => matchesQuery(p, q))
      .slice(0, limit)
      .map((p) => ({
        ...p,
        merchant: 'Sample Store (built-in fixture)',
        externalId: p.id,
        availability: 'unknown' as const,
        providerId: this.id,
      }));
  }
}

// ---------------------------------------------------------------------------
// Meta Catalog provider — real adapter, env-gated.
// ---------------------------------------------------------------------------

export interface MetaCatalogConfig {
  /** Meta product catalog id (the catalog whose products are searched). */
  catalogId: string;
  /** Graph API access token with catalog read permission. Never logged. */
  accessToken: string;
  /** Merchant display name attached to every row. */
  merchantName?: string;
  /** Graph API version segment, default 'v21.0'. */
  graphVersion?: string;
  /** Injectable fetch (tests stub it). Defaults to global fetch. */
  fetchFn?: typeof fetch;
}

interface MetaProductRow {
  id?: string;
  name?: string;
  title?: string;
  description?: string;
  price?: unknown;
  currency?: string;
  url?: string;
  link?: string;
  image_url?: string;
  availability?: string;
}

export class MetaCatalogProvider implements ProductCatalogProvider {
  readonly id = 'meta-catalog';
  readonly displayName = 'Meta Catalog';
  readonly kind = 'real' as const;

  constructor(private readonly config: MetaCatalogConfig) {}

  isConfigured(): boolean {
    return Boolean(this.config.catalogId?.trim() && this.config.accessToken?.trim());
  }

  async search(query: string, opts?: CatalogSearchOptions): Promise<CatalogProduct[]> {
    if (!this.isConfigured()) {
      throw new Error(
        'Meta Catalog is not configured: set META_CATALOG_ID and META_CATALOG_ACCESS_TOKEN.',
      );
    }
    const limit = clampLimit(opts?.limit);
    const version = this.config.graphVersion ?? 'v21.0';
    const fields = 'id,name,description,price,currency,url,image_url,availability';
    const url =
      `https://graph.facebook.com/${version}/${encodeURIComponent(this.config.catalogId)}/products` +
      `?fields=${encodeURIComponent(fields)}&limit=${limit}`;
    const fetchFn = this.config.fetchFn ?? fetch;
    const res = await fetchFn(url, {
      headers: { authorization: `Bearer ${this.config.accessToken}`, accept: 'application/json' },
      signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(15_000) : undefined,
    });
    if (!res.ok) throw new Error(`Meta Catalog search failed: HTTP ${res.status}`);
    const body = (await res.json().catch(() => ({}))) as { data?: MetaProductRow[] };
    const rows = Array.isArray(body.data) ? body.data : [];
    const q = (query ?? '').trim().toLowerCase();
    const merchant = this.config.merchantName ?? 'Meta Catalog merchant';
    const out: CatalogProduct[] = [];
    for (const row of rows) {
      const name = (row.name ?? row.title ?? '').trim();
      if (!row.id || !name) continue;
      const price = parsePriceToCents(row.price);
      if (!price) continue; // no trustworthy price → drop, never guess
      const product: CatalogProduct = {
        id: `meta-catalog:${row.id}`,
        name,
        description: typeof row.description === 'string' ? row.description : '',
        priceCents: price.priceCents,
        currency: typeof row.currency === 'string' ? row.currency.toUpperCase() : price.currency,
        imageUrl: typeof row.image_url === 'string' ? row.image_url : '',
        merchant,
        externalId: row.id,
        productUrl: typeof row.url === 'string' ? row.url : typeof row.link === 'string' ? row.link : undefined,
        availability:
          row.availability === 'in stock'
            ? 'in_stock'
            : row.availability === 'out of stock'
              ? 'out_of_stock'
              : 'unknown',
        providerId: this.id,
      };
      // The Graph catalog listing endpoint has no server-side text search;
      // filtering is client-side over the returned page (documented limit).
      if (matchesQuery(product, q)) out.push(product);
      if (out.length >= limit) break;
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Cross-merchant aggregator
// ---------------------------------------------------------------------------

export class CrossMerchantCatalog {
  private readonly realProviders: ProductCatalogProvider[];
  private readonly fallback: ProductCatalogProvider;

  /**
   * @param providers  candidate providers; unconfigured ones are skipped.
   * @param fallback   provider used when no real provider answers
   *                   (default: the mock fixture provider).
   */
  constructor(providers: ProductCatalogProvider[], fallback?: ProductCatalogProvider) {
    this.realProviders = providers.filter((p) => p.kind === 'real');
    this.fallback = fallback ?? new MockCatalogProvider();
  }

  /** Real providers that are actually usable right now. */
  configuredProviders(): ProductCatalogProvider[] {
    return this.realProviders.filter((p) => p.isConfigured());
  }

  async search(query: string, opts?: CatalogSearchOptions): Promise<CrossMerchantSearchResult> {
    const limit = clampLimit(opts?.limit, 25);
    const configured = this.configuredProviders();
    const sources: ProviderOutcome[] = [];

    if (configured.length === 0) {
      const products = await this.fallback.search(query, { limit });
      sources.push({ providerId: this.fallback.id, kind: this.fallback.kind, ok: true, count: products.length });
      return { products, sources, usedFallback: true, degraded: 'no-real-provider' };
    }

    const merged: CatalogProduct[] = [];
    const seen = new Set<string>();
    let anyOk = false;
    for (const provider of configured) {
      try {
        const rows = await provider.search(query, { limit });
        anyOk = true;
        sources.push({ providerId: provider.id, kind: 'real', ok: true, count: rows.length });
        for (const row of rows) {
          const key = `${row.providerId}::${row.merchant}::${row.externalId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push(row);
        }
      } catch (err) {
        sources.push({
          providerId: provider.id,
          kind: 'real',
          ok: false,
          count: 0,
          error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
        });
      }
    }

    if (!anyOk) {
      const products = await this.fallback.search(query, { limit });
      sources.push({ providerId: this.fallback.id, kind: this.fallback.kind, ok: true, count: products.length });
      return { products, sources, usedFallback: true, degraded: 'real-providers-failed' };
    }

    const q = (query ?? '').trim().toLowerCase();
    merged.sort((a, b) => relevance(a, q) - relevance(b, q) || a.priceCents - b.priceCents);
    return { products: merged.slice(0, limit), sources, usedFallback: false };
  }
}

// ---------------------------------------------------------------------------
// Env construction
// ---------------------------------------------------------------------------

export interface CatalogEnv {
  META_CATALOG_ID?: string | undefined;
  META_CATALOG_ACCESS_TOKEN?: string | undefined;
  META_CATALOG_MERCHANT_NAME?: string | undefined;
}

/**
 * Build the production catalog from the environment: the Meta adapter is
 * included ONLY when its env is present (env-gated); the mock fixture is
 * always the honest fallback. `fetchFn` is injectable for tests.
 */
export function createCrossMerchantCatalog(
  env: CatalogEnv = process.env as CatalogEnv,
  fetchFn?: typeof fetch,
): CrossMerchantCatalog {
  const providers: ProductCatalogProvider[] = [];
  const catalogId = (env.META_CATALOG_ID ?? '').trim();
  const accessToken = (env.META_CATALOG_ACCESS_TOKEN ?? '').trim();
  if (catalogId && accessToken) {
    providers.push(
      new MetaCatalogProvider({
        catalogId,
        accessToken,
        merchantName: (env.META_CATALOG_MERCHANT_NAME ?? '').trim() || undefined,
        fetchFn,
      }),
    );
  }
  return new CrossMerchantCatalog(providers);
}
