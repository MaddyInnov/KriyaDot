// SPDX-License-Identifier: Apache-2.0
// Chief-of-Staff tools. Chief-only: every handler first checks
// `opts.isChief(ctx.botId)` and refuses non-chief callers.
//
//   coordinate_bots    — assign/consult/notify a specialist bot
//   propose_team_setup — propose multi-bot roster changes (user approval)
//   create_bot         — propose a single new specialist (user approval)
//   propose_bot_deletion — propose removing a bot (user approval)
//   raise_escalation   — file a user-only gate in the escalations inbox
//   retry_thread       — retry a failed delegation's stored brief
//
// All governance rules still apply (these are ordinary registry tools).

import type { BotConfig, ToolContext, ToolDefinition } from '../types.js';
import {
  MAX_DELEGATION_RETRIES,
  sanitizeProposalFields,
  validateProposalOps,
  type ChiefIncident,
  type ChiefProposal,
  type ChiefProposalKind,
  type ChiefProposalOp,
} from '../chief.js';

export const CHIEF_TOOL_NAMES = {
  coordinateBots: 'coordinate_bots',
  proposeTeamSetup: 'propose_team_setup',
  createBot: 'create_bot',
  proposeBotDeletion: 'propose_bot_deletion',
  raiseEscalation: 'raise_escalation',
  retryThread: 'retry_thread',
} as const;

export type CoordinateMode = 'assign' | 'consult' | 'notify';

export interface CreateChiefToolsOptions {
  /** True when the calling bot is the Chief of Staff. */
  isChief: (botId: string) => boolean;
  /** Resolve a bot id to its config. */
  getBotConfig: (botId: string) => BotConfig | undefined;
  /**
   * Run one target-bot turn and return its final text. The host wires this
   * to agentRuntime.runTurn with a fresh session (chief_<…>).
   */
  runBotTurn: (bot: BotConfig, message: string) => Promise<{ text: string }>;
  /**
   * Fire-and-forget message delivery. The host may map this onto its
   * message_bot path (own session, confirmation now).
   */
  sendMessage: (bot: BotConfig, message: string) => Promise<{ queued: boolean }>;
  /** Persist a proposal; returns it with id + status filled in. */
  createProposal: (proposal: {
    kind: ChiefProposalKind;
    createdByBotId: string;
    reason: string;
    operations: ChiefProposalOp[];
    suggestion?: boolean;
    newTeams?: string[];
  }) => ChiefProposal;
  /** File an incident in the Team incidents inbox. */
  reportIncident: (incident: {
    chiefBotId: string;
    targetBotId?: string;
    targetBotName?: string;
    threadId?: string;
    summary: string;
    detail?: string;
    attempts: number;
  }) => ChiefIncident;
  /** File an escalation in the Team escalations inbox. */
  reportEscalation: (escalation: {
    chiefBotId: string;
    threadId?: string;
    summary: string;
    detail?: string;
  }) => ChiefIncident;
  /**
   * Retry a failed delegation: re-run the incident's stored brief as a new
   * attempt linked to the original thread id. Returns the updated attempt
   * info, or undefined when the retry budget is spent (then the incident is
   * marked escalated by the host).
   */
  retryDelegation: (
    threadId: string,
  ) => Promise<{ incidentId: string; attempts: number; text?: string; exhausted?: boolean } | undefined>;
  /**
   * True when the planned ops would create a second chief without demoting
   * the current one (one-chief-per-team rule). The host answers from its
   * live roster + chief config.
   */
  wouldCreateSecondChief: (operations: ChiefProposalOp[]) => boolean;
}

const BOT_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function cleanBotId(raw: unknown, field: string): string {
  const id = typeof raw === 'string' ? raw.trim() : '';
  if (!id || !BOT_ID_RE.test(id)) {
    throw new Error(`${field} must be a non-empty bot id ([a-zA-Z0-9_-], max 64 chars)`);
  }
  return id;
}

function cleanText(raw: unknown, field: string, maxLen: number, required = true): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) {
    if (required) throw new Error(`${field} must be a non-empty string`);
    return '';
  }
  return text.length > maxLen ? text.slice(0, maxLen) : text;
}

function requireChief(opts: CreateChiefToolsOptions, ctx: ToolContext): void {
  if (!opts.isChief(ctx.botId)) {
    throw new Error('Only the Chief of Staff bot can use this tool.');
  }
}

