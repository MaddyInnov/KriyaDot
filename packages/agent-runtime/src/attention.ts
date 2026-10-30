// SPDX-License-Identifier: Apache-2.0
/**
 * Attention / salience subsystem (Octomind parity #133).
 *
 * Deterministic, offline scoring of messages/blocks for compaction
 * keep/drop decisions. No LLM is consulted: the score is a pure function
 * of the message itself (role, explicit markers, file references, tool
 * errors, position/recency), so the same history always scores the same
 * way and the behaviour is unit-testable end to end.
 *
 * Consumers:
 * - `sessions.ts` fold planning: blocks at or above
 *   {@link DEFAULT_ATTENTION_PIN_THRESHOLD} are pinned into the retained
 *   set (under the per-category retention quotas of #132) instead of
 *   surviving only as summary text.
 * - Hosts may also use {@link scoreAttention} directly to rank context
 *   blocks before sending them to a provider.
 */

export type MessageCategory =
  | 'decisions'
  | 'file-content'
  | 'tool-results'
  | 'user-turns'
  | 'other';

/** Minimal structural shape this module needs (ChatMessage-compatible). */
export interface AttentionMessage {
  role: string;
  content: string;
  toolName?: string;
  toolCallId?: string;
  toolCalls?: unknown[];
}

export interface AttentionScore {
  /** Salience in [0, 1]. Higher survives. */
  score: number;
  category: MessageCategory;
  /** Names of the signals that contributed (for audits / debugging). */
  signals: string[];
}

/** Score at/above which a folded block is pinned verbatim by default. */
export const DEFAULT_ATTENTION_PIN_THRESHOLD = 0.5;

const DECISION_MARKERS: RegExp[] = [
  /\bdecision\b/i,
  /\bdecided\b/i,
  /\bwe (?:will|shall|must)\b/i,
  /\bagreed\b/i,
  /\bapproved\b/i,
  /\bdo not\b/i,
  /\bnever\b/i,
  /\balways\b/i,
  /\bimportant\b/i,
  /\bremember\b/i,
  /\bTODO\b/,
  /\bplan:/i,
  /\bstep \d+\b/i,
];

const FILE_REFERENCE =
  /(?:^|[\s`'"(])[\w./-]+\.(?:ts|tsx|js|jsx|mjs|json|md|py|rs|go|java|css|html|yml|yaml|toml|sql|sh)\b/;

const TOOL_ERROR = /\b(?:error|failed|failure|exception|traceback|denied|timed out)\b/i;

/** True when the text carries an explicit decision / instruction marker. */
export function hasDecisionMarker(content: string): boolean {
  return DECISION_MARKERS.some((re) => re.test(content));
}

/** True when the text references a file path (or carries file content). */
export function hasFileReference(content: string): boolean {
  return FILE_REFERENCE.test(content) || content.includes('```');
}

/**
 * Categorize one message for the per-category retention budgets (#132).
 * Precedence is deliberate: a tool result stays a tool result even if it
 * mentions a decision, and a decision stated by a user/assistant outranks
 * the generic user-turn / file buckets.
 */
export function categorizeMessage(msg: AttentionMessage): MessageCategory {
  if (msg.role === 'tool') return 'tool-results';
  if (hasDecisionMarker(msg.content)) return 'decisions';
  if (hasFileReference(msg.content)) return 'file-content';
  if (msg.role === 'user') return 'user-turns';
  return 'other';
}

/**
 * Score one message. `index`/`total` give the message's position in the
 * full history (0-based, oldest first) and drive the recency signal,
 * which is capped at 0.2 so recency alone can never pin a block — that
 * is what separates attention survival from the old recency-only rule.
 */
export function scoreAttention(
  msg: AttentionMessage,
  position: { index?: number; total?: number } = {},
): AttentionScore {
  const signals: string[] = [];
  let score = 0;
  const category = categorizeMessage(msg);
  const content = msg.content ?? '';

  if (hasDecisionMarker(content)) {
    score += 0.5;
    signals.push('explicit-marker');
  }
  if (hasFileReference(content)) {
    score += 0.3;
    signals.push('file-reference');
  }
  if (content.includes('```')) {
    score += 0.1;
    signals.push('file-content');
  }
  if (msg.role === 'user') {
    score += 0.15;
    signals.push('user-turn');
  }
  if (msg.role === 'tool') {
    score += 0.05;
    signals.push('tool-result');
    if (TOOL_ERROR.test(content)) {
      score += 0.35;
      signals.push('tool-error');
    }
  }
  if (content.length >= 500) {
    score += 0.1;
    signals.push('long-content');
  }
  const { index, total } = position;
  if (typeof index === 'number' && typeof total === 'number' && total > 1) {
    const recency = Math.min(1, Math.max(0, index / (total - 1)));
    score += 0.2 * recency;
    if (recency >= 0.8) signals.push('recent');
  }
  return { score: Math.min(1, Math.round(score * 1000) / 1000), category, signals };
}

/** Score a whole list, oldest first, returning scores in input order. */
export function scoreAttentionBatch(messages: AttentionMessage[]): AttentionScore[] {
  return messages.map((m, i) => scoreAttention(m, { index: i, total: messages.length }));
}

/** True when a scored block is salient enough to pin verbatim. */
export function isHighAttention(
  score: AttentionScore,
  threshold: number = DEFAULT_ATTENTION_PIN_THRESHOLD,
): boolean {
  return score.score >= threshold;
}

/**
 * Rank messages by attention (score desc, then newest first as the
 * tie-break). Returns indices into the input array; the input is not
 * mutated.
 */
export function rankByAttention(messages: AttentionMessage[]): number[] {
  const scores = scoreAttentionBatch(messages);
  return messages
    .map((_, i) => i)
    .sort((a, b) => {
      const diff = scores[b]!.score - scores[a]!.score;
      return diff !== 0 ? diff : b - a;
    });
}
