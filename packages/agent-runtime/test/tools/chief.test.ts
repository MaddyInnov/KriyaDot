// SPDX-License-Identifier: Apache-2.0
// Tests for the chief-only tools (tools/chief.ts): chief gating for all
// six tools, coordinate_bots modes with a mocked runBotTurn,
// retry-then-incident after 3 failures, proposal validation, and field
// sanitization. Zero network.

import { describe, expect, it, vi } from 'vitest';
import {
  CHIEF_TOOL_NAMES,
  createChiefTools,
  registerChiefTools,
} from '../../src/tools/chief.js';
import { makeChiefIncident, makeChiefProposal } from '../../src/chief.js';
import type {
  ChiefIncident,
  ChiefProposal,
  ChiefProposalOp,
} from '../../src/chief.js';
import type { CreateChiefToolsOptions, ToolDefinition } from '../../src/tools/chief.js';
import type { BotConfig, ToolContext } from '../../src/types.js';

const chiefBot = { id: 'chief', name: 'Chief', tools: [] } as unknown as BotConfig;
const coderBot = { id: 'coder', name: 'Coder', tools: [] } as unknown as BotConfig;

const chiefCtx: ToolContext = { sessionId: 's1', botId: 'chief' };
const nonChiefCtx: ToolContext = { sessionId: 's1', botId: 'coder' };

interface Harness {
  tools: Map<string, ToolDefinition>;
  incidents: ChiefIncident[];
  proposals: ChiefProposal[];
  runBotTurn: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  opts: CreateChiefToolsOptions;
}

function makeHarness(overrides: Partial<CreateChiefToolsOptions> = {}): Harness {
  const incidents: ChiefIncident[] = [];
  const proposals: ChiefProposal[] = [];
  const runBotTurn = vi.fn(async (bot: BotConfig, message: string) => ({
    text: `done by ${bot.id}: ${message.slice(0, 20)}`,
  }));
  const sendMessage = vi.fn(async () => ({ queued: true }));
  const opts: CreateChiefToolsOptions = {
    isChief: (id) => id === 'chief',
    getBotConfig: (id) => ({ chief: chiefBot, coder: coderBot } as Record<string, BotConfig>)[id],
    runBotTurn,
    sendMessage,
    createProposal: (p) => {
      const created = makeChiefProposal(p);
      proposals.push(created);
      return created;
    },
    reportIncident: (i) => {
      const created = makeChiefIncident({ ...i, kind: 'incident' });
      incidents.push(created);
      return created;
    },
    reportEscalation: (e) => {
      const created = makeChiefIncident({ ...e, kind: 'escalation' });
      incidents.push(created);
      return created;
    },
    retryDelegation: async () => ({ incidentId: 'cin_retry', attempts: 1 }),
    wouldCreateSecondChief: () => false,
    ...overrides,
  };
  const tools = new Map<string, ToolDefinition>();
  registerChiefTools(tools, opts);
  return { tools, incidents, proposals, runBotTurn, sendMessage, opts };
}

