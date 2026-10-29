// SPDX-License-Identifier: Apache-2.0
// Guardrails as code (Octomind parity): argument matching, session-
// history conditions, and the repo-local policy file.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GovernanceGateway,
  clearWorkspacePolicyCache,
  loadWorkspacePolicy,
  mergeBotPolicy,
  type EvalContext,
  type Policy,
} from '../src/index.js';

const CTX: EvalContext = { sessionId: 's1', botId: 'b1', actor: 'tester' };

const gateways: GovernanceGateway[] = [];
function fresh(policy: Policy): GovernanceGateway {
  const gw = new GovernanceGateway({ dbPath: ':memory:', policy });
  gateways.push(gw);
  return gw;
}

afterEach(() => {
  while (gateways.length > 0) gateways.pop()?.close();
  clearWorkspacePolicyCache();
});

const basePolicy = (rules: Policy['rules']): Policy => ({ defaultEffect: 'allow', rules });

describe('argPattern matching', () => {
  const policy = basePolicy([
    {
      id: 'gate-prod-deploy',
      toolPattern: '^deploy$',
      argPattern: { arg: 'env', pattern: '^prod' },
      effect: 'require-approval',
      reason: 'prod deploys need a human',
    },
  ]);

  it('fires only when the argument value matches', async () => {
    const gw = fresh(policy);
    const prod = await gw.simulate('deploy', { env: 'prod-eu' }, policy);
    expect(prod.effect).toBe('require-approval');
    expect(prod.matchedRuleId).toBe('gate-prod-deploy');
    const staging = await gw.simulate('deploy', { env: 'staging' }, policy);
    expect(staging.effect).toBe('allow');
    expect(staging.matchedRuleId).toBeUndefined();
  });

  it('does not fire when the argument is missing or non-string values do not match', async () => {
    const gw = fresh(policy);
    expect((await gw.simulate('deploy', {}, policy)).effect).toBe('allow');
    expect((await gw.simulate('deploy', { env: 42 }, policy)).effect).toBe('allow');
  });

  it('matches non-string args via JSON', async () => {
    const p2 = basePolicy([
      {
        id: 'big-limit',
        toolPattern: '^transfer$',
        argPattern: { arg: 'amount', pattern: '"cents":\\s*[5-9][0-9]{4}' },
        effect: 'deny',
      },
    ]);
    const gw = fresh(p2);
    // amount is a scalar here — JSON of a number; use an object arg instead.
    const p3 = basePolicy([
      {
        id: 'big-limit',
        toolPattern: '^transfer$',
        argPattern: { arg: 'meta', pattern: '"tier":\\s*"gold"' },
        effect: 'deny',
      },
    ]);
    const gw2 = fresh(p3);
    expect((await gw2.simulate('transfer', { meta: { tier: 'gold' } }, p3)).effect).toBe('deny');
    expect((await gw2.simulate('transfer', { meta: { tier: 'free' } }, p3)).effect).toBe('allow');
    void gw;
    void p2;
  });

  it('an invalid argPattern regex never matches (fail-closed)', async () => {
    const p = basePolicy([
      { id: 'broken', toolPattern: '^deploy$', argPattern: { arg: 'env', pattern: '([' }, effect: 'deny' },
    ]);
    const gw = fresh(p);
    expect((await gw.simulate('deploy', { env: 'prod' }, p)).effect).toBe('allow');
  });
});

