<!-- SPDX-License-Identifier: Apache-2.0 -->
# Agent-Safety Benchmarks — Soteria Verified Plans (Workstream 1 (d))

Reproduction harness + cost study for verified plans. The task set is
OSWorld-*style* — our own local tasks in that spirit (file
organisation, document edits, send-with-attachment, a browser-form
task against a local fixture page). OSWorld itself is not downloaded,
and the Soteria paper never evaluated on OSWorld either (see the
programme research report, §1).

## What runs

- **Deterministic corpus (default).** 10 legitimate gold plans +
  4 violating plans, verification OFF vs ON. The verifier's per-step
  oracle is the REAL governance gateway (`simulate()`, in-memory DB,
  DEFAULT_POLICY merged with each task's planSpecs). Plans come from
  the corpus — **no model runs in this mode**; it measures the
  verifier, the spec language and the oracle, not a model.
- **Live sub-run (`--live`).** A free model generates plans for 3
  tasks and judges the synthetic undecidable set (judge ablation:
  planning-model-as-judge vs a separate judge). Lane selection: local
  Ollama when it answers, else the keyless OVH anonymous lane through
  the runtime's provider factory, sequential and rate-limit-aware.
  No keyed provider is ever constructed — zero paid usage.

## Metrics (per run, in results.json)

Task success (fixture-state checkers), policy violations (executed
steps the gateway would deny or a shadow verification blocks — the
governance-audit view), false blocks (legitimate plans blocked),
verifier latency per plan, wall-clock latency.

Latency methodology: fixture tasks finish in ~0.05–0.2 ms, so the
kill criterion's latency arm uses the **median total wall-clock of
5 repetitions** of the legitimate corpus, with absolute verifier
latency per plan reported alongside.

## Kill criterion

False-blocks > 10% of legitimate plans OR verifier-added task
latency > 30% → verification narrows to high-risk tool classes only
(file deletes, payments, sends) via the `planVerificationScope` flag;
the runner re-measures under the narrowed scope and RESULTS.md
records the outcome. **2026-11-18 outcome: TRIGGERED on the latency
arm** (0% false blocks; +58% relative latency on micro-fixture tasks
at ~0.03 ms/plan absolute) — the runtime default scope is therefore
`high-risk-only`; `all` remains one flag away. See RESULTS.md.

## Safety note

The fixture executor never shells out: `run_command` steps are
recorded for violation accounting, not executed. File tools are
confined to the per-task temp fixture directory.

## Run

```sh
npm run build            # from the repo root, once
node benchmarks/agent-safety/run.mjs            # deterministic corpus
node benchmarks/agent-safety/run.mjs --live     # + free-model sub-run
node benchmarks/agent-safety/run.mjs --write    # also writes results.json + RESULTS.md
```
