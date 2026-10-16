// SPDX-License-Identifier: Apache-2.0
/**
 * Native CLI drivers (OpenMausBot parity P0 #8).
 *
 * Upgrades the one-shot `agent/<cli>/<model>` providers (see agent-cli.ts)
 * into real native drivers for CLIs with a structured streaming interface —
 * currently Claude Code (`claude`) and Codex (`codex`):
 *
 * - STREAMING: parses the CLI's incremental JSON event stream (Claude Code
 *   `--output-format stream-json`; `codex exec --json` JSONL) and forwards
 *   text as tokens while the turn runs — no more waiting for process exit.
 * - TOOL VISIBILITY: the CLI's own tool executions (`tool_use` blocks /
 *   `command_execution` items) are surfaced as KriyaDot `tool_call` /
 *   `tool_result` stream events via `onCliToolEvent`, so the UI and the
 *   audit trail see everything the CLI did.
 * - PERMISSION BROKER: KriyaDot's approval modes are mapped onto the CLI's
 *   own permission flags BEFORE spawn (plan/auto/bypass → `--permission-mode`
 *   / `--sandbox` / `--dangerously-bypass-approvals-and-sandbox`), the
 *   catastrophic-command denylist is enforced live as a kill-switch (the
 *   child is killed the moment a denied command is observed), and the
 *   runtime's plan gate already runs before the driver spawns in plan mode.
 * - SESSIONS: the CLI's session id (`session_id` / `thread_id`) is captured
 *   per KriyaDot session and resumed on the next turn — no cold start.
 *
 * HONEST LIMITATIONS (architectural, not bugs):
 * - In non-interactive mode the CLI owns tool execution: KriyaDot cannot
 *   pre-approve each individual CLI tool call the way it can its own tools.
 *   The broker governs at the boundary (mode flags + kill-switch + plan
 *   gate + full observation/audit) instead of faking per-call interception.
 * - `toolCalls` returned from `chat()` are always `[]`: returning the CLI's
 *   tool calls there would make the runtime EXECUTE them a second time.
 *   Observation flows through `onCliToolEvent` only.
 * - Child stdout is external/untrusted (same contract as agent-cli.ts).
 *
 * Security contract: the child is spawned WITHOUT a shell (argv array);
 * no secrets are passed to or read from the child — auth is the CLI's own
 * login. Tokens never appear in logs, errors, or API responses.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  detectAgentClis,
  flattenMessagesForCli,
  parseAgentProviderId,
  untrustedCliPrefix,
} from './agent-cli.js';
import { isCatastrophicCommand } from '../tools/builtin.js';
import type {
  ApprovalMode,
  ChatMessage,
  CliToolStreamEvent,
  LLMProvider,
  ModelInfo,
  TokenUsage,
  ToolCall,
  ToolDefinition,
} from '../types.js';

// ---------------------------------------------------------------------------
// Text accumulation: CLIs emit text either cumulatively (each event carries
// the full text so far) or discretely (each event carries new text). The
// accumulator emits only the unseen suffix in both cases.
// ---------------------------------------------------------------------------

export class TextAccumulator {
  private seen = '';

  /** Feed newly observed text; returns the unseen suffix to emit ('' if none). */
  feed(text: string): string {
    if (!text) return '';
    if (text.startsWith(this.seen) && this.seen.length > 0) {
      const delta = text.slice(this.seen.length);
      this.seen = text;
      return delta;
    }
    // Discrete emission, or the stream restarted: emit all, adopt as baseline.
    // Guard against re-emitting an exact duplicate (some CLIs repeat the
    // final message in the result event).
    if (text === this.seen) return '';
    this.seen = text;
    return text;
  }

  reset(): void {
    this.seen = '';
  }

  get text(): string {
    return this.seen;
  }
}

// ---------------------------------------------------------------------------
// CLI session store: KriyaDot sessionKey -> CLI-native session id.
// In-memory (a restart clears it); explicit list/resume covers cross-restart.
// ---------------------------------------------------------------------------

export class CliSessionStore {
  private readonly map = new Map<string, string>();

  key(cliId: string, sessionKey: string): string {
    return `${cliId}::${sessionKey}`;
  }

