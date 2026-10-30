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
// - 'acceptEdits' (CA-2) — file edits and a small set of safe filesystem
//              shell commands are auto-allowed; everything else follows
//              the normal 'auto' rules. It only ever upgrades a
//              'require-approval' verdict for those narrow call shapes —
//              governance denies still deny.
// - 'dontAsk' (CA-2) — anything that would prompt is denied instead;
//              explicit policy allows still work. Strictly stricter than
//              'auto': it only ever turns prompts into denials.

export type ApprovalMode = 'plan' | 'auto' | 'bypass' | 'acceptEdits' | 'dontAsk';

export const APPROVAL_MODES: readonly ApprovalMode[] = ['plan', 'auto', 'bypass', 'acceptEdits', 'dontAsk'];

export function parseApprovalMode(raw: unknown): ApprovalMode | undefined {
  return typeof raw === 'string' && (APPROVAL_MODES as readonly string[]).includes(raw)
    ? (raw as ApprovalMode)
    : undefined;
}

export const APPROVAL_MODE_DESCRIPTIONS: Record<ApprovalMode, string> = {
  plan: 'Plan approval: the agent presents a step-by-step plan and waits for your approval before acting.',
  auto: 'Automatic: low-risk actions proceed under policy; risky actions still ask for approval.',
  bypass: 'DANGEROUS: all approvals are auto-granted for this bot. Use only for fully trusted automation.',
  acceptEdits: 'Accept edits: file edits and safe filesystem commands proceed automatically; anything else still asks for approval.',
  dontAsk: "Don't ask: anything that would need approval is denied instead. Only explicitly allowed actions proceed.",
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
    return { errors: [`${where}.approvalMode: must be one of plan|auto|bypass|acceptEdits|dontAsk`] };
  }
  return { mode, errors: [] };
}

// ---------------------------------------------------------------------------
// CA-2: the governance-evaluation mapping for acceptEdits / dontAsk.
// Pure + total: given the mode, the governance verdict for a call, and the
// call's shape, return the verdict the runtime should act on. Governance
// itself is untouched — this mapping runs AFTER evaluation, and it can
// never turn a 'deny' into anything else.
// ---------------------------------------------------------------------------

export type ModeGovernanceDecision = 'allow' | 'deny' | 'require-approval';

export interface ApprovalModeCallInfo {
  /** Tool name, e.g. 'write_file' or 'run_command'. */
  name: string;
  /** The tool definition's mutating flag, when known. */
  mutating?: boolean;
  /** Tool args (used to inspect shell commands for acceptEdits). */
  args?: Record<string, unknown>;
}

/** Tools whose whole purpose is editing a workspace file (acceptEdits). */
export const FILE_EDIT_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'edit_file',
  'create_file',
  'apply_patch',
  'patch_file',
  'notebook_edit',
]);

export function isFileEditTool(name: string): boolean {
  return FILE_EDIT_TOOLS.has(name);
}

/**
 * Shell commands acceptEdits treats as "safe filesystem commands":
 * read-only inspection plus basic file management with no chaining,
 * redirection, substitution or glob-freeform shell features. Anything
 * with shell metacharacters is NOT safe (it could hide a second command).
 */
const SAFE_FS_COMMAND = /^\s*(ls|dir|pwd|mkdir|touch|cp|mv|cat|head|tail|wc|stat|git\s+(status|diff|log|add))\b[^;&|`$<>\n]*$/;

export function isSafeFilesystemCommand(command: unknown): boolean {
  if (typeof command !== 'string' || !command.trim()) return false;
  if (/[;&|`$<>\n]|\$\(|&&|\|\|/.test(command)) return false;
  return SAFE_FS_COMMAND.test(command);
}

/** Extract the shell command string from a run_command-style call. */
function shellCommandOf(call: ApprovalModeCallInfo): string | undefined {
  if (call.name !== 'run_command' && call.name !== 'exec' && call.name !== 'shell') return undefined;
  const cmd = call.args?.['command'] ?? call.args?.['cmd'];
  return typeof cmd === 'string' ? cmd : undefined;
}

export interface ApprovalModeApplication {
  decision: ModeGovernanceDecision;
  /** Set when the mode changed (or deliberately confirmed) the verdict. */
  reason?: string;
  /** True when the returned decision differs from the input decision. */
  changed: boolean;
}

/**
 * Apply a named approval mode to a governance verdict.
 *
 * Matrix (input → output):
 *  - plan / auto: unchanged (plan gates the turn earlier; auto is the
 *    baseline the other modes are defined against).
 *  - bypass: 'require-approval' → 'allow' (runtime also audits loudly
 *    and overrides bypass on bot-originated turns before this point).
 *  - acceptEdits: 'require-approval' → 'allow' ONLY for file-edit tools
 *    and safe filesystem commands; everything else unchanged.
 *  - dontAsk: 'require-approval' → 'deny'; 'allow'/'deny' unchanged
 *    (explicit allows still work).
 * A governance 'deny' is never upgraded by any mode.
 */
export function applyApprovalMode(
  mode: ApprovalMode,
  decision: ModeGovernanceDecision,
  call: ApprovalModeCallInfo,
): ApprovalModeApplication {
  if (decision === 'deny') return { decision, changed: false };
  switch (mode) {
    case 'dontAsk':
      return decision === 'require-approval'
        ? { decision: 'deny', changed: true, reason: "dontAsk mode: approval prompts are denied instead of shown" }
        : { decision, changed: false };
    case 'acceptEdits': {
      if (decision !== 'require-approval') return { decision, changed: false };
      if (isFileEditTool(call.name)) {
        return { decision: 'allow', changed: true, reason: `acceptEdits mode: file edit via ${call.name} auto-allowed` };
      }
      const cmd = shellCommandOf(call);
      if (cmd !== undefined && isSafeFilesystemCommand(cmd)) {
        return { decision: 'allow', changed: true, reason: 'acceptEdits mode: safe filesystem command auto-allowed' };
      }
      return { decision, changed: false };
    }
    case 'bypass':
      return decision === 'require-approval'
        ? { decision: 'allow', changed: true, reason: 'bypass mode: approval auto-granted' }
        : { decision, changed: false };
    default:
      return { decision, changed: false };
  }
}

/**
 * Native-CLI permission-mode mapping (for the cli-driver wiring): Claude
 * Code's own permission modes include acceptEdits and dontAsk verbatim;
 * Codex has no equivalents, so both fall back to its workspace sandbox
 * (unanswerable prompts fail closed there, which is dontAsk's spirit;
 * acceptEdits' edit allowance is approximated by the sandbox write grant).
 */
export function nativeCliPermissionMode(mode: ApprovalMode, cli: 'claude-code' | 'codex'): string {
  if (cli === 'claude-code') {
    switch (mode) {
      case 'bypass': return 'bypassPermissions';
      case 'acceptEdits': return 'acceptEdits';
      case 'dontAsk': return 'dontAsk';
      default: return 'default';
    }
  }
  return mode === 'bypass' ? 'danger-full-access' : 'workspace-write';
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
