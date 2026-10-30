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
import { extractFirstJsonObject, evaluateQuestion, purposeChatOptions } from './evaluate.js';
import { reviewToolCall } from './reviewer.js';
import type { ToolCall } from './types.js';
import type { SteerQueue } from './steer.js';
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
  | { accepted: true; skipped?: boolean; reason: string; model?: string; confidence?: number }
  | { accepted: false; reason: string; guidance: string; model?: string; confidence?: number };

export interface VerifyGateOptions {
  profile?: PurposeModelProfile;
  profiles?: ModelProfiles;
  signal?: AbortSignal;
  /** Max evidence entries quoted to the supervisor. Default 12. */
  maxEvidence?: number;
  /**
   * #28(a): also ask the evaluate seam for calibrated confidence in the
   * claim and attach it to the verdict. Opt-in because it costs an
   * extra aux call; the runtime enables it when an 'evaluate' profile
   * is explicitly configured.
   */
  withConfidence?: boolean;
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
  supervisorStats.recordGate();
  const claim = input.claim.trim();
  if (!claim) return { accepted: true, reason: 'empty final answer — nothing claimed' };
  const successful = input.evidence.filter((e) => e.ok);
  if (successful.length === 0) {
    supervisorStats.recordGateRejection();
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
    supervisorStats.recordGateSkip();
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
      // #8/#11: forward the FULL supervisor-profile knob set; temperature
      // 0 remains only as the default when the profile does not set one.
      {
        model,
        signal: opts.signal,
        ...purposeChatOptions(opts.profile ?? resolvePurposeProfile('supervisor', { profiles: opts.profiles }), { temperature: 0 }),
      },
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
  // #28(a): calibrated confidence on the gate judgment via the evaluate
  // seam — best-effort; a null answer simply leaves confidence unset.
  let confidence: number | undefined;
  if (opts.withConfidence) try {
    const ev = await evaluateQuestion(
      provider,
      {
        kind: 'noul',
        question:
          `Is this completion claim fully supported by the runtime evidence? Claim: ${claim.slice(0, 400)} ` +
          `Evidence: ${input.evidence.slice(-4).map((e) => `${e.toolName}:${e.ok ? 'ok' : 'FAILED'}`).join(', ')}`,
      },
      { profiles: opts.profiles, profile: opts.profile, signal: opts.signal },
    );
    if (ev) confidence = ev.value ? ev.probability : 1 - ev.probability;
  } catch {
    // Confidence is advisory only.
  }
  if (verdict === 'accept') {
    supervisorStats.recordGateAccept();
    return { accepted: true, reason: reason || 'supervisor accepted the evidence', model, confidence };
  }
  if (verdict === 'reject') {
    supervisorStats.recordGateRejection();
    const guidance =
      typeof obj?.guidance === 'string' && obj.guidance.trim()
        ? obj.guidance.slice(0, 800)
        : 'Provide runtime evidence for the claim: run the relevant tools/checks and report their actual results.';
    return {
      accepted: false,
      confidence,
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

// ---------------------------------------------------------------------------
// Octomind closure build (2026-10-30): standing supervisor, authorizer,
// supervisor-owned plan, statistics, steer/delegate/resolve primitives.
// ---------------------------------------------------------------------------

/**
 * Supervisor statistics accumulator (#180): gates fired, rejections,
 * steers, authorizer decisions — accumulated across ALL sessions in the
 * process. The Activity surface reads it via `supervisorStats.snapshot()`
 * (the API host exposes GET on its activity route — see the closure
 * report; `spans.ts` also re-exports a summarizer for it).
 */
export class SupervisorStats {
  gatesFired = 0;
  gateAccepts = 0;
  gateRejections = 0;
  gateSkipped = 0;
  steers = 0;
  authorizerAllowed = 0;
  authorizerDenied = 0;
  authorizerSkipped = 0;
  plansCreated = 0;
  condensations = 0;
  planSketches = 0;

  recordGate(): void { this.gatesFired += 1; }
  recordGateAccept(): void { this.gateAccepts += 1; }
  recordGateRejection(): void { this.gateRejections += 1; }
  recordGateSkip(): void { this.gateSkipped += 1; }
  recordSteer(): void { this.steers += 1; }
  recordAuthorizer(allowed: boolean, skipped = false): void {
    if (skipped) this.authorizerSkipped += 1;
    else if (allowed) this.authorizerAllowed += 1;
    else this.authorizerDenied += 1;
  }
  snapshot(): Record<string, number> {
    return {
      gatesFired: this.gatesFired,
      gateAccepts: this.gateAccepts,
      gateRejections: this.gateRejections,
      gateSkipped: this.gateSkipped,
      steers: this.steers,
      authorizerAllowed: this.authorizerAllowed,
      authorizerDenied: this.authorizerDenied,
      authorizerSkipped: this.authorizerSkipped,
      plansCreated: this.plansCreated,
      condensations: this.condensations,
      planSketches: this.planSketches,
    };
  }
  reset(): void {
    for (const k of Object.keys(this.snapshot())) {
      (this as unknown as Record<string, number>)[k] = 0;
    }
  }
}

/** Process-wide supervisor statistics (#180). */
export const supervisorStats = new SupervisorStats();

/** Stats getter for host surfaces (Activity API). */
export function getSupervisorStats(): Record<string, number> {
  return supervisorStats.snapshot();
}

// --- Supervisor-owned persistent structured plan (#62) ---------------------

export type SupervisorPlanStepStatus = 'pending' | 'active' | 'done' | 'blocked';

export interface SupervisorPlanStep {
  id: string;
  title: string;
  status: SupervisorPlanStepStatus;
  note?: string;
}

export interface SupervisorPlan {
  id: string;
  sessionId: string;
  botId: string;
  request: string;
  steps: SupervisorPlanStep[];
  /** True when this plan came from the human-approved plan-mode gate. */
  humanApproved: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Parse a numbered/bulleted plan text into step titles (pure). */
export function parsePlanStepTitles(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:\d+[.)]|[-*•])\s+(.+)$/);
    if (m && m[1]!.trim().length >= 3) out.push(m[1]!.trim().slice(0, 200));
  }
  return out.slice(0, 25);
}

/**
 * Persistent (per-session) supervisor plan store (#62). Plans survive
 * turns because the store lives on the runtime, not in a turn. Optional
 * JSON persistence: `serialize()` / `restore()` let the host stash the
 * plans alongside the session DB.
 */
export class SupervisorPlanStore {
  private readonly plans = new Map<string, SupervisorPlan>();

