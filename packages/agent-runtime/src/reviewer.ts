// SPDX-License-Identifier: Apache-2.0
/**
 * Reviewer model — second pair of eyes for auto-approve mode.
 *
 * When a turn runs with autoApprove: true, blindly allowing every tool call
 * is risky. The reviewer asks a cheap/fast model: "is this tool call routine
 * and safe?" YES → allow (audited as reviewer-approved). NO/uncertain →
 * escalate to a human approval card.
 *
 * Cost safety: the reviewer NEVER uses a paid model without explicit config.
 * It uses REVIEWER_MODEL env (providerId/modelId), else routes to the
 * cheapest free model. If no free model is configured, the reviewer is
 * skipped and the call escalates to human approval (fail-safe).
 */

import type { LLMProvider, ToolCall } from './types.js';
import { routeModel } from './routing.js';
import {
  profileModelForProvider,
  resolvePurposeProfile,
  type ModelProfiles,
  type PurposeModelProfile,
} from './model-profiles.js';

export type ReviewerVerdict = 'yes' | 'no' | 'skip';

export interface ReviewerResult {
  verdict: ReviewerVerdict;
  reason: string;
  model?: string;
}

/**
 * Ask the reviewer model about a tool call. Never throws — failures return
 * { verdict: 'skip' } so the caller escalates to human approval.
 */
export async function reviewToolCall(
  provider: LLMProvider,
  call: ToolCall,
  opts: { signal?: AbortSignal; profile?: PurposeModelProfile; profiles?: ModelProfiles } = {},
): Promise<ReviewerResult> {
  // Resolve the cheapest model: purpose profile ('reviewer') > explicit
  // REVIEWER_MODEL override > cheapest free > skip.
  let model: string | undefined;
  const profile = opts.profile ?? resolvePurposeProfile('reviewer', { profiles: opts.profiles });
  const fromProfile = profileModelForProvider(profile, provider.providerId);
  if (fromProfile) {
    model = fromProfile;
  } else if (profile?.modelId && !profile.providerId) {
    model = profile.modelId;
  }
  const override = process.env.REVIEWER_MODEL?.trim();
  if (!model && override) {
    model = override.includes('/') ? override.split('/').slice(1).join('/') : override;
  }
  if (!model) {
    try {
      const routed = routeModel({ taskType: 'simple-qa', freeOnly: true });
      // Only use it if the provider matches (we don't want to spin up a new
      // provider client here; the caller passes their provider).
      if (routed.providerId === provider.providerId) {
        model = routed.modelId;
      } else {
        return { verdict: 'skip', reason: 'no free model on current provider; escalating to human' };
      }
    } catch {
      return { verdict: 'skip', reason: 'no free model available; escalating to human' };
    }
  }

  // Redact obvious secrets from args before sending to the reviewer.
  let redacted: string;
  try {
    redacted = JSON.stringify(call.args ?? {}, (k, v) =>
      /token|secret|password|key|auth/i.test(k) ? '[REDACTED]' : v,
    );
  } catch {
    redacted = '{}';
  }
  const prompt =
    'You are a safety reviewer for an AI agent. Given this tool call, is it routine and safe?\n' +
    `Tool: ${call.name}\nArgs: ${redacted.slice(0, 2000)}\n\n` +
    'Reply with exactly one line: YES or NO, followed by a one-line reason. ' +
    'Say NO if the call deletes data, sends external messages, runs destructive ' +
    'commands, accesses credentials, or is ambiguous. When in doubt, say NO.';

  try {
    const res = await provider.chat(
      [{ role: 'user', content: prompt }],
      [],
      { model: model!, signal: opts.signal },
    );
    const text = (res.content ?? '').trim().toUpperCase();
    const reason = (res.content ?? '').trim().split('\n')[0]?.slice(0, 200) ?? '';
    if (text.startsWith('YES')) {
      return { verdict: 'yes', reason, model };
    }
    return { verdict: 'no', reason: reason || 'reviewer declined', model };
  } catch (err) {
    return { verdict: 'skip', reason: `reviewer error: ${err instanceof Error ? err.message : String(err)}` };
  }
}
