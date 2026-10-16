// SPDX-License-Identifier: Apache-2.0
// Agent auto-detection REST API (Codync parity: agents section).
//
//   GET  /api/agents/detected  → { agents: DetectedAgent[], scannedAt }
//   GET  /api/agents           → { agents: AgentListEntry[] } (detected first,
//                                 then not-installed with install hints)
//   POST /api/agents/rescan    → { agents: DetectedAgent[], scannedAt }
//
// HOST WIRING (index.ts):
//   import { createAgentDetectRouter } from './agent-detect-routes.js';
//   app.use('/api/agents', createAgentDetectRouter());

import express, { type Router } from 'express';
import { listAgents, rescanAgents, scanAgents, lastScanTime } from '@mvp/agent-runtime';

function errorBody(message: string): Record<string, unknown> {
  return { ok: false, error: message };
}

export function createAgentDetectRouter(): Router {
  const router = express.Router();

  router.get('/detected', async (_req, res) => {
    try {
      const agents = await scanAgents();
      res.json({ ok: true, agents, scannedAt: lastScanTime() });
    } catch (err) {
      res.status(500).json(errorBody(err instanceof Error ? err.message : 'scan failed'));
    }
  });

  router.get('/', async (_req, res) => {
    try {
      const agents = await listAgents();
      res.json({ ok: true, agents, scannedAt: lastScanTime() });
    } catch (err) {
      res.status(500).json(errorBody(err instanceof Error ? err.message : 'scan failed'));
    }
  });

  router.post('/rescan', async (_req, res) => {
    try {
      rescanAgents();
      const agents = await scanAgents({ force: true });
      res.json({ ok: true, agents, scannedAt: lastScanTime() });
    } catch (err) {
      res.status(500).json(errorBody(err instanceof Error ? err.message : 'rescan failed'));
    }
  });

  return router;
}
