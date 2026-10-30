// SPDX-License-Identifier: Apache-2.0
/**
 * KriyaDot task benchmark runner.
 *
 * Executes the task suite in tasks/tasks.mjs against a provider and
 * writes a JSON + markdown report. A task PASSES at score >= 0.99.
 *
 * Usage:
 *   npm run build            (from packages/agent-runtime, once)
 *   node benchmarks/tasks/run-tasks.mjs [--write]
 *
 * Providers:
 *   mock (default)  The repo's MockProvider replaying each task's
 *                   canned known-good answer (mockScript). Zero network,
 *                   zero paid APIs. Validates the harness + scorers +
 *                   reporting — NOT any model's ability.
 *   <catalog id>    e.g. BENCH_PROVIDER=groq node benchmarks/tasks/run-tasks.mjs --write
 *                   Uses createProvider() from the built dist. Requires
 *                   that provider's API key in the environment (see
 *                   src/providers/catalog.json envKey); the runner exits
 *                   2 with a clear message when the key is absent and
 *                   never attempts a network call without it.
 *                   BENCH_MODEL overrides the model id.
 *
 * With --write, results land in benchmarks/tasks/results/
 * (task-results.json + task-results.md).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MockProvider, createProvider, getProviderPreset } from '../../dist/index.js';
import { TASKS } from './tasks.mjs';

const PASS_THRESHOLD = 0.99;

async function runSuite(provider, providerLabel, model) {
  const results = [];
  for (const task of TASKS) {
    // Mock mode: a fresh MockProvider per task, scripted with the
    // task's known-good answer. Real providers answer for themselves.
    const active = providerLabel === 'mock' ? new MockProvider(task.mockScript) : provider;
    const messages = [{ role: 'user', content: task.prompt }];
    const started = performance.now();
    let response;
    try {
      response = await active.chat(messages, task.tools ?? [], { model });
    } catch (err) {
      results.push({
        id: task.id,
        category: task.category,
        score: 0,
        pass: false,
        ms: Math.round(performance.now() - started),
        detail: `provider call failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    const ms = Math.round(performance.now() - started);
    const { score, detail } = task.score(response);
    results.push({ id: task.id, category: task.category, score, pass: score >= PASS_THRESHOLD, ms, detail });
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
  const passed = results.filter((r) => r.pass).length;
  const meanScore = results.reduce((a, r) => a + r.score, 0) / results.length;
  return { total: results.length, passed, meanScore, byCategory };
}

function renderMarkdown(report) {
  const { summary } = report;
  const rows = report.results
    .map((r) => `| ${r.id} | ${r.category} | ${r.pass ? 'PASS' : 'FAIL'} | ${r.score.toFixed(2)} | ${r.ms} | ${r.detail.replaceAll('|', '\\|')} |`)
    .join('\n');
  const catRows = Object.entries(summary.byCategory)
    .map(([c, s]) => `| ${c} | ${s.passed}/${s.total} | ${(s.scoreSum / s.total).toFixed(2)} |`)
    .join('\n');
  return `# KriyaDot Task Benchmark Results

- Provider: **${report.provider}** (model: ${report.model})
- Date: ${report.env.date}
- Environment: Node ${report.env.node}, ${report.env.platform}
- Suite: ${summary.total} tasks, pass threshold score >= ${PASS_THRESHOLD}

${report.provider === 'mock'
    ? '> **Mock provider.** These results replay each task\'s canned known-good answer through the repo\'s MockProvider. They validate the harness, scorers and reporting pipeline — they are NOT evidence about any real model\'s ability.'
    : '> Results from a real provider run. Scores are produced by the deterministic scorers in tasks.mjs (code executed in a sandbox, fields compared exactly, tool calls checked) — no model graded these answers.'}

## Overall

**${summary.passed}/${summary.total} tasks passed**, mean score ${summary.meanScore.toFixed(2)}.

| Category | Passed | Mean score |
| --- | ---: | ---: |
${catRows}

## Tasks

| Task | Category | Result | Score | ms | Scorer detail |
| --- | --- | --- | ---: | ---: | --- |
${rows}
`;
}

async function main() {
  const providerId = process.env.BENCH_PROVIDER ?? 'mock';
  let provider = null;
  let model = process.env.BENCH_MODEL ?? 'mock-model';

  if (providerId !== 'mock') {
    const preset = getProviderPreset(providerId);
    if (!preset) {
      console.error(`Unknown provider "${providerId}" (no preset in src/providers/catalog.json).`);
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
    const outDir = join(import.meta.dirname, 'results');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'task-results.json'), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(join(outDir, 'task-results.md'), renderMarkdown(report));
    console.error(`Wrote ${join(outDir, 'task-results.json')} and task-results.md`);
  }
}

await main();
