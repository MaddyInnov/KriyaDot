// SPDX-License-Identifier: Apache-2.0
// HTTP routes for packaged outbound calling (CT-1..CT-5). Register-style:
// the coordinator mounts createOutboundCallRouter at /api/calls (see the
// wave4-calls WIRING note). Creating a brief or a pre-approval NEVER dials;
// dialing happens only through POST /briefs/:id/place (or the scheduled
// tick), which re-checks authorization inside OutboundCallService.
//
//   GET    /providers                     → telephony provider status
//   POST   /briefs                        → draft brief + script sheet (201)
//   GET    /briefs                        → briefs
//   GET    /briefs/:id                    → brief (+ record when placed)
//   GET    /briefs/:id/script-sheet       → CT-3 sheet
//   PATCH  /briefs/:id/script-sheet       → revise voice/opening/closing/points
//   POST   /briefs/:id/request-approval   → raise the governance card
//   POST   /briefs/:id/place              → dial (authorization-checked)
//   POST   /briefs/:id/bring-in           → CT-5 { number }
//   POST   /briefs/:id/refresh            → poll a live call (finalizes+reports)
//   POST   /briefs/:id/end                → hang up a live call
//   GET    /briefs/:id/report             → the call report
//   POST   /preapprovals                  → CT-4 bounded one-call pre-approval
//   GET    /preapprovals
//   DELETE /preapprovals/:id              → revoke
//   POST   /scheduled                     → CT-2 { briefId, runAt, routineId? }
//   GET    /scheduled
//   DELETE /scheduled/:id                 → cancel
//   POST   /scheduled/tick                → fire due entries (scheduler/coordinator)

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { TelephonyProvider } from './telephony.js';
import { OutboundCallService } from './outbound-calls.js';

export interface OutboundCallRouteDeps {
  service: OutboundCallService;
  provider: TelephonyProvider;
}

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

