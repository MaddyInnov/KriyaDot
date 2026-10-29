// SPDX-License-Identifier: Apache-2.0
/**
 * Supervisor verify-gate (Octomind parity — the harness's completion
 * gate, distinct from the pre-execution reviewer in reviewer.ts).
 *
 * Problem it solves: an agent that ran tools can declare "done" in prose
 * with nothing behind the claim. `verify_changes` existed as a voluntary
 * tool, but nothing BLOCKED an unverified completion claim.
 *
 * The gate: when a turn that executed mutating tools is about to end on
 * a final answer, a separate cheap model (the 'supervisor' purpose
 * profile) judges the claim against the QUOTED runtime evidence the
 * runtime collected this turn — actual tool results, test output, file
 * writes. Rules:
 *
 *   - No evidence at all → rejected WITHOUT a model call. A completion
 *     claim with zero tool results behind it is unverifiable by
 *     construction.
 *   - Evidence present → the supervisor model accepts or rejects with a
 *     reason; a rejection carries concrete guidance that the runtime
 *     injects as the next instruction (bounded rejections per turn).
 *   - No supervisor model resolvable, or the model errors / answers
 *     unparseably → the gate marks itself SKIPPED and accepts (fail-safe,
 *     same philosophy as the reviewer: never deadlock a turn on an
 *     auxiliary model). The skip is audited by the caller.
 *
 * Cost safety mirrors the reviewer: without an explicit supervisor
 * profile, only free models are eligible.
 */

import type { LLMProvider } from './types.js';
import { routeModel } from './routing.js';
import { extractFirstJsonObject } from './evaluate.js';
import {
  profileModelForProvider,
  resolvePurposeProfile,
  type ModelProfiles,
  type PurposeModelProfile,
} from './model-profiles.js';

/** One piece of runtime evidence: a tool that actually ran this turn. */
export interface TurnEvidence {
  toolName: string;
  /** True when the tool result was not an error/denial. */
  ok: boolean;
  /** True when the tool mutates state (drives whether the gate engages). */
  mutating: boolean;
  /** Short excerpt of the tool's result — the "quoted" evidence. */
  excerpt: string;
}

export type VerifyGateVerdict =
  | { accepted: true; skipped?: boolean; reason: string; model?: string }
  | { accepted: false; reason: string; guidance: string; model?: string };

export interface VerifyGateOptions {
  profile?: PurposeModelProfile;
  profiles?: ModelProfiles;
  signal?: AbortSignal;
  /** Max evidence entries quoted to the supervisor. Default 12. */
  maxEvidence?: number;
}

/** Resolve the supervisor model for a provider (profile → free routing). */
export function resolveSupervisorModel(
  provider: LLMProvider,
  opts: VerifyGateOptions = {},
): string | undefined {
  const profile = opts.profile ?? resolvePurposeProfile('supervisor', { profiles: opts.profiles });
  const fromProfile = profileModelForProvider(profile, provider.providerId);
  if (fromProfile) return fromProfile;
  if (profile?.modelId && !profile.providerId) return profile.modelId;
  try {
    const routed = routeModel({ taskType: 'simple-qa', freeOnly: true });
    if (routed.providerId === provider.providerId) return routed.modelId;
  } catch {
    // No free model — gate will skip.
  }
  return undefined;
}

const MAX_EXCERPT_CHARS = 600;

function buildGatePrompt(input: { request: string; claim: string; evidence: TurnEvidence[] }): string {
  const evidenceText = input.evidence
    .map(
      (e, i) =>
        `[${i + 1}] tool=${e.toolName} outcome=${e.ok ? 'success' : 'FAILED'}${e.mutating ? ' (mutating)' : ''}\n    result: ${e.excerpt.slice(0, MAX_EXCERPT_CHARS)}`,
    )
    .join('\n');
  return (
    'You are a strict verification supervisor. A worker agent claims its task is complete. ' +
    'Judge ONLY from the runtime evidence below (actual tool results from this turn) — never ' +
    'from the claim\'s confidence.\n\n' +
    `User request:\n${input.request.slice(0, 1500)}\n\n` +
    `Worker's completion claim:\n${input.claim.slice(0, 1500)}\n\n` +
    `Runtime evidence:\n${evidenceText}\n\n` +
    'ACCEPT only if the evidence shows the requested work actually happened and, where the ' +
    'project has checks (tests/lint/build), that they were run and passed — or the evidence ' +
    'clearly shows why they do not apply. REJECT when the claim outruns the evidence, checks ' +
    'failed or were never run, or work items are unaccounted for.\n' +
    'Reply with exactly one JSON object: {"verdict": "accept"|"reject", "reason": "<one line>", ' +
    '"guidance": "<what the worker must do next — required when rejecting>"}'
  );
}

/**
 * Judge a completion claim against quoted runtime evidence. Never
 * throws; model problems degrade to a skipped-accept (see header).
 */
export async function verifyCompletionClaim(
  provider: LLMProvider,
  input: { request: string; claim: string; evidence: TurnEvidence[] },
  opts: VerifyGateOptions = {},
): Promise<VerifyGateVerdict> {
  const claim = input.claim.trim();
  if (!claim) return { accepted: true, reason: 'empty final answer — nothing claimed' };
  const successful = input.evidence.filter((e) => e.ok);
  if (successful.length === 0) {
    return {
      accepted: false,
      reason: 'no successful tool results this turn — the claim has no runtime evidence behind it',
      guidance:
        'Your completion claim was rejected by the supervisor: there is no runtime evidence ' +
        '(no successful tool results) behind it. Do the work with tools first, run the ' +
        'project\'s checks (e.g. verify_changes) where they apply, and only then summarize — ' +
        'citing what the tools actually returned.',
    };
  }
  const model = resolveSupervisorModel(provider, opts);
  if (!model) {
    return {
      accepted: true,
      skipped: true,
      reason: 'no supervisor model available; gate skipped (evidence present)',
    };
  }
  let text: string;
  try {
    const res = await provider.chat(
      [{ role: 'user', content: buildGatePrompt({ ...input, evidence: input.evidence.slice(-(opts.maxEvidence ?? 12)) }) }],
      [],
      { model, signal: opts.signal, temperature: 0 },
    );
    text = res.content ?? '';
  } catch (err) {
    return {
      accepted: true,
      skipped: true,
      reason: `supervisor call failed (${err instanceof Error ? err.message : String(err)}); gate skipped`,
      model,
    };
  }
  const obj = extractFirstJsonObject(text);
  const verdict = typeof obj?.verdict === 'string' ? obj.verdict.toLowerCase() : '';
  const reason = typeof obj?.reason === 'string' ? obj.reason.slice(0, 300) : '';
  if (verdict === 'accept') {
    return { accepted: true, reason: reason || 'supervisor accepted the evidence', model };
  }
  if (verdict === 'reject') {
    const guidance =
      typeof obj?.guidance === 'string' && obj.guidance.trim()
        ? obj.guidance.slice(0, 800)
        : 'Provide runtime evidence for the claim: run the relevant tools/checks and report their actual results.';
    return {
      accepted: false,
      reason: reason || 'supervisor rejected the claim',
      guidance:
        `Your completion claim was rejected by the supervisor: ${reason || 'the evidence does not support it'}. ` +
        `Next step: ${guidance} When you finish, cite the tool results that prove it.`,
      model,
    };
  }
  return {
    accepted: true,
    skipped: true,
    reason: 'supervisor answer unparseable; gate skipped',
    model,
  };
}
