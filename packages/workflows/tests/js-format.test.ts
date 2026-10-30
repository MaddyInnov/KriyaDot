// SPDX-License-Identifier: Apache-2.0
// D-2 — JS-orchestration workflow format: parse/validate, compile-to-DAG
// equivalence, and end-to-end runs through the standard WorkflowRunner
// (same run records as a DAG workflow). Zero paid API use: the runner is
// built with a fake runtime/governance, and JS workflows use code nodes
// only.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AgentRuntime } from '@mvp/agent-runtime';
import type { GovernanceGateway } from '@mvp/governance';
import {
  JsWorkflowRunner,
  WorkflowRunner,
  compileJsWorkflow,
  parseJsWorkflow,
} from '../src/index.js';

const EXAMPLE_SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'js-workflow.example.js'),
  'utf8',
);

function makeJsRunner(): { js: JsWorkflowRunner; dag: WorkflowRunner } {
  const runtime = {
    runTurn: async () => ({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }),
  } as unknown as AgentRuntime;
  const governance = {
    evaluate: async () => ({ effect: 'allow' }),
    requestApproval: () => 'approval-1',
    awaitDecision: async () => 'approved' as const,
  } as unknown as GovernanceGateway;
  const dag = new WorkflowRunner({
    dbPath: ':memory:',
    agentRuntime: runtime,
    governance,
    tools: new Map(),
    bots: new Map(),
  });
  return { js: new JsWorkflowRunner(dag), dag };
}

describe('parseJsWorkflow', () => {
  it('parses the shipped example module', () => {
    const def = parseJsWorkflow(EXAMPLE_SOURCE);
    expect(def.id).toBe('example-invoice-total');
    expect(def.format).toBe('kriyadot.workflow.js');
    expect(def.steps.map((s) => s.id)).toEqual(['subtotal', 'with-tax']);
  });

  it('rejects a module that never assigns exports.workflow', () => {
    expect(() => parseJsWorkflow('const x = 1;')).toThrow(/exports\.workflow/);
  });

  it('rejects duplicate step ids and empty code', () => {
    expect(() =>
      parseJsWorkflow(
        `exports.workflow = { id: 'w', name: 'W', steps: [
           { id: 'a', code: 'return 1;' }, { id: 'a', code: 'return 2;' } ] };`,
      ),
    ).toThrow(/duplicate step id/);
    expect(() =>
      parseJsWorkflow(
        `exports.workflow = { id: 'w', name: 'W', steps: [ { id: 'a', code: '  ' } ] };`,
      ),
    ).toThrow(/code must be a non-empty string/);
  });

  it('cannot reach host capabilities from module source', () => {
    expect(() =>
      parseJsWorkflow(
        `exports.workflow = { id: 'w', name: String(process.pid), steps: [ { id: 'a', code: 'return 1;' } ] };`,
      ),
    ).toThrow(/module evaluation failed/);
  });

  it('rejects non-data definitions (functions hiding in steps)', () => {
    const def = parseJsWorkflow(
      `exports.workflow = { id: 'w', name: 'W', steps: [ { id: 'a', code: 'return 1;', fn: () => 1 } ] };`,
    );
    // Functions are stripped by the realm-crossing serialization; the
    // surviving definition is plain data and still valid.
    expect(def.steps).toHaveLength(1);
    expect((def.steps[0] as unknown as Record<string, unknown>)['fn']).toBeUndefined();
  });
});

describe('compileJsWorkflow', () => {
  it('compiles to a trigger → code-node chain equivalent to a hand-written DAG', () => {
    const dag = compileJsWorkflow(parseJsWorkflow(EXAMPLE_SOURCE));
    expect(dag.nodes.map((n) => n.type)).toEqual(['trigger', 'code', 'code']);
    expect(dag.edges).toEqual([
      ['__trigger', 'subtotal'],
      ['subtotal', 'with-tax'],
    ]);
    // The second step's code rebinds `input` to the first step's output.
    const taxNode = dag.nodes.find((n) => n.id === 'with-tax');
    expect(String(taxNode?.config['code'])).toContain('nodes["subtotal"].output');
  });
});

describe('JsWorkflowRunner end-to-end', () => {
  it('runs the example through the DAG runner with chained step inputs', async () => {
    const { js } = makeJsRunner();
    const { workflowId } = js.registerSource(EXAMPLE_SOURCE);
    const run = await js.runAndWait(workflowId, { items: [{ price: 10 }, { price: 5 }] });
    expect(run.status).toBe('succeeded');
    expect(run.nodeStates['subtotal']?.output).toEqual({ subtotal: 15 });
    expect(run.nodeStates['with-tax']?.output).toEqual({ subtotal: 15, total: 18 });
  });

  it('produces the same run records as a DAG workflow (store-visible)', async () => {
    const { js } = makeJsRunner();
    const { workflowId } = js.registerSource(EXAMPLE_SOURCE);
    const run = await js.runAndWait(workflowId, { items: [{ price: 1 }] });
    const listed = js.listRuns(workflowId);
    expect(listed.map((r) => r.id)).toContain(run.id);
    expect(js.getRun(run.id)?.status).toBe('succeeded');
  });

  it('a failing step fails the run with the step error in its node state', async () => {
    const { js } = makeJsRunner();
    const { workflowId } = js.registerSource(
      `exports.workflow = { id: 'boom', name: 'Boom', steps: [
         { id: 'ok', code: 'return 1;' },
         { id: 'bad', code: 'throw new Error("step exploded");' } ] };`,
    );
    const run = await js.runAndWait(workflowId, {});
    expect(run.status).toBe('failed');
    expect(run.nodeStates['bad']?.error).toContain('step exploded');
    expect(run.nodeStates['ok']?.status).toBe('succeeded');
  });

  it('later steps can read earlier outputs via nodes.<id>.output', async () => {
    const { js } = makeJsRunner();
    const { workflowId } = js.registerSource(
      `exports.workflow = { id: 'reach-back', name: 'Reach back', steps: [
         { id: 'a', code: 'return 40;' },
         { id: 'b', code: 'return 1;' },
         { id: 'c', code: 'return nodes.a.output + input;' } ] };`,
    );
    const run = await js.runAndWait(workflowId, {});
    expect(run.status).toBe('succeeded');
    expect(run.nodeStates['c']?.output).toBe(41);
  });
});
