// SPDX-License-Identifier: Apache-2.0
/**
 * Opt-in policy snapshot mode (#70).
 *
 * KriyaDot's DEFAULT is live policy evaluation: every tool call is
 * evaluated against the policy as it stands at call time, so an
 * operator who tightens a rule mid-session is protected immediately.
 * That is a deliberate difference from tools that snapshot guardrails
 * at session start, and it stays the default.
 *
 * Snapshot mode is the opt-in alternative for operators who want the
 * opposite guarantee — one immutable policy for a whole session (for
 * reproducibility, audit, or change-freeze windows):
 *
 *   const snapshot = createPolicySnapshot(effectivePolicy, { source: 'bot:b1' });
 *   gateway.evaluateWithSnapshot(tool, args, ctx, snapshot); // or
 *   gateway.simulate(tool, args, snapshot.policy);
 *
 * A snapshot is a deep-cloned, deep-frozen copy of the effective merged
 * policy plus a provenance hash (SHA-256 over the canonical JSON of
 * the policy). Mutating the source policy object — or the policy FILE
 * it was merged from — after capture cannot change snapshot
 * evaluation; re-loading and evaluating live reflects the mutation.
 *
 * Enablement is via config, never by default:
 * - `.kriyadot/policy.json` may carry `"policySnapshot": true`
 *   (surfaced as `PolicyFileResult.policySnapshot` by policy-file.ts);
 * - a bot policy may carry `policySnapshot: true`
 *   (`BotPolicy.policySnapshot` in bot-policy.ts);
 * - hosts pass either flag through {@link resolveSessionPolicy}.
 */

import { createHash } from 'node:crypto';
import { canonicalJson } from './history.js';
import type { Policy } from './types.js';

/** An immutable, provenance-hashed capture of an effective policy. */
export interface PolicySnapshot {
  /** Deep-frozen deep clone of the policy as captured. */
  readonly policy: Policy;
  /** SHA-256 hex over the canonical JSON of the captured policy. */
  readonly hash: string;
  /** Epoch ms when the snapshot was captured (session start). */
  readonly capturedAt: number;
  /** Free-form provenance label (e.g. "bot:b1", a workspace path). */
  readonly source?: string;
  /** Number of rules captured. */
  readonly ruleCount: number;
}

/** SHA-256 hex over the canonical JSON of a policy (stable key order). */
export function hashPolicy(policy: Policy): string {
  return createHash('sha256').update(canonicalJson(policy), 'utf8').digest('hex');
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Capture an immutable snapshot of an effective (already merged)
 * policy. The input is deep-cloned first, so later mutation of the
 * caller's object cannot leak into the snapshot.
 */
export function createPolicySnapshot(
  policy: Policy,
  opts: { source?: string; now?: number } = {},
): PolicySnapshot {
  const clone = JSON.parse(canonicalJson(policy)) as Policy;
  deepFreeze(clone);
  return Object.freeze({
    policy: clone,
    hash: hashPolicy(clone),
    capturedAt: opts.now ?? Date.now(),
    source: opts.source,
    ruleCount: clone.rules.length,
  });
}

/** True when a snapshot still corresponds to `policy` (same provenance hash). */
export function snapshotMatchesPolicy(snapshot: PolicySnapshot, policy: Policy): boolean {
  return snapshot.hash === hashPolicy(policy);
}

export interface SessionPolicyResolution {
  /** The policy to evaluate against for this session. */
  policy: Policy;
  /** Present only when snapshot mode was enabled and a snapshot was taken. */
  snapshot?: PolicySnapshot;
  /** 'snapshot' when evaluating against the capture, 'live' otherwise (default). */
  mode: 'live' | 'snapshot';
}

/**
 * Resolve the session policy from the opt-in flag:
 * - `snapshot: false`/absent (DEFAULT) → the live policy object itself,
 *   evaluated fresh on every call;
 * - `snapshot: true` → a fresh {@link PolicySnapshot}; evaluate against
 *   `resolution.policy` (the frozen capture) for the whole session.
 */
export function resolveSessionPolicy(
  policy: Policy,
  opts: { snapshot?: boolean; source?: string; now?: number } = {},
): SessionPolicyResolution {
  if (opts.snapshot !== true) {
    return { policy, mode: 'live' };
  }
  const snapshot = createPolicySnapshot(policy, { source: opts.source, now: opts.now });
  return { policy: snapshot.policy, snapshot, mode: 'snapshot' };
}
