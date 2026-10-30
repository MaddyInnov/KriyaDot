// SPDX-License-Identifier: Apache-2.0
/**
 * Smart model routing (Phase 3, workstream D).
 *
 * Pure function of the provider/model catalog — no network, no keys, no
 * provider calls. Picks a (providerId, modelId) pair for a task type:
 *
 * - code      → strongest available code-capable model
 * - reasoning → strongest available reasoning-capable model
 * - chat      → strongest available general model
 * - simple-qa → cheapest/free model ($0 free models first, then lowest
 *               list-price input cost from pricing.ts)
 *
 * Rules (in precedence order):
 * 1. An explicit user override (`botModel`) ALWAYS wins — but it is still
 *    subject to the free-only guard below (fail closed).
 * 2. When FREE_MODELS_ONLY=1/true in the environment, or `freeOnly: true`
 *    is passed, routing stays strictly within models flagged free in the
 *    catalog (`free: true`, or an id ending in `:free` / `-free`, via
 *    `isFreeModel`). If no free model exists, routing throws instead of
 *    silently falling back to a paid model.
 *
 * The coordinator's injection point is `AgentRuntime.runTurn` (see
 * runtime.ts): replace the `providerId`/`model` resolution there with a
 * `routeModel(...)` call. `routeModel` never calls `assertModelAllowed`
 * itself — the runtime keeps doing that as the final choke point.
 */

import {
  FREE_MODELS_ONLY_ENV_VAR,
  isFreeModel,
  listProviderPresets,
} from './providers/catalog.js';
import type { ProviderModelPreset } from './providers/catalog.js';
import { priceOfModel } from './pricing.js';
import { matchLearnedRule } from './routing-learn.js';
import type { LearnedRoutingRule } from './routing-learn.js';

export type TaskType = 'code' | 'chat' | 'reasoning' | 'simple-qa';

export interface RouteModelInput {
  taskType: TaskType;
  /**
   * Explicit user/model override. Accepts `providerId/modelId`
   * (e.g. "groq/gpt-oss-20b") or a bare model id (e.g. "gpt-oss-20b",
   * resolved against the catalog). Always wins, subject to the free-only
   * guard.
   */
  botModel?: string;
  /** Force free-models-only routing even when the env guard is off. */
  freeOnly?: boolean;
  /**
   * When set, only models from this provider are considered (the bot's
   * pinned provider). Unknown/empty provider pools fall back to the full
   * catalog rather than throwing, so dynamic providers (e.g. subscription
   * bridges whose models aren't in the static catalog) keep working.
   */
  providerHint?: string;
  /**
   * The user message being routed (optional). Used ONLY to match learned
   * routing rules that carry message patterns (routing-learn.ts). Never
   * sent anywhere.
   */
  message?: string;
  /**
   * Learned routing rules from user corrections (routing-learn.ts), newest
   * first. The first matching rule wins over the built-in heuristics below
   * — but never over an explicit `botModel` override, and never against
   * the free-only guard (fail closed: a rule targeting a paid model is
   * skipped while the guard is active).
   */
  learnedRules?: LearnedRoutingRule[];
}

export interface RouteModelResult {
  providerId: string;
  modelId: string;
  /** Human-readable explanation of why this model was picked. */
  reason: string;
}

interface Candidate {
  providerId: string;
  model: ProviderModelPreset;
}

/** All catalog models, in catalog order (deterministic tie-breaking). */
function allCandidates(): Candidate[] {
  const out: Candidate[] = [];
  for (const preset of listProviderPresets()) {
    for (const model of preset.models) {
      out.push({ providerId: preset.id, model });
    }
  }
  return out;
}

/** True when the free-only constraint is active (param or env kill switch). */
export function freeOnlyActive(freeOnly?: boolean): boolean {
  if (freeOnly === true) return true;
  const raw = process.env[FREE_MODELS_ONLY_ENV_VAR];
  return raw === '1' || (typeof raw === 'string' && raw.toLowerCase() === 'true');
}

