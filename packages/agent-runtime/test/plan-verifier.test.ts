// SPDX-License-Identifier: Apache-2.0
// Plan verifier (Soteria Verified Plans, Workstream 1 (b) + (c)):
// symbolic pass over a fake oracle, whole-plan spec evaluation, the
// flag-gated judge (default off, verdicts never conflated), the
// high-risk-only scope, and the recovery decision order.

import { describe, expect, it } from 'vitest';
import {
  applySkipWithDependents,
  createProviderPlanJudge,
  fusionPlanToPlanSteps,
  planRecoveryDecision,
  renderVerificationSummary,
  transitiveDependents,
  verifyPlan,
  type PlanOracleResult,
  type PlanPolicyOracle,
  type PlanStep,
  type StructuredPlan,
} from '../src/plan-verifier.js';
import type { PlanSpec } from '../src/plan-specs.js';
import { buildStructuredPlanPrompt, parseStructuredPlan } from '../src/approval-modes.js';
import { parseModelProfiles, resolvePurposeProfile } from '../src/model-profiles.js';
import { MockProvider } from '../src/providers/mock.js';

const allowOracle: PlanPolicyOracle = { simulate: async () => ({ effect: 'allow' }) };

function oracleWith(map: Record<string, PlanOracleResult>): PlanPolicyOracle {
  return {
    simulate: async (step) => map[step.tool] ?? { effect: 'allow' },
  };
}

function step(partial: Partial<PlanStep> & { id: string; tool: string }): PlanStep {
  return { args: {}, dependsOn: [], ...partial };
}

