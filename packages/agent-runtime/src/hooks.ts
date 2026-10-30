// SPDX-License-Identifier: Apache-2.0
// Plugin hook system (OpenCode parity) + lifecycle expansion (CA-1).
//
// OpenCode's extensibility comes from plugins: modules that register hooks on
// runtime events (tool calls, sessions, file changes). Until now agent-runtime
// only had injected single-shot callbacks (summarizer hook, checkpoint hook)
// and a GovernanceGateway interface — no pluggable event bus and no plugin
// loader. This module provides both, plus the CA-1 expansion:
//
//   - HookBus: a typed event bus. Handlers run serially, in registration
//     order. A gate-event handler may cancel the operation (fail-closed:
//     the runtime returns a cancellation instead of executing).
//   - loadPlugins(dir, bus): loads plugin modules from a directory. A plugin
//     is any ESM module whose default export (or `activate` named export) is
//     a function `(bus) => void | Promise<void>`, optionally with
//     `name`/`version` metadata attached. Only `.js`/`.mjs` files are loaded;
//     subdirectories are skipped. Load failures are collected, not thrown,
//     so one broken plugin cannot take the host down.
//   - Handler types: JS functions (above), script handlers
//     (createScriptHookHandler), HTTP handlers (createHttpHookHandler —
//     POST the payload to a URL; an explicit block response blocks gate
//     events), and prompt handlers (createPromptHookHandler — an
//     LLM-judged handler behind the host-injected PromptHookEvaluator seam).
//   - Config: parseHookConfig / registerHookConfig accept the bot/project
//     config shape used for script hooks since the Octomind closure
//     ({ kind: 'script', command, events }) and extend it with
//     { kind: 'http', url } and { kind: 'prompt', prompt } entries plus a
//     per-hook `async` (fire-and-forget) flag. Back-compatible: every
//     previously valid script entry parses identically.
//
// ---------------------------------------------------------------------------
// EVENT CATALOG (16 events)
// ---------------------------------------------------------------------------
// Original five (unchanged semantics):
//   session.created  — a new session was created (runtime turn path).
//   tool.before      — GATE. Before a tool executes; { cancel } blocks it.
//   tool.after       — After a tool executed; { inject } feeds text back.
//   turn.ending      — Turn is about to end on a final answer; { inject }
//                      continues the turn instead.
//   input.transform  — Raw user message before the turn; { transform }
//                      replaces the model's view (stored message unchanged).
// CA-1 additions:
//   session.start    — A session started (SessionStore.createSession and
//                      the runtime's new-session path). Observer.
//   session.end      — A session ended (SessionStore.deleteSession).
//                      Observer.
//   turn.start       — A turn started (every runTurn). Observer.
//   subagent.start   — GATE. A subagent/background spawn is about to run;
//                      { cancel } blocks the spawn.
//   subagent.stop    — A subagent/background run finished (status in the
//                      payload). { inject } is collected like tool.after.
//   compact.before   — GATE. A compaction fold is about to run
//                      (SessionStore.compactNow); { cancel } skips it.
//   compact.after    — A compaction fold ran. Observer (+ inject).
//   permission.request — A tool call reached governance require-approval.
//                      ADVISORY by default: handlers observe but cannot
//                      change the outcome. A handler registered with
//                      canBlock (config: additionalDeny: true) may ADD a
//                      deny — it can never approve what governance denied
//                      or required approval for (block-only power).
//   file.changed     — A file-mutating tool (write_file/edit_file/…)
//                      completed successfully. Observer.
//   worktree.create  — GATE (async call sites). A git worktree is about
//                      to be / was created for an isolated spawn or via
//                      the worktree tools; { cancel } at the async call
//                      sites blocks creation.
//   worktree.remove  — A git worktree was removed (cleanup of an
//                      isolated spawn or the worktree tools). Observer.
//
// GATE EVENTS (an explicit { cancel } / block verdict is honored):
//   tool.before, subagent.start, compact.before, worktree.create,
//   permission.request (only from canBlock/additionalDeny handlers).
// Every other event is an observer: cancel verdicts are ignored there.
// Async handlers (async: true) are fire-and-forget and can NEVER block —
// they are not awaited, so their verdicts arrive too late by design.
//
// GOVERNANCE INVARIANT: hooks can only ever tighten, never loosen. No
// hook verdict can turn a governance deny into an allow, or a
// require-approval into an allow. The runtime only consumes `cancelled`
// to ADD a block on top of the governance outcome.

import type { LLMProvider } from './types.js';

