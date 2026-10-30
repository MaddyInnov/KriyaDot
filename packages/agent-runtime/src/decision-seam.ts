// SPDX-License-Identifier: Apache-2.0
/**
 * Fast decision seam — triage consumer (Octomind parity #141).
 *
 * The purpose-profile table declared `routing` and `triage` purposes,
 * but only `routing` gained a consumer (routeMessageWithModel, via the
 * evaluate seam with purpose:'routing'). `triage` was dead config:
 * watch/notification triage ran on its own routeModel('simple-qa')
 * seam and never consulted the profile table.
 *
 * This module is the triage consumer. It asks the calibrated evaluate
 * seam a boolean question, resolved through the 'triage' purpose
 * profile (explicit profile → host table → MODEL_PROFILE_TRIAGE env →
 * supervisor/evaluate fallbacks inside the seam), and returns a typed
 * verdict with its calibrated probability. When no model can be
 * resolved (no profile, no eligible free model) it returns null —
 * callers must fail safe with their existing seam (e.g. routeModel
 * simple-qa) or fail quiet, never block on triage.
 *
 * HOST WIRING (integration point, apps/api is not edited here):
 * apps/api/src/watch-watcher.ts `createRoutingTriage` and
 * apps/api/src/notification-triage.ts's helper-model triage can call
 * triageDecision(provider, question, { profiles }) first and fall back
 * to their current routeModel path when it returns null.
 */

import type { LLMProvider } from './types.js';
import { evaluateQuestion, resolveEvaluateProfile } from './evaluate.js';
import type { ModelProfiles, PurposeModelProfile } from './model-profiles.js';

/** Resolve the effective 'triage' purpose profile (undefined = seam will try fallbacks / free routing). */
export function resolveTriageProfile(opts: {
  profile?: PurposeModelProfile;
  profiles?: ModelProfiles;
} = {}): PurposeModelProfile | undefined {
  return resolveEvaluateProfile({ profile: opts.profile, profiles: opts.profiles, purpose: 'triage' });
}

export interface TriageDecision {
  /** True when the item needs immediate attention (the question answered "yes"). */
  urgent: boolean;
  /** Calibrated probability of the answer, 0..1. */
  probability: number;
  /** The model that answered (id only). */
  model: string;
  reason?: string;
}

/**
 * Ask a yes/no triage question through the 'triage' purpose profile.
 * Returns null when the evaluate seam cannot resolve a model or the
 * answer is unusable — the caller keeps its fallback behaviour.
 * `acceptThreshold` (default 0.5) is the probability at/above which a
 * "yes" is taken as urgent; a low-confidence "yes" fails safe to
 * not-urgent rather than paging a human on a guess.
 */
export async function triageDecision(
  provider: LLMProvider,
  question: string,
  opts: {
    profile?: PurposeModelProfile;
    profiles?: ModelProfiles;
    signal?: AbortSignal;
    acceptThreshold?: number;
  } = {},
): Promise<TriageDecision | null> {
  const ans = await evaluateQuestion(
    provider,
    { kind: 'noul', question },
    {
      ...(opts.profile ? { profile: opts.profile } : {}),
      ...(opts.profiles ? { profiles: opts.profiles } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      purpose: 'triage',
    },
  ).catch(() => null);
  if (!ans || typeof ans.value !== 'boolean') return null;
  const threshold = opts.acceptThreshold ?? 0.5;
  return {
    urgent: ans.value === true && ans.probability >= threshold,
    probability: ans.probability,
    model: ans.model,
    ...(ans.reason ? { reason: ans.reason } : {}),
  };
}
