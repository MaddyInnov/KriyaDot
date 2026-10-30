// SPDX-License-Identifier: Apache-2.0
// Tool-result spill (#59): token-based threshold + the registered
// read_spilled_result tool round-trip.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ToolSpillStore,
  createSpillTools,
  estimateSpillTokens,
  DEFAULT_SPILL_THRESHOLD_TOKENS,
} from '../src/tool-spill.js';

const dirs: string[] = [];
function makeStore(): ToolSpillStore {
  const dir = mkdtempSync(join(tmpdir(), 'kriyadot-spill-'));
  dirs.push(dir);
  return new ToolSpillStore(dir);
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('ToolSpillStore thresholds', () => {
  it('keeps small results inline', () => {
    const store = makeStore();
    expect(store.maybeSpill('t', 'hello')).toBeNull();
  });

  it('spills on the byte ceiling', () => {
    const store = makeStore();
    const big = 'x'.repeat(40_000);
    expect(store.maybeSpill('t', big)).not.toBeNull();
  });

  it('spills on the token threshold even under the byte ceiling', () => {
    const store = makeStore();
    // 32_500 ASCII chars = 32_500 bytes (under the 32 KiB byte cap) but
    // ~8_125 estimated tokens (over the 8_000-token threshold).
    const content = 'a'.repeat(32_500);
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(32 * 1024);
    expect(estimateSpillTokens(content)).toBeGreaterThan(DEFAULT_SPILL_THRESHOLD_TOKENS);
    const ref = store.maybeSpill('t', content);
    expect(ref).not.toBeNull();
    expect(ref!.bytes).toBe(32_500);
  });
});

describe('read_spilled_result (registered tool)', () => {
  it('pages through a spilled result by id', async () => {
    const store = makeStore();
    const content = '0123456789'.repeat(5_000);
    const ref = store.maybeSpill('big_tool', content)!;
    expect(ref).not.toBeNull();
    const tools = createSpillTools(store);
    expect(tools.map((t) => t.name)).toEqual(['read_spilled_result']);
    const first = (await tools[0]!.handler({ id: ref.id, offset: 0, length: 100 }, undefined as never)) as {
      content: string;
      nextOffset: number | null;
      totalBytes: number;
    };
    expect(first.content).toBe(content.slice(0, 100));
    expect(first.nextOffset).toBe(100);
    expect(first.totalBytes).toBe(Buffer.byteLength(content, 'utf8'));
    const missing = (await tools[0]!.handler({ id: 'spill_nope' }, undefined as never)) as { error?: string };
    expect(missing.error).toBeTruthy();
  });

  it('the spill preview directs the model to the registered tool name', () => {
    const store = makeStore();
    const ref = store.maybeSpill('big_tool', 'z'.repeat(40_000))!;
    expect(store.formatForModel('big_tool', ref)).toContain('read_spilled_result');
  });
});
