// SPDX-License-Identifier: Apache-2.0
// SkillHub network installs (§2.16 #151) + skill copy policy (§2.16 #154).
// Real UserSkillStore in a temp dir; all network fetch stubbed.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { UserSkillStore } from '@mvp/agent-runtime';
import {
  fetchSkillHubIndex,
  installSkillFromRegistry,
  installSkillPackageFromUrl,
  parseSkillHubIndex,
  sha256Hex,
  SkillHubChecksumError,
  type SkillHubFetch,
} from '../src/skillhub.js';
import {
  buildSkillExportPackage,
  importSkillPackage,
  SkillCopyPolicyStore,
  SkillExportDeniedError,
} from '../src/skill-copy-policy.js';

let store: UserSkillStore;
let policies: SkillCopyPolicyStore;
let dataDir: string;

const PACKAGE = JSON.stringify({
  format: 'kriyadot.skill',
  version: 1,
  name: 'hub-skill',
  description: 'From the hub',
  skillVersion: '1.2.0',
  instructions: 'Do the hub thing.',
  copyPolicy: 'open',
  exportedAt: '2026-01-01T00:00:00.000Z',
});

function fetchReturning(map: Record<string, string>): SkillHubFetch {
  return async (url) => {
    const text = map[url];
    if (text === undefined) return { ok: false, status: 404, text: async () => 'not found' };
    return { ok: true, status: 200, text: async () => text };
  };
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'skillhub-test-'));
  store = new UserSkillStore(dataDir, join(dataDir, 'skills'));
  policies = new SkillCopyPolicyStore(dataDir);
});

describe('parseSkillHubIndex', () => {
  it('parses a valid index', () => {
    const index = parseSkillHubIndex(
      JSON.stringify({
        skills: [
          { id: 'a', name: 'Skill A', description: 'd', downloadUrl: 'https://hub.example/a.json', sha256: 'a'.repeat(64) },
        ],
      }),
    );
    expect(index.skills).toHaveLength(1);
    expect(index.skills[0].sha256).toBe('a'.repeat(64));
  });

  it('rejects malformed indexes and non-http download URLs', () => {
    expect(() => parseSkillHubIndex('{"nope":1}')).toThrow(/skills/);
    expect(() =>
      parseSkillHubIndex(JSON.stringify({ skills: [{ id: 'a', name: 'A', downloadUrl: 'file:///etc/x' }] })),
    ).toThrow(/http\(s\)/);
    expect(() =>
      parseSkillHubIndex(JSON.stringify({ skills: [{ id: 'a', name: 'A', downloadUrl: 'https://x/y', sha256: 'zz' }] })),
    ).toThrow(/sha256/);
  });
});

