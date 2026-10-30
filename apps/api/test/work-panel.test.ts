// SPDX-License-Identifier: Apache-2.0
// Tests for apps/api/src/work-panel.ts (Activity / live-work panel):
// - pure projection: day-boundary grouping, title extraction, status
//   sentence, attempts passthrough
// - HTTP surface with in-memory fake stores (zero paid APIs, temp-free):
//   live status, day-grouped items, run summary, permissions summary.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BotConfig } from '@mvp/agent-runtime';
import {
  buildStatusSentence,
  cleanTitle,
  groupWorkByDay,
  normalizeAttempts,
  projectWorkItems,
  registerWorkPanelRoutes,
  titleFromSpans,
  type ObsRunLike,
  type WorkItem,
} from '../src/work-panel.js';

const BOTS = [
  { id: 'chief', name: 'Chief', tools: ['search', 'write'] },
  { id: 'writer', name: 'Writer', tools: ['write'] },
] as unknown as BotConfig[];

function localTs(y: number, m: number, d: number, h = 12, min = 0): number {
  return new Date(y, m - 1, d, h, min).getTime();
}

function item(partial: Partial<WorkItem> & { runId: string; timestamp: number }): WorkItem {
  return {
    source: 'observability',
    title: 'A task',
    outcome: 'Finished — all done.',
    status: 'completed',
    endedAt: partial.timestamp + 1000,
    botId: 'chief',
    botName: 'Chief',
    attempts: [],
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// Pure projection
// ---------------------------------------------------------------------------

describe('groupWorkByDay', () => {
  const now = localTs(2026, 10, 30, 15, 0);

  it('labels today and yesterday by local day boundaries', () => {
    const groups = groupWorkByDay(
      [
        item({ runId: 'a', timestamp: localTs(2026, 10, 30, 0, 1) }), // just after midnight → Today
        item({ runId: 'b', timestamp: localTs(2026, 10, 29, 23, 59) }), // just before → Yesterday
        item({ runId: 'c', timestamp: localTs(2026, 10, 29, 0, 1) }),
        item({ runId: 'd', timestamp: localTs(2026, 10, 20, 9, 0) }),
      ],
      now,
    );
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday', expect.any(String)]);
    expect(groups[0]!.items.map((i) => i.runId)).toEqual(['a']);
    // Within Yesterday, newest first.
    expect(groups[1]!.items.map((i) => i.runId)).toEqual(['b', 'c']);
    expect(groups[2]!.date).toBe('2026-10-20');
  });

  it('returns an empty list for no items', () => {
    expect(groupWorkByDay([], now)).toEqual([]);
  });
});

describe('title extraction', () => {
  it('uses the first user message verbatim (single-lined, trimmed)', () => {
    const items = projectWorkItems({
      obsRuns: [
        {
          runId: 'r1',
          sessionId: 's1',
          botId: 'chief',
          kind: 'session',
          startedAt: 1000,
          endedAt: 2000,
          outcome: 'success',
        } satisfies ObsRunLike,
      ],
      routineRuns: [],
      backgroundRuns: [],
      botName: (id) => (id === 'chief' ? 'Chief' : id),
      firstUserMessage: () => '  Research the best\nstanding desks  ',
    });
    expect(items[0]!.title).toBe('Research the best standing desks');
    expect(items[0]!.status).toBe('completed');
  });

  it('falls back to the turn span payload, then to a friendly default', () => {
    const spans = [
      {
        id: 'sp1',
        runId: 'r1',
        sessionId: 's1',
        parentSpanId: null,
        kind: 'turn' as const,
        name: 'turn',
        startedAt: 0,
        endedAt: 5,
        durationMs: 5,
        status: 'ok' as const,
        botId: 'chief',
        payload: { input: { message: 'Draft the launch email' } },
      },
    ];
    expect(titleFromSpans(spans as never)).toBe('Draft the launch email');
    expect(cleanTitle(undefined, 'A task with Chief')).toBe('A task with Chief');
    expect(cleanTitle('x'.repeat(200), 'fb').length).toBeLessThanOrEqual(90);
  });

  it('uses the routine name as the title for routine runs', () => {
    const items = projectWorkItems({
      obsRuns: [],
      routineRuns: [
        {
          id: 'rr1',
          routineId: 'morning',
          routineName: 'Morning briefing',
          status: 'succeeded',
          startedAt: 500,
          endedAt: 900,
          createdAt: 400,
          outputExcerpt: 'Three things need you today.',
          attempts: 1,
        },
      ],
      backgroundRuns: [],
      botName: (id) => id,
    });
    expect(items[0]!.title).toBe('Morning briefing');
    expect(items[0]!.outcome).toBe('Three things need you today.');
    expect(items[0]!.status).toBe('completed');
  });
});

describe('buildStatusSentence', () => {
  it('is the idle sentence when nothing runs', () => {
    expect(buildStatusSentence([])).toBe('Nothing running right now');
  });

  it('names the single running task', () => {
    const sentence = buildStatusSentence([
      item({ runId: 'a', timestamp: 1, status: 'running', title: 'Research standing desks' }),
    ]);
    expect(sentence).toContain('1 task');
    expect(sentence).toContain('researching');
    expect(sentence).toContain('Research standing desks');
  });

  it('counts multiple running tasks', () => {
    const sentence = buildStatusSentence([
      item({ runId: 'a', timestamp: 1, status: 'running', title: 'Research X' }),
      item({ runId: 'b', timestamp: 2, status: 'writing', title: 'Write the report' }),
    ]);
    expect(sentence).toMatch(/^Running 2 tasks — /);
    expect(sentence).toContain('·');
  });
});

describe('normalizeAttempts (passthrough)', () => {
  it('passes an attempt trail array through', () => {
    const trail = [{ attempt: 1, error: 'timeout' }, { attempt: 2 }];
    expect(normalizeAttempts(trail)).toEqual(trail);
  });

  it('expands a numeric attempt count and defaults to empty', () => {
    expect(normalizeAttempts(3)).toEqual([{ attempt: 1 }, { attempt: 2 }, { attempt: 3 }]);
    expect(normalizeAttempts(undefined)).toEqual([]);
    expect(normalizeAttempts(null)).toEqual([]);
  });

  it('surfaces attempts on projected items when the record carries them', () => {
    const items = projectWorkItems({
      obsRuns: [
        {
          runId: 'r9',
          sessionId: 's9',
          botId: 'chief',
          kind: 'session',
          startedAt: 10,
          endedAt: 20,
          outcome: 'failed',
          attempts: [{ attempt: 1, error: 'boom' }],
        } as ObsRunLike,
      ],
      routineRuns: [],
      backgroundRuns: [],
      botName: (id) => id,
    });
    expect(items[0]!.attempts).toEqual([{ attempt: 1, error: 'boom' }]);
  });
});

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

interface FakeRun extends ObsRunLike {
  spans: Array<Record<string, unknown>>;
  totalCost: number;
}

function fakeSpanStore(runs: FakeRun[]) {
  return {
    listRuns: ({ limit }: { limit?: number }) => runs.slice(0, limit ?? 100),
    getRun: (runId: string) => runs.find((r) => r.runId === runId),
    listSpans: (runId: string) => runs.find((r) => r.runId === runId)?.spans ?? [],
    runTotals: (runId: string) => {
      const run = runs.find((r) => r.runId === runId);
      return {
        runId,
        spanCount: run?.spans.length ?? 0,
        llmCostCents: run?.totalCost ?? 0,
        toolCostCents: 0,
        totalCostCents: run?.totalCost ?? 0,
        errorCount: 0,
        durationMs: run && run.endedAt !== null ? run.endedAt - run.startedAt : null,
      };
    },
  };
}

describe('work-panel routes', () => {
  let baseUrl = '';
  let server: ReturnType<typeof import('node:http').createServer> | null = null;
  let dataDir = '';

  beforeEach(async () => {
    const todayStart = new Date();
    todayStart.setHours(10, 0, 0, 0);
    const yesterday = new Date(todayStart.getTime() - 24 * 3600 * 1000);
    const runs: FakeRun[] = [
      {
        runId: 'run_today_done',
        sessionId: 'sess_a',
        botId: 'chief',
        kind: 'session',
        startedAt: todayStart.getTime(),
        endedAt: todayStart.getTime() + 60_000,
        outcome: 'success',
        totalCost: 12,
        spans: [],
      },
      {
        runId: 'run_today_live',
        sessionId: 'sess_b',
        botId: 'writer',
        kind: 'session',
        startedAt: todayStart.getTime() + 120_000,
        endedAt: null,
        outcome: null,
        totalCost: 0,
        spans: [],
      },
      {
        runId: 'run_yesterday',
        sessionId: 'sess_c',
        botId: 'chief',
        kind: 'session',
        startedAt: yesterday.getTime(),
        endedAt: yesterday.getTime() + 30_000,
        outcome: 'failed',
        totalCost: 3,
        spans: [],
      },
    ];
    const firstMessages: Record<string, string> = {
      sess_a: 'Plan my week',
      sess_b: 'Write the release notes',
      sess_c: 'Book a flight to Pune',
    };
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerWorkPanelRoutes(router, {
      spanStore: fakeSpanStore(runs) as never,
      listRoutineRuns: () => [
        {
          id: 'routine_run_1',
          routineId: 'morning',
          routineName: 'Morning briefing',
          status: 'succeeded',
          startedAt: todayStart.getTime() + 60_000,
          endedAt: todayStart.getTime() + 90_000,
          createdAt: todayStart.getTime() + 59_000,
          outputExcerpt: 'All caught up.',
          attempts: [{ attempt: 1 }, { attempt: 2 }],
        },
      ],
      listBackgroundRuns: () => [],
      getFirstUserMessage: (sessionId) => firstMessages[sessionId],
      bots: BOTS,
      dataDir: (dataDir = mkdtempSync(join(tmpdir(), 'work-panel-'))),
      getVaultCounts: () => ({ secrets: 2, logins: 1, walletMethods: 1, accountsConnected: 1, accountsTotal: 1 }),
      countPendingApprovals: () => 3,
    });
    app.use('/api', router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve()) as never;
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}/api`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) =>
      (server as unknown as { close(cb: () => void): void }).close(() => resolve()),
    );
    server = null;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = '';
  });

  async function api(path: string): Promise<{ status: number; json: any }> {
    const res = await fetch(`${baseUrl}${path}`);
    return { status: res.status, json: await res.json() };
  }

  it('live status names the running work', async () => {
    const { status, json } = await api('/work-panel/live');
    expect(status).toBe(200);
    expect(json.idle).toBe(false);
    expect(json.runningCount).toBe(1);
    expect(json.sentence).toContain('Write the release notes');
    expect(json.running[0].runId).toBe('run_today_live');
  });

  it('items are grouped Today / Yesterday with user-word titles', async () => {
    const { status, json } = await api('/work-panel/items');
    expect(status).toBe(200);
    expect(json.groups.map((g: any) => g.label)).toEqual(['Today', 'Yesterday']);
    const todayTitles = json.groups[0].items.map((i: any) => i.title);
    expect(todayTitles).toContain('Plan my week');
    expect(todayTitles).toContain('Morning briefing');
    const routine = json.groups[0].items.find((i: any) => i.runId === 'routine_run_1');
    expect(routine.attempts).toEqual([{ attempt: 1 }, { attempt: 2 }]);
    expect(json.groups[1].items[0].title).toBe('Book a flight to Pune');
    expect(json.groups[1].items[0].status).toBe('failed');
  });

  it('run detail returns the plain-language summary header data', async () => {
    const { status, json } = await api('/work-panel/runs/run_today_done');
    expect(status).toBe(200);
    expect(json.summary.asked).toBe('Plan my week');
    expect(json.summary.status).toBe('completed');
    expect(json.summary.durationMs).toBe(60_000);
    expect(json.summary.costCents).toBe(12);
    expect(json.summary.botName).toBe('Chief');
  });

  it('unknown run 404s', async () => {
    const { status } = await api('/work-panel/runs/nope');
    expect(status).toBe(404);
  });

  it('permissions summary is counts-only with per-bot policy data', async () => {
    const { status, json } = await api('/work-panel/permissions');
    expect(status).toBe(200);
    expect(json.summary.principal.userId).toBe('default-user');
    expect(json.summary.vault).toEqual({
      secrets: 2,
      logins: 1,
      walletMethods: 1,
      accountsConnected: 1,
      accountsTotal: 1,
    });
    expect(json.summary.pendingApprovals).toBe(3);
    expect(json.summary.bots.map((b: any) => b.botId)).toEqual(['chief', 'writer']);
    expect(JSON.stringify(json)).not.toContain('password');
  });
});