export function createOutboundCallRouter(deps: OutboundCallRouteDeps): Router {
  const { service, provider } = deps;
  const router = Router();

  router.get('/providers', (_req: Request, res: Response) => {
    res.json({ providers: [{ id: provider.id, label: provider.label, configured: provider.configured, hint: provider.hint ?? null }] });
  });

  router.post('/briefs', (req: Request, res: Response) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const brief = service.createBrief({
        botId: b.botId as string,
        counterpartyName: b.counterpartyName as string,
        number: b.number as string,
        purpose: b.purpose as string,
        talkingPoints: Array.isArray(b.talkingPoints) ? (b.talkingPoints as string[]) : undefined,
        openingLine: typeof b.openingLine === 'string' ? b.openingLine : undefined,
        closingLine: typeof b.closingLine === 'string' ? b.closingLine : undefined,
        voiceId: typeof b.voiceId === 'string' ? b.voiceId : undefined,
        maxDurationSec: typeof b.maxDurationSec === 'number' ? b.maxDurationSec : undefined,
      });
      res.status(201).json({ brief });
    } catch (err) { res.status(400).json({ error: errMessage(err, 'invalid call brief') }); }
  });

  router.get('/briefs', (_req: Request, res: Response) => {
    res.json({ briefs: service.listBriefs() });
  });

  router.get('/briefs/:id', (req: Request, res: Response) => {
    const brief = service.getBrief(req.params.id);
    if (!brief) { res.status(404).json({ error: 'unknown call brief' }); return; }
    res.json({ brief, record: service.getRecord(brief.id) ?? null });
  });

  router.get('/briefs/:id/script-sheet', (req: Request, res: Response) => {
    try { res.json({ scriptSheet: service.getScriptSheet(req.params.id) }); }
    catch (err) { sendErr(res, err, 'failed to read script sheet'); }
  });

  router.patch('/briefs/:id/script-sheet', (req: Request, res: Response) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const sheet = service.updateScriptSheet(req.params.id, {
        voiceId: typeof b.voiceId === 'string' ? b.voiceId : undefined,
        openingLine: typeof b.openingLine === 'string' ? b.openingLine : undefined,
        closingLine: typeof b.closingLine === 'string' ? b.closingLine : undefined,
        talkingPoints: Array.isArray(b.talkingPoints) ? (b.talkingPoints as string[]) : undefined,
      });
      res.json({ scriptSheet: sheet });
    } catch (err) { sendErr(res, err, 'failed to update script sheet'); }
  });

  router.post('/briefs/:id/request-approval', async (req: Request, res: Response) => {
    try { res.json({ brief: await service.requestApproval(req.params.id) }); }
    catch (err) { sendErr(res, err, 'failed to request approval'); }
  });

  router.post('/briefs/:id/place', async (req: Request, res: Response) => {
    try { res.json({ record: await service.placeCall(req.params.id) }); }
    catch (err) { sendErr(res, err, 'failed to place call'); }
  });

  router.post('/briefs/:id/bring-in', async (req: Request, res: Response) => {
    try {
      const number = (req.body as { number?: unknown } | undefined)?.number;
      if (typeof number !== 'string' || !number) { res.status(400).json({ error: '"number" is required' }); return; }
      res.json({ record: await service.bringIn(req.params.id, number) });
    } catch (err) { sendErr(res, err, 'failed to bring in participant'); }
  });

  router.post('/briefs/:id/refresh', async (req: Request, res: Response) => {
    try { res.json({ record: await service.refreshCall(req.params.id) }); }
    catch (err) { sendErr(res, err, 'failed to refresh call'); }
  });

  router.post('/briefs/:id/end', async (req: Request, res: Response) => {
    try { res.json({ record: await service.endCall(req.params.id) }); }
    catch (err) { sendErr(res, err, 'failed to end call'); }
  });

  router.get('/briefs/:id/report', (req: Request, res: Response) => {
    const record = service.getRecord(req.params.id);
    if (!record) { res.status(404).json({ error: 'no call has been placed for this brief' }); return; }
    if (!record.report) { res.status(409).json({ error: 'call has not finished yet — no report', record }); return; }
    res.json({ report: record.report });
  });

  router.post('/preapprovals', (req: Request, res: Response) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const pre = service.createPreApproval({
        number: b.number as string,
        counterpartyName: b.counterpartyName as string,
        maxDurationSec: typeof b.maxDurationSec === 'number' ? b.maxDurationSec : undefined,
        ttlMs: typeof b.ttlMs === 'number' ? b.ttlMs : undefined,
      });
      res.status(201).json({ preApproval: pre });
    } catch (err) { res.status(400).json({ error: errMessage(err, 'invalid pre-approval') }); }
  });

  router.get('/preapprovals', (_req: Request, res: Response) => {
    res.json({ preApprovals: service.listPreApprovals() });
  });

  router.delete('/preapprovals/:id', (req: Request, res: Response) => {
    try { res.json({ preApproval: service.revokePreApproval(req.params.id) }); }
    catch (err) { sendErr(res, err, 'failed to revoke pre-approval'); }
  });

  router.post('/scheduled', (req: Request, res: Response) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (typeof b.briefId !== 'string' || typeof b.runAt !== 'number') {
        res.status(400).json({ error: '"briefId" (string) and "runAt" (epoch ms) are required' });
        return;
      }
      const entry = service.scheduleCall(b.briefId, b.runAt, { routineId: typeof b.routineId === 'string' ? b.routineId : undefined });
      res.status(201).json({ scheduled: entry });
    } catch (err) { sendErr(res, err, 'failed to schedule call'); }
  });

  router.get('/scheduled', (_req: Request, res: Response) => {
    res.json({ scheduled: service.listScheduled() });
  });

  router.delete('/scheduled/:id', (req: Request, res: Response) => {
    try { res.json({ scheduled: service.cancelScheduled(req.params.id) }); }
    catch (err) { sendErr(res, err, 'failed to cancel scheduled call'); }
  });

  router.post('/scheduled/tick', async (_req: Request, res: Response) => {
    try { res.json({ fired: await service.tickScheduled() }); }
    catch (err) { sendErr(res, err, 'scheduled tick failed'); }
  });

  return router;
}
