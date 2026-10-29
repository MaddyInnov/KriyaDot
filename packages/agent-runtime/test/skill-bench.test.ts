// SPDX-License-Identifier: Apache-2.0
// Skill bench (§1.20): mock-provider runs, pass/fail aggregation and
// tool-expectation checks. Deterministic, zero network.

import { describe, expect, it } from 'vitest';
import { runSkillBench, validateSkillBenchCases } from '../src/evals.js';

const SKILL = { name: 'greeter', instructions: 'Always greet by name and offer tea.' };

describe('runSkillBench', () => {
  it('aggregates pass/fail across contains + tool expectations', async () => {
    const report = await runSkillBench({
      skill: SKILL,
      cases: [
        { prompt: 'greet Ash', expectContains: ['hello ash', 'tea'] },
        { prompt: 'look up tea stock', expectTool: 'inventory_lookup' },
        { prompt: 'greet Bo', expectContains: ['hello bo', 'coffee'] },
      ],
      runTurn: async ({ prompt }) => {
        if (prompt.includes('stock')) return { response: 'checking…', toolsUsed: ['inventory_lookup'] };
        if (prompt.includes('Bo')) return { response: 'Hello Bo, tea?', toolsUsed: [] };
        return { response: 'Hello Ash! Tea?', toolsUsed: [] };
      },
    });
    expect(report.total).toBe(3);
    expect(report.passed).toBe(2);
    expect(report.failed).toBe(1);
    expect(report.passRate).toBeCloseTo(2 / 3);
    expect(report.cases[2].checks.find((c) => c.target === 'coffee')?.passed).toBe(false);
  });

  it('expectTool accepts any of several tools', async () => {
    const report = await runSkillBench({
      skill: SKILL,
      cases: [{ prompt: 'x', expectTool: ['a_tool', 'b_tool'] }],
      runTurn: async () => ({ response: '', toolsUsed: ['b_tool'] }),
    });
    expect(report.passed).toBe(1);
  });

  it('a runner throw fails only that case', async () => {
    const report = await runSkillBench({
      skill: SKILL,
      cases: [
        { prompt: 'boom', expectContains: ['x'] },
        { prompt: 'fine', expectContains: ['ok'] },
      ],
      runTurn: async ({ prompt }) => {
        if (prompt === 'boom') throw new Error('provider down');
        return { response: 'ok', toolsUsed: [] };
      },
    });
    expect(report.passed).toBe(1);
    expect(report.cases[0].error).toBe('provider down');
  });

  it('passes the skill instructions to the runner', async () => {
    let seen = '';
    await runSkillBench({
      skill: SKILL,
      cases: [{ prompt: 'hi', expectContains: ['hi'] }],
      runTurn: async (req) => {
        seen = req.skillInstructions;
        return { response: 'hi', toolsUsed: [] };
      },
    });
    expect(seen).toBe(SKILL.instructions);
  });

  it('rejects invalid case sets', async () => {
    await expect(
      runSkillBench({ skill: SKILL, cases: [{ prompt: 'x' }], runTurn: async () => ({ response: '' }) }),
    ).rejects.toThrow(/at least one of expectContains/);
    expect(validateSkillBenchCases('nope')).toEqual(['cases must be an array']);
    expect(validateSkillBenchCases([])).toEqual(['cases must not be empty']);
  });
});
