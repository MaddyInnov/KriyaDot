// SPDX-License-Identifier: Apache-2.0
// REST routes for the network connector (Muse parity §4.14:
// DV-17 / DV-18 / DV-19). Register-style module: routes.ts mounts this
// under /network (see the wave-6 wiring note). Mount behind the API's
// normal auth, like the phone routes.
//
//   GET    /network/tailscale/status       enrollment + peers (read-only)
//   POST   /network/tailscale/join         { loginServer? } → join or { authUrl } to approve
//   POST   /network/tailscale/disconnect   down + logout + identity erasure (verified)
//   GET    /network/tcp/approvals          live per-host approvals
//   POST   /network/tcp/approvals          { host, ttlMs?, note? } grant per-host approval
//   DELETE /network/tcp/approvals/:host    revoke
//   POST   /network/tcp/probe              { host, port } governed connect probe (DV-19)

import type { Request, Response, Router } from 'express';
import { TailscaleConnectorError, type TailscaleConnector } from './tailscale-connector.js';
import {
  TailnetTcpError,
  probeViaTailnet,
  type TailnetApprovalStore,
  type TailnetDialer,
} from './tailnet-tcp.js';

export interface NetworkRouteDeps {
  connector: TailscaleConnector;
  approvals: TailnetApprovalStore;
  dial?: TailnetDialer;
  audit?: (event: string, detail: Record<string, unknown>) => void;
}

function err(res: Response, status: number, error: string, detail?: string): void {
  res.status(status).json(detail ? { error, detail } : { error });
}

function handleError(res: Response, e: unknown): void {
  if (e instanceof TailscaleConnectorError || e instanceof TailnetTcpError) {
    const status =
      e.code === 'tailscale_unavailable' ? 503
      : e.code === 'host_not_approved' ? 403
      : e.code === 'tailnet_not_joined' ? 409
      : 400;
    err(res, status, e.code, e.message);
    return;
  }
  err(res, 500, 'network_error', e instanceof Error ? e.message : String(e));
}

export function registerNetworkRoutes(router: Router, deps: NetworkRouteDeps): void {
  const { connector, approvals } = deps;
  const audit = deps.audit ?? (() => {});

  // ---- Tailscale connector (DV-17 / DV-18) --------------------------------

  router.get('/tailscale/status', async (_req: Request, res: Response) => {
    try {
      res.json({ ok: true, status: await connector.status() });
    } catch (e) {
      handleError(res, e);
    }
  });

  router.post('/tailscale/join', async (req: Request, res: Response) => {
    try {
      const loginServer = (req.body as { loginServer?: unknown } | undefined)?.loginServer;
      const result = await connector.join({
        loginServer: typeof loginServer === 'string' && loginServer.length > 0 ? loginServer : undefined,
      });
      // 202 when the user still has to approve the device in a browser.
      res.status(result.status.joined ? 200 : 202).json({ ok: true, ...result });
    } catch (e) {
      handleError(res, e);
    }
  });

  router.post('/tailscale/disconnect', async (_req: Request, res: Response) => {
    try {
      const result = await connector.disconnect();
      res.json({ ok: true, ...result });
    } catch (e) {
      handleError(res, e);
    }
  });

  // ---- Governed TCP reach (DV-19) ------------------------------------------

  router.get('/tcp/approvals', (_req: Request, res: Response) => {
    res.json({ ok: true, approvals: approvals.list() });
  });

  router.post('/tcp/approvals', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { host?: unknown; ttlMs?: unknown; note?: unknown };
      const approval = approvals.grant(body.host, {
        ttlMs: typeof body.ttlMs === 'number' ? body.ttlMs : undefined,
        note: typeof body.note === 'string' ? body.note : undefined,
      });
      audit('tailnet.approval_granted', { host: approval.host, expiresAt: approval.expiresAt });
      res.status(201).json({ ok: true, approval });
    } catch (e) {
      handleError(res, e);
    }
  });

  router.delete('/tcp/approvals/:host', (req: Request, res: Response) => {
    try {
      const revoked = approvals.revoke(req.params.host);
      if (revoked) audit('tailnet.approval_revoked', { host: req.params.host });
      res.json({ ok: true, revoked });
    } catch (e) {
      handleError(res, e);
    }
  });

  router.post('/tcp/probe', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { host?: unknown; port?: unknown };
      const result = await probeViaTailnet(
        { connector, approvals, dial: deps.dial, audit },
        body.host,
        body.port,
      );
      res.json({ ok: true, ...result });
    } catch (e) {
      handleError(res, e);
    }
  });
}
