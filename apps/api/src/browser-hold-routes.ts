// SPDX-License-Identifier: Apache-2.0
// Browser hold routes (§1.4): a person takes/releases the hold on a bot's
// browser profile. While held, the PerBotComputerManager (sharing the
// same registry instance — the process-wide default unless injected)
// blocks every bot browser action on that profile with
// "Browser is held by <person>".
//
//   GET    /holds                 → all current holds
//   GET    /holds/:profileId      → the hold on one profile (or null)
//   POST   /holds/:profileId      { personId, personName?, reason? } → hold
//   DELETE /holds/:profileId      { personId?, force? } → release
//
// HOST WIRING (index.ts):
//   app.use('/api/browser', createBrowserHoldRouter({}));

import express, { type Router } from 'express';
import {
  BrowserHeldError,
  defaultBrowserHoldRegistry,
  type BrowserHoldRegistry,
} from '@mvp/agent-runtime';

export interface BrowserHoldRouterDeps {
  registry?: BrowserHoldRegistry;
  audit?: (action: string, fields: { actor?: string; detail?: unknown }) => void;
}

export function createBrowserHoldRouter(deps: BrowserHoldRouterDeps = {}): Router {
  const registry = deps.registry ?? defaultBrowserHoldRegistry;
  const router = express.Router();

  router.get('/holds', (_req, res) => {
    res.json({ ok: true, holds: registry.list() });
  });

  router.get('/holds/:profileId', (req, res) => {
    res.json({ ok: true, profileId: req.params.profileId, hold: registry.get(req.params.profileId) ?? null });
  });

  router.post('/holds/:profileId', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.personId !== 'string' || !body.personId.trim()) {
      res.status(400).json({ error: 'personId is required' });
      return;
    }
    try {
      const hold = registry.hold({
        profileId: req.params.profileId,
        personId: body.personId.trim(),
        ...(typeof body.personName === 'string' ? { personName: body.personName } : {}),
        ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
      });
      deps.audit?.('browser.hold_taken', { actor: hold.personId, detail: { profileId: hold.profileId } });
      res.status(201).json({ ok: true, hold });
    } catch (err) {
      const status = err instanceof BrowserHeldError ? 409 : 400;
      res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.delete('/holds/:profileId', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const released = registry.release(req.params.profileId, {
        ...(typeof body.personId === 'string' ? { personId: body.personId } : {}),
        force: body.force === true,
      });
      if (!released) {
        res.status(404).json({ error: `No browser hold on profile "${req.params.profileId}"` });
        return;
      }
      deps.audit?.('browser.hold_released', {
        actor: typeof body.personId === 'string' ? body.personId : released.personId,
        detail: { profileId: released.profileId, heldBy: released.personId, force: body.force === true },
      });
      res.json({ ok: true, released });
    } catch (err) {
      const status = err instanceof BrowserHeldError ? 409 : 400;
      res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
