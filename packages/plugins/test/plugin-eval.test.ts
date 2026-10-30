// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { runPluginEval, validatePluginEvalSuite, formatPluginEvalReport } from '../src/plugin-eval.js';
import { validateUnifiedManifest } from '../src/bundle.js';

const manifest = validateUnifiedManifest({
  id: 'fixture-plugin', name: 'Fixture', version: '1.0.0', description: 'Fixture plugin',
  kinds: ['tool'], entry: 'index.js', declaredTools: [{ name: 'echo', description: 'echo' }],
});

const suite = validatePluginEvalSuite({
  id: 'fixture-suite', pluginId: 'fixture-plugin', minScore: 0.5,
  cases: [
    { id: 'greets', input: 'say hello', expectContains: ['hello'] },
    { id: 'uses-tool', input: 'echo hi', expectTool: 'plugin:fixture-plugin:echo', expectContains: ['hi'] },
  ],
});

describe('CA-23 plugin eval harness', () => {
  it('passes a fixture plugin and returns CI exit code 0', async () => {
    const report = await runPluginEval(suite, manifest, async ({ caseInput }) => ({
      text: caseInput.includes('echo') ? 'hi there' : 'hello world',
      toolsUsed: caseInput.includes('echo') ? ['plugin:fixture-plugin:echo'] : [],
    }));
    expect(report.passed).toBe(2);
    expect(report.exitCode).toBe(0);
    expect(formatPluginEvalReport(report)).toContain('PASS');
  });

  it('fails the CI gate (exit 1) when a case misses its rubric', async () => {
    const report = await runPluginEval(suite, manifest, async () => ({ text: 'unrelated', toolsUsed: [] }));
    expect(report.failed).toBe(2);
    expect(report.exitCode).toBe(1);
  });

  it('refuses to run a suite against the wrong plugin', async () => {
    await expect(runPluginEval({ ...suite, pluginId: 'other' }, manifest, async () => ({ text: 'x' }))).rejects.toThrow(/but manifest is/);
  });
});
