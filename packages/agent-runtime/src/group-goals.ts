// SPDX-License-Identifier: Apache-2.0
// Group goals — bounded multi-turn coordinator/worker goal runs (OpenMausBot
// parity).
//
// A group goal differs from a one-shot team run (teams.ts: one coordinator
// turn) and from fusion (fusion.ts: planner → parallel workers → one
// synthesis). The coordinator works in BOUNDED TURNS and ends EVERY turn
// with an explicit control decision inside a fenced envelope:
//
//   ```goal-control
//   {"decision": "continue", "next_step": "…", "summary": "…"}
//   ```
//
// Decisions:
//   - "completed"   → the goal is done; "summary" becomes the final result.
//   - "needs-input" → pause; the user is notified ("needs you") and the goal
//                     resumes when they reply.
//   - "blocked"     → pause with a reason; resumes when the user intervenes.
//   - "continue"    → run the next turn, until maxTurns (hard pause there).
//
// This module is pure (no DB, no I/O): envelope parsing, coordinator prompt
// building, coordinator auto-selection, validation. Persistence, the turn
// loop and HTTP live in the API layer.

import type { BotConfig } from './types.js';

/** The four control decisions a coordinator may emit per turn. */
export type GoalControlDecision = 'completed' | 'needs-input' | 'blocked' | 'continue';

export const GOAL_CONTROL_DECISIONS: readonly GoalControlDecision[] = [
  'completed',
  'needs-input',
  'blocked',
  'continue',
] as const;

/** Fence language tag for the control envelope (original KriyaDot format). */
export const GOAL_CONTROL_FENCE = 'goal-control';

/** Why the parser fell back to "continue". */
export type ControlFallbackReason = 'missing' | 'malformed' | 'unknown-decision';

export interface ParsedControlEnvelope {
  decision: GoalControlDecision;
  /** The coordinator's stated next step (for "continue"). */
  nextStep?: string;
  /** Final summary (for "completed"). */
  summary?: string;
  /** Set when no usable envelope was found — the engine treats it as "continue". */
  fallback?: ControlFallbackReason;
}

export function isGoalControlDecision(v: unknown): v is GoalControlDecision {
  return (
    typeof v === 'string' &&
    (GOAL_CONTROL_DECISIONS as readonly string[]).includes(v.trim().toLowerCase())
  );
}

const FENCE_RE = /```goal-control\s*\n([\s\S]*?)```/g;

/**
 * Parse the coordinator's control decision from its reply text.
 *
 * The LAST fenced ```goal-control block wins (the coordinator's final word
 * for the turn). Missing / malformed / unknown-decision envelopes fall back
 * to "continue" with a `fallback` marker so the engine can note it — the
 * goal never dies just because the model forgot the envelope.
 */
