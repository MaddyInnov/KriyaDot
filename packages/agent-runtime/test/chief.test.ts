// SPDX-License-Identifier: Apache-2.0
// Tests for the Chief of Staff prompt layer (chief.ts): roster rendering,
// section injection/replacement between markers, prompt content, escalation
// budget, incident/proposal factories, op validation, field sanitization.
// Zero network.

import { describe, expect, it } from 'vitest';
import {
  buildChiefSection,
  injectChiefSection,
  makeChiefIncident,
  makeChiefProposal,
  renderChiefRoster,
  sanitizeProposalFields,
  shouldEscalate,
  validateProposalOps,
  CHIEF_ROSTER_END,
  CHIEF_ROSTER_START,
  MAX_DELEGATION_RETRIES,
  MAX_PROPOSAL_OPS,
} from '../src/chief.js';
import type { BotConfig } from '../src/types.js';

function bot(id: string, name = id): BotConfig {
  return {
    id,
    name,
    description: `${name} does things`,
    systemPrompt: 'p',
    provider: 'groq',
    model: 'm',
    skills: [],
    tools: ['ask_bot', 'message_bot'],
    mcpServers: [],
  };
}

describe('renderChiefRoster', () => {
  it('renders a markdown list of bots', () => {
    const out = renderChiefRoster([
      { id: 'coder', name: 'Coder', description: 'writes code' },
      { id: 'scout', name: 'Scout', description: 'researches' },
    ]);
    expect(out).toContain('**coder**');
    expect(out).toContain('**scout**');
    expect(out).toContain('writes code');
  });

  it('handles an empty team', () => {
    expect(renderChiefRoster([])).toContain('No other bots');
  });

  it('caps the list at 40 bots', () => {
    const bots = Array.from({ length: 45 }, (_, i) => ({
      id: `b${i}`,
      name: `B${i}`,
      description: 'x',
    }));
    const out = renderChiefRoster(bots);
    expect(out).not.toContain('**b40**');
    expect(out).toContain('5 more');
  });
});

describe('buildChiefSection', () => {
  const chief = bot('chief', 'Chief');
  chief.chiefOfStaff = true;
  chief.managedSections = ['support'];

  it('contains the roster between the fenced markers', () => {
    const section = buildChiefSection(chief, [chief, bot('coder'), bot('scout')]);
    expect(section).toContain(CHIEF_ROSTER_START);
    expect(section).toContain(CHIEF_ROSTER_END);
    const roster = section.slice(
      section.indexOf(CHIEF_ROSTER_START),
      section.indexOf(CHIEF_ROSTER_END),
    );
    expect(roster).toContain('**coder**');
    expect(roster).toContain('**scout**');
    expect(roster).not.toContain('**chief**'); // chief is not in its own roster
  });

  it('covers the delegation doctrine, incidents, escalations and team setup', () => {
    const section = buildChiefSection(chief, [chief, bot('coder')]);
    expect(section).toContain('primary point of contact');
    expect(section).toContain('Delegation doctrine');
    expect(section).toContain('assign');
    expect(section).toContain('consult');
    expect(section).toContain('notify');
    expect(section).toContain('self-contained');
    expect(section).toContain('Never invent');
    expect(section).toContain('Incidents');
    expect(section).toContain('Escalations');
    expect(section).toContain('Team setup');
    expect(section).toContain('propose_team_setup');
    expect(section).toContain('create_bot');
    expect(section).toContain('propose_bot_deletion');
    expect(section).toContain('retry_thread');
  });

  it('renders managed sections in the header', () => {
    const section = buildChiefSection(chief, []);
    expect(section).toContain('support');
  });
});

describe('injectChiefSection', () => {
  const base = 'Base system prompt.';
  const sectionOf = (roster: string) =>
    `# Chief\n${CHIEF_ROSTER_START}\n${roster}\n${CHIEF_ROSTER_END}\n`;

  it('appends the section when no markers are present', () => {
    const out = injectChiefSection(base, sectionOf('roster v1'));
    expect(out).toContain('Base system prompt.');
    expect(out).toContain('roster v1');
  });

  it('replaces only the roster block when markers exist', () => {
    const first = injectChiefSection(base, sectionOf('roster v1'));
    const second = injectChiefSection(first, sectionOf('roster v2'));
    expect(second).toContain('roster v2');
    expect(second).not.toContain('roster v1');
    expect(second).toContain('Base system prompt.');
    // Exactly one pair of markers remains.
    expect(second.split(CHIEF_ROSTER_START)).toHaveLength(2);
    expect(second.split(CHIEF_ROSTER_END)).toHaveLength(2);
  });
});

