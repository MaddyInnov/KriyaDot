<!-- SPDX-License-Identifier: Apache-2.0 -->
# KriyaDot Public Benchmark Pack

The public, reproducible benchmark pack for KriyaDot: 13 tasks in
`suite.mjs`, executed by `run.mjs`, with the latest run published in
`RESULTS.md` / `results.json` and a footprint baseline in
`FOOTPRINT.md` / `footprint.json` (produced by `footprint.mjs`).

This pack complements — and partly reuses — the earlier suites
documented in the repo-root `BENCHMARK.md` (harness micro-benchmarks
in `packages/agent-runtime/benchmarks/run.mjs` and the 8-task suite
in `packages/agent-runtime/benchmarks/tasks/`). Where a task is
reused, it is imported from that suite and scored by its original
deterministic scorer; nothing is re-implemented or re-scored here.

## What the suite covers

| Family | Tasks | What is actually exercised |
| --- | ---: | --- |
| chat-routing | 4 | The real Universal router decision (`decideUniversalRoute` in `apps/api/dist/universal.js`, which scores bots with `scoreBotsForRouting` from the agent-runtime dist) over fixture bots carrying `routeKeywords`. Scorer: expected bot + expected path. |
| tool-spill | 1 | A ≥100 KB synthetic tool result through `ToolSpillStore`'s spill/compression path (agent-runtime dist). Scorer (three equal parts): model-facing payload under an 8,192-byte bound (the compressed body itself is capped at 4,000 chars by the store default), the original retrievable byte-for-byte through the store's paged `read()` API, and the store's `search()` API finding a tail marker in the stored original. |
| coding fix | 2 | Reused from the existing task suite; the returned function is executed in a `node:vm` sandbox against assertions. |
| memory-recall | 2 | A `TieredMemoryStore` seeded in a temp directory; scorer: expected atom in the top-k (rank 1 = full credit) of `recallHybrid`. |
| workflow-run | 1 | A real headless run of the shipped `sequentialPipelineTemplate` through `WorkflowRunner` from `@mvp/workflows` dist (trigger → set → code → set; stub governance/agent-runtime, no model, no tool). Scorer: run succeeded AND final output matches the expected transform. |
| extract-values / follow-instructions | 3 | Reused from the existing task suite; JSON fields compared exactly, format constraints checked mechanically. |

Every scorer is deterministic. No scorer calls a model.

## Method

- Harness tasks (routing, spill, memory, workflow) call the built
  dist code directly, in-process, against throwaway state in the OS
  temp directory. They measure whether KriyaDot's deterministic
  plumbing does what it claims — routing decisions, spill bounds and
  retrieval, memory recall ranking, workflow execution.
- Provider tasks (coding fix, extract, follow) make exactly one
  provider call per task and score the response with the upstream
  suite's scorers.
- A task passes at score ≥ 0.99. Wall time is per-task milliseconds
  measured by the runner; token counts are reported only where the
  provider returns usage.

## How to run

```sh
# from the repo root, once:
npm run build

# mock mode (default) — deterministic, zero network, zero paid API:
node benchmarks/run.mjs            # prints the JSON report
node benchmarks/run.mjs --write    # also writes results.json + RESULTS.md

# footprint baseline (mock lane only; boots the real API server):
node benchmarks/footprint.mjs --write   # writes footprint.json + FOOTPRINT.md
```

### Real mode (env-gated)

```sh
BENCH_PROVIDER=groq BENCH_MODEL=gpt-oss-120b GROQ_API_KEY=<redacted> \
  node benchmarks/run.mjs --write
```

`BENCH_PROVIDER` accepts any provider id from
`packages/agent-runtime/src/providers/catalog.json`; `BENCH_MODEL`
is optional (defaults to the provider's default model). This
mirrors the existing task runner's contract: **the runner refuses
to start when the provider's key env var is missing (exit 2 — no
key, no network call).** In real mode only the provider tasks
change; the harness tasks are deterministic and provider-independent
by design. Real-provider runs write the same results files with the
real provider/model named in them — check the `provider` field
before quoting any number.

## Honesty rules

- **Mock numbers prove the pipeline and the scorers, not model
  quality.** In mock mode the provider tasks replay each task's
  canned known-good answer (`mockScript` in the upstream
  `tasks.mjs`) through the repo's real `MockProvider`. A pass there
  means the known-good answer genuinely satisfies the scorer
  (sandbox-executed code, exact fields, exact format) and that the
  harness + reporting work end to end. It says nothing about any
  real model's reasoning, coding, or writing ability, and must
  never be quoted as a model score. `RESULTS.md` generated from a
  mock run is labelled as mock, prominently, for exactly this
  reason.
- Mock token counts are the MockProvider's fixed scripted usage
  (10 prompt / 5 completion / 15 total per call), not measured
  model usage.
- Numbers in `RESULTS.md` and `FOOTPRINT.md` come only from runs
  actually executed on the machine and date named in those files.
  Absolute numbers vary by hardware; rerun the scripts to reproduce.
- The tool-spill task is coded against the dist API that exists
  today: an earlier draft of this pack was written against the
  pre-compression `ToolSpillStore` (preview-only payload, paged
  `read()`, no `search()`); when the OH-1 compression stage landed
  in the dist in parallel, the task was updated to score the
  compressed payload bound, paged retrieval, and `search()`
  against the new API rather than quietly keeping the old
  assumptions.