describe('verifyPlan — per-step oracle pass', () => {
  it('verifies a clean plan and records require-approval as informational', async () => {
    const plan: StructuredPlan = {
      steps: [
        step({ id: 's1', tool: 'read_file', args: { path: 'a.txt' } }),
        step({ id: 's2', tool: 'write_file', args: { path: 'b.txt' }, dependsOn: ['s1'] }),
      ],
    };
    const res = await verifyPlan(plan, [], oracleWith({ write_file: { effect: 'require-approval', reason: 'writes ask' } }));
    expect(res.status).toBe('verified');
    expect(res.steps.find((s) => s.stepId === 's2')?.requiresApproval).toBe(true);
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('blocks a policy-denied step, and marks catastrophic floors absolute', async () => {
    const plan: StructuredPlan = {
      steps: [
        step({ id: 's1', tool: 'run_command', args: { command: 'rm -rf /' } }),
        step({ id: 's2', tool: 'delete_file', args: { path: 'x' } }),
      ],
    };
    const res = await verifyPlan(plan, [], oracleWith({
      run_command: { effect: 'deny', hardFloor: { tier: 'catastrophic', reason: 'catastrophic shell', patternId: 'catastrophic-shell' } },
      delete_file: { effect: 'deny', reason: 'no deletes', matchedRuleId: 'no-delete' },
    }));
    expect(res.status).toBe('blocked');
    expect(res.blocked.map((b) => b.stepId)).toEqual(['s1', 's2']);
    expect(res.blocked[0]?.catastrophic).toBe(true);
    expect(res.blocked[1]?.catastrophic).toBeUndefined();
    expect(res.blocked[1]?.ruleId).toBe('no-delete');
  });

  it('an oracle error makes the step undecidable, never verified', async () => {
    const plan: StructuredPlan = { steps: [step({ id: 's1', tool: 'mystery_tool' })] };
    const res = await verifyPlan(plan, [], {
      simulate: async () => {
        throw new Error('oracle down');
      },
    });
    expect(res.status).toBe('undecidable');
    expect(res.undecidable[0]?.reason).toContain('oracle down');
  });

  it('blocks structural defects: unknown deps and cycles', async () => {
    const unknown: StructuredPlan = { steps: [step({ id: 's1', tool: 'read_file', dependsOn: ['ghost'] })] };
    expect((await verifyPlan(unknown, [], allowOracle)).status).toBe('blocked');
    const cyclic: StructuredPlan = {
      steps: [
        step({ id: 's1', tool: 'read_file', dependsOn: ['s2'] }),
        step({ id: 's2', tool: 'read_file', dependsOn: ['s1'] }),
      ],
    };
    const res = await verifyPlan(cyclic, [], allowOracle);
    expect(res.status).toBe('blocked');
    expect(res.blocked[0]?.reason).toContain('cycle');
  });
});

describe('verifyPlan — whole-plan specs', () => {
  const ordering: PlanSpec = { type: 'ordering', id: 'read-before-write', before: '^read_file$', after: '^write_file$', relation: 'must-precede' };

  it('ordering must-precede: blocks a write with no earlier read', async () => {
    const plan: StructuredPlan = { steps: [step({ id: 's1', tool: 'write_file' })] };
    const res = await verifyPlan(plan, [ordering], allowOracle);
    expect(res.status).toBe('blocked');
    expect(res.blocked[0]?.specId).toBe('read-before-write');
    const ok: StructuredPlan = {
      steps: [step({ id: 's1', tool: 'read_file' }), step({ id: 's2', tool: 'write_file', dependsOn: ['s1'] })],
    };
    expect((await verifyPlan(ok, [ordering], allowOracle)).status).toBe('verified');
  });

  it('ordering must-not-precede: blocks the too-early step', async () => {
    const spec: PlanSpec = { type: 'ordering', id: 'no-send-before-review', before: '^send_email$', after: '^review_step$', relation: 'must-not-precede' };
    const plan: StructuredPlan = {
      steps: [step({ id: 's1', tool: 'send_email' }), step({ id: 's2', tool: 'review_step' })],
    };
    const res = await verifyPlan(plan, [spec], allowOracle);
    expect(res.status).toBe('blocked');
    expect(res.blocked[0]?.stepId).toBe('s1');
  });

  it('requires-history: plan-level, with arg matching', async () => {
    const spec: PlanSpec = {
      type: 'requires-history', id: 'attach-read-first', toolPattern: '^send_email$',
      requires: { toolPattern: '^read_file$', arg: 'path', argPattern: 'report\\.pdf' },
    };
    const bad: StructuredPlan = {
      steps: [
        step({ id: 's1', tool: 'read_file', args: { path: 'notes.txt' } }),
        step({ id: 's2', tool: 'send_email', args: { attachment: 'report.pdf' } }),
      ],
    };
    const res = await verifyPlan(bad, [spec], allowOracle);
    expect(res.status).toBe('blocked');
    expect(res.blocked[0]?.specId).toBe('attach-read-first');
    const good: StructuredPlan = {
      steps: [
        step({ id: 's1', tool: 'read_file', args: { path: 'report.pdf' } }),
        step({ id: 's2', tool: 'send_email', args: { attachment: 'report.pdf' } }),
      ],
    };
    expect((await verifyPlan(good, [spec], allowOracle)).status).toBe('verified');
  });

  it('provenance: literal lineage, $-references, and the undecidable middle', async () => {
    const spec: PlanSpec = {
      type: 'provenance', id: 'delete-only-listed', toolPattern: '^delete_file$', arg: 'path',
      sourceToolPattern: '^list_folder$', sourceArg: 'paths',
    };
    const listed = step({ id: 's1', tool: 'list_folder', args: { path: '.' }, outputs: { paths: 'old.log' } });
    // Literal value among declared outputs → verified.
    const literal: StructuredPlan = { steps: [listed, step({ id: 's2', tool: 'delete_file', args: { path: 'old.log' } })] };
    expect((await verifyPlan(literal, [spec], allowOracle)).status).toBe('verified');
    // Literal value NOT among declared outputs → blocked.
    const foreign: StructuredPlan = { steps: [listed, step({ id: 's2', tool: 'delete_file', args: { path: 'passwd' } })] };
    const res = await verifyPlan(foreign, [spec], allowOracle);
    expect(res.status).toBe('blocked');
    expect(res.blocked[0]?.specId).toBe('delete-only-listed');
    // $-reference to a declared output → verified.
    const ref: StructuredPlan = { steps: [listed, step({ id: 's2', tool: 'delete_file', args: { path: '$s1.paths' } })] };
    expect((await verifyPlan(ref, [spec], allowOracle)).status).toBe('verified');
    // Source step declares no outputs → undecidable (cannot check statically).
    const undeclared: StructuredPlan = {
      steps: [step({ id: 's1', tool: 'list_folder' }), step({ id: 's2', tool: 'delete_file', args: { path: 'x' } })],
    };
    expect((await verifyPlan(undeclared, [spec], allowOracle)).status).toBe('undecidable');
    // No source step at all → blocked.
    const noSource: StructuredPlan = { steps: [step({ id: 's2', tool: 'delete_file', args: { path: 'x' } })] };
    expect((await verifyPlan(noSource, [spec], allowOracle)).status).toBe('blocked');
  });

  it('postcondition specs are recorded for the monitor and never block', async () => {
    const spec: PlanSpec = { type: 'postcondition', id: 'pc', toolPattern: '^write_file$', effectClass: 'file-created' };
    const plan: StructuredPlan = { steps: [step({ id: 's1', tool: 'write_file' })] };
    const res = await verifyPlan(plan, [spec], allowOracle);
    expect(res.status).toBe('verified');
    expect(res.postconditions).toEqual([{ stepId: 's1', specId: 'pc', effectClass: 'file-created' }]);
  });
});

describe('verifyPlan — scope + judge', () => {
  it("scope 'high-risk-only' leaves low-risk steps out-of-scope (not 'verified')", async () => {
    const plan: StructuredPlan = {
      steps: [step({ id: 's1', tool: 'read_file' }), step({ id: 's2', tool: 'delete_file' })],
    };
    const res = await verifyPlan(plan, [], oracleWith({ delete_file: { effect: 'deny', reason: 'no' } }), { scope: 'high-risk-only' });
    expect(res.steps.find((s) => s.stepId === 's1')?.status).toBe('out-of-scope');
    expect(res.status).toBe('blocked'); // the in-scope delete still blocks
    expect(res.scope).toBe('high-risk-only');
  });

  it("scope 'high-risk-only' does not simulate out-of-scope steps at all (narrowing semantics)", async () => {
    let calls = 0;
    const counting: PlanPolicyOracle = {
      simulate: async () => {
        calls += 1;
        return { effect: 'deny', hardFloor: { tier: 'catastrophic', reason: 'floor', patternId: 'p' } };
      },
    };
    const plan: StructuredPlan = { steps: [step({ id: 's1', tool: 'run_command' })] };
    const res = await verifyPlan(plan, [], counting, { scope: 'high-risk-only' });
    expect(calls).toBe(0);
    expect(res.steps[0]?.status).toBe('out-of-scope');
    expect(res.status).toBe('verified'); // nothing in scope blocked; the execution-time floor still applies
  });

  it('semantic steps are undecidable symbolically; the judge is OFF by default', async () => {
    const plan: StructuredPlan = { steps: [step({ id: 's1', tool: 'send_email', args: { content: 'hi' }, semantic: true })] };
    const judge = async () => ({ verdict: 'allow' as const, reason: 'looks fine' });
    const off = await verifyPlan(plan, [], allowOracle, { judge });
    expect(off.status).toBe('undecidable');
    expect(off.judgeVerdicts).toEqual([]);
    const on = await verifyPlan(plan, [], allowOracle, { judge, judgeEnabled: true });
    expect(on.status).toBe('verified');
    // Judge-settled steps stay labelled as judge verdicts — never symbolic.
    expect(on.steps[0]?.source).toBe('judge');
    expect(on.judgeVerdicts).toEqual([{ stepId: 's1', verdict: 'allow', reason: 'looks fine' }]);
    expect(renderVerificationSummary(on)).toContain('judge');
  });

  it('a judge block blocks, with judge provenance', async () => {
    const plan: StructuredPlan = { steps: [step({ id: 's1', tool: 'send_email', semantic: true })] };
    const res = await verifyPlan(plan, [], allowOracle, {
      judgeEnabled: true,
      judge: async () => ({ verdict: 'block', reason: 'unsolicited send' }),
    });
    expect(res.status).toBe('blocked');
    expect(res.blocked[0]?.source).toBe('judge');
  });

  it('createProviderPlanJudge parses verdicts and refuses garbage', async () => {
    const provider = new MockProvider([{ content: '{"verdict":"block","reason":"nope"}' }]);
    const judge = createProviderPlanJudge(provider, 'mock-model');
    const v = await judge(step({ id: 's1', tool: 'send_email', semantic: true }), { plan: { steps: [] } });
    expect(v.verdict).toBe('block');
    const garbage = createProviderPlanJudge(new MockProvider([{ content: 'sure, fine' }]), 'mock-model');
    await expect(garbage(step({ id: 's1', tool: 'send_email', semantic: true }), { plan: { steps: [] } })).rejects.toThrow();
  });

  it("the 'verifier' purpose profile resolves like every other purpose", () => {
    const profiles = parseModelProfiles(JSON.stringify({ verifier: { model: 'ovh-anonymous/gpt-oss-120b' } }));
    const resolved = resolvePurposeProfile('verifier', { profiles, env: {} });
    expect(resolved?.modelId).toBe('gpt-oss-120b');
    expect(resolved?.providerId).toBe('ovh-anonymous');
  });
});

describe('structured plan parsing (runPlanGate seam)', () => {
  it('buildStructuredPlanPrompt asks for JSON steps; parse sanitizes them', () => {
    expect(buildStructuredPlanPrompt('tidy up')).toContain('"steps"');
    const parsed = parseStructuredPlan(
      '```json\n{"steps":[{"id":"s1","tool":"list_folder","args":{"path":"."},"dependsOn":[],"outputs":{"paths":"a.log"}},' +
        '{"id":"s2","tool":"delete_file","args":{"path":"$s1.paths"},"dependsOn":["s1","ghost"],"goal":true},' +
        '{"id":"s2","tool":"dup"}]}\n```',
    );
    expect(parsed?.steps.length).toBe(2);
    expect(parsed?.steps[1]?.dependsOn).toEqual(['s1']); // ghost dep dropped, dup id dropped
    expect(parsed?.steps[1]?.goal).toBe(true);
    expect(parseStructuredPlan('1. First do X\n2. Then do Y')).toBeNull(); // prose → fallback
  });

  it('send steps with free-text content are flagged semantic', () => {
    const parsed = parseStructuredPlan('{"steps":[{"id":"s1","tool":"send_email","args":{"content":"hello"}}]}');
    expect(parsed?.steps[0]?.semantic).toBe(true);
  });
});

describe('recovery decisions (c)', () => {
  const plan: StructuredPlan = {
    steps: [
      step({ id: 's1', tool: 'read_file' }),
      step({ id: 's2', tool: 'write_file', dependsOn: ['s1'] }),
      step({ id: 's3', tool: 'send_email', dependsOn: ['s2'], goal: true }),
      step({ id: 's4', tool: 'list_folder' }),
    ],
  };

  it('transitiveDependents follows the dependency chain', () => {
    expect([...transitiveDependents(plan, 's1')].sort()).toEqual(['s2', 's3']);
    expect([...transitiveDependents(plan, 's4')]).toEqual([]);
  });

  it('skip-with-dependents when goal steps survive', () => {
    const d = planRecoveryDecision({ plan, blockedStepId: 's1', reason: 'denied' });
    // s3 (goal) depends on s1 → does NOT survive → not a skip.
    expect(d.action).toBe('replan');
    const d2 = planRecoveryDecision({ plan, blockedStepId: 's4', reason: 'denied' });
    expect(d2.action).toBe('skip-with-dependents');
    expect(d2.droppedStepIds).toEqual(['s4']);
    const remaining = applySkipWithDependents(plan, d2);
    expect(remaining.steps.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
  });

  it('one bounded re-plan, then ask', () => {
    const first = planRecoveryDecision({ plan, blockedStepId: 's1', reason: 'x', replanUsed: false });
    expect(first.action).toBe('replan');
    const second = planRecoveryDecision({ plan, blockedStepId: 's1', reason: 'x', replanUsed: true });
    expect(second.action).toBe('ask');
    expect(second.reason).toContain('x');
  });

  it('catastrophic denials are absolute: escalate, never skip/re-plan', () => {
    const d = planRecoveryDecision({ plan, blockedStepId: 's4', reason: 'catastrophic shell', catastrophic: true });
    expect(d.action).toBe('escalate');
  });
});

describe('fusion reuse', () => {
  it('fusionPlanToPlanSteps converts post-sanitizePlan output for the verifier', async () => {
    const structured = fusionPlanToPlanSteps({
      subtasks: [
        { id: 'a', title: 'Research', description: 'gather facts', dependencies: [] },
        { id: 'b', title: 'Write', description: 'draft it', dependencies: ['a'] },
      ],
      rationale: 'split',
    });
    expect(structured.steps[1]?.dependsOn).toEqual(['a']);
    const res = await verifyPlan(structured, [], allowOracle);
    expect(res.status).toBe('verified'); // no-tool steps: structure checked, nothing to simulate
    const broken = fusionPlanToPlanSteps({
      subtasks: [{ id: 'a', title: 'X', description: 'y', dependencies: ['missing'] }],
    });
    expect((await verifyPlan(broken, [], allowOracle)).status).toBe('blocked');
  });
});
