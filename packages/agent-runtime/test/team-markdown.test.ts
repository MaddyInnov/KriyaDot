// SPDX-License-Identifier: Apache-2.0
// Tests for team-markdown.ts (BotMRR markdown team import):
// - parseTeamMarkdown parses the sample doc (name, members, roster prompt, rules)
// - invalid docs produce issues instead of throwing
// - resolveMarkdownBots resolves bot refs
// - serializeTeamMarkdown round-trips

import { describe, expect, it } from 'vitest';
import {
  parseTeamMarkdown,
  resolveMarkdownBots,
  SAMPLE_TEAM_MARKDOWN,
  serializeTeamMarkdown,
} from '../src/team-markdown.js';

describe('parseTeamMarkdown', () => {
  it('parses the sample document', () => {
    const parsed = parseTeamMarkdown(SAMPLE_TEAM_MARKDOWN);
    expect(parsed.ok).toBe(true);
    expect(parsed.issues).toEqual([]);
    const spec = parsed.spec!;
    expect(spec.name).toBe('Research Squad');
    expect(spec.members).toHaveLength(2);
    expect(spec.members[0]).toMatchObject({ name: 'Scout', role: 'coordinator', botRef: 'scout' });
    expect(spec.members[0].tools).toEqual(['web_search', 'fetch_page']);
    expect(spec.members[0].persona).toContain('research coordinator');
    expect(spec.rosterPrompt).toContain('Delegate subtasks');
    expect(spec.coordinationRules.delegationPolicy).toBe('always-ask');
    expect(spec.coordinationRules.overrides?.['writer']).toBe('always-allow');
  });

  it('never throws on garbage input', () => {
    const parsed = parseTeamMarkdown('just some random text\nno headings at all');
    expect(parsed.ok).toBe(false);
    expect(parsed.issues.length).toBeGreaterThan(0);
  });

  it('flags a doc with no team heading', () => {
    const parsed = parseTeamMarkdown('## Members\n- **Bob** (role: member)\n');
    expect(parsed.ok).toBe(false);
    expect(parsed.issues.some((i) => i.message.includes('Team'))).toBe(true);
  });
});

describe('resolveMarkdownBots', () => {
  const bots = [
    { id: 'scout', name: 'Scout' },
    { id: 'writer', name: 'Writer' },
  ];
  it('matches by id, case-insensitive id, then name', () => {
    const parsed = parseTeamMarkdown(SAMPLE_TEAM_MARKDOWN);
    expect(parsed.ok).toBe(true);
    const res = resolveMarkdownBots(parsed.spec!, bots);
    expect(res[0]).toMatchObject({ botId: 'scout' });
    expect(res[1]).toMatchObject({ botId: 'writer' });
  });
  it('throws with a helpful message for unknown bots', () => {
    const parsed = parseTeamMarkdown(
      '# Team: Ghosts\n\n## Members\n- **Casper** (role: member)\n  - bot: casper\n',
    );
    expect(parsed.ok).toBe(true);
    expect(() => resolveMarkdownBots(parsed.spec!, bots)).toThrow(/Unknown bots.*Casper.*casper/);
  });
});

describe('serializeTeamMarkdown round-trip', () => {
  it('round-trips a parsed spec', () => {
    const parsed = parseTeamMarkdown(SAMPLE_TEAM_MARKDOWN);
    expect(parsed.ok).toBe(true);
    const bots = [
      { id: 'scout', name: 'Scout', persona: 'research coordinator' },
      { id: 'writer', name: 'Writer' },
    ];
    const md = serializeTeamMarkdown(
      {
        name: parsed.spec!.name,
        description: parsed.spec!.description,
        coordinatorBotId: 'scout',
        memberBotIds: ['scout', 'writer'],
        rosterPrompt: parsed.spec!.rosterPrompt,
      },
      bots,
    );
    const again = parseTeamMarkdown(md);
    expect(again.ok).toBe(true);
    expect(again.spec!.name).toBe(parsed.spec!.name);
    expect(again.spec!.members).toHaveLength(parsed.spec!.members.length);
  });
});
