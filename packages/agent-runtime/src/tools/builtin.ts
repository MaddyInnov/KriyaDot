// SPDX-License-Identifier: Apache-2.0

import { execFile } from 'node:child_process';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { ToolContext, ToolDefinition } from '../types.js';
import type { ButtonsWidgetPayload, WidgetAnswer, WidgetHost } from '../widgets.js';
import { validateWidgetPayload } from '../widgets.js';
import { executeInPersistentSandbox, executeSandboxedCommand, sandboxBackend } from './sandbox.js';
import { resolveWorkspaceDir, type WorkspaceSource } from '../workspaces.js';
// Shared catastrophic-shell detection (M1): the governance hard floor's
// rm flag-cluster expansion, reused here so the tool-level denylist and the
// CLI kill-switch catch `rm -rfv /etc`, `rm -rf --one-file-system /`, etc.
import { catastrophicRmTarget } from '@mvp/governance';
import { confineRealpath } from '../confine.js';

const execFileAsync = promisify(execFile);

const MAX_OUTPUT_BYTES = 8 * 1024; // 8KB truncation for command output
const MAX_FETCH_BYTES = 200 * 1024; // 200KB cap for web_fetch
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

/**
 * Refuse obviously destructive shell patterns before they run.
 *
 * This is the tool-level hard floor (defense in depth alongside the
 * governance gateway): catastrophic commands are refused UNCONDITIONALLY —
 * a human approval can never lift this. Merely destructive-but-recoverable
 * commands (deleting a specific project file, etc.) are not denylisted here;
 * they go through the governance approval path instead.
 */
const COMMAND_DENYLIST: RegExp[] = [
  // `rm -rf /` and its flag variants are covered by catastrophicRmTarget()
  // (shared with the governance hard floor) — see isCatastrophicCommand.
  /mkfs/, // filesystem formatting
  /\bdd\b[^;&|]*\bof=\s*\/dev\//, // dd writing to a raw block device
  /\b(shred|wipefs|fdisk|sfdisk|gdisk|sgdisk|cgdisk|parted)\b/, // disk wipe/partition tools
  /:\(\)\s*\{/, // fork bombs
];

function truncate(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  const buf = Buffer.from(s, 'utf8').subarray(0, maxBytes);
  return buf.toString('utf8') + `\n…[truncated to ${maxBytes} bytes]`;
}

/**
 * True when `text` (a shell command, or JSON containing one) matches the
 * catastrophic-command denylist. Exported for the native CLI driver's
 * kill-switch: the same hard floor applies to CLI-observed tool calls, and
 * a human approval can never lift it.
 */
export function isCatastrophicCommand(text: string): boolean {
  // Shared rm detection (M1): catches `rm -rf /` plus flag variants like
  // `rm -rfv /etc`, `rm -rf --one-file-system /`, `rm --recursive --force /`.
  if (catastrophicRmTarget(text) !== null) return true;
  return COMMAND_DENYLIST.some((pattern) => pattern.test(text));
}

/**
 * Resolve `p` inside `workspaceDir`, following symlinks (M3). Throws if the
 * real path escapes the workspace — a symlink pointing outside is rejected,
 * while symlinks staying inside are allowed.
 */
function confine(workspaceDir: string, p: string): string {
  return confineRealpath(workspaceDir, p);
}

function readFileTool(workspaceDir: WorkspaceSource): ToolDefinition {
  return {
    name: 'read_file',
    description: 'Read a UTF-8 text file inside the workspace. Path is relative to the workspace root.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Workspace-relative file path' } },
      required: ['path'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const file = confine(resolveWorkspaceDir(workspaceDir, ctx), String(args.path));
      return readFileSync(file, 'utf8');
    },
  };
}

function writeFileTool(workspaceDir: WorkspaceSource): ToolDefinition {
  return {
    name: 'write_file',
    mutating: true,
    description: 'Write (or overwrite) a UTF-8 text file inside the workspace. Parent directories are created.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path' },
        content: { type: 'string', description: 'File content' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const file = confine(resolveWorkspaceDir(workspaceDir, ctx), String(args.path));
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, String(args.content), 'utf8');
      return { written: file, bytes: Buffer.byteLength(String(args.content), 'utf8') };
    },
  };
}

