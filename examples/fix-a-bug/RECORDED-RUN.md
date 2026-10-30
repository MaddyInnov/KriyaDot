<!-- SPDX-License-Identifier: Apache-2.0 -->

# fix-a-bug — recorded run

This is a **captured run** of the demo in this folder, shipped so the
demo can be evaluated without running anything live.

## How this recording was captured (read this first)

- Harness: `recorded/record-run.mjs` (shipped alongside this file, so
  the recording is reproducible).
- It copies `cart.js` + `cart.test.mjs` into a fresh scratch directory
  and runs **one real `AgentRuntime` turn** against that workspace,
  using the built `dist/` of `packages/agent-runtime`,
  `packages/governance`, and the API's `GovernanceAdapter` — the same
  runtime, built-in tools (`read_file` / `write_file` / `run_command`),
  governance approval flow, and supervisor verify-gate as the live
  demo.
- The model is the repo's **`MockProvider`, scripted** to perform the
  demo flow (read → run failing tests → write fix → re-run tests →
  claim completion). There was **no live model, no network, and no
  paid API call**. What is real: tool execution, the failing and then
  passing `node --test` runs, the governance approvals (the harness
  approves each card, standing in for the human in the demo script —
  each decision is logged in the transcript), and the supervisor
  verify-gate, which was enabled for the bot with a `supervisor`
  purpose profile pointing at the mock model and consumed the script's
  final step as its verdict call (6 provider calls total: 5 turn steps
  + 1 gate call; the turn was allowed to end on the claim).
- After the turn, the harness independently re-ran `node --test`
  (Step 2 in the transcript) and only then copied the patched file out.
- Times, durations, temp paths, and approval ids in the transcript are
  from the actual capture run and will differ on a re-run.

Reproduce it:

```sh
npm run build   # once, from the repo root (builds the dist/ the harness imports)
node examples/fix-a-bug/recorded/record-run.mjs
```

Artefacts from the capture:

- `recorded/transcript.txt` — the harness output, verbatim (also
  embedded below).
- `recorded/cart.js` — the patched file the turn produced.
- `recorded/cart.diff.txt` — unified diff, original → patched.
- The original `examples/fix-a-bug/cart.js` is **unchanged** (the demo
  still ships in its buggy, runnable state).

## Transcript (verbatim)

# fix-a-bug recorded run — raw harness output

scratch workspace: /tmp/kriyadot-fix-a-bug-GzJXPH (copy of examples/fix-a-bug/)
node: v24.22.1; platform: linux/x64

## Step 0 — the demo project before the turn (node --test)

```
✔ plain lines sum price * qty (1.236766ms)
✖ discount applies to the whole line (1.336115ms)
✔ single discounted item (0.197917ms)
ℹ tests 3
ℹ suites 0
ℹ pass 2
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 557.693073

✖ failing tests:

test at cart.test.mjs:10:1
✖ discount applies to the whole line (1.336115ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  
  145 !== 135
  
      at TestContext.<anonymous> (file:///tmp/kriyadot-fix-a-bug-GzJXPH/cart.test.mjs:12:10)
      at Test.runInAsyncScope (node:async_hooks:227:14)
      at Test.run (node:internal/test_runner/test:1402:25)
      at Test.processPendingSubtests (node:internal/test_runner/test:974:18)
      at Test.postRun (node:internal/test_runner/test:1542:19)
      at Test.run (node:internal/test_runner/test:1467:12)
      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:387:3) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 145,
    expected: 135,
    operator: 'strictEqual',
    diff: 'simple'
  }
```
exit code: 1 (1 failing test expected)

## Step 1 — the turn (user message from the demo script)

> The cart tests are failing. Find the bug and fix it.

