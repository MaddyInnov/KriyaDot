// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import {
  parseValidatorSpecs,
  runTurnValidators,
  runValidator,
  splitCommandLine,
  validatorFailureMessage,
  type ValidatorExecFn,
} from '../src/validators.js';

describe('splitCommandLine', () => {
  it('splits plain and quoted args', () => {
    expect(splitCommandLine('npm test')).toEqual(['npm', 'test']);
    expect(splitCommandLine('node "my script.js" --flag x')).toEqual([
      'node',
      'my script.js',
      '--flag',
      'x',
    ]);
    expect(splitCommandLine("echo 'a b'")).toEqual(['echo', 'a b']);
    expect(splitCommandLine('')).toEqual([]);
  });
});

describe('parseValidatorSpecs', () => {
  it('parses strings, lists and objects into argv specs', () => {
    expect(parseValidatorSpecs('npm test')).toEqual([
      { name: 'skill-validator', command: ['npm', 'test'] },
    ]);
    expect(
      parseValidatorSpecs([
        'npm test',
        { name: 'lint', command: 'npm run lint', timeoutMs: 5000 },
        { builtin: 'verify-changes' },
        42,
        null,
      ]),
    ).toEqual([
      { name: 'npm', command: ['npm', 'test'] },
      { name: 'lint', command: ['npm', 'run', 'lint'], timeoutMs: 5000 },
      { name: 'skill-validator', builtin: 'verify-changes' },
    ]);
    expect(parseValidatorSpecs(undefined)).toEqual([]);
  });
});

describe('runValidator', () => {
  it('passes a zero-exit command', async () => {
    const exec: ValidatorExecFn = async () => ({ stdout: 'all good', stderr: '', exitCode: 0 });
    const r = await runValidator({ name: 'check', command: ['make', 'check'] }, { workspaceDir: '/ws', exec });
    expect(r).toMatchObject({ name: 'check', passed: true });
    expect(r.output).toContain('all good');
  });

  it('fails a non-zero-exit command with output excerpt', async () => {
    const exec: ValidatorExecFn = async () => ({ stdout: '', stderr: 'boom: 3 failures', exitCode: 2 });
    const r = await runValidator({ name: 'check', command: ['make', 'check'] }, { workspaceDir: '/ws', exec });
    expect(r.passed).toBe(false);
    expect(r.output).toContain('boom: 3 failures');
  });

  it('fails (never throws) when the command cannot start', async () => {
    const exec: ValidatorExecFn = async () => {
      throw new Error('ENOENT');
    };
    const r = await runValidator({ name: 'check', command: ['nope'] }, { workspaceDir: '/ws', exec });
    expect(r.passed).toBe(false);
    expect(r.error).toContain('ENOENT');
  });

  it('fails a spec with neither command nor builtin', async () => {
    const r = await runValidator({ name: 'empty' }, { workspaceDir: '/ws' });
    expect(r.passed).toBe(false);
    expect(r.error).toContain('neither');
  });
});

describe('runTurnValidators + validatorFailureMessage', () => {
  it('runs serially and formats failures as an instruction', async () => {
    const order: string[] = [];
    const exec: ValidatorExecFn = async (command) => {
      order.push(command.join(' '));
      return { stdout: '', stderr: 'nope', exitCode: 1 };
    };
    const results = await runTurnValidators(
      [
        { name: 'a', command: ['check-a'] },
        { name: 'b', command: ['check-b'] },
      ],
      { workspaceDir: '/ws', exec },
    );
    expect(order).toEqual(['check-a', 'check-b']);
    expect(results.every((r) => !r.passed)).toBe(true);
    const message = validatorFailureMessage(results);
    expect(message).toContain('End-of-turn validation failed');
    expect(message).toContain('Validator "a" FAILED');
    expect(message).toContain('Validator "b" FAILED');
  });

  it('returns an empty string when all validators pass', async () => {
    const exec: ValidatorExecFn = async () => ({ stdout: 'ok', stderr: '', exitCode: 0 });
    const results = await runTurnValidators([{ name: 'a', command: ['check'] }], {
      workspaceDir: '/ws',
      exec,
    });
    expect(validatorFailureMessage(results)).toBe('');
  });
});
