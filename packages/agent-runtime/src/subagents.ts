// SPDX-License-Identifier: Apache-2.0

import type { AuditEntry } from './governance.js';
import type { TokenUsage } from './types.js';
import type { ProvenanceNote } from './provenance.js';
import { SubagentStore } from './subagent-store.js';

/**
 * Host-injected implementation of an actual subagent run. The host (top-level
 * coordinator) wires the real thing: it creates a child AgentRuntime turn
 * under the SAME governance policy as the parent, with a tool subset and a
 * bounded nesting depth, then returns the child's final text.
 *
 * - `task`: the subtask description handed to the child.
 * - `tools`: tool names the child may use. When undefined the host SHOULD
 *   default to the parent bot's tool set MINUS `delegate` (no unbounded
 *   recursion) — the delegate tool also strips `delegate` from explicit
 *   lists before calling.
 * - `botId`: optional bot identity for the child (defaults to the parent's).
 * - `parentSessionId`: the session the delegate call came from (provenance).
 */
export interface SubagentSpawnInput {
  task: string;
  tools?: string[];
  botId?: string;
  parentSessionId: string;
  /**
   * The store-minted child session id (spawnSubagent fills this in).
   * Hosts SHOULD use it as the child's runtime session id so that
   * SubagentStore.getDepth() walks the real session chain and the nesting
   * limit holds for grandchildren. Optional for backward compatibility.
   */
  sessionId?: string;
  /**
   * Provenance for the child's turn (P1 #13): the parent's origin note with
   * the relay path extended. Hosts SHOULD forward it to runTurn so the
   * consent rule and untrusted-content fencing apply to the child.
   */
  provenance?: ProvenanceNote;
}

export interface SubagentSpawnResult {
  result: string;
  usage?: TokenUsage;
  /** The child's session id, if the host created one (used for depth walks). */
  sessionId?: string;
}

export type SubagentSpawnFn = (input: SubagentSpawnInput) => Promise<SubagentSpawnResult>;

/**
 * Audit sink for subagent lifecycle events. The host passes the real audit
 * function (the same one feeding the Audit/Activity UI); tests pass a
 * recorder. Emitted types: `subagent.spawned`, `subagent.finished`
 * (detail.status is 'done' | 'failed'). Entries carry the PARENT session/bot
 * ids so they surface next to the parent's own activity in the UI.
 */
export type SubagentAuditFn = (entry: Omit<AuditEntry, 'ts'>) => void | Promise<void>;

/** Default nesting cap: root session (depth 0) → child (1) → grandchild (2); depth 2 cannot delegate. */
export const MAX_SUBAGENT_DEPTH = 2;

function newSessionId(): string {
  return `sub_sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export interface SpawnSubagentOptions {
  store: SubagentStore;
  spawn: SubagentSpawnFn;
  audit?: SubagentAuditFn;
  /** Override the nesting cap (default MAX_SUBAGENT_DEPTH). */
  maxDepth?: number;
  parentBotId: string;
  parentSessionId: string;
  task: string;
  tools?: string[];
  botId?: string;
  /** Provenance forwarded to the child's spawn input (P1 #13). */
  provenance?: ProvenanceNote;
}

/**
 * Spawn a subagent with full bookkeeping:
 *  1. Enforce the nesting depth limit (fail closed — throw before recording).
 *  2. Record a `running` row in the SubagentStore + audit `subagent.spawned`.
 *  3. Call the host's `spawn` implementation.
 *  4. On resolve: mark `done` (persist usage) + audit `subagent.finished`.
 *     On reject: mark `failed` + audit `subagent.finished` (status failed).
 *
 * Returns the spawn result plus the store record id.
 */
export async function spawnSubagent(
  opts: SpawnSubagentOptions,
): Promise<SubagentSpawnResult & { subagentId: string }> {
  const { store, spawn, audit, parentBotId, parentSessionId, task } = opts;
  const maxDepth = opts.maxDepth ?? MAX_SUBAGENT_DEPTH;

  const depth = store.getDepth(parentSessionId);
  if (depth >= maxDepth) {
    throw new Error(
      `Subagent nesting limit reached (depth ${depth}, max ${maxDepth}): ` +
        'a subagent this deep cannot delegate further. ' +
        'Complete the work in this agent instead of spawning another.',
    );
  }

  const record = store.spawnChild({
    sessionId: newSessionId(),
    parentSessionId,
    parentBotId,
    task,
  });
  const emit = (entry: Omit<AuditEntry, 'ts'>): void => {
    try {
      const res = audit?.(entry);
      if (res instanceof Promise) res.catch(() => undefined);
    } catch {
      // audit failures must never break the spawn path
    }
  };

  emit({
    type: 'subagent.spawned',
    sessionId: parentSessionId,
    botId: parentBotId,
    detail: { subagentId: record.id, task },
  });

  try {
    const result = await spawn({
      task,
      tools: opts.tools,
      botId: opts.botId ?? parentBotId,
      parentSessionId,
      // Hand the minted child session id to the host so the child's runtime
      // session matches the store record — depth walks then follow the real
      // chain (grandchild delegation is correctly depth-limited).
      sessionId: record.sessionId,
      provenance: opts.provenance,
    });
    // If the host minted its own child session, prefer it for the record so
    // depth walks follow the real session chain.
    if (result.sessionId && result.sessionId !== record.sessionId) {
      // Keep the record's sessionId as the stable id we minted; the host's
      // id is returned to the caller. (A future revision could link both.)
    }
    store.finish(record.id, 'done', result.usage);
    emit({
      type: 'subagent.finished',
      sessionId: parentSessionId,
      botId: parentBotId,
      detail: { subagentId: record.id, status: 'done', usage: result.usage ?? null },
    });
    return { ...result, subagentId: record.id };
  } catch (err) {
    store.finish(record.id, 'failed');
    emit({
      type: 'subagent.finished',
      sessionId: parentSessionId,
      botId: parentBotId,
      detail: {
        subagentId: record.id,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      },
    });
    throw err;
  }
}