  get(cliId: string, sessionKey: string): string | undefined {
    return this.map.get(this.key(cliId, sessionKey));
  }

  set(cliId: string, sessionKey: string, cliSessionId: string): void {
    this.map.set(this.key(cliId, sessionKey), cliSessionId);
  }

  clear(): void {
    this.map.clear();
  }
}

/** Process-lifetime default store; tests inject their own. */
export const defaultCliSessionStore = new CliSessionStore();

// ---------------------------------------------------------------------------
// Session listing (read-only scans of the CLI's own session storage).
// ---------------------------------------------------------------------------

export interface CliSessionInfo {
  id: string;
  title: string;
  updatedAt: number;
  cliId: string;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/**
 * List past Claude Code sessions by scanning ~/.claude/projects/<slug>/*.jsonl
 * (read-only). The title is the first user message found, best-effort.
 */
export function listClaudeSessions(homeDir?: string): CliSessionInfo[] {
  const home = homeDir ?? homedir();
  const projectsDir = join(home, '.claude', 'projects');
  const out: CliSessionInfo[] = [];
  let slugs: string[];
  try {
    slugs = readdirSync(projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return out;
  }
  for (const slug of slugs) {
    const dir = join(projectsDir, slug);
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const file of files) {
      const full = join(dir, file);
      let title = file.replace(/\.jsonl$/, '');
      let updatedAt = 0;
      try {
        updatedAt = statSync(full).mtimeMs;
        // First user text message as the title (best-effort, first 40 lines).
        const head = readFileSync(full, 'utf8').split('\n').slice(0, 40);
        for (const line of head) {
          const obj = safeJsonParse(line) as Record<string, unknown> | undefined;
          const msg = obj?.['message'] as Record<string, unknown> | undefined;
          const content = msg?.['content'];
          const text =
            typeof content === 'string'
              ? content
              : Array.isArray(content)
                ? content
                    .map((b) => (typeof b === 'object' && b !== null && (b as Record<string, unknown>)['type'] === 'text'
                      ? String((b as Record<string, unknown>)['text'] ?? '')
                      : ''))
                    .join('')
                : '';
          const role = msg?.['role'] ?? obj?.['role'];
          if (role === 'user' && text.trim()) {
            title = truncate(text.trim().split('\n')[0] ?? title, 80);
            break;
          }
        }
      } catch {
        // unreadable file — keep the id as the title
      }
      out.push({ id: title === file.replace(/\.jsonl$/, '') ? file.replace(/\.jsonl$/, '') : file.replace(/\.jsonl$/, ''), title, updatedAt, cliId: 'claude-code' });
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

/**
 * List past Codex sessions. Modern Codex keeps sessions in sqlite
 * (~/.codex/sessions or the logs db); older layouts used *.jsonl files.
 * Best-effort: scan ~/.codex/sessions for jsonl/json files; empty when the
 * layout is unknown (the live `thread_id` from --json is authoritative).
 */
export function listCodexSessions(homeDir?: string): CliSessionInfo[] {
  const home = homeDir ?? homedir();
  const sessionsDir = join(home, '.codex', 'sessions');
  const out: CliSessionInfo[] = [];
  let files: string[];
  try {
    files = readdirSync(sessionsDir).filter((f) => f.endsWith('.jsonl') || f.endsWith('.json'));
  } catch {
    return out;
  }
  for (const file of files) {
    const full = join(sessionsDir, file);
    let updatedAt = 0;
    try {
      updatedAt = statSync(full).mtimeMs;
    } catch {
      // ignore
    }
    out.push({ id: file.replace(/\.(jsonl|json)$/, ''), title: file, updatedAt, cliId: 'codex' });
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

export function listNativeCliSessions(cliId: string, homeDir?: string): CliSessionInfo[] {
  if (cliId === 'claude-code') return listClaudeSessions(homeDir);
  if (cliId === 'codex') return listCodexSessions(homeDir);
  return [];
}

// ---------------------------------------------------------------------------
// Native CLI spec: streaming args, event parsing, resume, permission mapping.
// ---------------------------------------------------------------------------

export type NativeCliId = 'claude-code' | 'codex';

export interface NativeRunOpts {
  model: string;
  prompt: string;
  approvalMode: ApprovalMode;
  resumeSessionId?: string;
}

export interface NativeCliSpec {
  id: NativeCliId;
  /** Executable name (resolved via PATH). */
  command: string;
  /** argv for one streaming turn (no shell). Prompt is embedded by the spec. */
  buildArgs: (opts: NativeRunOpts) => string[];
  /** Map KriyaDot approval modes onto the CLI's own permission flags. */
  permissionArgs: (mode: ApprovalMode) => string[];
}

function claudePermissionArgs(mode: ApprovalMode): string[] {
  // KriyaDot's plan gate already approved the plan before spawn, so plan and
  // auto both run the CLI in default mode; bypass maps to bypassPermissions.
  // (default keeps the CLI's own per-tool prompting policy for anything the
  // user's settings require; in non-TTY operation unanswerable prompts fail
  // closed rather than auto-approving.)
  if (mode === 'bypass') return ['--permission-mode', 'bypassPermissions'];
  return ['--permission-mode', 'default'];
}

function codexPermissionArgs(mode: ApprovalMode): string[] {
  if (mode === 'bypass') {
    return ['--sandbox', 'danger-full-access', '--dangerously-bypass-approvals-and-sandbox'];
  }
  // plan: KriyaDot's plan gate approved the plan pre-spawn; the CLI then
  // executes inside the workspace sandbox. auto: Codex's own default.
  return ['--sandbox', 'workspace-write'];
}

const NATIVE_SPECS: Record<NativeCliId, NativeCliSpec> = {
  'claude-code': {
    id: 'claude-code',
    command: 'claude',
    permissionArgs: claudePermissionArgs,
    buildArgs: (opts) => {
      const args = ['-p', '--verbose', '--output-format', 'stream-json', '--model', opts.model];
      args.push(...claudePermissionArgs(opts.approvalMode));
      if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId);
      args.push(opts.prompt);
      return args;
    },
  },
  codex: {
    id: 'codex',
    command: 'codex',
    permissionArgs: codexPermissionArgs,
    buildArgs: (opts) => {
      const perm = codexPermissionArgs(opts.approvalMode);
      if (opts.resumeSessionId) {
        // `codex exec resume [SESSION_ID] [PROMPT]` — session keeps its model.
        return ['exec', 'resume', ...perm, '--json', '--skip-git-repo-check', opts.resumeSessionId, opts.prompt];
      }
      return ['exec', ...perm, '--json', '--skip-git-repo-check', '--model', opts.model, opts.prompt];
    },
  },
};

export function getNativeCliSpec(cliId: string): NativeCliSpec | undefined {
  return (NATIVE_SPECS as Record<string, NativeCliSpec>)[cliId];
}

export function hasNativeDriver(cliId: string): boolean {
  return getNativeCliSpec(cliId) !== undefined;
}

// ---------------------------------------------------------------------------
// Event parsing.
// ---------------------------------------------------------------------------

export interface CliParseCallbacks {
  onToken: (t: string) => void;
  onToolEvent: (e: CliToolStreamEvent) => void;
  /** Called when the CLI reports its session id. */
  onSessionId: (id: string) => void;
  /** Kill-switch: called when a catastrophic tool call is observed. Return true if killed. */
  onBlockedTool: (call: ToolCall, reason: string) => void;
}

interface ParseState {
  cliId: NativeCliId;
  text: TextAccumulator;
  /** tool_use id -> ToolCall, for matching tool_result events. */
  pendingTools: Map<string, ToolCall>;
  finalText: string;
  sessionId?: string;
  blocked: boolean;
}

export function createParseState(cliId: NativeCliId): ParseState {
  return { cliId, text: new TextAccumulator(), pendingTools: new Map(), finalText: '', blocked: false };
}

function makeToolCall(cliId: string, id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id: `${cliId}:${id}`, name, args };
}

function checkBlocked(
  state: ParseState,
  call: ToolCall,
  cbs: CliParseCallbacks,
): boolean {
  let haystack: string;
  try {
    haystack = JSON.stringify(call.args);
  } catch {
    haystack = call.name;
  }
  if (isCatastrophicCommand(haystack)) {
    state.blocked = true;
    cbs.onBlockedTool(call, `Catastrophic command pattern blocked by KriyaDot policy (never bypassable).`);
    cbs.onToolEvent({ kind: 'tool_denied', call, cliId: state.cliId, denied: true });
    return true;
  }
  return false;
}

const MAX_TOOL_OUTPUT_CHARS = 4000;

function truncateToolOutput(s: string): string {
  return s.length > MAX_TOOL_OUTPUT_CHARS ? s.slice(0, MAX_TOOL_OUTPUT_CHARS) + '…[truncated]' : s;
}

/** Parse one Claude Code `--output-format stream-json` line. Never throws. */
export function parseClaudeStreamLine(line: string, state: ParseState, cbs: CliParseCallbacks): void {
  let evt: Record<string, unknown>;
  try {
    evt = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return; // not JSON — ignore (progress chatter on stdout is unexpected)
  }
  if (typeof evt['type'] !== 'string') return;
  try {
    switch (evt['type']) {
      case 'system': {
        const sid = evt['session_id'];
        if (typeof sid === 'string' && sid) {
          state.sessionId = sid;
          cbs.onSessionId(sid);
        }
        break;
      }
      case 'assistant': {
        const msg = evt['message'] as Record<string, unknown> | undefined;
        const content = msg?.['content'];
        if (!Array.isArray(content)) break;
        for (const block of content) {
          if (typeof block !== 'object' || block === null) continue;
          const b = block as Record<string, unknown>;
          if (b['type'] === 'text' && typeof b['text'] === 'string') {
            const delta = state.text.feed(b['text']);
            if (delta) cbs.onToken(delta);
          } else if (b['type'] === 'tool_use') {
            const tid = typeof b['id'] === 'string' ? b['id'] : `tu_${state.pendingTools.size}`;
            const name = typeof b['name'] === 'string' ? b['name'] : 'unknown';
            const input = (b['input'] && typeof b['input'] === 'object' ? b['input'] : {}) as Record<string, unknown>;
            const call = makeToolCall(state.cliId, tid, `claude.${name}`, input);
            state.pendingTools.set(tid, call);
            if (checkBlocked(state, call, cbs)) return;
            cbs.onToolEvent({ kind: 'tool_call', call, cliId: state.cliId });
          }
        }
        break;
      }
      case 'user': {
        const msg = evt['message'] as Record<string, unknown> | undefined;
        const content = msg?.['content'];
        if (!Array.isArray(content)) break;
        for (const block of content) {
          if (typeof block !== 'object' || block === null) continue;
          const b = block as Record<string, unknown>;
          if (b['type'] !== 'tool_result') continue;
          const tid = typeof b['tool_use_id'] === 'string' ? b['tool_use_id'] : '';
          const call = state.pendingTools.get(tid) ?? makeToolCall(state.cliId, tid || 'unknown', 'claude.unknown', {});
          state.pendingTools.delete(tid);
          let resultText = '';
          const c = b['content'];
          if (typeof c === 'string') resultText = c;
          else {
            try {
              resultText = JSON.stringify(c);
            } catch {
              resultText = '[unserializable tool result]';
            }
          }
          cbs.onToolEvent({
            kind: 'tool_result',
            call,
            cliId: state.cliId,
            result: { output: truncateToolOutput(resultText), is_error: b['is_error'] === true },
          });
        }
        break;
      }
      case 'result': {
        const sid = evt['session_id'];
        if (typeof sid === 'string' && sid) {
          state.sessionId = sid;
          cbs.onSessionId(sid);
        }
        if (evt['subtype'] === 'success' && typeof evt['result'] === 'string') {
          // Authoritative final text; the accumulator dedupes if we already
          // streamed it incrementally.
          const delta = state.text.feed(evt['result']);
          if (delta) cbs.onToken(delta);
        } else if (evt['subtype'] !== 'success' && evt['subtype'] !== undefined) {
          const errText = typeof evt['result'] === 'string' && evt['result'] ? `: ${evt['result']}` : '';
          cbs.onToken(`\n[Claude Code turn ended (${String(evt['subtype'])})${errText}]\n`);
        }
        state.finalText = state.text.text;
        break;
      }
      default:
        break; // forward-compatible: ignore unknown event types
    }
  } catch {
    // Defensive: a malformed event must never kill the turn.
  }
}

/** Parse one `codex exec --json` JSONL line. Never throws. */
export function parseCodexJsonLine(line: string, state: ParseState, cbs: CliParseCallbacks): void {
  let evt: Record<string, unknown>;
  try {
    evt = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  if (typeof evt['type'] !== 'string') return;
  try {
    switch (evt['type']) {
      case 'thread.started': {
        const tid = evt['thread_id'];
        if (typeof tid === 'string' && tid) {
          state.sessionId = tid;
          cbs.onSessionId(tid);
        }
        break;
      }
      case 'error': {
        const msg = typeof evt['message'] === 'string' ? evt['message'] : 'unknown error';
        // Transient reconnect notices are informational, not fatal.
        cbs.onToken(`\n[Codex: ${msg}]\n`);
        break;
      }
      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        const item = evt['item'] as Record<string, unknown> | undefined;
        if (!item || typeof item !== 'object') break;
        handleCodexItem(item, state, cbs, evt['type'] === 'item.completed');
        break;
      }
      case 'turn.completed':
        state.finalText = state.text.text;
        break;
      default:
        break; // forward-compatible
    }
  } catch {
    // Defensive: never let a malformed event kill the turn.
  }
}

function codexItemText(item: Record<string, unknown>): string {
  const t = item['text'];
  return typeof t === 'string' ? t : '';
}

function handleCodexItem(
  item: Record<string, unknown>,
  state: ParseState,
  cbs: CliParseCallbacks,
  completed: boolean,
): void {
  const itemType = typeof item['type'] === 'string' ? (item['type'] as string) : 'unknown';
  const itemId = typeof item['id'] === 'string' ? (item['id'] as string) : `${itemType}_${state.pendingTools.size}`;

  if (itemType === 'agent_message') {
    const delta = state.text.feed(codexItemText(item));
    if (delta) cbs.onToken(delta);
    return;
  }

  if (itemType === 'error') {
    const msg = typeof item['message'] === 'string' ? item['message'] : 'unknown error';
    cbs.onToken(`\n[Codex item error: ${msg}]\n`);
    return;
  }

  // Tool-like items: surface on completion (they carry outputs then).
  if (!completed) return;

  if (itemType === 'command_execution') {
    const command = typeof item['command'] === 'string' ? item['command'] : '';
    const call = makeToolCall(state.cliId, itemId, 'codex.exec', { command });
    if (checkBlocked(state, call, cbs)) return;
    cbs.onToolEvent({ kind: 'tool_call', call, cliId: state.cliId });
    const output = typeof item['aggregated_output'] === 'string' ? item['aggregated_output'] : '';
    cbs.onToolEvent({
      kind: 'tool_result',
      call,
      cliId: state.cliId,
      result: {
        output: truncateToolOutput(output),
        exit_code: typeof item['exit_code'] === 'number' ? item['exit_code'] : undefined,
        status: typeof item['status'] === 'string' ? item['status'] : undefined,
      },
    });
    return;
  }

  if (itemType === 'file_change') {
    const changes = item['changes'];
    let summary = '';
    try {
      summary = truncateToolOutput(JSON.stringify(changes));
    } catch {
      summary = '[unserializable changes]';
    }
    const call = makeToolCall(state.cliId, itemId, 'codex.file_change', { changes: summary });
    cbs.onToolEvent({ kind: 'tool_call', call, cliId: state.cliId });
    cbs.onToolEvent({ kind: 'tool_result', call, cliId: state.cliId, result: { applied: true } });
    return;
  }

  if (itemType === 'mcp_tool_call') {
    const name =
      typeof item['name'] === 'string'
        ? item['name']
        : typeof item['server'] === 'string'
          ? `mcp.${item['server']}`
          : 'mcp.tool';
    let args: Record<string, unknown> = {};
    try {
      const a = item['arguments'];
      args = a && typeof a === 'object' ? (a as Record<string, unknown>) : { raw: String(a ?? '') };
    } catch {
      args = {};
    }
    const call = makeToolCall(state.cliId, itemId, `codex.${name}`, args);
    if (checkBlocked(state, call, cbs)) return;
    cbs.onToolEvent({ kind: 'tool_call', call, cliId: state.cliId });
    const out = typeof item['result'] === 'string' ? item['result'] : (() => { try { return JSON.stringify(item['result']); } catch { return ''; } })();
    cbs.onToolEvent({
      kind: 'tool_result',
      call,
      cliId: state.cliId,
      result: { output: truncateToolOutput(out) },
    });
    return;
  }

  // Other item types (web_search, todo_list, …): note them as text so the
  // transcript stays faithful without inventing tool semantics.
  if (itemType === 'web_search' || itemType === 'todo_list') {
    cbs.onToken(`\n[Codex ${itemType}]\n`);
  }
}

// ---------------------------------------------------------------------------
// Spawn plumbing (injectable for tests).
// ---------------------------------------------------------------------------

export type SpawnFn = (
  command: string,
  args: string[],
  opts: { signal?: AbortSignal },
) => {
  child: ChildProcess;
  stdout?: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

function defaultSpawn(
  command: string,
  args: string[],
  _opts: { signal?: AbortSignal },
): ReturnType<SpawnFn> {
  const child = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    // No shell, no extra env: the CLI authenticates with its own login.
  });
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal }));
    child.on('error', () => resolve({ code: null, signal: null }));
  });
  return { child, stdout: child.stdout, stderr: child.stderr, done };
}