export function parseControlDecision(text: string): ParsedControlEnvelope {
  FENCE_RE.lastIndex = 0;
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = FENCE_RE.exec(text)) !== null) {
    last = m[1];
  }
  if (last === null) {
    return { decision: 'continue', fallback: 'missing' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(last.trim());
  } catch {
    return { decision: 'continue', fallback: 'malformed' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { decision: 'continue', fallback: 'malformed' };
  }
  const obj = parsed as Record<string, unknown>;
  if (!isGoalControlDecision(obj.decision)) {
    return { decision: 'continue', fallback: 'unknown-decision' };
  }
  const decision = (obj.decision as string).trim().toLowerCase() as GoalControlDecision;
  const out: ParsedControlEnvelope = { decision };
  const nextStep = obj.next_step ?? obj.nextStep;
  if (typeof nextStep === 'string' && nextStep.trim()) {
    out.nextStep = nextStep.trim().slice(0, 2000);
  }
  if (typeof obj.summary === 'string' && obj.summary.trim()) {
    out.summary = obj.summary.trim().slice(0, 4000);
  }
  return out;
}

/** A worker bot as presented to the coordinator. */
export interface GoalWorkerInfo {
  id: string;
  name: string;
  description: string;
}

/** Condensed record of one finished turn, fed back into the next prompt. */
export interface GoalTurnSummary {
  turn: number;
  decision: GoalControlDecision;
  nextStep?: string;
  summary?: string;
  /** Worker delegations observed this turn ("Coder: implemented parser (done)"). */
  delegations?: string[];
}

/**
 * Build the coordinator's prompt for one goal turn.
 *
 * The coordinator delegates via the `delegate` / `ask_bot` tools (peer
 * approvals apply through the host's delegate gate) and MUST end every
 * reply with the control envelope. Turn 1 gets the full brief; later turns
 * get the condensed history so context stays bounded.
 */
export function buildGoalCoordinatorPrompt(args: {
  goalTitle: string;
  goalDescription?: string;
  coordinatorName: string;
  workers: GoalWorkerInfo[];
  turnNumber: number;
  maxTurns: number;
  history: GoalTurnSummary[];
  resumeInput?: string;
  roomName?: string;
}): string {
  const {
    goalTitle,
    goalDescription,
    coordinatorName,
    workers,
    turnNumber,
    maxTurns,
    history,
    resumeInput,
    roomName,
  } = args;
  const roster =
    workers.length > 0
      ? workers.map((w) => `- ${w.id} ("${w.name}"): ${w.description || 'general-purpose worker'}`).join('\n')
      : '(no worker bots assigned — do the work yourself)';
  const lines: string[] = [
    `You are ${coordinatorName}, the coordinator of a GROUP GOAL${roomName ? ` in the room "${roomName}"` : ''}.`,
    '',
    `GOAL: ${goalTitle}`,
  ];
  if (goalDescription) {
    lines.push(`Details: ${goalDescription}`);
  }
  lines.push(
    '',
    `This is turn ${turnNumber} of at most ${maxTurns}. Work the goal forward this turn:`,
    '- Break off pieces with the `delegate` tool (args: "task" — a self-contained subtask — and "bot" — the worker id), or consult a worker with `ask_bot`. Delegated workers do NOT see this conversation, so every brief must be fully self-contained.',
    '- Delegation may ask the user for approval first; if a delegation is denied, reassign or proceed without it.',
    '- Prefer doing work through workers over doing everything yourself, but verify their results before building on them.',
    '',
    'Worker roster (use these exact ids):',
    roster,
  );
  if (history.length > 0) {
    lines.push('', 'What happened so far:');
    for (const h of history) {
      const bits = [`Turn ${h.turn}: decision=${h.decision}`];
      if (h.nextStep) bits.push(`next: ${h.nextStep}`);
      if (h.summary) bits.push(`summary: ${h.summary}`);
      if (h.delegations && h.delegations.length > 0) bits.push(`delegations: ${h.delegations.join('; ')}`);
      lines.push(`- ${bits.join(' | ')}`);
    }
  }
  if (resumeInput) {
    lines.push('', `The user resumed the goal with this input: ${resumeInput}`);
  }
  lines.push(
    '',
    'END EVERY REPLY with a control-decision envelope on its own lines, exactly like this:',
    '```goal-control',
    '{"decision": "continue", "next_step": "what you will do next turn", "summary": ""}',
    '```',
    'Decisions: "completed" (goal achieved — put the final summary in "summary"),',
    '"needs-input" (you cannot proceed without the user — say what you need in "next_step"),',
    '"blocked" (stuck on something outside your control — explain in "next_step"),',
    '"continue" (more work remains).',
    'If the goal is not achievable, say so with "blocked" rather than looping forever.',
  );
  return lines.join('\n');
}

/**
 * Auto-select the coordinator: the chief of staff when one exists
 * (it already knows the roster and the delegation doctrine), otherwise
 * the first available bot.
 */
export function selectGoalCoordinator(bots: BotConfig[]): BotConfig | undefined {
  return bots.find((b) => b.chiefOfStaff === true) ?? bots[0];
}

/** Default turn bound (OpenMausBot parity: 13). */
export const DEFAULT_GOAL_MAX_TURNS = 13;
export const MIN_GOAL_MAX_TURNS = 1;
export const MAX_GOAL_MAX_TURNS = 30;

/** Clamp a user-supplied maxTurns into [1, 30]; non-numbers → default 13. */
export function clampGoalMaxTurns(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_GOAL_MAX_TURNS;
  return Math.min(MAX_GOAL_MAX_TURNS, Math.max(MIN_GOAL_MAX_TURNS, Math.floor(v)));
}

const MAX_GOAL_TITLE_LEN = 140;

export function validGoalTitle(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.trim().length <= MAX_GOAL_TITLE_LEN;
}

export const GOAL_ID_RE = /^goal_[a-z0-9]+_[a-z0-9]+$/;

export function newGoalId(): string {
  return `goal_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function newGoalTurnId(): string {
  return `gturn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function isGoalId(v: unknown): v is string {
  return typeof v === 'string' && GOAL_ID_RE.test(v);
}
