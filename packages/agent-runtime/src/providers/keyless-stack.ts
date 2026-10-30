// SPDX-License-Identifier: Apache-2.0
/**
 * Keyless free-LLM stack (free-LLM research 2026-10-29, §8).
 *
 * The ordered zero-setup fallback chain for the first-run experience.
 * The host walks this chain when a new user has configured NO provider:
 * each lane carries its guarantee class and honest UI label so the
 * product never calls a shared/best-effort lane "unlimited" or
 * "reliable". Groq / OpenRouter stay OUT of this chain — they are
 * "free with a free key" upgrades, not keyless lanes.
 *
 *   1. ollama-local   — guaranteed: the user's own compute (desktop
 *      Ollama or the Lightning Studio sidecar, see local-llm.ts).
 *   2. ovh-anonymous  — shared: OVHcloud's documented anonymous tier.
 *   3. llm7-anonymous — best-effort: undocumented anonymous lane.
 *   4. aihorde        — chat-only deep fallback: no tool calls, queued.
 */

export type KeylessGuarantee = 'guaranteed' | 'shared' | 'best-effort' | 'chat-only';

export interface KeylessLane {
  /** Stable lane id (not necessarily the provider id). */
  id: string;
  /** Catalog provider id the host constructs for this lane. */
  providerId: string;
  guarantee: KeylessGuarantee;
  /** Short honest label for the first-run screen. */
  label: string;
  /** Limits copy, mirrored from the catalog preset where one exists. */
  limitsNote: string;
  /** False only for AI Horde: tool-using turns must skip this lane. */
  toolCalls: boolean;
  /** True when prompts leave the user's device on this lane. */
  promptsLeaveDevice: boolean;
  /** Default model for the lane (first catalog model). */
  defaultModel?: string;
}

export const KEYLESS_FALLBACK_CHAIN: readonly KeylessLane[] = [
  {
    id: 'ollama-local',
    providerId: 'ollama',
    guarantee: 'guaranteed',
    label:
      'Runs on your own machine/Studio. Private — prompts never leave. Small local model: great for chat, triage and short tasks; slower and less capable than cloud models.',
    limitsNote: 'No shared quota — limited only by your own machine (pre-pull exactly one small model).',
    toolCalls: true,
    promptsLeaveDevice: false,
    defaultModel: 'qwen3:4b',
  },
  {
    id: 'ovh-anonymous',
    providerId: 'ovh-anonymous',
    guarantee: 'shared',
    label:
      'Free cloud (OVHcloud) — no key needed. Shared free lane: max ~2 requests/minute per model, can throttle at busy times. Prompts leave this device. Falls back to your local model automatically.',
    limitsNote: 'Anonymous lane: 2 requests/min per model (shared) — modest limits',
    toolCalls: true,
    promptsLeaveDevice: true,
    defaultModel: 'gpt-oss-120b',
  },
  {
    id: 'llm7-anonymous',
    providerId: 'llm7-anonymous',
    guarantee: 'best-effort',
    label:
      'Free community cloud (LLM7) — no key needed. Unofficial free lane with shared limits; may slow down or change without notice. Prompts leave this device.',
    limitsNote: '~60 requests/hour per IP (unverified, best-effort)',
    toolCalls: true,
    promptsLeaveDevice: true,
    defaultModel: 'default',
  },
  {
    id: 'aihorde',
    providerId: 'aihorde',
    guarantee: 'chat-only',
    label:
      'Volunteer-run community network. Free, no key — but queued: replies can take minutes, and tool use is unavailable.',
    limitsNote: 'Anonymous lane: lowest queue priority, max 512 tokens, plain chat only (no tool calls).',
    toolCalls: false,
    promptsLeaveDevice: true,
    defaultModel: 'koboldcpp',
  },
];

/**
 * The chain in fallback order. `toolUse: true` drops the chat-only lane
 * (AI Horde) so tool-using turns never land on a lane that would reject
 * them.
 */
export function keylessChain(opts: { toolUse?: boolean } = {}): KeylessLane[] {
  if (opts.toolUse) return KEYLESS_FALLBACK_CHAIN.filter((lane) => lane.toolCalls);
  return [...KEYLESS_FALLBACK_CHAIN];
}

/** Provider ids in first-run fallback order (host wiring convenience). */
export function keylessProviderOrder(opts: { toolUse?: boolean } = {}): string[] {
  return keylessChain(opts).map((lane) => lane.providerId);
}

/** One-line honest positioning for the first-run screen. */
export const KEYLESS_FIRST_RUN_POSITIONING =
  'KriyaDot works immediately with free built-in models — a private local model plus shared free cloud lanes with modest limits. Paste a free Groq key anytime for roomier limits; nothing here ever requires payment.';
