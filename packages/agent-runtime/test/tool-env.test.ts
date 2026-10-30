// SPDX-License-Identifier: Apache-2.0
// Environment-gated capabilities (#123): skills with frontmatter
// `requiredEnv` are skipped at load/activation with a recorded reason;
// tools are filtered by the sidecar registry (tools/tool-env.ts).

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SkillLoader, SkillNotUsableError } from '../src/skills.js';
import {
  filterToolsByRequiredEnv,
  isToolEnvSatisfied,
  missingEnvForTool,
  registerToolRequiredEnv,
  requiredEnvForTool,
} from '../src/tools/tool-env.js';
import type { ToolDefinition } from '../src/types.js';

function fakeTool(name: string): ToolDefinition {
  return {
    name,
    description: `fake ${name}`,
    parameters: { type: 'object', properties: {} },
    handler: async () => ({ ok: true }),
  };
}

describe('tool requiredEnv registry (#123)', () => {
  it('filters a tool whose required env is missing, keeps it when present', () => {
    registerToolRequiredEnv('needs_key_tool', { requiredEnv: ['FAKE_SERVICE_API_KEY'] });
    const tools = [fakeTool('needs_key_tool'), fakeTool('plain_tool')];

    const missing = filterToolsByRequiredEnv(tools, {});
    expect(missing.tools.map((t) => t.name)).toEqual(['plain_tool']);
    expect(missing.skipped).toHaveLength(1);
    expect(missing.skipped[0]!.name).toBe('needs_key_tool');
    expect(missing.skipped[0]!.missingEnv).toEqual(['FAKE_SERVICE_API_KEY']);
    expect(missing.skipped[0]!.reason).toMatch(/skipped: required env FAKE_SERVICE_API_KEY not set/);

    const present = filterToolsByRequiredEnv(tools, { FAKE_SERVICE_API_KEY: 'k' });
    expect(present.tools.map((t) => t.name)).toEqual(['needs_key_tool', 'plain_tool']);
    expect(present.skipped).toEqual([]);
  });

  it('treats blank values as missing and ungated tools as satisfied', () => {
    registerToolRequiredEnv('blank_key_tool', { requiredEnv: ['BLANK_KEY'] });
    expect(missingEnvForTool('blank_key_tool', { BLANK_KEY: '   ' })).toEqual(['BLANK_KEY']);
    expect(isToolEnvSatisfied('blank_key_tool', { BLANK_KEY: 'x' })).toBe(true);
    expect(requiredEnvForTool('never_registered_tool', {})).toEqual([]);
    expect(isToolEnvSatisfied('never_registered_tool', {})).toBe(true);
  });

  it('gates web_search on the SEARCH_PROVIDER-selected key only', () => {
    // No provider selected: keyless DuckDuckGo fallback → available.
    expect(isToolEnvSatisfied('web_search', {})).toBe(true);
    // Brave selected without its key: gated out.
    expect(missingEnvForTool('web_search', { SEARCH_PROVIDER: 'brave' })).toEqual(['BRAVE_API_KEY']);
    expect(isToolEnvSatisfied('web_search', { SEARCH_PROVIDER: 'brave', BRAVE_API_KEY: 'k' })).toBe(true);
    // Tavily selected: only the Tavily key matters.
    expect(missingEnvForTool('web_search', { SEARCH_PROVIDER: 'tavily', BRAVE_API_KEY: 'k' })).toEqual([
      'TAVILY_API_KEY',
    ]);
    const filtered = filterToolsByRequiredEnv([fakeTool('web_search')], { SEARCH_PROVIDER: 'tavily' });
    expect(filtered.tools).toEqual([]);
    expect(filtered.skipped[0]!.missingEnv).toEqual(['TAVILY_API_KEY']);
  });
});

describe('skill requiredEnv (#123)', () => {
  function makeSkillsDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'agent-skillenv-'));
    writeFileSync(
      join(dir, 'gated.md'),
      `---\nname: gated\ndescription: Needs a key\nrequiredEnv: [MY_SERVICE_API_KEY, MY_SERVICE_REGION]\n---\n\n# Gated\n\nBody.\n`,
    );
    writeFileSync(
      join(dir, 'open.md'),
      `---\nname: open\ndescription: No requirements\n---\n\n# Open\n\nBody.\n`,
    );
    return dir;
  }

  it('skips a skill whose env is missing, with a recorded reason', async () => {
    const loader = new SkillLoader(makeSkillsDir(), { env: {} });
    await expect(loader.loadFull('gated')).rejects.toBeInstanceOf(SkillNotUsableError);
    await expect(loader.loadFull('gated')).rejects.toThrow(/required env MY_SERVICE_API_KEY, MY_SERVICE_REGION not set/);
    await expect(loader.getSummary('gated')).rejects.toBeInstanceOf(SkillNotUsableError);
    const skipped = loader.getSkippedSkills();
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.name).toBe('gated');
    expect(skipped[0]!.missingEnv).toEqual(['MY_SERVICE_API_KEY', 'MY_SERVICE_REGION']);
    expect(loader.listAvailable()).toEqual(['open']);
    // The ungated skill is unaffected.
    const open = await loader.loadFull('open');
    expect(open.content).toContain('Body.');
    loader.close();
  });

  it('loads the skill when the env is present, exposing requiredEnv', async () => {
    const loader = new SkillLoader(makeSkillsDir(), {
      env: { MY_SERVICE_API_KEY: 'k', MY_SERVICE_REGION: 'eu' },
    });
    const skill = await loader.loadFull('gated');
    expect(skill.content).toContain('Body.');
    expect(skill.requiredEnv).toEqual(['MY_SERVICE_API_KEY', 'MY_SERVICE_REGION']);
    expect(loader.getSkippedSkills()).toEqual([]);
    expect(loader.listAvailable()).toEqual(['gated', 'open']);
    const summary = await loader.getSummary('gated');
    expect(summary).toEqual({ name: 'gated', description: 'Needs a key' });
    loader.close();
  });

  it('parses a single-string requiredEnv as a one-key list', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-skillenv1-'));
    writeFileSync(
      join(dir, 'one.md'),
      `---\nname: one\ndescription: One key\nrequiredEnv: ONLY_KEY\n---\n\nBody.\n`,
    );
    const missing = new SkillLoader(dir, { env: {} });
    await expect(missing.loadFull('one')).rejects.toThrow(/ONLY_KEY not set/);
    missing.close();
    const present = new SkillLoader(dir, { env: { ONLY_KEY: 'v' } });
    expect((await present.loadFull('one')).requiredEnv).toEqual(['ONLY_KEY']);
    present.close();
  });
});
