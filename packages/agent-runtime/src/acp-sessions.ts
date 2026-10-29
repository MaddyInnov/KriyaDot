// SPDX-License-Identifier: Apache-2.0
//
// Full ACP (Agent Client Protocol) session management — OpenMausBot parity
// P1 #26 (ACP completion).
//
// The minimal stdio JSON-RPC client lives in acp.ts (initialize / prompt /
// cancel). This module adds the session layer on top of it:
//
//   - session lifecycle: create / resume / list / get / close (persisted in
//     SQLite `acp-sessions.db`, including a full transcript)
//   - streaming prompts: the agent may emit `session/update` text chunks
//     while a `prompt` request is in flight
//   - tool-call bridging: agent-initiated `tool_call` notifications are
//     offered to the caller through an injectable approval hook; the
//     verdict flows back to the agent via `tool_result`
//   - cancellation: an in-flight prompt can be aborted by the user
//   - error mapping: spawn/timeout/protocol/process failures become
//     readable AcpSessionError values with a stable `kind`
//
// Trust model: an external ACP agent is UNTRUSTED by definition. All agent
// text is defused (invisible-unicode + fence-forgery neutralization) before
// it is stored or emitted, and `toFencedContext()` wraps it in the
// <<<UNTRUSTED PEER CONTENT>>> fence with a provenance header before it may
// enter any bot prompt — the same hardening as cross-bot provenance
// (provenance.ts). Tool calls the agent requests never execute locally:
// they are only ever offered to the human through the approval hook.

import { randomUUID } from 'node:crypto';
import { AcpClient, AcpError } from './acp.js';
import { defusePeerText, wrapPeerContent, type ProvenanceNote } from './provenance.js';

import { openDb } from './sqlite.js';
import type { DatabaseSync } from 'node:sqlite';

export type AcpSessionStatus = 'active' | 'busy' | 'closed' | 'error';

export interface AcpSession {
  id: string;
  label: string;
  command: string;
  args: string[];
  cwd?: string;
  agentName: string;
  status: AcpSessionStatus;
  createdAt: string;
  updatedAt: string;
}

export type AcpTranscriptType = 'user' | 'agent' | 'tool_call' | 'tool_result' | 'system' | 'error';

export interface AcpTranscriptEvent {
  seq: number;
  type: AcpTranscriptType;
  /** Defused raw text (display-safe). Agent text is UNTRUSTED — see `untrusted`. */
  text: string;
  /** True for agent/tool_result content: never feed to a model without fencing. */
  untrusted: boolean;
  toolCallId?: string;
  toolName?: string;
  ts: string;
}

export type AcpSessionErrorKind =
  | 'busy'
  | 'not-found'
  | 'closed'
  | 'spawn-failed'
  | 'timeout'
  | 'agent-error'
  | 'disconnected'
  | 'cancelled'
  | 'approval-denied'
  | 'unknown';

export class AcpSessionError extends Error {
  readonly kind: AcpSessionErrorKind;
  constructor(kind: AcpSessionErrorKind, message: string) {
    super(message);
    this.name = 'AcpSessionError';
    this.kind = kind;
  }
}

