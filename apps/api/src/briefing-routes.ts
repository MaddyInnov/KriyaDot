// SPDX-License-Identifier: Apache-2.0
// Daily Briefing HTTP surface (feature: briefing backend).
//
//   GET  /api/briefing            -> latest briefing JSON, or 404 {error}
//                                   when none exists (the web panel reads via
//                                   optionalJson, so 404 renders the empty
//                                   state — the contract is unchanged).
//   GET  /api/briefing/history    -> paginated history (newest first):
//                                   { items: [{id, generatedAt, kind,
//                                     summary?}], page, limit, total }
//   POST /api/briefing/generate   -> generate on demand, persist as 'manual'
//   GET  /api/briefing/config     -> { briefingTime, briefingEnabled }
//   PUT  /api/briefing/config     -> validate + persist a partial config
//
// Mounted from createRouter in routes.ts. Generation logic lives in
// briefing.ts so it is testable without HTTP.

import express from 'express';
import type { GovernanceGateway } from '@mvp/governance';
import type { RunHealthStore } from '@mvp/run-health';
import { BriefingStore, generateBriefing } from './briefing.js';
import type { GenerateBriefingDeps } from './briefing.js';
import { CalendarEventStore } from './tasks.js';
import { NoteStore } from './notes.js';

function errorBody(error: string, detail?: string): { error: string; detail?: string } {
  return detail ? { error, detail } : { error };
}

export interface BriefingRouteDeps {
  dataDir: string;
  governance: GovernanceGateway;
  runHealth: RunHealthStore;
  /**
   * Workflow source for the digest (feature interconnection). The real
   * WorkflowRunner satisfies this structurally; unset → no workflow
   * section. routes.ts passes the live runner.
   */
  workflowSource?: GenerateBriefingDeps['workflowSource'];
  /** W14c signals source + W14b notification digest (forwarded). */
  signalsSource?: GenerateBriefingDeps['signalsSource'];
  notificationDigest?: GenerateBriefingDeps['notificationDigest'];
  /** Nightly dreaming: dream-idea items for the briefing's dream section. */
  dreamsSource?: GenerateBriefingDeps['dreamsSource'];
}

/** Mount the /api/briefing/* routes. */
export function registerBriefingRoutes(router: express.Router, deps: BriefingRouteDeps): void {
  const store = new BriefingStore(deps.dataDir);
  const calendarStore = new CalendarEventStore(deps.dataDir);
  const noteStore = new NoteStore(deps.dataDir);

  router.get('/briefing', (_req, res) => {
    try {
      const latest = store.latest();
      if (!latest) {
        res.status(404).json(errorBody('No briefing generated yet'));
        return;
      }
      res.json(latest.payload);
    } catch (err) {
      res.status(500).json(errorBody('Failed to load briefing', err instanceof Error ? err.message : String(err)));
    }
  });

  router.get('/briefing/history', (req, res) => {
    try {
      const rawPage = typeof req.query.page === 'string' ? Number.parseInt(req.query.page, 10) : 1;
      const rawLimit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 20;
      const page = Number.isFinite(rawPage) ? Math.max(rawPage, 1) : 1;
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 20;
      const { items, total } = store.list(page, limit);
      res.json({ items, page, limit, total });
    } catch (err) {
      res.status(500).json(errorBody('Failed to list briefing history', err instanceof Error ? err.message : String(err)));
    }
  });

  router.post('/briefing/generate', async (_req, res) => {
    try {
      const briefing = await generateBriefing({
        store,
        governance: deps.governance,
        runHealth: deps.runHealth,
        calendarStore,
        noteStore,
        workflowSource: deps.workflowSource,
        signalsSource: deps.signalsSource,
        notificationDigest: deps.notificationDigest,
        dreamsSource: deps.dreamsSource,
      });
      const saved = store.saveBriefing('manual', briefing);
      res.status(201).json(saved.payload);
    } catch (err) {
      res.status(500).json(errorBody('Failed to generate briefing', err instanceof Error ? err.message : String(err)));
    }
  });

  router.get('/briefing/config', (_req, res) => {
    try {
      res.json(store.getConfig());
    } catch (err) {
      res.status(500).json(errorBody('Failed to load briefing config', err instanceof Error ? err.message : String(err)));
    }
  });

  router.put('/briefing/config', (req, res) => {
    try {
      const body = (req.body ?? {}) as { briefingTime?: unknown; briefingEnabled?: unknown };
      const patch: { briefingTime?: string; briefingEnabled?: boolean } = {};
      if (body.briefingTime !== undefined) patch.briefingTime = body.briefingTime as string;
      if (body.briefingEnabled !== undefined) patch.briefingEnabled = body.briefingEnabled as boolean;
      res.json(store.setConfig(patch));
    } catch (err) {
      res.status(400).json(errorBody('Invalid briefing config', err instanceof Error ? err.message : String(err)));
    }
  });
}
