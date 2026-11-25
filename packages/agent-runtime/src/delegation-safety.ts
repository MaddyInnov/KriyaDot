// SPDX-License-Identifier: Apache-2.0
/**
 * Delegation safety — evidence-only sub-agent returns (Workstream 2 of the
 * Agent-Safety Programme; see benchmarks/agent-safety-delegation/).
 *
 * Why this exists: KriyaDot's `delegate` tool returns CONCLUSIONS ONLY —
 * the parent receives the child's final text, with no tool evidence, no
 * quoted sources, no trace (see SubagentSpawnResult in subagents.ts).
 * Wang & Mannby (arXiv:2611.17520) measured what that shape costs: when a
 * weaker sub-agent is fooled by a forged record, a strong orchestrator
 * adopts the corrupted conclusion in ~98–100% of trials (751/757,
 * conditional on the worker being fooled), so the composed system's error
 * rate collapses to the weakest reader's. The structural countermeasure
 * their defence experiments support is to change the channel: the worker
 * returns EVIDENCE (verbatim quotes + source ids) and the orchestrator
 * draws the conclusion itself.
 *
 * DEFAULT CHANGE (2026-11-25, Ashutosh decision — "Approve both
 * defaults"): evidence-only is now the DEFAULT return mode for every
 * subagent spawn. The measured basis (P3: 0/10 forged propagation vs
 * 8/10 conclusion-delegated on the same cases) is in
 * benchmarks/agent-safety-delegation/README.md and FORMALISATION.md.
 * Conclusion returns remain available as an explicit opt-out, resolved
 * in this order (first match wins):
 *  - per-call: the delegate handler accepts `returnMode: 'conclusion'`
 *    (or 'evidence'; a handler-level arg, deliberately not in the
 *    advertised schema — the same precedent as `profileId` /
 *    `isolation`);
 *  - per-bot: the delegating bot's policy sets
 *    `delegationReturnMode: 'conclusion'` (bot config — the per-bot
 *    opt-out);
 *  - per-process: the host sets KRIYADOT_DELEGATE_EVIDENCE_ONLY=0 (or
 *    'false') to restore conclusion returns for every spawn (the
 *    global opt-out). '=1'/'true' states the default explicitly.
 */

/**
 * Env var controlling the delegation default. Since 2026-11-25 the
 * default is evidence-only; this var is now the global OPT-OUT
 * ('0'/'false' → conclusion returns) and may also state the default
 * explicitly ('1'/'true' → evidence-only).
 */
export const DELEGATE_EVIDENCE_ONLY_ENV = 'KRIYADOT_DELEGATE_EVIDENCE_ONLY';

/** The two return shapes a subagent spawn can use. */
export type DelegateReturnMode = 'conclusion' | 'evidence';

/**
 * The instruction appended to a delegated task in evidence mode. It is a
 * RETURN-FORMAT constraint on the child, not a change to the task itself:
 * the child still does the same research, but it may hand back only quoted
 * evidence with source identifiers — never a conclusion — so the parent
 * (typically the stronger model) performs the judgement step on checkable
 * material instead of adopting an unverifiable summary.
 */
export const EVIDENCE_ONLY_RETURN_INSTRUCTION = [
  '[DELEGATION SAFETY — EVIDENCE-ONLY RETURN MODE]',
  'Your reply is consumed by a lead agent that will draw its own conclusion.',
  'Return EVIDENCE ONLY, in exactly this shape:',
  '- Quote the relevant passages VERBATIM from each source you used, each',
  '  prefixed with its source identifier (file name, record id, URL or tool',
  '  result label) in square brackets, e.g. [record ACC-1042].',
  '- Include provenance lines verbatim where a source carries them (dates,',
  '  accession/provenance lines, authorship headers).',
  '- If sources disagree, quote BOTH sides; do not resolve the disagreement.',
  '- If you cannot find evidence for part of the task, write exactly:',
  '  NO EVIDENCE FOUND — followed by what is missing. Never fill a gap',
  '  from memory, inference or guesswork.',
  'Do NOT state a conclusion, recommendation or final answer, and do not',
  'say which source you believe. Evidence only.',
].join('\n');

/**
 * The framing prepended to an evidence-mode result before the parent
 * model sees it. Evidence-only returns shift the judgement step to the
 * parent; this framing makes the abstention path explicit and honest —
 * when the evidence is missing or insufficient, the parent must say so
 * (or ask) instead of silently concluding from general knowledge. The
 * measured cost of P3 included 3/10 abstentions on hard cases; hiding
 * them would recreate the failure the protocol exists to prevent.
 */
export const EVIDENCE_RESULT_FRAMING = [
  '[DELEGATION SAFETY — EVIDENCE-ONLY RESULT]',
  'The block below is raw evidence quoted by a sub-agent (verbatim passages',
  'with source identifiers), NOT a conclusion. Draw your own conclusion from',
  'this evidence only. If the evidence is marked NO EVIDENCE FOUND, or is',
  'insufficient to answer, say plainly what could not be established (or ask',
  'the user) — do not fill the gap from memory or inference and present it',
  'as established.',
  '---',
].join('\n');

/** Wrap a sub-agent's evidence-mode output in the parent-facing framing. */
export function frameEvidenceResult(result: string): string {
  return `${EVIDENCE_RESULT_FRAMING}\n${result}`;
}

/**
 * True when evidence-only is the effective process default. Since the
 * 2026-11-25 default flip this is true UNLESS the host explicitly opts
 * out with KRIYADOT_DELEGATE_EVIDENCE_ONLY=0 (or 'false'); '1'/'true'
 * state the default explicitly, and any other value leaves the default
 * in place.
 */
export function isDelegateEvidenceOnlyEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const v = env[DELEGATE_EVIDENCE_ONLY_ENV]?.toLowerCase();
  return v !== '0' && v !== 'false';
}

/**
 * Resolve the effective return mode for one spawn, first match wins:
 * an explicit per-call mode; the delegating bot's policy
 * (`delegationReturnMode` — the per-bot opt-out); the host env flag
 * (the global opt-out); and finally the default, 'evidence'
 * (2026-11-25 — previously 'conclusion').
 */
export function resolveDelegateReturnMode(opts: {
  requested?: unknown;
  botDefault?: unknown;
  env?: Record<string, string | undefined>;
}): DelegateReturnMode {
  if (opts.requested === 'evidence') return 'evidence';
  if (opts.requested === 'conclusion') return 'conclusion';
  if (opts.botDefault === 'evidence') return 'evidence';
  if (opts.botDefault === 'conclusion') return 'conclusion';
  return isDelegateEvidenceOnlyEnabled(opts.env) ? 'evidence' : 'conclusion';
}

/** Apply the evidence-only return instruction to a delegated task text. */
export function applyEvidenceOnlyReturn(task: string): string {
  return `${task}\n\n${EVIDENCE_ONLY_RETURN_INSTRUCTION}`;
}
