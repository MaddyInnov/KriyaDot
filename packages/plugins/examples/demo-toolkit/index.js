// SPDX-License-Identifier: Apache-2.0
// Demo tool plugin: newline-delimited JSON-RPC 2.0 over stdio, zero deps.
// Methods: tools/list, tools/call.
'use strict';
const readline = require('node:readline');

const TOOLS = [
  {
    name: 'wordcount',
    description: 'Count the words in a text.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to count words in.' } },
      required: ['text'],
    },
  },
  {
    name: 'timestamp',
    description: 'Return the current Unix timestamp in milliseconds.',
    parameters: { type: 'object', properties: {} },
  },
];

function callTool(name, args) {
  if (name === 'wordcount') {
    const text = typeof args.text === 'string' ? args.text : '';
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    return { words, characters: text.length };
  }
  if (name === 'timestamp') return { now: Date.now() };
  throw new Error(`unknown tool: ${name}`);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  const respond = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, ...msg }) + '\n');
  try {
    if (req.method === 'tools/list') respond({ result: { tools: TOOLS } });
    else if (req.method === 'tools/call') respond({ result: callTool(req.params.name, req.params.args || {}) });
    else respond({ error: { code: -32601, message: `method not found: ${req.method}` } });
  } catch (err) {
    respond({ error: { code: -32000, message: err instanceof Error ? err.message : String(err) } });
  }
});