// ---------------------------------------------------------------------------
// Native driver.
// ---------------------------------------------------------------------------

export interface NativeCliDriverOptions {
  cliId: string;
  model: string;
  /** Override the executable (tests / non-PATH installs). */
  command?: string;
  /** Kill the child after this long (default 10 min — agentic runs are slow). */
  timeoutMs?: number;
  sessionStore?: CliSessionStore;
  spawnFn?: SpawnFn;
  /**
   * Pre-flight auth check override (tests). The default check asks the CLI
   * about its own login state and fails fast when definitely signed out —
   * without it, an unauthenticated CLI hangs retrying until the turn timeout.
   * Set to `null` to skip the check entirely.
   */
  preflightAuthCheck?: (() => Promise<string | null>) | null;
  homeDir?: string;
}

const NATIVE_DEFAULT_TIMEOUT_MS = 600_000;
const MAX_STDERR_CHARS = 2000;
const MAX_LINE_BYTES = 256 * 1024; // one JSONL line cap (defense against runaway output)
const PREFLIGHT_TIMEOUT_MS = 8000;

export class NativeCliDriver implements LLMProvider {
  readonly providerId: string;
  private readonly cliId: string;
  private readonly model: string;
  private readonly command: string;
  private readonly timeoutMs: number;
  private readonly sessionStore: CliSessionStore;
  private readonly spawnFn: SpawnFn;
  private readonly preflightAuthCheck: (() => Promise<string | null>) | null;
  private readonly homeDir: string;

