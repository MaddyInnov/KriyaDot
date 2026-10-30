// SPDX-License-Identifier: Apache-2.0
// CA-5 agent definition files: frontmatter parsing (incl. edge cases),
// directory loading, merge precedence over the built-in library, and
// delegate/background profile resolution. Zero paid APIs.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  parseAgentDefinition,
  loadAgentDefinitions,
  mergeAgentDefinitions,
  agentDefinitionToProfile,
  AgentDefinitionRegistry,
  resolveDelegateProfile,
  slugifyAgentId,
} from '../src/agent-definitions.js';
import { loadSubagentProfiles } from '../src/subagent-profiles.js';

describe('parseAgentDefinition', () => {
  it('parses full frontmatter + body as system prompt', () => {
    const { definition, error } = parseAgentDefinition(
      [
        '---',
        'name: Code Reviewer',
        'description: Reviews diffs',
        'model: some-model-1',
        'tools: [read_file, grep]',
        'permissionMode: plan',
        'maxTurns: 12',
        'effort: high',
        'memory: project',
        'isolation: worktree',
        '---',
        'You review code carefully.',
      ].join('\n'),
      { fallbackName: 'fallback' },
    );
    expect(error).toBeUndefined();
    expect(definition).toMatchObject({
      id: 'code-reviewer',
      name: 'Code Reviewer',
      description: 'Reviews diffs',
      model: 'some-model-1',
      tools: ['read_file', 'grep'],
      approvalMode: 'plan',
      maxTurns: 12,
      effort: 'high',
      memoryScope: { scope: 'project' },
      isolation: 'worktree',
      systemPrompt: 'You review code carefully.',
    });
  });

  it('accepts approvalMode alias, comma-string tools, and object memory scope', () => {
    const { definition } = parseAgentDefinition(
      '---\nname: Alias Agent\napprovalMode: bypass\ntools: read_file, write_file\nmemory:\n  projectId: proj-1\n  roles: [lead]\n---\nBody prompt.',
    );
    expect(definition?.approvalMode).toBe('bypass');
    expect(definition?.tools).toEqual(['read_file', 'write_file']);
    expect(definition?.memoryScope).toEqual({ projectId: 'proj-1', roles: ['lead'] });
  });

  it('no frontmatter: whole file is the prompt, name falls back to the file name', () => {
    const { definition } = parseAgentDefinition('Just a prompt, no frontmatter.', { fallbackName: 'plain-agent' });
    expect(definition?.name).toBe('plain-agent');
    expect(definition?.id).toBe('plain-agent');
    expect(definition?.systemPrompt).toBe('Just a prompt, no frontmatter.');
    expect(definition?.tools).toEqual([]);
  });

  it('rejects an empty body and ignores invalid maxTurns/effort/isolation values', () => {
    expect(parseAgentDefinition('---\nname: Empty\n---\n   \n').error).toMatch(/empty system prompt/);
    const { definition } = parseAgentDefinition(
      '---\nname: Loose\nmaxTurns: -3\neffort: extreme\nisolation: moon\n---\nPrompt.',
    );
    expect(definition?.maxTurns).toBeUndefined();
    expect(definition?.effort).toBeUndefined();
    expect(definition?.isolation).toBeUndefined();
  });

  it('slugifies names into ids', () => {
    expect(slugifyAgentId('Code Reviewer!')).toBe('code-reviewer');
    expect(slugifyAgentId('  --Weird__Name-- ')).toBe('weird-name');
  });
});

describe('loadAgentDefinitions', () => {
  let base: string;
  beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'kriyadot-agents-')); });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  function writeAgent(root: string, file: string, text: string): void {
    const dir = join(root, '.kriyadot', 'agents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), text);
  }

  it('loads workspace + user dirs; workspace wins on id collision; bad files are reported', () => {
    const ws = join(base, 'ws');
    const user = join(base, 'user');
    writeAgent(user, 'shared.md', '---\nname: Shared\n---\nUser-level prompt.');
    writeAgent(ws, 'shared.md', '---\nname: Shared\n---\nWorkspace prompt.');
    writeAgent(ws, 'only-ws.md', '---\nname: Solo\n---\nSolo prompt.');
    writeAgent(ws, 'broken.md', '---\nname: Broken\n---\n');
    writeFileSync(join(ws, '.kriyadot', 'agents', 'ignored.txt'), 'not an agent');

    const report = loadAgentDefinitions({ workspaceDir: ws, userDir: user });
    expect(report.scannedDirs).toHaveLength(2);
    expect(report.definitions.map((d) => d.id).sort()).toEqual(['shared', 'solo']);
    const shared = report.definitions.find((d) => d.id === 'shared')!;
    expect(shared.systemPrompt).toBe('Workspace prompt.');
    expect(shared.source).toBe('workspace');
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]!.file).toContain('broken.md');
  });

  it('missing dirs are not errors', () => {
    const report = loadAgentDefinitions({ workspaceDir: join(base, 'nope') });
    expect(report.definitions).toEqual([]);
    expect(report.errors).toEqual([]);
  });
});

describe('merge precedence', () => {
  it('file-defined agents win over built-ins with the same id', () => {
    const builtins = loadSubagentProfiles();
    expect(builtins.length).toBeGreaterThanOrEqual(150);
    const victim = builtins[0]!;
    const { definition } = parseAgentDefinition(`---\nname: ${victim.name}\n---\nFILE VERSION PROMPT`, {});
    // Force the colliding id:
    const def = { ...definition!, id: victim.id };
    const merged = mergeAgentDefinitions(builtins, [def]);
    expect(merged).toHaveLength(builtins.length);
    expect(merged.find((p) => p.id === victim.id)!.systemPrompt).toBe('FILE VERSION PROMPT');

    const registry = new AgentDefinitionRegistry([def], builtins);
    const eph = registry.ephemeralFor(victim.id);
    expect(eph?.systemPrompt).toBe('FILE VERSION PROMPT');
    // Untouched built-ins still resolve:
    const other = builtins[1]!;
    expect(registry.ephemeralFor(other.id)?.systemPrompt).toBe(other.systemPrompt);
  });

  it('resolveDelegateProfile prefers definitions and falls back to the library', () => {
    const builtins = loadSubagentProfiles();
    const some = builtins[5]!;
    expect(resolveDelegateProfile(some.id)?.systemPrompt).toBe(some.systemPrompt);
    const { definition } = parseAgentDefinition('---\nname: Brand New\nmodel: m-1\nisolation: worktree\n---\nFresh prompt.');
    const resolved = resolveDelegateProfile('brand-new', [definition!]);
    expect(resolved).toMatchObject({ name: 'Brand New', model: 'm-1', isolation: 'worktree', systemPrompt: 'Fresh prompt.' });
    expect(resolveDelegateProfile('no-such-agent-xyz')).toBeUndefined();
    // toProfile keeps the library shape:
    expect(agentDefinitionToProfile(definition!)).toMatchObject({ id: 'brand-new', suggestedTools: [] });
  });
});