  get(sessionId: string): SupervisorPlan | undefined {
    return this.plans.get(sessionId);
  }

  set(input: {
    sessionId: string;
    botId: string;
    request: string;
    steps: string[];
    humanApproved?: boolean;
  }): SupervisorPlan {
    const now = Date.now();
    const existing = this.plans.get(input.sessionId);
    const plan: SupervisorPlan = {
      id: existing?.id ?? `plan-${input.sessionId}`,
      sessionId: input.sessionId,
      botId: input.botId,
      request: input.request,
      steps: input.steps.map((title, i) => ({
        id: `step-${i + 1}`,
        title,
        status: i === 0 ? 'active' : 'pending',
      })),
      humanApproved: input.humanApproved ?? existing?.humanApproved ?? false,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.plans.set(input.sessionId, plan);
    supervisorStats.plansCreated += existing ? 0 : 1;
    return plan;
  }

  updateStep(
    sessionId: string,
    stepIdOrIndex: string | number,
    patch: { status?: SupervisorPlanStepStatus; note?: string },
  ): SupervisorPlan | undefined {
    const plan = this.plans.get(sessionId);
    if (!plan) return undefined;
    const step =
      typeof stepIdOrIndex === 'number'
        ? plan.steps[stepIdOrIndex]
        : plan.steps.find((s) => s.id === stepIdOrIndex);
    if (!step) return undefined;
    if (patch.status) step.status = patch.status;
    if (patch.note !== undefined) step.note = patch.note;
    if (patch.status === 'done') {
      const next = plan.steps.find((s) => s.status === 'pending');
      if (next && !plan.steps.some((s) => s.status === 'active')) next.status = 'active';
    }
    plan.updatedAt = Date.now();
    return plan;
  }

  /** Mark the step whose title best matches a finished tool as done (fuzzy, deterministic). */
  markToolComplete(sessionId: string, toolName: string): void {
    const plan = this.plans.get(sessionId);
    if (!plan) return;
    const active = plan.steps.find((s) => s.status === 'active');
    if (active && active.title.toLowerCase().includes(toolName.toLowerCase())) {
      this.updateStep(sessionId, active.id, { status: 'done' });
    }
  }

  clear(sessionId: string): void {
    this.plans.delete(sessionId);
  }

  serialize(): string {
    return JSON.stringify([...this.plans.values()]);
  }

  restore(json: string): void {
    try {
      const arr = JSON.parse(json) as SupervisorPlan[];
      if (!Array.isArray(arr)) return;
      this.plans.clear();
      for (const p of arr) {
        if (p && typeof p.sessionId === 'string' && Array.isArray(p.steps)) {
          this.plans.set(p.sessionId, p);
        }
      }
    } catch {
      // A corrupt plan snapshot must never break startup.
    }
  }
}

/** Render a plan as the numbered checklist the worker sees. */
export function renderSupervisorPlan(plan: SupervisorPlan): string {
  const mark = (s: SupervisorPlanStepStatus): string =>
    s === 'done' ? '[x]' : s === 'active' ? '[>]' : s === 'blocked' ? '[!]' : '[ ]';
  return plan.steps.map((s, i) => `${i + 1}. ${mark(s.status)} ${s.title}`).join('\n');
}

// --- Independent supervisor authorizer (#23) -------------------------------

export interface AuthorizerVerdict {
  allowed: boolean;
  reason: string;
  model?: string;
  /** True when no reviewer model was available; the call proceeds to governance/human flow. */
  skipped?: boolean;
}

/**
 * Independent tool-call authorizer (#23): the reviewer model judges a
 * MUTATING tool call OUTSIDE auto-approve mode. Composition rule: this
 * runs AFTER governance classification in the runtime — a governance
 * hard denial always wins, and an authorizer ALLOW never overrides a
 * governance denial (the runtime only consults it when governance did
 * not deny). An authorizer DENY blocks the call with its reason.
 */
export async function authorizeToolCall(
  provider: LLMProvider,
  call: ToolCall,
  opts: {
    signal?: AbortSignal;
    profile?: PurposeModelProfile;
    profiles?: ModelProfiles;
  } = {},
): Promise<AuthorizerVerdict> {
  const review = await reviewToolCall(provider, call, {
    signal: opts.signal,
    profile: opts.profile,
    profiles: opts.profiles,
  });
  if (review.verdict === 'yes') {
    supervisorStats.recordAuthorizer(true);
    return { allowed: true, reason: review.reason, model: review.model };
  }
  if (review.verdict === 'no') {
    supervisorStats.recordAuthorizer(false);
    return { allowed: false, reason: review.reason || 'supervisor authorizer declined the call', model: review.model };
  }
  supervisorStats.recordAuthorizer(true, true);
  return { allowed: true, reason: review.reason, model: review.model, skipped: true };
}

// --- Standing supervisor (#20, #24, #26) ------------------------------------

export interface SupervisorObservation {
  toolName: string;
  ok: boolean;
  excerpt: string;
  /** Progress-guard style signals (stall / repeat / failure). */
  unproductiveStreak?: number;
  repeated?: boolean;
}

export interface StandingSupervisorOptions {
  profiles?: ModelProfiles;
  profile?: PurposeModelProfile;
  signal?: AbortSignal;
  /** Max steering injections per turn (#20 bound). Default 3. */
  maxSteersPerTurn?: number;
  /** Condense supervisor state beyond this many chars (#24). Default 8000. */
  condenseThresholdChars?: number;
  /** Injectable condenser (tests / host summarizer); default: compression-profile model call. */
  summarizer?: (stateText: string) => Promise<string>;
  planStore?: SupervisorPlanStore;
  sessionId?: string;
  botId?: string;
  steerQueue?: SteerQueue;
}

/**
 * Standing supervisor (#20): a run-long overseer bound to one turn.
 * (a) `planSketch()` at turn start, (b) `observe()` mid-turn — steering
 * only on stall/repeat/failure signals and bounded per turn, (c) the
 * end-of-turn `verify()` gate (the classic verifyCompletionClaim).
 * Its accumulated state condenses at a threshold (#24) via the
 * compression purpose profile. Primitives (#26): `steer`, `delegate`,
 * `resolve` wrap the existing SteerQueue / delegation / evaluate seams.
 */
export class Supervisor {
  private observations: string[] = [];
  private steersUsed = 0;
  private condensedState = '';
  planSteps: string[] = [];