Turn events (tokens assembled; tool/approval/notice events verbatim):
```
[tool_call] read_file {"path":"cart.js"}
[tool_call] read_file {"path":"cart.test.mjs"}
[tool_result] read_file: // SPDX-License-Identifier: Apache-2.0
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
      // BUG: the discount is computed on a single unit and then the
      // discounted unit price is multiplied — wait, that part is fine.
      // The real bug: for qty > 1 the discount is applied only ONCE
      // (to one unit) instead of to the whole line.
      const discountedUnit = item.price - (item.price * item.discountPct) / 100;
      total += discountedUnit + item.price * (item.qty - 1);
    } else {
      total += line;
    }
  }
  return Math.round(total * 100)... [truncated in transcript]
[tool_result] read_file: // SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cartTotal } from './cart.js';

test('plain lines sum price * qty', () => {
  assert.equal(cartTotal([{ price: 10, qty: 2 }, { price: 5, qty: 1 }]), 25);
});

test('discount applies to the whole line', () => {
  // 3 × $50 with 10% off the whole line = $135, not $145.
  assert.equal(cartTotal([{ price: 50, qty: 3, discountPct: 10 }]), 135);
});

test('single discounted item', () => {
  assert.equal(cartTotal([{ price: 80, qty: 1, discountPct: 25 }]), 60);
});

[approval_required] id=f25e8c85-9cf0-4f03-a2e7-7afb0d977352 tool=run_command — harness (as the demo user) will approve
[assistant] I will read the module and its tests first.
[tool_call] run_command {"command":"node --test"} (approval required)
[approval] run_command (eac8b2c6-e171-4368-b0c4-3ee86677f386) -> approved by harness (demo user role)
[tool_result] run_command: {"exitCode":1,"stdout":"✔ plain lines sum price * qty (1.292019ms)\n✖ discount applies to the whole line (1.24564ms)\n✔ single discounted item (0.218728ms)\nℹ tests 3\nℹ suites 0\nℹ pass 2\nℹ fail 1\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 292.789381\n\n✖ failing tests:\n\ntest at cart.test.mjs:10:1\n✖ discount applies to the whole line (1.24564ms)\n  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n  \n  145 !== 135\n  \n      at TestContext.<anonymous> (file:///tmp/kriyadot-fix-a-bug-GzJXPH/cart.test.mjs:12:10)\n      at Test.runInAsyncScope (node:async_hooks:227:14)\n      at Test.run (node:internal/test_runner/test:1402:25)\n      at Test.processPendingSubtests (node:internal/test_runner/test:974:18)\n      at Test.postRun (node:internal/test_runner/test:1542:19)\n      at Test.run (node:internal/test_runner/test:1467:12)\n      at async startSubtest... [truncated in transcript]
[approval_required] id=95b42502-1742-4dfd-a9a9-e8ad5b9fee4e tool=write_file — harness (as the demo user) will approve
[assistant] Now let me run the test suite to see the failure.
[tool_call] write_file {"path":"cart.js","content":"// SPDX-License-Identifier: Apache-2.0\n// Demo project: a tiny cart module with one deliberate bug (see README).\n\n/**\n * Total a cart.\n * items: [{ price, qty, discountPct? }] — discountPct is a percentage\n * off the WHOLE line (price * qty), per the pricing spec.\n */\nexport function cartTotal(items) {\n  let total = 0;\n  for (const item of items) {\n    const line = item.price * item.qty;\n    if (item.discountPct) {\n      total += line - (line * item.discountPct) / 100;\n    } else {\n      total += line;\n    }\n  }\n  return Math.round(total * 100) / 100;\n}\n"} (approval required)
[approval] write_file (a363d1fe-e7dd-49fe-8cdc-4a4ecae9f3d9) -> approved by harness (demo user role)
[tool_result] write_file: {"written":"/tmp/kriyadot-fix-a-bug-GzJXPH/cart.js","bytes":562}
[approval_required] id=66409c50-894b-4b96-8273-13717f10f048 tool=run_command — harness (as the demo user) will approve
[assistant] The bug is in the discounted branch: the discount is subtracted from a single unit and the remaining units are added at full price, so for qty > 1 only one unit is discounted. The discount must apply to the whole line. Fixing cart.js:
[tool_call] run_command {"command":"node --test"} (approval required)
[approval] run_command (62d1e0c9-6aa4-4968-99dc-5dbb46987a63) -> approved by harness (demo user role)
[tool_result] run_command: {"exitCode":0,"stdout":"✔ plain lines sum price * qty (1.710186ms)\n✔ discount applies to the whole line (0.278348ms)\n✔ single discounted item (0.17301ms)\nℹ tests 3\nℹ suites 0\nℹ pass 3\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 420.431764\n","stderr":"","sandboxed":false}
[assistant] Re-running the suite to verify the fix.Fixed. The discount in cartTotal now applies to the whole line (price * qty). All 3 tests pass, including "discount applies to the whole line" (3 x $50 at 10% off = $135).
[done] usage={"promptTokens":50,"completionTokens":25,"totalTokens":75}
```
turn usage: {"promptTokens":50,"completionTokens":25,"totalTokens":75}
provider calls made: 6 (5 scripted turn steps + 1 supervisor verify-gate call)

## Step 2 — independent verification (harness re-runs node --test)

```
✔ plain lines sum price * qty (1.823006ms)
✔ discount applies to the whole line (0.23306ms)
✔ single discounted item (0.225999ms)
ℹ tests 3
ℹ suites 0
ℹ pass 3
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 332.084391
```
exit code: 0

Patched cart.js copied to examples/fix-a-bug/recorded/cart.js
Unified diff written to examples/fix-a-bug/recorded/cart.diff.txt
original cart.js unchanged in examples/fix-a-bug/: true

## The diff the turn produced

```diff
--- a/cart.js
+++ b/cart.js
@@ -11,12 +11,7 @@
   for (const item of items) {
     const line = item.price * item.qty;
     if (item.discountPct) {
-      // BUG: the discount is computed on a single unit and then the
-      // discounted unit price is multiplied — wait, that part is fine.
-      // The real bug: for qty > 1 the discount is applied only ONCE
-      // (to one unit) instead of to the whole line.
-      const discountedUnit = item.price - (item.price * item.discountPct) / 100;
-      total += discountedUnit + item.price * (item.qty - 1);
+      total += line - (line * item.discountPct) / 100;
     } else {
       total += line;
     }
```

## Reading the transcript

- `Step 0` is the suite failing before the turn: `145 !== 135` on
  "discount applies to the whole line" — the planted bug.
- In `Step 1`, `run_command` and `write_file` pause for governance
  approval (`[approval_required]` → `[approval] ... approved`); the
  re-run inside the turn shows `pass 3 / fail 0`.
- The final assistant claim ("All 3 tests pass…") was checked by the
  supervisor verify-gate against the quoted tool evidence before the
  turn ended.
- `Step 2` is the harness's own post-turn `node --test`: 3 passed,
  exit code 0 — verification that does not depend on the turn's claims.