function consultPrefix(brief: string): string {
  return `This is a consultation — give advice only, take no actions:\n\n${brief}`;
}

export function createChiefTools(opts: CreateChiefToolsOptions): ToolDefinition[] {
  const coordinateBotsTool: ToolDefinition = {
    name: CHIEF_TOOL_NAMES.coordinateBots,
    mutating: true,
    description: [
      'Coordinate a specialist bot on the team (chief-only).',
      'Pick one mode:',
      '- "assign": the specialist does the work. Its reply comes back to',
      '  you — verify it against the brief before presenting it as done.',
      '  Failures are retried (up to 2 automatic retries); after that an',
      '  incident is filed and you get its id plus a plain-language summary.',
      '- "consult": advice only — the brief is prefixed so the specialist',
      '  knows to take no actions.',
      '- "notify": fire-and-forget message, no reply expected.',
      '',
      'Args:',
      '- target_bot_id (string, required): the specialist\'s id (see roster).',
      '- mode (string, required): assign|consult|notify.',
      '- brief (string, required): self-contained brief with all context —',
      '  recipients do NOT see your transcript.',
      '- rework (boolean): set true when retrying with a revised brief.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        target_bot_id: { type: 'string', description: "Specialist bot id from the team roster." },
        mode: { type: 'string', description: 'assign, consult, or notify.' },
        brief: { type: 'string', description: 'Self-contained brief for the specialist.' },
        rework: { type: 'boolean', description: 'True when this is a revised brief after a failure.' },
      },
      required: ['target_bot_id', 'mode', 'brief'],
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>, ctx: ToolContext) => {
      requireChief(opts, ctx);
      const targetId = cleanBotId(args.target_bot_id, 'target_bot_id');
      const mode = typeof args.mode === 'string' ? args.mode.trim() : '';
      if (!['assign', 'consult', 'notify'].includes(mode)) {
        throw new Error('mode must be one of assign|consult|notify');
      }
      const brief = cleanText(args.brief, 'brief', 8000);
      const target = opts.getBotConfig(targetId);
      if (!target) throw new Error(`coordinate_bots: unknown bot "${targetId}" (see the team roster)`);
      if (targetId === ctx.botId) throw new Error('coordinate_bots: you cannot coordinate yourself');

      if (mode === 'notify') {
        const { queued } = await opts.sendMessage(target, brief);
        return { queued, targetBotId: targetId };
      }

      const message = mode === 'consult' ? consultPrefix(brief) : brief;
      let attempts = 0;
      let lastError = '';
      // Initial attempt + up to MAX_DELEGATION_RETRIES automatic retries.
      for (;;) {
        try {
          const { text } = await opts.runBotTurn(target, message);
          const reply = text.trim().slice(0, 8000);
          if (!reply) throw new Error('the specialist returned an empty reply');
          return { reply, targetBotId: targetId, attempts, mode };
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          attempts += 1;
          if (attempts > MAX_DELEGATION_RETRIES) break;
        }
      }
      const incident = opts.reportIncident({
        chiefBotId: ctx.botId,
        targetBotId: target.id,
        targetBotName: target.name,
        summary: `Delegation to ${target.name} (${target.id}) failed after ${attempts} attempt(s): ${lastError}`.slice(0, 500),
        detail: JSON.stringify({ brief: message, error: lastError }),
        attempts,
      });
      return {
        failed: true,
        incidentId: incident.id,
        targetBotId: targetId,
        attempts,
        summary: `The delegation to ${target.name} failed after ${attempts} attempts (${lastError}). An incident was filed (${incident.id}). Tell the user plainly, or fix the brief and retry via retry_thread.`,
      };
    },
  };

  const proposeTeamSetupTool: ToolDefinition = {
    name: CHIEF_TOOL_NAMES.proposeTeamSetup,
    description: [
      'Propose changes to the team roster (chief-only). Use this for anything',
      'that touches MORE than one bot: restructuring, bulk field updates,',
      'adding a new team, demoting/promoting a chief.',
      'For a single new specialist use create_bot; for a removal use',
      'propose_bot_deletion.',
      'Nothing is applied directly — the proposal goes to the user as pending',
      'and only approved proposals take effect.',
      '',
      'Args:',
      '- reason (string, required): why the team should change, in plain language.',
      '- operations (array, required): 1-24 ops. Each op:',
      '    { action: "create", key: "new-bot-id", fields: { name, description,',
      '      systemPrompt, ... } }',
      '    { action: "update", botId: "existing-id", fields: { description, ... } }',
      '    { action: "delete", botId: "existing-id" }',
      '  Create ops need key + fields.name. Fields are sanitized (secrets redacted).',
      '- new_teams (array of strings): optional team names the proposal establishes.',
      '',
      'One-chief-per-team rule: a plan that would create a second chief',
      'without demoting the current one is rejected.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Why the team should change.' },
        operations: {
          type: 'array',
          description: '1-24 roster operations.',
          items: {
            type: 'object',
            properties: {
              action: { type: 'string', description: 'create|update|delete' },
              key: { type: 'string', description: 'New bot key (create only).' },
              botId: { type: 'string', description: 'Target bot id (update/delete).' },
              fields: { type: 'object', description: 'Field values (create/update).' },
            },
            additionalProperties: false,
          },
        },
        new_teams: {
          type: 'array',
          description: 'Optional team names established by this proposal.',
          items: { type: 'string' },
        },
      },
      required: ['reason', 'operations'],
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>, ctx: ToolContext) => {
      requireChief(opts, ctx);
      const reason = cleanText(args.reason, 'reason', 2000);
      const operations = (Array.isArray(args.operations) ? args.operations : []) as ChiefProposalOp[];
      const errors = validateProposalOps(operations);
      if (errors.length > 0) throw new Error(`Invalid operations: ${errors.join('; ')}`);
      const sanitized = operations.map((op) => ({
        ...op,
        fields: sanitizeProposalFields(op.fields),
      }));
      if (opts.wouldCreateSecondChief(sanitized)) {
        throw new Error(
          'Rejected: this plan would create a second chief without demoting the current one. ' +
            'Add an update op demoting the current chief (chiefOfStaff: false) or drop the new chief.',
        );
      }
      let newTeams: string[] | undefined;
      if (args.new_teams !== undefined) {
        if (!Array.isArray(args.new_teams) || args.new_teams.some((t) => typeof t !== 'string' || !t.trim())) {
          throw new Error('new_teams must be an array of non-empty strings');
        }
        newTeams = (args.new_teams as string[]).map((t) => t.trim().slice(0, 80)).slice(0, 8);
      }
      const proposal = opts.createProposal({
        kind: 'team-setup',
        createdByBotId: ctx.botId,
        reason,
        operations: sanitized,
        ...(newTeams ? { newTeams } : {}),
      });
      return { proposalId: proposal.id, status: proposal.status };
    },
  };

  const createBotTool: ToolDefinition = {
    name: CHIEF_TOOL_NAMES.createBot,
    description: [
      'Propose ONE new specialist bot (chief-only). The bot is NOT created',
      'directly — this always becomes a pending proposal that needs the',
      "user's approval.",
      'With suggestion: true the proposal is recorded as a soft suggestion',
      '(the UI shows it as such); it still needs approval to take effect.',
      'Use propose_team_setup when the change touches more than one bot.',
      '',
      'Args:',
      '- name (string, required): display name of the proposed bot.',
      '- description (string, required): what the bot does (one or two sentences).',
      '- system_prompt (string, required): the specialist\'s system prompt.',
      '- suggestion (boolean): record as a soft suggestion (default false).',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Display name of the proposed bot.' },
        description: { type: 'string', description: 'What the bot does.' },
        system_prompt: { type: 'string', description: "The specialist's system prompt." },
        suggestion: { type: 'boolean', description: 'Record as a soft suggestion.' },
      },
      required: ['name', 'description', 'system_prompt'],
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>, ctx: ToolContext) => {
      requireChief(opts, ctx);
      const name = cleanText(args.name, 'name', 120);
      const description = cleanText(args.description, 'description', 1000);
      const systemPrompt = cleanText(args.system_prompt, 'system_prompt', 8000);
      const suggestion = args.suggestion === true;
      const key = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64);
      if (!key) throw new Error('name must contain at least one letter or digit (used to derive the bot key)');
      const proposal = opts.createProposal({
        kind: 'create-bot',
        createdByBotId: ctx.botId,
        reason: `${suggestion ? 'Suggested' : 'Proposed'} new specialist bot: ${name}`,
        operations: [
          {
            action: 'create',
            key,
            fields: sanitizeProposalFields({ name, description, systemPrompt }),
          },
        ],
        suggestion,
      });
      return { proposalId: proposal.id, status: proposal.status, suggestion };
    },
  };

  const proposeBotDeletionTool: ToolDefinition = {
    name: CHIEF_TOOL_NAMES.proposeBotDeletion,
    description: [
      'Propose removing a bot from the roster (chief-only). The bot is NOT',
      "removed directly — this becomes a pending proposal for the user's",
      'approval. You may never propose deleting yourself.',
      '',
      'Args:',
      '- bot_id (string, required): the bot to remove.',
      '- reason (string, required): why it should be removed.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        bot_id: { type: 'string', description: 'Bot id to remove.' },
        reason: { type: 'string', description: 'Why it should be removed.' },
      },
      required: ['bot_id', 'reason'],
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>, ctx: ToolContext) => {
      requireChief(opts, ctx);
      const botId = cleanBotId(args.bot_id, 'bot_id');
      if (botId === ctx.botId) {
        throw new Error('You cannot propose deleting yourself. Ask the user to remove the chief directly.');
      }
      const target = opts.getBotConfig(botId);
      if (!target) throw new Error(`propose_bot_deletion: unknown bot "${botId}"`);
      const reason = cleanText(args.reason, 'reason', 2000);
      const proposal = opts.createProposal({
        kind: 'delete-bot',
        createdByBotId: ctx.botId,
        reason,
        operations: [{ action: 'delete', botId }],
      });
      return { proposalId: proposal.id, status: proposal.status };
    },
  };

  const raiseEscalationTool: ToolDefinition = {
    name: CHIEF_TOOL_NAMES.raiseEscalation,
    description: [
      'File an escalation (chief-only): a gate only the user can lift',
      '(approval the user must tap, credential, purchase, publishing',
      'decision). It lands in the Team escalations inbox; your job is to',
      'relay it to the user with context and a recommendation — never act',
      "in the user's place and never route around the gate.",
      '',
      'Args:',
      '- summary (string, required): what is blocked and what the user must decide.',
      '- thread_id (string): optional link to the originating delegation thread.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'What is blocked and what the user must decide.' },
        thread_id: { type: 'string', description: 'Optional originating thread id.' },
      },
      required: ['summary'],
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>, ctx: ToolContext) => {
      requireChief(opts, ctx);
      const summary = cleanText(args.summary, 'summary', 2000);
      const threadId =
        args.thread_id === undefined ? undefined : cleanText(args.thread_id, 'thread_id', 128, false) || undefined;
      const escalation = opts.reportEscalation({
        chiefBotId: ctx.botId,
        threadId,
        summary,
      });
      return { escalationId: escalation.id, status: escalation.status };
    },
  };

  const retryThreadTool: ToolDefinition = {
    name: CHIEF_TOOL_NAMES.retryThread,
    mutating: true,
    description: [
      'Retry a failed delegation (chief-only). Re-runs the incident\'s stored',
      'brief as a new attempt linked to the original thread id. Only use',
      'after reading the incident and fixing what was wrong with the brief —',
      `do not retry more than ${MAX_DELEGATION_RETRIES} times total; after that the user decides.`,
      '',
      'Args:',
      '- thread_id (string, required): the thread id from the incident.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        thread_id: { type: 'string', description: 'Thread id from the incident.' },
      },
      required: ['thread_id'],
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>, ctx: ToolContext) => {
      requireChief(opts, ctx);
      const threadId = cleanText(args.thread_id, 'thread_id', 128);
      const result = await opts.retryDelegation(threadId);
      if (!result) throw new Error(`retry_thread: no incident found for thread "${threadId}"`);
      return result;
    },
  };

  return [
    coordinateBotsTool,
    proposeTeamSetupTool,
    createBotTool,
    proposeBotDeletionTool,
    raiseEscalationTool,
    retryThreadTool,
  ];
}

/** Register the chief tools in a registry (delegate-tool pattern). */
export function registerChiefTools(
  registry: Map<string, ToolDefinition>,
  opts: CreateChiefToolsOptions,
): void {
  for (const tool of createChiefTools(opts)) {
    if (!registry.has(tool.name)) {
      registry.set(tool.name, tool);
    }
  }
}
