// SPDX-License-Identifier: Apache-2.0
/**
 * Recorded-run harness for the fix-a-bug demo (see ../RECORDED-RUN.md).
 *
 * What this does, honestly:
 *   - Copies ../cart.js + ../cart.test.mjs into a fresh scratch dir.
 *   - Runs ONE real AgentRuntime turn against that scratch workspace
 *     with the repo's MockProvider SCRIPTED to perform the demo flow
 *     (read the files -> run the failing tests -> write the fix ->
 *     re-run the tests -> claim completion). No live model, no network,
 *     no paid API: the "model" is a script, the runtime, tools,
 *     governance approvals and test executions are all real.
 *   - Governance: write_file / run_command raise real approval cards;
 *     this harness approves them (standing in for the human clicking
 *     Approve in the demo script) and logs each decision.
 *   - The bot has supervisorVerifyGate on with a `supervisor` purpose
 *     profile pointing at the mock model, so the completion claim is
 *     judged by the real verify-gate against the quoted tool evidence
 *     (the gate's verdict call is the script's final step).
 *   - After the turn, the harness independently re-runs `node --test`
 *     in the scratch dir, writes the patched file to ./cart.js, and
 *     prints a transcript to stdout (captured verbatim in
 *     ../RECORDED-RUN.md) plus ./transcript.txt.
 *
 * Run:  node examples/fix-a-bug/recorded/record-run.mjs   (from the repo root)
 */

import { execFile } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  AgentRuntime,
  MockProvider,
  createBuiltInTools,
} from '../../../packages/agent-runtime/dist/index.js';
import { GovernanceGateway, DEFAULT_POLICY } from '../../../packages/governance/dist/index.js';
import { GovernanceAdapter } from '../../../apps/api/dist/governance-adapter.js';

const execFileAsync = promisify(execFile);
const HERE = import.meta.dirname;
const DEMO_DIR = join(HERE, '..');

const FIXED_CART = `// SPDX-License-Identifier: Apache-2.0
// Demo project: a tiny cart module with one deliberate bug (see README).

/**
 * Total a cart.
 * items: [{ price, qty, discountPct? }] — discountPct is a percentage
 * off the WHOLE line (price * qty), per the pricing spec.
 */
export function cartTotal(items) {
  let total = 0;
  for (const item of items) {
    const line = item.price * item.qty;
    if (item.discountPct) {
      total += line - (line * item.discountPct) / 100;
    } else {
      total += line;
    }
  }
  return Math.round(total * 100) / 100;
}
`;

const lines = [];
function log(line = '') {
  lines.push(line);
  console.log(line);
}
function section(title) {
  log('');
  log(`## ${title}`);
  log('');
}

