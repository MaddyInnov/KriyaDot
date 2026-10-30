// SPDX-License-Identifier: Apache-2.0
/**
 * Calibrated evaluate seam (Octomind parity).
 *
 * A single cheap-model helper for the harness's small judgment calls —
 * "is this claim supported?", "which of these options?", "score this
 * 0–10" — returning a typed answer WITH a calibrated probability, so
 * callers (the supervisor verify-gate, end-of-turn validators, routing,
 * learning verifiers) can threshold on confidence instead of parsing
 * prose ad hoc in five different places.
 *
 * Model choice follows the purpose-profile table ('evaluate' purpose,
 * falling back to 'supervisor'): an explicit profile wins, then
 * MODEL_PROFILE_EVALUATE / MODEL_PROFILE_SUPERVISOR env, then the
 * cheapest FREE model on the caller's provider. When no model can be
 * resolved the seam returns null — callers must fail safe (the reviewer
 * escalates, the verify-gate marks itself skipped), never block forever.
 *
 * Zero paid usage by default: without an explicit profile/env override
 * only free models are eligible.
 */

import type { LLMProvider } from './types.js';
import { routeModel } from './routing.js';
import {
  profileModelForProvider,
  resolvePurposeProfile,
  type ModelProfiles,
  type PurposeModelProfile,
} from './model-profiles.js';

export type EvaluateQuestion =
  | { kind: 'noul'; question: string }
  | { kind: 'choice'; question: string; choices: string[] }
  | { kind: 'score'; question: string; /** Inclusive max; default 10. */ max?: number };

export interface EvaluateAnswer {
  kind: EvaluateQuestion['kind'];
  /** boolean for 'noul', the chosen string for 'choice', number for 'score'. */
  value: boolean | string | number;
  /** Calibrated confidence in the answer, 0..1. */
  probability: number;
  /** The model that answered (id only). */
  model: string;
  /** One-line rationale the model gave, when it provided one. */
  reason?: string;
}

export interface EvaluateOptions {
  /** Explicit profile (wins over env/table resolution). */
  profile?: PurposeModelProfile;
  /** Host purpose-profile table. */
  profiles?: ModelProfiles;
  signal?: AbortSignal;
  /**
   * Purpose whose profile drives this call (Octomind closure #141):
   * 'evaluate' by default; routing passes 'routing' so the routing
   * purpose profile resolves the router's decision model.
   */
  purpose?: import('./model-profiles.js').ModelPurpose;
}

/**
 * The full per-purpose knob set (#8/#11) as provider chat options:
 * temperature / topP / maxTokens / reasoningEffort plus the profile's
 * retry/timeout controls (#11). Only defined knobs are emitted, so a
 * profile that sets nothing changes nothing. `defaults` fill knobs the
 * profile leaves unset (e.g. the supervisor gate's temperature 0).
 */
export function purposeChatOptions(
  profile: PurposeModelProfile | undefined,
  defaults: {
    temperature?: number;
    topP?: number;
    maxTokens?: number;
    reasoningEffort?: 'low' | 'medium' | 'high';
  } = {},
): {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
  maxRetries?: number;
  timeoutMs?: number;
} {
  const out: ReturnType<typeof purposeChatOptions> = {};
  const temperature = profile?.temperature ?? defaults.temperature;
  if (temperature !== undefined) out.temperature = temperature;
  const topP = profile?.topP ?? defaults.topP;
  if (topP !== undefined) out.topP = topP;
  const maxTokens = profile?.maxTokens ?? defaults.maxTokens;
  if (maxTokens !== undefined) out.maxTokens = maxTokens;
  const reasoningEffort = profile?.reasoningEffort ?? defaults.reasoningEffort;
  if (reasoningEffort !== undefined) out.reasoningEffort = reasoningEffort;
  if (profile?.maxRetries !== undefined) out.maxRetries = profile.maxRetries;
  if (profile?.timeoutMs !== undefined) out.timeoutMs = profile.timeoutMs;
  return out;
}

