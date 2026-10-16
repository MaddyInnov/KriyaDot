// SPDX-License-Identifier: Apache-2.0
// Tests for argv parsing (args.ts): command splitting, flags, formats,
// short flags, the `--` separator, and command validation.
import { describe, expect, it } from 'vitest';
import { flagBool, flagString, parseArgs, requireFlag, validateCommand } from '../src/args.js';

describe('parseArgs', () => {
  it('splits command, subcommand and positionals', () => {
    const p = parseArgs(['threads', 'show', 'sess_1']);
    expect(p.command).toBe('threads');
    expect(p.subcommand).toBe('show');
    expect(p.positional).toEqual(['sess_1']);
  });

  it('parses chat <bot> message words', () => {
    const p = parseArgs(['chat', 'helper', 'summarize', 'this']);
    expect(p.command).toBe('chat');
    expect(p.subcommand).toBe('helper');
    expect(p.positional).toEqual(['summarize', 'this']);
  });

  it('parses --flag value and --flag=value forms', () => {
    const p = parseArgs(['run', '--bot', 'coder', '--message=hello world', '--auto-approve']);
    expect(p.flags['bot']).toBe('coder');
    expect(p.flags['message']).toBe('hello world');
    expect(p.flags['auto-approve']).toBe(true);
  });

  it('collects everything after -- as positional', () => {
    const p = parseArgs(['chat', 'helper', '--', '--not-a-flag']);
    expect(p.positional).toEqual(['--not-a-flag']);
  });

  it('handles global flags anywhere', () => {
    const p = parseArgs(['--format', 'json', 'bots', 'list', '--api', 'http://x:4000']);
    expect(p.global.format).toBe('json');
    expect(p.global.api).toBe('http://x:4000');
    expect(p.command).toBe('bots');
  });

  it('rejects a bad --format', () => {
    expect(() => parseArgs(['--format', 'yaml', 'bots', 'list'])).toThrow(/--format/);
  });

  it('supports -h and -V short flags', () => {
    expect(parseArgs(['-h']).global.help).toBe(true);
    expect(parseArgs(['-V']).global.version).toBe(true);
  });

  it('rejects unknown short flags', () => {
    expect(() => parseArgs(['-x'])).toThrow(/Unknown flag/);
  });

  it('lowercases the command but not positional values', () => {
    const p = parseArgs(['Chat', 'Helper', 'Hi There']);
    expect(p.command).toBe('chat');
    expect(p.subcommand).toBe('helper');
    expect(p.positional).toEqual(['Hi There']);
  });
});

describe('flag helpers', () => {
  it('requireFlag throws a usage error when missing', () => {
    expect(() => requireFlag({}, 'bot', 'Example: ...')).toThrow(/Missing --bot/);
    expect(requireFlag({ bot: 'coder' }, 'bot', '')).toBe('coder');
  });

  it('flagString returns undefined for missing/blank', () => {
    expect(flagString({}, 'x')).toBeUndefined();
    expect(flagString({ x: '  ' }, 'x')).toBeUndefined();
    expect(flagString({ x: ' v ' }, 'x')).toBe('v');
  });

  it('flagBool accepts true/1/true-string', () => {
    expect(flagBool({ f: true }, 'f')).toBe(true);
    expect(flagBool({ f: '1' }, 'f')).toBe(true);
    expect(flagBool({}, 'f')).toBe(false);
  });
});

describe('validateCommand', () => {
  it('accepts the full command table', () => {
    const ok: string[][] = [
      ['chat', 'helper', 'hi'],
      ['run', '--bot', 'coder', '--message', 'hi'],
      ['bots', 'list'],
      ['bots', 'run', 'coder', 'do it'],
      ['threads', 'list'],
      ['threads', 'show', 's1'],
      ['threads', 'branch', 's1'],
      ['routines', 'list'],
      ['routines', 'run', 'r1'],
      ['models', 'list'],
      ['mcp', 'list'],
      ['login'],
      ['config'],
      ['config', 'set', 'api', 'http://x'],
      ['help'],
      [],
    ];
    for (const argv of ok) {
      expect(validateCommand(parseArgs(argv)), argv.join(' ')).toBeNull();
    }
  });

  it('rejects unknown commands and bad subcommands', () => {
    expect(validateCommand(parseArgs(['frobnicate']))).toMatch(/Unknown command/);
    expect(validateCommand(parseArgs(['bots', 'delete']))).toMatch(/bots <list\|run>/);
    expect(validateCommand(parseArgs(['threads', 'merge']))).toMatch(/threads <list\|show\|branch>/);
    expect(validateCommand(parseArgs(['models', 'refresh']))).toMatch(/models list/);
    expect(validateCommand(parseArgs(['run']))).toMatch(/--bot/);
    expect(validateCommand(parseArgs(['bots', 'run']))).toMatch(/bots run <bot>/);
  });
});
