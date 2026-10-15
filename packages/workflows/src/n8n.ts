// SPDX-License-Identifier: Apache-2.0

/**
 * n8n workflow interchange for the MVP workflow engine.
 *
 * - `importN8nWorkflow` parses a standard n8n workflow export JSON
 *   (`nodes[]` with type/typeVersion/parameters/position, `connections{}`)
 *   into a KriyaDot `WorkflowDefinition`. Common n8n nodes map best-effort;
 *   anything without a mapping becomes a `code` placeholder node that fails
 *   loudly at runtime AND is listed in the returned `unmapped` report — the
 *   import itself never fails because of an unknown node.
 * - `exportN8nWorkflow` performs the best-effort reverse mapping.
 *
 * Both directions are intentionally lossy (documented per node below); the
 * goal is a working starting point, not a perfect round-trip. n8n template
 * expressions (`={{$json.x}}`, `$node["X"].json`, …) reference n8n's item
 * model and are carried over as literals where no KriyaDot equivalent exists —
 * they need manual conversion after import.
 */

import { randomUUID } from 'node:crypto';
import type {
  EdgeBranch,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
} from './types.js';

// -- n8n JSON shapes ----------------------------------------------------------

export interface N8nNodeJson {
  id: string;
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
  parameters: Record<string, unknown>;
  webhookId?: string;
  disabled?: boolean;
  notes?: string;
  [key: string]: unknown;
}

export interface N8nConnectionTarget {
  node: string;
  type: string;
  index: number;
}

export interface N8nWorkflowJson {
  name: string;
  nodes: N8nNodeJson[];
  connections: Record<string, { main?: N8nConnectionTarget[][] } | N8nConnectionTarget[][][]>;
  active?: boolean;
  [key: string]: unknown;
}

export interface UnmappedN8nNode {
  n8nType: string;
  name: string;
  reason: string;
}

export interface N8nImportResult {
  workflow: WorkflowDefinition;
  unmapped: UnmappedN8nNode[];
}

// -- small helpers ------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || `node-${randomUUID().slice(0, 8)}`;
}

/** Strip n8n's `={{…}}` expression wrapper; returns { expression, isExpression }. */
function splitN8nExpression(value: unknown): { text: string; isExpression: boolean } {
  if (typeof value !== 'string') return { text: '', isExpression: false };
  const m = /^\s*=\{\{([\s\S]*)\}\}\s*$/.exec(value);
  if (m) return { text: m[1].trim(), isExpression: true };
  return { text: value, isExpression: false };
}

/**
 * Best-effort rewrite of n8n expression references to the KriyaDot template
 * model (`input` = run input ≈ n8n `$json` of the trigger item).
 * `$json.foo` → `input.foo`; anything else is left for manual conversion.
 */
function convertN8nExpression(expr: string): string {
  return expr.replace(/\$json\b/g, 'input');
}

/** Format an n8n condition value as a JS literal/expression for an `if` node. */
function formatConditionValue(value: unknown): string {
  const { text, isExpression } = splitN8nExpression(value);
  if (isExpression) return `(${convertN8nExpression(text)})`;
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return 'null';
  return JSON.stringify(value);
}

const N8N_OPERATORS: Record<string, (l: string, r: string) => string> = {
  equals: (l, r) => `${l} === ${r}`,
  notEquals: (l, r) => `${l} !== ${r}`,
  larger: (l, r) => `${l} > ${r}`,
  largerEqual: (l, r) => `${l} >= ${r}`,
  smaller: (l, r) => `${l} < ${r}`,
  smallerEqual: (l, r) => `${l} <= ${r}`,
  contains: (l, r) => `String(${l} ?? '').includes(String(${r} ?? ''))`,
  notContains: (l, r) => `!String(${l} ?? '').includes(String(${r} ?? ''))`,
  startsWith: (l, r) => `String(${l} ?? '').startsWith(String(${r} ?? ''))`,
  endsWith: (l, r) => `String(${l} ?? '').endsWith(String(${r} ?? ''))`,
  isEmpty: (l) => `(${l} === null || ${l} === undefined || ${l} === '')`,
  isNotEmpty: (l) => `!((${l} === null || ${l} === undefined || ${l} === ''))`,
  isTrue: (l) => `${l} === true`,
  isFalse: (l) => `${l} === false`,
};

