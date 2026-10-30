// SPDX-License-Identifier: Apache-2.0
// CA-23: `plugin eval` harness.
//
// Reuses the evals stack's rubric semantics (contains / regex / tool_used,
// as in @mvp/agent-runtime evals.ts) but runs against a PLUGIN fixture:
// the runner is injected, so tests and CI run with zero network and zero
// paid calls. CI-gating semantics: the report carries an exitCode —
// 0 when every case passes at/above the suite threshold, 1 otherwise —
// so `plugin eval` can gate a workflow exactly like a test command.

import type { UnifiedBundleManifest } from './bundle.js';

export interface PluginEvalCase {
  id: string;
  input: string;
  expectContains?: string[];
  expectRegex?: string;
  expectTool?: string;
  passThreshold?: number;
}

export interface PluginEvalSuite {
  id: string;
  pluginId: string;
  minScore?: number;
  cases: PluginEvalCase[];
}

export interface PluginEvalCaseResult {
  caseId: string;
  passed: boolean;
  score: number;
  detail: string;
}

export interface PluginEvalReport {
  suiteId: string;
  pluginId: string;
  passed: number;
  failed: number;
  score: number;
  results: PluginEvalCaseResult[];
  /** CI gate: 0 = pass, 1 = fail. */
  exitCode: 0 | 1;
}

export type PluginEvalRunner = (input: {
  pluginId: string;
  caseInput: string;
}) => Promise<{ text: string; toolsUsed?: string[] }>;

export function validatePluginEvalSuite(raw: unknown): PluginEvalSuite {
  if (typeof raw !== 'object' || raw === null) throw new Error('plugin eval suite must be an object');
  const s = raw as Record<string, unknown>;
  if (typeof s.id !== 'string' || !s.id) throw new Error('plugin eval suite needs an id');
  if (typeof s.pluginId !== 'string' || !s.pluginId) throw new Error('plugin eval suite needs a pluginId');
  if (!Array.isArray(s.cases) || s.cases.length === 0) throw new Error('plugin eval suite needs at least one case');
  for (const c of s.cases as Array<Record<string, unknown>>) {
    if (typeof c.id !== 'string' || typeof c.input !== 'string') throw new Error('plugin eval cases need { id, input }');
  }
  return raw as PluginEvalSuite;
}

function scoreCase(c: PluginEvalCase, out: { text: string; toolsUsed?: string[] }): { score: number; detail: string } {
  const parts: number[] = [];
  const notes: string[] = [];
  if (c.expectContains?.length) {
    const hay = out.text.toLowerCase();
    const found = c.expectContains.filter((k) => hay.includes(k.toLowerCase())).length;
    parts.push(found / c.expectContains.length);
    notes.push(`contains ${found}/${c.expectContains.length}`);
  }
  if (c.expectRegex) {
    let ok = false;
    try { ok = new RegExp(c.expectRegex).test(out.text); } catch { ok = false; }
    parts.push(ok ? 1 : 0);
    notes.push(ok ? 'regex matched' : 'regex missed');
  }
  if (c.expectTool) {
    const ok = (out.toolsUsed ?? []).includes(c.expectTool);
    parts.push(ok ? 1 : 0);
    notes.push(ok ? `tool ${c.expectTool} used` : `tool ${c.expectTool} not used`);
  }
  if (parts.length === 0) parts.push(out.text ? 1 : 0);
  return { score: parts.reduce((a, b) => a + b, 0) / parts.length, detail: notes.join('; ') || 'output present' };
}

export async function runPluginEval(
  suite: PluginEvalSuite,
  manifest: UnifiedBundleManifest,
  runner: PluginEvalRunner,
): Promise<PluginEvalReport> {
  if (suite.pluginId !== manifest.id) {
    throw new Error(`plugin eval suite is for "${suite.pluginId}" but manifest is "${manifest.id}"`);
  }
  const results: PluginEvalCaseResult[] = [];
  for (const c of suite.cases) {
    try {
      const out = await runner({ pluginId: manifest.id, caseInput: c.input });
      const { score, detail } = scoreCase(c, out);
      results.push({ caseId: c.id, passed: score >= (c.passThreshold ?? 0.7), score, detail });
    } catch (err) {
      results.push({ caseId: c.id, passed: false, score: 0, detail: err instanceof Error ? err.message : String(err) });
    }
  }
  const passed = results.filter((r) => r.passed).length;
  const score = results.length ? results.reduce((a, r) => a + r.score, 0) / results.length : 0;
  const minScore = suite.minScore ?? manifest.evalSuite?.minScore ?? 0;
  const gateOk = passed === results.length && score >= minScore;
  return {
    suiteId: suite.id,
    pluginId: manifest.id,
    passed,
    failed: results.length - passed,
    score,
    results,
    exitCode: gateOk ? 0 : 1,
  };
}

export function formatPluginEvalReport(r: PluginEvalReport): string {
  const lines = [
    `plugin eval ${r.suiteId} (${r.pluginId}): ${r.passed} passed, ${r.failed} failed, score ${r.score.toFixed(2)} — ${r.exitCode === 0 ? 'PASS' : 'FAIL'}`,
    ...r.results.map((x) => `  ${x.passed ? '✓' : '✗'} ${x.caseId} (${x.score.toFixed(2)}) ${x.detail}`),
  ];
  return lines.join('\n');
}
