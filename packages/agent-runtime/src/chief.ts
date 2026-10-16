// SPDX-License-Identifier: Apache-2.0
// Chief of Staff — the persistent persona layer that sits on top of the
// one-shot coordinator (teams.ts).
//
// A bot flagged `chiefOfStaff: true` gets a chief section injected into its
// system prompt on every turn (via a TurnContextProvider registered by the
// host — see runtime.ts's addContextProvider). The section carries the live
// team roster inside fenced markers so the host can replace it cheaply,
// plus the delegation doctrine, the incidents/escalations inbox rules, and
// the team-setup rules. The tools that back those rules live in
// tools/chief.ts and are chief-only (every handler checks isChief).

import { randomUUID } from 'node:crypto';
import { redactSecrets } from './agent-import.js';
import type { BotConfig } from './types.js';

/** Fence markers that wrap the live roster inside the chief prompt section. */
export const CHIEF_ROSTER_START = '<!-- kriyadot:chief-roster:start -->';
export const CHIEF_ROSTER_END = '<!-- kriyadot:chief-roster:end -->';

/** Maximum bots listed in the roster (rest are summarized). */
export const CHIEF_ROSTER_CAP = 40;

/** Maximum automatic retries for a failed delegation before an incident is filed. */
export const MAX_DELEGATION_RETRIES = 2;

/**
 * True when the delegation attempts have exceeded the retry budget and the
 * chief should stop retrying (file/keep the incident, possibly escalate).
 */
export function shouldEscalate(attempts: number): boolean {
  return attempts > MAX_DELEGATION_RETRIES;
}

/** A bot as seen from the chief's roster (id, name, one-line description). */
export interface ChiefRosterBot {
  id: string;
  name: string;
  description: string;
  /** Tool names the bot exposes (informational, truncated in the render). */
  tools?: string[];
}

/** Render the team roster as a markdown list, capped at CHIEF_ROSTER_CAP bots. */
export function renderChiefRoster(bots: ChiefRosterBot[]): string {
  if (bots.length === 0) return 'No other bots on the team yet.';
  const shown = bots.slice(0, CHIEF_ROSTER_CAP);
  const lines = shown.map((b) => {
    const toolNote =
      b.tools && b.tools.length > 0 ? ` [tools: ${b.tools.slice(0, 8).join(', ')}${b.tools.length > 8 ? ', …' : ''}]` : '';
    return `- **${b.id}** — ${b.name}: ${b.description || 'no description'}${toolNote}`;
  });
  if (bots.length > CHIEF_ROSTER_CAP) {
    lines.push(`…and ${bots.length - CHIEF_ROSTER_CAP} more (see list_bots for the full roster).`);
  }
  return lines.join('\n');
}

/**
 * Build the chief section for the system prompt. Original KriyaDot wording:
 * the chief is the user's primary contact for its section, coordinates the
 * team, files incidents/escalations, and proposes (never applies) team-setup
 * changes.
 */
