// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { evaluateQuestion, extractFirstJsonObject } from '../src/evaluate.js';
import { MockProvider } from '../src/providers/mock.js';

const profile = { modelId: 'mock-model' };

describe('evaluateQuestion', () => {
  it('answers noul questions with a calibrated probability', async () => {
    const provider = new MockProvider([
      { content: '{"answer": true, "probability": 80, "reason": "evidence is direct"}' },
    ]);
    const ans = await evaluateQuestion(
      provider,
      { kind: 'noul', question: 'Did the tests pass?' },
      { profile },
    );
    expect(ans).toMatchObject({ kind: 'noul', value: true, probability: 0.8, model: 'mock-model' });
  });

  it('accepts 0..1 probabilities as-is', async () => {
    const provider = new MockProvider([{ content: '{"answer": false, "probability": 0.25}' }]);
    const ans = await evaluateQuestion(provider, { kind: 'noul', question: 'Sure?' }, { profile });
    expect(ans?.probability).toBe(0.25);
  });

  it('validates choice answers against the option list', async () => {
    const provider = new MockProvider([{ content: '{"answer": "beta", "probability": 60}' }]);
    const ans = await evaluateQuestion(
      provider,
      { kind: 'choice', question: 'Pick one', choices: ['alpha', 'beta'] },
      { profile },
    );
    expect(ans?.value).toBe('beta');

    const bad = new MockProvider([{ content: '{"answer": "gamma", "probability": 60}' }]);
    expect(
      await evaluateQuestion(
        bad,
        { kind: 'choice', question: 'Pick one', choices: ['alpha', 'beta'] },
        { profile },
      ),
    ).toBeNull();
  });

  it('clamps scores to the scale', async () => {
    const provider = new MockProvider([{ content: '{"answer": 42, "probability": 90}' }]);
    const ans = await evaluateQuestion(provider, { kind: 'score', question: 'Rate it' }, { profile });
    expect(ans?.value).toBe(10);
  });

  it('returns null when the model output is unparseable', async () => {
    const provider = new MockProvider([{ content: 'I think yes, probably.' }]);
    expect(
      await evaluateQuestion(provider, { kind: 'noul', question: 'Ok?' }, { profile }),
    ).toBeNull();
  });

  it('returns null when no model is resolvable (mock provider, no profile)', async () => {
    const provider = new MockProvider([{ content: '{"answer": true, "probability": 99}' }]);
    // No profile/env: free routing never resolves to the 'mock' provider.
    expect(await evaluateQuestion(provider, { kind: 'noul', question: 'Ok?' })).toBeNull();
    expect(provider.calls).toHaveLength(0);
  });
});

describe('extractFirstJsonObject', () => {
  it('extracts JSON embedded in prose', () => {
    expect(extractFirstJsonObject('Sure! {"a": 1} done')).toEqual({ a: 1 });
    expect(extractFirstJsonObject('no json here')).toBeNull();
  });
});
