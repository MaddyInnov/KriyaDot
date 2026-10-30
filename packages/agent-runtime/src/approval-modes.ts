// SPDX-License-Identifier: Apache-2.0
// Approval modes (Atomic parity): per-bot control over how tool approvals
// are handled.
//
// - 'plan'   — the agent must present a plan and get human approval before
//              it may act. The turn pauses at a plan-approval gate.
// - 'auto'   — the current default: routine low-risk actions are allowed by
//              policy, risky ones raise approval cards.
// - 'bypass' — DANGEROUS: every approval is auto-granted. Requires explicit
//              per-bot opt-in in the UI (with a scary confirmation), is
//              logged prominently, and shows a persistent warning banner in
//              chat. The catastrophic-command denylist still applies —
//              bypass can never approve what the tool floor refuses.

export type ApprovalMode = 'plan' | 'auto' | 'bypass';

export const APPROVAL_MODES: readonly ApprovalMode[] = ['plan', 'auto', 'bypass'];

export function parseApprovalMode(raw: unknown): ApprovalMode | undefined {
  return typeof raw === 'string' && (APPROVAL_MODES as readonly string[]).includes(raw)
    ? (raw as ApprovalMode)
    : undefined;
}

export const APPROVAL_MODE_DESCRIPTIONS: Record<ApprovalMode, string> = {
  plan: 'Plan approval: the agent presents a step-by-step plan and waits for your approval before acting.',
  auto: 'Automatic: low-risk actions proceed under policy; risky actions still ask for approval.',
  bypass: 'DANGEROUS: all approvals are auto-granted for this bot. Use only for fully trusted automation.',
};

/** Synthetic tool-call name used for the plan-approval gate card. */
export const PLAN_APPROVAL_TOOL = 'approve_plan';

/**
 * Build the planning prompt used to ask the model for a step-by-step plan
 * before any tool runs. Kept as a pure function for tests.
 */
export function buildPlanPrompt(userMessage: string): string {
  return (
    `You are about to work on the following task. Before taking any action, ` +
    `produce a concise step-by-step plan (numbered list, each step one line). ` +
    `The plan will be shown to the user for approval — be specific about ` +
    `which tools/files you intend to touch, and flag anything risky or ` +
    `irreversible.\n\nTask: ${userMessage}\n\nPlan:`
  );
}

/**
 * Validate a raw approvalMode value from a bot manifest/config.
 * Returns the mode or undefined (caller keeps the default) plus errors.
 */
export function validateApprovalMode(
  raw: unknown,
  where: string,
): { mode?: ApprovalMode; errors: string[] } {
  if (raw === undefined || raw === null) return { errors: [] };
  const mode = parseApprovalMode(raw);
  if (!mode) {
    return { errors: [`${where}.approvalMode: must be one of plan|auto|bypass`] };
  }
  return { mode, errors: [] };
}

// ---------------------------------------------------------------------------
// Closure build (2026-10-30): plan-step parsing (#62) + extended layers (#41).
// ---------------------------------------------------------------------------

/** Parse plan text into step titles (numbered or bulleted lines). */
export function parsePlanSteps(planText: string): string[] {
  const out: string[] = [];
  for (const line of planText.split('\n')) {
    const m = line.match(/^\s*(?:\d+[.)]|[-*•])\s+(.+)$/);
    if (m && m[1]!.trim().length >= 3) out.push(m[1]!.trim().slice(0, 200));
  }
  return out.slice(0, 25);
}

/**
 * Extended layer stage (#41): BotConfig.layers in types.ts only knows
 * 'prepare' | 'review' with fixed output behaviour. This structural
 * extension adds per-stage outputMode, role/profile, and 'execute' /
 * 'verify' kinds AS DATA; the runtime executes them through the
 * existing layer machinery ('execute' runs in the prepare phase,
 * 'verify' in the review phase). Parent merge step: widen
 * LayerStageSpec.kind/outputMode/role in types.ts to this shape.
 */
export type ExtendedLayerKind = 'prepare' | 'review' | 'execute' | 'verify';

export interface ExtendedLayerStage {
  name: string;
  kind: ExtendedLayerKind;
  prompt: string;
  model?: string;
  providerId?: string;
  inputMode?: 'user' | 'draft' | 'user+draft';
  /** How the stage output is applied: note (system note), replace (draft), append. Default by kind. */
  outputMode?: 'note' | 'replace' | 'append';
  /** Persona/role label prepended to the stage prompt by the runtime. */
  role?: string;
  /** Purpose profile name whose model resolves this stage when `model` is unset. */
  profile?: string;
}

export function validateExtendedLayers(
  raw: unknown,
  where: string,
): { layers?: ExtendedLayerStage[]; errors: string[] } {
  if (raw === undefined || raw === null) return { errors: [] };
  if (!Array.isArray(raw)) return { errors: [`${where}.layers: must be an array`] };
  const errors: string[] = [];
  const layers: ExtendedLayerStage[] = [];
  const kinds: readonly string[] = ['prepare', 'review', 'execute', 'verify'];
  raw.forEach((entry, i) => {
    const e = entry as Record<string, unknown>;
    if (typeof e?.name !== 'string' || typeof e?.prompt !== 'string' || !kinds.includes(String(e?.kind))) {
      errors.push(`${where}.layers[${i}]: needs name, prompt, and kind prepare|review|execute|verify`);
      return;
    }
    layers.push({
      name: e.name as string,
      kind: e.kind as ExtendedLayerKind,
      prompt: e.prompt as string,
      ...(typeof e.model === 'string' ? { model: e.model } : {}),
      ...(typeof e.providerId === 'string' ? { providerId: e.providerId } : {}),
      ...(e.inputMode === 'user' || e.inputMode === 'draft' || e.inputMode === 'user+draft' ? { inputMode: e.inputMode } : {}),
      ...(e.outputMode === 'note' || e.outputMode === 'replace' || e.outputMode === 'append' ? { outputMode: e.outputMode } : {}),
      ...(typeof e.role === 'string' ? { role: e.role } : {}),
      ...(typeof e.profile === 'string' ? { profile: e.profile } : {}),
    });
  });
  return errors.length > 0 ? { errors } : { layers, errors };
}
