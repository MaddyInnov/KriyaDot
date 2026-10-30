// SPDX-License-Identifier: Apache-2.0
// SCH-5 — User-facing supervised-services view.
//
// The API process supervises several long-lived subsystems (routine
// scheduler, account sync, connector sync, the dreamer, cloud
// supervisor, watch watcher, …). Until now each had its own ad-hoc
// health surface — or none. This module is the ONE registry the
// Activity → Services panel reads:
//
//   - Each service registers a descriptor: id, name, what it does, a
//     status probe, an OPTIONAL restart seam, and a log source.
//   - Restart is honest: a service only exposes `canRestart: true` when
//     a real restart function is wired. There is no fake restart button
//     for subsystems that can only be restarted by restarting the app —
//     those say so in their descriptor detail.
//   - Logs: services can push lines into the registry's per-service ring
//     buffer (recordLog), and/or provide a `recentLogs` reader (e.g.
//     backed by run-health rows or a subsystem's own journal). The view
//     merges both, newest last, capped.
//
// Wiring: index.ts constructs the registry with the live subsystem
// handles and mounts createSupervisedServicesRouter at /api — see the
// wave-6 wiring note for the exact descriptors to register.

import { Router, type Request, type Response } from 'express';
import { LifecycleAuditLog } from './lifecycle-approval.js';

export type SupervisedServiceStatus = 'running' | 'degraded' | 'stopped' | 'unknown';

export interface SupervisedServiceHealth {
  status: SupervisedServiceStatus;
  /** Human-readable one-liner: what the probe observed. */
  detail?: string;
  /** When the service last started / last did useful work (ms epoch). */
  since?: number;
}

export interface SupervisedServiceDescriptor {
  id: string;
  name: string;
  description: string;
  /** Live status probe. Throwing = 'unknown' with the error as detail. */
  probe: () => SupervisedServiceHealth | Promise<SupervisedServiceHealth>;
  /**
   * Real restart seam. Omit when the subsystem cannot be restarted
   * in-process — the UI then shows no restart action (honest surface).
   */
  restart?: () => void | Promise<void>;
  /** Optional reader for the subsystem's own recent log lines. */
  recentLogs?: () => string[] | Promise<string[]>;
}

export interface SupervisedServiceView extends SupervisedServiceHealth {
  id: string;
  name: string;
  description: string;
  canRestart: boolean;
  recentLogs: string[];
  lastRestartAt?: number;
}

const LOG_RING_CAPACITY = 200;
const LOG_VIEW_LIMIT = 50;

export class SupervisedServiceRegistry {
  private readonly services = new Map<string, SupervisedServiceDescriptor>();
  private readonly logRings = new Map<string, string[]>();
  private readonly lastRestartAt = new Map<string, number>();
  private readonly auditLog?: LifecycleAuditLog;

  constructor(deps: { auditLog?: LifecycleAuditLog } = {}) {
    this.auditLog = deps.auditLog;
  }

  register(descriptor: SupervisedServiceDescriptor): void {
    if (this.services.has(descriptor.id)) {
      throw new Error(`supervised service already registered: ${descriptor.id}`);
    }
    this.services.set(descriptor.id, descriptor);
    this.logRings.set(descriptor.id, []);
  }

  has(id: string): boolean {
    return this.services.has(id);
  }

  ids(): string[] {
    return [...this.services.keys()];
  }

  /** Push a log line into a service's ring buffer (oldest evicted). */
  recordLog(id: string, line: string): void {
    const ring = this.logRings.get(id);
    if (!ring) return;
    ring.push(line);
    if (ring.length > LOG_RING_CAPACITY) ring.splice(0, ring.length - LOG_RING_CAPACITY);
  }

  async view(id: string): Promise<SupervisedServiceView | undefined> {
    const descriptor = this.services.get(id);
    if (!descriptor) return undefined;
    let health: SupervisedServiceHealth;
    try {
      health = await descriptor.probe();
    } catch (err) {
      health = {
        status: 'unknown',
        detail: `probe failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    let ownLogs: string[] = [];
    if (descriptor.recentLogs) {
      try {
        ownLogs = await descriptor.recentLogs();
      } catch {
        ownLogs = [];
      }
    }
    const merged = [...(this.logRings.get(id) ?? []), ...ownLogs].slice(-LOG_VIEW_LIMIT);
    return {
      id: descriptor.id,
      name: descriptor.name,
      description: descriptor.description,
      canRestart: typeof descriptor.restart === 'function',
      ...health,
      recentLogs: merged,
      ...(this.lastRestartAt.has(id) ? { lastRestartAt: this.lastRestartAt.get(id) } : {}),
    };
  }

  async list(): Promise<SupervisedServiceView[]> {
    const views: SupervisedServiceView[] = [];
    for (const id of this.services.keys()) {
      const view = await this.view(id);
      if (view) views.push(view);
    }
    return views;
  }

  /**
   * Restart a service through its registered seam. Fails honestly:
   * unknown service → 404 class; no seam → 'no-restart-seam' error.
   */
  async restart(id: string, actor = 'api'): Promise<SupervisedServiceView> {
    const descriptor = this.services.get(id);
    if (!descriptor) throw new SupervisedServiceError(`unknown supervised service: ${id}`, 404);
    if (typeof descriptor.restart !== 'function') {
      throw new SupervisedServiceError(
        `service "${id}" has no in-process restart seam; it restarts with the app`,
        400,
      );
    }
    await descriptor.restart();
    this.lastRestartAt.set(id, Date.now());
    this.recordLog(id, `[${new Date().toISOString()}] restarted via services view by ${actor}`);
    this.auditLog?.record('service.restarted', actor, { serviceId: id });
    const view = await this.view(id);
    return view!;
  }
}

export class SupervisedServiceError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'SupervisedServiceError';
  }
}

// ---------------------------------------------------------------------------
// Well-known subsystem ids (the wiring note maps these to live handles).
// ---------------------------------------------------------------------------

export const SUPERVISED_SERVICE_IDS = {
  routines: 'routines-engine',
  sync: 'account-sync',
  connectors: 'connector-sync',
  dreamer: 'dreamer',
  cloudSupervisor: 'cloud-supervisor',
  watchers: 'watch-watcher',
  scheduler: 'thread-scheduler',
} as const;

// ---------------------------------------------------------------------------
// Routes — register-style: mount at /api (paths are /services…).
// ---------------------------------------------------------------------------

export function createSupervisedServicesRouter(deps: {
  registry: SupervisedServiceRegistry;
}): Router {
  const router = Router();

  router.get('/services', async (_req: Request, res: Response) => {
    res.json({ ok: true, services: await deps.registry.list() });
  });

  router.get('/services/:id', async (req: Request, res: Response) => {
    const view = await deps.registry.view(req.params.id);
    if (!view) {
      res.status(404).json({ error: `unknown supervised service: ${req.params.id}` });
      return;
    }
    res.json({ ok: true, service: view });
  });

  router.post('/services/:id/restart', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { actor?: unknown };
      const view = await deps.registry.restart(
        req.params.id,
        typeof body.actor === 'string' ? body.actor : undefined,
      );
      res.json({ ok: true, service: view });
    } catch (err) {
      if (err instanceof SupervisedServiceError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: err instanceof Error ? err.message : 'restart failed' });
    }
  });

  return router;
}