export function buildChiefSection(chief: BotConfig, bots: BotConfig[]): string {
  const sectionName = chief.managedSections && chief.managedSections.length > 0 ? chief.managedSections.join(', ') : 'general';
  const roster: ChiefRosterBot[] = bots
    .filter((b) => b.id !== chief.id)
    .map((b) => ({
      id: b.id,
      name: b.name,
      description: b.description ?? '',
      tools: b.tools,
    }));
  const rosterText = renderChiefRoster(roster);

  return [
    `# Chief of Staff — ${chief.name}`,
    '',
    `You are the Chief of Staff for the "${sectionName}" section. You are the user's primary point of contact for everything in this section: the user talks to you, and you coordinate the specialist bots behind the scenes. Speak to the user in first person as their chief of staff — never as a neutral tool.`,
    '',
    '## Your team roster',
    CHIEF_ROSTER_START,
    rosterText,
    CHIEF_ROSTER_END,
    '',
    'The roster above is refreshed every turn. Use list_bots for the same list inside a turn if you need to double-check a bot id.',
    '',
    '## Delegation doctrine',
    '',
    'For each piece of work, pick exactly one of:',
    '- **Handle it directly** — quick answers, coordination, and anything only you can decide.',
    '- **Assign** (`coordinate_bots` mode `assign`) — the work belongs to a specialist. Write the brief as if the recipient has never seen this conversation: goal, inputs, constraints, and what "done" looks like. Then END YOUR TURN. The result comes back to you; when it does, check it against the brief before answering the user.',
    '- **Consult** (`coordinate_bots` mode `consult`) — you need a specialist\'s opinion, not their action. Frame it as advice-only.',
    '- **Notify** (`coordinate_bots` mode `notify`) — the specialist should know something, no reply needed.',
    '',
    'Rules you do not bend:',
    '- Briefs must be self-contained. Delegated bots do not see your transcript.',
    '- Never invent a specialist\'s result. If you have no result, say so and say what you are doing about it.',
    '- After assigning, wait for the result instead of guessing. When it arrives, verify it (run it, read it, or spot-check it) before presenting it as done.',
    '- On failure: rework the brief (narrower scope, clearer done-criteria) and retry. At most 2 retries for one delegation.',
    '',
    '## Incidents',
    '',
    `Failed delegations land in the Team incidents inbox with a plain-language summary (filed automatically after ${MAX_DELEGATION_RETRIES} retries). When you see an incident: read it, decide whether the brief was at fault or the specialist was, and either retry it once via \`retry_thread\` with a fixed brief or tell the user plainly what failed and what you need from them. Do not quietly retry more than ${MAX_DELEGATION_RETRIES} times — after that, the user decides.`,
    '',
    '## Escalations',
    '',
    'Some gates only a person can lift: approvals the user must tap, credentials, purchases, publishing decisions. Those surface in the Team escalations inbox. Your job is to RELAY them to the user with context and a recommendation — never act in their place, never pretend the gate is lifted, and never route around it with a different tool.',
    '',
    '## Team setup',
    '',
    'The roster is yours to shape but NOT yours to change unilaterally. Every change needs the user\'s approval, so proposals are how you act:',
    '- `propose_team_setup` — for anything that touches more than one bot (restructure, bulk updates, new teams).',
    '- `create_bot` — ONLY to propose a single new specialist. With `suggestion: true` it is recorded as a soft suggestion; either way it becomes a pending proposal, never a direct change.',
    '- `propose_bot_deletion` — to propose removing a bot. You may never propose deleting yourself.',
    'Approved proposals are applied by the host; rejected ones are dropped. You report the outcome to the user either way.',
  ].join('\n');
}

/**
 * Inject (or replace) the chief section in a system prompt. When the roster
 * markers are already present, only the content between them is replaced
 * (cheap refresh of a stale roster); otherwise the section is appended.
 */
export function injectChiefSection(basePrompt: string, section: string): string {
  const start = section.indexOf(CHIEF_ROSTER_START);
  const end = section.indexOf(CHIEF_ROSTER_END);
  if (start !== -1 && end !== -1 && end > start) {
    const baseStart = basePrompt.indexOf(CHIEF_ROSTER_START);
    const baseEnd = basePrompt.indexOf(CHIEF_ROSTER_END);
    if (baseStart !== -1 && baseEnd !== -1 && baseEnd > baseStart) {
      return (
        basePrompt.slice(0, baseStart) +
        section.slice(start, end + CHIEF_ROSTER_END.length) +
        basePrompt.slice(baseEnd + CHIEF_ROSTER_END.length)
      );
    }
  }
  return basePrompt.endsWith('\n') ? `${basePrompt}\n${section}\n` : `${basePrompt}\n\n${section}\n`;
}

// ---------------------------------------------------------------------------
// Incidents & escalations
// ---------------------------------------------------------------------------

/** Kind of chief inbox item. */
export type ChiefIncidentKind = 'incident' | 'escalation';

/** Lifecycle of an inbox item. */
export type ChiefIncidentStatus = 'open' | 'triaged' | 'resolved';

/** One inbox item: a failed delegation (incident) or a user-only gate (escalation). */
export interface ChiefIncident {
  id: string;
  kind: ChiefIncidentKind;
  chiefBotId: string;
  targetBotId?: string;
  targetBotName?: string;
  threadId?: string;
  summary: string;
  detail?: string;
  attempts: number;
  status: ChiefIncidentStatus;
  createdAt: string;
  updatedAt: string;
}

export interface NewChiefIncident {
  kind: ChiefIncidentKind;
  chiefBotId: string;
  targetBotId?: string;
  targetBotName?: string;
  threadId?: string;
  summary: string;
  detail?: string;
  attempts?: number;
}

