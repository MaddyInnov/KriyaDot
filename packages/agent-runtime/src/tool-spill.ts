// SPDX-License-Identifier: Apache-2.0
/**
 * Tool-result spill: oversized tool results are written to the bot
 * workspace spill dir; the model receives a truncated preview plus a
 * spill reference it can page through with read_spilled_result.
 *
 * OH-1 (OpenHuman adoption): before the model-facing payload is built,
 * the result passes a deterministic, local, no-model compression stage
 * (dedupe repeated lines, collapse whitespace runs, JSON key-preserving
 * truncation, head+tail elision). The FULL original is stored under the
 * spill handle; the model gets the compressed payload + handle id +
 * fetch_handle / search_handle instructions. Governance-verbatim
 * results (see MaybeSpillOptions.verbatim) bypass compression AND
 * spill entirely. Per-bot hygiene: TTL + total-size cap with
 * oldest-first eviction, enforced lazily on write and via prune().
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolDefinition } from './types.js';
export const DEFAULT_SPILL_THRESHOLD_BYTES = 32 * 1024;
/**
 * Token-based spill threshold (Octomind parity #59): what the model can
 * actually hold is measured in tokens, not bytes. The estimator matches
 * the codebase convention (chars / 4, see sessions.ts). The byte cap
 * above remains as a hard storage ceiling; a result spills when EITHER
 * threshold is exceeded.
 */
export const DEFAULT_SPILL_THRESHOLD_TOKENS = 8_000;
export const DEFAULT_SPILL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_SPILL_MAX_TOTAL_BYTES = 25 * 1024 * 1024;
export const DEFAULT_COMPRESSION_MAX_CHARS = 4_000;
export function estimateSpillTokens(content: string): number {
  return Math.ceil(content.length / 4);
}

// ---------------------------------------------------------------------------
// Deterministic local compression (no model call, no randomness)
// ---------------------------------------------------------------------------

export interface CompressionResult {
  text: string;
  originalBytes: number;
  compressedBytes: number;
  /** compressedBytes / originalBytes (1 = no shrink). */
  ratio: number;
  compressed: boolean;
}

function truncateJsonValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') {
    return value.length > 200 ? `${value.slice(0, 200)}…[truncated ${value.length - 200} chars]` : value;
  }
  if (Array.isArray(value)) {
    if (depth > 4) return `[…${value.length} items]`;
    if (value.length <= 4) return value.map((v) => truncateJsonValue(v, depth + 1));
    return [
      ...value.slice(0, 3).map((v) => truncateJsonValue(v, depth + 1)),
      `…[${value.length - 4} items elided]`,
      truncateJsonValue(value[value.length - 1], depth + 1),
    ];
  }
  if (value !== null && typeof value === 'object') {
    if (depth > 4) return '{…}';
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = truncateJsonValue(v, depth + 1);
    return out;
  }
  return value;
}

function headTailElide(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const headLen = Math.floor(maxChars * 0.6);
  const tailLen = Math.max(0, maxChars - headLen);
  const elided = text.length - headLen - tailLen;
  return `${text.slice(0, headLen)}\n…[elided ${elided} chars]…\n${text.slice(text.length - tailLen)}`;
}

/**
 * Structural/extractive compression, deterministic and local:
 *  - JSON: parsed and re-serialized with keys preserved, long string
 *    values truncated, long arrays head/tail sampled.
 *  - Text: trailing whitespace trimmed, 3+ blank lines collapse to one,
 *    repeated non-empty lines deduped (first occurrence kept, later
 *    repeats replaced by one omission marker per run of repeats).
 *  - Anything still over `maxChars` gets head+tail elision with a marker.
 */
