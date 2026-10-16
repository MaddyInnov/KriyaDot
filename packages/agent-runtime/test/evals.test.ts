// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import {
  BUILTIN_EVAL_SUITES,
  EvalRunner,
  buildJudgeMessages,
  clampJudgeScore,
  parseJudgeScore,
  scoreContainsRubric,
  scoreRegexRubric,
  scoreToolUsedRubric,
  validateEvalSuite,
  type EvalCase,
  type EvalRunnerDeps,
  type EvalSuite,
  type EvalTurnOutput,
} from '../src/evals.js';
import type { BotConfig } from '../src/types.js';
import type { TokenUsage } from '../src/types.js';

const U = (total: number): TokenUsage => ({
  promptTokens: total,
  completionTokens: total,
  totalTokens: total * 2,
});

const BOT = { id: 'b1', name: 'TestBot', provider: 'mock', model: 'mock' } as BotConfig;

function turnReturning(response: string, toolsUsed: string[] = [], usage: TokenUsage = U(10)) {
  return async (): Promise<EvalTurnOutput> => ({ response, toolsUsed, usage });
}

function depsWith(overrides: Partial<EvalRunnerDeps>): EvalRunnerDeps {
  return {
    runTurn: turnReturning('ok'),
    ...overrides,
  };
}

function simpleSuite(cases: EvalCase[]): EvalSuite {
  return { id: 's1', name: 'Suite 1', cases };
}

describe('rubric scorers', () => {
  it('scores contains by keyword coverage (case-insensitive)', () => {
    const r = scoreContainsRubric({ type: 'contains', keywords: ['Rust', 'Biscuit'] }, 'I love rust and biscuit!');
    expect(r.score).toBe(1);
    const partial = scoreContainsRubric({ type: 'contains', keywords: ['Rust', 'Go'] }, 'rust it is');
    expect(partial.score).toBe(0.5);
    expect(partial.detail).toContain('Go');
  });

  it('scores regex match / miss / invalid pattern', () => {
    expect(scoreRegexRubric({ type: 'regex', pattern: '\\d+\\.\\d+' }, 'version 20.1').score).toBe(1);
    expect(scoreRegexRubric({ type: 'regex', pattern: '^nope' }, 'version 20.1').score).toBe(0);
    const bad = scoreRegexRubric({ type: 'regex', pattern: '([' }, 'x');
    expect(bad.score).toBe(0);
    expect(bad.detail).toContain('invalid regex');
  });

  it('scores tool_used for single tool and tool lists', () => {
    expect(scoreToolUsedRubric({ type: 'tool_used', tool: 'read_file' }, ['read_file']).score).toBe(1);
    expect(scoreToolUsedRubric({ type: 'tool_used', tool: 'read_file' }, ['glob']).score).toBe(0);
    expect(scoreToolUsedRubric({ type: 'tool_used', tool: ['glob', 'run_command'] }, ['run_command']).score).toBe(1);
  });
});

describe('validateEvalSuite', () => {
  it('accepts all built-in suites', () => {
    expect(BUILTIN_EVAL_SUITES.length).toBe(3);
    for (const s of BUILTIN_EVAL_SUITES) {
      const v = validateEvalSuite(s);
      expect(v.errors).toEqual([]);
      expect(v.ok).toBe(true);
    }
  });

  it('rejects bad suites', () => {
    expect(validateEvalSuite(null).ok).toBe(false);
    expect(validateEvalSuite({ id: 'BAD ID!', name: 'x', cases: [] }).ok).toBe(false);
    // unknown rubric type
    const bad = {
      id: 's1',
      name: 'S',
      cases: [{ id: 'c1', name: 'C', input: 'hi', rubrics: [{ type: 'nope' }] }],
    };
    expect(validateEvalSuite(bad).ok).toBe(false);
    // invalid regex
    const badRe = {
      id: 's1',
      name: 'S',
      cases: [{ id: 'c1', name: 'C', input: 'hi', rubrics: [{ type: 'regex', pattern: '([' }] }],
    };
    expect(validateEvalSuite(badRe).ok).toBe(false);
    // duplicate case ids
    const dup = {
      id: 's1',
      name: 'S',
      cases: [
        { id: 'c1', name: 'C', input: 'hi', rubrics: [{ type: 'contains', keywords: ['a'] }] },
        { id: 'c1', name: 'C2', input: 'hi', rubrics: [{ type: 'contains', keywords: ['a'] }] },
      ],
    };
    expect(validateEvalSuite(dup).ok).toBe(false);
    // too many cases
    const many = {
      id: 's1',
      name: 'S',
      cases: Array.from({ length: 51 }, (_, i) => ({
        id: `c${i}`,
        name: 'C',
        input: 'hi',
        rubrics: [{ type: 'contains', keywords: ['a'] }],
      })),
    };
    expect(validateEvalSuite(many).ok).toBe(false);
  });
});