/** Build a stored incident record from a new-incident input. */
export function makeChiefIncident(input: NewChiefIncident): ChiefIncident {
  const now = new Date().toISOString();
  return {
    id: `cin_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    kind: input.kind,
    chiefBotId: input.chiefBotId,
    targetBotId: input.targetBotId,
    targetBotName: input.targetBotName,
    threadId: input.threadId,
    summary: input.summary,
    detail: input.detail,
    attempts: input.attempts ?? 0,
    status: 'open',
    createdAt: now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Team-setup proposals
// ---------------------------------------------------------------------------

/** One roster change inside a proposal. */
export interface ChiefProposalOp {
  action: 'create' | 'update' | 'delete';
  /** Slug-style key for create ops (becomes the bot id). */
  key?: string;
  /** Target bot id for update/delete ops. */
  botId?: string;
  /** Field values for create/update ops. */
  fields?: Record<string, unknown>;
}

export type ChiefProposalKind = 'team-setup' | 'create-bot' | 'delete-bot';
export type ChiefProposalStatus = 'pending' | 'approved' | 'rejected';

/** A proposed roster change awaiting user approval. */
export interface ChiefProposal {
  id: string;
  kind: ChiefProposalKind;
  createdByBotId: string;
  reason: string;
  operations: ChiefProposalOp[];
  status: ChiefProposalStatus;
  /** Set by create_bot(suggestion: true); UI renders these as soft suggestions. */
  suggestion?: boolean;
  /** Team names the proposal establishes (team-setup proposals). */
  newTeams?: string[];
  createdAt: string;
  decidedAt?: string;
}

export interface NewChiefProposal {
  kind: ChiefProposalKind;
  createdByBotId: string;
  reason: string;
  operations: ChiefProposalOp[];
  suggestion?: boolean;
  newTeams?: string[];
}

export function makeChiefProposal(input: NewChiefProposal): ChiefProposal {
  return {
    id: `cpr_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    kind: input.kind,
    createdByBotId: input.createdByBotId,
    reason: input.reason,
    operations: input.operations,
    suggestion: input.suggestion,
    newTeams: input.newTeams,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
}

/** Maximum operations in a single team-setup proposal. */
export const MAX_PROPOSAL_OPS = 24;

/** Proposal op count limits shared by runtime tools and API. */
export const MIN_PROPOSAL_OPS = 1;

/** Maximum length for any single string field value in a proposal. */
const PROPOSAL_FIELD_MAX_LEN = 8000;

/** Key names treated as secret-bearing — values are always redacted. */
const SECRET_FIELD_RE = /secret|token|password|passwd|api[-_ ]?key|auth|credential|private[-_ ]?key|bearer/i;

/**
 * Sanitize proposal field values: strip secret-looking keys, cap string
 * lengths, and redact secret patterns inside remaining strings. Never
 * throws — on unexpected input the value is replaced with a placeholder.
 */
export function sanitizeProposalFields(
  fields: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!fields || typeof fields !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    try {
      if (SECRET_FIELD_RE.test(key)) {
        out[key] = '[REDACTED]';
        continue;
      }
      if (typeof value === 'string') {
        out[key] = redactSecrets(
          value.length > PROPOSAL_FIELD_MAX_LEN ? value.slice(0, PROPOSAL_FIELD_MAX_LEN) : value,
        );
      } else if (Array.isArray(value)) {
        out[key] = value
          .filter((v) => typeof v === 'string')
          .map((v) => (v as string).slice(0, 200))
          .slice(0, 50);
      } else if (typeof value === 'number' || typeof value === 'boolean') {
        out[key] = value;
      }
      // Objects/functions/etc. are dropped — proposals carry flat fields only.
    } catch {
      out[key] = '[REDACTED: sanitization failed]';
    }
  }
  return out;
}

/**
 * Validate proposal operations shared logic. Returns error strings (empty =
 * valid). `isChiefOp` marks whether the op would create/promote a chief —
 * used by the host for the one-chief-per-team rule.
 */
export function validateProposalOps(operations: ChiefProposalOp[]): string[] {
  const errors: string[] = [];
  if (!Array.isArray(operations) || operations.length < MIN_PROPOSAL_OPS) {
    errors.push(`operations: at least ${MIN_PROPOSAL_OPS} operation is required`);
    return errors;
  }
  if (operations.length > MAX_PROPOSAL_OPS) {
    errors.push(`operations: at most ${MAX_PROPOSAL_OPS} operations per proposal`);
    return errors;
  }
  operations.forEach((op, i) => {
    const where = `operations[${i}]`;
    if (!op || typeof op !== 'object') {
      errors.push(`${where}: must be an object`);
      return;
    }
    if (!['create', 'update', 'delete'].includes(op.action)) {
      errors.push(`${where}.action: must be create|update|delete`);
      return;
    }
    if (op.action === 'create') {
      if (typeof op.key !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(op.key)) {
        errors.push(`${where}.key: must be 1-64 chars of letters, digits, _ or -`);
      }
      const fields = op.fields as Record<string, unknown> | undefined;
      if (!fields || typeof fields.name !== 'string' || !fields.name.trim()) {
        errors.push(`${where}.fields.name: required for create`);
      }
    } else {
      if (typeof op.botId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(op.botId)) {
        errors.push(`${where}.botId: must be 1-64 chars of letters, digits, _ or -`);
      }
    }
  });
  return errors;
}
