// SPDX-License-Identifier: Apache-2.0
// models.dev catalog refresh (OpenMausBot parity P1 #23).
//
// The app keeps a cached copy of the models.dev model catalog
// (https://models.dev/api.json — models, providers, list pricing). Refresh is
// ALWAYS manual (POST /api/models/refresh); the app never re-fetches on its
// own, so a catalog change can never surprise a running setup. On fetch
// failure the previous cache is kept and the error is surfaced.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const MODELS_DEV_URL = 'https://models.dev/api.json';
const CACHE_FILE = 'models-dev-catalog.json';

export interface ModelsDevModel {
  id: string;
  name: string;
  contextLength?: number;
  /** USD per 1M input tokens, when published. */
  inputPer1M?: number;
  /** USD per 1M output tokens, when published. */
  outputPer1M?: number;
}

export interface ModelsDevProvider {
  id: string;
  name: string;
  models: ModelsDevModel[];
}

export interface ModelsDevCatalog {
  fetchedAt: string;
  providers: ModelsDevProvider[];
}

function cachePath(dataDir: string): string {
  return path.join(dataDir, CACHE_FILE);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Validate + normalize the raw models.dev payload into our compact catalog.
 * Throws on anything that is not recognizably the models.dev shape —
 * callers keep the old cache in that case.
 */
export function normalizeModelsDevPayload(raw: unknown): ModelsDevCatalog {
  if (!isRecord(raw)) throw new Error('models.dev payload is not an object');
  const providers: ModelsDevProvider[] = [];
  for (const [providerId, pRaw] of Object.entries(raw)) {
    if (!isRecord(pRaw)) continue;
    const modelsRaw = pRaw['models'];
    if (!isRecord(modelsRaw)) continue;
    const models: ModelsDevModel[] = [];
    for (const [modelId, mRaw] of Object.entries(modelsRaw)) {
      if (!isRecord(mRaw)) continue;
      const id = str(mRaw['id']) ?? modelId;
      const name = str(mRaw['name']) ?? id;
      const limit = isRecord(mRaw['limit']) ? mRaw['limit'] : undefined;
      const cost = isRecord(mRaw['cost']) ? mRaw['cost'] : undefined;
      models.push({
        id,
        name,
        ...(num(limit?.['context']) !== undefined ? { contextLength: num(limit?.['context']) } : {}),
        ...(num(cost?.['input']) !== undefined ? { inputPer1M: num(cost?.['input']) } : {}),
        ...(num(cost?.['output']) !== undefined ? { outputPer1M: num(cost?.['output']) } : {}),
      });
    }
    if (models.length === 0) continue;
    providers.push({
      id: str(pRaw['id']) ?? providerId,
      name: str(pRaw['name']) ?? providerId,
      models,
    });
  }
  if (providers.length === 0) throw new Error('models.dev payload contains no providers with models');
  return { fetchedAt: new Date().toISOString(), providers };
}

export interface ModelsDevFetchOptions {
  /** Test seam / custom transport. Defaults to global fetch. */
  fetcher?: typeof fetch;
  timeoutMs?: number;
  url?: string;
}

/** Fetch + validate the live models.dev catalog. Throws on any failure. */
export async function fetchModelsDevCatalog(opts: ModelsDevFetchOptions = {}): Promise<ModelsDevCatalog> {
  const fetcher = opts.fetcher ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const url = opts.url ?? MODELS_DEV_URL;
  let res: Response;
  try {
    res = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new Error(`models.dev fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new Error(`models.dev returned HTTP ${res.status}`);
  let raw: unknown;
  try {
    raw = await res.json();
  } catch (err) {
    throw new Error(`models.dev returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return normalizeModelsDevPayload(raw);
}

/** Read the cached catalog, or null when there is none / it is corrupt. */
export function readModelsDevCache(dataDir: string): ModelsDevCatalog | null {
  const p = cachePath(dataDir);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as {
      fetchedAt?: unknown;
      providers?: unknown;
    };
    if (!str(parsed.fetchedAt) || !Array.isArray(parsed.providers)) return null;
    // Re-validate the provider/model entries loosely; drop malformed rows.
    const providers: ModelsDevProvider[] = [];
    for (const pRaw of parsed.providers) {
      if (!isRecord(pRaw) || !str(pRaw['id']) || !Array.isArray(pRaw['models'])) continue;
      const models: ModelsDevModel[] = [];
      for (const mRaw of pRaw['models']) {
        if (!isRecord(mRaw) || !str(mRaw['id'])) continue;
        models.push({
          id: mRaw['id'] as string,
          name: str(mRaw['name']) ?? (mRaw['id'] as string),
          ...(num(mRaw['contextLength']) !== undefined ? { contextLength: num(mRaw['contextLength']) } : {}),
          ...(num(mRaw['inputPer1M']) !== undefined ? { inputPer1M: num(mRaw['inputPer1M']) } : {}),
          ...(num(mRaw['outputPer1M']) !== undefined ? { outputPer1M: num(mRaw['outputPer1M']) } : {}),
        });
      }
      if (models.length > 0) {
        providers.push({
          id: pRaw['id'] as string,
          name: str(pRaw['name']) ?? (pRaw['id'] as string),
          models,
        });
      }
    }
    if (providers.length === 0) return null;
    return { fetchedAt: parsed.fetchedAt as string, providers };
  } catch {
    return null;
  }
}

/** Persist a validated catalog to the data dir. */
export function writeModelsDevCache(dataDir: string, catalog: ModelsDevCatalog): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(cachePath(dataDir), JSON.stringify(catalog, null, 2), 'utf8');
}

/** Milliseconds since the cache was fetched, or null when there is no cache. */
export function modelsDevCacheAgeMs(dataDir: string, nowMs: number = Date.now()): number | null {
  const cached = readModelsDevCache(dataDir);
  if (!cached) return null;
  const fetched = Date.parse(cached.fetchedAt);
  if (!Number.isFinite(fetched)) return null;
  return Math.max(0, nowMs - fetched);
}

/** "updated 3 days ago" style relative age for the UI. */
export function formatCatalogAge(ageMs: number | null): string {
  if (ageMs === null) return 'never updated';
  const mins = Math.floor(ageMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.floor(months / 12);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

/**
 * Refresh the cache from models.dev. Returns the new catalog. On failure the
 * old cache is untouched and the error propagates (callers surface it).
 */
export async function refreshModelsDevCatalog(
  dataDir: string,
  opts: ModelsDevFetchOptions = {},
): Promise<ModelsDevCatalog> {
  const catalog = await fetchModelsDevCatalog(opts);
  writeModelsDevCache(dataDir, catalog);
  return catalog;
}
