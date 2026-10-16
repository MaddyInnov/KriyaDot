// SPDX-License-Identifier: Apache-2.0
// Managed local LLM REST API (Atomic Agent parity: zero-config local models).
//
//   GET  /api/local-llm/status            → LocalLlmStatus
//   GET  /api/local-llm/models            → { models: ModelEntry[] }
//   POST /api/local-llm/download-binary   → { ok, asset } (long-running)
//   POST /api/local-llm/download-model    → { ok, model } (long-running, {modelId})
//   POST /api/local-llm/start             → { ok } ({modelId?})
//   POST /api/local-llm/stop              → { ok }
//   POST /api/local-llm/restart           → { ok } ({modelId?})
//
// Downloads accept only pinned release assets and curated model ids — the
// client cannot supply arbitrary URLs.
//
// HOST WIRING (index.ts):
//   import { createLocalLlmRouter } from './local-llm-routes.js';
//   import { LocalLlmManager } from '@mvp/agent-runtime';
//   const localLlm = new LocalLlmManager(config.dataDir);
//   app.use('/api/local-llm', createLocalLlmRouter(localLlm));
//   // …and localLlm.stop() in the shutdown path.

import express, { type Router } from 'express';
import type { LocalLlmManager } from '@mvp/agent-runtime';

function errorBody(message: string): Record<string, unknown> {
  return { ok: false, error: message };
}

function clientError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // Never leak absolute host paths in API errors.
  return msg.replace(/[A-Za-z]:\\[^\s"']+|\/[^\s"']+/g, (p) =>
    p.split(/[\\/]/).pop() ?? p,
  );
}

export function createLocalLlmRouter(manager: LocalLlmManager): Router {
  const router = express.Router();

  router.get('/status', async (_req, res) => {
    try {
      res.json({ ok: true, status: await manager.getStatus() });
    } catch (err) {
      res.status(500).json(errorBody(clientError(err)));
    }
  });

  router.get('/models', async (_req, res) => {
    try {
      res.json({ ok: true, models: await manager.listModels() });
    } catch (err) {
      res.status(500).json(errorBody(clientError(err)));
    }
  });

  router.post('/download-binary', async (_req, res) => {
    try {
      const asset = await manager.downloadBinary();
      res.json({ ok: true, asset: { file: asset.file, url: asset.url } });
    } catch (err) {
      res.status(500).json(errorBody(clientError(err)));
    }
  });

  router.post('/download-model', async (req, res) => {
    try {
      const modelId = typeof req.body?.modelId === 'string' ? req.body.modelId : '';
      if (!modelId) {
        res.status(400).json(errorBody('modelId is required'));
        return;
      }
      const model = await manager.downloadModel(modelId);
      res.json({ ok: true, model: { id: model.id, name: model.name, downloaded: true } });
    } catch (err) {
      res.status(500).json(errorBody(clientError(err)));
    }
  });

  router.post('/start', async (req, res) => {
    try {
      const modelId = typeof req.body?.modelId === 'string' ? req.body.modelId : undefined;
      await manager.start(modelId);
      res.json({ ok: true, status: await manager.getStatus() });
    } catch (err) {
      res.status(500).json(errorBody(clientError(err)));
    }
  });

  router.post('/stop', async (_req, res) => {
    try {
      await manager.stop();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json(errorBody(clientError(err)));
    }
  });

  router.post('/restart', async (req, res) => {
    try {
      const modelId = typeof req.body?.modelId === 'string' ? req.body.modelId : undefined;
      await manager.restart(modelId);
      res.json({ ok: true, status: await manager.getStatus() });
    } catch (err) {
      res.status(500).json(errorBody(clientError(err)));
    }
  });

  return router;
}
