# Demo: fix-a-bug

A five-minute KriyaDot demo: a tiny project with a real bug, a failing
test, and a bot that finds and fixes it — with the supervisor
verify-gate checking the "done" claim against actual test output.

## The project

- `cart.js` — a shopping-cart total function. It has a bug: the
  discount is applied per item *before* quantity multiplication for
  one branch, so multi-quantity discounted items total wrong.
- `cart.test.mjs` — the test that exposes it (node:test, no deps).

Run it yourself first:

```sh
node --test
# → 1 failing test: "discount applies to the whole line"
```

## The demo script

1. Open Chat with a coding bot whose workspace is this folder.
2. Say: **"The cart tests are failing. Find the bug and fix it."**
3. Watch the turn: the bot reads the code, runs the tests
   (`run_command`), edits `cart.js`, and re-runs the suite.
4. When the bot claims "all tests pass", the **supervisor verify-gate**
   checks the claim against the quoted test output before the turn is
   allowed to end — a claim without green test evidence is rejected
   and the bot is sent back to work.
5. Try `/context` to inspect the session, or share the transcript
   with the session Share button (publishes to `/p/<slug>`).

## Resetting the demo

```sh
git checkout -- cart.js   # if this folder is inside the repo
```

or re-copy the folder from a fresh checkout.
