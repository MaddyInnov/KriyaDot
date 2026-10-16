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