describe('EvalRunner', () => {
  const passingCase: EvalCase = {
    id: 'c1',
    name: 'Reads a file',
    input: 'read it',
    rubrics: [{ type: 'tool_used', tool: 'read_file' }],
  };

  it('runs cases and scores them', async () => {
    const runner = new EvalRunner(depsWith({ runTurn: turnReturning('here you go', ['read_file']) }));
    const events: string[] = [];
    const report = await runner.run(simpleSuite([passingCase]), BOT, {
      onEvent: (e) => {
        events.push(e.type);
      },
    });
    expect(report.status).toBe('completed');
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(0);
    expect(report.score).toBe(1);
    expect(report.caseResults[0].passed).toBe(true);
    expect(events).toEqual(['run_started', 'case_started', 'case_done', 'done']);
  });

  it('fails cases that miss the rubric', async () => {
    const runner = new EvalRunner(depsWith({ runTurn: turnReturning('no tools here', []) }));
    const report = await runner.run(simpleSuite([passingCase]), BOT);
    expect(report.passed).toBe(0);
    expect(report.caseResults[0].passed).toBe(false);
    expect(report.caseResults[0].rubricResults[0].detail).toContain('read_file');
  });

  it('enforces the per-case timeout even when runTurn never settles', async () => {
    // A non-cooperative runTurn that ignores the abort signal entirely.
    const hanging = () => new Promise<EvalTurnOutput>(() => {});
    const runner = new EvalRunner(depsWith({ runTurn: hanging }));
    const c: EvalCase = { id: 'ct', name: 'Timeout', input: 'hang', rubrics: [{ type: 'contains', keywords: ['x'] }], timeoutMs: 50 };
    const start = Date.now();
    const report = await runner.run(simpleSuite([c]), BOT);
    const elapsed = Date.now() - start;
    expect(report.caseResults[0].passed).toBe(false);
    expect(report.caseResults[0].error).toMatch(/timed out after 50ms/);
    // Bounded: well under a generous ceiling (the hang would run forever).
    expect(elapsed).toBeLessThan(5000);
  });

  it('scores llm_judge with an injected judge', async () => {
    const judge = vi.fn(async () => 0.9);
    const c: EvalCase = {
      id: 'cj',
      name: 'Judge me',
      input: 'do it',
      rubrics: [{ type: 'llm_judge', criteria: 'is polite', threshold: 0.8 }],
    };
    const runner = new EvalRunner(depsWith({ runTurn: turnReturning('certainly!'), judge }));
    const report = await runner.run(simpleSuite([c]), BOT);
    expect(judge).toHaveBeenCalledWith('is polite', 'certainly!');
    expect(report.caseResults[0].score).toBe(0.9);
    expect(report.caseResults[0].passed).toBe(true);
  });

  it('scores llm_judge as 0 when no judge is configured', async () => {
    const c: EvalCase = {
      id: 'cj',
      name: 'Judge me',
      input: 'do it',
      rubrics: [{ type: 'llm_judge', criteria: 'is polite' }],
    };
    const runner = new EvalRunner(depsWith({ runTurn: turnReturning('certainly!') }));
    const report = await runner.run(simpleSuite([c]), BOT);
    expect(report.caseResults[0].score).toBe(0);
    expect(report.caseResults[0].rubricResults[0].detail).toContain('no judge');
  });

  it('records turn failures as failed cases, not crashes', async () => {
    const runner = new EvalRunner(
      depsWith({
        runTurn: async () => {
          throw new Error('provider exploded');
        },
      }),
    );
    const report = await runner.run(simpleSuite([passingCase]), BOT);
    expect(report.status).toBe('completed');
    expect(report.caseResults[0].error).toContain('provider exploded');
    expect(report.caseResults[0].passed).toBe(false);
  });

  it('aborts remaining cases when the budget is exceeded', async () => {
    const runner = new EvalRunner(
      depsWith({
        runTurn: turnReturning('x', ['read_file'], U(1000)),
        costOf: () => 5, // $5 per case
      }),
    );
    const cases = [passingCase, { ...passingCase, id: 'c2' }, { ...passingCase, id: 'c3' }];
    const report = await runner.run(simpleSuite(cases), BOT, { maxBudgetUsd: 6, maxConcurrency: 1 });
    expect(report.status).toBe('aborted_budget');
    expect(report.caseResults.length).toBeLessThan(3);
    expect(report.costUsd).toBeGreaterThan(6);
  });

  it('seeds setup memories before the case runs', async () => {
    const storeMemory = vi.fn(async () => undefined);
    const seen: string[] = [];
    const runner = new EvalRunner(
      depsWith({
        runTurn: async () => {
          seen.push('turn');
          return { response: 'Rust and Biscuit', toolsUsed: [], usage: U(1) };
        },
        storeMemory,
      }),
    );
    const c: EvalCase = {
      id: 'cm',
      name: 'Recall',
      input: 'what?',
      setupMemories: ['a', 'b'],
      rubrics: [{ type: 'contains', keywords: ['Rust'] }],
    };
    await runner.run(simpleSuite([c]), BOT);
    expect(storeMemory).toHaveBeenCalledTimes(2);
    expect(storeMemory).toHaveBeenCalledWith('b1', 'a');
    expect(seen).toEqual(['turn']);
  });

  it('passes timeout and signal to the turn function', async () => {
    let captured: { timeoutMs: number; signal: AbortSignal } | null = null;
    const runner = new EvalRunner(
      depsWith({
        runTurn: async (_b, req) => {
          captured = { timeoutMs: req.timeoutMs, signal: req.signal };
          return { response: 'ok', toolsUsed: [], usage: U(1) };
        },
      }),
    );
    const c: EvalCase = { ...passingCase, timeoutMs: 5000 };
    await runner.run(simpleSuite([c]), BOT);
    expect(captured!.timeoutMs).toBe(5000);
    expect(captured!.signal).toBeInstanceOf(AbortSignal);
  });

  it('a throwing progress listener does not break the run', async () => {
    const runner = new EvalRunner(depsWith({ runTurn: turnReturning('ok', ['read_file']) }));
    const report = await runner.run(simpleSuite([passingCase]), BOT, {
      onEvent: () => {
        throw new Error('listener boom');
      },
    });
    expect(report.status).toBe('completed');
  });

  it('rejects invalid suites instead of running', async () => {
    const runner = new EvalRunner(depsWith({}));
    await expect(runner.run({ id: 'bad', name: 'Bad', cases: [] }, BOT)).rejects.toThrow(/Invalid eval suite/);
  });
});

describe('judge helpers', () => {
  it('clamps judge scores', () => {
    expect(clampJudgeScore(0.5)).toBe(0.5);
    expect(clampJudgeScore(2)).toBe(1);
    expect(clampJudgeScore(-1)).toBe(0);
    expect(clampJudgeScore(NaN)).toBe(0);
  });

  it('parses judge text replies', () => {
    expect(parseJudgeScore('0.85')).toBe(0.85);
    expect(parseJudgeScore('Score: 0.7 — polite refusal')).toBe(0.7);
    expect(parseJudgeScore('no number here')).toBe(0);
  });

  it('builds a strict judge prompt', () => {
    const msgs = buildJudgeMessages('be nice', 'hello');
    expect(msgs[0].role).toBe('system');
    expect(msgs[1].content).toContain('be nice');
    expect(msgs[1].content).toContain('hello');
  });
});
