// SPDX-License-Identifier: Apache-2.0
// OH-4: opt-in account ingestion HTTP API (mounted at /api/memory-ingestion).
//
//   GET  /api/memory-ingestion/:botId
//        → { ok, botId, settings, sources: [{ id, enabled, available,
//            unavailableReason?, lastRunAt, lastAdded }] }
//   PUT  /api/memory-ingestion/:botId   body: the settings shape
//        { sources: { files?, gmail?, drive?, rss? }, rssFeeds? }
//        → { ok, botId, settings, sources }
//   POST /api/memory-ingestion/:botId/run   body: { source? }
//        → { ok, botId, added, skipped, perSource, blocked? }
//
// Ingestion is OFF by default for every bot; a source runs only when
// the owner enabled it here. See memory-ingestion.ts for the engine,
// guards (pause / privacy / local-only) and dedupe.

import express, { type Router } from 'express';
import {
  MemoryIngestionEngine,
  getIngestionSettings,
  ingestionSourceStatuses,
  saveIngestionSettings,
  INGESTION_SOURCES,
  type IngestionSourceId,
  type MemoryIngestionDeps,
} from './memory-ingestion.js';

export interface MemoryIngestionRouterDeps extends MemoryIngestionDeps {
  getBots: () => Array<{ id: string }>;
}

function errorBody(error: string, detail?: string): { error: string; detail?: string } {
  return detail ? { error, detail } : { error };
}

export function createMemoryIngestionRouter(deps: MemoryIngestionRouterDeps): Router {
  const router = express.Router();
  const engine = new MemoryIngestionEngine(deps);

  const requireBot = (botId: string): boolean => deps.getBots().some((b) => b.id === botId);

  router.get('/:botId', (req, res) => {
    const botId = req.params.botId;
    if (!requireBot(botId)) {
      res.status(404).json(errorBody(`Unknown bot "${botId}"`));
      return;
    }
    res.json({
      ok: true,
      botId,
      settings: getIngestionSettings(deps.dataDir, botId),
      sources: ingestionSourceStatuses(deps, botId),
    });
  });

  router.put('/:botId', (req, res) => {
    const botId = req.params.botId;
    if (!requireBot(botId)) {
      res.status(404).json(errorBody(`Unknown bot "${botId}"`));
      return;
    }
    try {
      const settings = saveIngestionSettings(deps.dataDir, botId, req.body ?? {});
      res.json({
        ok: true,
        botId,
        settings,
        sources: ingestionSourceStatuses(deps, botId),
      });
    } catch (err) {
      res.status(400).json(errorBody('Failed to save ingestion settings', err instanceof Error ? err.message : String(err)));
    }
  });

  router.post('/:botId/run', async (req, res) => {
    const botId = req.params.botId;
    if (!requireBot(botId)) {
      res.status(404).json(errorBody(`Unknown bot "${botId}"`));
      return;
    }
    const rawSource = (req.body as { source?: unknown } | undefined)?.source;
    let source: IngestionSourceId | undefined;
    if (rawSource !== undefined) {
      if (typeof rawSource !== 'string' || !(INGESTION_SOURCES as readonly string[]).includes(rawSource)) {
        res.status(400).json(errorBody(`"source" must be one of ${INGESTION_SOURCES.join(', ')}`));
        return;
      }
      source = rawSource as IngestionSourceId;
    }
    try {
      const result = await engine.run(botId, source);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json(errorBody('Ingestion run failed', err instanceof Error ? err.message : String(err)));
    }
  });

  return router;
}