function runCommandTool(workspaceDir: WorkspaceSource): ToolDefinition {
  return {
    name: 'run_command',
    mutating: true,
    description:
      'Run a shell command (sh -c). Destructive patterns are refused. ' +
      'Executes inside an E2B cloud sandbox when E2B_API_KEY is set, else a local Docker container ' +
      '(isolated: no workspace files, no network by default); ' +
      'falls back to host execution with the workspace as cwd only when no sandbox backend is available ' +
      '(result carries sandboxed:false). ' +
      'Stdout/stderr are truncated to 8KB.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run' },
        timeoutMs: { type: 'number', description: 'Timeout in ms (default 30000)' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const command = String(args.command);
      if (isCatastrophicCommand(command)) {
        throw new Error(`Refused by command denylist: "${command.slice(0, 120)}"`);
      }
      const timeoutMs =
        typeof args.timeoutMs === 'number' && args.timeoutMs > 0
          ? Math.min(args.timeoutMs, 120_000)
          : DEFAULT_COMMAND_TIMEOUT_MS;
      // Persistent Dot environment: run inside the Dot's own long-lived E2B
      // sandbox instead of a fresh ephemeral one. Falls back to ephemeral on
      // connect failure (the sandbox may have expired).
      const persistentId = ctx?.persistentSandboxId;
      if (persistentId && sandboxBackend() === 'e2b') {
        try {
          const result = await executeInPersistentSandbox(persistentId, command, {
            timeoutMs,
            maxOutputBytes: MAX_OUTPUT_BYTES * 4,
          });
          return {
            exitCode: result.exitCode,
            timedOut: result.timedOut ?? false,
            stdout: truncate(result.stdout, MAX_OUTPUT_BYTES),
            stderr: truncate(result.stderr, MAX_OUTPUT_BYTES),
            sandboxed: true,
            backend: 'e2b-persistent',
          };
        } catch (err) {
          // Persistent sandbox gone (expired/killed) — fall through to
          // ephemeral rather than failing the turn.
          console.warn(`[run_command] persistent sandbox ${persistentId} unreachable, using ephemeral: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // Phase 3: prefer the sandboxed backend (E2B cloud, else Docker).
      // Host execution remains only as a last resort so the tool keeps
      // working on machines with neither; the result is flagged.
      if (sandboxBackend() !== 'none') {
        const result = await executeSandboxedCommand(command, {
          timeoutMs,
          maxOutputBytes: MAX_OUTPUT_BYTES * 4,
        });
        return {
          exitCode: result.exitCode,
          timedOut: result.timedOut ?? false,
          stdout: truncate(result.stdout, MAX_OUTPUT_BYTES),
          stderr: truncate(result.stderr, MAX_OUTPUT_BYTES),
          sandboxed: true,
          backend: sandboxBackend(),
        };
      }
      try {
        const { stdout, stderr } = await execFileAsync('sh', ['-c', command], {
          cwd: resolveWorkspaceDir(workspaceDir, ctx),
          timeout: timeoutMs,
          maxBuffer: MAX_OUTPUT_BYTES * 4,
          windowsHide: true,
        });
        return {
          exitCode: 0,
          stdout: truncate(stdout, MAX_OUTPUT_BYTES),
          stderr: truncate(stderr, MAX_OUTPUT_BYTES),
          sandboxed: false,
        };
      } catch (err) {
        const e = err as {
          stdout?: string;
          stderr?: string;
          code?: number | string;
          killed?: boolean;
          message: string;
        };
        if (e.killed) {
          return {
            exitCode: 124,
            timedOut: true,
            stdout: truncate(e.stdout ?? '', MAX_OUTPUT_BYTES),
            stderr: truncate(e.stderr ?? '', MAX_OUTPUT_BYTES),
            sandboxed: false,
          };
        }
        return {
          exitCode: typeof e.code === 'number' ? e.code : 1,
          stdout: truncate(e.stdout ?? '', MAX_OUTPUT_BYTES),
          stderr: truncate(e.stderr ?? e.message ?? '', MAX_OUTPUT_BYTES),
          sandboxed: false,
        };
      }
    },
  };
}

function webSearchTool(): ToolDefinition {
  return {
    name: 'web_search',
    description: 'Search the web via the DuckDuckGo instant-answer API. Returns the abstract plus top related topics.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search query' } },
      required: ['query'],
      additionalProperties: false,
    },
    handler: async (args, _ctx: ToolContext) => {
      const url =
        `https://api.duckduckgo.com/?q=${encodeURIComponent(String(args.query))}` +
        `&format=json&no_html=1&skip_disambig=1`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`DuckDuckGo search failed: HTTP ${res.status}`);
      const data = (await res.json()) as {
        AbstractText?: string;
        AbstractURL?: string;
        RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
      };
      return {
        abstract: data.AbstractText ?? '',
        source: data.AbstractURL ?? '',
        topics: (data.RelatedTopics ?? [])
          .filter((t) => t.Text)
          .slice(0, 5)
          .map((t) => ({ text: t.Text, url: t.FirstURL })),
      };
    },
  };
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// web_fetch SSRF gate (M2)
// ---------------------------------------------------------------------------

const FETCH_MAX_REDIRECTS = 5;
const DNS_LOOKUP_TIMEOUT_MS = 3_000;

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const v = Number(p);
    if (v < 0 || v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

function inCidr(n: number, base: string, bits: number): boolean {
  const b = ipv4ToInt(base);
  if (b === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (n & mask) === (b & mask);
}

/**
 * True when the IP must never be fetched: loopback, private (RFC 1918),
 * link-local (cloud metadata lives at 169.254.169.254), multicast, or the
 * 0.0.0.0/8 "this network" range — plus the IPv6 equivalents.
 */
export function isBlockedFetchIp(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower.includes(':')) {
    // IPv4-mapped IPv6 (::ffff:1.2.3.4) — judge the embedded IPv4 address.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isBlockedFetchIp(mapped[1]);
    const hex = lower.replace(/:/g, '');
    return (
      lower === '::1' || // loopback
      lower === '::' || // unspecified
      lower.startsWith('ff') || // multicast ff00::/8
      /^fe[89ab]/i.test(hex.slice(0, 4)) || // link-local fe80::/10
      /^(fc|fd)/i.test(hex.slice(0, 2)) // unique-local fc00::/7
    );
  }
  const n = ipv4ToInt(lower);
  if (n === null) return true; // unparseable → fail closed
  return (
    inCidr(n, '127.0.0.0', 8) ||
    inCidr(n, '10.0.0.0', 8) ||
    inCidr(n, '172.16.0.0', 12) ||
    inCidr(n, '192.168.0.0', 16) ||
    inCidr(n, '169.254.0.0', 16) ||
    inCidr(n, '0.0.0.0', 8) ||
    inCidr(n, '224.0.0.0', 4) ||
    n === 0xffffffff
  );
}

function lookupAllWithTimeout(host: string, timeoutMs = DNS_LOOKUP_TIMEOUT_MS): Promise<LookupAddress[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`DNS lookup timed out for "${host}"`)), timeoutMs);
    timer.unref?.();
    dnsLookup(host, { all: true }, (err, addresses) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(addresses);
    });
  });
}