/**
 * Compile n8n IF `parameters.conditions` (v1 `{conditions[], combineOperation}`
 * or v2 `{conditions[], combinator}`) into a KriyaDot `if` condition expression.
 */
function compileN8nConditions(parameters: Record<string, unknown>): string {
  const raw = asRecord(parameters['conditions']);
  // v1 nests under conditions.conditions; v2 keeps the list at conditions.conditions too.
  const list = Array.isArray(raw['conditions']) ? (raw['conditions'] as unknown[]) : [];
  const combineRaw =
    typeof parameters['combineOperation'] === 'string'
      ? parameters['combineOperation']
      : typeof raw['combinator'] === 'string'
        ? raw['combinator']
        : 'and';
  const joiner = /^(any|or)$/i.test(String(combineRaw)) ? ' || ' : ' && ';
  const parts: string[] = [];
  for (const item of list) {
    const cond = asRecord(item);
    const left = formatConditionValue(cond['leftValue']);
    const right = formatConditionValue(cond['rightValue']);
    const opRaw = asRecord(cond['operator']);
    const operation = asString(opRaw['operation']) || asString(cond['operation']) || 'equals';
    const fn = N8N_OPERATORS[operation];
    parts.push(
      fn
        ? `(${fn(left, right)})`
        : `/* n8n operator "${operation}" has no KriyaDot equivalent — review manually */ (false)`,
    );
  }
  if (parts.length === 0) return 'true /* n8n IF had no parseable conditions */';
  return parts.join(joiner);
}

// -- import -------------------------------------------------------------------

interface MappedNode {
  node: WorkflowNode;
  unmapped?: UnmappedN8nNode;
  drop?: boolean;
}

function unmappedPlaceholder(n8nNode: N8nNodeJson, reason: string): MappedNode {
  const id = n8nNode.id || slugify(n8nNode.name);
  return {
    node: {
      id,
      type: 'code',
      name: `${n8nNode.name} (unmapped)`,
      config: {
        code: `throw new Error(${JSON.stringify(
          `n8n node "${n8nNode.name}" (${n8nNode.type}) has no KriyaDot mapping — replace this node manually`,
        )});`,
      },
    },
    unmapped: { n8nType: n8nNode.type, name: n8nNode.name, reason },
  };
}

