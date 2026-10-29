// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import {
  WORKFLOW_FILE_FORMAT,
  WORKFLOW_FILE_VERSION,
  extractCostUsd,
  parseWorkflowFile,
  serializeWorkflow,
} from '../src/index.js';
import type { WorkflowDefinition } from '../src/index.js';

const richDef: WorkflowDefinition = {
  id: 'wf-rich',
  name: 'Rich definition',
  description: 'exercises every format field',
  budget: { maxCostUsd: 2.5 },
  nodes: [
    { id: 'trigger', type: 'trigger', name: 'Start', config: {} },
    {
      id: 'check',
      type: 'if',
      name: 'Check',
      config: { condition: '{{input.n}} > 5' },
      retry: { maxAttempts: 3, backoffMs: 100 },
      timeoutMs: 5000,
    },
    { id: 'yes', type: 'set', name: 'Yes', config: { assignments: { ok: true } } },
    { id: 'no', type: 'set', name: 'No', config: { assignments: { ok: false } } },
    {
      id: 'work',
      type: 'code',
      name: 'Work',
      config: { code: 'return { costCents: 25 };', nested: { list: [1, 'two', null] } },
    },
  ],
  edges: [
    ['trigger', 'check'],
    ['check', 'yes', 'true'],
    ['check', 'no', 'false'],
    ['yes', 'work'],
    ['no', 'work'],
  ],
};

