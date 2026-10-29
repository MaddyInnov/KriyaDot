// SPDX-License-Identifier: Apache-2.0
/**
 * Mid-turn steering queue.
 *
 * While a turn is generating, a user may submit an additional message
 * that should influence THAT turn rather than starting a new one. The
 * host enqueues it here; the runtime drains the queue at the next
 * model-call boundary (top of each iteration) and injects the texts as
 * user messages marked as steering.
 *
 * Fallback (documented): when no turn is running for the session,
 * enqueueSteer still accepts the message but the runtime will drain it
 * at the start of the NEXT turn for that session — i.e. it behaves
 * exactly like the existing queued-message behaviour, just persisted in
 * this queue until a turn boundary consumes it. Callers can check
 * `isSteering`/`pending` to decide whether to start a new turn instead.
 */
export interface SteerMessage { text: string; at: number; id: string; }
let seq = 0;
export class SteerQueue {
  private readonly q = new Map<string, SteerMessage[]>();
  enqueue(sessionId: string, text: string): SteerMessage {
    const msg: SteerMessage = { text: String(text ?? '').slice(0, 8000), at: Date.now(), id: `steer_${++seq}_${Date.now().toString(36)}` };
    const arr = this.q.get(sessionId) ?? []; arr.push(msg); this.q.set(sessionId, arr); return msg;
  }
  drain(sessionId: string): SteerMessage[] { const arr = this.q.get(sessionId) ?? []; this.q.delete(sessionId); return arr; }
  peek(sessionId: string): SteerMessage[] { return [...(this.q.get(sessionId) ?? [])]; }
  pending(sessionId: string): number { return this.q.get(sessionId)?.length ?? 0; }
  clear(sessionId: string): void { this.q.delete(sessionId); }
  /** Format drained messages as one steering user message. */
  static format(msgs: SteerMessage[]): string {
    return `[steering — the user added this while you were working; adjust course accordingly]\n${msgs.map(m=>m.text).join('\n')}`;
  }
}
