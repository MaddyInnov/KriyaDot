// SPDX-License-Identifier: Apache-2.0
// Voice catalog HTTP API: searchable TTS voice lists for the picker.
//
// Expected mount (parent wires this in index.ts):
//
//   import { createVoiceCatalogRouter } from './voice-catalog-routes.js';
//   app.use('/api', createVoiceCatalogRouter());
//
// Routes (relative to the mount point):
//   GET /voice/catalog?provider=elevenlabs&q=narrator&language=en
//     → 200 { provider, query, count, voices: VoiceCatalogEntry[] }
//     → 400 when `provider` is missing/unknown or its key is unset
//     → 502 when the provider's catalog request itself fails
//
// Providers: elevenlabs (account voices, or the shared library when q
// is present), fish (public model search), chatterbox (self-hosted
// /voices), openai/groq (static built-in lists), mock/system (empty).
// Catalog keys are resolved server-side from env and never returned.

import { Router, type Request, type Response } from 'express';
import {
  searchVoiceCatalog,
  VOICE_CATALOG_PROVIDERS,
  type VoiceCatalogEntry,
  type VoiceFetchFn,
} from '@mvp/voice';

/** The catalog search the router delegates to (injectable for tests). */
export type VoiceCatalogSearchFn = (
  provider: string,
  search: { query?: string; language?: string; pageSize?: number },
) => Promise<VoiceCatalogEntry[]>;

export interface VoiceCatalogRouterDeps {
  /** Env source for provider keys/URLs; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Injectable fetch forwarded to the catalog providers (tests). */
  fetchFn?: VoiceFetchFn;
  /** Full search override (tests); bypasses env/fetch wiring. */
  searchCatalog?: VoiceCatalogSearchFn;
}

function errorBody(error: string, detail?: string): { error: string; detail?: string } {
  return detail ? { error, detail } : { error };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Map a catalog failure onto an HTTP status: config problems are the
 *  caller's to fix (400); a failed upstream request is a 502. */
export function voiceCatalogErrorStatus(message: string): 400 | 502 {
  if (/unknown voice catalog provider/i.test(message)) return 400;
  if (/missing (ELEVENLABS_API_KEY|FISH_API_KEY|CHATTERBOX_BASE_URL)/i.test(message)) return 400;
  if (/not configured/i.test(message)) return 400;
  return 502;
}

export function createVoiceCatalogRouter(deps: VoiceCatalogRouterDeps = {}): Router {
  const router = Router();
  const env = deps.env ?? process.env;
  const searchCatalog: VoiceCatalogSearchFn =
    deps.searchCatalog ??
    ((provider, search) => searchVoiceCatalog(provider, search, { env, fetchFn: deps.fetchFn }));

  router.get('/voice/catalog', async (req: Request, res: Response) => {
    const providerRaw = typeof req.query.provider === 'string' ? req.query.provider.trim() : '';
    if (!providerRaw) {
      res.status(400).json(
        errorBody(
          '"provider" query param is required',
          `expected one of: ${VOICE_CATALOG_PROVIDERS.join(', ')}`,
        ),
      );
      return;
    }
    const query = typeof req.query.q === 'string' ? req.query.q : '';
    const language = typeof req.query.language === 'string' && req.query.language ? req.query.language : undefined;
    const pageSizeRaw = typeof req.query.pageSize === 'string' ? Number(req.query.pageSize) : NaN;
    const pageSize = Number.isFinite(pageSizeRaw) && pageSizeRaw > 0 ? Math.min(100, Math.floor(pageSizeRaw)) : undefined;
    try {
      const voices = await searchCatalog(providerRaw.toLowerCase(), { query, language, pageSize });
      res.json({ provider: providerRaw.toLowerCase(), query, count: voices.length, voices });
    } catch (err) {
      const message = errMessage(err);
      const status = voiceCatalogErrorStatus(message);
      res
        .status(status)
        .json(errorBody(status === 400 ? 'voice catalog unavailable for this provider' : 'voice catalog request failed', message));
    }
  });

  return router;
}
