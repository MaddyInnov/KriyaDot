// SPDX-License-Identifier: Apache-2.0
/**
 * Shipped default slash commands must load even when no seed directory
 * exists on disk — in the single-file binary the module-relative seed
 * paths resolve into the virtual bundle filesystem, so loadSlashCommands
 * falls back to the embedded seed copy (generated/seed.ts). Fail-soft
 * contract: a defective document yields an empty map, never a throw.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSlashCommands, parseSlashCommands } from '../src/slash-commands.js';
import { SEED_FILES } from '../src/generated/seed.js';

describe('slash commands — shipped defaults', () => {
  it('loads the seed defaults (plan/review/work/reduce) with an empty data dir', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'slash-seed-'));
    const cmds = loadSlashCommands(dataDir);
    for (const name of ['plan', 'review', 'work', 'reduce']) {
      expect(cmds[name]?.prompt.length).toBeGreaterThan(0);
    }
  });

  it('the embedded seed copy parses to the same defaults (binary fallback path)', () => {
    const embedded = SEED_FILES['slash-commands.json'];
    expect(typeof embedded).toBe('string');
    const cmds = parseSlashCommands(embedded);
    expect(Object.keys(cmds).sort()).toEqual(['plan', 'reduce', 'review', 'work']);
  });

  it('parseSlashCommands fails soft on defective input', () => {
    expect(parseSlashCommands('not json')).toEqual({});
    expect(parseSlashCommands('{"Bad Name":{"prompt":"x"}}')).toEqual({});
    expect(parseSlashCommands('{"ok":{"prompt":""}}')).toEqual({});
  });
});
