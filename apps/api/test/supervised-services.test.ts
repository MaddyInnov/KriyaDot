// SPDX-License-Identifier: Apache-2.0
// SCH-5 — supervised-services registry: status probes, honest restart
// seams (no seam → no fake restart), merged recent logs, HTTP surface.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SupervisedServiceError,
  SupervisedServiceRegistry,
  createSupervisedServicesRouter,
} from '../src/supervised-services.js';
import { LifecycleAuditLog } from '../src/lifecycle-approval.js';

describe('SupervisedServiceRegistry (SCH-5)', () => {
  let dir: string;
  let registry: SupervisedServiceRegistry;
  let restarts: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'supervised-'));
    restarts = 0;
    registry = new SupervisedServiceRegistry({ auditLog: new LifecycleAuditLog(dir) });
    registry.register({
      id: 'routines-engine',
      name: 'Routines engine',
      description: 'Fires scheduled routines.',
      probe: () => ({ status: 'running', detail: '3 routines armed', since: 123 }),
      restart: () => {
        restarts += 1;
      },
      recentLogs: () => ['own-log-line'],
    });
    registry.register({
      id: 'dreamer',
      name: 'Dreamer',
      description: 'Nightly memory consolidation. Restarts with the app.',
      probe: () => ({ status: 'degraded', detail: 'last run failed' }),
      // No restart seam — honestly not restartable in-process.
    });
    registry.register({
      id: 'broken-probe',
      name: 'Broken probe',
      description: 'Probe throws.',
      probe: () => {
        throw new Error('probe exploded');
      },
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists services with probed status and honest canRestart flags', async () => {
    const views = await registry.list();
    const routines = views.find((v) => v.id === 'routines-engine');
    expect(routines?.status).toBe('running');
    expect(routines?.canRestart).toBe(true);
    const dreamer = views.find((v) => v.id === 'dreamer');
    expect(dreamer?.status).toBe('degraded');
    expect(dreamer?.canRestart).toBe(false);
    const broken = views.find((v) => v.id === 'broken-probe');
    expect(broken?.status).toBe('unknown');
    expect(broken?.detail).toContain('probe exploded');
  });

  it('merges ring-buffer logs with the service own logs, capped', async () => {
    registry.recordLog('routines-engine', 'ring-line-1');
    registry.recordLog('routines-engine', 'ring-line-2');
    const view = await registry.view('routines-engine');
    expect(view?.recentLogs).toEqual(['ring-line-1', 'ring-line-2', 'own-log-line']);
  });

  it('restarts through the seam, stamps lastRestartAt, and audits', async () => {
    const view = await registry.restart('routines-engine', 'test');
    expect(restarts).toBe(1);
    expect(view.lastRestartAt).toBeTypeOf('number');
    expect(view.recentLogs.some((l) => l.includes('restarted via services view'))).toBe(true);
  });

  it('refuses restart for seam-less and unknown services', async () => {
    await expect(registry.restart('dreamer')).rejects.toThrow(/no in-process restart seam/);
    await expect(registry.restart('nope')).rejects.toBeInstanceOf(SupervisedServiceError);
  });

  it('serves list + restart over HTTP', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', createSupervisedServicesRouter({ registry }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}/api/services`;
    try {
      const list = (await (await fetch(base)).json()) as { services: Array<{ id: string }> };
      expect(list.services.map((s) => s.id)).toContain('dreamer');

      const noSeam = await fetch(`${base}/dreamer/restart`, { method: 'POST' });
      expect(noSeam.status).toBe(400);

      const ok = await fetch(`${base}/routines-engine/restart`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(ok.status).toBe(200);
      expect(restarts).toBe(1);

      const missing = await fetch(`${base}/ghost`);
      expect(missing.status).toBe(404);
    } finally {
      server.close();
    }
  });
});