describe('KriyaDot workflow file format', () => {
  it('serializes with the format envelope and round-trips losslessly', () => {
    const json = serializeWorkflow(richDef);
    const envelope = JSON.parse(json) as Record<string, unknown>;
    expect(envelope['format']).toBe(WORKFLOW_FILE_FORMAT);
    expect(envelope['format']).toBe('kriyadot.workflow');
    expect(envelope['version']).toBe(WORKFLOW_FILE_VERSION);
    expect(parseWorkflowFile(json)).toEqual(richDef);
    // Also accepts an already-parsed object.
    expect(parseWorkflowFile(envelope)).toEqual(richDef);
    // Round-trip is stable: serialize(parse(serialize(def))) is identical.
    expect(serializeWorkflow(parseWorkflowFile(json))).toBe(json);
  });

  it('round-trips a minimal definition', () => {
    const minimal: WorkflowDefinition = {
      id: 'wf-min',
      name: 'Minimal',
      nodes: [{ id: 'trigger', type: 'trigger', name: 'T', config: {} }],
      edges: [],
    };
    expect(parseWorkflowFile(serializeWorkflow(minimal))).toEqual(minimal);
  });

  it('rejects malformed JSON and wrong envelopes', () => {
    expect(() => parseWorkflowFile('{not json')).toThrow(/workflow file: invalid JSON/);
    expect(() => parseWorkflowFile('[]')).toThrow(/top level must be an object/);
    expect(() =>
      parseWorkflowFile(JSON.stringify({ version: 1, workflow: richDef })),
    ).toThrow(/unsupported "format"/);
    expect(() =>
      parseWorkflowFile(
        JSON.stringify({ format: 'other.format', version: 1, workflow: richDef }),
      ),
    ).toThrow(/unsupported "format"/);
    expect(() =>
      parseWorkflowFile(
        JSON.stringify({ format: WORKFLOW_FILE_FORMAT, version: 99, workflow: richDef }),
      ),
    ).toThrow(/unsupported "version": 99/);
    expect(() =>
      parseWorkflowFile(JSON.stringify({ format: WORKFLOW_FILE_FORMAT, version: 1 })),
    ).toThrow(/missing "workflow"/);
  });

  it('rejects missing workflow/node ids and duplicate node ids', () => {
    const noWfId = JSON.parse(serializeWorkflow(richDef)) as { workflow: Record<string, unknown> };
    delete noWfId.workflow['id'];
    expect(() => parseWorkflowFile(noWfId)).toThrow(/workflow is missing.*"id"/);

    const noNodeId = JSON.parse(serializeWorkflow(richDef)) as {
      workflow: { nodes: Record<string, unknown>[] };
    };
    delete noNodeId.workflow.nodes[1]['id'];
    expect(() => parseWorkflowFile(noNodeId)).toThrow(/missing a non-empty string "id"/);

    const dup = JSON.parse(serializeWorkflow(richDef)) as {
      workflow: { nodes: Record<string, unknown>[] };
    };
    dup.workflow.nodes[2]['id'] = 'check';
    expect(() => parseWorkflowFile(dup)).toThrow(/duplicate node id: check/);
  });

  it('rejects unknown node types', () => {
    const bad = JSON.parse(serializeWorkflow(richDef)) as {
      workflow: { nodes: Record<string, unknown>[] };
    };
    bad.workflow.nodes[1]['type'] = 'teleport';
    expect(() => parseWorkflowFile(bad)).toThrow(/unknown node type: teleport/);
  });

  it('rejects dangling edges and invalid branch labels', () => {
    const dangling = JSON.parse(serializeWorkflow(richDef)) as {
      workflow: { edges: unknown[] };
    };
    dangling.workflow.edges = [['trigger', 'ghost']];
    expect(() => parseWorkflowFile(dangling)).toThrow(/edge references unknown node: ghost/);

    const badLabel = JSON.parse(serializeWorkflow(richDef)) as {
      workflow: { edges: unknown[] };
    };
    badLabel.workflow.edges = [['trigger', 'check'], ['check', 'yes', 'maybe']];
    expect(() => parseWorkflowFile(badLabel)).toThrow(/invalid branch label/);

    const labelOnNonIf = JSON.parse(serializeWorkflow(richDef)) as {
      workflow: { edges: unknown[] };
    };
    labelOnNonIf.workflow.edges = [['trigger', 'check', 'true']];
    expect(() => parseWorkflowFile(labelOnNonIf)).toThrow(/branch label/);
  });

  it('rejects cycles, bad retry/timeout/budget shapes, and dangling loop refs', () => {
    const cyclic: WorkflowDefinition = {
      id: 'wf-cyc',
      name: 'Cyclic',
      nodes: [
        { id: 'trigger', type: 'trigger', name: 'T', config: {} },
        { id: 'a', type: 'delay', name: 'A', config: { seconds: 0 } },
        { id: 'b', type: 'delay', name: 'B', config: { seconds: 0 } },
      ],
      edges: [
        ['trigger', 'a'],
        ['a', 'b'],
        ['b', 'a'],
      ],
    };
    expect(() => parseWorkflowFile(serializeWorkflow(cyclic))).toThrow(/cycle/);

    const badRetry: WorkflowDefinition = {
      ...richDef,
      nodes: richDef.nodes.map((n) =>
        n.id === 'work' ? { ...n, retry: { maxAttempts: 0 } } : n,
      ),
    };
    expect(() => parseWorkflowFile(serializeWorkflow(badRetry))).toThrow(/retry\.maxAttempts/);

    const badBudget: WorkflowDefinition = { ...richDef, budget: { maxCostUsd: -1 } };
    expect(() => parseWorkflowFile(serializeWorkflow(badBudget))).toThrow(/budget\.maxCostUsd/);

    const danglingLoop: WorkflowDefinition = {
      id: 'wf-loop-bad',
      name: 'Bad loop',
      nodes: [
        { id: 'trigger', type: 'trigger', name: 'T', config: {} },
        {
          id: 'loop',
          type: 'loop',
          name: 'L',
          config: { bodyNodeId: 'ghost', evaluatorNodeId: 'also-ghost' },
        },
      ],
      edges: [['trigger', 'loop']],
    };
    expect(() => parseWorkflowFile(serializeWorkflow(danglingLoop))).toThrow(
      /references unknown node: ghost/,
    );
  });
});

describe('extractCostUsd', () => {
  it('reads costUsd, costCents / cost_cents, and usage-nested costs', () => {
    expect(extractCostUsd({ costUsd: 1.25 })).toBe(1.25);
    expect(extractCostUsd({ costCents: 250 })).toBe(2.5);
    expect(extractCostUsd({ cost_cents: 30 })).toBeCloseTo(0.3);
    expect(extractCostUsd({ usage: { costUsd: 0.5 } })).toBe(0.5);
    expect(extractCostUsd({ usage: { costCents: 40 } })).toBeCloseTo(0.4);
    // costUsd wins over costCents when both are present.
    expect(extractCostUsd({ costUsd: 1, costCents: 999 })).toBe(1);
  });

  it('returns 0 for outputs without a usable cost signal', () => {
    expect(extractCostUsd('plain text')).toBe(0);
    expect(extractCostUsd(null)).toBe(0);
    expect(extractCostUsd([1, 2])).toBe(0);
    expect(extractCostUsd({ totalTokens: 500 })).toBe(0);
    expect(extractCostUsd({ costUsd: -3 })).toBe(0);
    expect(extractCostUsd({ costUsd: 'x' })).toBe(0);
    expect(extractCostUsd({ costUsd: Number.NaN })).toBe(0);
  });
});