/**
 * Validate a fetch URL against SSRF: http(s) only, hostname must resolve
 * (all records — DNS rebinding with one private record is rejected) to
 * public IPs, literal IPs are checked without DNS.
 */
export async function assertPublicFetchUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: "${raw.slice(0, 120)}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Only http(s) URLs may be fetched: "${raw.slice(0, 120)}"`);
  }
  const host = url.hostname;
  if (!host) throw new Error(`URL has no hostname: "${raw.slice(0, 120)}"`);
  let addresses: string[];
  if (ipv4ToInt(host) !== null || host.includes(':')) {
    addresses = [host]; // literal IP — no DNS needed
  } else {
    let records: LookupAddress[];
    try {
      records = await lookupAllWithTimeout(host);
    } catch (err) {
      throw new Error(`DNS lookup failed for "${host}": ${err instanceof Error ? err.message : String(err)}`);
    }
    addresses = records.map((r) => r.address);
    if (addresses.length === 0) throw new Error(`No DNS records for "${host}"`);
  }
  for (const ip of addresses) {
    if (isBlockedFetchIp(ip)) {
      throw new Error(`Refusing to fetch non-public address for "${host}"`);
    }
  }
  return url;
}

function webFetchTool(): ToolDefinition {
  return {
    name: 'web_fetch',
    description: 'Fetch a URL and return its text content (HTML stripped, capped at 200KB).',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'URL to fetch' } },
      required: ['url'],
      additionalProperties: false,
    },
    handler: async (args, _ctx: ToolContext) => {
      const url = String(args.url);
      // SSRF gate + manual redirect following: every hop is re-validated so
      // a public URL cannot redirect into loopback/private/metadata IPs.
      let current = url;
      let res: Response | null = null;
      for (let hop = 0; hop <= FETCH_MAX_REDIRECTS; hop++) {
        const target = await assertPublicFetchUrl(current);
        const attempt = await fetch(target.toString(), {
          redirect: 'manual',
          signal: AbortSignal.timeout(20_000),
          headers: { 'User-Agent': 'mvp-agent-runtime/0.1.0' },
        });
        const location = attempt.headers.get('location');
        if (attempt.status >= 300 && attempt.status < 400 && location) {
          if (hop === FETCH_MAX_REDIRECTS) throw new Error(`Too many redirects fetching ${url}`);
          await attempt.arrayBuffer().catch(() => undefined); // drain before next hop
          current = new URL(location, target).toString();
          continue;
        }
        res = attempt;
        break;
      }
      if (!res) throw new Error(`Fetch failed for ${url}`);
      if (!res.ok) throw new Error(`Fetch failed: HTTP ${res.status} for ${url}`);
      const reader = res.body?.getReader();
      if (!reader) throw new Error('Empty response body');
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.length;
        if (total >= MAX_FETCH_BYTES) break;
      }
      const html = Buffer.concat(chunks).subarray(0, MAX_FETCH_BYTES).toString('utf8');
      const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim();
      return { url, title: title ?? '', text: stripHtml(html) };
    },
  };
}

