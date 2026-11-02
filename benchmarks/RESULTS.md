<!-- SPDX-License-Identifier: Apache-2.0 -->
# KriyaDot Public Benchmark Pack — Results

- Provider: **mock** (model: mock-model)
- Date: 2026-11-02T07:00:00.558Z
- Environment: Node v24.22.1, linux/x64
- Suite: 13 tasks in benchmarks/suite.mjs, pass threshold score >= 0.99
- Wall time (sum of per-task ms): 46 ms

> **MOCK RESULTS — read this label before quoting any number.**
> Harness tasks (chat-routing, tool-spill, memory-recall, workflow-run) exercised the real deterministic dist code. Provider tasks (fix-the-bug, extract-values, follow-instructions) replayed each task's canned known-good answer through the repo's MockProvider. The provider-task scores validate the suite, the scorers and this reporting pipeline — they are **NOT** evidence about any real model's ability, and must never be quoted as a model score.

## Overall

**13/13 tasks passed**, mean score 1.00.

| Category | Passed | Mean score |
| --- | ---: | ---: |
| chat-routing | 4/4 | 1.00 |
| tool-spill | 1/1 | 1.00 |
| fix-the-bug | 2/2 | 1.00 |
| memory-recall | 2/2 | 1.00 |
| workflow-run | 1/1 | 1.00 |
| extract-values | 2/2 | 1.00 |
| follow-instructions | 1/1 | 1.00 |

## Tasks

| Task | Category | Result | Score | ms | Tokens (total, when reported) | Scorer detail |
| --- | --- | --- | ---: | ---: | ---: | --- |
| route-code-to-coder | chat-routing | PASS | 1.00 | 2 | — | routed to coder via keyword-score (path=specialist, confidence=1); expected coder/specialist |
| route-writing-to-writer | chat-routing | PASS | 1.00 | 1 | — | routed to writer via keyword-score (path=specialist, confidence=0.69); expected writer/specialist |
| route-finance-to-finance | chat-routing | PASS | 1.00 | 0 | — | routed to finance via keyword-score (path=specialist, confidence=0.6); expected finance/specialist |
| route-unmatched-to-anchor | chat-routing | PASS | 1.00 | 0 | — | routed to chief via default (path=direct, confidence=0); expected chief/direct |
| tool-spill-huge-result | tool-spill | PASS | 1.00 | 3 | — | original 120018 bytes spilled as spill_mvywsq6b_1; model payload 4433 bytes (bound 8192, ok; store-reported modelBytes=4029, compressionRatio=0.0335699645053242); paged read retrieved 120018 bytes in 16 pages, byte-identical=true; search('NEEDLE_TAIL_MARKER') totalMatches=1, ok=true |
| fix-bug-cart-discount | fix-the-bug | PASS | 1.00 | 3 | 15 | all 4 assertions passed |
| fix-bug-clamp-range | fix-the-bug | PASS | 1.00 | 2 | 15 | all 5 assertions passed |
| memory-recall-deployment-window | memory-recall | PASS | 1.00 | 14 | — | expected atom at rank 1 of 3 hits |
| memory-recall-project-codename | memory-recall | PASS | 1.00 | 7 | — | expected atom at rank 1 of 3 hits |
| workflow-sequential-pipeline | workflow-run | PASS | 1.00 | 14 | — | run 74e29c30-689d-461c-8c2b-cc34ff2f0946 status=succeeded; summary output={"title":"hello","count":2,"upper":["A","B"]}; expected {"title":"hello","count":2,"upper":["A","B"]} |
| extract-invoice-fields | extract-values | PASS | 1.00 | 0 | 15 | all 5 fields exact |
| extract-event-dates | extract-values | PASS | 1.00 | 0 | 15 | all 4 fields exact |
| follow-json-only | follow-instructions | PASS | 1.00 | 0 | 15 | exact JSON-only reply |

## Notes recorded by this suite

- The tool-spill task is coded against the current dist ToolSpillStore API (spill + compression stage + paged `read()` + `search()`); its detail line records the store-reported compressed size and compression ratio from the actual run.
- Mock-mode token counts are the MockProvider's fixed scripted usage (10 prompt / 5 completion / 15 total per call), not measured model usage.
