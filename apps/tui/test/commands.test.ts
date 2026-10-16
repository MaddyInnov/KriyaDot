// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { helpText, isKnownCommand, parseSlashCommand } from '../src/commands.js';

describe('parseSlashCommand', () => {
  it('returns null for plain messages', () => {
    expect(parseSlashCommand('hello there')).toBeNull();
    expect(parseSlashCommand('')).toBeNull();
    expect(parseSlashCommand('  /bots  ')).toEqual({ name: 'bots', args: '' });
  });

  it('parses a bare command', () => {
    expect(parseSlashCommand('/bots')).toEqual({ name: 'bots', args: '' });
    expect(parseSlashCommand('/QUIT')).toEqual({ name: 'quit', args: '' });
  });

  it('parses a command with args', () => {
    expect(parseSlashCommand('/model llama-3.3-70b')).toEqual({ name: 'model', args: 'llama-3.3-70b' });
    expect(parseSlashCommand('/theme   midnight  ')).toEqual({ name: 'theme', args: 'midnight' });
  });

  it('parses unknown commands so the UI can report them', () => {
    expect(parseSlashCommand('/frobnicate x')).toEqual({ name: 'frobnicate', args: 'x' });
  });

  it('handles a lone slash', () => {
    expect(parseSlashCommand('/')).toEqual({ name: '', args: '' });
  });
});

describe('isKnownCommand', () => {
  it('knows the documented commands', () => {
    for (const c of ['bots', 'model', 'workflows', 'memory', 'activity', 'theme', 'clear', 'help', 'quit']) {
      expect(isKnownCommand(c)).toBe(true);
    }
  });

  it('rejects unknown commands', () => {
    expect(isKnownCommand('frobnicate')).toBe(false);
    expect(isKnownCommand('')).toBe(false);
  });
});

describe('helpText', () => {
  it('mentions every known command', () => {
    const text = helpText();
    for (const c of ['/bots', '/model', '/workflows', '/memory', '/activity', '/theme', '/clear', '/help', '/quit']) {
      expect(text).toContain(c);
    }
  });
});
