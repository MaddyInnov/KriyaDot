// SPDX-License-Identifier: Apache-2.0
// W14d global pause: persisted registry, audited HTTP surface, chat-turn
// refusal (mock runtime — the turn must never run), scheduler/poller
// skip behavior, and resume restoring normal operation.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PauseRegistry, registerSystemPauseRoutes } from '../src/system-pause.js';
import { BriefingScheduler, BriefingStore } from '../src/briefing.js';
import { RoutineScheduler } from '../src/routine-schedules.js';
import { EventTriggerPoller } from '../src/routine-events.js';
import { WatcherService } from '../src/watch-watcher.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'w14-pause-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('PauseRegistry', () => {
  it('pause → state persists across registry reopen; resume restores', () => {
    const a = new PauseRegistry(dir);
    expect(a.isPaused()).toBe(false);
    const s = a.pause('user', 'focus time', 1000);
    expect(s.paused).toBe(true);
    expect(s.pausedAt).toBe(1000);
    expect(s.pausedBy).toBe('user');
    expect(s.reason).toBe('focus time');

    const b = new PauseRegistry(dir); // "restart"
    expect(b.isPaused()).toBe(true);
    expect(b.state().pausedAt).toBe(1000);

    const r = b.resume('cli', 2000);
    expect(r.paused).toBe(false);
    expect(r.resumedAt).toBe(2000);
    expect(r.resumedBy).toBe('cli');
    expect(new PauseRegistry(dir).isPaused()).toBe(false);
  });

  it('pause is idempotent (keeps the original record)', () => {
    const a = new PauseRegistry(dir);
    a.pause('user', undefined, 1000);
    const again = a.pause('someone-else', undefined, 5000);
    expect(again.pausedAt).toBe(1000);
    expect(again.pausedBy).toBe('user');
  });
});

describe('system pause HTTP surface', () => {
  async function serve(registry: PauseRegistry, audits: Array<{ action: string; fields: Record<string, unknown> }>) {
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerSystemPauseRoutes(router, {
      registry,
      audit: (action, fields) => audits.push({ action, fields: fields as Record<string, unknown> }),
    });
    app.use('/api', router);
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    return { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
  }

  it('POST pause / GET pause-state / POST resume, all audited with the actor', async () => {
    const registry = new PauseRegistry(dir);
    const audits: Array<{ action: string; fields: Record<string, unknown> }> = [];
    const srv = await serve(registry, audits);
    try {
      let res = await fetch(`${srv.base}/api/system/pause-state`);
      expect(((await res.json()) as { paused: boolean }).paused).toBe(false);

      res = await fetch(`${srv.base}/api/system/pause`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actor: 'web', reason: 'focus' }),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { paused: boolean }).paused).toBe(true);
      expect(registry.isPaused()).toBe(true);

      res = await fetch(`${srv.base}/api/system/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actor: 'cli' }),
      });
      expect(((await res.json()) as { paused: boolean }).paused).toBe(false);

      const actions = audits.map((a) => a.action);
      expect(actions).toEqual(['system.paused', 'system.resumed']);
      expect(JSON.stringify(audits[0]!.fields)).toContain('web');
      expect(JSON.stringify(audits[1]!.fields)).toContain('cli');
    } finally {
      await srv.close();
    }
  });
});

describe('pause gates at the entry points', () => {
  it('W5 watcher skips polls while paused and resumes after', async () => {
    const registry = new PauseRegistry(dir);
    let executorCalls = 0;
    const watcher = new WatcherService({
      store: { listRules: () => [] } as never,
      executor: {
        executeTool: async () => {
          executorCalls += 1;
          return {};
        },
      },
      triage: async () => null,
      isPaused: () => registry.isPaused(),
    });
    registry.pause('user');
    await expect(watcher.pollDue()).resolves.toEqual([]);
    registry.resume('user');
    await expect(watcher.pollDue()).resolves.toEqual([]); // no rules, but the gate is open
    expect(executorCalls).toBe(0);
  });

  it('W2 event poller skips polls while paused', async () => {
    const registry = new PauseRegistry(dir);
    registry.pause('user');
    const poller = new EventTriggerPoller({
      routineStore: {
        list: () => {
          throw new Error('must not be read while paused');
        },
      } as never,
      eventStore: {} as never,
      executor: { executeTool: async () => ({}) },
      isPaused: () => registry.isPaused(),
    });
    await expect(poller.pollDue()).resolves.toEqual([]);
  });

  it('routine scheduler skips its tick while paused (routine store never read)', async () => {
    const registry = new PauseRegistry(dir);
    registry.pause('user');
    const scheduler = new RoutineScheduler({
      routineStore: {
        list: () => {
          throw new Error('must not be read while paused');
        },
      } as never,
      agentRuntime: {} as never,
      getBots: () => [],
      isPaused: () => registry.isPaused(),
    });
    await expect(scheduler.tick()).resolves.toBeUndefined();
  });

  it('briefing scheduler skips its tick while paused (no briefing saved)', async () => {
    const registry = new PauseRegistry(dir);
    registry.pause('user');
    const scheduler = new BriefingScheduler({
      dataDir: dir,
      governance: { listAudit: () => [], listApprovals: () => [] } as never,
      runHealth: { listScopes: () => [], queryMetrics: () => [] } as never,
      summarize: async () => 'x',
      isPaused: () => registry.isPaused(),
    });
    const at = new Date();
    at.setHours(7, 0, 0, 0); // matches the default 07:00 briefing time
    await scheduler.tick(at);
    expect(new BriefingStore(dir).latest()).toBeUndefined();
  });
});
