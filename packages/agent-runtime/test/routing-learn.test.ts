// SPDX-License-Identifier: Apache-2.0
// Classification learning from corrections: rule extraction, persistence,
// matching, and injection into routeModel.

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { routeModel } from '../src/routing.js';
import {
  ROUTING_RULES_FILENAME,
  extractKeywords,
  formatRoutingRulesPrompt,
  learnFromCorrection,
  loadRoutingRules,
  matchLearnedRule,
  recordRoutingCorrection,
  saveRoutingRules,
  type LearnedRoutingRule,
  type RoutingCorrection,
} from '../src/routing-learn.js';

function correction(overrides: Partial<RoutingCorrection> = {}): RoutingCorrection {
  return {
    taskType: 'code',
    routedProviderId: 'groq',
    routedModelId: 'gpt-oss-20b',
    correctedProviderId: 'agent',
    correctedModelId: 'claude-code/sonnet',
    ...overrides,
  };
}

let savedFreeOnly: string | undefined;
beforeEach(() => {
  savedFreeOnly = process.env.FREE_MODELS_ONLY;
  delete process.env.FREE_MODELS_ONLY;
});
afterEach(() => {
  if (savedFreeOnly === undefined) delete process.env.FREE_MODELS_ONLY;
  else process.env.FREE_MODELS_ONLY = savedFreeOnly;
});

describe('extractKeywords', () => {
  it('extracts distinctive words, dropping stopwords and short tokens', () => {
    const words = extractKeywords('Please deploy the docker container to the kubernetes cluster');
    expect(words).toContain('deploy');
    expect(words).toContain('docker');
    expect(words).toContain('kubernetes');
    expect(words).not.toContain('the');
    expect(words).not.toContain('to');
  });

  it('dedupes and caps at maxWords', () => {
    const words = extractKeywords('alpha beta gamma delta epsilon zeta eta theta', 3);
    expect(words).toEqual(['alpha', 'beta', 'gamma']);
  });
});

describe('learnFromCorrection', () => {
  it('learns a task-type rule and a keyword rule from one correction', () => {
    const rules = learnFromCorrection(
      correction({ message: 'deploy the docker container to production' }),
    );
    expect(rules).toHaveLength(2);
    const [keywordRule, typeRule] = rules as [LearnedRoutingRule, LearnedRoutingRule];
    expect(keywordRule!.when.messagePattern).toMatch(/deploy/);
    expect(keywordRule!.when.messagePattern).toMatch(/docker/);
    expect(keywordRule!.when.taskType).toBe('code');
    expect(keywordRule!.then).toEqual({ providerId: 'agent', modelId: 'claude-code/sonnet' });
    expect(typeRule!.when).toEqual({ taskType: 'code' });
    expect(typeRule!.count).toBe(1);
  });

  it('learns only the task-type rule when the message has no keywords', () => {
    const rules = learnFromCorrection(correction({ message: 'hi' }));
    expect(rules).toHaveLength(1);
    expect(rules[0]!.when).toEqual({ taskType: 'code' });
  });

  it('bumps count on a repeated correction instead of duplicating', () => {
    const once = learnFromCorrection(correction({ message: 'deploy docker containers' }));
    const twice = learnFromCorrection(correction({ message: 'deploy docker images' }), once);
    expect(twice).toHaveLength(2);
    const keyword = twice.find((r) => r.when.messagePattern !== undefined)!;
    const general = twice.find((r) => r.when.messagePattern === undefined)!;
    expect(keyword.count).toBe(2); // strengthened, not duplicated
    expect(general.count).toBe(2);
    // New keyword folded into the pattern (generalization, not a new rule).
    expect(keyword.when.messagePattern).toMatch(/images/);
    expect(keyword.when.messagePattern).toMatch(/containers/);
  });

  it('lets the latest correction win on contradiction for the same scope', () => {
    const once = learnFromCorrection(correction());
    const changed = learnFromCorrection(
      correction({ correctedProviderId: 'ollama', correctedModelId: 'qwen3:8b' }),
      once,
    );
    const typeRule = changed.find((r) => r.when.messagePattern === undefined);
    expect(typeRule!.then).toEqual({ providerId: 'ollama', modelId: 'qwen3:8b' });
    expect(typeRule!.count).toBe(1);
  });

  it('is a no-op when the correction changes nothing', () => {
    const c = correction();
    c.correctedProviderId = c.routedProviderId;
    c.correctedModelId = c.routedModelId;
    expect(learnFromCorrection(c)).toEqual([]);
  });

  it('does not mutate the input rule list', () => {
    const existing = learnFromCorrection(correction());
    const snapshot = JSON.stringify(existing);
    learnFromCorrection(correction({ correctedModelId: 'other/model' }), existing);
    expect(JSON.stringify(existing)).toBe(snapshot);
  });
});