export type HookEventName =
  | 'session.created'
  | 'tool.before'
  | 'tool.after'
  | 'turn.ending'
  | 'input.transform'
  | 'session.start'
  | 'session.end'
  | 'subagent.start'
  | 'subagent.stop'
  | 'compact.before'
  | 'compact.after'
  | 'permission.request'
  | 'file.changed'
  | 'worktree.create'
  | 'worktree.remove'
  | 'turn.start';

/** Every hook event name, in catalog order. */
export const HOOK_EVENTS: readonly HookEventName[] = [
  'session.created',
  'session.start',
  'session.end',
  'turn.start',
  'turn.ending',
  'input.transform',
  'tool.before',
  'tool.after',
  'permission.request',
  'subagent.start',
  'subagent.stop',
  'compact.before',
  'compact.after',
  'file.changed',
  'worktree.create',
  'worktree.remove',
];

/** Events where an explicit block verdict from a sync handler is honored. */
export const GATE_HOOK_EVENTS: ReadonlySet<HookEventName> = new Set<HookEventName>([
  'tool.before',
  'subagent.start',
  'compact.before',
  'worktree.create',
  'permission.request',
]);

export function isGateHookEvent(event: HookEventName): boolean {
  return GATE_HOOK_EVENTS.has(event);
}

/** Events whose handlers may return { inject } and have it collected. */
const INJECT_EVENTS: ReadonlySet<HookEventName> = new Set<HookEventName>([
  'tool.after',
  'turn.ending',
  'compact.after',
  'subagent.stop',
  'session.end',
]);

export interface SessionCreatedPayload {
  sessionId: string;
  botId: string;
}

/** CA-1: a session started. Fired alongside session.created on the runtime path, and by SessionStore.createSession when the store has a bus. */
export interface SessionStartPayload {
  sessionId: string;
  botId: string;
}

/** CA-1: a session ended (deleted). */
export interface SessionEndPayload {
  sessionId: string;
  botId: string;
}

/** CA-1: a turn started. */
export interface TurnStartPayload {
  sessionId: string;
  botId: string;
  /** True when this turn created the session. */
  isNewSession: boolean;
}

/** CA-1: a subagent (delegate or background) is about to spawn. GATE. */
export interface SubagentStartPayload {
  sessionId: string;
  botId: string;
  /** The subtask text (truncated by the emitter when very long). */
  task: string;
  /** Profile id when the spawn uses a specialist profile. */
  profileId?: string;
  /** 'delegate' (synchronous) or 'background'. */
  via: 'delegate' | 'background';
  /** Child bot id when known. */
  childBotId?: string;
}

/** CA-1: a subagent/background run finished. */
export interface SubagentStopPayload {
  sessionId: string;
  botId: string;
  task: string;
  status: 'done' | 'failed' | 'stopped';
  profileId?: string;
  via: 'delegate' | 'background';
  error?: string;
  /** Background run id when via is 'background'. */
  runId?: string;
}

/** CA-1: a compaction fold is about to run. GATE (compactNow path). */
export interface CompactBeforePayload {
  sessionId: string;
  botId?: string;
  /** Messages about to be folded away. */
  messageCount: number;
}

/** CA-1: a compaction fold ran. */
export interface CompactAfterPayload {
  sessionId: string;
  botId?: string;
  messageCount: number;
  /** Whether a fold actually happened. */
  compacted: boolean;
}

/**
 * CA-1: a tool call reached a governance require-approval decision.
 * Advisory observers by default — see the catalog note above. The
 * payload's `decision` is the governance outcome BEFORE any hook-added
 * deny; hooks can never upgrade it.
 */
export interface PermissionRequestPayload {
  sessionId: string;
  botId: string;
  toolName: string;
  args: Record<string, unknown>;
  decision: 'require-approval';
  reason?: string;
}

/** CA-1: a file-mutating tool completed successfully. */
export interface FileChangedPayload {
  sessionId: string;
  botId: string;
  toolName: string;
  /** Workspace-relative or absolute path the tool reported/used. */
  path: string;
}

/** CA-1: a worktree was (or is about to be) created. GATE at async call sites. */
export interface WorktreeCreatePayload {
  sessionId?: string;
  botId?: string;
  repoPath: string;
  /** Set when the worktree already exists (post-creation notification). */
  worktreePath?: string;
  branch?: string | null;
}

/** CA-1: a worktree was removed. */
export interface WorktreeRemovePayload {
  sessionId?: string;
  botId?: string;
  repoPath: string;
  worktreePath: string;
}

