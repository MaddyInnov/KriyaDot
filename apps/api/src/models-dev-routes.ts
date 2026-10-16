// SPDX-License-Identifier: Apache-2.0
// models.dev catalog refresh HTTP API (OpenMausBot parity P1 #23).
//
//   GET  /models/catalog-info → { fetchedAt, ageMs, ageLabel, providerCount, modelCount }
//   POST /models/refresh      → re-fetch from models.dev, validate, cache
//
// Refresh is manual-only: the app never re-fetches on its own, so a catalog
// change can never surprise a running setup. On failure the previous cache
// is kept and the error is surfaced (502).

import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  formatCatalogAge,
  modelsDevCacheAgeMs,
  readModelsDevCache,
  refreshModelsDevCatalog,
} from '@mvp/agent-runtime';

function errorBody(error: string, detail?: string): { error: string; detail?: string } {
  return detail ? { error, detail } : { error };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface ModelsDevRouteDeps {
  dataDir: string;
}

export function registerModelsDevRoutes(router: Router, deps: ModelsDevRouteDeps): void {
  const { dataDir } = deps;

  router.get('/models/catalog-info', (_req: Request, res: Response) => {
    try {
      const cached = readModelsDevCache(dataDir);
      const ageMs = modelsDevCacheAgeMs(dataDir);
      res.json({
        fetchedAt: cached?.fetchedAt ?? null,
        ageMs,
        ageLabel: formatCatalogAge(ageMs),
        providerCount: cached?.providers.length ?? 0,
        modelCount: cached ? cached.providers.reduce((n, p) => n + p.models.length, 0) : 0,
      });
    } catch (err) {
      res.status(500).json(errorBody('failed to read model catalog cache', errMessage(err)));
    }
  });

  router.post('/models/refresh', async (_req: Request, res: Response) => {
    try {
      const catalog = await refreshModelsDevCatalog(dataDir);
      res.json({
        ok: true,
        fetchedAt: catalog.fetchedAt,
        ageLabel: formatCatalogAge(0),
        providerCount: catalog.providers.length,
        modelCount: catalog.providers.reduce((n, p) => n + p.models.length, 0),
      });
    } catch (err) {
      // Old cache (if any) is untouched — surface the failure.
      res.status(502).json(errorBody('models.dev refresh failed; previous catalog kept', errMessage(err)));
    }
  });
}