describe('matchLearnedRule', () => {
  it('matches the keyword rule only when the pattern hits', () => {
    const rules = learnFromCorrection(
      correction({ message: 'deploy the docker container' }),
    );
    const hit = matchLearnedRule(rules, { taskType: 'code', message: 'can you deploy this docker image?' });
    expect(hit?.when.messagePattern).toBeDefined();
    const miss = matchLearnedRule(rules, { taskType: 'code', message: 'write a haiku' });
    // Falls through to the general task-type rule (no message pattern).
    expect(miss?.when.messagePattern).toBeUndefined();
    expect(miss?.then.modelId).toBe('claude-code/sonnet');
  });

  it('ignores task-type mismatches', () => {
    const rules = learnFromCorrection(correction());
    expect(matchLearnedRule(rules, { taskType: 'chat', message: 'deploy docker' })).toBeUndefined();
  });

  it('fails closed on a malformed stored pattern', () => {
    const bad: LearnedRoutingRule = {
      id: 'rr-bad',
      description: 'bad',
      when: { taskType: 'code', messagePattern: '([' },
      then: { providerId: 'x', modelId: 'y' },
      count: 1,
      updatedAt: new Date().toISOString(),
    };
    expect(matchLearnedRule([bad], { taskType: 'code', message: 'deploy' })).toBeUndefined();
  });
});

describe('persistence (bot/data dir JSON)', () => {
  it('round-trips rules through routing-rules.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kriyadot-rules-'));
    const rules = recordRoutingCorrection(dir, correction({ message: 'deploy docker now' }));
    expect(rules).toHaveLength(2);
    const raw = JSON.parse(readFileSync(join(dir, ROUTING_RULES_FILENAME), 'utf8')) as {
      version: number;
      rules: unknown[];
    };
    expect(raw.version).toBe(1);
    expect(raw.rules).toHaveLength(2);
    const loaded = loadRoutingRules(dir);
    expect(loaded).toEqual(rules);
    // Second correction in the same dir strengthens, not duplicates.
    const again = recordRoutingCorrection(dir, correction({ message: 'deploy docker again' }));
    expect(again).toHaveLength(2);
    expect(again[0]!.count).toBe(2);
  });

  it('returns [] for a missing or corrupt file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kriyadot-rules-'));
    expect(loadRoutingRules(dir)).toEqual([]);
    expect(loadRoutingRules(join(dir, 'does-not-exist'))).toEqual([]);
  });

  it('saveRoutingRules creates the data dir', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'kriyadot-rules-')), 'nested', 'data');
    saveRoutingRules(dir, []);
    expect(loadRoutingRules(dir)).toEqual([]);
  });
});

describe('formatRoutingRulesPrompt', () => {
  it('renders an injectable markdown section', () => {
    const rules = learnFromCorrection(correction({ message: 'deploy docker containers' }));
    const md = formatRoutingRulesPrompt(rules);
    expect(md).toContain('## Learned routing rules');
    expect(md).toContain('agent/claude-code/sonnet');
    expect(md).toContain('1 user correction');
  });

  it('is empty when there are no rules', () => {
    expect(formatRoutingRulesPrompt([])).toBe('');
  });
});

describe('routeModel learned-rule injection', () => {
  it('applies a matching learned rule over the heuristics', () => {
    const rules = learnFromCorrection(correction());
    const res = routeModel({ taskType: 'code', learnedRules: rules });
    expect(res.providerId).toBe('agent');
    expect(res.modelId).toBe('claude-code/sonnet');
    expect(res.reason).toContain('learned routing rule');
  });

  it('prefers the keyword rule when the message matches, else the type rule', () => {
    const rules = learnFromCorrection(
      correction({ message: 'deploy docker containers' }),
    );
    const keywordHit = routeModel({
      taskType: 'code',
      message: 'deploy this docker setup',
      learnedRules: rules,
    });
    expect(keywordHit.modelId).toBe('claude-code/sonnet');
    const typeOnly = routeModel({ taskType: 'code', message: 'write a poem', learnedRules: rules });
    expect(typeOnly.modelId).toBe('claude-code/sonnet');
  });

  it('an explicit botModel override still wins over learned rules', () => {
    const rules = learnFromCorrection(correction());
    const res = routeModel({
      taskType: 'code',
      botModel: 'groq/gpt-oss-20b',
      learnedRules: rules,
    });
    expect(res.providerId).toBe('groq');
    expect(res.modelId).toBe('gpt-oss-20b');
  });

  it('skips a paid learned target while the free-only guard is active (fail closed)', () => {
    process.env.FREE_MODELS_ONLY = '1';
    const rules = learnFromCorrection(
      correction({ correctedProviderId: 'anthropic', correctedModelId: 'claude-3-5-sonnet-latest' }),
    );
    const res = routeModel({ taskType: 'code', learnedRules: rules });
    // Guard skipped the rule; heuristics picked a free model instead.
    expect(res.providerId).not.toBe('anthropic');
    expect(res.reason).not.toContain('learned routing rule');
  });

  it('behaves exactly as before when no learnedRules are passed', () => {
    const a = routeModel({ taskType: 'reasoning' });
    const b = routeModel({ taskType: 'reasoning', learnedRules: [] });
    expect(a).toEqual(b);
  });
});
