// SPDX-License-Identifier: Apache-2.0
// Product analytics API (opt-in, off by default).
//
//   GET  /api/analytics/settings  → current settings (never leaks endpoint to non-admins; single-user: fine)
//   PUT  /api/analytics/settings  → { enabled, crashReporting, endpoint }
//   GET  /api/analytics/events    → local event queue (for "View collected data")
//   POST /api/analytics/events/clear
//   GET  /api/analytics/crashes   → redacted crash records
//   POST /api/analytics/crashes/clear
//
// The singleton productAnalytics from @mvp/agent-runtime is the source of
// truth at runtime; settings are persisted via analytics-settings.ts.

import { Router, type Request, type Response } from 'express';
import { productAnalytics } from '@mvp/agent-runtime';
import {
  loadAnalyticsSettings,
  saveAnalyticsSettings,
  sanitizeAnalyticsSettings,
} from './analytics-settings.js';

export function createAnalyticsRouter(opts: { dataDir: string }): Router {
  const router = Router();
  const { dataDir } = opts;

  // Apply persisted/env settings at router creation (boot).
  productAnalytics.updateSettings(loadAnalyticsSettings(dataDir));

  router.get('/settings', (_req: Request, res: Response) => {
    res.json({ ok: true, settings: productAnalytics.getSettings() });
  });

  router.put('/settings', (req: Request, res: Response) => {
    const settings = sanitizeAnalyticsSettings(req.body);
    saveAnalyticsSettings(dataDir, settings);
    productAnalytics.updateSettings(settings);
    res.json({ ok: true, settings: productAnalytics.getSettings() });
  });

  router.get('/events', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      enabled: productAnalytics.isEnabled,
      events: productAnalytics.getQueuedEvents(),
    });
  });

  router.post('/events/clear', (_req: Request, res: Response) => {
    productAnalytics.clearQueue();
    res.json({ ok: true });
  });

  router.get('/crashes', (_req: Request, res: Response) => {
    res.json({ ok: true, crashes: productAnalytics.getCrashes() });
  });

  router.post('/crashes/clear', (_req: Request, res: Response) => {
    productAnalytics.clearCrashes();
    res.json({ ok: true });
  });

  return router;
}
