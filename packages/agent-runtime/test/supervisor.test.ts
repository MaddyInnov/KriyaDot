// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { verifyCompletionClaim, type TurnEvidence } from '../src/supervisor.js';
import { MockProvider } from '../src/providers/mock.js';

const evidence: TurnEvidence[] = [
  { toolName: 'verify_changes', ok: true, mutating: true, excerpt: 'tests: 42 passed' },
  { toolName: 'write_file', ok: true, mutating: true, excerpt: 'wrote src/a.ts' },
];
const profile = { modelId: 'mock-model' };

describe('verifyCompletionClaim', () => {
  it('rejects a claim with NO successful evidence without calling the model', async () => {
    const provider = new MockProvider([{ content: '{"verdict": "accept"}' }]);
    const verdict = await verifyCompletionClaim(
      provider,
      { request: 'Fix the bug', claim: 'All done!', evidence: [] },
      { profile },
    );
    expect(verdict.accepted).toBe(false);
    expect(provider.calls).toHaveLength(0);
    if (!verdict.accepted) expect(verdict.guidance).toContain('no runtime evidence');
  });

  it('rejects when all evidence failed', async () => {
    const provider = new MockProvider([{ content: '{"verdict": "accept"}' }]);
    const failed: TurnEvidence[] = [
      { toolName: 'run_command', ok: false, mutating: true, excerpt: 'exit 1' },
    ];
    const verdict = await verifyCompletionClaim(
      provider,
      { request: 'Fix it', claim: 'Fixed!', evidence: failed },
      { profile },
    );
    expect(verdict.accepted).toBe(false);
    expect(provider.calls).toHaveLength(0);
  });

  it('accepts when the supervisor accepts the quoted evidence', async () => {
    const provider = new MockProvider([
      { content: '{"verdict": "accept", "reason": "tests quoted and passing"}' },
    ]);
    const verdict = await verifyCompletionClaim(
      provider,
      { request: 'Fix the bug', claim: 'Fixed and tested', evidence },
      { profile },
    );
    expect(verdict).toMatchObject({ accepted: true, reason: 'tests quoted and passing' });
    // The supervisor saw the quoted evidence, not just the claim.
    expect(provider.calls[0]!.messages[0]!.content).toContain('tests: 42 passed');
  });

  it('rejects with guidance when the supervisor rejects', async () => {
    const provider = new MockProvider([
      { content: '{"verdict": "reject", "reason": "lint never ran", "guidance": "Run the linter and quote its output."}' },
    ]);
    const verdict = await verifyCompletionClaim(
      provider,
      { request: 'Fix the bug', claim: 'Done', evidence },
      { profile },
    );
    expect(verdict.accepted).toBe(false);
    if (!verdict.accepted) expect(verdict.guidance).toContain('Run the linter');
  });

  it('skips (accepts) when no supervisor model is resolvable', async () => {
    const provider = new MockProvider([{ content: '{"verdict": "reject"}' }]);
    const verdict = await verifyCompletionClaim(
      provider,
      { request: 'Fix', claim: 'Done', evidence },
      {},
    );
    expect(verdict).toMatchObject({ accepted: true, skipped: true });
    expect(provider.calls).toHaveLength(0);
  });

  it('skips (accepts) on unparseable supervisor output', async () => {
    const provider = new MockProvider([{ content: 'looks fine to me' }]);
    const verdict = await verifyCompletionClaim(
      provider,
      { request: 'Fix', claim: 'Done', evidence },
      { profile },
    );
    expect(verdict).toMatchObject({ accepted: true, skipped: true });
  });
});
