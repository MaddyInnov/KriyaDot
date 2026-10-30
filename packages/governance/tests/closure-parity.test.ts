// SPDX-License-Identifier: Apache-2.0
// Octomind closure rows: #66 argument-qualified history, #70 opt-in
// policy snapshots, #122 domain-bound capabilities, #126 local: rule.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_POLICY,
  GovernanceGateway,
  clearWorkspacePolicyCache,
  computeArgDigest,
  countMatchingHistory,
  createPolicySnapshot,
  extractTargetHost,
  hashPolicy,
  historyEntryMatches,
  hostMatchesDomains,
  loadWorkspacePolicy,
  makeHistoryEntry,
  mergeBotPolicy,
  resolveSessionPolicy,
  snapshotMatchesPolicy,
  summarizeArgs,
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

describe('#66 argument-qualified history conditions', () => {
  it('computeArgDigest is key-order independent and arg-sensitive', () => {
    expect(computeArgDigest({ a: 1, b: { c: 2, d: 3 } })).toBe(
      computeArgDigest({ b: { d: 3, c: 2 }, a: 1 }),
    );
    expect(computeArgDigest({ command: 'git status' })).not.toBe(
      computeArgDigest({ command: 'git push' }),
    );
    expect(computeArgDigest({ command: 'git status' })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('summarizeArgs produces a matchable summary', () => {
    expect(summarizeArgs({ command: 'git status' })).toBe('command=git status');
    expect(makeHistoryEntry('shell', { command: 'git status' }).argSummary).toContain('git status');
  });

  const policy = basePolicy([
    {
      id: 'push-after-git-status',
      toolPattern: '^git_push$',
      requiresHistory: { toolPattern: '^shell$', argPattern: 'command=git\\s+status' },
      effect: 'allow',
    },
    { id: 'push-default', toolPattern: '^git_push$', effect: 'deny' },
  ]);

  it('matches when shell ran with the qualifying arguments', async () => {
    const gw = fresh(policy);
    const history = [makeHistoryEntry('shell', { command: 'git status' })];
    const sim = await gw.simulate('git_push', {}, policy, history);
    expect(sim.effect).toBe('allow');
    expect(sim.matchedRuleId).toBe('push-after-git-status');
  });

  it('does not match when shell ran with different arguments', async () => {
    const gw = fresh(policy);
    const history = [makeHistoryEntry('shell', { command: 'git push --force' })];
    expect((await gw.simulate('git_push', {}, policy, history)).effect).toBe('deny');
  });

  it('legacy name-only entries never satisfy an argument-qualified condition (fail-closed)', async () => {
    const gw = fresh(policy);
    expect((await gw.simulate('git_push', {}, policy, ['shell'])).effect).toBe('deny');
    expect(historyEntryMatches('shell', { toolPattern: '^shell$', argPattern: 'git' })).toBe(false);
    // …but still satisfy a name-only condition, as before.
    expect(historyEntryMatches('shell', { toolPattern: '^shell$' })).toBe(true);
    expect(countMatchingHistory(['shell', 'shell'], { toolPattern: '^shell$', minCount: 2 })).toBe(2);
  });

  it('matches an exact argDigest condition', async () => {
    const digest = computeArgDigest({ command: 'git status' });
    const p = basePolicy([
      {
        id: 'exact',
        toolPattern: '^git_push$',
        requiresHistory: { toolPattern: '^shell$', argDigest: digest },
        effect: 'allow',
      },
      { id: 'fallback', toolPattern: '^git_push$', effect: 'deny' },
    ]);
    const gw = fresh(p);
    expect(
      (await gw.simulate('git_push', {}, p, [makeHistoryEntry('shell', { command: 'git status' })])).effect,
    ).toBe('allow');
    expect(
      (await gw.simulate('git_push', {}, p, [makeHistoryEntry('shell', { command: 'ls' })])).effect,
    ).toBe('deny');
    // A rich entry without a digest does not satisfy a digest condition.
    expect(
      (await gw.simulate('git_push', {}, p, [{ name: 'shell', argSummary: 'command=git status' }])).effect,
    ).toBe('deny');
  });

  it('honors minCount with argument qualification', async () => {
    const p = basePolicy([
      {
        id: 'two-status',
        toolPattern: '^deploy$',
        requiresHistory: { toolPattern: '^shell$', argPattern: 'git status', minCount: 2 },
        effect: 'allow',
      },
      { id: 'fallback', toolPattern: '^deploy$', effect: 'require-approval' },
    ]);
    const gw = fresh(p);
    const one = [makeHistoryEntry('shell', { command: 'git status' })];
    const two = [...one, makeHistoryEntry('shell', { command: 'git status --short' })];
    expect((await gw.simulate('deploy', {}, p, one)).effect).toBe('require-approval');
    expect((await gw.simulate('deploy', {}, p, two)).effect).toBe('allow');
  });

  it('applies in live evaluation via rich EvalContext history', async () => {
    const gw = fresh(policy);
    const denied = await gw.evaluate('git_push', {}, CTX);
    expect(denied.effect).toBe('deny');
    const allowed = await gw.evaluate('git_push', {}, {
      ...CTX,
      sessionToolHistory: [makeHistoryEntry('shell', { command: 'git status' })],
    });
    expect(allowed.effect).toBe('allow');
  });

  it('policy file parses argDigest/argPattern history conditions and rejects bad ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mvp-policy66-'));
    try {
      mkdirSync(join(dir, '.kriyadot'));
      const digest = computeArgDigest({ command: 'git status' });
      writeFileSync(
        join(dir, '.kriyadot', 'policy.json'),
        JSON.stringify({
          rules: [
            {
              id: 'ok',
              toolPattern: '^git_push$',
              requiresHistory: { toolPattern: '^shell$', argDigest: digest, argPattern: 'git status' },
              effect: 'allow',
            },
            {
              id: 'bad-digest',
              toolPattern: '^x$',
              requiresHistory: { toolPattern: '^shell$', argDigest: 'xyz' },
              effect: 'allow',
            },
          ],
        }),
      );
      const { policy, errors } = loadWorkspacePolicy(dir);
      expect(policy.rules).toHaveLength(1);
      expect(policy.rules[0]?.requiresHistory).toMatchObject({ argDigest: digest, argPattern: 'git status' });
      expect(errors.some((e) => e.includes('bad-digest'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('#70 opt-in policy snapshot mode', () => {
  it('default resolution is live (no snapshot)', () => {
    const policy = basePolicy([]);
    const res = resolveSessionPolicy(policy);
    expect(res.mode).toBe('live');
    expect(res.snapshot).toBeUndefined();
    expect(res.policy).toBe(policy);
  });

  it('snapshot is frozen, hashed, and unaffected by later mutation of the source', async () => {
    const policy: Policy = {
      defaultEffect: 'require-approval',
      rules: [{ id: 'r1', toolPattern: '^deploy$', effect: 'allow' }],
    };
    const snapshot = createPolicySnapshot(policy, { source: 'test' });
    expect(snapshot.hash).toBe(hashPolicy(policy));
    expect(snapshot.ruleCount).toBe(1);
    expect(Object.isFrozen(snapshot.policy)).toBe(true);
    expect(Object.isFrozen(snapshot.policy.rules)).toBe(true);
    expect(snapshotMatchesPolicy(snapshot, policy)).toBe(true);

    // Mutate the live policy after capture.
    policy.rules.push({ id: 'r2', toolPattern: '^deploy$', effect: 'deny' });
    policy.rules[0]!.effect = 'deny';
    expect(snapshotMatchesPolicy(snapshot, policy)).toBe(false);

    const gw = fresh(policy);
    // Snapshot evaluation: unchanged (original rule allows).
    const snapSim = await gw.simulate('deploy', {}, snapshot.policy);
    expect(snapSim.effect).toBe('allow');
    expect(snapSim.matchedRuleId).toBe('r1');
    // Live evaluation: changed.
    const liveSim = await gw.simulate('deploy', {}, policy);
    expect(liveSim.effect).toBe('deny');
    // evaluateWithSnapshot end-to-end.
    const live = await gw.evaluateWithSnapshot('deploy', {}, CTX, snapshot);
    expect(live.effect).toBe('allow');
  });

  it('mutating the policy FILE after snapshot leaves snapshot evaluation unchanged, live changes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mvp-policy70-'));
    try {
      mkdirSync(join(dir, '.kriyadot'));
      const file = join(dir, '.kriyadot', 'policy.json');
      const write = (effect: string, pad: string) =>
        writeFileSync(
          file,
          JSON.stringify({
            policySnapshot: true,
            rules: [{ id: 'ws', toolPattern: '^deploy$', effect, reason: pad }],
          }),
        );
      write('allow', 'v1');
      const loaded = loadWorkspacePolicy(dir);
      expect(loaded.policySnapshot).toBe(true);
      expect(loaded.policy.policySnapshot).toBe(true);
      const effective = mergeBotPolicy({ defaultEffect: 'require-approval', rules: [] }, loaded.policy);
      const res = resolveSessionPolicy(effective, { snapshot: loaded.policySnapshot, source: dir });
      expect(res.mode).toBe('snapshot');

      // Operator edits the file mid-session.
      clearWorkspacePolicyCache();
      write('deny', 'v2-with-different-length');
      const reloaded = loadWorkspacePolicy(dir);
      const liveEffective = mergeBotPolicy(
        { defaultEffect: 'require-approval', rules: [] },
        reloaded.policy,
      );

      const gw = fresh(liveEffective);
      expect((await gw.simulate('deploy', {}, res.policy)).effect).toBe('allow');
      expect((await gw.simulate('deploy', {}, liveEffective)).effect).toBe('deny');
      expect(res.snapshot?.hash).not.toBe(hashPolicy(liveEffective));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('policySnapshot flag defaults off when absent or non-boolean', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mvp-policy70b-'));
    try {
      mkdirSync(join(dir, '.kriyadot'));
      writeFileSync(join(dir, '.kriyadot', 'policy.json'), JSON.stringify({ rules: [] }));
      expect(loadWorkspacePolicy(dir).policySnapshot).toBeUndefined();
      clearWorkspacePolicyCache();
      writeFileSync(
        join(dir, '.kriyadot', 'policy.json'),
        JSON.stringify({ policySnapshot: 'yes', rules: [] }),
      );
      const res = loadWorkspacePolicy(dir);
      expect(res.policySnapshot).toBeUndefined();
      expect(res.errors.some((e) => e.includes('policySnapshot'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('#122 domain-bound capabilities', () => {
  it('extractTargetHost finds hosts in conventional and incidental args', () => {
    expect(extractTargetHost({ url: 'https://api.example.com/v1?x=1' })).toBe('api.example.com');
    expect(extractTargetHost({ endpoint: 'example.org:8443/path' })).toBe('example.org');
    expect(extractTargetHost({ note: 'see https://Docs.Example.NET/a' })).toBe('docs.example.net');
    expect(extractTargetHost({ command: 'ls -la' })).toBeNull();
    expect(extractTargetHost({})).toBeNull();
  });

  it('hostMatchesDomains: apex+subdomains, *. is subdomain-only, * is all', () => {
    expect(hostMatchesDomains('example.com', ['example.com'])).toBe(true);
    expect(hostMatchesDomains('api.example.com', ['example.com'])).toBe(true);
    expect(hostMatchesDomains('example.com', ['*.example.com'])).toBe(false);
    expect(hostMatchesDomains('api.example.com', ['*.example.com'])).toBe(true);
    expect(hostMatchesDomains('evil.com', ['example.com'])).toBe(false);
    expect(hostMatchesDomains('notexample.com', ['example.com'])).toBe(false);
    expect(hostMatchesDomains('anything.io', ['*'])).toBe(true);
    expect(hostMatchesDomains('api.example.com:443', ['https://example.com/x'])).toBe(true);
  });

  const policy = basePolicy([
    {
      id: 'fetch-example-only',
      toolPattern: '^web_fetch$',
      domains: ['example.com'],
      effect: 'allow',
      reason: 'fetch is bound to example.com',
    },
    // A later permissive rule must NOT rescue an out-of-domain call.
    { id: 'fetch-any', toolPattern: '^web_fetch$', effect: 'allow' },
  ]);

  it('allows in-domain calls and denies out-of-domain calls without fall-through', async () => {
    const gw = fresh(policy);
    const ok = await gw.simulate('web_fetch', { url: 'https://api.example.com/data' }, policy);
    expect(ok.effect).toBe('allow');
    expect(ok.targetHost).toBe('api.example.com');
    const bad = await gw.simulate('web_fetch', { url: 'https://evil.com/data' }, policy);
    expect(bad.effect).toBe('deny');
    expect(bad.domainDenied).toBe(true);
    expect(bad.matchedRuleId).toBe('fetch-example-only');
    expect(bad.reason).toContain('evil.com');
  });

  it('denies when no target host can be determined (fail-closed)', async () => {
    const gw = fresh(policy);
    const sim = await gw.simulate('web_fetch', {}, policy);
    expect(sim.effect).toBe('deny');
    expect(sim.domainDenied).toBe(true);
  });

  it('applies in live evaluation and audits the denial', async () => {
    const gw = fresh(policy);
    expect((await gw.evaluate('web_fetch', { url: 'https://example.com/' }, CTX)).effect).toBe('allow');
    expect((await gw.evaluate('web_fetch', { url: 'https://phish.io/' }, CTX)).effect).toBe('deny');
    const audit = gw.listAudit(10);
    expect(audit.some((a) => a.decision === 'deny' && String(a.detail).includes('phish.io'))).toBe(true);
  });

  it('policy file parses domains and mergeBotPolicy carries them through', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mvp-policy122-'));
    try {
      mkdirSync(join(dir, '.kriyadot'));
      writeFileSync(
        join(dir, '.kriyadot', 'policy.json'),
        JSON.stringify({
          rules: [
            { id: 'bound', toolPattern: '^http_get$', domains: ['example.com'], effect: 'allow' },
            { id: 'bad', toolPattern: '^x$', domains: 'example.com', effect: 'allow' },
          ],
        }),
      );
      const { policy: filePolicy, errors } = loadWorkspacePolicy(dir);
      expect(filePolicy.rules).toHaveLength(1);
      expect(errors.some((e) => e.includes('bad'))).toBe(true);
      const merged = mergeBotPolicy({ defaultEffect: 'deny', rules: [] }, filePolicy);
      expect(merged.rules[0]?.domains).toEqual(['example.com']);
      const gw = fresh(merged);
      expect((await gw.simulate('http_get', { url: 'https://example.com/' }, merged)).effect).toBe('allow');
      expect((await gw.simulate('http_get', { url: 'https://other.com/' }, merged)).effect).toBe('deny');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('#126 local: tools in the default policy', () => {
  it('local tools require approval by default', async () => {
    const gw = fresh(DEFAULT_POLICY);
    const sim = await gw.simulate('local:lint-fix', {});
    expect(sim.effect).toBe('require-approval');
    expect(sim.matchedRuleId).toBe('local-tools-require-approval');
    const live = await gw.evaluate('local:deploy-helper', {}, CTX);
    expect(live.effect).toBe('require-approval');
    expect(live.approvalId).toBeTruthy();
  });

  it('a more specific operator rule placed ahead can allow a named local tool', async () => {
    const policy: Policy = {
      defaultEffect: DEFAULT_POLICY.defaultEffect,
      rules: [
        { id: 'allow-local-lint', toolPattern: '^local:lint-fix$', effect: 'allow' },
        ...DEFAULT_POLICY.rules,
      ],
    };
    const gw = fresh(policy);
    expect((await gw.simulate('local:lint-fix', {}, policy)).effect).toBe('allow');
    expect((await gw.simulate('local:other', {}, policy)).effect).toBe('require-approval');
  });

  it('catastrophic hard denials still fire for shell commands (not weakened)', async () => {
    const gw = fresh(DEFAULT_POLICY);
    const sim = await gw.simulate('run_command', { command: 'rm -rf /' });
    expect(sim.effect).toBe('deny');
  });
});
