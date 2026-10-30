// SPDX-License-Identifier: Apache-2.0
// #42 executable slash commands (/run + shipped `reduce`) and
// #164 env skill force-load helpers (slash-commands.ts).

import { describe, expect, it } from 'vitest';
import {
  envForcedSkills,
  executeRunCommand,
  loadSlashCommands,
  mergeForcedSkills,
  parseRunCommand,
  REDUCE_COMMAND_NAME,
  resolveRunTarget,
} from '../src/slash-commands.js';

describe('#42 /run parsing + target resolution', () => {
  it('parses /run <name> [args] and rejects non-/run messages', () => {
    expect(parseRunCommand('/run nightly args here')).toEqual({ name: 'nightly', args: 'args here' });
    expect(parseRunCommand('/run')).toEqual({ name: '', args: '' });
    expect(parseRunCommand('/reply #1 hi')).toBeNull();
    expect(parseRunCommand('run nightly')).toBeNull();
  });

  it('resolves workflows over layers over prompt commands', () => {
    const registries = {
      workflows: ['nightly'],
      layers: ['nightly', 'review-layer'],
      commands: { nightly: { description: '', prompt: 'x' }, plan: { description: '', prompt: 'y' } },
    };
    expect(resolveRunTarget('nightly', registries)).toEqual({ kind: 'workflow', name: 'nightly' });
    expect(resolveRunTarget('review-layer', registries)).toEqual({ kind: 'layer', name: 'review-layer' });
    expect(resolveRunTarget('plan', registries)).toEqual({ kind: 'command', name: 'plan' });
    expect(resolveRunTarget('nope', registries)).toBeNull();
    expect(resolveRunTarget('', registries)).toBeNull();
  });

  it('executes workflows/layers through host executors and expands command fallbacks', async () => {
    const calls: string[] = [];
    const wf = await executeRunCommand(
      { name: 'nightly', args: 'full' },
      {
        workflows: ['nightly'],
        runWorkflow: async (name, args) => {
          calls.push(`${name}:${args}`);
          return { runId: 'r1' };
        },
      },
    );
    expect(wf.target.kind).toBe('workflow');
    expect(wf.output).toEqual({ runId: 'r1' });
    expect(calls).toEqual(['nightly:full']);

    const cmd = await executeRunCommand(
      { name: 'plan', args: 'the thing' },
      { commands: { plan: { description: '', prompt: 'Plan: {args}' } } },
    );
    expect(cmd.target.kind).toBe('command');
    expect(cmd.expanded).toBe('Plan: the thing');
  });

  it('fails visibly on unknown targets and unwired executor kinds', async () => {
    await expect(executeRunCommand({ name: 'ghost', args: '' }, { workflows: ['nightly'] })).rejects.toThrow(/Unknown \/run target "ghost"/);
    await expect(executeRunCommand({ name: 'nightly', args: '' }, { workflows: ['nightly'] })).rejects.toThrow(/not wired/);
  });

  it('the seed file ships the `reduce` command', () => {
    const commands = loadSlashCommands('/nonexistent-data-dir-for-seed-fallback');
    expect(commands[REDUCE_COMMAND_NAME]).toBeDefined();
    expect(commands[REDUCE_COMMAND_NAME]!.prompt).toContain('{args}');
  });
});

describe('#164 env skill force-load', () => {
  it('parses KRIYADOT_FORCE_SKILLS (trim, dedupe, blanks dropped)', () => {
    expect(envForcedSkills({ KRIYADOT_FORCE_SKILLS: ' code-review, debugging-method ,code-review,' } as NodeJS.ProcessEnv)).toEqual([
      'code-review',
      'debugging-method',
    ]);
    expect(envForcedSkills({} as NodeJS.ProcessEnv)).toEqual([]);
    expect(envForcedSkills({ KRIYADOT_FORCE_SKILLS: '  ' } as NodeJS.ProcessEnv)).toEqual([]);
  });

  it('merges forced skills ahead of selected ones, deduped and stable', () => {
    expect(mergeForcedSkills(['a', 'b'], ['b', 'c'])).toEqual(['b', 'c', 'a']);
    expect(mergeForcedSkills([], [])).toEqual([]);
  });
});
