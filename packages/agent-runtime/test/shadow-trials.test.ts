// SPDX-License-Identifier: Apache-2.0
// Shadow-trial evolution pipeline for learned routing rules.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadRoutingRules,
  matchLearnedRule,
  promoteRule,
  proposeFromCorrection,
  recordShadowCorrection,
  retireRule,
  ruleStatus,
  scoreShadowRules,
  type RoutingCorrection,
} from '../src/routing-learn.js';

const correction = (over: Partial<RoutingCorrection> = {}): RoutingCorrection => ({
  taskType: 'code',
  routedProviderId: 'groq',
  routedModelId: 'llama-3.1-8b-instant',
  correctedProviderId: 'agent/claude-code',
  correctedModelId: 'sonnet',
  message: 'deploy the docker container to kubernetes',
  ...over,
});

describe('shadow lifecycle', () => {
  it('new candidate rules enter shadow and never match routing', () => {
    const rules = proposeFromCorrection(correction());
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.every((r) => ruleStatus(r) === 'shadow')).toBe(true);
    // Even a perfect scope/message match must not route while in shadow.
    expect(
      matchLearnedRule(rules, { taskType: 'code', message: 'deploy the docker container to kubernetes' }),
    ).toBeUndefined();
  });

  it('legacy rules without a status stay active and keep matching', () => {
    const legacy = [
      {
        id: 'rr-legacy',
        description: 'old rule',
        when: { taskType: 'code' as const },
        then: { providerId: 'x', modelId: 'y' },
        count: 2,
        updatedAt: new Date().toISOString(),
      },
    ];
    expect(matchLearnedRule(legacy, { taskType: 'code' })?.id).toBe('rr-legacy');
  });

  it('scores trials: agreements accumulate, disagreements count against', () => {
    let rules = proposeFromCorrection(correction());
    rules = scoreShadowRules(rules, correction());
    const general = rules.find((r) => r.when.messagePattern === undefined)!;
    expect(general.shadow).toMatchObject({ trials: 1, agreements: 1, disagreements: 0 });
    // A correction in the same scope pointing somewhere else disagrees
    // with the general shadow rule (it matches on task type alone).
    rules = scoreShadowRules(
      rules,
      correction({ correctedProviderId: 'openai', correctedModelId: 'gpt-x', message: 'write a haiku about rain' }),
    );
    const generalAfter = rules.find((r) => r.when.messagePattern === undefined)!;
    expect(generalAfter.shadow?.trials).toBe(2);
    expect(generalAfter.shadow?.disagreements).toBe(1);
  });
});

describe('promotion + rollback', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mvp-shadow-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('auto-promotes after enough agreeing corrections, then routes live', () => {
    let promoted: string[] = [];
    for (let i = 0; i < 3; i++) {
      const out = recordShadowCorrection(dir, correction({ message: `deploy the docker container run ${i}` }));
      promoted = out.promoted;
    }
    expect(promoted.length).toBeGreaterThan(0);
    const rules = loadRoutingRules(dir);
    const live = rules.filter((r) => ruleStatus(r) === 'active');
    expect(live.length).toBeGreaterThan(0);
    expect(
      matchLearnedRule(rules, { taskType: 'code', message: 'deploy the docker container to kubernetes' }),
    ).toBeDefined();
  });

  it('human promote bypasses the bar; rollback retires for good', () => {
    const { rules } = recordShadowCorrection(dir, correction());
    const id = rules[0]!.id;
    const promoted = promoteRule(rules, id);
    expect(ruleStatus(promoted.find((r) => r.id === id)!)).toBe('active');
    const retired = retireRule(promoted, id);
    expect(ruleStatus(retired.find((r) => r.id === id)!)).toBe('retired');
    expect(matchLearnedRule(retired, { taskType: 'code', message: 'deploy the docker container' })).toBeUndefined();
    // A retired rule cannot be resurrected by promote.
    expect(ruleStatus(promoteRule(retired, id).find((r) => r.id === id)!)).toBe('retired');
  });
});