/**
 * Fired when a turn is about to end on a final answer (Octomind parity:
 * post-result hooks). A handler may return { inject } — the text is fed
 * back to the model as its next instruction and the turn continues
 * instead of ending (the runtime bounds how often this can happen).
 */
export interface TurnEndingPayload {
  sessionId: string;
  botId: string;
  /** The draft final answer the turn is about to end on. */
  finalContent: string;
  /** Number of tools executed this turn. */
  toolsExecuted: number;
}

/**
 * Fired on the raw user message before the turn starts (Octomind parity:
 * pipe guardrail / input transform). A handler may return
 * { transform } to replace the message text the model sees. Transforms
 * chain in registration order. The stored user message is NOT rewritten
 * — only the model's view of it.
 */
export interface InputTransformPayload {
  sessionId: string;
  botId: string;
  message: string;
}

/** A handler result asking the runtime to inject text into the turn. */
export interface HookInject {
  inject: string;
}

/** A handler result asking the runtime to replace the input message. */
export interface HookTransform {
  transform: string;
}

export interface ToolBeforePayload {
  sessionId: string;
  botId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface ToolAfterPayload extends ToolBeforePayload {
  ok: boolean;
  durationMs: number;
  error?: string;
}

/** A gate-event handler cancels the operation by returning { cancel: true }. */
export interface HookCancel {
  cancel: true;
  /** Human-readable reason surfaced to the model and the audit trail. */
  reason?: string;
}

export type HookHandler<T = unknown> = (
  payload: T,
) =>
  | void
  | HookCancel
  | HookInject
  | HookTransform
  | Promise<void | HookCancel | HookInject | HookTransform>;

function isCancel(v: unknown): v is HookCancel {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { cancel?: unknown }).cancel === true
  );
}

function isInject(v: unknown): v is HookInject {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { inject?: unknown }).inject === 'string'
  );
}

function isTransform(v: unknown): v is HookTransform {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { transform?: unknown }).transform === 'string'
  );
}

export interface HookEmitResult {
  /** True when a gate-event handler returned { cancel: true } (and was allowed to block). */
  cancelled: boolean;
  /** First cancellation reason, if any. */
  reason?: string;
  /**
   * Texts handlers asked to inject into the turn (from inject-capable
   * event handlers returning { inject }). In order.
   */
  injections: string[];
  /**
   * Final transformed message when `input.transform` handlers returned
   * { transform }; undefined when none did.
   */
  transformed?: string;
  /** Errors thrown by sync handlers — always collected, never propagated. */
  errors: Array<{ event: HookEventName; message: string }>;
  /** How many async (fire-and-forget) handlers were fired by this emit. */
  asyncFired: number;
}

export interface HookHandlerOptions {
  /**
   * Fire-and-forget: the handler is invoked but never awaited, and its
   * verdicts (cancel/inject/transform) are discarded. Use for logging,
   * metrics, and notifications. Async handlers can never block a gate.
   */
  async?: boolean;
  /**
   * Explicitly grant this handler block power on `permission.request`
   * (config: additionalDeny). Without it, permission.request handlers
   * are advisory observers. Irrelevant for other gate events, where any
   * sync handler may block.
   */
  canBlock?: boolean;
}

interface HookEntry {
  fn: HookHandler;
  async: boolean;
  canBlock?: boolean;
}

/**
 * Typed event bus. Emit is serial and best-effort for sync handlers:
 * handler errors are collected into the result (and never thrown), so a
 * buggy plugin cannot break a turn. Cancellation is only honored for
 * gate events (see GATE_HOOK_EVENTS) and never from async handlers.
 */
export class HookBus {
  private readonly handlers = new Map<HookEventName, HookEntry[]>();
  private readonly pendingAsync = new Set<Promise<void>>();
  /** Errors from async handlers, in completion order (observability only). */
  readonly asyncErrors: Array<{ event: HookEventName; message: string }> = [];

  /** Register a handler; returns an unsubscribe function. */
  on<T = unknown>(event: HookEventName, fn: HookHandler<T>, opts: HookHandlerOptions = {}): () => void {
    const list = this.handlers.get(event) ?? [];
    const entry: HookEntry = { fn: fn as HookHandler, async: opts.async === true, canBlock: opts.canBlock };
    list.push(entry);
    this.handlers.set(event, list);
    return () => {
      const cur = this.handlers.get(event) ?? [];
      const i = cur.indexOf(entry);
      if (i !== -1) cur.splice(i, 1);
    };
  }

