// SPDX-License-Identifier: Apache-2.0
// REST routes for health data sync + scoped erasure (Muse parity
// §4.14: DV-4). Register-style module: routes.ts mounts this under
// /health-sync (see the wave-6 wiring note). Mount behind the API's
// normal auth — health data is sensitive and these handlers assume the
// caller is already authenticated as the user, exactly like the phone
// routes. Ingest is additionally expected to come from a paired device;
// routes.ts should bind deviceId to the paired-device identity when
// wiring (see wiring note).
//
//   POST   /health-sync/samples   { deviceId, samples[] } ingest (idempotent)
//   GET    /health-sync/samples   ?deviceId=&type=&since=&until=&limit=
//   GET    /health-sync/summary   ?deviceId=
//   DELETE /health-sync/samples   scoped erasure { deviceId?, types?, before?, confirmAll? }

import type { Request, Response, Router } from 'express';
import {
  HealthSyncError,
  HEALTH_SAMPLE_TYPES,
  type HealthEraseScope,
  type HealthSampleType,
  type HealthSyncStore,
} from './health-sync.js';

export interface HealthSyncRouteDeps {
  store: HealthSyncStore;
  audit?: (event: string, detail: Record<string, unknown>) => void;
}

function err(res: Response, status: number, error: string, detail?: string): void {
  res.status(status).json(detail ? { error, detail } : { error });
}

function handleError(res: Response, e: unknown): void {
  if (e instanceof HealthSyncError) {
    err(res, 400, e.code, e.message);
    return;
  }
  err(res, 500, 'health_sync_error', e instanceof Error ? e.message : String(e));
}

function parseTypes(raw: unknown): HealthSampleType[] | undefined {
  if (raw === undefined) return undefined;
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
  const types = list.map((t) => String(t).trim()).filter((t) => t.length > 0) as HealthSampleType[];
  for (const t of types) {
    if (!(HEALTH_SAMPLE_TYPES as readonly string[]).includes(t)) {
      throw new HealthSyncError('invalid_type', `unknown health type: ${t}`);
    }
  }
  return types;
}

function parseEpoch(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function registerHealthSyncRoutes(router: Router, deps: HealthSyncRouteDeps): void {
  const { store } = deps;
  const audit = deps.audit ?? (() => {});

  router.post('/samples', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { deviceId?: unknown; samples?: unknown };
      const result = store.ingest(body.deviceId as string, body.samples as unknown[]);
      audit('health.samples_ingested', {
        deviceId: String(body.deviceId), inserted: result.inserted, duplicates: result.duplicates,
      });
      res.status(201).json({ ok: true, ...result });
    } catch (e) {
      handleError(res, e);
    }
  });

  router.get('/samples', (req: Request, res: Response) => {
    try {
      const samples = store.query({
        deviceId: typeof req.query.deviceId === 'string' ? req.query.deviceId : undefined,
        types: parseTypes(req.query.type),
        since: parseEpoch(req.query.since),
        until: parseEpoch(req.query.until),
        limit: parseEpoch(req.query.limit),
      });
      res.json({ ok: true, samples });
    } catch (e) {
      handleError(res, e);
    }
  });

  router.get('/summary', (req: Request, res: Response) => {
    const deviceId = typeof req.query.deviceId === 'string' ? req.query.deviceId : undefined;
    res.json({ ok: true, summary: store.summary(deviceId) });
  });

  router.delete('/samples', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as {
        deviceId?: unknown; types?: unknown; before?: unknown; confirmAll?: unknown;
      };
      const scope: HealthEraseScope = {
        deviceId: typeof body.deviceId === 'string' ? body.deviceId : undefined,
        types: parseTypes(body.types),
        before: parseEpoch(body.before),
        confirmAll: body.confirmAll === true,
      };
      const result = store.erase(scope);
      audit('health.samples_erased', {
        deviceId: scope.deviceId ?? null,
        types: scope.types ?? null,
        before: scope.before ?? null,
        confirmAll: scope.confirmAll ?? false,
        deleted: result.deleted,
      });
      res.json({ ok: true, ...result });
    } catch (e) {
      handleError(res, e);
    }
  });
}