function mapN8nNode(n: N8nNodeJson): MappedNode {
  const id = n.id || slugify(n.name);
  const params = asRecord(n.parameters);
  const base = { id, name: n.name, config: {} as Record<string, unknown> };

  switch (n.type) {
    // -- triggers ---------------------------------------------------------
    case 'n8n-nodes-base.webhook':
      return {
        node: {
          ...base,
          type: 'trigger',
          config: {
            triggerKind: 'webhook',
            path: asString(params['path']),
            httpMethod: asString(params['httpMethod']) || 'GET',
            webhookId: n.webhookId ?? '',
          },
        },
      };
    case 'n8n-nodes-base.scheduleTrigger':
      return {
        node: {
          ...base,
          type: 'trigger',
          config: { triggerKind: 'schedule', rule: params['rule'] ?? {} },
        },
      };
    case 'n8n-nodes-base.manualTrigger':
    case 'n8n-nodes-base.executeWorkflowTrigger':
      return { node: { ...base, type: 'trigger', config: { triggerKind: 'manual' } } };

    // -- core nodes --------------------------------------------------------
    case 'n8n-nodes-base.httpRequest': {
      const headers: Record<string, string> = {};
      const headerParams = asRecord(params['headerParameters'])['parameters'];
      if (Array.isArray(headerParams)) {
        for (const h of headerParams) {
          const rec = asRecord(h);
          if (typeof rec['name'] === 'string') headers[rec['name']] = asString(rec['value']);
        }
      }
      let body: unknown;
      if (params['sendBody'] === true) {
        if (params['specifyBody'] === 'json' || params['jsonBody'] !== undefined) {
          body = params['jsonBody'];
        } else {
          const bodyParams = asRecord(params['bodyParameters'])['parameters'];
          if (Array.isArray(bodyParams)) {
            const obj: Record<string, unknown> = {};
            for (const b of bodyParams) {
              const rec = asRecord(b);
              if (typeof rec['name'] === 'string') obj[rec['name']] = rec['value'];
            }
            body = obj;
          }
        }
      }
      const config: Record<string, unknown> = {
        url: asString(params['url']),
        method: asString(params['method']) || 'GET',
      };
      if (Object.keys(headers).length > 0) config['headers'] = headers;
      if (body !== undefined) config['body'] = body;
      return { node: { ...base, type: 'http', config } };
    }

    case 'n8n-nodes-base.set': {
      const assignments: Record<string, unknown> = {};
      const list = asRecord(params['assignments'])['assignments'];
      if (Array.isArray(list)) {
        for (const a of list) {
          const rec = asRecord(a);
          if (typeof rec['name'] === 'string') assignments[rec['name']] = rec['value'];
        }
      }
      return {
        node: {
          ...base,
          type: 'set',
          config: { assignments, includeInput: params['keepOnlySet'] !== true },
        },
      };
    }

    case 'n8n-nodes-base.if':
      return {
        node: {
          ...base,
          type: 'if',
          config: { condition: compileN8nConditions(params) },
        },
      };

    case 'n8n-nodes-base.code':
      return {
        node: {
          ...base,
          type: 'code',
          config: { code: asString(params['jsCode']) || '// (empty n8n Code node)\nreturn input;' },
        },
      };

    case 'n8n-nodes-base.function':
    case 'n8n-nodes-base.functionItem':
      return {
        node: {
          ...base,
          type: 'code',
          config: {
            code: asString(params['functionCode']) || '// (empty n8n Function node)\nreturn input;',
          },
        },
      };

    case 'n8n-nodes-base.wait': {
      const amount = Number(params['amount'] ?? 0);
      const unit = asString(params['unit']) || 'seconds';
      const factor =
        unit === 'minutes' ? 60 : unit === 'hours' ? 3600 : unit === 'days' ? 86400 : 1;
      return {
        node: { ...base, type: 'delay', config: { seconds: Math.max(0, amount * factor) } },
      };
    }

    case 'n8n-nodes-base.noOp':
      // Pass-through: output = input.
      return { node: { ...base, type: 'set', config: { assignments: {}, includeInput: true } } };

    // -- agent / tool passthrough -------------------------------------------
    case '@n8n/n8n-nodes-langchain.agent':
      return {
        node: {
          ...base,
          type: 'agent',
          config: {
            // No KriyaDot bot id can be derived from n8n — wire one up manually.
            botId: '',
            prompt: asString(asRecord(params['options'])['systemMessage']) || asString(params['prompt']),
          },
        },
      };

    // -- annotations ---------------------------------------------------------
    case 'n8n-nodes-base.stickyNote':
      return {
        node: { ...base, type: 'set', name: n.name, config: { assignments: {}, includeInput: true } },
        unmapped: {
          n8nType: n.type,
          name: n.name,
          reason: 'non-executable annotation node (dropped from the graph)',
        },
        drop: true,
      };

    default:
      // LangChain tool nodes → tool passthrough where sensible.
      if (n.type.startsWith('@n8n/n8n-nodes-langchain.tool')) {
        return {
          node: {
            ...base,
            type: 'tool',
            config: { tool: n.type.replace('@n8n/n8n-nodes-langchain.tool', '').replace(/^\./, '') || n.type, args: params },
          },
        };
      }
      return unmappedPlaceholder(n, 'no KriyaDot node mapping (imported as a failing code placeholder)');
  }
}