describe('shouldEscalate', () => {
  it('stays false within the retry budget', () => {
    expect(shouldEscalate(0)).toBe(false);
    expect(shouldEscalate(MAX_DELEGATION_RETRIES)).toBe(false);
  });

  it('turns true once attempts exceed the budget', () => {
    expect(shouldEscalate(MAX_DELEGATION_RETRIES + 1)).toBe(true);
  });
});

describe('makeChiefIncident / makeChiefProposal', () => {
  it('builds an open incident with ids and timestamps', () => {
    const inc = makeChiefIncident({
      kind: 'incident',
      chiefBotId: 'chief',
      summary: 'delegation failed',
      attempts: 3,
    });
    expect(inc.id).toMatch(/^cin_/);
    expect(inc.status).toBe('open');
    expect(inc.attempts).toBe(3);
    expect(inc.createdAt).toBeTruthy();
  });

  it('builds a pending proposal', () => {
    const p = makeChiefProposal({
      kind: 'team-setup',
      createdByBotId: 'chief',
      reason: 'restructure',
      operations: [{ action: 'update', botId: 'coder' }],
    });
    expect(p.id).toMatch(/^cpr_/);
    expect(p.status).toBe('pending');
  });
});

describe('validateProposalOps', () => {
  it('requires at least one operation', () => {
    expect(validateProposalOps([])).not.toHaveLength(0);
    expect(validateProposalOps(undefined as never)).not.toHaveLength(0);
  });

  it('caps operations at 24', () => {
    const ops = Array.from({ length: MAX_PROPOSAL_OPS + 1 }, (_, i) => ({
      action: 'update' as const,
      botId: `b${i}`,
    }));
    expect(validateProposalOps(ops).join(' ')).toContain('at most 24');
  });

  it('rejects create ops without key or name', () => {
    const errs = validateProposalOps([{ action: 'create', fields: {} }]);
    expect(errs.some((e) => e.includes('key'))).toBe(true);
    expect(errs.some((e) => e.includes('name'))).toBe(true);
  });

  it('accepts a well-formed mixed plan', () => {
    expect(
      validateProposalOps([
        { action: 'create', key: 'newbie', fields: { name: 'Newbie' } },
        { action: 'update', botId: 'coder', fields: { description: 'x' } },
        { action: 'delete', botId: 'scout' },
      ]),
    ).toHaveLength(0);
  });

  it('rejects unknown actions and bad ids', () => {
    const errs = validateProposalOps([
      { action: 'explode' as never, botId: 'coder' },
      { action: 'update', botId: 'bad id!' },
    ]);
    expect(errs).toHaveLength(2);
  });
});

describe('sanitizeProposalFields', () => {
  it('redacts secret-looking keys by name', () => {
    const out = sanitizeProposalFields({
      name: 'X',
      apiKey: 'sk-1234567890abcdef',
      password: 'hunter2',
    });
    expect(out.name).toBe('X');
    expect(out.apiKey).toBe('[REDACTED]');
    expect(out.password).toBe('[REDACTED]');
  });

  it('redacts secret patterns inside string values', () => {
    const out = sanitizeProposalFields({
      systemPrompt: 'use key sk-1234567890abcdef for the API',
    });
    expect(out.systemPrompt as string).not.toContain('sk-1234567890abcdef');
  });

  it('caps long strings and drops non-flat values', () => {
    const out = sanitizeProposalFields({
      systemPrompt: 'x'.repeat(9000),
      nested: { a: 1 },
      count: 3,
      flag: true,
    });
    expect((out.systemPrompt as string).length).toBeLessThanOrEqual(8000);
    expect(out).not.toHaveProperty('nested');
    expect(out.count).toBe(3);
    expect(out.flag).toBe(true);
  });

  it('returns an empty object for missing input', () => {
    expect(sanitizeProposalFields(undefined)).toEqual({});
  });
});
