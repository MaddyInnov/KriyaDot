// SPDX-License-Identifier: Apache-2.0
// Tests for crash recovery:
// - TurnTracker begin/end/listActive
// - reconcileOnBoot marks stuck routine runs failed and files orphan entries
// - the recovery router lists orphans and dismisses them

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createCrashRecoveryRouter,
  INTERRUPTED_NOTE,
  OrphanLedger,
  reconcileOnBoot,
  TurnTracker,
} from '../src/crash-recovery.js';

describe('TurnTracker', () => {
  let dir: string;
  let tracker: TurnTracker;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'turns-'));
    tracker = new TurnTracker(dir);
  });
  afterEach(() => {
    tracker.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('tracks active turns and clears them on end', () => {
    tracker.beginTurn({ sessionId: 's1', botId: 'b1', message: 'hello', startedAt: Date.now() });
    expect(tracker.listActive()).toHaveLength(1);
    tracker.endTurn('s1');
    expect(tracker.listActive()).toHaveLength(0);
  });
});

describe('reconcileOnBoot', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'reconcile-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('marks stuck routine runs interrupted and files orphans', () => {
    const marked: string[] = [];
    const audits: string[] = [];
    const summary = reconcileOnBoot({
      dataDir: dir,
      listStuckRoutineRuns: () => [{ id: 'run-1', routineId: 'r1', routineName: 'Nightly' }],
      reconcileRoutineRuns: () => {
        marked.push('run-1');
        return 1;
      },
      listRunningTeamRuns: () => [],
      markTeamRunInterrupted: () => {},
      listRunningGroupGoals: () => [{ goalId: 'g1', title: 'Ship it' }],
      markGroupGoalInterrupted: () => {},
      turnTracker: (() => {
        const t = new TurnTracker(dir);
        t.beginTurn({ sessionId: 's9', botId: 'b1', message: 'half-written', startedAt: Date.now() });
        return t;
      })(),
      audit: (action) => {
        audits.push(action);
      },
    });
    expect(marked).toEqual(['run-1']);
    expect(summary.counts['routine-run']).toBe(1);
    expect(summary.counts['group-goal']).toBe(1);
    expect(summary.counts['chat-turn']).toBe(1);
    expect(summary.orphans).toHaveLength(3);
    // Chat-turn orphan carries the resume payload.
    const chatOrphan = summary.orphans.find((o) => o.kind === 'chat-turn');
    expect(chatOrphan?.context?.sessionId).toBe('s9');
    expect(audits).toContain('recovery.reconciled');
  });
});

describe('crash recovery router', () => {
  let dir: string;
  let baseUrl: string;
  let server: { close(cb: () => void): void } | null = null;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'recovery-'));
    const ledger = new OrphanLedger(dir);
    ledger.file({ kind: 'routine-run', refId: 'run-1', label: 'Nightly run', context: { routineId: 'r1' } });
    ledger.close();

    const app = express();
    app.use(express.json());
    app.use(
      '/recovery',
      createCrashRecoveryRouter({
        dataDir: dir,
        audit: () => {},
      }),
    );
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve()) as unknown as { close(cb: () => void): void };
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}/recovery`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists orphans and dismisses them', async () => {
    const list = (await (await fetch(`${baseUrl}/orphans`)).json()) as {
      orphans: Array<{ id: string; label: string }>;
    };
    expect(list.orphans).toHaveLength(1);
    expect(list.orphans[0].label).toContain('Nightly run');
    const dismiss = await fetch(`${baseUrl}/orphans/${list.orphans[0].id}/dismiss`, { method: 'POST' });
    expect(dismiss.status).toBe(200);
    const again = (await (await fetch(`${baseUrl}/orphans`)).json()) as { orphans: unknown[] };
    expect(again.orphans).toHaveLength(0);
  });

  it('resume on a routine-run orphan hands back the retry URL', async () => {
    const list = (await (await fetch(`${baseUrl}/orphans`)).json()) as {
      orphans: Array<{ id: string }>;
    };
    const resume = await fetch(`${baseUrl}/orphans/${list.orphans[0].id}/resume`, { method: 'POST' });
    expect(resume.status).toBe(200);
    const body = (await resume.json()) as { kind: string; resumeUrl?: string };
    expect(body.kind).toBe('routine-run');
  });
});
