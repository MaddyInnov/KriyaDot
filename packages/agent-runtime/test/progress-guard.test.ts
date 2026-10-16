// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import {
  ProgressGuard,
  classifyTurnError,
  noProgressReport,
} from '../src/progress-guard.js';

function call(name: string, args: Record<string, unknown> = {}, result: unknown = { ok: true }) {
  return { name, args, result };
}

describe('ProgressGuard', () => {
  it('does not trip on productive calls', () => {
    const g = new ProgressGuard(3);
    expect(g.observe(call('write_file', { path: 'a.ts' }, { written: 'a.ts' }))).toBe(false);
    expect(g.observe(call('read_file', { path: 'b.ts' }, 'contents'))).toBe(false);
    expect(g.isTripped).toBe(false);
  });
  it('trips after N consecutive unproductive calls', () => {
    const g = new ProgressGuard(3);
    expect(g.observe(call('read_file', { path: 'a' }, { error: 'not found' }))).toBe(false);
    expect(g.observe(call('read_file', { path: 'a' }, { error: 'not found' }))).toBe(false);
    expect(g.observe(call('read_file', { path: 'a' }, { error: 'not found' }))).toBe(true);
    expect(g.isTripped).toBe(true);
    expect(g.unproductiveStreak).toBe(3);
  });
  it('resets the streak on a productive call', () => {
    const g = new ProgressGuard(3);
    g.observe(call('read_file', { path: 'a' }, { error: 'x' }));
    g.observe(call('read_file', { path: 'a' }, { error: 'x' }));
    g.observe(call('write_file', { path: 'out' }, { written: 'out' }));
    expect(g.isTripped).toBe(false);
    expect(g.unproductiveStreak).toBe(0);
  });
  it('treats repeated identical successful reads as unproductive', () => {
    const g = new ProgressGuard(2);
    g.observe(call('read_file', { path: 'a' }, 'same contents')); // productive (new)
    g.observe(call('read_file', { path: 'a' }, 'same contents')); // unproductive (repeat)
    expect(g.observe(call('read_file', { path: 'a' }, 'same contents'))).toBe(true); // trips
  });
  it('treats new successful results as productive', () => {
    const g = new ProgressGuard(2);
    g.observe(call('glob', {}, ['a.ts']));
    expect(g.observe(call('glob', {}, ['b.ts']))).toBe(false);
    expect(g.unproductiveStreak).toBe(0);
  });
  it('reset() clears state for a new turn', () => {
    const g = new ProgressGuard(2);
    g.observe(call('read_file', {}, { error: 'x' }));
    g.observe(call('read_file', {}, { error: 'x' }));
    expect(g.isTripped).toBe(true);
    g.reset();
    expect(g.isTripped).toBe(false);
    expect(g.unproductiveStreak).toBe(0);
  });
});

describe('noProgressReport', () => {
  it('builds a classified failure with the call history', () => {
    const g = new ProgressGuard(2);
    g.observe(call('read_file', { path: 'a' }, { error: 'x' }));
    g.observe(call('read_file', { path: 'a' }, { error: 'x' }));
    const f = noProgressReport(g);
    expect(f.kind).toBe('no_progress');
    expect(f.message).toContain('No progress detected');
    expect(f.detail?.recentCalls).toHaveLength(2);
  });
});

describe('classifyTurnError', () => {
  it('classifies budget, timeout, denial, and aborts', () => {
    expect(classifyTurnError(new Error('Budget cap reached'))).toBe('budget_exceeded');
    expect(classifyTurnError(new Error('request timed out'))).toBe('timeout');
    expect(classifyTurnError(new Error('approval denied'))).toBe('approval_denied');
    expect(classifyTurnError(new Error('whatever'), { aborted: true })).toBe('interrupted');
    expect(classifyTurnError(new Error('boom'))).toBe('model_error');
  });
});
