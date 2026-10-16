// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  applyFusionEvent,
  emptyFusionState,
  type FusionLiveState,
} from './fusion-progress';
import type { FusionStreamEvent } from '../../lib/api';

const PLAN = {
  subtasks: [
    { id: 's1', title: 'Research', description: 'research it', dependencies: [] },
    { id: 's2', title: 'Draft', description: 'draft it', dependencies: ['s1'] },
  ],
  rationale: 'split',
};

function reduce(events: FusionStreamEvent[]): FusionLiveState {
  return events.reduce(applyFusionEvent, emptyFusionState());
}

describe('applyFusionEvent', () => {
  it('folds a full successful run', () => {
    const state = reduce([
      { type: 'plan_created', plan: PLAN },
      { type: 'worker_started', subtaskId: 's1', title: 'Research' },
      { type: 'worker_done', subtaskId: 's1', title: 'Research', ok: true },
      { type: 'worker_started', subtaskId: 's2', title: 'Draft' },
      { type: 'worker_done', subtaskId: 's2', title: 'Draft', ok: true },
      { type: 'fusion_started', workerCount: 2 },
      {
        type: 'done',
        result: {
          task: 't',
          status: 'completed',
          plan: PLAN,
          workerResults: [
            { subtaskId: 's1', title: 'Research', output: 'facts', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
            { subtaskId: 's2', title: 'Draft', output: 'doc', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
          ],
          fused: 'final',
          fallbackSingleAgent: false,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        },
      },
    ]);
    expect(state.status).toBe('completed');
    expect(state.fused).toBe('final');
    expect(state.workerStatus).toEqual({ s1: 'done', s2: 'done' });
    expect(state.workerResults).toHaveLength(2);
  });

  it('marks failed workers', () => {
    const state = reduce([
      { type: 'worker_started', subtaskId: 's1', title: 'A' },
      { type: 'worker_done', subtaskId: 's1', title: 'A', ok: false },
      { type: 'error', message: 'boom' },
    ]);
    expect(state.workerStatus.s1).toBe('failed');
    expect(state.status).toBe('failed');
    expect(state.error).toBe('boom');
  });

  it('handles plan_failed as single-agent fallback', () => {
    const state = reduce([{ type: 'plan_failed', reason: 'bad json' }]);
    expect(state.fallbackSingleAgent).toBe(true);
    expect(state.planFailedReason).toBe('bad json');
  });

  it('hydrates from a snapshot', () => {
    const state = reduce([
      {
        type: 'snapshot',
        run: {
          runId: 'fr_x',
          botId: 'b',
          botName: 'B',
          task: 't',
          status: 'completed',
          plan: PLAN,
          workerResults: [
            { subtaskId: 's1', title: 'Research', output: 'o', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, error: 'x' },
          ],
          fused: 'f',
          fallbackSingleAgent: false,
          usage: null,
          costUsd: 0.02,
          error: null,
          createdAt: '2026-01-01',
          completedAt: '2026-01-01',
        },
      },
    ]);
    expect(state.status).toBe('completed');
    expect(state.fused).toBe('f');
    expect(state.workerStatus).toEqual({ s1: 'failed' });
    expect(state.costUsd).toBe(0.02);
  });

  it('ignores unknown event types', () => {
    const state = reduce([{ type: 'nonsense' } as unknown as FusionStreamEvent]);
    expect(state.status).toBe('running');
  });
});
