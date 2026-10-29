// SPDX-License-Identifier: Apache-2.0
/**
 * Purpose-based model profiles (Octomind parity).
 *
 * One configurable table answers "which model does X" for every auxiliary
 * job in the harness — supervisor, compression, routing, reviewer,
 * summarizer, triage, evaluate — instead of each subsystem hard-wiring
 * its own choice (the API summarizer was pinned to one vendor; the
 * reviewer had its own env var; routing had a third mechanism).
 *
 * Resolution order for a purpose:
 *   1. host-supplied profiles table (API: <dataDir>/model-profiles.json,
 *      CLI: config) passed via opts.profiles
 *   2. env MODEL_PROFILE_<PURPOSE> = "providerId/modelId"
 *   3. purpose-specific legacy env (REVIEWER_MODEL for 'reviewer')
 *   4. undefined → the caller falls back to its historical behavior
 *      (usually: cheapest free model on the current provider, or the
 *      turn's own model).
 *
 * Sampling/reliability knobs (temperature, topP, maxTokens,
 * reasoningEffort, maxRetries, timeoutMs) ride along on the profile and
 * are forwarded to the provider driver by the caller.
 */

export type ModelPurpose =
  | 'main'
  | 'supervisor'
  | 'compression'
  | 'routing'
  | 'reviewer'
  | 'summarizer'
  | 'triage'
  | 'extraction'
  | 'evaluate';

export const MODEL_PURPOSES: readonly ModelPurpose[] = [
  'main',
  'supervisor',
  'compression',
  'routing',
  'reviewer',
  'summarizer',
  'triage',
  'extraction',
  'evaluate',
];

export interface PurposeModelProfile {
  providerId?: string;
  modelId?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** Per-call retry budget override for drivers that support it. */
  maxRetries?: number;
  /** Per-call request timeout in ms. */
  timeoutMs?: number;
}

export type ModelProfiles = Partial<Record<ModelPurpose, PurposeModelProfile>>;

function isPurpose(v: string): v is ModelPurpose {
  return (MODEL_PURPOSES as readonly string[]).includes(v);
}

function envKeyFor(purpose: ModelPurpose): string {
  return `MODEL_PROFILE_${purpose.toUpperCase()}`;
}

function parseProviderModel(spec: string): PurposeModelProfile | undefined {
  const trimmed = spec.trim();
  if (!trimmed) return undefined;
  const slash = trimmed.indexOf('/');
  if (slash > 0) {
    return { providerId: trimmed.slice(0, slash), modelId: trimmed.slice(slash + 1) };
  }
  return { modelId: trimmed };
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function sanitizeProfile(raw: unknown): PurposeModelProfile | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const out: PurposeModelProfile = {};
  if (typeof r.providerId === 'string' && r.providerId) out.providerId = r.providerId;
  if (typeof r.modelId === 'string' && r.modelId) out.modelId = r.modelId;
  else if (typeof r.model === 'string' && r.model) {
    // Tolerate "provider/model" in a single `model` field.
    Object.assign(out, parseProviderModel(r.model) ?? {});
  }
  const temperature = num(r.temperature);
  if (temperature !== undefined) out.temperature = temperature;
  const topP = num(r.topP);
  if (topP !== undefined) out.topP = topP;
  const maxTokens = num(r.maxTokens);
  if (maxTokens !== undefined) out.maxTokens = Math.max(1, Math.floor(maxTokens));
  if (r.reasoningEffort === 'low' || r.reasoningEffort === 'medium' || r.reasoningEffort === 'high') {
    out.reasoningEffort = r.reasoningEffort;
  }
  const maxRetries = num(r.maxRetries);
  if (maxRetries !== undefined) out.maxRetries = Math.max(0, Math.floor(maxRetries));
  const timeoutMs = num(r.timeoutMs);
  if (timeoutMs !== undefined) out.timeoutMs = Math.max(0, Math.floor(timeoutMs));
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Parse a model-profiles JSON document (the host's model-profiles.json).
 * Unknown purposes and malformed entries are skipped, never thrown —
 * a bad aux-model config must not take the platform down.
 */
export function parseModelProfiles(text: string): ModelProfiles {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null) return {};
  const out: ModelProfiles = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isPurpose(key)) continue;
    const profile = sanitizeProfile(value);
    if (profile) out[key] = profile;
  }
  return out;
}

/** Resolve the effective profile for a purpose (see header for order). */
export function resolvePurposeProfile(
  purpose: ModelPurpose,
  opts: { profiles?: ModelProfiles; env?: NodeJS.ProcessEnv } = {},
): PurposeModelProfile | undefined {
  const env = opts.env ?? process.env;
  const fromTable = opts.profiles?.[purpose];
  const fromEnvSpec = env[envKeyFor(purpose)] ? parseProviderModel(env[envKeyFor(purpose)]!) : undefined;
  // Legacy single-purpose env vars keep working.
  const legacy =
    purpose === 'reviewer' && env.REVIEWER_MODEL
      ? parseProviderModel(env.REVIEWER_MODEL)
      : undefined;
  const merged: PurposeModelProfile = { ...(legacy ?? {}), ...(fromEnvSpec ?? {}), ...(fromTable ?? {}) };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Pick the concrete model to run a purpose on a GIVEN provider: the
 * profile's model when its provider matches (or names no provider),
 * else undefined (caller falls back to free routing / the turn model).
 */
export function profileModelForProvider(
  profile: PurposeModelProfile | undefined,
  providerId: string,
): string | undefined {
  if (!profile?.modelId) return undefined;
  if (profile.providerId && profile.providerId !== providerId) return undefined;
  return profile.modelId;
}