export function compressToolResult(content: string, opts: { maxChars?: number } = {}): CompressionResult {
  const maxChars = Math.max(200, opts.maxChars ?? DEFAULT_COMPRESSION_MAX_CHARS);
  const originalBytes = Buffer.byteLength(content, 'utf8');
  let text = content;
  const trimmed = content.trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      text = JSON.stringify(truncateJsonValue(JSON.parse(trimmed), 0), null, 1);
    } catch { /* not JSON after all — fall through to text path */ }
  }
  if (text === content) {
    const lines = content.split('\n').map((l) => l.replace(/[ \t]+$/g, ''));
    const seen = new Map<string, number>();
    const out: string[] = [];
    let blankRun = 0;
    let dupRun = 0;
    const flushDup = () => { if (dupRun > 0) { out.push(`[… duplicate line(s) omitted ×${dupRun}]`); dupRun = 0; } };
    for (const line of lines) {
      if (line.trim() === '') {
        flushDup();
        blankRun += 1;
        if (blankRun <= 1) out.push(line);
        continue;
      }
      blankRun = 0;
      const count = seen.get(line) ?? 0;
      seen.set(line, count + 1);
      if (count > 0) { dupRun += 1; continue; }
      flushDup();
      out.push(line);
    }
    flushDup();
    text = out.join('\n');
  }
  text = headTailElide(text, maxChars);
  const compressedBytes = Buffer.byteLength(text, 'utf8');
  return {
    text,
    originalBytes,
    compressedBytes,
    ratio: originalBytes > 0 ? compressedBytes / originalBytes : 1,
    compressed: compressedBytes < originalBytes,
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface SpillRef {
  id: string;
  path: string;
  bytes: number;
  preview: string;
  /** OH-1: compressed model-facing payload (falls back to preview). */
  compressed?: string;
  originalBytes?: number;
  modelBytes?: number;
  compressionRatio?: number;
}

export interface SpillMetrics {
  toolName: string;
  handleId: string;
  originalBytes: number;
  modelBytes: number;
  compressionRatio: number;
}

export interface MaybeSpillOptions {
  /** Governance-verbatim: bypass compression AND spill (model gets full text). */
  verbatim?: boolean;
  /** Precomputed optional model summary, prepended to the compressed payload. Never fetched by the store. */
  summary?: string;
  onMetrics?: (m: SpillMetrics) => void;
}

export interface ToolSpillStoreOptions {
  ttlMs?: number;
  maxTotalBytes?: number;
  compressionMaxChars?: number;
  now?: () => number;
  onMetrics?: (m: SpillMetrics) => void;
}

export interface SearchHandleMatch { offset: number; excerpt: string; }
export interface SearchHandleResult { matches: SearchHandleMatch[]; totalMatches: number; totalBytes: number; }

let seq = 0;
/** Pack B: bound for the in-memory spill-content cache (see loadContent). */
export const SPILL_CONTENT_CACHE_MAX_BYTES = 32 * 1024 * 1024;

export class ToolSpillStore {
  private readonly ttlMs: number;
  private readonly maxTotalBytes: number;
  private readonly compressionMaxChars: number;
  private readonly nowFn: () => number;
  private readonly metricsHook?: (m: SpillMetrics) => void;
  /**
   * Pack B footprint/speed: spill files are write-once per id, so their
   * decoded content is safe to cache. Paging through one large handle
   * (fetch_handle) or searching it repeatedly otherwise re-reads and
   * re-decodes the whole file on every call. LRU-bounded by total bytes;
   * prune() evicts removed ids.
   */
  private readonly contentCache = new Map<string, { content: string; bytes: number }>();
  private contentCacheBytes = 0;

  private loadContent(id: string, path: string): string | null {
    const hit = this.contentCache.get(id);
    if (hit) {
      // Refresh LRU position.
      this.contentCache.delete(id);
      this.contentCache.set(id, hit);
      return hit.content;
    }
    if (!existsSync(path)) return null;
    const content = readFileSync(path, 'utf8');
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes <= SPILL_CONTENT_CACHE_MAX_BYTES) {
      this.contentCache.set(id, { content, bytes });
      this.contentCacheBytes += bytes;
      while (this.contentCacheBytes > SPILL_CONTENT_CACHE_MAX_BYTES) {
        const oldest = this.contentCache.keys().next().value as string | undefined;
        if (oldest === undefined || oldest === id) break;
        const evicted = this.contentCache.get(oldest)!;
        this.contentCache.delete(oldest);
        this.contentCacheBytes -= evicted.bytes;
      }
    }
    return content;
  }

  private dropCached(id: string): void {
    const hit = this.contentCache.get(id);
    if (hit) {
      this.contentCache.delete(id);
      this.contentCacheBytes -= hit.bytes;
    }
  }
  constructor(
    private readonly dir: string,
    readonly thresholdBytes = DEFAULT_SPILL_THRESHOLD_BYTES,
    readonly thresholdTokens = DEFAULT_SPILL_THRESHOLD_TOKENS,
    opts: ToolSpillStoreOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_SPILL_TTL_MS;
    this.maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_SPILL_MAX_TOTAL_BYTES;
    this.compressionMaxChars = opts.compressionMaxChars ?? DEFAULT_COMPRESSION_MAX_CHARS;
    this.nowFn = opts.now ?? (() => Date.now());
    this.metricsHook = opts.onMetrics;
  }
  get spillDir(): string { return this.dir; }

  maybeSpill(toolName: string, content: string, opts: MaybeSpillOptions = {}): SpillRef | null {
    if (opts.verbatim) return null;
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes <= this.thresholdBytes && estimateSpillTokens(content) <= this.thresholdTokens) return null;
    mkdirSync(this.dir, { recursive: true });
    const id = `spill_${Date.now().toString(36)}_${++seq}`;
    const path = join(this.dir, `${id}.txt`);
    writeFileSync(path, content, 'utf8');
    const comp = compressToolResult(content, { maxChars: this.compressionMaxChars });
    const compressed = opts.summary ? `${opts.summary}\n${comp.text}` : comp.text;
    const modelBytes = Buffer.byteLength(compressed, 'utf8');
    const ref: SpillRef = {
      id, path, bytes,
      preview: content.slice(0, 2000),
      compressed,
      originalBytes: bytes,
      modelBytes,
      compressionRatio: bytes > 0 ? modelBytes / bytes : 1,
    };
    try {
      const m: SpillMetrics = { toolName, handleId: id, originalBytes: bytes, modelBytes, compressionRatio: ref.compressionRatio! };
      this.metricsHook?.(m);
      opts.onMetrics?.(m);
    } catch { /* metrics must never break a turn */ }
    try { this.prune({ keepId: id }); } catch { /* hygiene is best-effort */ }
    return ref;
  }

  /** Delete TTL-expired handles, then evict oldest-first until under the size cap. */
  prune(opts: { keepId?: string } = {}): { removed: string[]; bytesFreed: number } {
    const removed: string[] = [];
    let bytesFreed = 0;
    if (!existsSync(this.dir)) return { removed, bytesFreed };
    const now = this.nowFn();
    const entries: Array<{ id: string; path: string; size: number; mtimeMs: number }> = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.txt')) continue;
      const p = join(this.dir, name);
      try {
        const st = statSync(p);
        entries.push({ id: name.slice(0, -4), path: p, size: st.size, mtimeMs: st.mtimeMs });
      } catch { /* race — skip */ }
    }
    const drop = (e: { id: string; path: string; size: number }) => {
      this.dropCached(e.id);
      try { unlinkSync(e.path); removed.push(e.id); bytesFreed += e.size; } catch { /* already gone */ }
    };
    const survivors: typeof entries = [];
    for (const e of entries) {
      if (e.id !== opts.keepId && now - e.mtimeMs > this.ttlMs) drop(e);
      else survivors.push(e);
    }
    let total = survivors.reduce((a, e) => a + e.size, 0);
    if (total > this.maxTotalBytes) {
      survivors.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.id < b.id ? -1 : 1));
      for (const e of survivors) {
        if (total <= this.maxTotalBytes) break;
        if (e.id === opts.keepId) continue;
        drop(e);
        total -= e.size;
      }
    }
    return { removed, bytesFreed };
  }

  read(id: string, offset = 0, length = 8000): { content: string; totalBytes: number; offset: number; nextOffset: number | null } | null {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) return null;
    const path = join(this.dir, `${id}.txt`);
    const full = this.loadContent(id, path);
    if (full === null) return null;
    const slice = full.slice(Math.max(0,offset), Math.max(0,offset)+Math.max(1,length));
    const next = offset + slice.length < full.length ? offset + slice.length : null;
    return { content: slice, totalBytes: Buffer.byteLength(full,'utf8'), offset, nextOffset: next };
  }

  /** Substring (default) or regex-lite search within a stored handle. */
  search(id: string, query: string, opts: { regex?: boolean; contextChars?: number; maxResults?: number } = {}): SearchHandleResult | null {
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || !query) return null;
    const path = join(this.dir, `${id}.txt`);
    const full = this.loadContent(id, path);
    if (full === null) return null;
    const ctx = Math.max(0, opts.contextChars ?? 120);
    const max = Math.max(1, opts.maxResults ?? 20);
    const offsets: Array<{ offset: number; len: number }> = [];
    if (opts.regex) {
      let re: RegExp;
      try { re = new RegExp(query, 'gi'); } catch { return { matches: [], totalMatches: 0, totalBytes: Buffer.byteLength(full, 'utf8') }; }
      let m: RegExpExecArray | null;
      while ((m = re.exec(full)) !== null) {
        offsets.push({ offset: m.index, len: Math.max(1, m[0].length) });
        if (m[0].length === 0) re.lastIndex += 1;
        if (offsets.length > 10_000) break;
      }
    } else {
      const hay = full.toLowerCase();
      const needle = query.toLowerCase();
      let from = 0;
      for (;;) {
        const idx = hay.indexOf(needle, from);
        if (idx < 0) break;
        offsets.push({ offset: idx, len: needle.length });
        from = idx + Math.max(1, needle.length);
        if (offsets.length > 10_000) break;
      }
    }
    const matches = offsets.slice(0, max).map(({ offset, len }) => ({
      offset,
      excerpt: full.slice(Math.max(0, offset - ctx), Math.min(full.length, offset + len + ctx)),
    }));
    return { matches, totalMatches: offsets.length, totalBytes: Buffer.byteLength(full, 'utf8') };
  }

  formatForModel(toolName: string, ref: SpillRef): string {
    const payload = ref.compressed ?? ref.preview;
    const ratioNote = ref.compressionRatio !== undefined ? `, compression ratio ${ref.compressionRatio.toFixed(3)} (model-facing/original)` : '';
    return `[tool result too large (${ref.bytes} bytes) — compressed + spilled to workspace${ratioNote}]\nHandle: ${ref.id} (tool: ${toolName})\nCompressed result:\n${payload}\n[use fetch_handle with id="${ref.id}" to page the FULL original, search_handle with id="${ref.id}" and a query to find excerpts, or read_spilled_result with id="${ref.id}" (legacy alias)]`;
  }
}

