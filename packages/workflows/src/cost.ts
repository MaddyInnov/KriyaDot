// SPDX-License-Identifier: Apache-2.0

/**
 * Cost signal extraction for workflow budget enforcement.
 *
 * The workflow runner has no single "executor callback": each node type
 * produces its own output (tool handler results, agent text, HTTP
 * responses, code return values, …). The cost signal therefore lives ON
 * the node output. `extractCostUsd` reads, in priority order:
 *
 *   1. `output.costUsd`    — USD amount as a number (the shape used by the
 *                            agent-runtime eval/fusion layers);
 *   2. `output.costCents`  — USD cents as a number (the shape paid tools
 *                            return, cf. agent-runtime's
 *                            `extractToolCostCents` for Composio-style
 *                            actions), or the snake-case `cost_cents`;
 *   3. the same fields nested one level down under `output.usage`
 *      (for outputs shaped like `{ usage: { costUsd } }`).
 *
 * Anything else — plain text, token counts without a price, missing or
 * non-finite/negative values — counts as $0. Token usage alone is NOT
 * priced here: the runner holds no price table, so an `agent` node's raw
 * TokenUsage cannot be converted honestly; tools/code nodes that know
 * their price report it via the fields above.
 *
 * `loop` / `match` nodes aggregate the costs of their sub-executions into
 * a top-level `costUsd` on their own output, so this single function is
 * the only reader the budget check needs.
 */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function validAmount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function costFromRecord(rec: Record<string, unknown>): number | undefined {
  const usd = validAmount(rec['costUsd']);
  if (usd !== undefined) return usd;
  const cents = validAmount(rec['costCents']) ?? validAmount(rec['cost_cents']);
  if (cents !== undefined) return cents / 100;
  return undefined;
}

/** USD cost carried by a node output, or 0 when it carries none. */
export function extractCostUsd(output: unknown): number {
  const rec = asRecord(output);
  if (!rec) return 0;
  const direct = costFromRecord(rec);
  if (direct !== undefined) return direct;
  const usage = asRecord(rec['usage']);
  if (usage) {
    const nested = costFromRecord(usage);
    if (nested !== undefined) return nested;
  }
  return 0;
}
