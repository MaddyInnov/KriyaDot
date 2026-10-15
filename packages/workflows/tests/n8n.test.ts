// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { exportN8nWorkflow, importN8nWorkflow } from '../src/index.js';
import type { N8nWorkflowJson, WorkflowDefinition } from '../src/index.js';

// A representative n8n export: webhook → set → if → (true) http / (false) code,
// plus an unknown Slack node and a sticky note.
const SAMPLE_N8N: N8nWorkflowJson = {
  name: 'Order triage',
  nodes: [
    {
      id: 'a1',
      name: 'Webhook',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2,
      position: [240, 300],
      parameters: { httpMethod: 'POST', path: 'orders', responseMode: 'responseNode' },
      webhookId: 'wh-123',
    },
    {
      id: 'b2',
      name: 'Normalize',
      type: 'n8n-nodes-base.set',
      typeVersion: 3,
      position: [520, 300],
      parameters: {
        assignments: {
          assignments: [
            { id: 'x1', name: 'total', value: '={{$json.amount}}', type: 'number' },
            { id: 'x2', name: 'label', value: 'order', type: 'string' },
          ],
        },
        keepOnlySet: true,
      },
    },
    {
      id: 'c3',
      name: 'Big order?',
      type: 'n8n-nodes-base.if',
      typeVersion: 2,
      position: [800, 300],
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
          conditions: [
            {
              id: 'y1',
              leftValue: '={{$json.total}}',
              rightValue: 1000,
              operator: { type: 'number', operation: 'larger' },
            },
          ],
          combinator: 'and',
        },
        options: {},
      },
    },
    {
      id: 'd4',
      name: 'Notify API',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4,
      position: [1080, 200],
      parameters: {
        url: 'https://example.com/notify',
        method: 'POST',
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '{"total": 1}',
        options: {},
      },
    },
    {
      id: 'e5',
      name: 'Log small',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [1080, 420],
      parameters: { mode: 'runOnceForAllItems', jsCode: 'return { logged: true };' },
    },
    {
      id: 'f6',
      name: 'Slack ping',
      type: 'n8n-nodes-base.slack',
      typeVersion: 2,
      position: [1360, 200],
      parameters: { channel: '#orders' },
    },
    {
      id: 'g7',
      name: 'Note',
      type: 'n8n-nodes-base.stickyNote',
      typeVersion: 1,
      position: [240, 120],
      parameters: { content: 'remember the thing' },
    },
  ],
  connections: {
    Webhook: { main: [[{ node: 'Normalize', type: 'main', index: 0 }]] },
    Normalize: { main: [[{ node: 'Big order?', type: 'main', index: 0 }]] },
    'Big order?': {
      main: [
        [{ node: 'Notify API', type: 'main', index: 0 }],
        [{ node: 'Log small', type: 'main', index: 0 }],
      ],
    },
    'Notify API': { main: [[{ node: 'Slack ping', type: 'main', index: 0 }]] },
  },
  active: false,
};