  constructor(
    private readonly provider: LLMProvider,
    private readonly opts: StandingSupervisorOptions = {},
  ) {}

  get steersIssued(): number {
    return this.steersUsed;
  }

  get stateText(): string {
    return [this.condensedState, ...this.observations].filter(Boolean).join('\n');
  }

  /** (a) Plan sketch at turn start, via the supervisor purpose profile. */
  async planSketch(request: string): Promise<string[]> {
    supervisorStats.planSketches += 1;
    const model = resolveSupervisorModel(this.provider, this.opts);
    if (!model) {
      this.planSteps = parsePlanStepTitles(request).slice(0, 5);
      return this.planSteps;
    }
    try {
      const res = await this.provider.chat(
        [
          {
            role: 'user',
            content:
              'Sketch a short execution plan for this request as a numbered list (max 6 steps, one line each). ' +
              `Reply with ONLY the numbered list.\n\nRequest: ${request.slice(0, 1200)}`,
          },
        ],
        [],
        {
          model,
          signal: this.opts.signal,
          ...purposeChatOptions(
            this.opts.profile ?? resolvePurposeProfile('supervisor', { profiles: this.opts.profiles }),
            { temperature: 0 },
          ),
        },
      );
      const steps = parsePlanStepTitles(res.content ?? '');
      this.planSteps = steps.length > 0 ? steps : [request.slice(0, 120)];
    } catch {
      this.planSteps = [request.slice(0, 120)];
    }
    this.observations.push(`plan: ${this.planSteps.join(' | ')}`);
    // #62: the sketch becomes the session's persistent supervisor plan
    // when a store + session are bound and no human-approved plan exists.
    if (this.opts.planStore && this.opts.sessionId) {
      const existing = this.opts.planStore.get(this.opts.sessionId);
      if (!existing || !existing.humanApproved) {
        this.opts.planStore.set({
          sessionId: this.opts.sessionId,
          botId: this.opts.botId ?? '',
          request,
          steps: this.planSteps,
        });
      }
    }
    return this.planSteps;
  }