async function runTests(cwd) {
  try {
    const { stdout, stderr } = await execFileAsync('node', ['--test'], { cwd });
    return { code: 0, out: `${stdout}${stderr}`.trim() };
  } catch (err) {
    return { code: err.code ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}`.trim() };
  }
}

async function main() {
  const scratch = mkdtempSync(join(tmpdir(), 'kriyadot-fix-a-bug-'));
  copyFileSync(join(DEMO_DIR, 'cart.js'), join(scratch, 'cart.js'));
  copyFileSync(join(DEMO_DIR, 'cart.test.mjs'), join(scratch, 'cart.test.mjs'));

  log('# fix-a-bug recorded run — raw harness output');
  log('');
  log(`scratch workspace: ${scratch} (copy of examples/fix-a-bug/)`);
  log(`node: ${process.version}; platform: ${process.platform}/${process.arch}`);

  section('Step 0 — the demo project before the turn (node --test)');
  const before = await runTests(scratch);
  log('```');
  log(before.out);
  log('```');
  log(`exit code: ${before.code} (1 failing test expected)`);

  // The scripted "model": exactly the demo flow from ../README.md.
  const mock = new MockProvider([
    {
      content: 'I will read the module and its tests first.',
      toolCalls: [
        { id: 'call_1', name: 'read_file', args: { path: 'cart.js' } },
        { id: 'call_2', name: 'read_file', args: { path: 'cart.test.mjs' } },
      ],
    },
    {
      content: 'Now let me run the test suite to see the failure.',
      toolCalls: [{ id: 'call_3', name: 'run_command', args: { command: 'node --test' } }],
    },
    {
      content:
        'The bug is in the discounted branch: the discount is subtracted from a single unit and the remaining units are added at full price, so for qty > 1 only one unit is discounted. The discount must apply to the whole line. Fixing cart.js:',
      toolCalls: [{ id: 'call_4', name: 'write_file', args: { path: 'cart.js', content: FIXED_CART } }],
    },
    {
      content: 'Re-running the suite to verify the fix.',
      toolCalls: [{ id: 'call_5', name: 'run_command', args: { command: 'node --test' } }],
    },
    {
      content:
        'Fixed. The discount in cartTotal now applies to the whole line (price * qty). All 3 tests pass, including "discount applies to the whole line" (3 x $50 at 10% off = $135).',
    },
    // Supervisor verify-gate verdict call (gate is on for this bot).
    { content: '{"verdict":"accept","reason":"quoted run_command evidence shows the full suite passing after the write"}' },
  ]);

  class MockRuntime extends AgentRuntime {
    constructor(opts, provider) {
      super(opts);
      this.provider = provider;
    }
    resolveProvider() {
      return this.provider;
    }
  }

  const tools = new Map();
  for (const t of createBuiltInTools({ workspaceDir: scratch })) tools.set(t.name, t);
  const gateway = new GovernanceGateway({ dbPath: ':memory:', policy: DEFAULT_POLICY });
  const adapter = new GovernanceAdapter(gateway);
  const runtime = new MockRuntime(
    {
      dbPath: ':memory:',
      skillsDir: join(DEMO_DIR, '..', '..', 'seed', 'skills'),
      governance: adapter,
      toolRegistry: tools,
      modelProfiles: { supervisor: { modelId: 'mock-model' } },
    },
    mock,
  );

  const bot = {
    id: 'coder',
    name: 'Coder',
    description: 'Coding assistant (demo recording)',
    systemPrompt:
      'You are Coder, a pragmatic coding assistant working inside the workspace directory. Use read_file to inspect code, write_file to modify files, and run_command to run tests.',
    provider: 'mock',
    model: 'mock-model',
    skills: [],
    tools: ['read_file', 'write_file', 'run_command'],
    mcpServers: [],
    supervisorVerifyGate: true,
  };

  section('Step 1 — the turn (user message from the demo script)');
  log('> The cart tests are failing. Find the bug and fix it.');
  log('');
  log('Turn events (tokens assembled; tool/approval/notice events verbatim):');
  log('```');

  let assistantText = '';
  const turnPromise = runtime.runTurn({
    bot,
    message: 'The cart tests are failing. Find the bug and fix it.',
    onEvent: (e) => {
      if (e.type === 'token') {
        assistantText += e.content;
      } else if (e.type === 'tool_call') {
        if (assistantText.trim()) {
          log(`[assistant] ${assistantText.trim()}`);
          assistantText = '';
        }
        log(`[tool_call] ${e.call.name} ${JSON.stringify(e.call.args)}${e.approvalRequired ? ' (approval required)' : ''}`);
      } else if (e.type === 'tool_result') {
        const text = typeof e.result === 'string' ? e.result : JSON.stringify(e.result);
        log(`[tool_result] ${e.call.name}${e.denied ? ' DENIED' : ''}: ${text.length > 900 ? `${text.slice(0, 900)}... [truncated in transcript]` : text}`);
      } else if (e.type === 'approval_required') {
        log(`[approval_required] id=${e.approvalId} tool=${e.call.name} — harness (as the demo user) will approve`);
      } else if (e.type === 'notice') {
        log(`[notice:${e.kind}] ${e.message}`);
      } else if (e.type === 'error') {
        log(`[error] ${e.message}`);
      } else if (e.type === 'done') {
        if (assistantText.trim()) {
          log(`[assistant] ${assistantText.trim()}`);
          assistantText = '';
        }
        log(`[done] usage=${JSON.stringify(e.usage)}`);
      }
    },
  });
  // Approve governance cards as they appear (the human's role in the demo).
  const decided = new Set();
  const approver = setInterval(() => {
    for (const a of gateway.listApprovals('pending')) {
      if (decided.has(a.id)) continue;
      decided.add(a.id);
      log(`[approval] ${a.toolName} (${a.id}) -> approved by harness (demo user role)`);
      gateway.decide(a.id, 'approved', { decidedBy: 'recorded-demo-harness' });
    }
  }, 25);
  let usage;
  try {
    usage = await turnPromise;
  } finally {
    clearInterval(approver);
  }
  log('```');
  log(`turn usage: ${JSON.stringify(usage)}`);
  log(`provider calls made: ${mock.calls.length} (5 scripted turn steps + 1 supervisor verify-gate call)`);

  section('Step 2 — independent verification (harness re-runs node --test)');
  const after = await runTests(scratch);
  log('```');
  log(after.out);
  log('```');
  log(`exit code: ${after.code}`);

  const patched = readFileSync(join(scratch, 'cart.js'), 'utf8');
  writeFileSync(join(HERE, 'cart.js'), patched);
  log('');
  log('Patched cart.js copied to examples/fix-a-bug/recorded/cart.js');

  const original = readFileSync(join(DEMO_DIR, 'cart.js'), 'utf8');
  writeFileSync(join(HERE, 'cart.diff.txt'), '');
  try {
    const { stdout } = await execFileAsync('diff', ['-u', '--label', 'a/cart.js', '--label', 'b/cart.js', join(DEMO_DIR, 'cart.js'), join(HERE, 'cart.js')]);
    writeFileSync(join(HERE, 'cart.diff.txt'), stdout);
  } catch (err) {
    // diff exits 1 when files differ — that is the expected case here.
    if (typeof err.stdout === 'string' && err.stdout) writeFileSync(join(HERE, 'cart.diff.txt'), err.stdout);
  }
  log('Unified diff written to examples/fix-a-bug/recorded/cart.diff.txt');
  log(`original cart.js unchanged in examples/fix-a-bug/: ${original === readFileSync(join(DEMO_DIR, 'cart.js'), 'utf8')}`);

  writeFileSync(join(HERE, 'transcript.txt'), `${lines.join('\n')}\n`);
  if (after.code !== 0) {
    console.error('RECORDED RUN FAILED: tests still failing after the turn');
    process.exit(1);
  }
}

await main();