/** Built-in tools available to every bot: file I/O, shell, web, and interactive questions. */
export function createBuiltInTools(opts: { workspaceDir: WorkspaceSource }): ToolDefinition[] {
  const { workspaceDir } = opts;
  return [
    readFileTool(workspaceDir),
    writeFileTool(workspaceDir),
    runCommandTool(workspaceDir),
    webSearchTool(),
    webFetchTool(),
    askUserQuestionTool(),
  ];
}

// ---------------------------------------------------------------------------
// ask_user_question (OpenMausBot parity P1 #15)
// ---------------------------------------------------------------------------

const ASK_QUESTION_TIMEOUT_DEFAULT_MIN = 15;
const ASK_QUESTION_TIMEOUT_MIN = 1;
const ASK_QUESTION_TIMEOUT_MAX = 60;

interface AskQuestionOptionInput {
  id?: string;
  label: string;
  description?: string;
}

interface AskQuestionInput {
  question: string;
  options?: AskQuestionOptionInput[];
  multiSelect?: boolean;
  allowFreeText?: boolean;
}

const askQuestionOptionSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Stable option id (auto-generated o1, o2, … when omitted)' },
    label: { type: 'string', description: 'Button label shown to the user' },
    description: { type: 'string', description: 'Shorter helper text under the label' },
  },
  additionalProperties: false,
};

const askQuestionSingleSchema = {
  type: 'object',
  properties: {
    question: { type: 'string', description: 'The question to ask the user' },
    options: { type: 'array', items: askQuestionOptionSchema, description: 'Clickable options' },
    multiSelect: { type: 'boolean', description: 'Allow picking several options' },
    allowFreeText: { type: 'boolean', description: 'Also accept free text from the user' },
  },
  required: ['question'],
  additionalProperties: false,
};