describe('importN8nWorkflow', () => {
  it('maps common n8n nodes to KriyaDot node types', () => {
    const { workflow, unmapped } = importN8nWorkflow(SAMPLE_N8N);
    const byName = Object.fromEntries(workflow.nodes.map((n) => [n.name, n]));

    expect(workflow.name).toBe('Order triage');
    expect(byName['Webhook'].type).toBe('trigger');
    expect(byName['Webhook'].config).toMatchObject({ triggerKind: 'webhook', path: 'orders' });
    expect(byName['Normalize'].type).toBe('set');
    expect(byName['Normalize'].config).toMatchObject({
      assignments: { total: '={{$json.amount}}', label: 'order' },
    });
    expect(byName['Big order?'].type).toBe('if');
    expect(byName['Big order?'].config['condition']).toMatch(/input\.total/);
    expect(byName['Notify API'].type).toBe('http');
    expect(byName['Notify API'].config).toMatchObject({
      url: 'https://example.com/notify',
      method: 'POST',
    });
    expect(byName['Log small'].type).toBe('code');

    // Exactly one trigger is kept.
    expect(workflow.nodes.filter((n) => n.type === 'trigger')).toHaveLength(1);
    // Sticky note is dropped, not imported.
    expect(byName['Note']).toBeUndefined();
    // Slack has no mapping → reported, placeholder node keeps the graph intact.
    expect(unmapped.map((u) => u.n8nType)).toContain('n8n-nodes-base.slack');
    expect(unmapped.find((u) => u.n8nType === 'n8n-nodes-base.slack')).toMatchObject({
      name: 'Slack ping',
    });
    expect(byName['Slack ping (unmapped)'].type).toBe('code');
  });

  it('labels if-branch edges true/false', () => {
    const { workflow } = importN8nWorkflow(SAMPLE_N8N);
    const idOf = (name: string): string => {
      const n = workflow.nodes.find((x) => x.name === name);
      if (!n) throw new Error(`missing node ${name}`);
      return n.id;
    };
    const ifId = idOf('Big order?');
    const trueEdge = workflow.edges.find(
      ([f, t, b]) => f === ifId && t === idOf('Notify API'),
    );
    const falseEdge = workflow.edges.find(
      ([f, t, b]) => f === ifId && t === idOf('Log small'),
    );
    expect(trueEdge?.[2]).toBe('true');
    expect(falseEdge?.[2]).toBe('false');
  });

  it('synthesizes a trigger when the n8n workflow has none', () => {
    const noTrigger: N8nWorkflowJson = {
      name: 'No trigger',
      nodes: [
        {
          id: 's1',
          name: 'Set',
          type: 'n8n-nodes-base.set',
          typeVersion: 3,
          position: [240, 300],
          parameters: { assignments: { assignments: [] } },
        },
      ],
      connections: {},
    };
    const { workflow } = importN8nWorkflow(noTrigger);
    const triggers = workflow.nodes.filter((n) => n.type === 'trigger');
    expect(triggers).toHaveLength(1);
    expect(workflow.edges).toContainEqual([triggers[0].id, 's1']);
  });

  it('keeps only the first trigger and reports the extras', () => {
    const twoTriggers: N8nWorkflowJson = {
      name: 'Two triggers',
      nodes: [
        {
          id: 't1',
          name: 'Manual',
          type: 'n8n-nodes-base.manualTrigger',
          typeVersion: 1,
          position: [240, 300],
          parameters: {},
        },
        {
          id: 't2',
          name: 'Cron',
          type: 'n8n-nodes-base.scheduleTrigger',
          typeVersion: 1,
          position: [240, 500],
          parameters: { rule: { interval: [] } },
        },
        {
          id: 's1',
          name: 'Set',
          type: 'n8n-nodes-base.set',
          typeVersion: 3,
          position: [520, 300],
          parameters: { assignments: { assignments: [] } },
        },
      ],
      connections: {
        Manual: { main: [[{ node: 'Set', type: 'main', index: 0 }]] },
        Cron: { main: [[{ node: 'Set', type: 'main', index: 0 }]] },
      },
    };
    const { workflow, unmapped } = importN8nWorkflow(twoTriggers);
    expect(workflow.nodes.filter((n) => n.type === 'trigger')).toHaveLength(1);
    expect(unmapped.some((u) => u.reason.includes('multiple triggers'))).toBe(true);
  });

  it('maps wait → delay and noOp → pass-through set', () => {
    const { workflow } = importN8nWorkflow({
      name: 'Misc',
      nodes: [
        {
          id: 't',
          name: 'Manual',
          type: 'n8n-nodes-base.manualTrigger',
          typeVersion: 1,
          position: [0, 0],
          parameters: {},
        },
        {
          id: 'w',
          name: 'Wait',
          type: 'n8n-nodes-base.wait',
          typeVersion: 1,
          position: [0, 0],
          parameters: { amount: 2, unit: 'minutes' },
        },
        {
          id: 'n',
          name: 'No-op',
          type: 'n8n-nodes-base.noOp',
          typeVersion: 1,
          position: [0, 0],
          parameters: {},
        },
      ],
      connections: {
        Manual: { main: [[{ node: 'Wait', type: 'main', index: 0 }]] },
        Wait: { main: [[{ node: 'No-op', type: 'main', index: 0 }]] },
      },
    });
    const byName = Object.fromEntries(workflow.nodes.map((n) => [n.name, n]));
    expect(byName['Wait'].type).toBe('delay');
    expect(byName['Wait'].config).toMatchObject({ seconds: 120 });
    expect(byName['No-op'].type).toBe('set');
    expect(byName['No-op'].config).toMatchObject({ includeInput: true });
  });

  it('throws a clear error on malformed input', () => {
    expect(() => importN8nWorkflow(null)).toThrow(/must be an object/);
    expect(() => importN8nWorkflow({})).toThrow(/nodes\[\]/);
    expect(() => importN8nWorkflow({ nodes: 'nope' })).toThrow(/nodes\[\]/);
  });
});

