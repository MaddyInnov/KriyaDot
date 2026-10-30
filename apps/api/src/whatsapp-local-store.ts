// SPDX-License-Identifier: Apache-2.0
// Local WhatsApp desktop-store search (Muse parity audit §4.14, DV-10).
//
// Read-only search over the WhatsApp DESKTOP app's local store on the
// user's own computer (the Electron/Chromium profile: IndexedDB + Local
// Storage LevelDB directories). This is NOT the WhatsApp Cloud API
// (whatsapp-cloud.ts) and never sends anything anywhere.
//
// Honest mechanics: Chromium LevelDB keeps recent records as plain bytes
// in the write-ahead `.log` file, while compacted `.ldb`/`.sst` tables are
// Snappy-compressed — message text is recoverable from the former, often
// NOT from the latter. The scanner therefore extracts printable UTF-8
// string runs from the store files and matches the query against them,
// and every result names the file it came from plus a coverage note, so a
// miss is reported as "not found in the readable portion" — never as
// "the message does not exist".
//
// When no WhatsApp desktop store exists on this machine the tool returns a
// clean `available: false` (not an error): the honest unavailable state.
//
// Governance: chat content is deeply personal → require-approval.
// Read-only by construction: the scanner only ever reads files.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { BotPolicyRule, ToolContext, ToolDefinition } from '@mvp/agent-runtime';
import { PAUSED_MESSAGE } from './system-pause.js';

export function whatsappLocalPolicyRules(): BotPolicyRule[] {
  return [
    {
      id: 'whatsapp-local-approval',
      toolPattern: '^whatsapp_local_search$',
      effect: 'require-approval',
      reason:
        'Searching the user\'s local WhatsApp desktop store exposes private chat content; needs human approval. The search is read-only and stays on this machine.',
    },
  ];
}

// ---------------------------------------------------------------------------
// Store locations
// ---------------------------------------------------------------------------

/**
 * Candidate roots of the WhatsApp desktop app's Chromium profile, per
 * platform. Multiple candidates because packaging varies (Microsoft Store
 * app, direct Electron builds, the Linux community clients).
 */