function normalizeQuestionInput(raw: unknown): AskQuestionInput | { error: string } {
  if (typeof raw !== 'object' || raw === null) return { error: 'question must be an object' };
  const r = raw as Record<string, unknown>;
  if (typeof r.question !== 'string' || r.question.trim().length === 0) {
    return { error: 'every question needs non-empty `question` text' };
  }
  const out: AskQuestionInput = { question: r.question };
  if (r.options !== undefined) {
    if (!Array.isArray(r.options)) return { error: '`options` must be an array' };
    const options: AskQuestionOptionInput[] = [];
    for (const o of r.options) {
      if (typeof o !== 'object' || o === null || typeof (o as Record<string, unknown>).label !== 'string') {
        return { error: 'every option needs a string `label`' };
      }
      const oo = o as Record<string, unknown>;
      const opt: AskQuestionOptionInput = { label: oo.label as string };
      if (typeof oo.id === 'string') opt.id = oo.id;
      if (typeof oo.description === 'string') opt.description = oo.description;
      options.push(opt);
    }
    out.options = options;
  }
  if (typeof r.multiSelect === 'boolean') out.multiSelect = r.multiSelect;
  if (typeof r.allowFreeText === 'boolean') out.allowFreeText = r.allowFreeText;
  return out;
}

/**
 * Interpret a widget answer value into selected option ids + labels +
 * free text. Defensive: accepts {selected|selectedIds:[ids], freeText},
 * a bare array of ids, a single id string, or {id}.
 */
function interpretQuestionAnswer(
  answer: WidgetAnswer,
  payload: ButtonsWidgetPayload,
): { selected: string[]; labels: string[]; freeText: string | null } {
  if (!answer.answered) return { selected: [], labels: [], freeText: null };
  const v = answer.value;
  let ids: string[] = [];
  let freeText: string | null = null;
  if (Array.isArray(v)) {
    ids = v.map((x) => String(x));
  } else if (typeof v === 'string') {
    ids = [v];
  } else if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.selected)) ids = (o.selected as unknown[]).map((x) => String(x));
    else if (Array.isArray(o.selectedIds)) ids = (o.selectedIds as unknown[]).map((x) => String(x));
    else if (typeof o.id === 'string') ids = [o.id];
    if (typeof o.freeText === 'string' && o.freeText.length > 0) freeText = o.freeText;
    else if (typeof o.text === 'string' && o.text.length > 0) freeText = o.text;
  }
  const known = new Map(payload.options.map((o) => [o.id, o.label] as const));
  const selected = ids.filter((id) => known.has(id));
  const unknownIds = ids.filter((id) => !known.has(id));
  if (unknownIds.length > 0 && freeText === null) freeText = unknownIds.join(', ');
  return {
    selected,
    labels: selected.map((id) => known.get(id) ?? id),
    freeText,
  };
}

