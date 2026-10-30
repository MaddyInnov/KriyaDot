<!-- SPDX-License-Identifier: Apache-2.0 -->

# KriyaDot benchmarks

Two different benchmark families live here. They measure different
things and must not be conflated:

| Runner | What it measures | Output |
| --- | --- | --- |
| `run.mjs` | Harness **micro-benchmarks**: latency of deterministic plumbing (embedder, memory recall, session store, discovery ranking, supervisor gate against a mock provider) | repo-root `BENCHMARK.md` (micro section) |
| `tasks/run-tasks.mjs` | **Task suite**: defined tasks with deterministic, auto-scored outcomes (fix-the-bug, extract-values, follow-instructions, tool-use) run against a provider | `tasks/results/task-results.json` + `task-results.md` |

## Task suite

```sh
cd packages/agent-runtime
npm run build
node benchmarks/tasks/run-tasks.mjs --write        # mock provider (default, offline)
```

- Tasks and scorers: `tasks/tasks.mjs`. Every scorer is deterministic —
  code answers are executed in a `node:vm` sandbox and checked against
  assertions, extraction answers are JSON-parsed and compared field by
  field, instruction-following is checked mechanically, and tool-use is
  scored on the exact tool calls returned. No model grades anything.
- A task passes at score >= 0.99. Partial credit exists (e.g. buggy
  code that fixes some assertions, JSON wrapped in prose).
- **Mock mode** replays each task's canned known-good answer
  (`mockScript`) through the repo's real `MockProvider`. It validates
  the harness, scorers, and reporting end to end. It says nothing about
  any model's ability — results files are labelled accordingly.

### Running against a real model

```sh
BENCH_PROVIDER=groq BENCH_MODEL=gpt-oss-120b GROQ_API_KEY=... \
  node benchmarks/tasks/run-tasks.mjs --write
```

`BENCH_PROVIDER` is any provider id from
`src/providers/catalog.json`. The runner refuses to start when the
provider's key env var is absent (exit 2, no network call attempted).
Real-provider runs overwrite the same results files — check the
`provider` field before quoting numbers.
