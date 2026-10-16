// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  buildGoalCoordinatorPrompt,
  clampGoalMaxTurns,
  isGoalId,
  newGoalId,
  parseControlDecision,
  selectGoalCoordinator,
  validGoalTitle,
  GOAL_CONTROL_FENCE,
  type BotConfig,
} from '../src/group-goals.js';

const ENV = (decision: string, extra = ''): string =>
  `Working on it.\n\`\`\`${GOAL_CONTROL_FENCE}\n{"decision": "${decision}"${extra}}\n\`\`\``;

function bot(id: string, chief = false): BotConfig {
  return { id, name: id, chiefOfStaff: chief } as BotConfig;
}

describe('parseControlDecision', () => {
  it('parses all four decisions', () => {
    for (const d of ['completed', 'needs-input', 'blocked', 'continue'] as const) {
      const p = parseControlDecision(ENV(d));
      expect(p.decision).toBe(d);
      expect(p.fallback).toBeUndefined();
    }
  });

  it('extracts next_step and summary', () => {
    const p = parseControlDecision(
      ENV('continue', ', "next_step": "ask Coder", "summary": "half done"'),
    );
    expect(p.decision).toBe('continue');
    expect(p.nextStep).toBe('ask Coder');
    expect(p.summary).toBe('half done');
  });

  it('accepts nextStep camelCase alias', () => {
    const p = parseControlDecision(ENV('blocked', ', "nextStep": "waiting on deploy"'));
    expect(p.decision).toBe('blocked');
    expect(p.nextStep).toBe('waiting on deploy');
  });

  it('the last envelope wins', () => {
    const text = `${ENV('continue')}\nActually done now.\n${ENV('completed', ', "summary": "all good"')}`;
    const p = parseControlDecision(text);
    expect(p.decision).toBe('completed');
    expect(p.summary).toBe('all good');
  });

  it('missing envelope falls back to continue', () => {
    const p = parseControlDecision('just some text, no envelope');
    expect(p.decision).toBe('continue');
    expect(p.fallback).toBe('missing');
  });

  it('malformed JSON falls back to continue', () => {
    const p = parseControlDecision(`\`\`\`${GOAL_CONTROL_FENCE}\n{not json\`\`\``);
    expect(p.decision).toBe('continue');
    expect(p.fallback).toBe('malformed');
  });

  it('unknown decision falls back to continue', () => {
    const p = parseControlDecision(ENV('almost-done'));
    expect(p.decision).toBe('continue');
    expect(p.fallback).toBe('unknown-decision');
  });

  it('non-object envelope falls back to continue', () => {
    const p = parseControlDecision(`\`\`\`${GOAL_CONTROL_FENCE}\n"continue"\n\`\`\``);
    expect(p.decision).toBe('continue');
    expect(p.fallback).toBe('malformed');
  });
});

describe('selectGoalCoordinator', () => {
  it('prefers the chief of staff', () => {
    const bots = [bot('worker'), bot('chief', true), bot('other')];
    expect(selectGoalCoordinator(bots)?.id).toBe('chief');
  });

  it('falls back to the first bot when there is no chief', () => {
    const bots = [bot('a'), bot('b')];
    expect(selectGoalCoordinator(bots)?.id).toBe('a');
  });

  it('returns undefined for an empty roster', () => {
    expect(selectGoalCoordinator([])).toBeUndefined();
  });
});

describe('buildGoalCoordinatorPrompt', () => {
  it('includes the goal, roster, turn bound and envelope instructions', () => {
    const prompt = buildGoalCoordinatorPrompt({
      goalTitle: 'Ship the report',
      goalDescription: 'PDF by Friday',
      coordinatorName: 'Chief',
      workers: [{ id: 'coder', name: 'Coder', description: 'writes code' }],
      turnNumber: 1,
      maxTurns: 13,
      history: [],
    });
    expect(prompt).toContain('Ship the report');
    expect(prompt).toContain('PDF by Friday');
    expect(prompt).toContain('coder');
    expect(prompt).toContain('turn 1 of at most 13');
    expect(prompt).toContain('```goal-control');
    expect(prompt).toContain('"completed"');
    expect(prompt).toContain('"needs-input"');
  });

  it('condenses history and resume input on later turns', () => {
    const prompt = buildGoalCoordinatorPrompt({
      goalTitle: 'Ship the report',
      coordinatorName: 'Chief',
      workers: [],
      turnNumber: 3,
      maxTurns: 13,
      history: [
        { turn: 1, decision: 'continue', nextStep: 'ask Coder', delegations: ['Coder: write parser (done)'] },
        { turn: 2, decision: 'needs-input', nextStep: 'need the logo' },
      ],
      resumeInput: 'here is the logo',
    });
    expect(prompt).toContain('turn 3 of at most 13');
    expect(prompt).toContain('Turn 1: decision=continue');
    expect(prompt).toContain('here is the logo');
  });
});

describe('validation', () => {
  it('validGoalTitle', () => {
    expect(validGoalTitle('Do the thing')).toBe(true);
    expect(validGoalTitle('')).toBe(false);
    expect(validGoalTitle('   ')).toBe(false);
    expect(validGoalTitle('x'.repeat(141))).toBe(false);
    expect(validGoalTitle('x'.repeat(140))).toBe(true);
  });

  it('clampGoalMaxTurns', () => {
    expect(clampGoalMaxTurns(undefined)).toBe(13);
    expect(clampGoalMaxTurns('x')).toBe(13);
    expect(clampGoalMaxTurns(5)).toBe(5);
    expect(clampGoalMaxTurns(0)).toBe(1);
    expect(clampGoalMaxTurns(100)).toBe(30);
    expect(clampGoalMaxTurns(7.9)).toBe(7);
  });

  it('goal ids', () => {
    const id = newGoalId();
    expect(isGoalId(id)).toBe(true);
    expect(isGoalId('nope')).toBe(false);
    expect(isGoalId('goal_')).toBe(false);
  });
});
