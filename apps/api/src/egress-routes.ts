// SPDX-License-Identifier: Apache-2.0
// Egress journal API (A13 — opt-in, off by default).
//
//   GET  /api/egress-journal/settings  → { enabled, label, limits }
//   PUT  /api/egress-journal/settings  → { enabled } (persisted)
//
// The singleton egressJournalSettings from @mvp/agent-runtime is the
// runtime source of truth (run_command reads it per call); settings are
// persisted via egress-settings.ts. Scope note: this journals ONLY the
// sandboxed tool/command path. The API server's own provider traffic is
// NOT proxied or journaled by this feature.

import { Router, type Request, type Response } from 'express';
import { EGRESS_JOURNAL_LABEL, EGRESS_JOURNAL_LIMITS, egressJournalSettings } from '@mvp/agent-runtime';
import { loadEgressJournalSettings, saveEgressJournalSettings, sanitizeEgressJournalSettings } from './egress-settings.js';

export function createEgressJournalRouter(opts: { dataDir: string }): Router {
  const router = Router();
  const { dataDir } = opts;

  // Apply persisted/env settings at router creation (boot).
  egressJournalSettings.updateSettings(loadEgressJournalSettings(dataDir));

  const payload = () => ({
    ok: true,
    settings: egressJournalSettings.getSettings(),
    label: EGRESS_JOURNAL_LABEL,
    limits: EGRESS_JOURNAL_LIMITS,
  });

  router.get('/settings', (_req: Request, res: Response) => {
    res.json(payload());
  });

  router.put('/settings', (req: Request, res: Response) => {
    const settings = sanitizeEgressJournalSettings(req.body);
    saveEgressJournalSettings(dataDir, settings);
    egressJournalSettings.updateSettings(settings);
    res.json(payload());
  });

  return router;
}