function parseN8nWorkflow(input: unknown): N8nWorkflowJson {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('import: n8n JSON must be an object with nodes[] and connections{}');
  }
  const obj = input as Record<string, unknown>;
  if (!Array.isArray(obj['nodes'])) {
    throw new Error('import: n8n JSON must contain a nodes[] array');
  }
  const nodes: N8nNodeJson[] = (obj['nodes'] as unknown[]).map((raw, i) => {
    const rec = asRecord(raw);
    return {
      id: asString(rec['id']) || `n8n-node-${i}`,
      name: asString(rec['name']) || `Node ${i + 1}`,
      type: asString(rec['type']),
      typeVersion: Number(rec['typeVersion'] ?? 1),
      position: (Array.isArray(rec['position']) ? rec['position'] : [0, 0]) as [number, number],
      parameters: asRecord(rec['parameters']),
      ...(typeof rec['webhookId'] === 'string' ? { webhookId: rec['webhookId'] } : {}),
      ...(rec['disabled'] === true ? { disabled: true } : {}),
    };
  });
  return {
    name: asString(obj['name']) || 'Imported n8n workflow',
    nodes,
    connections: asRecord(obj['connections']) as N8nWorkflowJson['connections'],
    ...(typeof obj['active'] === 'boolean' ? { active: obj['active'] } : {}),
  };
}

/**
 * Import a standard n8n workflow export into a KriyaDot WorkflowDefinition.
 * Never fails on unknown nodes — they become loud `code` placeholders and
 * are listed in `unmapped`.
 */