/** Resolve the FULL profile behind an evaluate-style call (exported for aux drivers). */
export function resolveEvaluateProfile(opts: EvaluateOptions = {}): PurposeModelProfile | undefined {
  if (opts.profile) return opts.profile;
  const purpose = opts.purpose ?? 'evaluate';
  return (
    resolvePurposeProfile(purpose, { profiles: opts.profiles }) ??
    (purpose !== 'supervisor' ? resolvePurposeProfile('supervisor', { profiles: opts.profiles }) : undefined)
  );
}

/**
 * Resolve the model an evaluate call should use on `provider`, or
 * undefined when no eligible model exists. Exported for the supervisor
 * gate, which shares this resolution.
 */
export function resolveEvaluateModel(
  provider: LLMProvider,
  opts: EvaluateOptions = {},
): string | undefined {
  const profile = resolveEvaluateProfile(opts);
  const fromProfile = profileModelForProvider(profile, provider.providerId);
  if (fromProfile) return fromProfile;
  if (profile?.modelId && !profile.providerId) return profile.modelId;
  try {
    const routed = routeModel({ taskType: 'simple-qa', freeOnly: true });
    if (routed.providerId === provider.providerId) return routed.modelId;
  } catch {
    // No free model at all — fall through to undefined.
  }
  return undefined;
}

function buildPrompt(q: EvaluateQuestion): string {
  const base =
    'You are a calibrated decision helper. Answer the question and state your confidence ' +
    'as a probability percentage (0-100) that your answer is correct. Be honest: use low ' +
    'confidence when the evidence is thin.\n\n';
  if (q.kind === 'noul') {
    return (
      base +
      `Question (answer yes or no): ${q.question}\n\n` +
      'Reply with exactly one JSON object: {"answer": true|false, "probability": <0-100>, "reason": "<one line>"}'
    );
  }
  if (q.kind === 'choice') {
    return (
      base +
      `Question: ${q.question}\nOptions:\n${q.choices.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n\n` +
      'Reply with exactly one JSON object: {"answer": "<the exact option text>", "probability": <0-100>, "reason": "<one line>"}'
    );
  }
  const max = q.max ?? 10;
  return (
    base +
    `Question (answer with a score from 0 to ${max}): ${q.question}\n\n` +
    `Reply with exactly one JSON object: {"answer": <number 0-${max}>, "probability": <0-100>, "reason": "<one line>"}`
  );
}

/** Extract the first JSON object from a model reply (lenient). */
export function extractFirstJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function clampProbability(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return 0.5;
  // Models answer either 0..1 or 0..100; >1 means percent.
  const p = n > 1 ? n / 100 : n;
  return Math.min(1, Math.max(0, p));
}

/**
 * Ask a calibrated question. Returns null when no eligible model exists
 * or the model call/parse fails — callers fail safe. Never throws.
 */
export async function evaluateQuestion(
  provider: LLMProvider,
  question: EvaluateQuestion,
  opts: EvaluateOptions = {},
): Promise<EvaluateAnswer | null> {
  const model = resolveEvaluateModel(provider, opts);
  if (!model) return null;
  let text: string;
  try {
    const res = await provider.chat([{ role: 'user', content: buildPrompt(question) }], [], {
      model,
      signal: opts.signal,
      // #8/#11: forward the full evaluate-profile knob set (temperature
      // defaults to 0 only when the profile does not set one).
      ...purposeChatOptions(resolveEvaluateProfile(opts), { temperature: 0 }),
    });
    text = res.content ?? '';
  } catch {
    return null;
  }
  const obj = extractFirstJsonObject(text);
  if (!obj) return null;
  const probability = clampProbability(obj.probability);
  const reason = typeof obj.reason === 'string' ? obj.reason.slice(0, 300) : undefined;
  if (question.kind === 'noul') {
    if (typeof obj.answer !== 'boolean') return null;
    return { kind: 'noul', value: obj.answer, probability, model, reason };
  }
  if (question.kind === 'choice') {
    if (typeof obj.answer !== 'string' || !question.choices.includes(obj.answer)) return null;
    return { kind: 'choice', value: obj.answer, probability, model, reason };
  }
  const max = question.max ?? 10;
  const score = typeof obj.answer === 'number' ? obj.answer : Number(obj.answer);
  if (!Number.isFinite(score)) return null;
  return {
    kind: 'score',
    value: Math.min(max, Math.max(0, score)),
    probability,
    model,
    reason,
  };
}