function askUserQuestionTool(): ToolDefinition {
  return {
    name: 'ask_user_question',
    description: [
      'Ask the user a question with clickable options and PAUSE the turn until they answer.',
      'Renders buttons in the chat UI; the turn resumes when the user picks an option (or types free text when allowFreeText is true).',
      'Use SPARINGLY — only for genuine user decisions you cannot make yourself (preferences, direction choices, disambiguation that blocks progress).',
      `After timeoutMinutes (default ${ASK_QUESTION_TIMEOUT_DEFAULT_MIN}, clamped to ${ASK_QUESTION_TIMEOUT_MIN}-${ASK_QUESTION_TIMEOUT_MAX}) with no answer, the turn resumes with answered:false — ALWAYS have a fallback default and continue without the answer.`,
      'Batch related questions in one call via `questions` (all are shown at once, then answered in order) instead of calling repeatedly.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to ask (single-question mode)' },
        options: {
          type: 'array',
          items: askQuestionOptionSchema,
          description: 'Clickable options (single-question mode)',
        },
        multiSelect: { type: 'boolean', description: 'Allow picking several options' },
        allowFreeText: { type: 'boolean', description: 'Also accept free text from the user' },
        questions: {
          type: 'array',
          items: askQuestionSingleSchema,
          description: 'Batch mode: several questions, all shown at once then answered in order',
        },
        timeoutMinutes: {
          type: 'number',
          description: `Per-question wait in minutes (default ${ASK_QUESTION_TIMEOUT_DEFAULT_MIN}, clamped to ${ASK_QUESTION_TIMEOUT_MIN}-${ASK_QUESTION_TIMEOUT_MAX})`,
        },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const host: WidgetHost | undefined = ctx.widget;
      if (!host) {
        return {
          error:
            'ask_user_question is not available in this context (no interactive UI attached). ' +
            'Proceed with your best judgment instead.',
        };
      }

      // Normalize to a question list: batch (`questions`) or single.
      let inputs: AskQuestionInput[];
      if (Array.isArray(args.questions)) {
        inputs = [];
        for (const raw of args.questions) {
          const n = normalizeQuestionInput(raw);
          if ('error' in n) return { error: `invalid questions[${inputs.length}]: ${n.error}` };
          inputs.push(n);
        }
      } else if (typeof args.question === 'string' && args.question.trim().length > 0) {
        const n = normalizeQuestionInput({
          question: args.question,
          options: args.options,
          multiSelect: args.multiSelect,
          allowFreeText: args.allowFreeText,
        });
        if ('error' in n) return { error: `invalid question: ${n.error}` };
        inputs = [n];
      } else {
        return {
          error: 'ask_user_question needs at least one question: pass `question` or a non-empty `questions` array.',
        };
      }
      if (inputs.length === 0) {
        return { error: 'ask_user_question needs at least one question: `questions` was empty.' };
      }

      const rawTimeout = typeof args.timeoutMinutes === 'number' && Number.isFinite(args.timeoutMinutes)
        ? args.timeoutMinutes
        : ASK_QUESTION_TIMEOUT_DEFAULT_MIN;
      const timeoutMs =
        Math.min(ASK_QUESTION_TIMEOUT_MAX, Math.max(ASK_QUESTION_TIMEOUT_MIN, rawTimeout)) * 60_000;

      // Batch: raise + emit ALL questions first, then await answers in order.
      const raised: Array<{ input: AskQuestionInput; widgetId: string; expiresAt: number; payload: ButtonsWidgetPayload }> = [];
      for (let i = 0; i < inputs.length; i++) {
        const input = inputs[i]!;
        const options = (input.options ?? []).map((o, oi) => ({
          id: typeof o.id === 'string' && o.id.length > 0 ? o.id : `o${oi + 1}`,
          label: o.label,
          ...(o.description !== undefined ? { description: o.description } : {}),
        }));
        const validated = validateWidgetPayload({
          kind: 'buttons',
          title: 'Question for you',
          question: input.question,
          options,
          ...(input.multiSelect ? { multiSelect: true } : {}),
          ...(input.allowFreeText ? { allowFreeText: true } : {}),
        });
        if (!validated.ok) return { error: `invalid question ${i + 1}: ${validated.error}` };
        const payload = validated.payload as ButtonsWidgetPayload;
        let widgetId: string;
        let expiresAt: number;
        try {
          const record = await host.raise({ kind: 'buttons', payload, title: 'Question for you', interactive: true });
          widgetId = record.id;
          expiresAt = record.expiresAt;
        } catch (err) {
          return { error: `could not raise question ${i + 1}: ${err instanceof Error ? err.message : String(err)}` };
        }
        raised.push({ input, widgetId, expiresAt, payload });
        try {
          await host.emit({
            type: 'widget',
            widgetId,
            sessionId: ctx.sessionId,
            widget: payload,
            expiresAt,
            interactive: true,
          });
        } catch {
          // Event sinks must never break the question flow.
        }
      }

      const answers: Array<{
        question: string;
        answered: boolean;
        selected: string[];
        labels: string[];
        freeText: string | null;
      }> = [];
      for (const { input, widgetId, payload } of raised) {
        let answer: WidgetAnswer;
        try {
          answer = await host.awaitAnswer(widgetId, timeoutMs);
        } catch {
          // Aborted (or host error): fail closed — no answer, turn continues.
          answer = { answered: false };
        }
        const answeredAt = Date.now();
        try {
          await host.emit({
            type: 'widget_answered',
            widgetId,
            answer: {
              answered: answer.answered,
              ...(answer.value !== undefined ? { value: answer.value } : {}),
              ...(answer.expired ? { expired: true } : {}),
              answeredAt,
            },
          });
        } catch {
          // Event sinks must never break the question flow.
        }
        const interpreted = interpretQuestionAnswer(answer, payload);
        answers.push({ question: input.question, answered: answer.answered, ...interpreted });
      }
      return { answers, allAnswered: answers.every((a) => a.answered) };
    },
  };
}
