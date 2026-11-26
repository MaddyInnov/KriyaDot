// SPDX-License-Identifier: Apache-2.0
// B-7 residual (web layer): the retraction reducer drops the dying
// provider's partial segment from the in-flight assistant block and
// never touches completed messages or the failover notice.

import { describe, expect, it } from 'vitest';
import { applyRetraction, type RetractableBlock } from './retract-state';

interface Block extends RetractableBlock {
  id: string;
}

const user = (text: string): Block => ({ kind: 'user', id: `u-${text}`, text });
const done = (text: string): Block => ({ kind: 'assistant', id: `a-${text}`, text, streaming: false });
const live = (text: string): Block => ({ kind: 'assistant', id: `s-${text}`, text, streaming: true });
const notice = (text: string): Block => ({ kind: 'notice', id: `n-${text}`, text });
const tool = (): Block => ({ kind: 'tool', id: 't-1' });

describe('applyRetraction (B-7 residual)', () => {
  it('drops the whole partial segment: a fully-retracted streaming block is removed', () => {
    const blocks = [user('hi'), done('earlier answer'), live('partial frag')];
    const out = applyRetraction(blocks, 'partial frag'.length);
    expect(out.map((b) => b.kind)).toEqual(['user', 'assistant']);
    expect(out[1]!.text).toBe('earlier answer');
  });

  it('keeps the failover notice and completed messages; only the in-flight segment goes', () => {
    // Stream order at the swap: partial tokens, failover notice, retract.
    const blocks = [user('hi'), live('partial frag'), notice('🔁 primary hit its limit — continues on backup')];
    const out = applyRetraction(blocks, 'partial frag'.length);
    expect(out.map((b) => b.kind)).toEqual(['user', 'notice']);
    expect(out[1]!.text).toContain('continues on backup');
  });

  it('truncates only the segment tail when the count is smaller than the block', () => {
    const blocks = [live('abcdef')];
    const out = applyRetraction(blocks, 2);
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe('abcd');
    expect(out[0]!.streaming).toBe(true);
  });

  it('clamps an oversized count to the in-flight block — completed history survives', () => {
    const blocks = [done('precious completed answer'), live('frag')];
    const out = applyRetraction(blocks, 10_000);
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe('precious completed answer');
  });

  it('does nothing when the newest assistant block is already complete', () => {
    const blocks = [user('hi'), done('finished'), tool()];
    const out = applyRetraction(blocks, 5);
    expect(out.map((b) => b.kind)).toEqual(['user', 'assistant', 'tool']);
    expect(out[1]!.text).toBe('finished');
  });

  it('does nothing for a zero/invalid count or an empty list', () => {
    expect(applyRetraction([live('frag')], 0)[0]!.text).toBe('frag');
    expect(applyRetraction([], 5)).toEqual([]);
  });

  it('backup tokens after retraction start a clean bubble (reducer-level composition)', () => {
    // Simulate the page's token rule on the retracted list: with the
    // partial block gone and a notice last, the next token opens a new
    // streaming block containing only the backup's answer.
    const blocks = [user('hi'), live('partial frag'), notice('🔁 swap')];
    const out = [...applyRetraction(blocks, 'partial frag'.length)];
    const last = out[out.length - 1];
    if (!(last && last.kind === 'assistant' && last.streaming)) {
      out.push({ kind: 'assistant', id: 's-backup', text: 'full answer', streaming: true });
    }
    const assistants = out.filter((b) => b.kind === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.text).toBe('full answer');
  });
});
