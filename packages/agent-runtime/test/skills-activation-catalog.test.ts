// SPDX-License-Identifier: Apache-2.0
// #163 declarative frontmatter activation rules + #162 pack resource catalog.

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SkillLoader,
  evaluateActivationRules,
  parseActivationRules,
} from '../src/skills.js';

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'skills-activation-'));
  writeFileSync(
    join(dir, 'deployer.md'),
    [
      '---',
      'name: deployer',
      'description: Deploys things',
      'activation:',
      '  keywords: [deploy, release]',
      '  patterns: ["\\\\bship it\\\\b"]',
      '  exclude: [rollback]',
      '---',
      '',
      'Deploy body.',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(dir, 'plain.md'),
    '---\nname: plain\ndescription: No rules\n---\n\nPlain body.\n',
  );
  mkdirSync(join(dir, 'pack', 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'pack', 'references'), { recursive: true });
  mkdirSync(join(dir, 'pack', 'assets'), { recursive: true });
  writeFileSync(join(dir, 'pack', 'SKILL.md'), '---\nname: pack\ndescription: A pack\n---\n\nPack body.\n');
  writeFileSync(join(dir, 'pack', 'scripts', 'run.mjs'), 'console.log(1);\n');
  writeFileSync(join(dir, 'pack', 'references', 'guide.md'), '# Guide\n');
  writeFileSync(join(dir, 'pack', 'assets', 'card.txt'), 'card\n');
  return dir;
}

describe('parseActivationRules / evaluateActivationRules (#163)', () => {
  it('parses keyword/pattern/exclude lists and drops invalid regexes', () => {
    const rules = parseActivationRules({ keywords: ['Deploy'], patterns: ['ok.*', '[unclosed'], exclude: ['Stop'] });
    expect(rules.keywords).toEqual(['deploy']);
    expect(rules.patterns).toEqual(['ok.*']);
    expect(rules.exclude).toEqual(['stop']);
  });

  it('matches on keyword or pattern, case-insensitively', () => {
    const rules = parseActivationRules({ keywords: ['deploy'], patterns: ['\\bship it\\b'] });
    expect(evaluateActivationRules(rules, 'Please DEPLOY this')).toBe(true);
    expect(evaluateActivationRules(rules, 'ship it now')).toBe(true);
    expect(evaluateActivationRules(rules, 'write some docs')).toBe(false);
  });

  it('an exclude hit vetoes an otherwise-matching message', () => {
    const rules = parseActivationRules({ keywords: ['deploy'], exclude: ['rollback'] });
    expect(evaluateActivationRules(rules, 'deploy then rollback')).toBe(false);
  });

  it('empty rule sets never match', () => {
    expect(evaluateActivationRules(parseActivationRules(undefined), 'deploy')).toBe(false);
    expect(evaluateActivationRules(parseActivationRules({ exclude: ['x'] }), 'deploy')).toBe(false);
  });
});

describe('SkillLoader activation + catalog (#163/#162)', () => {
  it('exposes frontmatter rules and matches them per message', () => {
    const loader = new SkillLoader(makeDir());
    const rules = loader.getActivationRules('deployer');
    expect(rules.keywords).toContain('deploy');
    expect(loader.skillsMatchingMessage('time to deploy the app')).toEqual(['deployer']);
    expect(loader.skillsMatchingMessage('deploy but rollback after')).toEqual([]);
    expect(loader.skillsMatchingMessage('unrelated chatter')).toEqual([]);
    expect(loader.getActivationRules('plain').keywords).toEqual([]);
  });

  it('builds a resource catalog for packs and an empty one for files', () => {
    const loader = new SkillLoader(makeDir());
    const catalog = loader.getResourceCatalog('pack');
    expect(catalog.isPack).toBe(true);
    expect(catalog.totalFiles).toBe(3);
    expect(catalog.scripts.map((e) => e.path)).toEqual(['scripts/run.mjs']);
    expect(catalog.references[0]?.sizeBytes).toBeGreaterThan(0);
    expect(catalog.assets[0]?.name).toBe('card.txt');
    const single = loader.getResourceCatalog('plain');
    expect(single.isPack).toBe(false);
    expect(single.totalFiles).toBe(0);
  });

  it('the shipped driving-kriyadot seed pack is a real multi-file pack', () => {
    const seedDir = join(process.cwd(), '..', '..', 'seed', 'skills');
    const loader = new SkillLoader(seedDir);
    const catalog = loader.getResourceCatalog('driving-kriyadot');
    expect(catalog.isPack).toBe(true);
    expect(catalog.scripts.length).toBeGreaterThanOrEqual(1);
    expect(catalog.references.length).toBeGreaterThanOrEqual(1);
    expect(catalog.assets.length).toBeGreaterThanOrEqual(1);
    // And its frontmatter activation rules are live (#163 in seed).
    expect(loader.skillsMatchingMessage('how do I drive kriyadot from my agent?')).toContain('driving-kriyadot');
  });
});
