// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  computePetMood,
  collectPetStateInputs,
  PET_CELEBRATE_WINDOW_MS,
  PET_RECENT_WINDOW_MS,
  PET_SLEEP_AFTER_MS,
  type PetStateInputs,
} from '../src/pet-state.js';

const NOW = 1_700_000_000_000;

function base(over: Partial<PetStateInputs> = {}): PetStateInputs {
  return {
    now: NOW,
    activeTurns: [],
    workflowRunning: 0,
    workflowPaused: 0,
    pendingApprovals: 0,
    queued: 0,
    speakingActive: false,
    lastCompletedAt: null,
    lastOutcome: null,
    lastActivityAt: NOW,
    ...over,
  };
}

describe('computePetMood', () => {
  it('speaking outranks everything', () => {
    expect(computePetMood(base({ speakingActive: true, activeTurns: [{ step: 'Working' }] }))).toBe('speaking');
  });

  it('active turn with a Thinking step → thinking, otherwise working', () => {
    expect(computePetMood(base({ activeTurns: [{ step: 'Thinking' }] }))).toBe('thinking');
    expect(computePetMood(base({ activeTurns: [{ step: 'Running read_file' }] }))).toBe('working');
  });

  it('running workflow → working even with no chat turns', () => {
    expect(computePetMood(base({ workflowRunning: 2 }))).toBe('working');
  });

  it('waiting states → thinking (approvals, paused runs, queued messages)', () => {
    expect(computePetMood(base({ pendingApprovals: 1 }))).toBe('thinking');
    expect(computePetMood(base({ workflowPaused: 1 }))).toBe('thinking');
    expect(computePetMood(base({ queued: 3 }))).toBe('thinking');
  });

  it('active work outranks waiting', () => {
    expect(computePetMood(base({ activeTurns: [{ step: 'Running tests' }], pendingApprovals: 2 }))).toBe('working');
  });

  it('recent failure → error, recent success → celebrating then happy', () => {
    const done = NOW - 5_000;
    expect(computePetMood(base({ lastCompletedAt: done, lastOutcome: 'failed' }))).toBe('error');
    expect(computePetMood(base({ lastCompletedAt: done, lastOutcome: 'success' }))).toBe('celebrating');
    expect(
      computePetMood(base({ lastCompletedAt: NOW - PET_CELEBRATE_WINDOW_MS - 1_000, lastOutcome: 'success' })),
    ).toBe('happy');
    expect(computePetMood(base({ lastCompletedAt: done, lastOutcome: 'needs-input' }))).toBe('thinking');
  });

  it('stale outcomes fall through to idle/sleeping', () => {
    const old = NOW - PET_RECENT_WINDOW_MS - 1_000;
    expect(computePetMood(base({ lastCompletedAt: old, lastOutcome: 'failed', lastActivityAt: NOW }))).toBe('idle');
    expect(
      computePetMood(base({ lastCompletedAt: old, lastOutcome: 'success', lastActivityAt: NOW - PET_SLEEP_AFTER_MS - 1 })),
    ).toBe('sleeping');
  });

  it('long inactivity → sleeping, fresh inactivity → idle', () => {
    expect(computePetMood(base({ lastActivityAt: NOW - PET_SLEEP_AFTER_MS - 1 }))).toBe('sleeping');
    expect(computePetMood(base({ lastActivityAt: NOW - 1_000 }))).toBe('idle');
    expect(computePetMood(base({ lastActivityAt: null }))).toBe('idle');
  });
});

describe('collectPetStateInputs', () => {
  it('aggregates turns, workflows, approvals and queue without throwing on broken sources', () => {
    const inputs = collectPetStateInputs({
      now: () => NOW,
      turnStates: { list: () => [{ step: 'Thinking', startedAt: NOW - 1_000, updatedAt: NOW - 500 }] },
      workflowRunner: {
        listRuns: () => [
          { status: 'running', createdAt: NOW - 2_000, updatedAt: NOW - 100 } as never,
          { status: 'succeeded', createdAt: NOW - 9_000, updatedAt: NOW - 3_000 } as never,
        ],
      },
      listApprovals: () => [{}, {}],
      chatQueue: { list: () => [{}] },
    });
    expect(inputs.activeTurns).toHaveLength(1);
    expect(inputs.workflowRunning).toBe(1);
    expect(inputs.pendingApprovals).toBe(2);
    expect(inputs.queued).toBe(1);
    expect(inputs.lastOutcome).toBe('success');
    expect(inputs.lastCompletedAt).toBe(NOW - 3_000);
    expect(computePetMood(inputs)).toBe('thinking');

    const degraded = collectPetStateInputs({
      now: () => NOW,
      turnStates: { list: () => { throw new Error('boom'); } },
      workflowRunner: { listRuns: () => { throw new Error('boom'); } },
      listApprovals: () => { throw new Error('boom'); },
      chatQueue: { list: () => { throw new Error('boom'); } },
    });
    expect(computePetMood(degraded)).toBe('idle');
  });
});
