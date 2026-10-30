// SPDX-License-Identifier: Apache-2.0
// HTTP routes for direct phone SMS + tap-to-call (CT-6..CT-9).
// Register-style: the coordinator mounts createPhoneSmsRouter at
// /api/phone-sms (see the wave4-calls WIRING note). These routes are the
// UI/manual surface; bot sends go through the governed tools in
// phone-sms.ts (require-approval). A direct POST /send from the local UI
// is the user's own explicit action in their own session — the same trust
// model as the other local phone routes.
//
//   POST /send              { number, text, contact?, deviceId? }
//   POST /drafts            { number, text, contact?, deviceId? }  (never sends)
//   GET  /drafts?deviceId=
//   DELETE /drafts/:id
//   GET  /mode?deviceId=    → { mode }
//   PUT  /mode              { deviceId, mode: 'send' | 'draft-only' }
//   POST /search            { query, limit?, deviceId? }
//   POST /thread            { address, limit?, deviceId? }
//   POST /tap-to-call-card  { number, counterpartyName? } → card payload
//   POST /dial              { number, contact?, deviceId? } (call from my number)

import { Router } from 'express';
import type { Request, Response } from 'express';
import { PhoneSmsService, buildTapToCallCard, type TextingMode } from './phone-sms.js';

export interface PhoneSmsRouteDeps { service: PhoneSmsService }

function errMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}
function errStatus(err: unknown): number {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === 'number' && s >= 400 && s < 600 ? s : 500;
}
function sendErr(res: Response, err: unknown, fallback: string): void {
  const status = errStatus(err);
  res.status(status).json({ error: status >= 500 ? fallback : errMessage(err, fallback) });
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function createPhoneSmsRouter(deps: PhoneSmsRouteDeps): Router {
  const { service } = deps;
  const router = Router();

  router.post('/send', async (req: Request, res: Response) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (!str(b.number) || !str(b.text)) { res.status(400).json({ error: '"number" and "text" are required' }); return; }
      res.json(await service.sendSms({ deviceId: str(b.deviceId), number: b.number as string, text: b.text as string, contact: str(b.contact) }));
    } catch (err) { sendErr(res, err, 'failed to send SMS'); }
  });

  router.post('/drafts', async (req: Request, res: Response) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (!str(b.number) || !str(b.text)) { res.status(400).json({ error: '"number" and "text" are required' }); return; }
      const draft = service.createDraft({ deviceId: str(b.deviceId), number: b.number as string, text: b.text as string, contact: str(b.contact) });
      const composerOpened = await service.openComposer(draft).catch(() => false);
      res.status(201).json({ draft, composerOpened, sent: false });
    } catch (err) { sendErr(res, err, 'failed to create draft'); }
  });

  router.get('/drafts', (req: Request, res: Response) => {
    res.json({ drafts: service.listDrafts(str(req.query.deviceId)) });
  });

  router.delete('/drafts/:id', (req: Request, res: Response) => {
    if (!service.deleteDraft(req.params.id)) { res.status(404).json({ error: 'unknown draft' }); return; }
    res.json({ ok: true });
  });

  router.get('/mode', (req: Request, res: Response) => {
    const deviceId = str(req.query.deviceId);
    if (!deviceId) { res.status(400).json({ error: '"deviceId" query param is required' }); return; }
    res.json({ deviceId, mode: service.getTextingMode(deviceId) });
  });

  router.put('/mode', (req: Request, res: Response) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const mode = b.mode as TextingMode;
    if (!str(b.deviceId) || (mode !== 'send' && mode !== 'draft-only')) {
      res.status(400).json({ error: '"deviceId" and "mode" (\'send\' | \'draft-only\') are required' });
      return;
    }
    service.setTextingMode(b.deviceId as string, mode);
    res.json({ deviceId: b.deviceId, mode });
  });

  router.post('/search', async (req: Request, res: Response) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (!str(b.query)) { res.status(400).json({ error: '"query" is required' }); return; }
      res.json({ data: await service.searchSms({ deviceId: str(b.deviceId), query: b.query as string, limit: num(b.limit) }) });
    } catch (err) { sendErr(res, err, 'SMS search failed'); }
  });

  router.post('/thread', async (req: Request, res: Response) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (!str(b.address)) { res.status(400).json({ error: '"address" is required' }); return; }
      res.json({ data: await service.readThread({ deviceId: str(b.deviceId), address: b.address as string, limit: num(b.limit) }) });
    } catch (err) { sendErr(res, err, 'SMS thread read failed'); }
  });

  router.post('/tap-to-call-card', (req: Request, res: Response) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (!str(b.number)) { res.status(400).json({ error: '"number" is required' }); return; }
      res.json({ card: buildTapToCallCard({ number: b.number as string, counterpartyName: str(b.counterpartyName) }) });
    } catch (err) { res.status(400).json({ error: errMessage(err, 'invalid number') }); }
  });

  router.post('/dial', async (req: Request, res: Response) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (!str(b.number)) { res.status(400).json({ error: '"number" is required' }); return; }
      res.json({ ok: true, ...(await service.dialFromMyNumber({ deviceId: str(b.deviceId), number: b.number as string, contact: str(b.contact) })) });
    } catch (err) { sendErr(res, err, 'dial failed'); }
  });

  return router;
}
