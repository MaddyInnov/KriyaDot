// SPDX-License-Identifier: Apache-2.0

/**
 * Ready-to-use workflow templates, expressed as plain WorkflowDefinitions
 * (so each one serializes with `serializeWorkflow` and parses back with
 * `parseWorkflowFile` — the shipped templates are also living examples of
 * the KriyaDot workflow file format).
 *
 * All four use only built-in node types with no external dependencies
 * (no bots, tools or HTTP endpoints), so they dry-run and execute as-is:
 *
 * - `sequentialPipelineTemplate` — trigger → set → code → set chain.
 * - `fanOutTemplate`             — dynamic fan-out via a `match` node.
 * - `graphTemplate`              — branching graph with an `if` node.
 * - `researchTemplate`           — draft/evaluate `loop` with an evaluator.
 */

import type { WorkflowDefinition } from './types.js';

/** Sequential pipeline: shape the input, transform it, summarize it. */
export const sequentialPipelineTemplate: WorkflowDefinition = {
  id: 'template-sequential-pipeline',
  name: 'Sequential pipeline',
  description: 'A linear chain: shape the input, transform it with code, then summarize the result.',
  nodes: [
    { id: 'trigger', type: 'trigger', name: 'Start', config: {} },
    {
      id: 'shape',
      type: 'set',
      name: 'Shape input',
      config: {
        assignments: {
          title: '{{input.title}}',
          items: '{{input.items}}',
        },
      },
    },
    {
      id: 'transform',
      type: 'code',
      name: 'Transform',
      config: {
        code: "const items = nodes.shape.output.items || [];\nreturn { count: items.length, upper: items.map((x) => String(x).toUpperCase()) };",
      },
    },
    {
      id: 'summary',
      type: 'set',
      name: 'Summarize',
      config: {
        assignments: {
          title: '{{nodes.shape.output.title}}',
          count: '{{nodes.transform.output.count}}',
          upper: '{{nodes.transform.output.upper}}',
        },
      },
    },
  ],
  edges: [
    ['trigger', 'shape'],
    ['shape', 'transform'],
    ['transform', 'summary'],
  ],
};

/**
 * Fan-out: take `input.items`, run the body once per item (at most 3 in
 * parallel), then collect the per-item results in input order.
 */
export const fanOutTemplate: WorkflowDefinition = {
  id: 'template-fan-out',
  name: 'Fan-out (match)',
  description: 'Dynamic fan-out: a match node runs its body once per item of the input list.',
  nodes: [
    { id: 'trigger', type: 'trigger', name: 'Start', config: {} },
    {
      id: 'prep',
      type: 'set',
      name: 'Prepare items',
      config: { assignments: { items: '{{input.items}}' } },
    },
    {
      id: 'fan',
      type: 'match',
      name: 'Process each item',
      config: { sourceNodeId: 'prep', sourcePath: 'items', bodyNodeId: 'process-item', maxParallel: 3 },
    },
    {
      id: 'collect',
      type: 'set',
      name: 'Collect results',
      config: {
        assignments: {
          results: '{{nodes.fan.output.results}}',
          count: '{{nodes.fan.output.count}}',
        },
      },
    },
    // Subordinate body of the match node (driven by `fan`, not wired).
    {
      id: 'process-item',
      type: 'code',
      name: 'Process item',
      config: {
        code: 'return { index, value: item, shout: String(item).toUpperCase() };',
      },
    },
  ],
  edges: [
    ['trigger', 'prep'],
    ['prep', 'fan'],
    ['fan', 'collect'],
  ],
};

/** Branching graph: an `if` node routes to one of two branches, then joins. */
export const graphTemplate: WorkflowDefinition = {
  id: 'template-graph-branching',
  name: 'Branching graph (if)',
  description: 'An if node routes the run down one of two branches; both branches join at the end.',
  nodes: [
    { id: 'trigger', type: 'trigger', name: 'Start', config: {} },
    {
      id: 'check',
      type: 'if',
      name: 'Score is high?',
      config: { condition: '{{input.score}} > 50' },
    },
    {
      id: 'on-high',
      type: 'set',
      name: 'High path',
      config: { assignments: { route: 'high', label: 'Score above threshold' } },
    },
    {
      id: 'on-low',
      type: 'set',
      name: 'Low path',
      config: { assignments: { route: 'low', label: 'Score at or below threshold' } },
    },
    {
      id: 'join',
      type: 'set',
      name: 'Join',
      config: { assignments: { done: true, score: '{{input.score}}' } },
    },
  ],
  edges: [
    ['trigger', 'check'],
    ['check', 'on-high', 'true'],
    ['check', 'on-low', 'false'],
    ['on-high', 'join'],
    ['on-low', 'join'],
  ],
};

/**
 * Research loop: draft, evaluate, repeat until the evaluator accepts the
 * draft (score reaches the bar) or 5 iterations are exhausted.
 */
export const researchTemplate: WorkflowDefinition = {
  id: 'template-research-loop',
  name: 'Research loop (draft + evaluator)',
  description: 'A loop node drafts and evaluates repeatedly until the evaluator accepts the draft.',
  nodes: [
    { id: 'trigger', type: 'trigger', name: 'Start', config: {} },
    {
      id: 'research',
      type: 'loop',
      name: 'Draft until accepted',
      config: { bodyNodeId: 'draft', evaluatorNodeId: 'evaluate', maxIterations: 5 },
    },
    {
      id: 'final',
      type: 'set',
      name: 'Final answer',
      config: {
        assignments: {
          answer: '{{nodes.research.output.bodyOutput.text}}',
          iterations: '{{nodes.research.output.iterations}}',
          score: '{{nodes.research.output.evaluatorOutput.score}}',
        },
      },
    },
    // Subordinate nodes of the loop (driven by `research`, not wired).
    {
      id: 'draft',
      type: 'code',
      name: 'Draft',
      config: {
        code: "const prev = (nodes.draft.output && nodes.draft.output.attempt) || 0;\nconst attempt = prev + 1;\nreturn { attempt, text: 'Draft v' + attempt + ' on: ' + String(input.topic || 'the topic') };",
      },
    },
    {
      id: 'evaluate',
      type: 'code',
      name: 'Evaluate draft',
      config: {
        code: 'const score = nodes.draft.output.attempt * 30;\nreturn { accept: score >= 90, score };',
      },
    },
  ],
  edges: [
    ['trigger', 'research'],
    ['research', 'final'],
  ],
};

/** All shipped templates, in display order. */
export const WORKFLOW_TEMPLATES: readonly WorkflowDefinition[] = [
  sequentialPipelineTemplate,
  fanOutTemplate,
  graphTemplate,
  researchTemplate,
];

/** All shipped templates keyed by workflow id. */
export const workflowTemplatesById: Readonly<Record<string, WorkflowDefinition>> = Object.freeze(
  Object.fromEntries(WORKFLOW_TEMPLATES.map((t) => [t.id, t])),
);