function readTool(store: ToolSpillStore, name: string): ToolDefinition {
  return {
    name, description: 'Read a chunk of a spilled (oversized) tool result by its spill reference / handle id.',
    parameters: { type:'object', properties:{ id:{type:'string'}, handle:{type:'string'}, offset:{type:'number'}, length:{type:'number'} }, required:[] },
    handler: async (args) => {
      const id = typeof args.id==='string' ? args.id : typeof args.handle==='string' ? args.handle : '';
      const r = store.read(id, typeof args.offset==='number'?args.offset:0, typeof args.length==='number'?args.length:8000);
      return r ?? { error: 'spilled result not found' };
    },
  };
}

export function createHandleTools(store: ToolSpillStore): ToolDefinition[] {
  return [
    readTool(store, 'read_spilled_result'),
    readTool(store, 'fetch_handle'),
    {
      name: 'search_handle', description: 'Search within a stored spill handle (substring, or regex when regex=true) and return matching excerpts with offsets.',
      parameters: { type:'object', properties:{ id:{type:'string'}, handle:{type:'string'}, query:{type:'string'}, regex:{type:'boolean'}, maxResults:{type:'number'} }, required:['query'] },
      handler: async (args) => {
        const id = typeof args.id==='string' ? args.id : typeof args.handle==='string' ? args.handle : '';
        const q = typeof args.query==='string' ? args.query : '';
        const r = store.search(id, q, { regex: args.regex===true, maxResults: typeof args.maxResults==='number'?args.maxResults:20 });
        return r ?? { error: 'spilled result not found' };
      },
    },
  ];
}

export function createSpillTools(store: ToolSpillStore, opts: { handleTools?: boolean } = {}): ToolDefinition[] {
  if (opts.handleTools) return createHandleTools(store);
  return [readTool(store, 'read_spilled_result')];
}