  /** Register a handler that runs at most once. */
  once<T = unknown>(event: HookEventName, fn: HookHandler<T>, opts: HookHandlerOptions = {}): () => void {
    const wrapped: HookHandler<T> = (payload) => {
      unsub();
      return fn(payload);
    };
    const unsub = this.on(event, wrapped, opts);
    return unsub;
  }

  handlerCount(event: HookEventName): number {
    return this.handlers.get(event)?.length ?? 0;
  }

  /** Await every async handler fired so far (tests / graceful shutdown). */
  async flushAsync(): Promise<void> {
    while (this.pendingAsync.size > 0) {
      await Promise.allSettled([...this.pendingAsync]);
    }
  }

  private fireAsync(event: HookEventName, entry: HookEntry, payload: unknown): void {
    let p: Promise<void>;
    p = (async () => {
      try {
        await entry.fn(payload);
      } catch (err) {
        this.asyncErrors.push({ event, message: err instanceof Error ? err.message : String(err) });
      }
    })().finally(() => {
      this.pendingAsync.delete(p);
    });
    this.pendingAsync.add(p);
  }

  async emit<T = unknown>(event: HookEventName, payload: T): Promise<HookEmitResult> {
    const result: HookEmitResult = { cancelled: false, injections: [], errors: [], asyncFired: 0 };
    const list = [...(this.handlers.get(event) ?? [])];
    let currentPayload = payload;
    for (const entry of list) {
      if (entry.async) {
        result.asyncFired += 1;
        this.fireAsync(event, entry, currentPayload);
        continue;
      }
      try {
        const v = await entry.fn(currentPayload);
        if (isCancel(v) && GATE_HOOK_EVENTS.has(event)) {
          // permission.request is advisory by default: only handlers
          // explicitly granted block power (canBlock) may add a deny.
          const mayBlock = event === 'permission.request' ? entry.canBlock === true : true;
          if (mayBlock) {
            result.cancelled = true;
            if (result.reason === undefined) result.reason = v.reason;
          }
          // Keep running remaining handlers (they may clean up), but the
          // operation is cancelled regardless once a block lands.
        }
        if (INJECT_EVENTS.has(event) && isInject(v)) {
          result.injections.push(v.inject);
        }
        if (event === 'input.transform' && isTransform(v)) {
          result.transformed = v.transform;
          // Chain: later handlers see the transformed message.
          currentPayload = { ...(currentPayload as Record<string, unknown>), message: v.transform } as T;
        }
      } catch (err) {
        result.errors.push({ event, message: err instanceof Error ? err.message : String(err) });
      }
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// Shared verdict parsing (HTTP + prompt handlers)
// ---------------------------------------------------------------------------

/**
 * Interpret a JSON-ish verdict body from an HTTP or prompt handler.
 * Recognized shapes (first match wins):
 *   { "cancel": true, "reason"? }          → block
 *   { "block": true, "reason"? }           → block
 *   { "decision": "block"|"deny", ... }    → block
 *   { "decision": "allow", ... }           → no block (NEVER an approval
 *                                            upgrade — see the governance
 *                                            invariant in the header)
 *   { "allow": false, "reason"? }          → block
 *   { "inject": "..." }                    → inject
 *   { "transform": "..." }                 → transform
 * Anything else (including plain text) is a pass: no effect.
 */
export function parseHookVerdict(text: string): HookCancel | HookInject | HookTransform | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Lenient: scan for the first JSON object in the text (LLM replies).
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end <= start) return undefined;
    try {
      parsed = JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const o = parsed as Record<string, unknown>;
  const reason = typeof o.reason === 'string' ? o.reason : undefined;
  if (o.cancel === true || o.block === true) return { cancel: true, reason };
  if (o.decision === 'block' || o.decision === 'deny') return { cancel: true, reason };
  if (o.allow === false) return { cancel: true, reason };
  if (typeof o.inject === 'string' && o.inject) return { inject: o.inject };
  if (typeof o.transform === 'string') return { transform: o.transform };
  return undefined;
}

// ---------------------------------------------------------------------------
// Script hooks (Octomind parity: post-result script hooks)
// ---------------------------------------------------------------------------

/**
 * Build a hook handler that runs an external script (argv array, no
 * shell) with the event payload as JSON on stdin.
 *
 * The Octomind pattern: when the script FAILS (non-zero exit), its
 * stdout is injected into the agent's context as a correction — the
 * script is a check the agent must answer. A script may also inject
 * deliberately on success by printing {"inject": "..."} as its last
 * stdout line. Output is capped; spawn errors are treated as a failed
 * check with the error as the injection (fail-visible, never silent).
 */
export function createScriptHookHandler(
  command: string[],
  opts: { timeoutMs?: number; maxOutputChars?: number } = {},
): HookHandler {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxChars = opts.maxOutputChars ?? 4_000;
  return async (payload: unknown) => {
    const { execFile } = await import('node:child_process');
    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    try {
      const r = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        const child = execFile(
          command[0]!,
          command.slice(1),
          { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
          (err, out, errOut) => {
            if (err) {
              (err as { stdout?: string }).stdout = String(out ?? '');
              (err as { stderr?: string }).stderr = String(errOut ?? '');
              reject(err);
            } else {
              resolve({ stdout: String(out ?? ''), stderr: String(errOut ?? '') });
            }
          },
        );
        child.stdin?.end(JSON.stringify(payload ?? {}));
      });
      stdout = r.stdout;
      stderr = r.stderr;
    } catch (err) {
      const e = err as { stdout?: unknown; stderr?: unknown; code?: unknown };
      stdout = String(e.stdout ?? '');
      stderr = String(e.stderr ?? '');
      exitCode = typeof e.code === 'number' ? e.code : 1;
      if (!stdout && !stderr) {
        return {
          inject:
            `A check script (${command.join(' ')}) could not run cleanly: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
    const combined = (stdout + (stderr ? `\n[stderr]\n${stderr}` : '')).trim().slice(0, maxChars);
    if (exitCode !== 0) {
      return {
        inject:
          `A check script (${command.join(' ')}) failed with exit code ${exitCode}. ` +
          `Address its output before finishing:\n${combined || '(no output)'}`,
      };
    }
    // Deliberate injection on success: last JSON line with an inject field.
    const lines = stdout.trim().split('\n');
    const last = lines[lines.length - 1];
    if (last) {
      try {
        const parsed = JSON.parse(last) as { inject?: unknown };
        if (typeof parsed.inject === 'string' && parsed.inject) {
          return { inject: parsed.inject.slice(0, maxChars) };
        }
      } catch {
        // Not JSON — a passing script with plain output injects nothing.
      }
    }
    return undefined;
  };
}

// ---------------------------------------------------------------------------
// HTTP handlers (CA-1)
// ---------------------------------------------------------------------------

/** Minimal fetch shape so tests can inject a fake without a network. */
export type HookFetchFn = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{ status: number; text(): Promise<string> }>;

export interface HttpHookOptions {
  /** Event this handler instance is bound to (rides in the POST body). */
  event?: HookEventName;
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Test seam / custom transport. Defaults to the global fetch. */
  fetchFn?: HookFetchFn;
}

const defaultFetch: HookFetchFn = async (url, init) => {
  const res = await fetch(url, init);
  return { status: res.status, text: () => res.text() };
};

/**
 * Build a hook handler that POSTs the event payload as JSON to `url`.
 *
 * Request body: { event, payload, ts }. The response body is read as a
 * verdict via parseHookVerdict — an explicit block verdict blocks gate
 * events; inject/transform verdicts apply on the events that support
 * them. Everything else FAILS OPEN: timeouts, network errors, non-2xx
 * statuses, and unparseable bodies all mean "no effect", never a block
 * and never a thrown error. Only an explicit block response can block.
 */
export function createHttpHookHandler(url: string, opts: HttpHookOptions = {}): HookHandler {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const fetchFn = opts.fetchFn ?? defaultFetch;
  return async (payload: unknown) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
        body: JSON.stringify({ event: opts.event ?? null, payload: payload ?? null, ts: new Date().toISOString() }),
        signal: controller.signal,
      });
      if (res.status < 200 || res.status >= 300) return undefined; // fail-open
      const text = await res.text();
      return parseHookVerdict(text);
    } catch {
      return undefined; // timeout / network failure: fail-open
    } finally {
      clearTimeout(timer);
    }
  };
}

// ---------------------------------------------------------------------------
// Prompt handlers (CA-1): LLM-judged hooks behind a host-injected seam
// ---------------------------------------------------------------------------

/**
 * The evaluator seam for prompt hooks. The host injects an implementation
 * that renders a judgment with a small/cheap model and returns the raw
 * reply text; the handler parses a verdict out of it (parseHookVerdict).
 *
 * WIRING: use providerPromptEvaluator(provider) below to bind the seam
 * to the runtime's existing small-model path (evaluate.ts model
 * resolution: purpose profile → cheapest FREE model). When no evaluator
 * is injected, prompt handlers are inert (fail-open) — hosts that want
 * prompt hooks MUST pass an evaluator to registerHookConfig or call
 * createPromptHookHandler with one.
 */
export interface PromptHookEvaluator {
  (input: { prompt: string; event: HookEventName | null; payload: unknown }): Promise<string>;
}

export interface PromptHookOptions {
  event?: HookEventName;
  evaluator?: PromptHookEvaluator;
  timeoutMs?: number;
}

/** Render a prompt-hook template: {{event}}, {{payload}}, {{toolName}}, {{sessionId}}, {{botId}}. */
export function renderPromptHookTemplate(template: string, event: HookEventName | null, payload: unknown): string {
  const p = (payload ?? {}) as Record<string, unknown>;
  return template
    .replaceAll('{{event}}', event ?? '')
    .replaceAll('{{payload}}', JSON.stringify(payload ?? null))
    .replaceAll('{{toolName}}', typeof p.toolName === 'string' ? p.toolName : '')
    .replaceAll('{{sessionId}}', typeof p.sessionId === 'string' ? p.sessionId : '')
    .replaceAll('{{botId}}', typeof p.botId === 'string' ? p.botId : '');
}

async function withTimeout<T>(p: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('prompt hook evaluator timed out')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Build an LLM-judged hook handler. The evaluator receives the rendered
 * prompt template plus the event/payload; its reply is parsed as a
 * verdict. The evaluator is instructed (by convention of the default
 * templates hosts write) to reply with a JSON verdict — see
 * parseHookVerdict. No evaluator, a timeout, or an evaluator error all
 * fail open (no effect).
 */
export function createPromptHookHandler(template: string, opts: PromptHookOptions = {}): HookHandler {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  return async (payload: unknown) => {
    if (!opts.evaluator) return undefined; // unwired seam: inert, fail-open
    const prompt = renderPromptHookTemplate(template, opts.event ?? null, payload);
    try {
      const reply = await withTimeout(opts.evaluator({ prompt, event: opts.event ?? null, payload }), timeoutMs);
      return parseHookVerdict(reply);
    } catch {
      return undefined; // evaluator failure: fail-open
    }
  };
}

/**
 * Default PromptHookEvaluator backed by the runtime's existing
 * small-model path: the model is resolved exactly like evaluate.ts
 * resolves its judgment model (purpose profile → cheapest FREE model on
 * the provider). Returns an evaluator that yields '' (fail-open) when
 * no eligible model exists. Hosts wire it once:
 *   registerHookConfig(bus, entries, { evaluator: providerPromptEvaluator(provider) })
 */
export function providerPromptEvaluator(
  provider: LLMProvider,
  opts: { profiles?: import('./model-profiles.js').ModelProfiles } = {},
): PromptHookEvaluator {
  return async ({ prompt }) => {
    const { resolveEvaluateModel } = await import('./evaluate.js');
    const model = resolveEvaluateModel(provider, { profiles: opts.profiles });
    if (!model) return '';
    const res = await provider.chat(
      [
        {
          role: 'system',
          content:
            'You are a hook judge for an agent runtime. Reply with exactly one JSON object: ' +
            '{"decision": "allow"} to let the operation proceed, {"decision": "block", "reason": "..."} ' +
            'to block it, or {"inject": "..."} to add a note. Never output anything else.',
        },
        { role: 'user', content: prompt },
      ],
      [],
      { model, temperature: 0 },
    );
    return res.content ?? '';
  };
}

// ---------------------------------------------------------------------------
// Hook config parsing + registration (CA-1)
// ---------------------------------------------------------------------------
// Bot/project config shape (extends the Octomind script-hook shape):
//   hooks: [
//     { kind: 'script', command: ['node', 'check.mjs'], events: ['tool.after'] },
//     { kind: 'http',   url: 'https://…/hook', events: ['tool.before'], timeoutMs: 5000 },
//     { kind: 'prompt', prompt: 'Block if {{payload}} …', events: ['tool.before'] },
//   ]
// Common optional fields: events (default ['tool.after']), async (bool),
// timeoutMs, name, additionalDeny (bool — grants block power on
// permission.request; meaningless elsewhere).

export interface ScriptHookConfigEntry {
  kind: 'script';
  command: string[];
  events: HookEventName[];
  async?: boolean;
  timeoutMs?: number;
  name?: string;
  additionalDeny?: boolean;
}

export interface HttpHookConfigEntry {
  kind: 'http';
  url: string;
  events: HookEventName[];
  async?: boolean;
  timeoutMs?: number;
  headers?: Record<string, string>;
  name?: string;
  additionalDeny?: boolean;
}

export interface PromptHookConfigEntry {
  kind: 'prompt';
  prompt: string;
  events: HookEventName[];
  async?: boolean;
  timeoutMs?: number;
  name?: string;
  additionalDeny?: boolean;
}

export type HookConfigEntry = ScriptHookConfigEntry | HttpHookConfigEntry | PromptHookConfigEntry;

export interface HookConfigReport {
  entries: HookConfigEntry[];
  errors: string[];
}

function parseEvents(raw: unknown, i: number, errors: string[]): HookEventName[] | undefined {
  if (raw === undefined) return ['tool.after'];
  if (!Array.isArray(raw) || !raw.every((e) => (HOOK_EVENTS as readonly string[]).includes(e as string))) {
    errors.push(`hooks[${i}]: events must be a subset of ${HOOK_EVENTS.join(', ')}`);
    return undefined;
  }
  const events = [...new Set(raw as HookEventName[])];
  return events.length > 0 ? events : ['tool.after'];
}

/** Validate untrusted config into hook entries. Never throws; bad entries are reported and skipped. */
export function parseHookConfig(raw: unknown): HookConfigReport {
  const entries: HookConfigEntry[] = [];
  const errors: string[] = [];
  if (raw === undefined || raw === null) return { entries, errors };
  if (!Array.isArray(raw)) return { entries, errors: ['hooks must be an array'] };
  raw.forEach((item, i) => {
    if (!item || typeof item !== 'object') {
      errors.push(`hooks[${i}] is not an object`);
      return;
    }
    const o = item as Record<string, unknown>;
    const events = parseEvents(o.events, i, errors);
    if (!events) return;
    const common = {
      events,
      ...(o.async === true ? { async: true } : {}),
      ...(typeof o.timeoutMs === 'number' && o.timeoutMs > 0 ? { timeoutMs: o.timeoutMs } : {}),
      ...(typeof o.name === 'string' && o.name ? { name: o.name } : {}),
      ...(o.additionalDeny === true ? { additionalDeny: true } : {}),
    };
    if (o.kind === 'script') {
      const command = o.command;
      if (
        !Array.isArray(command) ||
        command.length === 0 ||
        !command.every((c) => typeof c === 'string' && c.length > 0)
      ) {
        errors.push(`hooks[${i}]: script hook needs a non-empty string argv "command"`);
        return;
      }
      entries.push({ kind: 'script', command: [...(command as string[])], ...common });
    } else if (o.kind === 'http') {
      if (typeof o.url !== 'string' || !/^https?:\/\//.test(o.url)) {
        errors.push(`hooks[${i}]: http hook needs an http(s) "url"`);
        return;
      }
      const headers =
        o.headers && typeof o.headers === 'object' && !Array.isArray(o.headers)
          ? Object.fromEntries(
              Object.entries(o.headers as Record<string, unknown>).filter(
                (kv): kv is [string, string] => typeof kv[1] === 'string',
              ),
            )
          : undefined;
      entries.push({ kind: 'http', url: o.url, ...(headers ? { headers } : {}), ...common });
    } else if (o.kind === 'prompt') {
      if (typeof o.prompt !== 'string' || !o.prompt.trim()) {
        errors.push(`hooks[${i}]: prompt hook needs a non-empty "prompt"`);
        return;
      }
      entries.push({ kind: 'prompt', prompt: o.prompt, ...common });
    } else {
      errors.push(`hooks[${i}]: unknown hook kind "${String(o.kind)}" (expected script|http|prompt)`);
    }
  });
  return { entries, errors };
}

/** Read the `hooks` field off a bot/workspace config object. */
export function hooksFromConfig(config: { hooks?: unknown } | null | undefined): HookConfigReport {
  return parseHookConfig(config?.hooks);
}

export interface RegisterHookConfigOptions {
  /** Evaluator seam for prompt hooks (see providerPromptEvaluator). */
  evaluator?: PromptHookEvaluator;
  /** Transport seam for HTTP hooks (tests). */
  fetchFn?: HookFetchFn;
  /** Handler factories (tests). */
  createScript?: typeof createScriptHookHandler;
  createHttp?: typeof createHttpHookHandler;
  createPrompt?: typeof createPromptHookHandler;
}

/**
 * Register every config entry on the bus — one handler per (entry,
 * event), honoring each entry's async flag and additionalDeny grant.
 * Returns unsubscribe functions plus the registration count.
 */
export function registerHookConfig(
  bus: HookBus,
  entries: HookConfigEntry[],
  opts: RegisterHookConfigOptions = {},
): { unsubs: Array<() => void>; registered: number } {
  const createScript = opts.createScript ?? createScriptHookHandler;
  const createHttp = opts.createHttp ?? createHttpHookHandler;
  const createPrompt = opts.createPrompt ?? createPromptHookHandler;
  const unsubs: Array<() => void> = [];
  for (const entry of entries) {
    for (const event of entry.events) {
      let handler: HookHandler;
      if (entry.kind === 'script') {
        handler = createScript(entry.command, entry.timeoutMs ? { timeoutMs: entry.timeoutMs } : {});
      } else if (entry.kind === 'http') {
        handler = createHttp(entry.url, {
          event,
          ...(entry.timeoutMs ? { timeoutMs: entry.timeoutMs } : {}),
          ...(entry.headers ? { headers: entry.headers } : {}),
          ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
        });
      } else {
        handler = createPrompt(entry.prompt, {
          event,
          ...(entry.timeoutMs ? { timeoutMs: entry.timeoutMs } : {}),
          ...(opts.evaluator ? { evaluator: opts.evaluator } : {}),
        });
      }
      unsubs.push(
        bus.on(event, handler, {
          async: entry.async === true,
          // Only meaningful on permission.request; harmless elsewhere.
          canBlock: entry.additionalDeny === true,
        }),
      );
    }
  }
  return { unsubs, registered: unsubs.length };
}

/** Parse + register a bot/workspace config's hooks in one call. */
export function installConfigHooks(
  bus: HookBus,
  config: { hooks?: unknown } | null | undefined,
  opts: RegisterHookConfigOptions = {},
): { unsubs: Array<() => void>; errors: string[]; registered: number } {
  const { entries, errors } = hooksFromConfig(config);
  const { unsubs, registered } = registerHookConfig(bus, entries, opts);
  return { unsubs, errors, registered };
}

// ---------------------------------------------------------------------------
// Plugin loading
// ---------------------------------------------------------------------------

export interface LoadedPlugin {
  name: string;
  version?: string;
  file: string;
}

export interface PluginLoadReport {
  loaded: LoadedPlugin[];
  /** Files that failed to load or had no activate export — { file, error }. */
  failed: Array<{ file: string; error: string }>;
}

interface PluginModule {
  default?: unknown;
  activate?: unknown;
  name?: unknown;
  version?: unknown;
}

function pickActivate(mod: PluginModule): ((bus: HookBus) => void | Promise<void>) | undefined {
  if (typeof mod.activate === 'function') return mod.activate as (bus: HookBus) => void | Promise<void>;
  if (typeof mod.default === 'function') return mod.default as (bus: HookBus) => void | Promise<void>;
  return undefined;
}

function pickMeta(mod: PluginModule, activate: (bus: HookBus) => void | Promise<void>, file: string): LoadedPlugin {
  const attached = (activate as { pluginName?: unknown; pluginVersion?: unknown }) ?? {};
  const name =
    typeof mod.name === 'string'
      ? mod.name
      : typeof attached.pluginName === 'string'
        ? attached.pluginName
        : file;
  const version = typeof mod.version === 'string' ? mod.version : undefined;
  return { name, version, file };
}

/**
 * Load every `.js`/`.mjs` plugin module in `dir` and call its activate
 * function with the bus. Activation errors are collected into the report;
 * the bus keeps working for the plugins that did load.
 */
export async function loadPlugins(dir: string, bus: HookBus): Promise<PluginLoadReport> {
  const report: PluginLoadReport = { loaded: [], failed: [] };
  let entries: Array<{ name: string; isFile(): boolean }>;
  try {
    const { readdirSync } = await import('node:fs');
    entries = readdirSync(dir, { withFileTypes: true }) as Array<{ name: string; isFile(): boolean }>;
  } catch {
    return report; // missing dir => nothing to load, not an error
  }
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isFile() || !/\.(mjs|js)$/.test(e.name)) continue;
    const file = join(dir, e.name);
    try {
      const mod = (await import(pathToFileURL(file).href)) as PluginModule;
      const activate = pickActivate(mod);
      if (!activate) {
        report.failed.push({ file, error: 'no activate function (default or named export)' });
        continue;
      }
      await activate(bus);
      report.loaded.push(pickMeta(mod, activate, e.name));
    } catch (err) {
      report.failed.push({ file, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return report;
}
