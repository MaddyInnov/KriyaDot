// SPDX-License-Identifier: Apache-2.0
// OH-1: compression + searchable handles + TTL/cap hygiene + verbatim bypass + metrics.
import { mkdtempSync, rmSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ToolSpillStore,
  compressToolResult,
  createHandleTools,
  createSpillTools,
  type SpillMetrics,
} from '../src/tool-spill.js';

const dirs: string[] = [];
function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kriyadot-spill-oh1-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('compressToolResult', () => {
  it('shrinks a large repetitive result and preserves head/tail markers', () => {
    const head = 'HEAD-MARKER first line';
    const tail = 'TAIL-MARKER last line';
    const content = [head, ...Array.from({ length: 2000 }, () => 'same repeated log line'), tail].join('\n');
    const r = compressToolResult(content, { maxChars: 1000 });
    expect(r.compressed).toBe(true);
    expect(r.ratio).toBeLessThan(0.2);
    expect(r.text).toContain('HEAD-MARKER');
    expect(r.text).toContain('duplicate line(s) omitted');
    // Head+tail elision keeps the tail reachable when content is long and varied.
    const varied = Array.from({ length: 3000 }, (_, i) => `unique line ${i}`).join('\n');
    const r2 = compressToolResult(`${varied}\n${tail}`, { maxChars: 1000 });
    expect(r2.text).toContain('unique line 0');
    expect(r2.text).toContain('elided');
    expect(r2.text).toContain('TAIL-MARKER');
    expect(r2.text.length).toBeLessThanOrEqual(1100);
  });

  it('does key-preserving truncation for JSON', () => {
    const obj = { status: 'ok', items: Array.from({ length: 50 }, (_, i) => ({ id: i, blob: 'x'.repeat(500) })), note: 'y'.repeat(1000) };
    const r = compressToolResult(JSON.stringify(obj), { maxChars: 4000 });
    expect(r.text).toContain('"status"');
    expect(r.text).toContain('truncated');
    expect(r.compressedBytes).toBeLessThan(r.originalBytes);
  });
});

describe('handles: fetch_handle + search_handle', () => {
  it('spills with a compressed model payload and the full original under the handle', async () => {
    const store = new ToolSpillStore(makeDir(), 100, 10);
    const content = `alpha start\n${'filler line\n'.repeat(500)}NEEDLE-XYZ unique content\n${'more filler\n'.repeat(500)}omega end`;
    const ref = store.maybeSpill('big', content)!;
    expect(ref).not.toBeNull();
    expect(ref.compressed).toBeTruthy();
    expect(ref.compressionRatio!).toBeLessThan(1);
    const model = store.formatForModel('big', ref);
    expect(model).toContain('fetch_handle');
    expect(model).toContain('search_handle');
    expect(model).toContain(ref.id);

    const tools = createHandleTools(store);
    expect(tools.map((t) => t.name)).toEqual(['read_spilled_result', 'fetch_handle', 'search_handle']);
    const fetchTool = tools.find((t) => t.name === 'fetch_handle')!;
    const page = (await fetchTool.handler({ handle: ref.id, offset: 0, length: 50 }, undefined as never)) as { content: string };
    expect(page.content).toBe(content.slice(0, 50));

    const searchTool = tools.find((t) => t.name === 'search_handle')!;
    const found = (await searchTool.handler({ id: ref.id, query: 'NEEDLE-XYZ' }, undefined as never)) as {
      matches: Array<{ offset: number; excerpt: string }>; totalMatches: number;
    };
    expect(found.totalMatches).toBe(1);
    expect(found.matches[0]!.excerpt).toContain('NEEDLE-XYZ');
    expect(found.matches[0]!.offset).toBe(content.indexOf('NEEDLE-XYZ'));
    const rx = (await searchTool.handler({ id: ref.id, query: 'NEEDLE-[A-Z]+', regex: true }, undefined as never)) as { totalMatches: number };
    expect(rx.totalMatches).toBe(1);
    const missing = (await searchTool.handler({ id: 'spill_nope', query: 'x' }, undefined as never)) as { error?: string };
    expect(missing.error).toBeTruthy();
    // Back-compat: default createSpillTools still returns only the legacy tool.
    expect(createSpillTools(store).map((t) => t.name)).toEqual(['read_spilled_result']);
    expect(createSpillTools(store, { handleTools: true }).map((t) => t.name)).toEqual(['read_spilled_result', 'fetch_handle', 'search_handle']);
  });

  it('records original vs model-facing sizes via the metrics hook', () => {
    const seen: SpillMetrics[] = [];
    const store = new ToolSpillStore(makeDir(), 100, 10, { onMetrics: (m) => seen.push(m) });
    const ref = store.maybeSpill('big', 'z'.repeat(5000))!;
    expect(seen).toHaveLength(1);
    expect(seen[0]!.originalBytes).toBe(5000);
    expect(seen[0]!.modelBytes).toBe(Buffer.byteLength(ref.compressed!, 'utf8'));
    expect(seen[0]!.compressionRatio).toBeCloseTo(seen[0]!.modelBytes / 5000, 5);
    expect(seen[0]!.handleId).toBe(ref.id);
  });
});

describe('hygiene: TTL + size cap', () => {
  it('prune() evicts TTL-expired handles', () => {
    const dir = makeDir();
    let now = 1_000_000_000_000;
    const store = new ToolSpillStore(dir, 10, 1, { ttlMs: 1000, now: () => now });
    const ref = store.maybeSpill('t', 'a'.repeat(500))!;
    const path = join(dir, `${ref.id}.txt`);
    // Align file mtime with the fake clock, then advance past the TTL.
    utimesSync(path, new Date(now), new Date(now));
    now += 2000;
    const res = store.prune();
    expect(res.removed).toContain(ref.id);
    expect(existsSync(path)).toBe(false);
  });

  it('evicts oldest-first when over the total size cap', () => {
    const dir = makeDir();
    const store = new ToolSpillStore(dir, 10, 1, { maxTotalBytes: 1200, ttlMs: 10 ** 12 });
    const r1 = store.maybeSpill('t', 'a'.repeat(500))!;
    utimesSync(join(dir, `${r1.id}.txt`), new Date(Date.now() - 2000), new Date(Date.now() - 2000));
    const r2 = store.maybeSpill('t', 'b'.repeat(500))!;
    utimesSync(join(dir, `${r2.id}.txt`), new Date(Date.now() - 1000), new Date(Date.now() - 1000));
    const r3 = store.maybeSpill('t', 'c'.repeat(500))!;
    // Writing r3 pushed the store to 1500 > 1200 → oldest (r1) evicted on write.
    expect(existsSync(join(dir, `${r1.id}.txt`))).toBe(false);
    expect(existsSync(join(dir, `${r2.id}.txt`))).toBe(true);
    expect(existsSync(join(dir, `${r3.id}.txt`))).toBe(true);
  });
});

describe('verbatim bypass', () => {
  it('returns null (no spill, no compression) for verbatim results', () => {
    const store = new ToolSpillStore(makeDir(), 10, 1);
    expect(store.maybeSpill('approval_evidence', 'x'.repeat(100_000), { verbatim: true })).toBeNull();
    expect(store.maybeSpill('approval_evidence', 'x'.repeat(100_000))).not.toBeNull();
  });

  it('a precomputed summary is prepended when supplied', () => {
    const store = new ToolSpillStore(makeDir(), 10, 1);
    const ref = store.maybeSpill('t', 'q'.repeat(5000), { summary: 'SUMMARY: all q.' })!;
    expect(ref.compressed!.startsWith('SUMMARY: all q.')).toBe(true);
  });
});