describe('exportN8nWorkflow', () => {
  it('reverse-maps KriyaDot nodes to n8n format with branch outputs', () => {
    const def: WorkflowDefinition = {
      id: 'wf-1',
      name: 'Triage',
      nodes: [
        { id: 'trigger', type: 'trigger', name: 'Start', config: {} },
        { id: 'check', type: 'if', name: 'Big?', config: { condition: '{{input.n}} > 5' } },
        { id: 'yes', type: 'http', name: 'Call', config: { url: 'https://x.test', method: 'POST' } },
        { id: 'no', type: 'set', name: 'Mark', config: { assignments: { small: true } } },
        { id: 'calc', type: 'code', name: 'Calc', config: { code: 'return input;' } },
        { id: 'wait', type: 'delay', name: 'Wait', config: { seconds: 30 } },
        { id: 'review', type: 'approval', name: 'Review', config: { message: 'ok?' } },
      ],
      edges: [
        ['trigger', 'check'],
        ['check', 'yes', 'true'],
        ['check', 'no', 'false'],
        ['yes', 'calc'],
        ['no', 'calc'],
        ['calc', 'wait'],
        ['wait', 'review'],
      ],
    };
    const n8n = exportN8nWorkflow(def);
    expect(n8n.name).toBe('Triage');
    expect(n8n.nodes).toHaveLength(7);
    const byName = Object.fromEntries(n8n.nodes.map((n) => [n.name, n]));
    expect(byName['Start'].type).toBe('n8n-nodes-base.manualTrigger');
    expect(byName['Big?'].type).toBe('n8n-nodes-base.if');
    expect(byName['Call'].type).toBe('n8n-nodes-base.httpRequest');
    expect(byName['Mark'].type).toBe('n8n-nodes-base.set');
    expect(byName['Calc'].type).toBe('n8n-nodes-base.code');
    expect(byName['Wait'].type).toBe('n8n-nodes-base.wait');
    // approval has no n8n equivalent → code stub carrying the original config.
    expect(byName['Review'].type).toBe('n8n-nodes-base.code');
    expect(byName['Review'].parameters['jsCode']).toMatch(/approval/);

    const ifConns = n8n.connections['Big?']?.main;
    expect(ifConns).toHaveLength(2);
    expect(ifConns?.[0].map((t) => t.node)).toEqual(['Call']);
    expect(ifConns?.[1].map((t) => t.node)).toEqual(['Mark']);
    const startConns = n8n.connections['Start']?.main;
    expect(startConns?.[0].map((t) => t.node)).toEqual(['Big?']);
  });

  it('round-trips an import back through export without losing nodes', () => {
    const { workflow } = importN8nWorkflow(SAMPLE_N8N);
    const n8n = exportN8nWorkflow(workflow);
    const names = new Set(n8n.nodes.map((n) => n.name));
    for (const node of workflow.nodes) {
      expect(names.has(node.name)).toBe(true);
    }
  });
});
