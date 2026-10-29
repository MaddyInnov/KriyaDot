// SPDX-License-Identifier: Apache-2.0
// W12a "Set me up": proposal generation with a mock provider — structured
// output parsing, invalid tool/server names filtered out, caps, unique
// ids, routine suggestions. Zero paid API usage (MockProvider only).

import { describe, expect, it } from 'vitest';
import {
  extractJsonObject,
  generateBotSetupProposal,
  sanitizeBotSetupProposal,
  slugifyBotId,
} from '../src/bot-setup.js';
import { MockProvider } from '../src/providers/mock.js';

const TOOLS = ['web_search', 'web_fetch', 'notes_read', 'gmail_read', 'ask_user_question'];
const MCP = ['gmail', 'calendar'];
const SKILLS = ['web-research', 'inbox-zero'];

function deps(provider: MockProvider) {
  return {
    provider,
    model: 'mock-model',
    availableTools: TOOLS,
    availableMcpServers: MCP,
    availableSkills: SKILLS,
    defaultProvider: 'groq',
    defaultModel: 'gpt-oss-20b',
    existingBotIds: ['scout', 'coder'],
  };
}

const GOOD_JSON = JSON.stringify({
  name: 'Inbox Pilot',
  description: 'Watches Gmail and drafts replies.',
  systemPrompt: 'You are Inbox Pilot. Every morning, read new Gmail and draft polite replies.',
  tools: ['gmail_read', 'web_search', 'teleport', 'ask_user_question'],
  skills: ['inbox-zero', 'made-up-skill'],
  mcpServers: ['gmail', 'not-a-server'],
  routines: [
    {
      name: 'Morning inbox draft',
      promptTemplate: 'Read overnight Gmail and draft replies for review.',
      schedule: { kind: 'daily', timezone: 'Asia/Kolkata', enabled: true, overlap: 'skip', time: '08:00', weekdays: [1, 2, 3, 4, 5] },
    },
    { name: '', promptTemplate: 'missing name — dropped' },
    { name: 'No prompt', promptTemplate: '' },
  ],
});

describe('generateBotSetupProposal', () => {
  it('parses structured output and filters invalid tool/server/skill names', async () => {
    const provider = new MockProvider([{ content: GOOD_JSON }]);
    const proposal = await generateBotSetupProposal(
      'I need a bot that watches my Gmail and drafts replies every morning',
      deps(provider),
    );
    expect(proposal.name).toBe('Inbox Pilot');
    expect(proposal.id).toBe('inbox-pilot');
    expect(proposal.tools).toEqual(['gmail_read', 'web_search', 'ask_user_question']);
    expect(proposal.droppedTools).toEqual(['teleport']);
    expect(proposal.mcpServers).toEqual(['gmail']);
    expect(proposal.droppedMcpServers).toEqual(['not-a-server']);
    expect(proposal.skills).toEqual(['inbox-zero']);
    expect(proposal.provider).toBe('groq');
    expect(proposal.model).toBe('gpt-oss-20b');
    expect(proposal.routines).toHaveLength(1);
    expect(proposal.routines[0]!.name).toBe('Morning inbox draft');
    expect(proposal.routines[0]!.schedule?.kind).toBe('daily');
    // The setup turn saw the catalogs (grounding for "only real tools").
    expect(provider.calls).toHaveLength(1);
    const userMsg = provider.calls[0]!.messages.find((m) => m.role === 'user');
    expect(userMsg?.content).toContain('gmail_read');
    expect(userMsg?.content).toContain('watches my Gmail');
  });

  it('tolerates fenced JSON and surrounding prose', async () => {
    const provider = new MockProvider([
      { content: `Here is your bot:\n\`\`\`json\n${GOOD_JSON}\n\`\`\`\nHope that helps!` },
    ]);
    const proposal = await generateBotSetupProposal('gmail bot please', deps(provider));
    expect(proposal.name).toBe('Inbox Pilot');
  });

  it('rejects an empty sentence and non-JSON model output', async () => {
    const provider = new MockProvider([{ content: 'no json here' }]);
    await expect(generateBotSetupProposal('   ', deps(provider))).rejects.toThrow(/sentence is required/);
    await expect(generateBotSetupProposal('a bot', deps(provider))).rejects.toThrow(/did not return a JSON object/);
  });

  it('makes the id unique against the existing roster', async () => {
    const provider = new MockProvider([
      { content: JSON.stringify({ name: 'Scout', systemPrompt: 'x', tools: ['web_search'] }) },
    ]);
    const proposal = await generateBotSetupProposal('another scout', deps(provider));
    expect(proposal.id).toBe('scout-2');
  });

  it('falls back to safe registry tools when the model picks none that exist', () => {
    const p = sanitizeBotSetupProposal(
      { name: 'Empty', tools: ['nope'] },
      {
        availableTools: TOOLS,
        availableMcpServers: MCP,
        availableSkills: SKILLS,
        defaultProvider: 'groq',
        defaultModel: 'm',
        existingBotIds: [],
      },
      'sentence',
    );
    expect(p.tools).toEqual(['web_search', 'web_fetch', 'notes_read']);
    expect(p.droppedTools).toEqual(['nope']);
  });

  it('drops routines with non-time-based schedule kinds', () => {
    const p = sanitizeBotSetupProposal(
      {
        name: 'Sched',
        routines: [
          { name: 'R1', promptTemplate: 'go', schedule: { kind: 'event', app: 'gmail' } },
          { name: 'R2', promptTemplate: 'go', schedule: { kind: 'cron', expression: '0 9 * * *' } },
        ],
      },
      {
        availableTools: TOOLS,
        availableMcpServers: MCP,
        availableSkills: SKILLS,
        defaultProvider: 'groq',
        defaultModel: 'm',
        existingBotIds: [],
      },
      'sentence',
    );
    expect(p.routines[0]!.schedule).toBeUndefined();
    expect(p.routines[1]!.schedule?.kind).toBe('cron');
  });
});

describe('extractJsonObject / slugifyBotId', () => {
  it('extracts a bare object', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });
  it('slugifies names', () => {
    expect(slugifyBotId('My Cool Bot!')).toBe('my-cool-bot');
    expect(slugifyBotId('!!!')).toBe('new-bot');
  });
});
