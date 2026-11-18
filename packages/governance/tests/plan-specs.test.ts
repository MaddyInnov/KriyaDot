// SPDX-License-Identifier: Apache-2.0
// Plan-level policy specs (Soteria Verified Plans, Workstream 1 (a)):
// parsing/validation, policy-file loading, merge layering, and
// policy-snapshot hash coverage.

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mergeBotPolicy } from '../src/bot-policy.js';
import { DEFAULT_POLICY } from '../src/default-policy.js';
import { clearWorkspacePolicyCache, loadWorkspacePolicy } from '../src/policy-file.js';
import { createPolicySnapshot, hashPolicy, snapshotMatchesPolicy } from '../src/policy-snapshot.js';
import { matchPlanToolPattern, parsePlanSpec, parsePlanSpecs } from '../src/plan-specs.js';
import type { Policy } from '../src/types.js';

describe('parsePlanSpec', () => {
  it('parses all four spec types', () => {
    const errors: string[] = [];
    expect(parsePlanSpec({ type: 'ordering', id: 'o1', before: '^read_file$', after: '^write_file$', relation: 'must-precede' }, 0, errors))
      .toMatchObject({ type: 'ordering', id: 'o1', relation: 'must-precede' });
    expect(parsePlanSpec({ type: 'requires-history', id: 'r1', toolPattern: '^send_email$', requires: { toolPattern: '^read_file$', arg: 'path', argPattern: 'report' } }, 1, errors))
      .toMatchObject({ type: 'requires-history', id: 'r1' });
    expect(parsePlanSpec({ type: 'provenance', id: 'p1', toolPattern: '^delete_file$', arg: 'path', sourceToolPattern: '^list_folder$' }, 2, errors))
      .toMatchObject({ type: 'provenance', id: 'p1', arg: 'path' });
    expect(parsePlanSpec({ type: 'postcondition', id: 'pc1', toolPattern: '^write_file$', effectClass: 'file-created' }, 3, errors))
      .toMatchObject({ type: 'postcondition', effectClass: 'file-created' });
    expect(errors).toEqual([]);
  });

  it('skips malformed specs with collected errors, never throws', () => {
    const errors: string[] = [];
    expect(parsePlanSpec({ type: 'ordering', id: 'bad', before: '(', after: 'x', relation: 'must-precede' }, 0, errors)).toBeNull();
    expect(parsePlanSpec({ type: 'ordering', id: 'bad2', before: 'a', after: 'b', relation: 'whenever' }, 1, errors)).toBeNull();
    expect(parsePlanSpec({ type: 'provenance', id: 'bad3', toolPattern: 'x', sourceToolPattern: 'y' }, 2, errors)).toBeNull();
    expect(parsePlanSpec({ type: 'nope', id: 'bad4' }, 3, errors)).toBeNull();
    expect(parsePlanSpec('string', 4, errors)).toBeNull();
    expect(errors.length).toBe(5);
  });

  it('parsePlanSpecs tolerates a missing block and rejects a non-array', () => {
    const errors: string[] = [];
    expect(parsePlanSpecs(undefined, errors)).toEqual([]);
    expect(parsePlanSpecs({ nope: true }, errors)).toEqual([]);
    expect(errors.length).toBe(1);
  });

  it('matchPlanToolPattern is case-insensitive and fail-closed on bad regex', () => {
    expect(matchPlanToolPattern('^DELETE_file$', 'delete_file')).toBe(true);
    expect(matchPlanToolPattern('(', 'delete_file')).toBe(false);
  });
});

describe('planSpecs in the policy model', () => {
  const spec = { type: 'ordering' as const, id: 's1', before: '^a$', after: '^b$', relation: 'must-precede' as const };

  it('mergeBotPolicy layers bot planSpecs ahead of global ones', () => {
    const global: Policy = { defaultEffect: 'deny', rules: [], planSpecs: [{ ...spec, id: 'global' }] };
    const merged = mergeBotPolicy(global, { rules: [], planSpecs: [{ ...spec, id: 'bot' }] });
    expect(merged.planSpecs?.map((s) => s.id)).toEqual(['bot', 'global']);
  });

  it('mergeBotPolicy omits planSpecs when neither layer has any', () => {
    const merged = mergeBotPolicy(DEFAULT_POLICY, { rules: [] });
    expect(merged.planSpecs).toBeUndefined();
  });

  it('the policy-snapshot hash covers planSpecs (attestable verification basis)', () => {
    const base: Policy = { defaultEffect: 'require-approval', rules: [] };
    const withSpecs: Policy = { ...base, planSpecs: [spec] };
    expect(hashPolicy(withSpecs)).not.toBe(hashPolicy(base));
    const snap = createPolicySnapshot(withSpecs, { source: 'test' });
    expect(snapshotMatchesPolicy(snap, withSpecs)).toBe(true);
    expect(snapshotMatchesPolicy(snap, base)).toBe(false);
    // Frozen: mutating the source after capture cannot change the snapshot.
    (withSpecs.planSpecs as unknown[]).push({ ...spec, id: 'late' });
    expect(snap.policy.planSpecs?.length).toBe(1);
  });
});

describe('policy.json planSpecs loading', () => {
  it('loads planSpecs + scope from .kriyadot/policy.json, skipping bad entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kriyadot-policy-'));
    mkdirSync(join(dir, '.kriyadot'), { recursive: true });
    writeFileSync(
      join(dir, '.kriyadot', 'policy.json'),
      JSON.stringify({
        rules: [],
        planVerificationScope: 'high-risk-only',
        planSpecs: [
          { type: 'provenance', id: 'del-prov', toolPattern: '^delete_file$', arg: 'path', sourceToolPattern: '^list_folder$' },
          { type: 'ordering', id: 'broken', before: '(', after: 'x', relation: 'must-precede' },
        ],
      }),
    );
    clearWorkspacePolicyCache();
    const loaded = loadWorkspacePolicy(dir);
    expect(loaded.policy.planSpecs?.map((s) => s.id)).toEqual(['del-prov']);
    expect(loaded.policy.planVerificationScope).toBe('high-risk-only');
    expect(loaded.errors.some((e) => e.includes('broken'))).toBe(true);
  });
});
