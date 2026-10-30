// SPDX-License-Identifier: Apache-2.0
// SCH-13 — job self-pause: durable blocks pause on first failure,
// transient failures pause at the streak threshold, pause records carry
// reason + would-have-been next run, resume is explicit.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RoutineStore, type BotRoutine } from '../src/bot-routines.js';
import { RoutineRunStore } from '../src/routine-runs.js';
import {
  RoutineSelfPausePolicy,
  classifyDurableBlock,
  createRoutineSelfPauseRouter,
} from '../src/routine-self-pause.js';

describe('classifyDurableBlock', () => {
  it('classifies credential/config/target errors as durable', () => {
    expect(classifyDurableBlock('missing credential for gmail')).toBe('missing-credential');
    expect(classifyDurableBlock('401 invalid_api_key from provider')).toBe('credential-rejected');
    expect(classifyDurableBlock('OPENAI_API_KEY environment variable not set')).toBe('missing-config');
    expect(classifyDurableBlock('bot not found: bot-9')).toBe('target-gone');
  });

  it('leaves transient errors unclassified', () => {
    expect(classifyDurableBlock('socket hang up')).toBeNull();
    expect(classifyDurableBlock('rate limited, retry later')).toBeNull();
    expect(classifyDurableBlock(null)).toBeNull();
  });
});

describe('RoutineSelfPausePolicy (SCH-13)', () => {
  let dir: string;
  let routines: RoutineStore;
  let runs: RoutineRunStore;
  let policy: RoutineSelfPausePolicy;
  let routine: BotRoutine;

  function failRun(error: string): void {
    const run = runs.createRun({ routineId: routine.id, routineName: routine.name, trigger: 'schedule' });
    runs.startRun(run.id);
    runs.finishRun(run.id, { status: 'failed', error });
  }

  function succeedRun(): void {
    const run = runs.createRun({ routineId: routine.id, routineName: routine.name, trigger: 'schedule' });
    runs.startRun(run.id);
    runs.finishRun(run.id, { status: 'succeeded' });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'self-pause-'));
    routines = new RoutineStore(dir);
    runs = new RoutineRunStore(dir);
    policy = new RoutineSelfPausePolicy(dir, { routines, runs, failureThreshold: 3 });
    routine = routines.create({
      name: 'Morning digest',
      botId: 'bot-1',
      promptTemplate: 'Summarize the inbox',
      schedule: {
        kind: 'daily',
        time: '07:30',
        weekdays: [0, 1, 2, 3, 4, 5, 6],
        timezone: 'UTC',
        enabled: true,
        overlap: 'skip',
      },
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('pauses IMMEDIATELY on a durable block, with reason + next run shown', () => {
    failRun('missing credential for gmail');
    const pause = policy.evaluateAfterRun(routine.id);
    expect(pause?.reasonKind).toBe('durable-block');
    expect(pause?.blockKind).toBe('missing-credential');
    expect(pause?.reason).toContain('durable block');
    expect(pause?.nextRunAt).toBeTypeOf('number');
    expect(pause!.nextRunAt!).toBeGreaterThan(Date.now() - 60_000);
    expect(routines.get(routine.id)?.enabled).toBe(false);
    expect(policy.listActive()).toHaveLength(1);
  });

  it('pauses transient failures only at the threshold', () => {
    failRun('socket hang up');
    expect(policy.evaluateAfterRun(routine.id)).toBeUndefined();
    failRun('socket hang up again');
    expect(policy.evaluateAfterRun(routine.id)).toBeUndefined();
    expect(routines.get(routine.id)?.enabled).toBe(true);
    failRun('third socket hang up');
    const pause = policy.evaluateAfterRun(routine.id);
    expect(pause?.reasonKind).toBe('repeated-failure');
    expect(pause?.consecutiveFailures).toBe(3);
    expect(routines.get(routine.id)?.enabled).toBe(false);
  });

  it('does not pause when the streak was reset by a success', () => {
    failRun('boom');
    failRun('boom');
    succeedRun();
    failRun('boom');
    expect(policy.evaluateAfterRun(routine.id)).toBeUndefined();
    expect(routines.get(routine.id)?.enabled).toBe(true);
  });

  it('is idempotent while paused, and resume re-enables explicitly', () => {
    failRun('missing credential');
    policy.evaluateAfterRun(routine.id);
    expect(policy.evaluateAfterRun(routine.id)).toBeUndefined();
    expect(policy.listActive()).toHaveLength(1);

    const resumed = policy.resume(routine.id, 'test');
    expect(resumed?.resumedBy).toBe('test');
    expect(routines.get(routine.id)?.enabled).toBe(true);
    expect(policy.listActive()).toHaveLength(0);
    expect(policy.listHistory(routine.id)).toHaveLength(1);
    expect(policy.resume(routine.id)).toBeUndefined();
  });

  it('serves pauses + resume over HTTP for the schedule UI', async () => {
    failRun('missing credential for gmail');
    policy.evaluateAfterRun(routine.id);

    const app = express();
    app.use(express.json());
    app.use('/api', createRoutineSelfPauseRouter({ policy }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}/api/routine-pauses`;
    try {
      const list = (await (await fetch(base)).json()) as {
        pauses: Array<{ routineId: string; reason: string; nextRunAt?: number }>;
      };
      expect(list.pauses).toHaveLength(1);
      expect(list.pauses[0]?.routineId).toBe(routine.id);
      expect(list.pauses[0]?.reason).toContain('missing-credential');
      expect(list.pauses[0]?.nextRunAt).toBeTypeOf('number');

      const resumed = await fetch(`${base}/${routine.id}/resume`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(resumed.status).toBe(200);
      expect(routines.get(routine.id)?.enabled).toBe(true);

      const again = await fetch(`${base}/${routine.id}/resume`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(again.status).toBe(404);
    } finally {
      server.close();
    }
  });
});
