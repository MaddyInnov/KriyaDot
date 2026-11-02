// SPDX-License-Identifier: Apache-2.0
/**
 * KriyaDot public benchmark pack — runner (OH-6).
 *
 * Usage:
 *   npm run build            (from the repo root, once)
 *   node benchmarks/run.mjs [--write]
 *
 * Providers:
 *   mock (default)  Deterministic, zero network, zero paid API.
 *                   Harness tasks (routing / spill / memory /
 *                   workflow) exercise the real dist code directly.
 *                   Provider tasks (coding-fix / extract / follow)
 *                   replay each task's canned known-good answer
 *                   through the repo's MockProvider. Mock scores
 *                   validate the suite, scorers and reporting
 *                   pipeline — NOT any model's ability.
 *   <catalog id>    e.g. BENCH_PROVIDER=groq BENCH_MODEL=gpt-oss-120b \
 *                     GROQ_API_KEY=... node benchmarks/run.mjs --write
 *                   Mirrors the existing tasks runner's contract:
 *                   BENCH_PROVIDER accepts any provider id from
 *                   packages/agent-runtime/src/providers/catalog.json,
 *                   BENCH_MODEL is optional, and the runner REFUSES
 *                   to start (exit 2, no network call) when the
 *                   provider's key env var is missing. Harness tasks
 *                   still run deterministically in real mode (they
 *                   involve no model); only provider tasks change.
 *
 * With --write, results land in benchmarks/results.json and
 * benchmarks/RESULTS.md (relative to this file).
 * A task PASSES at score >= 0.99.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MockProvider, createProvider, getProviderPreset } from '../packages/agent-runtime/dist/index.js';
import { PASS_THRESHOLD, SUITE } from './suite.mjs';

async function runSuite(provider, providerLabel, model) {
  const results = [];
  for (const task of SUITE) {
    const started = performance.now();
    try {
      let outcome;
      let usage;
      if (task.kind === 'harness') {
        outcome = await task.run();
      } else {
        // Provider task: fresh MockProvider per task in mock mode
        // (scripted with the task's known-good answer); the real
        // provider answers for itself otherwise.
        const active = providerLabel === 'mock' ? new MockProvider(task.upstream.mockScript) : provider;
        const response = await active.chat([{ role: 'user', content: task.upstream.prompt }], task.upstream.tools ?? [], { model });
        usage = response.usage ?? undefined;
        outcome = task.upstream.score(response);
      }
      results.push({
        id: task.id,
        category: task.category,
        kind: task.kind,
        score: outcome.score,
        pass: outcome.score >= PASS_THRESHOLD,
        ms: Math.round(performance.now() - started),
        ...(usage ? { usage } : {}),
        detail: outcome.detail,
      });
    } catch (err) {
      results.push({
        id: task.id,
        category: task.category,
        kind: task.kind,
        score: 0,
        pass: false,
        ms: Math.round(performance.now() - started),
        detail: `task execution failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  return results;
}

function summarize(results) {
  const byCategory = {};
  for (const r of results) {
    byCategory[r.category] ??= { total: 0, passed: 0, scoreSum: 0 };
    byCategory[r.category].total += 1;
    byCategory[r.category].passed += r.pass ? 1 : 0;
    byCategory[r.category].scoreSum += r.score;
  }
  return {
    total: results.length,
    passed: results.filter((r) => r.pass).length,
    meanScore: results.reduce((a, r) => a + r.score, 0) / results.length,
    totalMs: results.reduce((a, r) => a + r.ms, 0),
    byCategory,
  };
}

function renderMarkdown(report) {
  const { summary } = report;
  const rows = report.results
    .map(
      (r) =>
        `| ${r.id} | ${r.category} | ${r.pass ? 'PASS' : 'FAIL'} | ${r.score.toFixed(2)} | ${r.ms} | ${r.usage ? r.usage.totalTokens : '—'} | ${String(r.detail).replaceAll('|', '\\|')} |`,
    )
    .join('\n');
  const catRows = Object.entries(summary.byCategory)
    .map(([c, s]) => `| ${c} | ${s.passed}/${s.total} | ${(s.scoreSum / s.total).toFixed(2)} |`)
    .join('\n');
  return `<!-- SPDX-License-Identifier: Apache-2.0 -->
# KriyaDot Public Benchmark Pack — Results

- Provider: **${report.provider}** (model: ${report.model})
- Date: ${report.env.date}
- Environment: Node ${report.env.node}, ${report.env.platform}
- Suite: ${summary.total} tasks in benchmarks/suite.mjs, pass threshold score >= ${PASS_THRESHOLD}
- Wall time (sum of per-task ms): ${summary.totalMs} ms

${
  report.provider === 'mock'
    ? '> **MOCK RESULTS — read this label before quoting any number.**\n> Harness tasks (chat-routing, tool-spill, memory-recall, workflow-run) exercised the real deterministic dist code. Provider tasks (fix-the-bug, extract-values, follow-instructions) replayed each task\'s canned known-good answer through the repo\'s MockProvider. The provider-task scores validate the suite, the scorers and this reporting pipeline — they are **NOT** evidence about any real model\'s ability, and must never be quoted as a model score.'
    : '> Results from a real provider run for the provider tasks; harness tasks are deterministic and provider-independent. All scores come from deterministic scorers — no model graded these answers.'
}

## Overall

**${summary.passed}/${summary.total} tasks passed**, mean score ${summary.meanScore.toFixed(2)}.

| Category | Passed | Mean score |
| --- | ---: | ---: |
${catRows}

## Tasks

| Task | Category | Result | Score | ms | Tokens (total, when reported) | Scorer detail |
| --- | --- | --- | ---: | ---: | ---: | --- |
${rows}

## Notes recorded by this suite

- The tool-spill task is coded against the current dist ToolSpillStore API (spill + compression stage + paged \`read()\` + \`search()\`); its detail line records the store-reported compressed size and compression ratio from the actual run.
- Mock-mode token counts are the MockProvider's fixed scripted usage (10 prompt / 5 completion / 15 total per call), not measured model usage.
`;
}

async function main() {
  const providerId = process.env.BENCH_PROVIDER ?? 'mock';
  let provider = null;
  let model = process.env.BENCH_MODEL ?? 'mock-model';

  if (providerId !== 'mock') {
    const preset = getProviderPreset(providerId);
    if (!preset) {
      console.error(`Unknown provider "${providerId}" (no preset in packages/agent-runtime/src/providers/catalog.json).`);
      process.exit(2);
    }
    if (preset.envKey && !process.env[preset.envKey]) {
      console.error(
        `Provider "${providerId}" needs ${preset.envKey} in the environment; it is not set. ` +
          'Refusing to run (no key = no network calls). Set it, or run the default mock suite.',
      );
      process.exit(2);
    }
    provider = createProvider(providerId);
    model = process.env.BENCH_MODEL ?? preset.models?.find((m) => m.default)?.id ?? preset.models?.[0]?.id ?? model;
  }

  const results = await runSuite(provider, providerId, model);
  const summary = summarize(results);
  const report = {
    provider: providerId,
    model,
    env: { node: process.version, platform: `${process.platform}/${process.arch}`, date: new Date().toISOString() },
    summary,
    results,
  };

  console.log(JSON.stringify(report, null, 2));
  console.error(`\n${summary.passed}/${summary.total} tasks passed (mean score ${summary.meanScore.toFixed(2)}) — provider: ${providerId}, model: ${model}`);

  if (process.argv.includes('--write')) {
    const outDir = import.meta.dirname;
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'results.json'), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(join(outDir, 'RESULTS.md'), renderMarkdown(report));
    console.error(`Wrote ${join(outDir, 'results.json')} and RESULTS.md`);
  }
}

await main();
