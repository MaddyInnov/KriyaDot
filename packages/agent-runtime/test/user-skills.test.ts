// SPDX-License-Identifier: Apache-2.0
// Tests for user skill lifecycle (OpenMausBot parity P1 #20): authoring,
// learning proposals, review, disabled-by-default enforcement, scoping,
// and the SkillLoader usability gate.

import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeEach } from 'vitest';
import {
  SkillExistsError,
  SkillNameError,
  SkillNotFoundError,
  SkillNotUsableError,
  SkillStateError,
  UserSkillStore,
  createSkillAuthoringTools,
  parseSkillScope,
  renderSkillFile,
  serializeUserSkill,
  validateSkillName,
} from '../src/user-skills.js';
import { SkillLoader } from '../src/skills.js';
import type { ToolContext } from '../src/types.js';

function makeStore(seedSkills: string[] = []): { store: UserSkillStore; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'userskills-'));
  const dataDir = join(dir, 'data');
  const skillsDir = join(dataDir, 'skills');
  const seedDir = join(dir, 'seed-skills');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(seedDir, { recursive: true });
  for (const name of seedSkills) {
    mkdirSync(join(seedDir, name), { recursive: true });
    writeFileSync(join(seedDir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: seed\n---\nbody\n`);
  }
  const audits: Array<{ action: string; fields: Record<string, unknown> }> = [];
  const store = new UserSkillStore(dataDir, skillsDir, {
    seedSkillsDir: seedDir,
    audit: (action, fields) => audits.push({ action, fields }),
  });
  (store as unknown as { __audits: unknown }).__audits = audits;
  return {
    store,
    dir,
    cleanup: () => {
      store.close();
    },
  };
}

const ctx = { sessionId: 's1', botId: 'bot-a' } as ToolContext;

describe('validateSkillName', () => {
  it('accepts valid names and lowercases', () => {
    expect(validateSkillName('pdf-triage')).toBe('pdf-triage');
    expect(validateSkillName('My-Skill-2')).toBe('my-skill-2');
  });
  it('rejects bad names', () => {
    for (const bad of ['', 'ab', '-lead', 'trail-', 'has space', 'UPPER OK'.toLowerCase() + '_x', 'a'.repeat(65), 42]) {
      expect(() => validateSkillName(bad as string)).toThrow(SkillNameError);
    }
  });
});

describe('parseSkillScope', () => {
  it('defaults to global', () => {
    expect(parseSkillScope(undefined)).toEqual({ type: 'global' });
    expect(parseSkillScope('global')).toEqual({ type: 'global' });
  });
  it('parses bot lists and dedupes', () => {
    expect(parseSkillScope(['a', 'b', 'a'])).toEqual({ type: 'bots', botIds: ['a', 'b'] });
  });
  it('rejects empty lists and garbage', () => {
    expect(() => parseSkillScope([])).toThrow(SkillNameError);
    expect(() => parseSkillScope('everyone')).toThrow(SkillNameError);
  });
});

describe('renderSkillFile', () => {
  it('renders frontmatter + instructions + examples', () => {
    const out = renderSkillFile({ name: 'x', description: 'd', version: '1.0.0', instructions: 'do things', examples: 'ex1' });
    expect(out).toContain('name: x');
    expect(out).toContain('do things');
    expect(out).toContain('## Examples');
  });
});

describe('UserSkillStore.createSkill', () => {
  it('creates DISABLED by default and writes the skill file', () => {
    const { store, dir, cleanup } = makeStore();
    try {
      const rec = store.createSkill({
        name: 'pdf-triage',
        description: 'Triage PDFs',
        instructions: 'Read the PDF and summarize.',
        source: 'agent-created',
        createdByBot: 'bot-a',
      });
      expect(rec.status).toBe('disabled');
      expect(rec.source).toBe('agent-created');
      const file = join(dir, 'data', 'skills', 'pdf-triage', 'SKILL.md');
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file, 'utf8')).toContain('Read the PDF and summarize.');
      // Disabled-by-default: not usable even though the file exists.
      expect(store.isUserSkill('pdf-triage')).toBe(true);
      expect(store.isUsable('pdf-triage', 'bot-a')).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('rejects duplicates and seed collisions', () => {
    const { store, cleanup } = makeStore(['web-research']);
    try {
      store.createSkill({ name: 'dup', description: 'd', instructions: 'i', source: 'manual' });
      expect(() => store.createSkill({ name: 'dup', description: 'd', instructions: 'i', source: 'manual' })).toThrow(
        SkillExistsError,
      );
      expect(() => store.createSkill({ name: 'web-research', description: 'd', instructions: 'i', source: 'manual' })).toThrow(
        SkillExistsError,
      );
    } finally {
      cleanup();
    }
  });

  it('honors bot scoping', () => {
    const { store, cleanup } = makeStore();
    try {
      store.createSkill({
        name: 'scoped',
        description: 'd',
        instructions: 'i',
        scope: { type: 'bots', botIds: ['bot-a'] },
        source: 'manual',
      });
      store.enable('scoped', 'user');
      expect(store.isUsable('scoped', 'bot-a')).toBe(true);
      expect(store.isUsable('scoped', 'bot-b')).toBe(false);
      expect(store.isUsable('scoped')).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('global active skill is usable for any bot', () => {
    const { store, cleanup } = makeStore();
    try {
      store.createSkill({ name: 'glob', description: 'd', instructions: 'i', source: 'manual' });
      store.enable('glob', 'user');
      expect(store.isUsable('glob', 'any-bot')).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe('status transitions', () => {
  it('enable/disable move between disabled and active, with audit', () => {
    const { store, cleanup } = makeStore();
    try {
      store.createSkill({ name: 'tog', description: 'd', instructions: 'i', source: 'manual' });
      expect(() => store.disable('tog', 'user')).toThrow(SkillStateError); // already disabled
      const active = store.enable('tog', 'user');
      expect(active.status).toBe('active');
      expect(active.reviewedBy).toBe('user');
      const disabled = store.disable('tog', 'user');
      expect(disabled.status).toBe('disabled');
      expect(store.isUsable('tog', 'bot-a')).toBe(false);
      const audits = (store as unknown as { __audits: Array<{ action: string }> }).__audits;
      expect(audits.map((a) => a.action)).toContain('skill.enabled');
      expect(audits.map((a) => a.action)).toContain('skill.disabled');
    } finally {
      cleanup();
    }
  });

  it('unknown skill errors', () => {
    const { store, cleanup } = makeStore();
    try {
      expect(() => store.enable('nope', 'user')).toThrow(SkillNotFoundError);
    } finally {
      cleanup();
    }
  });
});

describe('learning proposals', () => {
  it('createProposal stores a draft with no file', () => {
    const { store, dir, cleanup } = makeStore();
    try {
      const rec = store.createProposal({
        name: 'learned-one',
        description: 'd',
        observedPattern: 'the bot did X then Y',
        instructions: 'do X then Y',
        source: 'learned',
        createdByBot: 'bot-a',
      });
      expect(rec.status).toBe('draft');
      expect(rec.draftContent).toContain('do X then Y');
      expect(existsSync(join(dir, 'data', 'skills', 'learned-one'))).toBe(false);
      expect(store.isUsable('learned-one', 'bot-a')).toBe(false);
      expect(store.reviewQueue().proposals.map((p) => p.name)).toContain('learned-one');
    } finally {
      cleanup();
    }
  });

  it('materializeProposal writes the file as disabled', () => {
    const { store, dir, cleanup } = makeStore();
    try {
      store.createProposal({ name: 'lprop', description: 'd', instructions: 'i', source: 'learned' });
      const rec = store.materializeProposal('lprop', 'user');
      expect(rec.status).toBe('disabled');
      expect(existsSync(join(dir, 'data', 'skills', 'lprop', 'SKILL.md'))).toBe(true);
      expect(store.isUsable('lprop', 'bot-a')).toBe(false); // still disabled: needs enable
      expect(() => store.materializeProposal('lprop', 'user')).toThrow(SkillStateError);
    } finally {
      cleanup();
    }
  });

  it('rejectProposal is terminal', () => {
    const { store, cleanup } = makeStore();
    try {
      store.createProposal({ name: 'lproptwo', description: 'd', instructions: 'i', source: 'learned' });
      const rec = store.rejectProposal('lproptwo', 'user');
      expect(rec.status).toBe('rejected');
      expect(store.isUsable('lproptwo', 'bot-a')).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('reconcileDrafts follows the approval card', () => {
    const { store, dir, cleanup } = makeStore();
    try {
      store.createProposal({ name: 'appr-one', description: 'd', instructions: 'i', source: 'learned' });
      store.createProposal({ name: 'appr-two', description: 'd', instructions: 'i', source: 'learned' });
      store.createProposal({ name: 'appr-three', description: 'd', instructions: 'i', source: 'learned' });
      store.attachApproval('appr-one', 'appr-1');
      store.attachApproval('appr-two', 'appr-2');
      store.attachApproval('appr-three', 'appr-3');
      const statuses: Record<string, 'pending' | 'approved' | 'denied' | 'expired'> = {
        'appr-1': 'approved',
        'appr-2': 'denied',
        'appr-3': 'pending',
      };
      const out = store.reconcileDrafts((id) => statuses[id]);
      expect(out.materialized).toEqual(['appr-one']);
      expect(out.rejected).toEqual(['appr-two']);
      expect(store.get('appr-one')!.status).toBe('disabled');
      expect(store.get('appr-two')!.status).toBe('rejected');
      expect(store.get('appr-three')!.status).toBe('draft');
      expect(existsSync(join(dir, 'data', 'skills', 'appr-one', 'SKILL.md'))).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe('updateSkill / deleteSkill', () => {
  it('updates description and rewrites the file', () => {
    const { store, dir, cleanup } = makeStore();
    try {
      store.createSkill({ name: 'upd', description: 'old', instructions: 'body', source: 'manual' });
      const rec = store.updateSkill('upd', { description: 'new', instructions: 'body2' });
      expect(rec.description).toBe('new');
      const file = readFileSync(join(dir, 'data', 'skills', 'upd', 'SKILL.md'), 'utf8');
      expect(file).toContain('body2');
      expect(file).toContain('description: new');
    } finally {
      cleanup();
    }
  });

  it('deleteSkill removes file + record; active skills must be disabled first', () => {
    const { store, dir, cleanup } = makeStore();
    try {
      store.createSkill({ name: 'del', description: 'd', instructions: 'i', source: 'manual' });
      store.enable('del', 'user');
      expect(() => store.deleteSkill('del', 'user')).toThrow(SkillStateError);
      store.disable('del', 'user');
      store.deleteSkill('del', 'user');
      expect(store.get('del')).toBeUndefined();
      expect(existsSync(join(dir, 'data', 'skills', 'del'))).toBe(false);
      expect(() => store.deleteSkill('del', 'user')).toThrow(SkillNotFoundError);
    } finally {
      cleanup();
    }
  });
});

describe('createSkillAuthoringTools', () => {
  it('create_skill saves disabled', async () => {
    const { store, cleanup } = makeStore();
    try {
      const [createSkill] = createSkillAuthoringTools({ store });
      const out = (await createSkill.handler(
        { name: 'tool-made', description: 'd', instructions: 'i' },
        ctx,
      )) as { ok: boolean; status: string };
      expect(out.ok).toBe(true);
      expect(out.status).toBe('disabled');
      expect(store.isUsable('tool-made', 'bot-a')).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('learn_skill creates a draft and raises an approval card', async () => {
    const { store, cleanup } = makeStore();
    try {
      const requested: Array<{ tool: string; args: Record<string, unknown> }> = [];
      const [, learnSkill] = createSkillAuthoringTools({
        store,
        approval: {
          requestApproval: (tool, args, _c) => {
            requested.push({ tool, args });
            return 'appr-123';
          },
        },
      });
      const out = (await learnSkill.handler(
        { name: 'learned-tool', description: 'd', observedPattern: 'p', instructions: 'i' },
        ctx,
      )) as { ok: boolean; status: string; approvalId?: string };
      expect(out.ok).toBe(true);
      expect(out.status).toBe('draft');
      expect(out.approvalId).toBe('appr-123');
      expect(requested).toHaveLength(1);
      expect(requested[0].tool).toBe('learn_skill');
      expect(store.get('learned-tool')!.approvalId).toBe('appr-123');
    } finally {
      cleanup();
    }
  });

  it('learn_skill without a broker still keeps the draft reviewable', async () => {
    const { store, cleanup } = makeStore();
    try {
      const [, learnSkill] = createSkillAuthoringTools({ store });
      const out = (await learnSkill.handler(
        { name: 'no-broker', description: 'd', observedPattern: 'p', instructions: 'i' },
        ctx,
      )) as { status: string; approvalId?: string };
      expect(out.status).toBe('draft');
      expect(out.approvalId).toBeUndefined();
      expect(store.get('no-broker')!.status).toBe('draft');
    } finally {
      cleanup();
    }
  });

  it('both tools are marked mutating', () => {
    const { store, cleanup } = makeStore();
    try {
      const tools = createSkillAuthoringTools({ store });
      expect(tools.map((t) => t.name).sort()).toEqual(['create_skill', 'learn_skill']);
      for (const t of tools) expect(t.mutating).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe('SkillLoader usability gate', () => {
  it('gates getSummary and loadFull for disabled user skills', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-'));
    const dataDir = join(dir, 'data');
    const skillsDir = join(dataDir, 'skills');
    mkdirSync(dataDir, { recursive: true });
    const store = new UserSkillStore(dataDir, skillsDir, {});
    const gate = (name: string, botId?: string): boolean =>
      store.isUserSkill(name) ? store.isUsable(name, botId) : true;
    try {
      store.createSkill({ name: 'gated', description: 'd', instructions: 'i', source: 'manual' });
      const loader = new SkillLoader(join(dir, 'seed'), { additionalDirs: [skillsDir], usabilityGate: gate });
      await expect(loader.getSummary('gated', 'bot-a')).rejects.toThrow(SkillNotUsableError);
      await expect(loader.loadFull('gated', 'bot-a')).rejects.toThrow(SkillNotUsableError);
      // After enable, loads work.
      store.enable('gated', 'user');
      const summary = await loader.getSummary('gated', 'bot-a');
      expect(summary.name).toBe('gated');
      const full = await loader.loadFull('gated', 'bot-a');
      expect(full.content).toContain('i');
      loader.close();
    } finally {
      store.close();
    }
  });

  it('does not gate unknown (seed/imported) skills', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate2-'));
    const dataDir = join(dir, 'data');
    const skillsDir = join(dataDir, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    const store = new UserSkillStore(dataDir, skillsDir, {});
    const gate = (name: string, botId?: string): boolean =>
      store.isUserSkill(name) ? store.isUsable(name, botId) : true;
    try {
      // An imported skill (file on disk, no DB record) stays usable.
      mkdirSync(join(skillsDir, 'imported-one'), { recursive: true });
      writeFileSync(join(skillsDir, 'imported-one', 'SKILL.md'), '---\nname: imported-one\ndescription: imp\n---\nbody');
      const loader = new SkillLoader(join(dir, 'seed'), { additionalDirs: [skillsDir], usabilityGate: gate });
      const summary = await loader.getSummary('imported-one', 'bot-a');
      expect(summary.name).toBe('imported-one');
      loader.close();
    } finally {
      store.close();
    }
  });
});

describe('serializeUserSkill', () => {
  it('omits draft content by default', () => {
    const { store, cleanup } = makeStore();
    try {
      const rec = store.createProposal({ name: 'ser', description: 'd', instructions: 'i', source: 'learned' });
      const slim = serializeUserSkill(rec);
      expect(slim).not.toHaveProperty('draftContent');
      const full = serializeUserSkill(rec, { includeDraft: true });
      expect(full).toHaveProperty('draftContent');
    } finally {
      cleanup();
    }
  });
});

describe('beforeEach isolation', () => {
  // Guards against accidental cross-test DB reuse: every makeStore uses a
  // fresh temp dir, so this just asserts the helper contract.
  let seen = new Set<string>();
  beforeEach(() => {
    seen = new Set<string>();
  });
  it('temp dirs are unique', () => {
    const a = makeStore();
    const b = makeStore();
    expect(a.dir).not.toBe(b.dir);
    seen.add(a.dir);
    a.cleanup();
    b.cleanup();
  });
});