  constructor(opts: NativeCliDriverOptions) {
    const spec = getNativeCliSpec(opts.cliId);
    if (!spec) throw new Error(`No native driver for CLI "${opts.cliId}". Native drivers: claude-code, codex.`);
    this.cliId = opts.cliId;
    this.model = opts.model;
    this.command = opts.command ?? spec.command;
    this.timeoutMs = opts.timeoutMs ?? NATIVE_DEFAULT_TIMEOUT_MS;
    this.sessionStore = opts.sessionStore ?? defaultCliSessionStore;
    this.spawnFn = opts.spawnFn ?? defaultSpawn;
    this.homeDir = opts.homeDir ?? homedir();
    this.preflightAuthCheck =
      opts.preflightAuthCheck !== undefined ? opts.preflightAuthCheck : () => this.defaultPreflightAuthCheck();
    this.providerId = `agent/${this.cliId}/${this.model}`;
  }

  /**
   * Fail-fast auth pre-flight: an unauthenticated CLI hangs retrying instead
   * of failing, which would burn the whole turn timeout. Ask the CLI about
   * its own login state (never read token bytes ourselves):
   * - codex: `codex login status` → "Not logged in" means stop now.
   * - claude: the credentials file must exist (existence only, no reads).
   * Fail-OPEN on check errors/timeouts: a broken check must never block a
   * legitimate login; the turn itself will surface real auth failures.
   */
  private async defaultPreflightAuthCheck(): Promise<string | null> {
    if (this.cliId === 'codex') {
      try {
        // NB: `codex login status` prints "Not logged in" to STDERR, not stdout.
        const { stdout, stderr, done } = this.spawnFn(this.command, ['login', 'status'], {});
        let out = '';
        const onData = (d: Buffer): void => {
          out += d.toString('utf8');
          if (out.length > 4096) out = out.slice(-4096);
        };
        stdout?.on('data', onData);
        stderr?.on('data', onData);
        const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), PREFLIGHT_TIMEOUT_MS));
        const result = await Promise.race([done.then(() => out), timeout]);
        if (result !== null && /not logged in/i.test(result)) {
          return (
            `Codex CLI is not signed in. Sign in via Settings → Providers → Sign in, ` +
            `or run \`codex login\` in your terminal — KriyaDot uses the CLI's own login.`
          );
        }
      } catch {
        // fail open
      }
      return null;
    }
    if (this.cliId === 'claude-code') {
      try {
        if (!existsSync(join(this.homeDir, '.claude', '.credentials.json'))) {
          return (
            `Claude Code is not signed in (no ~/.claude/.credentials.json). Sign in via ` +
            `Settings → Providers → Sign in, or run \`claude\` in your terminal once.`
          );
        }
      } catch {
        // fail open
      }
      return null;
    }
    return null;
  }

  async chat(
    messages: ChatMessage[],
    _tools: ToolDefinition[],
    opts: {
      model: string;
      onToken?: (t: string) => void;
      signal?: AbortSignal;
      sessionKey?: string;
      approvalMode?: ApprovalMode;
      onCliToolEvent?: (e: CliToolStreamEvent) => void;
    },
  ): Promise<{ content: string; toolCalls: []; usage: TokenUsage }> {
    const spec = getNativeCliSpec(this.cliId);
    if (!spec) throw new Error(`No native driver for CLI "${this.cliId}".`);
    const model = opts.model || this.model;
    const prompt = flattenMessagesForCli(messages);
    const approvalMode: ApprovalMode = opts.approvalMode ?? 'auto';

    // Fail fast when the CLI is definitely signed out (an unauthenticated
    // CLI hangs retrying until the turn timeout otherwise).
    if (this.preflightAuthCheck) {
      const authProblem = await this.preflightAuthCheck();
      if (authProblem) throw new Error(authProblem);
    }

    const sessionKey = opts.sessionKey;
    const resumeSessionId = sessionKey ? this.sessionStore.get(this.cliId, sessionKey) : undefined;
    const args = spec.buildArgs({ model, prompt, approvalMode, resumeSessionId });

    const prefix = untrustedCliPrefix(this.cliId);
    if (opts.onToken) opts.onToken(`${prefix}\n`);

    const state = createParseState(this.cliId as NativeCliId);
    let latestSessionId: string | undefined;
    const cbs: CliParseCallbacks = {
      onToken: (t) => opts.onToken?.(t),
      onToolEvent: (e) => opts.onCliToolEvent?.(e),
      onSessionId: (id) => {
        latestSessionId = id;
      },
      onBlockedTool: () => {
        // Kill-switch: the child is terminated by the run loop via state.blocked.
      },
    };
    const parseLine = this.cliId === 'codex' ? parseCodexJsonLine : parseClaudeStreamLine;

    const { child, stdout, stderr, done } = this.spawnFn(this.command, args, { signal: opts.signal });
    let stdoutBuf = '';
    let stderrText = '';
    let killedByGuard = false;
    let settled = false;

    const killChild = (): void => {
      if (settled) return;
      try {
        child.kill('SIGKILL');
      } catch {
        /* already dead */
      }
    };

    if (opts.signal?.aborted) {
      killChild();
      throw new Error(`Native CLI driver "${this.command}" aborted before start.`);
    }
    const onAbort = (): void => {
      killChild();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const feedLine = (line: string): void => {
      if (line.length === 0) return;
      if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) return; // skip absurd lines
      parseLine(line, state, cbs);
      if (state.blocked && !killedByGuard) {
        killedByGuard = true;
        killChild();
      }
    };

    stdout?.on('data', (d: Buffer) => {
      stdoutBuf += d.toString('utf8');
      let idx: number;
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx).trimEnd();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        feedLine(line);
        if (killedByGuard) break;
      }
    });
    stderr?.on('data', (d: Buffer) => {
      stderrText += d.toString('utf8');
      if (stderrText.length > MAX_STDERR_CHARS * 4) stderrText = stderrText.slice(-MAX_STDERR_CHARS * 4);
    });

    const timeout = setTimeout(killChild, this.timeoutMs);
    // A streaming turn that produces output stays alive; the timeout is an
    // absolute cap (agentic runs can be long).

    let exit: { code: number | null; signal: NodeJS.Signals | null };
    try {
      exit = await done;
    } finally {
      clearTimeout(timeout);
      settled = true;
      opts.signal?.removeEventListener('abort', onAbort);
    }
    // Flush any trailing partial line.
    if (stdoutBuf.trim()) feedLine(stdoutBuf.trim());

    if (killedByGuard || state.blocked) {
      throw new Error(
        `Native CLI driver "${this.command}": turn stopped — the CLI attempted a command blocked by KriyaDot's ` +
          `catastrophic-command policy. This block cannot be bypassed.`,
      );
    }

    if (sessionKey && latestSessionId) {
      this.sessionStore.set(this.cliId, sessionKey, latestSessionId);
    }

    const content = state.finalText || state.text.text;
    if (exit.code !== 0 && !content) {
      const errText = stderrText.trim().slice(0, MAX_STDERR_CHARS);
      const how = exit.code !== null && exit.code !== undefined
        ? `exited with code ${exit.code}`
        : `was killed by signal ${exit.signal ?? '?'}`;
      throw new Error(
        `Native CLI driver "${this.command}" ${how}` +
          (errText ? `: ${errText}` : ' and produced no output.') +
          ' The CLI handles its own auth — sign in via Settings → Providers → Sign in.',
      );
    }

    // Mark the child output external/untrusted (same contract as agent-cli.ts).
    const marked = `${prefix}\n${content}`;
    // Subscription usage is metered by the CLI's own plan, not by KriyaDot.
    return { content: marked, toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
  }

  async listModels(): Promise<ModelInfo[]> {
    return [{ id: this.model, name: `${this.cliId}/${this.model}` }];
  }
}