function tool(h: Harness, name: string): ToolDefinition {
  const t = h.tools.get(name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
}

async function call(
  h: Harness,
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext = chiefCtx,
): Promise<unknown> {
  return tool(h, name).handler(args, ctx);
}

describe('chief gating', () => {
  const calls: [string, Record<string, unknown>][] = [
    [CHIEF_TOOL_NAMES.coordinateBots, { target_bot_id: 'coder', mode: 'notify', brief: 'hi' }],
    [CHIEF_TOOL_NAMES.proposeTeamSetup, { reason: 'x', operations: [{ action: 'update', botId: 'coder' }] }],
    [CHIEF_TOOL_NAMES.createBot, { name: 'N', description: 'd', system_prompt: 'p' }],
    [CHIEF_TOOL_NAMES.proposeBotDeletion, { bot_id: 'coder', reason: 'r' }],
    [CHIEF_TOOL_NAMES.raiseEscalation, { summary: 's' }],
    [CHIEF_TOOL_NAMES.retryThread, { thread_id: 't1' }],
  ];

  it('registers all six chief tools', () => {
    const h = makeHarness();
    expect(h.tools.size).toBe(6);
    for (const name of Object.values(CHIEF_TOOL_NAMES)) expect(h.tools.has(name)).toBe(true);
  });

  it.each(calls)('rejects non-chief callers for %s', async (name, args) => {
    const h = makeHarness();
    await expect(call(h, name, args, nonChiefCtx)).rejects.toThrow(
      'Only the Chief of Staff bot can use this tool.',
    );
  });
});

describe('coordinate_bots', () => {
  it('assign runs the target turn and returns its reply', async () => {
    const h = makeHarness();
    const res = (await call(h, CHIEF_TOOL_NAMES.coordinateBots, {
      target_bot_id: 'coder',
      mode: 'assign',
      brief: 'write a function',
    })) as { reply: string; targetBotId: string; attempts: number };
    expect(res.targetBotId).toBe('coder');
    expect(res.reply).toContain('done by coder');
    expect(res.attempts).toBe(0);
    expect(h.runBotTurn).toHaveBeenCalledTimes(1);
  });

  it('consult prefixes the brief as advice-only', async () => {
    const h = makeHarness();
    await call(h, CHIEF_TOOL_NAMES.coordinateBots, {
      target_bot_id: 'coder',
      mode: 'consult',
      brief: 'which design?',
    });
    const sent = h.runBotTurn.mock.calls[0][1] as string;
    expect(sent).toContain('give advice only, take no actions');
    expect(sent).toContain('which design?');
  });

  it('notify is fire-and-forget via sendMessage', async () => {
    const h = makeHarness();
    const res = (await call(h, CHIEF_TOOL_NAMES.coordinateBots, {
      target_bot_id: 'coder',
      mode: 'notify',
      brief: 'heads up',
    })) as { queued: boolean };
    expect(res.queued).toBe(true);
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.runBotTurn).not.toHaveBeenCalled();
  });

  it('retries then files an incident after 3 failures', async () => {
    const h = makeHarness({
      runBotTurn: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    const res = (await call(h, CHIEF_TOOL_NAMES.coordinateBots, {
      target_bot_id: 'coder',
      mode: 'assign',
      brief: 'do it',
    })) as { failed: boolean; incidentId: string; attempts: number; summary: string };
    expect(res.failed).toBe(true);
    expect(res.attempts).toBe(3); // initial + 2 retries
    expect(res.incidentId).toMatch(/^cin_/);
    expect(res.summary).toContain('failed after 3 attempts');
    expect(h.incidents).toHaveLength(1);
    expect(h.incidents[0].summary).toContain('coder');
    expect(h.incidents[0].attempts).toBe(3);
  });

  it('rejects unknown bots, self-coordination and bad modes', async () => {
    const h = makeHarness();
    await expect(
      call(h, CHIEF_TOOL_NAMES.coordinateBots, { target_bot_id: 'ghost', mode: 'assign', brief: 'x' }),
    ).rejects.toThrow('unknown bot');
    await expect(
      call(h, CHIEF_TOOL_NAMES.coordinateBots, { target_bot_id: 'chief', mode: 'assign', brief: 'x' }),
    ).rejects.toThrow('yourself');
    await expect(
      call(h, CHIEF_TOOL_NAMES.coordinateBots, { target_bot_id: 'coder', mode: 'warp', brief: 'x' }),
    ).rejects.toThrow('assign|consult|notify');
  });
});

describe('propose_team_setup', () => {
  it('creates a pending proposal with sanitized fields', async () => {
    const h = makeHarness();
    const res = (await call(h, CHIEF_TOOL_NAMES.proposeTeamSetup, {
      reason: 'add a writer',
      operations: [
        {
          action: 'create',
          key: 'writer',
          fields: { name: 'Writer', apiKey: 'sk-1234567890abcdef' },
        },
      ],
    })) as { proposalId: string; status: string };
    expect(res.status).toBe('pending');
    expect(res.proposalId).toMatch(/^cpr_/);
    const stored = h.proposals[0];
    expect(stored.kind).toBe('team-setup');
    const fields = (stored.operations[0] as ChiefProposalOp).fields!;
    expect(fields.apiKey).toBe('[REDACTED]');
  });

  it('rejects empty operations', async () => {
    const h = makeHarness();
    await expect(
      call(h, CHIEF_TOOL_NAMES.proposeTeamSetup, { reason: 'x', operations: [] }),
    ).rejects.toThrow('at least 1 operation');
    expect(h.proposals).toHaveLength(0);
  });

  it('rejects a plan that would create a second chief', async () => {
    const h = makeHarness({
      wouldCreateSecondChief: () => true,
    });
    await expect(
      call(h, CHIEF_TOOL_NAMES.proposeTeamSetup, {
        reason: 'two chiefs',
        operations: [{ action: 'create', key: 'chief2', fields: { name: 'Chief 2' } }],
      }),
    ).rejects.toThrow('second chief');
    expect(h.proposals).toHaveLength(0);
  });
});

describe('create_bot', () => {
  it('always goes through a pending proposal, never applies directly', async () => {
    const h = makeHarness();
    const res = (await call(h, CHIEF_TOOL_NAMES.createBot, {
      name: 'Writer',
      description: 'writes docs',
      system_prompt: 'you write',
    })) as { proposalId: string; status: string; suggestion: boolean };
    expect(res.status).toBe('pending');
    expect(res.suggestion).toBe(false);
    const stored = h.proposals[0];
    expect(stored.kind).toBe('create-bot');
    expect(stored.operations[0].action).toBe('create');
    expect((stored.operations[0].fields as Record<string, string>).name).toBe('Writer');
  });

  it('records suggestion:true as a suggestion proposal', async () => {
    const h = makeHarness();
    const res = (await call(h, CHIEF_TOOL_NAMES.createBot, {
      name: 'Writer',
      description: 'writes docs',
      system_prompt: 'you write',
      suggestion: true,
    })) as { suggestion: boolean };
    expect(res.suggestion).toBe(true);
    expect(h.proposals[0].suggestion).toBe(true);
  });
});

describe('propose_bot_deletion', () => {
  it('refuses to propose deleting the chief itself', async () => {
    const h = makeHarness();
    await expect(
      call(h, CHIEF_TOOL_NAMES.proposeBotDeletion, { bot_id: 'chief', reason: 'x' }),
    ).rejects.toThrow('yourself');
    expect(h.proposals).toHaveLength(0);
  });

  it('rejects unknown bots', async () => {
    const h = makeHarness();
    await expect(
      call(h, CHIEF_TOOL_NAMES.proposeBotDeletion, { bot_id: 'ghost', reason: 'x' }),
    ).rejects.toThrow('unknown bot');
  });

  it('creates a pending delete-bot proposal', async () => {
    const h = makeHarness();
    const res = (await call(h, CHIEF_TOOL_NAMES.proposeBotDeletion, {
      bot_id: 'coder',
      reason: 'unused',
    })) as { proposalId: string; status: string };
    expect(res.status).toBe('pending');
    expect(h.proposals[0].kind).toBe('delete-bot');
    expect(h.proposals[0].operations[0].botId).toBe('coder');
  });
});

describe('raise_escalation', () => {
  it('files an escalation and returns its id', async () => {
    const h = makeHarness();
    const res = (await call(h, CHIEF_TOOL_NAMES.raiseEscalation, {
      summary: 'need approval to publish',
      thread_id: 't9',
    })) as { escalationId: string; status: string };
    expect(res.escalationId).toMatch(/^cin_/);
    expect(res.status).toBe('open');
    expect(h.incidents[0].kind).toBe('escalation');
    expect(h.incidents[0].threadId).toBe('t9');
  });
});

describe('retry_thread', () => {
  it('returns the new attempt info', async () => {
    const h = makeHarness();
    const res = await call(h, CHIEF_TOOL_NAMES.retryThread, { thread_id: 't1' });
    expect(res).toEqual({ incidentId: 'cin_retry', attempts: 1 });
  });

  it('fails when no incident matches the thread', async () => {
    const h = makeHarness({ retryDelegation: async () => undefined });
    await expect(call(h, CHIEF_TOOL_NAMES.retryThread, { thread_id: 'nope' })).rejects.toThrow(
      'no incident found',
    );
  });
});