  /**
   * (b) Observe a tool outcome; returns steering guidance ONLY on
   * stall/repeat/failure signals, bounded by maxSteersPerTurn.
   */
  observe(obs: SupervisorObservation): string | null {
    this.observations.push(
      `${obs.toolName}: ${obs.ok ? 'ok' : 'FAILED'} — ${obs.excerpt.slice(0, 200)}`,
    );
    const maxSteers = this.opts.maxSteersPerTurn ?? 3;
    if (this.steersUsed >= maxSteers) return null;
    let guidance: string | null = null;
    if (!obs.ok) {
      guidance =
        `[supervisor steering] ${obs.toolName} just failed (${obs.excerpt.slice(0, 160)}). ` +
        'Do not repeat the identical call. Diagnose the failure, change the approach or arguments, or pick an alternative tool.';
    } else if (obs.repeated) {
      guidance =
        `[supervisor steering] You are repeating ${obs.toolName} with the same arguments and getting the same result. ` +
        'Stop the loop: use the result you already have, or change strategy.';
    } else if ((obs.unproductiveStreak ?? 0) >= 3) {
      guidance =
        '[supervisor steering] Several recent tool calls produced no new information. ' +
        'Re-read the original request, check the plan, and take a materially different next step.';
    }
    if (guidance) {
      this.steersUsed += 1;
      supervisorStats.recordSteer();
    }
    return guidance;
  }