export function importN8nWorkflow(n8nJson: unknown): N8nImportResult {
  const parsed = parseN8nWorkflow(n8nJson);
  const unmapped: UnmappedN8nNode[] = [];
  const nodes: WorkflowNode[] = [];
  const nameToId = new Map<string, string>();
  const droppedIds = new Set<string>();
  const triggerIds: string[] = [];

  for (const n8nNode of parsed.nodes) {
    const mapped = mapN8nNode(n8nNode);
    if (mapped.unmapped) unmapped.push(mapped.unmapped);
    if (mapped.drop) {
      droppedIds.add(mapped.node.id);
      continue;
    }
    nodes.push(mapped.node);
    nameToId.set(n8nNode.name, mapped.node.id);
    if (mapped.node.type === 'trigger') triggerIds.push(mapped.node.id);
  }

  // KriyaDot requires exactly one trigger. Extra triggers become placeholders
  // (edges preserved); a missing trigger is synthesized.
  const triggerNodes = nodes.filter((n) => n.type === 'trigger');
  if (triggerNodes.length > 1) {
    for (const extra of triggerNodes.slice(1)) {
      const idx = nodes.findIndex((n) => n.id === extra.id);
      const placeholder = unmappedPlaceholder(
        {
          id: extra.id,
          name: extra.name,
          type: 'n8n-nodes-base.trigger(extra)',
          typeVersion: 1,
          position: [0, 0],
          parameters: extra.config,
        },
        'workflow has multiple triggers — only the first is kept as the trigger (KriyaDot supports exactly one)',
      );
      nodes[idx] = placeholder.node;
      if (placeholder.unmapped) unmapped.push(placeholder.unmapped);
    }
  }

  // Edges from n8n connections (keyed by SOURCE node name).
  const edges: WorkflowEdge[] = [];
  const seenEdges = new Set<string>();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const [srcName, rawOutputs] of Object.entries(parsed.connections)) {
    const fromId = nameToId.get(srcName);
    if (!fromId || droppedIds.has(fromId)) continue;
    const fromNode = byId.get(fromId);
    const isIf = fromNode?.type === 'if';
    // Object form: { main: [[targets],[targets]] } (outer index = output
    // index; 0 = true, 1 = false for IF). Tolerate the legacy array form.
    const mainRaw: unknown = Array.isArray(rawOutputs)
      ? rawOutputs
      : (rawOutputs as { main?: unknown })?.main ?? [];
    const outputs: N8nConnectionTarget[][] = [];
    for (const entry of mainRaw as unknown[]) {
      if (!Array.isArray(entry)) continue;
      // entry is either [targets] (one output) or [[t],[t]] (flattened two
      // outputs) — normalize by checking the first element.
      if (entry.length > 0 && Array.isArray(entry[0])) {
        for (const inner of entry as unknown[]) {
          if (Array.isArray(inner)) outputs.push(inner as N8nConnectionTarget[]);
        }
      } else {
        outputs.push(entry as N8nConnectionTarget[]);
      }
    }
    outputs.forEach((targets, outputIndex) => {
      for (const target of targets ?? []) {
        const toId = nameToId.get(target.node);
        if (!toId || toId === fromId || droppedIds.has(toId)) continue;
        let edge: WorkflowEdge = [fromId, toId];
        if (isIf) {
          const branch: EdgeBranch = outputIndex === 1 ? 'false' : 'true';
          edge = [fromId, toId, branch];
        }
        const key = `${fromId}→${toId}:${edge[2] ?? ''}`;
        if (seenEdges.has(key)) continue;
        seenEdges.add(key);
        edges.push(edge);
      }
    });
  }

  // No trigger mapped → synthesize one feeding the source nodes.
  const hasTrigger = nodes.some((n) => n.type === 'trigger');
  if (!hasTrigger) {
    const triggerId = 'trigger';
    const hasIncoming = new Set(edges.map(([, to]) => to));
    const sources = nodes.map((n) => n.id).filter((id) => !hasIncoming.has(id));
    nodes.unshift({ id: triggerId, type: 'trigger', name: 'Imported trigger', config: { triggerKind: 'manual' } });
    for (const src of sources) {
      edges.unshift([triggerId, src]);
    }
  }

  return {
    workflow: {
      id: `n8n-import-${randomUUID().slice(0, 8)}`,
      name: parsed.name,
      description: `Imported from n8n (${parsed.nodes.length} nodes, ${unmapped.length} unmapped). n8n expressions need manual conversion.`,
      nodes,
      edges,
    },
    unmapped,
  };
}

// -- export -------------------------------------------------------------------

