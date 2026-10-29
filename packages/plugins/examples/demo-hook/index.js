// SPDX-License-Identifier: Apache-2.0
// Demo hook plugin: on turn.ending / tool.after, ask the runtime to inject
// a footer instruction (HookBus { inject } result). Other events: no result.
'use strict';
const readline = require('node:readline');

const FOOTER = 'Before finishing, append a one-line footer: "— via KriyaDot demo-hook plugin".';

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  const respond = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, ...msg }) + '\n');
  if (req.method !== 'hooks/invoke') {
    respond({ error: { code: -32601, message: `method not found: ${req.method}` } });
    return;
  }
  const event = req.params && req.params.event;
  if (event === 'turn.ending' || event === 'tool.after') respond({ result: { inject: FOOTER } });
  else respond({ result: null });
});
