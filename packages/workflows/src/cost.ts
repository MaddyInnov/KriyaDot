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
 *
 * Pricing (#150): agent / bot-turn nodes DO get priced — the runner
 * captures the TokenUsage returned by the turn (or by an injected node
 * executor) and converts it with `priceUsageUsd`, which reuses the
 * agent-runtime price table (`@mvp/agent-runtime` pricing.ts:
 * `costOfUsage`). That priced cost feeds the same budget check and the
 * JSONL run-events stream (#152), so workflow budgets can cap LLM spend.
 */

import { costOfUsage } from '@mvp/agent-runtime';
import type { WorkflowTokenUsage } from './types.js';

/**
 * USD cost of a token usage record under the agent-runtime price table.
 * Unknown models price as $0 with the table's `estimated` semantics —
 * callers that need a non-zero assertion should use a priced model.
 */
export function priceUsageUsd(
  providerId: string | undefined,
  modelId: string | undefined,
  usage: WorkflowTokenUsage,
): number {
  if (!providerId || !modelId) return 0;
  return costOfUsage(providerId, modelId, usage).total;
}

/** An injectable pricer: returns USD for a usage record (or a UsageCost-like). */
export type UsagePricer = (
  providerId: string,
  modelId: string,
  usage: WorkflowTokenUsage,
) => number | { total: number } | undefined;

/** Normalize an UsagePricer's return value to a USD number. */
export function normalizePricedCost(
  priced: number | { total: number } | undefined,
): number {
  if (typeof priced === 'number') return Number.isFinite(priced) && priced >= 0 ? priced : 0;
  if (priced && typeof priced.total === 'number') {
    return Number.isFinite(priced.total) && priced.total >= 0 ? priced.total : 0;
  }
  return 0;
}

function usageFromRecord(rec: Record<string, unknown>): WorkflowTokenUsage | undefined {
  const prompt = rec['promptTokens'];
  const completion = rec['completionTokens'];
  if (typeof prompt !== 'number' || typeof completion !== 'number') return undefined;
  if (!Number.isFinite(prompt) || !Number.isFinite(completion) || prompt < 0 || completion < 0) {
    return undefined;
  }
  const total = rec['totalTokens'];
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: typeof total === 'number' && Number.isFinite(total) ? total : prompt + completion,
  };
}

/**
 * Token usage carried by a node output, if any: `output.usage` in
 * TokenUsage shape, or the output itself in that shape.
 */
export function extractTokenUsage(output: unknown): WorkflowTokenUsage | undefined {
  const rec = asRecord(output);
  if (!rec) return undefined;
  const nested = asRecord(rec['usage']);
  if (nested) {
    const usage = usageFromRecord(nested);
    if (usage) return usage;
  }
  return usageFromRecord(rec);
}

/**
 * Full cost of a node output: an explicit cost signal wins; otherwise
 * token usage on the output is priced with the (optionally injected)
 * price table using `fallback` provider/model when the output does not
 * name its own.
 */
export function priceNodeOutputUsd(
  output: unknown,
  opts?: {
    providerId?: string;
    modelId?: string;
    pricer?: UsagePricer;
  },
): number {
  const explicit = extractCostUsd(output);
  if (explicit > 0) return explicit;
  const usage = extractTokenUsage(output);
  if (!usage) return 0;
  const rec = asRecord(output) ?? {};
  const usageRec = asRecord(rec['usage']) ?? {};
  const providerId =
    (typeof usageRec['provider'] === 'string' && usageRec['provider']) ||
    (typeof rec['provider'] === 'string' && rec['provider']) ||
    opts?.providerId;
  const modelId =
    (typeof usageRec['model'] === 'string' && usageRec['model']) ||
    (typeof rec['model'] === 'string' && rec['model']) ||
    opts?.modelId;
  if (!providerId || !modelId) return 0;
  if (opts?.pricer) return normalizePricedCost(opts.pricer(providerId, modelId, usage));
  return priceUsageUsd(providerId, modelId, usage);
}

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