function kriyadotNodeToN8n(node: WorkflowNode, position: [number, number]): N8nNodeJson {
  const config = asRecord(node.config);
  const base = {
    id: node.id,
    name: node.name,
    position,
    notes: undefined as string | undefined,
  };
  switch (node.type) {
    case 'trigger': {
      const kind = asString(config['triggerKind']);
      if (kind === 'webhook') {
        return {
          ...base,
          type: 'n8n-nodes-base.webhook',
          typeVersion: 2,
          parameters: {
            httpMethod: asString(config['httpMethod']) || 'GET',
            path: asString(config['path']),
            responseMode: 'responseNode',
            options: {},
          },
        };
      }
      return {
        ...base,
        type: 'n8n-nodes-base.manualTrigger',
        typeVersion: 1,
        parameters: {},
      };
    }
    case 'http': {
      const headers = asRecord(config['headers']);
      return {
        ...base,
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4,
        parameters: {
          url: asString(config['url']),
          method: asString(config['method']) || 'GET',
          ...(Object.keys(headers).length > 0
            ? {
                sendHeaders: true,
                headerParameters: {
                  parameters: Object.entries(headers).map(([name, value]) => ({ name, value })),
                },
              }
            : {}),
          ...(config['body'] !== undefined
            ? { sendBody: true, specifyBody: 'json', jsonBody: JSON.stringify(config['body']) }
            : {}),
          options: {},
        },
      };
    }
    case 'set': {
      const assignments = asRecord(config['assignments']);
      return {
        ...base,
        type: 'n8n-nodes-base.set',
        typeVersion: 3,
        parameters: {
          assignments: {
            assignments: Object.entries(assignments).map(([name, value]) => ({
              id: randomUUID(),
              name,
              type: typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string',
              value: typeof value === 'string' ? value : JSON.stringify(value),
            })),
          },
          includeOtherFields: config['includeInput'] === true,
          options: {},
        },
      };
    }
    case 'if': {
      const condition = asString(config['condition']);
      return {
        ...base,
        type: 'n8n-nodes-base.if',
        typeVersion: 2,
        notes: `KriyaDot condition (convert manually): ${condition}`,
        parameters: {
          conditions: {
            options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
            conditions: [
              {
                id: randomUUID(),
                leftValue: `={{ /* kriyadot: ${condition.slice(0, 200)} */ true }}`,
                rightValue: '',
                operator: { type: 'boolean', operation: 'true', name: 'filter.operator.boolean.true' },
              },
            ],
            combinator: 'and',
          },
          options: {},
        },
      };
    }
    case 'code':
      return {
        ...base,
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        parameters: { mode: 'runOnceForAllItems', jsCode: asString(config['code']) },
      };
    case 'delay': {
      const seconds = Number(config['seconds'] ?? 0);
      return {
        ...base,
        type: 'n8n-nodes-base.wait',
        typeVersion: 1,
        parameters: { amount: Number.isFinite(seconds) ? Math.max(0, seconds) : 0, unit: 'seconds' },
      };
    }
    default: {
      // agent / tool / approval have no direct n8n equivalent — emit a Code
      // node carrying the original config as a comment for manual conversion.
      const note = `KriyaDot '${node.type}' node "${node.name}" — no direct n8n equivalent; convert manually.`;
      return {
        ...base,
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        notes: note,
        parameters: {
          mode: 'runOnceForAllItems',
          jsCode: `// ${note}\n// Original KriyaDot config:\n// ${JSON.stringify(config, null, 2).split('\n').join('\n// ')}\nthrow new Error(${JSON.stringify(note)});`,
        },
      };
    }
  }
}

/**
 * Best-effort reverse mapping: KriyaDot definition → n8n-format JSON.
 * Nodes without an n8n equivalent (agent/tool/approval) become Code nodes
 * carrying the original config as comments — loud, not silent.
 */
export function exportN8nWorkflow(def: WorkflowDefinition): N8nWorkflowJson {
  const nodes: N8nNodeJson[] = def.nodes.map((node, i) =>
    kriyadotNodeToN8n(node, [(i % 4) * 280 + 240, Math.floor(i / 4) * 180 + 120]),
  );
  const nameById = new Map(def.nodes.map((n) => [n.id, n.name]));
  const typeById = new Map(def.nodes.map((n) => [n.id, n.type]));
  const connections: N8nWorkflowJson['connections'] = {};

  const outgoing = new Map<string, WorkflowEdge[]>();
  for (const edge of def.edges) {
    const list = outgoing.get(edge[0]) ?? [];
    list.push(edge);
    outgoing.set(edge[0], list);
  }
  for (const [fromId, list] of outgoing) {
    const srcName = nameById.get(fromId);
    if (!srcName) continue;
    const isIf = typeById.get(fromId) === 'if';
    const main: N8nConnectionTarget[][] = isIf ? [[], []] : [[]];
    for (const edge of list) {
      const [, toId, branch] = edge;
      const dstName = nameById.get(toId);
      if (!dstName) continue;
      const target = { node: dstName, type: 'main', index: 0 };
      if (isIf) {
        main[branch === 'false' ? 1 : 0].push(target);
      } else {
        main[0].push(target);
      }
    }
    connections[srcName] = { main };
  }

  return {
    name: def.name,
    nodes,
    connections,
    active: false,
  };
}