export function whatsappStoreCandidates(platform: string, home: string, env: NodeJS.ProcessEnv = {}): string[] {
  switch (platform) {
    case 'win32': {
      const local = env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local');
      return [
        // Microsoft Store WhatsApp Desktop profile
        join(local, 'Packages', '5319275A.WhatsAppDesktop_cv1g1gvanyjgm', 'LocalState'),
        join(local, 'WhatsApp Desktop'),
      ];
    }
    case 'darwin':
      return [
        join(home, 'Library', 'Containers', 'net.whatsapp.WhatsApp', 'Data', 'Library', 'Application Support', 'WhatsApp Desktop'),
        join(home, 'Library', 'Application Support', 'WhatsApp Desktop'),
      ];
    case 'linux':
      return [
        join(home, '.config', 'WhatsApp'),
        join(home, 'snap', 'whatsapp-for-linux', 'current', '.config', 'whatsapp-for-linux'),
        join(home, '.var', 'app', 'io.github.mimbrero.WhatsAppDesktop', 'config', 'WhatsApp'),
      ];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Filesystem abstraction (mock fixtures in tests)
// ---------------------------------------------------------------------------

export interface StoreFs {
  exists(path: string): boolean;
  /** Recursively list files under dir (bounded); [] when unreadable. */
  walk(dir: string, maxFiles: number): string[];
  read(path: string): Buffer;
  size(path: string): number;
}

export const nodeStoreFs: StoreFs = {
  exists: (p) => existsSync(p),
  walk(dir, maxFiles) {
    const out: string[] = [];
    const stack = [dir];
    while (stack.length > 0 && out.length < maxFiles) {
      const cur = stack.pop() as string;
      let entries: string[];
      try { entries = readdirSync(cur); } catch { continue; }
      for (const e of entries) {
        const full = join(cur, e);
        let st;
        try { st = statSync(full); } catch { continue; }
        if (st.isDirectory()) stack.push(full);
        else if (st.isFile()) out.push(full);
        if (out.length >= maxFiles) break;
      }
    }
    return out;
  },
  read: (p) => readFileSync(p),
  size: (p) => statSync(p).size,
};

/** Subdirectories of a Chromium profile that hold message-bearing LevelDB data. */
const STORE_SUBDIRS = ['IndexedDB', 'Local Storage', 'Session Storage'];
/** File extensions that can carry recoverable plain-text records. */
const SCANNABLE_EXT = ['.log', '.ldb', '.sst', '.db'];
const MAX_FILES = 400;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

export interface WhatsappStoreDetection {
  available: boolean;
  /** Existing candidate roots (may hold no scannable files). */
  roots: string[];
  coverageNote: string;
}

const COVERAGE_NOTE =
  'Search covers printable text in the store\'s readable files (LevelDB write-ahead logs are plain; compacted tables are Snappy-compressed and may hide older messages). A miss means "not found in the readable portion", not "the message does not exist".';

export function detectWhatsappStore(
  fs: StoreFs,
  platform: string,
  home: string,
  env: NodeJS.ProcessEnv = {},
): WhatsappStoreDetection {
  const roots = whatsappStoreCandidates(platform, home, env).filter((r) => fs.exists(r));
  return { available: roots.length > 0, roots, coverageNote: COVERAGE_NOTE };
}

// ---------------------------------------------------------------------------
// String extraction + search
// ---------------------------------------------------------------------------

/**
 * Extract printable UTF-8 string runs (≥ minLen chars) from raw bytes.
 * Decodes lossily, then keeps runs of printable characters — LevelDB log
 * records embed message JSON with the text inline, so this recovers them.
 */
export function extractStrings(buf: Buffer, minLen = 4): Array<{ text: string; offset: number }> {
  const decoded = buf.toString('utf8');
  const out: Array<{ text: string; offset: number }> = [];
  let run = '';
  let runStart = 0;
  const flush = (end: number) => {
    if (run.length >= minLen) out.push({ text: run, offset: runStart });
    run = '';
    runStart = end;
  };
  for (let i = 0; i < decoded.length; i++) {
    const code = decoded.charCodeAt(i);
    // Printable: anything from space up, excluding DEL, C1 controls and the
    // U+FFFD replacement char produced by lossy decoding of binary bytes.
    const printable = code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f) && code !== 0xfffd;
    if (printable) {
      if (run.length === 0) runStart = i;
      run += decoded[i];
    } else {
      flush(i);
    }
  }
  flush(decoded.length);
  return out;
}

export interface WhatsappSearchHit {
  file: string;
  snippet: string;
  offset: number;
}

export interface WhatsappSearchResult {
  available: boolean;
  query: string;
  hits: WhatsappSearchHit[];
  filesScanned: number;
  bytesScanned: number;
  truncated: boolean;
  coverageNote: string;
}

export interface WhatsappLocalSearchDeps {
  fs?: StoreFs;
  platform?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
}

const SNIPPET_RADIUS = 90;

export class WhatsappLocalStoreSearch {
  private readonly fs: StoreFs;
  private readonly platform: string;
  private readonly home: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(deps: WhatsappLocalSearchDeps = {}) {
    this.fs = deps.fs ?? nodeStoreFs;
    this.platform = deps.platform ?? process.platform;
    this.home = deps.home ?? process.env['HOME'] ?? '';
    this.env = deps.env ?? process.env;
  }

  detect(): WhatsappStoreDetection {
    return detectWhatsappStore(this.fs, this.platform, this.home, this.env);
  }

  search(query: string, limit = 25): WhatsappSearchResult {
    const q = query.trim();
    if (!q) throw new Error('"query" is required (non-empty)');
    const det = this.detect();
    const base: WhatsappSearchResult = {
      available: det.available, query: q, hits: [], filesScanned: 0, bytesScanned: 0,
      truncated: false, coverageNote: det.coverageNote,
    };
    if (!det.available) return base;
    const needle = q.toLowerCase();
    let bytes = 0;
    outer: for (const root of det.roots) {
      const scanRoots = STORE_SUBDIRS.map((s) => join(root, s)).filter((s) => this.fs.exists(s));
      const files = this.fs.walk(root, MAX_FILES)
        .filter((f) => SCANNABLE_EXT.some((ext) => f.toLowerCase().endsWith(ext)))
        .filter((f) => scanRoots.length === 0 || scanRoots.some((s) => f.startsWith(s)) || f.toLowerCase().endsWith('.db'));
      for (const file of files) {
        if (base.hits.length >= limit || bytes >= MAX_TOTAL_BYTES) { base.truncated = true; break outer; }
        let size = 0;
        try { size = this.fs.size(file); } catch { continue; }
        if (size <= 0 || size > MAX_FILE_BYTES) continue;
        let buf: Buffer;
        try { buf = this.fs.read(file); } catch { continue; }
        base.filesScanned += 1;
        bytes += buf.length;
        for (const s of extractStrings(buf)) {
          const idx = s.text.toLowerCase().indexOf(needle);
          if (idx === -1) continue;
          const start = Math.max(0, idx - SNIPPET_RADIUS);
          const end = Math.min(s.text.length, idx + q.length + SNIPPET_RADIUS);
          base.hits.push({
            file,
            snippet: (start > 0 ? '…' : '') + s.text.slice(start, end) + (end < s.text.length ? '…' : ''),
            offset: s.offset + idx,
          });
          if (base.hits.length >= limit) break;
        }
      }
    }
    base.bytesScanned = bytes;
    return base;
  }
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export interface WhatsappLocalToolDeps {
  search: WhatsappLocalStoreSearch;
  audit?: (action: string, fields: { actor?: string; toolName?: string; detail?: unknown; sessionId?: string }) => void;
  isPaused?: () => boolean;
}

export function createWhatsappLocalTools(deps: WhatsappLocalToolDeps): ToolDefinition[] {
  return [
    {
      name: 'whatsapp_local_search',
      description:
        'Search the user\'s LOCAL WhatsApp desktop app store (read-only, on this machine) for message text. Returns an honest unavailable result when no desktop store exists here, and a coverage note on every result. Requires human approval.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text to search for in stored messages' },
          limit: { type: 'number', description: 'Max hits (1-100, default 25)' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      handler: async (args, ctx: ToolContext) => {
        if (deps.isPaused?.()) throw new Error(`paused: ${PAUSED_MESSAGE}`);
        const query = args['query'];
        if (typeof query !== 'string' || !query.trim() || query.length > 200) {
          throw new Error('"query" is required (non-empty string, max 200 chars)');
        }
        const limitRaw = args['limit'];
        const limit = typeof limitRaw === 'number' && Number.isFinite(limitRaw)
          ? Math.max(1, Math.min(100, Math.floor(limitRaw)))
          : 25;
        const result = deps.search.search(query, limit);
        try {
          // Audit metadata only — never the matched chat content.
          deps.audit?.('whatsapp.local_search', {
            actor: ctx.botId, toolName: 'whatsapp_local_search', sessionId: ctx.sessionId,
            detail: { available: result.available, hits: result.hits.length, filesScanned: result.filesScanned },
          });
        } catch { /* audit must never break the tool */ }
        return result;
      },
    } satisfies ToolDefinition,
  ];
}

export function registerWhatsappLocalTools(registry: Map<string, ToolDefinition>, deps: WhatsappLocalToolDeps): void {
  for (const tool of createWhatsappLocalTools(deps)) {
    if (!registry.has(tool.name)) registry.set(tool.name, tool);
  }
}
