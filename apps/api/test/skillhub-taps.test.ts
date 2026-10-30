// SPDX-License-Identifier: Apache-2.0
// #103 tap distribution refs in SkillHub: github / local / named-channel
// classification + channel resolution.

import { describe, expect, it } from 'vitest';
import { parseSkillHubTapRef, resolveSkillHubTapRef, SkillHubError } from '../src/skillhub.js';

describe('SkillHub tap refs (#103)', () => {
  it('classifies github refs, with and without the prefix and branch', () => {
    expect(parseSkillHubTapRef('github:acme/taps@main')).toMatchObject({ kind: 'github', owner: 'acme', repo: 'taps', branch: 'main' });
    expect(parseSkillHubTapRef('acme/taps')).toMatchObject({ kind: 'github', owner: 'acme', repo: 'taps' });
  });

  it('classifies local, channel and index refs', () => {
    expect(parseSkillHubTapRef('local:/srv/taps')).toMatchObject({ kind: 'local', path: '/srv/taps' });
    expect(parseSkillHubTapRef('channel:team')).toMatchObject({ kind: 'channel', name: 'team' });
    expect(parseSkillHubTapRef('https://example.com/index.json')).toMatchObject({ kind: 'index' });
  });

  it('resolves named channels through the host table, without chains', () => {
    const channels = { team: 'github:acme/team-taps', localteam: 'local:/srv/t' };
    expect(resolveSkillHubTapRef('channel:team', channels)).toMatchObject({ kind: 'github', repo: 'team-taps' });
    expect(resolveSkillHubTapRef('channel:localteam', channels)).toMatchObject({ kind: 'local' });
    expect(() => resolveSkillHubTapRef('channel:missing', channels)).toThrow(SkillHubError);
    expect(() => resolveSkillHubTapRef('channel:loop', { loop: 'channel:loop' })).toThrow(SkillHubError);
  });

  it('rejects malformed refs', () => {
    expect(() => parseSkillHubTapRef('')).toThrow(SkillHubError);
    expect(() => parseSkillHubTapRef('channel:')).toThrow(SkillHubError);
    expect(() => parseSkillHubTapRef('not a ref at all !!')).toThrow(SkillHubError);
  });
});
