// SPDX-License-Identifier: Apache-2.0
/**
 * KriyaDot task benchmark suite — task definitions + deterministic scorers.
 *
 * Each task is a single provider call (messages + optional tool
 * definitions) whose response is scored by a DETERMINISTIC scorer:
 * code tasks are executed in a node:vm sandbox and checked against
 * assertions, extraction tasks are JSON-parsed and field-compared,
 * instruction tasks are checked mechanically, and tool-use tasks are
 * scored on the exact tool call(s) returned. No scorer calls a model —
 * a score here is reproducible bit-for-bit for a given response.
 *
 * `mockScript` is the canned response the repo's MockProvider replays
 * for the task in mock mode. It is the KNOWN-GOOD answer: mock mode
 * validates the harness, the scorers and the reporting pipeline, and
 * its scores are NOT evidence about any real model's ability. Real
 * providers ignore `mockScript` and answer the prompt themselves.
 */

import vm from 'node:vm';

/** Extract the first fenced code block, or the trimmed raw text. */
function extractCode(text) {
  const fence = /```(?:js|javascript)?\n([\s\S]*?)```/.exec(text ?? '');
  return (fence ? fence[1] : (text ?? '')).trim();
}

/** Extract the first JSON value (object or array) from a response. */
function extractJson(text) {
  const fence = /```(?:json)?\n([\s\S]*?)```/.exec(text ?? '');
  const raw = (fence ? fence[1] : (text ?? '')).trim();
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.search(/[[{]/);
    if (start < 0) return null;
    for (let end = raw.length; end > start; end--) {
      try {
        return JSON.parse(raw.slice(start, end));
      } catch {
        // keep shrinking
      }
    }
    return null;
  }
}

/**
 * Score a code-fix task: evaluate the returned function in a sandbox
 * and run the assertions. Score = assertions passed / total.
 */
function scoreCode(entryPoint, assertions, opts = {}) {
  return (response) => {
    const code = extractCode(response.content);
    let fn;
    try {
      fn = vm.runInNewContext(`${code}\n;${entryPoint};`, vm.createContext({}), { timeout: 1000 });
    } catch (err) {
      return { score: 0, detail: `code did not evaluate: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (typeof fn !== 'function') return { score: 0, detail: `${entryPoint} is not a function in the returned code` };
    let passed = 0;
    const failures = [];
    for (const [input, expected] of assertions) {
      try {
        const arg = structuredClone(input);
        const got = opts.spreadArgs ? fn(...arg) : fn(arg);
        if (JSON.stringify(got) === JSON.stringify(expected)) passed++;
        else failures.push(`input ${JSON.stringify(input)} -> ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
      } catch (err) {
        failures.push(`input ${JSON.stringify(input)} threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return {
      score: passed / assertions.length,
      detail: failures.length ? failures.join('; ') : `all ${assertions.length} assertions passed`,
    };
  };
}

/** Score a JSON-extraction task field-by-field (exact matches only). */
function scoreFields(expected) {
  const keys = Object.keys(expected);
  return (response) => {
    const got = extractJson(response.content);
    if (got === null || typeof got !== 'object' || Array.isArray(got)) {
      return { score: 0, detail: 'response contained no parseable JSON object' };
    }
    let passed = 0;
    const failures = [];
    for (const key of keys) {
      if (JSON.stringify(got[key]) === JSON.stringify(expected[key])) passed++;
      else failures.push(`${key}: got ${JSON.stringify(got[key])}, expected ${JSON.stringify(expected[key])}`);
    }
    return { score: passed / keys.length, detail: failures.length ? failures.join('; ') : `all ${keys.length} fields exact` };
  };
}

const READ_FILE_TOOL = {
  name: 'read_file',
  description: 'Read a file from the workspace.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Workspace-relative file path.' } },
    required: ['path'],
    additionalProperties: false,
  },
};
const RUN_COMMAND_TOOL = {
  name: 'run_command',
  description: 'Run a shell command in the workspace.',
  parameters: {
    type: 'object',
    properties: { command: { type: 'string' } },
    required: ['command'],
    additionalProperties: false,
  },
};
const DELETE_FILE_TOOL = {
  name: 'delete_file',
  description: 'Permanently delete a file from the workspace.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  },
};

export const TASKS = [
  {
    id: 'fix-bug-cart-discount',
    category: 'fix-the-bug',
    description: 'Fix cartTotal so a percentage discount applies to the whole line (price * qty). Scorer executes the returned function against 4 assertions.',
    prompt:
      'The function below has a bug: for qty > 1 the discount is applied to only one unit instead of the whole line. ' +
      'Return the corrected function in a single ```js code block, keeping the name cartTotal and the same signature.\n\n' +
      '```js\n' +
      'function cartTotal(items) {\n' +
      '  let total = 0;\n' +
      '  for (const item of items) {\n' +
      '    if (item.discountPct) {\n' +
      '      const discountedUnit = item.price - (item.price * item.discountPct) / 100;\n' +
      '      total += discountedUnit + item.price * (item.qty - 1);\n' +
      '    } else {\n' +
      '      total += item.price * item.qty;\n' +
      '    }\n' +
      '  }\n' +
      '  return Math.round(total * 100) / 100;\n' +
      '}\n```',
    tools: [],
    score: scoreCode('cartTotal', [
      [[{ price: 50, qty: 3, discountPct: 10 }], 135],
      [[{ price: 10, qty: 2 }, { price: 5, qty: 1 }], 25],
      [[{ price: 80, qty: 1, discountPct: 25 }], 60],
      [[{ price: 20, qty: 4, discountPct: 50 }, { price: 3, qty: 3 }], 49],
    ]),
    mockScript: [
      {
        content:
          'The discount must be computed on the whole line:\n\n```js\n' +
          'function cartTotal(items) {\n' +
          '  let total = 0;\n' +
          '  for (const item of items) {\n' +
          '    const line = item.price * item.qty;\n' +
          '    total += item.discountPct ? line - (line * item.discountPct) / 100 : line;\n' +
          '  }\n' +
          '  return Math.round(total * 100) / 100;\n' +
          '}\n```',
      },
    ],
  },
  {
    id: 'fix-bug-clamp-range',
    category: 'fix-the-bug',
    description: 'Fix clamp so values are bounded to [min, max] inclusively. Scorer executes the returned function against 5 assertions.',
    prompt:
      'The function below has a bug: it returns max when the value is below min and min when the value is above max (the bounds are swapped). ' +
      'Return the corrected function in a single ```js code block, keeping the name clamp and the same signature.\n\n' +
      '```js\n' +
      'function clamp(value, min, max) {\n' +
      '  if (value < min) return max;\n' +
      '  if (value > max) return min;\n' +
      '  return value;\n' +
      '}\n```',
    tools: [],
    score: scoreCode('clamp', [
      [[5, 0, 10], 5],
      [[-3, 0, 10], 0],
      [[42, 0, 10], 10],
      [[0, 0, 10], 0],
      [[10, 0, 10], 10],
    ], { spreadArgs: true }),
    mockScript: [
      {
        content:
          '```js\n' +
          'function clamp(value, min, max) {\n' +
          '  if (value < min) return min;\n' +
          '  if (value > max) return max;\n' +
          '  return value;\n' +
          '}\n```',
      },
    ],
  },
  {
    id: 'extract-invoice-fields',
    category: 'extract-values',
    description: 'Extract 5 fields from an invoice email into a JSON object. Scorer compares each field exactly.',
    prompt:
      'Extract the invoice details from the text below. Reply with ONLY a JSON object with exactly these keys: ' +
      '"vendor" (string), "invoiceNumber" (string), "totalUsd" (number), "dueDate" (string, YYYY-MM-DD), "itemCount" (number).\n\n' +
      'Text: "Invoice INV-2041 from Northwind Traders. Items: 3 line items. Total due: $1,250.00 USD. Please pay by 2026-11-15."',
    tools: [],
    score: scoreFields({
      vendor: 'Northwind Traders',
      invoiceNumber: 'INV-2041',
      totalUsd: 1250,
      dueDate: '2026-11-15',
      itemCount: 3,
    }),
    mockScript: [
      {
        content: '{"vendor":"Northwind Traders","invoiceNumber":"INV-2041","totalUsd":1250,"dueDate":"2026-11-15","itemCount":3}',
      },
    ],
  },
  {
    id: 'extract-event-dates',
    category: 'extract-values',
    description: 'Extract 4 fields (event name, ISO start date, city, attendee count) from an event announcement.',
    prompt:
      'Extract the event details from the text below. Reply with ONLY a JSON object with exactly these keys: ' +
      '"event" (string), "date" (string, YYYY-MM-DD), "city" (string), "attendees" (number).\n\n' +
      'Text: "Join us for DevSummit on March 3, 2027 in Bengaluru. Last year 450 attendees joined; this year we expect the same hall." ' +
      'For "attendees", use the number the text states for last year.',
    tools: [],
    score: scoreFields({ event: 'DevSummit', date: '2027-03-03', city: 'Bengaluru', attendees: 450 }),
    mockScript: [{ content: '{"event":"DevSummit","date":"2027-03-03","city":"Bengaluru","attendees":450}' }],
  },
  {
    id: 'follow-json-only',
    category: 'follow-instructions',
    description: 'Reply with ONLY a JSON object {"status":"ok","count":3} — no prose, no code fence. Scorer: strict equality of the trimmed response (0.5 for parseable-but-wrapped).',
    prompt: 'Reply with ONLY this JSON object and nothing else — no prose, no code fences: {"status":"ok","count":3}',
    tools: [],
    score: (response) => {
      const raw = (response.content ?? '').trim();
      if (raw === '{"status":"ok","count":3}') return { score: 1, detail: 'exact JSON-only reply' };
      const parsed = extractJson(raw);
      if (parsed && parsed.status === 'ok' && parsed.count === 3) {
        return { score: 0.5, detail: 'JSON value correct but wrapped in prose/fences' };
      }
      return { score: 0, detail: `reply was not the required JSON object: ${raw.slice(0, 80)}` };
    },
    mockScript: [{ content: '{"status":"ok","count":3}' }],
  },
  {
    id: 'follow-three-bullets',
    category: 'follow-instructions',
    description: 'Reply with exactly 3 markdown bullet lines starting with "- ", nothing else. Scorer counts lines and bullet prefixes.',
    prompt:
      'List three benefits of unit tests. Format: exactly 3 lines, each starting with "- ", and no other text before or after the list.',
    tools: [],
    score: (response) => {
      const lines = (response.content ?? '').trim().split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
      const bullets = lines.filter((l) => l.startsWith('- ')).length;
      let score = 0;
      if (lines.length === 3) score += 0.5;
      if (bullets === 3) score += 0.5;
      return { score, detail: `${lines.length} non-empty line(s), ${bullets} bullet line(s); need exactly 3 of each` };
    },
    mockScript: [
      {
        content: '- They catch regressions before release.\n- They document how code is expected to behave.\n- They make refactoring safer.',
      },
    ],
  },
  {
    id: 'tool-use-read-file',
    category: 'tool-use',
    description: 'The user asks what a file contains; the only correct move is one read_file call for that exact path. Calling delete_file scores 0.',
    prompt: 'What does the file notes/plan.md contain? Use the available tools to find out.',
    tools: [READ_FILE_TOOL, RUN_COMMAND_TOOL, DELETE_FILE_TOOL],
    score: (response) => {
      const calls = response.toolCalls ?? [];
      if (calls.some((c) => c.name === 'delete_file')) return { score: 0, detail: 'called delete_file — destructive and unrequested' };
      const reads = calls.filter((c) => c.name === 'read_file');
      if (reads.length === 1 && reads[0].args?.path === 'notes/plan.md') {
        return { score: 1, detail: 'exactly one read_file call for notes/plan.md' };
      }
      if (reads.length >= 1) return { score: 0.5, detail: `read_file called but path/args wrong: ${JSON.stringify(calls)}` };
      return { score: 0, detail: `no read_file call made (calls: ${calls.map((c) => c.name).join(', ') || 'none'})` };
    },
    mockScript: [{ toolCalls: [{ id: 'bench-call-1', name: 'read_file', args: { path: 'notes/plan.md' } }] }],
  },
  {
    id: 'tool-use-answer-directly',
    category: 'tool-use',
    description: 'A question answerable from the prompt alone; tools are available but must NOT be called. Scorer: 1 only for a tool-free reply containing the answer.',
    prompt: 'What is 17 + 25? Answer directly in one short sentence. You do not need any tool for this.',
    tools: [READ_FILE_TOOL, RUN_COMMAND_TOOL, DELETE_FILE_TOOL],
    score: (response) => {
      const calls = response.toolCalls ?? [];
      if (calls.length > 0) return { score: 0, detail: `called tool(s) unnecessarily: ${calls.map((c) => c.name).join(', ')}` };
      if (/\b42\b/.test(response.content ?? '')) return { score: 1, detail: 'answered 42 directly, no tool calls' };
      return { score: 0, detail: 'no tool calls, but the answer 42 is missing' };
    },
    mockScript: [{ content: '17 + 25 is 42.' }],
  },
];
