// SPDX-License-Identifier: Apache-2.0
/**
 * First-reply rescue (item 2). Wrapper helper for the API turn path:
 * if a thread's FIRST turn produces no assistant reply within a
 * configurable timeout (or errors silently / returns empty), post a
 * rescue — one automatic retry with a nudge prompt; if that fails, a
 * visible system message in the thread + a needs-you inbox entry.
 * Max 1 rescue per thread (persisted in-memory set + optional store).
 *
 * HOST WIRING (routes.ts is host-owned): wrap the first-turn execution:
 *   const rescue = new FirstReplyRescue({ runTurn, appendSystemMessage, addNeedsYou, timeoutMs });
 *   const out = await rescue.runFirstTurn({ threadId, botId, run: () => executeTurn(...) });
 */
export interface RescueDeps {
  /** Retry the turn once with the nudge prompt; resolves true when a reply was produced. */
  retryTurn: (info: { threadId: string; nudgePrompt: string }) => Promise<boolean>;
  appendSystemMessage: (threadId: string, text: string) => Promise<void> | void;
  addNeedsYou: (entry: { threadId: string; botId?: string; title: string; detail: string }) => Promise<void> | void;
  timeoutMs?: number;
  now?: () => number;
}
export const RESCUE_NUDGE = 'Your previous attempt produced no reply. Please respond to the user\'s first message now, briefly and helpfully.';
export const RESCUE_SYSTEM_MESSAGE = '⚠️ The assistant did not reply to your first message. An automatic retry was attempted — please send your message again, or check the bot\'s provider settings.';
export class FirstReplyRescue {
  private readonly rescued = new Set<string>();
  constructor(private readonly deps: RescueDeps) {}
  hasRescued(threadId: string): boolean { return this.rescued.has(threadId); }
  /**
   * Run `firstTurn` with a watchdog. firstTurn resolves with whether an
   * assistant reply was produced. Timeout / false / throw all count as
   * "no reply" and trigger at most one rescue.
   */
  async runFirstTurn(input: { threadId: string; botId?: string; firstTurn: () => Promise<boolean> }): Promise<{ replied: boolean; rescued: boolean; rescueSucceeded?: boolean }> {
    const timeoutMs = this.deps.timeoutMs ?? 60_000;
    let replied = false;
    try {
      replied = await Promise.race([
        input.firstTurn(),
        new Promise<boolean>((_, reject) => setTimeout(() => reject(new Error('first-reply timeout')), timeoutMs)),
      ]);
    } catch { replied = false; }
    if (replied) return { replied: true, rescued: false };
    if (this.rescued.has(input.threadId)) return { replied: false, rescued: false };
    this.rescued.add(input.threadId);
    let rescueSucceeded = false;
    try { rescueSucceeded = await this.deps.retryTurn({ threadId: input.threadId, nudgePrompt: RESCUE_NUDGE }); } catch { rescueSucceeded = false; }
    if (rescueSucceeded) return { replied: true, rescued: true, rescueSucceeded: true };
    await this.deps.appendSystemMessage(input.threadId, RESCUE_SYSTEM_MESSAGE);
    await this.deps.addNeedsYou({ threadId: input.threadId, botId: input.botId, title: 'First reply failed', detail: RESCUE_SYSTEM_MESSAGE });
    return { replied: false, rescued: true, rescueSucceeded: false };
  }
}
