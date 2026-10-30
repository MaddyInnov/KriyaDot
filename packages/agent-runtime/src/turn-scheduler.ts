// SPDX-License-Identifier: Apache-2.0
// Per-bot parallel-thread scheduler (W8g).
//
// A bot can run up to MAX_PARALLEL_THREADS_PER_BOT (16) turns at once —
// one per chat thread. The scheduler is a per-bot counting semaphore
// with a FIFO wait queue: turns for DIFFERENT threads of the same bot
// never wait on each other until the cap is hit, and turns for
// different bots never interact at all. (Per-SESSION serialization is
// a separate concern handled by the chat layer's active-turn map: a
// new message on the same session aborts/queues against that session
// only.)
//
// There is deliberately NO global lock and NO per-bot single-flight:
// the only waiting a turn ever does is for a free slot under the cap.

/** Hard cap on concurrent turns (threads) per bot. */
export const MAX_PARALLEL_THREADS_PER_BOT = 16;

export class BotTurnScheduler {
  private readonly limit: number;
  private readonly active = new Map<string, number>();
  private readonly waiters = new Map<string, Array<() => void>>();

  constructor(limit: number = MAX_PARALLEL_THREADS_PER_BOT) {
    this.limit = Math.max(1, Math.floor(limit) || 1);
  }

  get perBotLimit(): number {
    return this.limit;
  }

  /** Turns currently running for a bot. */
  activeCount(botId: string): number {
    return this.active.get(botId) ?? 0;
  }

  /** Turns currently queued waiting for a slot for a bot. */
  queuedCount(botId: string): number {
    return this.waiters.get(botId)?.length ?? 0;
  }

  /**
   * Acquire a slot for `botId`. Resolves immediately while the bot is
   * under the cap; otherwise waits FIFO. Returns the release function —
   * call it exactly once when the turn settles.
   */
  async acquire(botId: string): Promise<() => void> {
    if (this.activeCount(botId) < this.limit) {
      this.active.set(botId, this.activeCount(botId) + 1);
      return () => this.release(botId);
    }
    await new Promise<void>((resolve) => {
      const q = this.waiters.get(botId) ?? [];
      q.push(resolve);
      this.waiters.set(botId, q);
    });
    // Woken by release(): the slot was handed over, count already moved.
    return () => this.release(botId);
  }

  private release(botId: string): void {
    const q = this.waiters.get(botId);
    if (q && q.length > 0) {
      const next = q.shift()!;
      if (q.length === 0) this.waiters.delete(botId);
      // Hand the slot straight to the next waiter: active count unchanged.
      next();
      return;
    }
    const n = this.activeCount(botId) - 1;
    if (n <= 0) this.active.delete(botId);
    else this.active.set(botId, n);
  }
}

// ---------------------------------------------------------------------------
// Multi-writer co-driving on ONE live session (Octomind parity #173).
//
// Before this, a session had exactly one effective writer: a second
// writer's message either aborted the in-flight turn or queued blindly,
// and neither writer could see the other. SessionCoDrive gives a session
// an explicit writer set with safe co-driving semantics:
//
//   - any number of writers may JOIN a session (presence is observable
//     via writersOf / activeWriter);
//   - write leases are granted FIFO per session: exactly one writer
//     holds the lease (is executing a turn) at a time, so two turns can
//     never interleave writes into the same session history;
//   - a non-holder writer is never rejected or forced to abort the
//     holder — it waits for the lease (or queues at the chat layer,
//     tagged with its writerId — see apps/api chat-queue `codrive` mode);
//   - leaving while holding the lease releases it to the next waiter.
//
// The coordinator is deliberately transport-free: the API layer maps
// HTTP/WS callers to writer ids and holds a lease for the duration of
// each turn on the session.
// ---------------------------------------------------------------------------

export class SessionCoDrive {
  private readonly writers = new Map<string, Set<string>>();
  private readonly holder = new Map<string, string>();
  private readonly waiters = new Map<string, Array<{ writerId: string; grant: () => void }>>();

  /** Attach a writer to a session. Idempotent. Returns the writer set. */
  join(sessionId: string, writerId: string): string[] {
    const set = this.writers.get(sessionId) ?? new Set<string>();
    set.add(writerId);
    this.writers.set(sessionId, set);
    return this.writersOf(sessionId);
  }

  /**
   * Detach a writer. If it held the write lease, the lease passes to
   * the next waiter (as if released). Returns the remaining writers.
   */
  leave(sessionId: string, writerId: string): string[] {
    const set = this.writers.get(sessionId);
    if (set) {
      set.delete(writerId);
      if (set.size === 0) this.writers.delete(sessionId);
    }
    if (this.holder.get(sessionId) === writerId) this.grantNext(sessionId);
    return this.writersOf(sessionId);
  }

  /** Writers currently attached to the session (sorted, stable). */
  writersOf(sessionId: string): string[] {
    return [...(this.writers.get(sessionId) ?? [])].sort();
  }

  /** The writer currently holding the session's write lease, if any. */
  activeWriter(sessionId: string): string | undefined {
    return this.holder.get(sessionId);
  }

  /** Writers waiting for the lease, in FIFO order. */
  queuedWriters(sessionId: string): string[] {
    return (this.waiters.get(sessionId) ?? []).map((w) => w.writerId);
  }

  /**
   * Acquire the session's write lease for `writerId` (auto-joins the
   * writer). Resolves immediately when the lease is free or already
   * held by this writer (re-entrant for the holder); otherwise waits
   * FIFO. Returns the release function — call it exactly once.
   */
  async acquireWrite(sessionId: string, writerId: string): Promise<() => void> {
    this.join(sessionId, writerId);
    const current = this.holder.get(sessionId);
    if (current === undefined || current === writerId) {
      this.holder.set(sessionId, writerId);
      return () => this.releaseWrite(sessionId, writerId);
    }
    await new Promise<void>((resolve) => {
      const q = this.waiters.get(sessionId) ?? [];
      q.push({ writerId, grant: resolve });
      this.waiters.set(sessionId, q);
    });
    // grantNext() already transferred the holder mark to this writer.
    return () => this.releaseWrite(sessionId, writerId);
  }

  private releaseWrite(sessionId: string, writerId: string): void {
    if (this.holder.get(sessionId) !== writerId) return; // not the holder (already passed on)
    this.grantNext(sessionId);
  }

  private grantNext(sessionId: string): void {
    const q = this.waiters.get(sessionId);
    if (q && q.length > 0) {
      const next = q.shift()!;
      if (q.length === 0) this.waiters.delete(sessionId);
      this.holder.set(sessionId, next.writerId);
      next.grant();
      return;
    }
    this.holder.delete(sessionId);
  }
}