  /** (c) End-of-turn verify-gate (delegates to verifyCompletionClaim). */
  async verify(
    input: { request: string; claim: string; evidence: TurnEvidence[] },
  ): Promise<VerifyGateVerdict> {
    return verifyCompletionClaim(this.provider, input, {
      profiles: this.opts.profiles,
      profile: this.opts.profile,
      signal: this.opts.signal,
      withConfidence: Boolean(this.opts.profiles?.evaluate),
    });
  }

  /** Independent authorizer (#23), supervisor-owned. */
  async authorize(call: ToolCall): Promise<AuthorizerVerdict> {
    return authorizeToolCall(this.provider, call, {
      profiles: this.opts.profiles,
      signal: this.opts.signal,
    });
  }

  /** #24: condense accumulated supervisor state past the threshold. */
  async maybeCondense(): Promise<boolean> {
    const threshold = this.opts.condenseThresholdChars ?? 8000;
    const text = this.stateText;
    if (text.length <= threshold) return false;
    let condensed: string;
    if (this.opts.summarizer) {
      condensed = await this.opts.summarizer(text);
    } else {
      const profile = resolvePurposeProfile('compression', { profiles: this.opts.profiles });
      const model = profileModelForProvider(profile, this.provider.providerId) ?? profile?.modelId;
      if (!model) return false;
      const res = await this.provider.chat(
        [
          {
            role: 'user',
            content:
              'Condense this supervisor run state (plan + observations) into a compact briefing under 300 words. ' +
              `Keep: plan steps and their status, failures, open threads.\n\n${text.slice(0, 16000)}`,
          },
        ],
        [],
        { model, signal: this.opts.signal, ...purposeChatOptions(profile, { temperature: 0 }) },
      );
      condensed = (res.content ?? '').trim();
      if (!condensed) return false;
    }
    this.condensedState = condensed.slice(0, 4000);
    this.observations = [];
    supervisorStats.condensations += 1;
    return true;
  }

  // --- Supervisor-owned primitives (#26) -----------------------------------

  /** Steer the running turn via the existing SteerQueue machinery. */
  steer(sessionId: string, text: string, queue?: SteerQueue): boolean {
    const q = queue ?? this.opts.steerQueue;
    if (!q) return false;
    q.enqueue(sessionId, text);
    supervisorStats.recordSteer();
    return true;
  }

  /** Delegate via the host's existing background/delegate starter. */
  async delegate<T>(starter: () => Promise<T> | T): Promise<T> {
    return starter();
  }

  /** Resolve a calibrated question via the evaluate seam. */
  async resolve(question: Parameters<typeof evaluateQuestion>[1]) {
    return evaluateQuestion(this.provider, question, {
      profiles: this.opts.profiles,
      signal: this.opts.signal,
    });
  }

  /** The persistent plan for the bound session (#62). */
  getPlan(): SupervisorPlan | undefined {
    return this.opts.sessionId ? this.opts.planStore?.get(this.opts.sessionId) : undefined;
  }

  updatePlanStep(
    stepIdOrIndex: string | number,
    patch: { status?: SupervisorPlanStepStatus; note?: string },
  ): SupervisorPlan | undefined {
    if (!this.opts.sessionId || !this.opts.planStore) return undefined;
    return this.opts.planStore.updateStep(this.opts.sessionId, stepIdOrIndex, patch);
  }
}
