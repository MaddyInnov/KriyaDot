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
