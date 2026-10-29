// SPDX-License-Identifier: Apache-2.0
// Live turn state (W8a): an in-memory registry of what each busy bot is
// doing RIGHT NOW — the current step of its in-flight turn, when the turn
// started, and how long it has been running.
//
// The runtime updates the registry as a turn progresses (thinking →
// running <tool> → …) and clears the entry when the turn ends or errors.
// The API layer serves it at GET /api/chat/now (the web "Now" cards) and
// the runtime also mirrors every update as a `step` StreamEvent so the
// open chat shows a live step line under the streaming message.
//
// In-memory by design: a turn that outlives the process is dead anyway
// (crash recovery marks it interrupted separately). No persistence, no I/O.

export interface CurrentTurnState {
  botId: string;
  botName?: string;
  sessionId: string;
  /** Human-readable current step, e.g. "Thinking" or "Running read_file". */
  step: string;
  /** 1-based step index when known (provider iteration). */
  stepIndex?: number;
  /** Total steps when known (max iterations). */
  stepTotal?: number;
  /** Epoch ms when the turn started. */
  startedAt: number;
  /** Epoch ms of the last step update. */
  updatedAt: number;
  /** Elapsed ms at snapshot time (computed by `snapshot`/`list`). */
  elapsedMs: number;
}

interface TurnEntry {
  botId: string;
  botName?: string;
  sessionId: string;
  step: string;
  stepIndex?: number;
  stepTotal?: number;
  startedAt: number;
  updatedAt: number;
}

/** Format an elapsed duration for the step line / Now card ("12s", "2m 05s"). */
export function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m ${String(sec).padStart(2, '0')}s`;
}

/**
 * Registry of in-flight turns, keyed by sessionId (one live turn per
 * session — the chat layer enforces the same invariant). Entries are
 * removed on turn end/error; `list()` is the "Now" view across all bots.
 */
export class TurnStateRegistry {
  private readonly entries = new Map<string, TurnEntry>();
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  /** Mark a turn as started (or restart the entry for a reused session). */
  begin(input: { botId: string; botName?: string; sessionId: string; step?: string }): CurrentTurnState {
    const t = this.now();
    const entry: TurnEntry = {
      botId: input.botId,
      botName: input.botName,
      sessionId: input.sessionId,
      step: input.step ?? 'Thinking',
      startedAt: t,
      updatedAt: t,
    };
    this.entries.set(input.sessionId, entry);
    return this.snapshot(input.sessionId)!;
  }

  /** Update the current step for a live turn. No-op for unknown sessions. */
  update(
    sessionId: string,
    patch: { step: string; stepIndex?: number; stepTotal?: number },
  ): CurrentTurnState | undefined {
    const entry = this.entries.get(sessionId);
    if (!entry) return undefined;
    entry.step = patch.step;
    if (patch.stepIndex !== undefined) entry.stepIndex = patch.stepIndex;
    if (patch.stepTotal !== undefined) entry.stepTotal = patch.stepTotal;
    entry.updatedAt = this.now();
    return this.snapshot(sessionId);
  }

  /** Clear a turn's state (turn ended, errored, or was interrupted). */
  finish(sessionId: string): boolean {
    return this.entries.delete(sessionId);
  }

  /** Snapshot one turn's state with a fresh elapsed figure. */
  snapshot(sessionId: string): CurrentTurnState | undefined {
    const entry = this.entries.get(sessionId);
    if (!entry) return undefined;
    return { ...entry, elapsedMs: Math.max(0, this.now() - entry.startedAt) };
  }

  /** All live turns, most recently started first — the "Now" list. */
  list(): CurrentTurnState[] {
    return [...this.entries.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((e) => ({ ...e, elapsedMs: Math.max(0, this.now() - e.startedAt) }));
  }

  /** Live turns for one bot (its parallel threads). */
  listForBot(botId: string): CurrentTurnState[] {
    return this.list().filter((s) => s.botId === botId);
  }

  get size(): number {
    return this.entries.size;
  }
}
