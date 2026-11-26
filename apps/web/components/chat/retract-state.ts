// SPDX-License-Identifier: Apache-2.0
// Stream retraction reducer (B-7 residual) — pure helper for the chat
// page's block list. No React here so the reducer can be unit-tested.
//
// When a provider dies mid-stream and the turn swaps to a backup, the
// runtime emits one `retract` event carrying the exact number of
// characters the dying provider streamed in the current segment. The
// reducer drops that many characters from the tail of the in-flight
// (still-streaming) assistant block — the segment streamed since the
// last completed boundary. If the segment was the block's whole text,
// the block is removed and the backup's tokens open a fresh bubble.
//
// What it must NEVER do: touch a completed block. Only the most recent
// assistant block that is still streaming is eligible; user blocks,
// tool blocks, notices (including the failover notice, which stays)
// and finished assistant messages are returned untouched. The count is
// clamped to the eligible block's text, so a stale or oversized count
// can never eat into completed history.

/** Minimal structural view of a chat block for retraction purposes. */
export interface RetractableBlock {
  kind: string;
  text?: string;
  streaming?: boolean;
}

/**
 * Fold a `retract` stream event into the block list. Returns an
 * unchanged copy when there is nothing to retract.
 */
export function applyRetraction<B extends RetractableBlock>(
  blocks: readonly B[],
  retractedChars: number,
): B[] {
  if (!Number.isFinite(retractedChars) || retractedChars <= 0) return blocks.slice();
  // The in-flight segment lives in the most recent still-streaming
  // assistant block; notices pushed after it (e.g. the failover notice)
  // do not close it, so search back past non-assistant blocks — but
  // never past a completed assistant block into older history.
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (!b || b.kind !== 'assistant') continue;
    if (!b.streaming) return blocks.slice(); // newest assistant block is complete — nothing in flight
    const text = b.text ?? '';
    const n = Math.min(retractedChars, text.length);
    if (n <= 0) return blocks.slice();
    const next = [...blocks];
    if (n >= text.length) {
      // The whole segment is retracted: drop the bubble entirely so
      // the backup's answer starts a fresh one.
      next.splice(i, 1);
    } else {
      next[i] = { ...b, text: text.slice(0, text.length - n) };
    }
    return next;
  }
  return blocks.slice();
}
