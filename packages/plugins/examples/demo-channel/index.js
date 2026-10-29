// SPDX-License-Identifier: Apache-2.0
// Demo channel plugin (echo). Executable plugins are spawned per call and
// stateless, so the echo queue lives in a file inside the plugin directory:
// channel/send appends the message as a queued inbound echo; channel/poll
// drains the queue. This is the documented poll model for plugin channels.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const QUEUE = path.join(__dirname, '.echo-queue.jsonl');
let counter = 0;

function send(to, text) {
  const msg = {
    id: `echo-${Date.now()}-${counter++}`,
    from: 'echo',
    chatId: to,
    text: `echo: ${text}`,
    receivedAt: Date.now(),
  };
  fs.appendFileSync(QUEUE, JSON.stringify(msg) + '\n', 'utf8');
  return { ok: true, id: msg.id };
}

function poll() {
  let raw = '';
  try {
    raw = fs.readFileSync(QUEUE, 'utf8');
    fs.writeFileSync(QUEUE, '', 'utf8');
  } catch {
    return { messages: [] };
  }
  const messages = raw
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return { messages };
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
    if (req.method === 'channel/send') respond({ result: send(req.params.to, req.params.text) });
    else if (req.method === 'channel/poll') respond({ result: poll() });
    else respond({ error: { code: -32601, message: `method not found: ${req.method}` } });
  } catch (err) {
    respond({ error: { code: -32000, message: err instanceof Error ? err.message : String(err) } });
  }
});