/**
 * Build a native driver for `agent/<cli-id>/<model>` when the CLI has one.
 * Returns null for CLIs without a native driver (caller falls back to the
 * one-shot AgentCliProvider). Throws on malformed ids / unknown CLIs /
 * missing binaries, mirroring createAgentCliProvider's errors.
 */
export function createNativeCliDriver(
  providerId: string,
  opts: {
    command?: string;
    timeoutMs?: number;
    sessionStore?: CliSessionStore;
    spawnFn?: SpawnFn;
    preflightAuthCheck?: (() => Promise<string | null>) | null;
    homeDir?: string;
  } = {},
): NativeCliDriver | null {
  const parsed = parseAgentProviderId(providerId);
  if (!parsed) {
    throw new Error(
      `Invalid agent-CLI provider id "${providerId}": expected "agent/<cli-id>/<model>".`,
    );
  }
  if (!hasNativeDriver(parsed.cliId)) return null;
  if (!opts.command) {
    const [detection] = detectAgentClis().filter((d) => d.id === parsed.cliId);
    if (!detection?.installed) {
      throw new Error(
        `Agent CLI "${parsed.cliId}" is not installed or not on PATH. ` +
          `Install it and sign in (Settings → Providers → Sign in) — KriyaDot uses the CLI's own login.`,
      );
    }
  }
  return new NativeCliDriver({ cliId: parsed.cliId, model: parsed.model, ...opts });
}