/** Map raw failures into readable, stable-kind errors. */
export function mapAcpError(err: unknown): AcpSessionError {
  if (err instanceof AcpSessionError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (/timed out/i.test(message)) {
    return new AcpSessionError('timeout', `The external agent did not respond in time. ${message}`);
  }
  if (/ENOENT|spawn failed|spawn .* failed/i.test(message)) {
    return new AcpSessionError(
      'spawn-failed',
      `Could not start the external agent process. Check the command is installed and on PATH. ${message}`,
    );
  }
  if (/process exited|client is not connected|client closed/i.test(message)) {
    return new AcpSessionError('disconnected', `The external agent process ended unexpectedly. ${message}`);
  }
  if (/^ACP error:/i.test(message)) {
    return new AcpSessionError('agent-error', `The external agent reported an error. ${message.replace(/^ACP error:\s*/i, '')}`);
  }
  if (err instanceof AcpError) {
    return new AcpSessionError('agent-error', `ACP protocol error. ${message}`);
  }
  return new AcpSessionError('unknown', `External agent failure. ${message}`);
}

export interface AcpToolCall {
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
}

export interface AcpToolVerdict {
  approved: boolean;
  /** Result text handed back to the agent (approved only). */
  output?: string;
  /** Human-readable reason (denied only). */
  error?: string;
}

export type AcpStreamEvent =
  | { type: 'chunk'; text: string }
  | { type: 'tool_call'; toolCall: AcpToolCall }
  | { type: 'tool_result'; toolCallId: string; approved: boolean }
  | { type: 'done'; text: string }
  | { type: 'error'; kind: AcpSessionErrorKind; message: string }
  | { type: 'cancelled' };

export interface AcpPromptHooks {
  onEvent?: (event: AcpStreamEvent) => void;
  /**
   * Offer an agent-requested tool call to the human. Must resolve with the
   * verdict; may throw (treated as denied). When absent, tool calls are
   * denied automatically.
   */
  requestToolApproval?: (toolCall: AcpToolCall) => Promise<AcpToolVerdict>;
  /** Per-prompt timeout ms (default 120s, matches the client default). */
  timeoutMs?: number;
}

export interface AcpCreateOptions {
  command: string;
  args?: string[];
  label?: string;
  /** Working directory for the agent. Required (L4): no ambient default. */
  cwd: string;
  /**
   * Extra spawn env for the agent process (ENGINES pack: preset env +
   * per-engine home overrides). Held in memory only — never persisted to
   * the session store, so a resumed-after-restart session spawns with the
   * default environment unless the host re-creates it.
   */
  env?: Record<string, string>;
}

/** SQLite-backed session + transcript store. */
export class AcpSessionStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    this.db = openDb(`${dataDir.replace(/\/$/, '')}/acp-sessions.db`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS acp_sessions (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        command TEXT NOT NULL,
        args_json TEXT NOT NULL DEFAULT '[]',
        cwd TEXT,
        agent_name TEXT NOT NULL DEFAULT 'unknown',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS acp_transcript (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        text TEXT NOT NULL DEFAULT '',
        untrusted INTEGER NOT NULL DEFAULT 0,
        tool_call_id TEXT,
        tool_name TEXT,
        ts TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  insertSession(s: Omit<AcpSession, 'status' | 'createdAt' | 'updatedAt'> & { agentName: string }): AcpSession {
    const now = new Date().toISOString();
    const row: AcpSession = { ...s, status: 'active', createdAt: now, updatedAt: now };
    this.db
      .prepare(
        'INSERT INTO acp_sessions (id, label, command, args_json, cwd, agent_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(row.id, row.label, row.command, JSON.stringify(row.args), row.cwd ?? null, row.agentName, row.status, now, now);
    return row;
  }

  getSession(id: string): AcpSession | null {
    const row = this.db.prepare('SELECT * FROM acp_sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToSession(row) : null;
  }

  listSessions(): AcpSession[] {
    const rows = this.db.prepare('SELECT * FROM acp_sessions ORDER BY updated_at DESC').all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToSession(r));
  }

  updateSession(id: string, patch: { status?: AcpSessionStatus; agentName?: string }): void {
    const sets: string[] = [];
    const vals: Array<string | number | null> = [];
    if (patch.status) {
      sets.push('status = ?');
      vals.push(patch.status);
    }
    if (patch.agentName) {
      sets.push('agent_name = ?');
      vals.push(patch.agentName);
    }
    sets.push('updated_at = ?');
    vals.push(new Date().toISOString());
    vals.push(id);
    this.db.prepare(`UPDATE acp_sessions SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM acp_transcript WHERE session_id = ?').run(id);
    this.db.prepare('DELETE FROM acp_sessions WHERE id = ?').run(id);
  }

  appendTranscript(sessionId: string, type: AcpTranscriptType, text: string, opts?: { untrusted?: boolean; toolCallId?: string; toolName?: string }): AcpTranscriptEvent {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), -1) AS max_seq FROM acp_transcript WHERE session_id = ?')
      .get(sessionId) as { max_seq: number };
    const seq = (row?.max_seq ?? -1) + 1;
    const ts = new Date().toISOString();
    this.db
      .prepare(
        'INSERT INTO acp_transcript (session_id, seq, type, text, untrusted, tool_call_id, tool_name, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(sessionId, seq, type, text, opts?.untrusted ? 1 : 0, opts?.toolCallId ?? null, opts?.toolName ?? null, ts);
    return { seq, type, text, untrusted: !!opts?.untrusted, ...(opts?.toolCallId ? { toolCallId: opts.toolCallId } : {}), ...(opts?.toolName ? { toolName: opts.toolName } : {}), ts };
  }

  getTranscript(sessionId: string, limit = 200): AcpTranscriptEvent[] {
    const rows = this.db
      .prepare('SELECT seq, type, text, untrusted, tool_call_id, tool_name, ts FROM acp_transcript WHERE session_id = ? ORDER BY seq ASC LIMIT ?')
      .all(sessionId, Math.min(Math.max(limit, 1), 1000)) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      seq: r.seq as number,
      type: r.type as AcpTranscriptType,
      text: r.text as string,
      untrusted: (r.untrusted as number) === 1,
      ...(typeof r.tool_call_id === 'string' && r.tool_call_id ? { toolCallId: r.tool_call_id } : {}),
      ...(typeof r.tool_name === 'string' && r.tool_name ? { toolName: r.tool_name } : {}),
      ts: r.ts as string,
    }));
  }

  private rowToSession(row: Record<string, unknown>): AcpSession {
    let args: string[] = [];
    try {
      const parsed: unknown = JSON.parse(String(row.args_json ?? '[]'));
      if (Array.isArray(parsed)) args = parsed.filter((a): a is string => typeof a === 'string');
    } catch {
      args = [];
    }
    return {
      id: String(row.id),
      label: String(row.label),
      command: String(row.command),
      args,
      ...(typeof row.cwd === 'string' && row.cwd ? { cwd: row.cwd } : {}),
      agentName: String(row.agent_name ?? 'unknown'),
      status: row.status as AcpSessionStatus,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
}

interface LiveClient {
  client: AcpClient;
  sessionId: string;
  agentName: string;
}

interface InFlight {
  cancel: () => void;
  toolQueue: AcpToolCall[];
  notifyToolCall: () => void;
}

/**
 * Owns live ACP processes and the prompt pipeline (streaming + tool-call
 * bridging + cancellation). Pure runtime code: the human approval step is
 * injected via hooks so tests and headless hosts can decide.
 */
export class AcpSessionManager {
  private readonly store: AcpSessionStore;
  private readonly live = new Map<string, LiveClient>();
  private readonly inFlight = new Map<string, InFlight>();
  /** Per-session spawn env (memory-only; see AcpCreateOptions.env). */
  private readonly spawnEnv = new Map<string, Record<string, string>>();

  constructor(store: AcpSessionStore) {
    this.store = store;
  }

  /** Close all live processes (host shutdown). */
  closeAll(): void {
    for (const [, rec] of this.live) {
      try {
        rec.client.close();
      } catch {
        // ignore
      }
    }
    this.live.clear();
    for (const [, f] of this.inFlight) {
      try {
        f.cancel();
      } catch {
        // ignore
      }
    }
    this.inFlight.clear();
  }

  async createSession(opts: AcpCreateOptions): Promise<AcpSession> {
    const command = opts.command?.trim();
    if (!command) throw new AcpSessionError('spawn-failed', 'A command is required to start an external ACP agent.');
    const args = Array.isArray(opts.args) ? opts.args.filter((a) => typeof a === 'string') : [];
    const id = `acp_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const label = opts.label?.trim().slice(0, 80) || command.split(/\s+/)[0] || 'acp-agent';
    const session = this.store.insertSession({ id, label, command, args, cwd: opts.cwd, agentName: 'unknown' });
    if (opts.env && Object.keys(opts.env).length > 0) this.spawnEnv.set(id, { ...opts.env });
    try {
      const agentName = await this.attach(id, session);
      this.store.updateSession(id, { agentName });
      const updated = this.store.getSession(id)!;
      this.store.appendTranscript(id, 'system', `Connected to external agent "${agentName}". All agent content is untrusted.`);
      return updated;
    } catch (err) {
      this.store.updateSession(id, { status: 'error' });
      this.store.appendTranscript(id, 'error', mapAcpError(err).message);
      throw mapAcpError(err);
    }
  }

  /** Reconnect a live client for an existing session (idempotent). */
  async resumeSession(id: string): Promise<AcpSession> {
    const session = this.requireSession(id);
    const existing = this.live.get(id);
    if (existing?.client.isConnected()) return session;
    // Drop a stale record so a fresh process is spawned below.
    if (existing) this.live.delete(id);
    if (session.status === 'closed') {
      throw new AcpSessionError('closed', 'This ACP session is closed. Create a new session instead.');
    }
    const agentName = await this.attach(id, session);
    this.store.updateSession(id, { status: 'active', agentName });
    this.store.appendTranscript(id, 'system', `Reconnected to external agent "${agentName}".`);
    return this.store.getSession(id)!;
  }

  listSessions(): AcpSession[] {
    return this.store.listSessions();
  }

  getSession(id: string): AcpSession {
    return this.requireSession(id);
  }

  getTranscript(id: string, limit?: number): AcpTranscriptEvent[] {
    this.requireSession(id);
    return this.store.getTranscript(id, limit);
  }

  async closeSession(id: string): Promise<void> {
    const session = this.requireSession(id);
    const flight = this.inFlight.get(id);
    if (flight) flight.cancel();
    const rec = this.live.get(id);
    if (rec) {
      try {
        rec.client.close();
      } catch {
        // ignore
      }
      this.live.delete(id);
    }
    this.spawnEnv.delete(id);
    this.store.updateSession(session.id, { status: 'closed' });
    this.store.appendTranscript(id, 'system', 'Session closed.');
    this.store.deleteSession(id);
  }

  /** Abort the in-flight prompt for a session (user cancel). */
  cancelPrompt(id: string): boolean {
    const flight = this.inFlight.get(id);
    if (!flight) return false;
    flight.cancel();
    return true;
  }

  /**
   * Send a prompt and stream the agent's reply. Agent-initiated tool calls
   * are bridged through `hooks.requestToolApproval`; without the hook they
   * are denied automatically. Resolves with the final (defused) agent text.
   */
  async prompt(id: string, text: string, hooks: AcpPromptHooks = {}): Promise<string> {
    const session = this.requireSession(id);
    const rec = await this.ensureLive(id, session);
    if (this.inFlight.has(id)) {
      throw new AcpSessionError('busy', 'This ACP session already has a prompt in flight. Cancel it first.');
    }
    const message = text?.trim();
    if (!message) throw new AcpSessionError('unknown', 'Prompt text is required.');
    if (message.length > 200_000) throw new AcpSessionError('unknown', 'Prompt is too long (max 200,000 characters).');

    this.store.appendTranscript(id, 'user', message.slice(0, 20_000));
    this.store.updateSession(id, { status: 'busy' });
    const emit = hooks.onEvent;

    let cancelFn: () => void = () => undefined;
    const cancelled = new Promise<never>((_, reject) => {
      cancelFn = () => reject(new AcpSessionError('cancelled', 'Prompt cancelled.'));
    });
    const flight: InFlight = { cancel: cancelFn, toolQueue: [], notifyToolCall: () => undefined };
    this.inFlight.set(id, flight);

    try {
      const finalText = await Promise.race([this.runPrompt(rec, id, message, hooks, flight, emit), cancelled]);
      const defused = defusePeerText(finalText);
      this.store.appendTranscript(id, 'agent', defused, { untrusted: true });
      this.store.updateSession(id, { status: 'active' });
      emit?.({ type: 'done', text: defused });
      return defused;
    } catch (err) {
      const mapped = mapAcpError(err);
      this.store.updateSession(id, { status: mapped.kind === 'cancelled' ? 'active' : 'error' });
      this.store.appendTranscript(id, mapped.kind === 'cancelled' ? 'system' : 'error', mapped.message);
      if (mapped.kind === 'cancelled') emit?.({ type: 'cancelled' });
      else emit?.({ type: 'error', kind: mapped.kind, message: mapped.message });
      // A dead process is dropped so the next prompt resumes cleanly.
      if (mapped.kind === 'disconnected' || mapped.kind === 'spawn-failed') this.live.delete(id);
      throw mapped;
    } finally {
      this.inFlight.delete(id);
    }
  }

  /**
   * Render transcript events as model-safe context: agent/tool content is
   * defused and wrapped in the untrusted fence with a provenance header.
   * Use this (never raw transcript text) when ACP content enters a bot prompt.
   */
  toFencedContext(session: AcpSession, events: AcpTranscriptEvent[]): string {
    const note: ProvenanceNote = {
      origin: 'external',
      originBotName: session.agentName,
      relayPath: [],
      timestamp: new Date().toISOString(),
    };
    return events
      .map((e) => {
        if (e.untrusted) return wrapPeerContent(e.text, note);
        if (e.type === 'tool_call') return `[External agent tool call: ${e.toolName ?? 'unknown'}]`;
        return e.text;
      })
      .join('\n\n');
  }

  // ---- internals ----

  private requireSession(id: string): AcpSession {
    const session = this.store.getSession(id);
    if (!session) throw new AcpSessionError('not-found', `No ACP session "${id}".`);
    return session;
  }

  private async attach(id: string, session: AcpSession): Promise<string> {
    const env = this.spawnEnv.get(id);
    const client = new AcpClient({
      command: session.command,
      args: session.args,
      // AcpClient requires an explicit cwd (L4). Sessions created before
      // that carry no cwd — fall back explicitly here (caller-visible
      // choice) rather than inside the client.
      cwd: session.cwd ?? process.cwd(),
      ...(env ? { env } : {}),
      onNotification: (method, params) => this.handleNotification(id, method, params),
    });
    let agentName = 'unknown';
    try {
      const info = await client.connect();
      agentName = info.agentName || 'unknown';
    } catch (err) {
      try {
        client.close();
      } catch {
        // ignore
      }
      throw mapAcpError(err);
    }
    this.live.set(id, { client, sessionId: id, agentName });
    return agentName;
  }

  private async ensureLive(id: string, session: AcpSession): Promise<LiveClient> {
    const rec = this.live.get(id);
    if (rec) return rec;
    if (session.status === 'closed') throw new AcpSessionError('closed', 'This ACP session is closed.');
    await this.resumeSession(id);
    const fresh = this.live.get(id);
    if (!fresh) throw new AcpSessionError('disconnected', 'Could not reconnect the external agent.');
    return fresh;
  }

  private handleNotification(id: string, method: string, params: unknown): void {
    const flight = this.inFlight.get(id);
    if (!flight) return; // no prompt in flight — nothing to bridge
    const p = params as { sessionId?: string; toolCallId?: string; id?: string; name?: string; tool?: string; args?: unknown } | undefined;
    // Accept both a dedicated `tool_call` notification and the
    // `session/update` envelope with kind 'tool_call'.
    let name: string | undefined;
    let toolCallId: string | undefined;
    let args: Record<string, unknown> = {};
    if (method === 'tool_call') {
      name = p?.name ?? p?.tool;
      toolCallId = p?.toolCallId ?? p?.id;
    } else if (method === 'session/update') {
      const up = (p as { update?: { kind?: string; name?: string; tool?: string; toolCallId?: string; id?: string; args?: unknown } } | undefined)?.update;
      if (up?.kind === 'tool_call') {
        name = up.name ?? up.tool;
        toolCallId = up.toolCallId ?? up.id;
        if (up.args && typeof up.args === 'object') args = up.args as Record<string, unknown>;
      }
    }
    if (!name || !toolCallId) return;
    if (p && typeof p === 'object' && 'args' in p && p.args && typeof p.args === 'object') {
      args = p.args as Record<string, unknown>;
    }
    flight.toolQueue.push({ toolCallId, name: String(name).slice(0, 128), args });
    flight.notifyToolCall();
  }

  private async runPrompt(
    rec: LiveClient,
    id: string,
    message: string,
    hooks: AcpPromptHooks,
    flight: InFlight,
    emit?: (e: AcpStreamEvent) => void,
  ): Promise<string> {
    let streamed = '';
    const onChunk = (chunk: string): void => {
      const defused = defusePeerText(chunk);
      streamed += defused;
      emit?.({ type: 'chunk', text: defused });
    };

    const promptPromise = rec.client.promptStream(message, {
      sessionId: rec.sessionId,
      ...(hooks.timeoutMs !== undefined ? { timeoutMs: hooks.timeoutMs } : {}),
      onChunk,
    });

    // Drain agent-initiated tool calls while the prompt is in flight. Each
    // call is offered to the human; the verdict flows back via tool_result.
    const waitForToolCall = (): Promise<AcpToolCall | null> =>
      new Promise((resolve) => {
        const next = flight.toolQueue.shift();
        if (next) {
          resolve(next);
          return;
        }
        flight.notifyToolCall = () => {
          const queued = flight.toolQueue.shift();
          flight.notifyToolCall = () => undefined;
          resolve(queued ?? null);
        };
      });

    let settled: { text: string } | null = null;
    promptPromise.then(
      (r) => {
        settled = r;
      },
      () => {
        // Rejection surfaces via the outer await below.
      },
    );

    while (!settled) {
      const next = await Promise.race([
        promptPromise.then((r) => ({ kind: 'done' as const, result: r })),
        waitForToolCall().then((tc) => ({ kind: 'tool' as const, toolCall: tc })),
      ]);
      if (next.kind === 'done') {
        settled = next.result;
        break;
      }
      const tc = next.toolCall;
      if (!tc) continue;
      // A tool call arrived with no waiter — shouldn't happen, but stay safe.
      await this.bridgeToolCall(rec, id, tc, hooks, emit);
    }
    // promptPromise already resolved here (settled), but await it to surface
    // a rejection if the loop above exited on the tool path.
    const result = await promptPromise;
    return result.text || streamed;
  }

  private async bridgeToolCall(
    rec: LiveClient,
    id: string,
    tc: AcpToolCall,
    hooks: AcpPromptHooks,
    emit?: (e: AcpStreamEvent) => void,
  ): Promise<void> {
    const defusedArgs = JSON.parse(JSON.stringify(tc.args)) as Record<string, unknown>;
    this.store.appendTranscript(id, 'tool_call', `Tool call: ${tc.name}`, { toolCallId: tc.toolCallId, toolName: tc.name });
    emit?.({ type: 'tool_call', toolCall: { ...tc, args: defusedArgs } });

    let verdict: AcpToolVerdict;
    try {
      verdict = hooks.requestToolApproval
        ? await hooks.requestToolApproval({ toolCallId: tc.toolCallId, name: tc.name, args: defusedArgs })
        : { approved: false, error: 'No approval handler attached — tool calls are denied by default.' };
    } catch (err) {
      verdict = { approved: false, error: err instanceof Error ? err.message : 'Approval failed.' };
    }
    if (!verdict.approved) {
      const reason = verdict.error || 'Denied by the user.';
      this.store.appendTranscript(id, 'tool_result', `Denied: ${reason}`, { toolCallId: tc.toolCallId, toolName: tc.name });
      emit?.({ type: 'tool_result', toolCallId: tc.toolCallId, approved: false });
      try {
        await rec.client.sendToolResult(tc.toolCallId, { approved: false, error: reason }, 10_000);
      } catch {
        // The agent may have moved on; denial is already recorded.
      }
      return;
    }
    const output = defusePeerText(String(verdict.output ?? ''));
    this.store.appendTranscript(id, 'tool_result', output, { untrusted: true, toolCallId: tc.toolCallId, toolName: tc.name });
    emit?.({ type: 'tool_result', toolCallId: tc.toolCallId, approved: true });
    // Best-effort ack with a short timeout: the agent's real continuation
    // signal is its eventual prompt response, so a missing tool_result ack
    // must not stall the pipeline.
    try {
      await rec.client.sendToolResult(tc.toolCallId, { approved: true, output }, 10_000);
    } catch {
      // The agent may have moved on; approval is already recorded.
    }
  }
}
