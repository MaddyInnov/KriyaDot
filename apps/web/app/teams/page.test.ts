// SPDX-License-Identifier: Apache-2.0
// H11: /api/bots returns a bare array; the teams page must not read `.bots`
// off it (normalizeBots tolerates the envelope shape defensively).
import { describe, expect, it } from 'vitest';
import { normalizeBots } from '../../lib/teams';

const bot = (id: string) => ({ id, name: id, description: `${id} bot` });

describe('normalizeBots (H11)', () => {
  it('passes a bare array through', () => {
    const bots = [bot('a'), bot('b')];
    expect(normalizeBots(bots)).toEqual(bots);
  });

  it('unwraps a { bots: [...] } envelope defensively', () => {
    const bots = [bot('a')];
    expect(normalizeBots({ bots })).toEqual(bots);
  });

  it('returns [] for nullish or malformed payloads', () => {
    expect(normalizeBots(null)).toEqual([]);
    expect(normalizeBots(undefined)).toEqual([]);
    expect(normalizeBots({ bots: null } as unknown as { bots: [] })).toEqual([]);
  });
});