describe('installSkillFromRegistry', () => {
  const INDEX_URL = 'https://hub.example/index.json';
  const PKG_URL = 'https://hub.example/skills/hub-skill.json';

  function indexWith(sha?: string): string {
    return JSON.stringify({
      skills: [
        { id: 'hub-skill', name: 'Hub Skill', description: 'd', downloadUrl: PKG_URL, ...(sha ? { sha256: sha } : {}) },
      ],
    });
  }

  it('installs DISABLED (pending review) through the user-skill store', async () => {
    const fetchFn = fetchReturning({ [INDEX_URL]: indexWith(sha256Hex(PACKAGE)), [PKG_URL]: PACKAGE });
    const out = await installSkillFromRegistry(
      { store, fetchFn, copyPolicies: policies },
      { registryUrl: INDEX_URL, skillId: 'hub-skill' },
    );
    expect(out.skill.status).toBe('disabled');
    expect(out.skill.source).toBe('imported');
    expect(store.reviewQueue().disabled.map((s) => s.name)).toContain('hub-skill');
    const fetched = await fetchSkillHubIndex(INDEX_URL, fetchFn);
    expect(fetched.skills[0].id).toBe('hub-skill');
  });

  it('rejects on checksum mismatch and installs nothing', async () => {
    const fetchFn = fetchReturning({ [INDEX_URL]: indexWith('b'.repeat(64)), [PKG_URL]: PACKAGE });
    await expect(
      installSkillFromRegistry({ store, fetchFn }, { registryUrl: INDEX_URL, skillId: 'hub-skill' }),
    ).rejects.toThrow(SkillHubChecksumError);
    expect(store.get('hub-skill')).toBeUndefined();
  });

  it('unknown skill id + bad registry URL are clean errors', async () => {
    const fetchFn = fetchReturning({ [INDEX_URL]: indexWith() });
    await expect(
      installSkillFromRegistry({ store, fetchFn }, { registryUrl: INDEX_URL, skillId: 'nope' }),
    ).rejects.toThrow(/no skill with id "nope"/);
    await expect(
      installSkillFromRegistry({ store, fetchFn }, { registryUrl: 'ftp://hub.example/x', skillId: 'a' }),
    ).rejects.toThrow(/http\(s\)/);
    await expect(
      installSkillPackageFromUrl({ store, fetchFn }, { packageUrl: 'not a url' }),
    ).rejects.toThrow(/not a valid URL/);
  });

  it('direct package install with caller-supplied checksum', async () => {
    const fetchFn = fetchReturning({ [PKG_URL]: PACKAGE });
    const out = await installSkillPackageFromUrl(
      { store, fetchFn },
      { packageUrl: PKG_URL, expectedSha256: sha256Hex(PACKAGE) },
    );
    expect(out.skill.status).toBe('disabled');
    expect(out.sha256).toBe(sha256Hex(PACKAGE));
  });
});

describe('copy policy (§2.16 #154)', () => {
  function makeSkill(name: string): void {
    store.createSkill({ name, description: 'd', instructions: `instructions for ${name}`, source: 'manual' });
  }

  it('open (default): export carries policy open, no watermark', () => {
    makeSkill('open-skill');
    const pkg = buildSkillExportPackage(store, policies, 'open-skill');
    expect(pkg.copyPolicy).toBe('open');
    expect(pkg.instructions).not.toContain('copyPolicy: lock');
  });

  it('deny: export is refused', () => {
    makeSkill('deny-skill');
    policies.setPolicy('deny-skill', 'deny');
    expect(() => buildSkillExportPackage(store, policies, 'deny-skill')).toThrow(SkillExportDeniedError);
  });

  it('lock: export carries watermark + policy; re-import is a locked import that cannot re-export', () => {
    makeSkill('lock-skill');
    policies.setPolicy('lock-skill', 'lock');
    const pkg = buildSkillExportPackage(store, policies, 'lock-skill');
    expect(pkg.copyPolicy).toBe('lock');
    expect(pkg.instructions).toContain('copyPolicy: lock');
    expect(pkg.instructions).toContain('instructions for lock-skill');

    const dataDir2 = mkdtempSync(join(tmpdir(), 'skillhub-test2-'));
    const store2 = new UserSkillStore(dataDir2, join(dataDir2, 'skills'));
    const policies2 = new SkillCopyPolicyStore(dataDir2);
    const rec = importSkillPackage(store2, policies2, pkg);
    expect(rec.status).toBe('disabled');
    expect(policies2.isLockedImport('lock-skill')).toBe(true);
    expect(() => buildSkillExportPackage(store2, policies2, 'lock-skill')).toThrow(/locked import/);
    store2.close();
  });

  it('importing an open package records the open policy', () => {
    const rec = importSkillPackage(store, policies, {
      name: 'imported-open',
      description: 'd',
      instructions: 'body',
      copyPolicy: 'open',
    });
    expect(rec.status).toBe('disabled');
    expect(policies.getPolicy('imported-open')).toBe('open');
    expect(policies.isLockedImport('imported-open')).toBe(false);
  });
});
