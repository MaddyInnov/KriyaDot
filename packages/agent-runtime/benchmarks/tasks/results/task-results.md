# KriyaDot Task Benchmark Results

- Provider: **mock** (model: mock-model)
- Date: 2026-10-29T19:29:56.489Z
- Environment: Node v24.22.1, linux/x64
- Suite: 8 tasks, pass threshold score >= 0.99

> **Mock provider.** These results replay each task's canned known-good answer through the repo's MockProvider. They validate the harness, scorers and reporting pipeline — they are NOT evidence about any real model's ability.

## Overall

**8/8 tasks passed**, mean score 1.00.

| Category | Passed | Mean score |
| --- | ---: | ---: |
| fix-the-bug | 2/2 | 1.00 |
| extract-values | 2/2 | 1.00 |
| follow-instructions | 2/2 | 1.00 |
| tool-use | 2/2 | 1.00 |

## Tasks

| Task | Category | Result | Score | ms | Scorer detail |
| --- | --- | --- | ---: | ---: | --- |
| fix-bug-cart-discount | fix-the-bug | PASS | 1.00 | 0 | all 4 assertions passed |
| fix-bug-clamp-range | fix-the-bug | PASS | 1.00 | 0 | all 5 assertions passed |
| extract-invoice-fields | extract-values | PASS | 1.00 | 0 | all 5 fields exact |
| extract-event-dates | extract-values | PASS | 1.00 | 0 | all 4 fields exact |
| follow-json-only | follow-instructions | PASS | 1.00 | 0 | exact JSON-only reply |
| follow-three-bullets | follow-instructions | PASS | 1.00 | 0 | 3 non-empty line(s), 3 bullet line(s); need exactly 3 of each |
| tool-use-read-file | tool-use | PASS | 1.00 | 0 | exactly one read_file call for notes/plan.md |
| tool-use-answer-directly | tool-use | PASS | 1.00 | 0 | answered 42 directly, no tool calls |