/** Extract a parameter-count hint (billions) from ids like "gpt-oss-120b". */
function paramSizeB(id: string): number | undefined {
  const m = /(\d+(?:\.\d+)?)\s*b(?:\b|-|$)/i.exec(id);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * General capability score. Documented heuristic over catalog metadata only:
 * parameter-count hints, tier words in the id/name, context length, and the
 * catalog default flag. Higher = stronger.
 */
function strengthScore(c: Candidate): number {
  const t = `${c.model.id} ${c.model.name}`.toLowerCase();
  let s = 0;
  const size = paramSizeB(c.model.id);
  if (size !== undefined) s += Math.log10(size) * 12;
  if (/\b(ultra|opus|sonnet|pro|max|premier|large)\b/.test(t)) s += 5;
  if (/\b(mini|nano|lite|flash|haiku|small|tiny|distill|1b|3b)\b/.test(t)) s -= 5;
  if ((c.model.contextLength ?? 0) >= 128000) s += 2;
  if (c.model.default) s += 1;
  return s;
}

/** Code-task score: general strength plus code-capability markers. */
function codeScore(c: Candidate): number {
  const t = `${c.model.id} ${c.model.name}`.toLowerCase();
  let s = strengthScore(c);
  if (/\bcode\b|coder|coding|\bdev\b|developer/.test(t)) s += 8;
  if (/oss/.test(c.model.id.toLowerCase())) s += 4; // gpt-oss class: strong open-weight coding/reasoning
  if (/\b(sonnet|opus)\b/.test(t)) s += 4;
  if (/agent|compound|tool/.test(t)) s += 2; // agentic tool-use models
  if (/\b(chat|vision|embed|audio|tts|whisper|image)\b/.test(t)) s -= 4;
  return s;
}

/** Reasoning-task score: general strength plus reasoning markers. */
function reasoningScore(c: Candidate): number {
  const t = `${c.model.id} ${c.model.name}`.toLowerCase();
  let s = strengthScore(c);
  if (/(^|-)r1(\b|-|$)/.test(c.model.id.toLowerCase())) s += 10;
  if (/reasoning|think|deep/.test(t)) s += 6;
  if (/oss/.test(c.model.id.toLowerCase())) s += 4;
  if (/\b(distill|flash|nano|mini|haiku|lite)\b/.test(t)) s -= 4;
  return s;
}

/**
 * Estimated USD cost per 1M input tokens. Catalog-flagged free models cost
 * 0 authoritatively; otherwise the pricing table is consulted (this includes
 * $0-marginal subscription bridges — but see the tie-break in simple-qa).
 * Models with no pricing entry and no free flag are unknown cost (Infinity)
 * so priced options are always preferred for simple-qa.
 */
function costPer1MInput(c: Candidate): number {
  if (isFreeModel(c.providerId, c.model.id)) return 0;
  return priceOfModel(c.providerId, c.model.id)?.inputPer1M ?? Number.POSITIVE_INFINITY;
}

function pickStrongest(cands: Candidate[], score: (c: Candidate) => number): Candidate {
  let best = cands[0]!;
  let bestScore = score(best);
  for (const c of cands.slice(1)) {
    const s = score(c);
    if (s > bestScore) {
      best = c;
      bestScore = s;
    }
  }
  return best;
}

/** Resolve an explicit override to a catalog (providerId, modelId) pair. */
function resolveOverride(botModel: string): Candidate {
  const cands = allCandidates();
  const slash = botModel.indexOf('/');
  if (slash > 0) {
    const providerId = botModel.slice(0, slash);
    const modelId = botModel.slice(slash + 1);
    const hit = cands.find((c) => c.providerId === providerId && c.model.id === modelId);
    if (!hit) {
      throw new Error(
        `routeModel: override "${botModel}" does not match any catalog model (expected "providerId/modelId").`,
      );
    }
    return hit;
  }
  const hits = cands.filter((c) => c.model.id === botModel);
  if (hits.length === 0) {
    throw new Error(`routeModel: override model "${botModel}" not found in the catalog.`);
  }
  return hits[0]!;
}

/**
 * Route a task to a (providerId, modelId) pair. Pure function of the
 * catalog; throws (fail closed) when the free-only constraint cannot be
 * satisfied or an override names an unknown/non-free model.
 */
export function routeModel(input: RouteModelInput): RouteModelResult {
  const constrained = freeOnlyActive(input.freeOnly);

  // 1. Explicit override always wins (still gated by the free-only guard).
  if (input.botModel) {
    const hit = resolveOverride(input.botModel);
    if (constrained && !isFreeModel(hit.providerId, hit.model.id)) {
      throw new Error(
        `${FREE_MODELS_ONLY_ENV_VAR} is active: override "${input.botModel}" ` +
          `(${hit.providerId}/${hit.model.id}) is not a free model, so routing refuses it. ` +
          `Pick a free model or lift the guard.`,
      );
    }
    return {
      providerId: hit.providerId,
      modelId: hit.model.id,
      reason:
        `explicit override "${input.botModel}" wins over task-type routing` +
        (constrained ? ' (verified free under the free-only guard)' : '') +
        '.',
    };
  }

  let cands = allCandidates();
  if (cands.length === 0) {
    throw new Error('routeModel: the provider catalog contains no models to route to.');
  }
  // Provider affinity: when the caller pins a provider (bot config), stay
  // inside it when it has models; otherwise fall back to the full catalog.
  if (input.providerHint) {
    const scoped = cands.filter((c) => c.providerId === input.providerHint);
    if (scoped.length > 0) cands = scoped;
  }
  if (constrained) {
    cands = cands.filter((c) => isFreeModel(c.providerId, c.model.id));
    if (cands.length === 0) {
      throw new Error(
        `${FREE_MODELS_ONLY_ENV_VAR} is active but the catalog contains no free models — ` +
          'routing refuses to pick a paid model. Add a free model to the catalog or lift the guard.',
      );
    }
  }
  const scope = constrained ? 'free-only pool' : 'full catalog';

  // Learned rules from user corrections (routing-learn.ts): checked after
  // the explicit override above, before the built-in heuristics. The
  // free-only guard is fail-closed — a rule pointing at a paid model is
  // skipped rather than applied.
  if (input.learnedRules && input.learnedRules.length > 0) {
    const rule = matchLearnedRule(input.learnedRules, {
      taskType: input.taskType,
      message: input.message,
    });
    if (rule && (!constrained || isFreeModel(rule.then.providerId, rule.then.modelId))) {
      const n = rule.count === 1 ? '1 user correction' : `${rule.count} user corrections`;
      return {
        providerId: rule.then.providerId,
        modelId: rule.then.modelId,
        reason:
          `learned routing rule (from ${n}): ${rule.description} ` +
          `→ ${rule.then.providerId}/${rule.then.modelId}.`,
      };
    }
  }

  switch (input.taskType) {
    case 'code': {
      const best = pickStrongest(cands, codeScore);
      return {
        providerId: best.providerId,
        modelId: best.model.id,
        reason: `code task → strongest code-capable model in the ${scope}: ${best.providerId}/${best.model.id}.`,
      };
    }
    case 'reasoning': {
      const best = pickStrongest(cands, reasoningScore);
      return {
        providerId: best.providerId,
        modelId: best.model.id,
        reason: `reasoning task → strongest reasoning-capable model in the ${scope}: ${best.providerId}/${best.model.id}.`,
      };
    }
    case 'chat': {
      const best = pickStrongest(cands, strengthScore);
      return {
        providerId: best.providerId,
        modelId: best.model.id,
        reason: `chat task → strongest general model in the ${scope}: ${best.providerId}/${best.model.id}.`,
      };
    }
    case 'simple-qa': {
      const ranked = [...cands].sort((a, b) => {
        const cost = costPer1MInput(a) - costPer1MInput(b);
        if (cost !== 0) return cost;
        // $0 tie-break: catalog-flagged free models beat $0-marginal
        // subscription bridges (those need the user's own CLI login, which
        // routing cannot verify), then strongest wins.
        const free =
          Number(isFreeModel(b.providerId, b.model.id)) -
          Number(isFreeModel(a.providerId, a.model.id));
        if (free !== 0) return free;
        return strengthScore(b) - strengthScore(a);
      });
      const best = ranked[0]!;
      const cost = costPer1MInput(best);
      return {
        providerId: best.providerId,
        modelId: best.model.id,
        reason:
          cost === 0
            ? `simple-qa task → free model ${best.providerId}/${best.model.id} ($0; strongest of the free options in the ${scope}).`
            : cost === Number.POSITIVE_INFINITY
              ? `simple-qa task → ${best.providerId}/${best.model.id} (no priced or free model found in the ${scope}; strongest available as fallback).`
              : `simple-qa task → cheapest priced model in the ${scope}: ${best.providerId}/${best.model.id} (~$${cost}/1M input tokens).`,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Evaluate-assisted routing (closure #28): routeModel above is purely
// deterministic. When a caller has several plausible candidate routes
// and no deterministic reason to prefer one, this seam asks the
// calibrated evaluateQuestion (choice kind, resolved through the
// 'routing' purpose profile) and accepts its pick ONLY at/above the
// probability threshold; below it — or when the judge is unavailable —
// the deterministic routeModel result stands (abstention). This is
// the routing.ts counterpart of message-router.ts's seam, for callers
// that route MODELS rather than bots.
// ---------------------------------------------------------------------------

import type { LLMProvider } from './types.js';
import { evaluateQuestion } from './evaluate.js';
import type { ModelProfiles, PurposeModelProfile } from './model-profiles.js';

export interface EvaluateRouteOutcome {
  result: RouteModelResult;
  /** 'deterministic' (no judge consulted/needed) | 'evaluate' (judge pick accepted) | 'abstained' (judge unsure → deterministic kept). */
  via: 'deterministic' | 'evaluate' | 'abstained';
  /** The judge's calibrated probability, when it answered. */
  probability?: number;
}

export async function routeModelWithEvaluate(
  provider: LLMProvider,
  input: RouteModelInput,
  opts: {
    /** Candidate routes the judge may choose between (deduped by provider/model). */
    candidates: RouteModelResult[];
    /** Probability at/above which the judge's pick wins. Default 0.6. */
    acceptThreshold?: number;
    profiles?: ModelProfiles;
    profile?: PurposeModelProfile;
    signal?: AbortSignal;
  },
): Promise<EvaluateRouteOutcome> {
  const deterministic = routeModel(input);
  const seen = new Set<string>();
  const candidates = opts.candidates.filter((c) => {
    const key = `${c.providerId}/${c.modelId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (candidates.length < 2) return { result: deterministic, via: 'deterministic' };
  // A candidate list that already contains only the deterministic pick
  // needs no judge.
  if (candidates.every((c) => c.providerId === deterministic.providerId && c.modelId === deterministic.modelId)) {
    return { result: deterministic, via: 'deterministic' };
  }
  const labels = candidates.map((c) => `${c.providerId}/${c.modelId}`);
  const ans = await evaluateQuestion(
    provider,
    {
      kind: 'choice',
      question:
        `Which model is the best fit for a "${input.taskType}" task` +
        (input.message ? ` described as: ${input.message.slice(0, 400)}` : '') +
        `? Candidates: ${candidates.map((c, i) => `${labels[i]} (${c.reason})`).join('; ')}`,
      choices: labels,
    },
    { profiles: opts.profiles, profile: opts.profile, signal: opts.signal, purpose: 'routing' },
  );
  if (!ans || typeof ans.value !== 'string') return { result: deterministic, via: 'deterministic' };
  const threshold = opts.acceptThreshold ?? 0.6;
  if (ans.probability < threshold) {
    return { result: deterministic, via: 'abstained', probability: ans.probability };
  }
  const picked = candidates[labels.indexOf(ans.value)];
  if (!picked) return { result: deterministic, via: 'abstained', probability: ans.probability };
  return {
    result: { ...picked, reason: `${picked.reason} [evaluate seam chose it with p=${ans.probability.toFixed(2)}${ans.reason ? `: ${ans.reason}` : ''}]` },
    via: 'evaluate',
    probability: ans.probability,
  };
}
