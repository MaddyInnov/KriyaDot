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
 * This module implements that countermeasure as an OPT-IN mode:
 *  - per-call: the delegate handler accepts `returnMode: 'evidence'`
 *    (a handler-level arg, deliberately not in the advertised schema —
 *    the same precedent as `profileId` / `isolation`);
 *  - per-process: the host sets KRIYADOT_DELEGATE_EVIDENCE_ONLY=1 to make
 *    evidence-only the default for every subagent spawn.
 * Default is OFF in both cases: conclusion returns remain the behaviour
 * unless a caller or the host explicitly opts in. The measured basis for
 * (and limits of) this protocol live in
 * benchmarks/agent-safety-delegation/README.md and FORMALISATION.md.
 */

/** Env var a host sets to make evidence-only returns the delegation default. */
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
  'Do NOT state a conclusion, recommendation or final answer, and do not',
  'say which source you believe. Evidence only.',
].join('\n');

/** True when the host env requests evidence-only delegation by default. */
export function isDelegateEvidenceOnlyEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const v = env[DELEGATE_EVIDENCE_ONLY_ENV];
  return v === '1' || v?.toLowerCase() === 'true';
}

/**
 * Resolve the effective return mode for one spawn: an explicit per-call
 * mode wins; otherwise the host env flag decides; otherwise 'conclusion'
 * (the historical default).
 */
export function resolveDelegateReturnMode(opts: {
  requested?: unknown;
  env?: Record<string, string | undefined>;
}): DelegateReturnMode {
  if (opts.requested === 'evidence') return 'evidence';
  if (opts.requested === 'conclusion') return 'conclusion';
  return isDelegateEvidenceOnlyEnabled(opts.env) ? 'evidence' : 'conclusion';
}

/** Apply the evidence-only return instruction to a delegated task text. */
export function applyEvidenceOnlyReturn(task: string): string {
  return `${task}\n\n${EVIDENCE_ONLY_RETURN_INSTRUCTION}`;
}