describe('requiresHistory matching', () => {
  const policy = basePolicy([
    {
      id: 'publish-needs-review',
      toolPattern: '^publish$',
      effect: 'deny',
      reason: 'must not match without history',
    },
    {
      id: 'publish-after-review',
      toolPattern: '^publish$',
      requiresHistory: { toolPattern: '^review' },
      effect: 'allow',
    },
  ]);
  // Order matters: put the history rule FIRST so it wins when satisfied.
  const ordered = basePolicy([policy.rules[1]!, policy.rules[0]!]);

  it('matches only after the required tool ran', async () => {
    const gw = fresh(ordered);
    const before = await gw.simulate('publish', {}, ordered, []);
    expect(before.effect).toBe('deny');
    const after = await gw.simulate('publish', {}, ordered, ['read_file', 'review_changes']);
    expect(after.effect).toBe('allow');
    expect(after.matchedRuleId).toBe('publish-after-review');
  });

  it('never matches without a history (simulation default)', async () => {
    const gw = fresh(ordered);
    expect((await gw.simulate('publish', {}, ordered)).effect).toBe('deny');
  });

  it('honors minCount', async () => {
    const p = basePolicy([
      {
        id: 'deploy-after-two-checks',
        toolPattern: '^deploy$',
        requiresHistory: { toolPattern: '^check', minCount: 2 },
        effect: 'allow',
      },
      { id: 'deploy-default', toolPattern: '^deploy$', effect: 'require-approval' },
    ]);
    const gw = fresh(p);
    expect((await gw.simulate('deploy', {}, p, ['check_lint'])).effect).toBe('require-approval');
    expect((await gw.simulate('deploy', {}, p, ['check_lint', 'check_types'])).effect).toBe('allow');
  });

  it('applies in live evaluation via EvalContext.sessionToolHistory', async () => {
    const gw = fresh(ordered);
    const denied = await gw.evaluate('publish', {}, CTX);
    expect(denied.effect).toBe('deny');
    const allowed = await gw.evaluate('publish', {}, { ...CTX, sessionToolHistory: ['review_changes'] });
    expect(allowed.effect).toBe('allow');
  });
});

describe('loadWorkspacePolicy', () => {
  it('loads valid rules and skips invalid ones with errors', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mvp-policy-'));
    try {
      mkdirSync(join(dir, '.kriyadot'));
      writeFileSync(
        join(dir, '.kriyadot', 'policy.json'),
        JSON.stringify({
          rules: [
            {
              id: 'no-prod',
              toolPattern: '^deploy$',
              argPattern: { arg: 'env', pattern: '^prod' },
              effect: 'require-approval',
            },
            { id: 'bad-effect', toolPattern: '^x$', effect: 'maybe' },
            { toolPattern: '([', effect: 'deny' },
            'not-an-object',
          ],
        }),
      );
      const { policy, errors, path } = loadWorkspacePolicy(dir);
      expect(path).toContain('policy.json');
      expect(policy.rules).toHaveLength(1);
      expect(policy.rules[0]).toMatchObject({
        id: 'no-prod',
        argPattern: { arg: 'env', pattern: '^prod' },
      });
      expect(errors.length).toBeGreaterThanOrEqual(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns an empty policy when the file does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mvp-policy-'));
    try {
      const { policy, errors } = loadWorkspacePolicy(dir);
      expect(policy.rules).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports invalid JSON without throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mvp-policy-'));
    try {
      mkdirSync(join(dir, '.kriyadot'));
      writeFileSync(join(dir, '.kriyadot', 'policy.json'), '{oops');
      const { policy, errors } = loadWorkspacePolicy(dir);
      expect(policy.rules).toEqual([]);
      expect(errors[0]).toContain('unreadable');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('workspace rules merge ahead of bot rules (most specific wins)', async () => {
    const global: Policy = { defaultEffect: 'allow', rules: [] };
    const botMerged = mergeBotPolicy(global, {
      rules: [{ id: 'bot-rule', toolPattern: '^deploy$', effect: 'allow' }],
    });
    const wsMerged = mergeBotPolicy(botMerged, {
      rules: [{ id: 'ws-rule', toolPattern: '^deploy$', effect: 'deny' }],
    });
    const gw = fresh(wsMerged);
    const sim = await gw.simulate('deploy', {}, wsMerged);
    expect(sim.effect).toBe('deny');
    expect(sim.matchedRuleId).toBe('ws-rule');
  });
});
