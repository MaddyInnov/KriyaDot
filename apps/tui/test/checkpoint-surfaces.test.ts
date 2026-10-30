// SPDX-License-Identifier: Apache-2.0
// CA-18 status line, CA-19 keybindings, CA-28 terminal signals (TUI).

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_STATUS_LINE, detectGitBranch, renderStatusLine } from '../src/status-line.js';
import {
  DEFAULT_KEYBINDINGS,
  actionForEvent,
  chordForEvent,
  loadKeybindings,
  mergeKeybindings,
  normalizeChord,
} from '../src/keybindings.js';
import { emitTerminalSignal, signalSequence } from '../src/terminal-signals.js';
import { isKnownCommand, parseSlashCommand } from '../src/commands.js';

describe('renderStatusLine (CA-18)', () => {
  const ctx = { bot: 'Coder', model: 'llama-3.3-70b', cost: 0.123, contextPct: 42.4, gitBranch: 'main', session: 'abcdef123456' };

  it('renders every field', () => {
    expect(renderStatusLine('{bot} · {model} · {cost} · {contextPct} · {gitBranch} · {session}', ctx)).toBe(
      'Coder · llama-3.3-70b · $0.12 · 42% ctx · main · abcdef12',
    );
  });

  it('falls back to the default template and em dashes for unknown values', () => {
    expect(renderStatusLine(undefined, { bot: 'Coder' })).toBe('Coder · — · —');
    expect(renderStatusLine('', ctx)).toContain('Coder');
    expect(DEFAULT_STATUS_LINE).toContain('{bot}');
  });

  it('leaves unknown fields visible instead of swallowing them', () => {
    expect(renderStatusLine('{bot} {bogus}', ctx)).toBe('Coder {bogus}');
  });

  it('detectGitBranch uses the injected runner and tolerates failure', () => {
    expect(detectGitBranch('/x', () => 'feature/x\n')).toBe('feature/x');
    expect(
      detectGitBranch('/x', () => {
        throw new Error('no git');
      }),
    ).toBeUndefined();
  });
});

describe('keybindings (CA-19)', () => {
  it('normalizeChord canonicalizes and rejects junk', () => {
    expect(normalizeChord('Ctrl+T')).toBe('ctrl+t');
    expect(normalizeChord(' shift + Return ')).toBe('shift+enter');
    expect(normalizeChord('y')).toBe('y');
    expect(normalizeChord('hyper+x')).toBeNull();
    expect(normalizeChord('ctrl+')).toBeNull();
    expect(normalizeChord(42)).toBeNull();
  });

  it('mergeKeybindings applies valid overrides and warns on the rest', () => {
    const { bindings, warnings } = mergeKeybindings({ cancel: 'ctrl+x', bogus: 'q', approve: 'ctrl+9x', deny: 'ctrl+x' });
    expect(bindings.cancel).toBe('ctrl+x');
    expect(bindings.approve).toBe(DEFAULT_KEYBINDINGS.approve); // invalid chord ignored
    expect(bindings.deny).toBe(DEFAULT_KEYBINDINGS.deny); // conflicts with cancel's new chord
    expect(warnings.some((w) => w.includes('unknown action'))).toBe(true);
    expect(warnings.some((w) => w.includes('invalid chord'))).toBe(true);
    expect(warnings.some((w) => w.includes('already bound'))).toBe(true);
  });

  it('loadKeybindings reads the JSON file and survives corrupt content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tui-keybind-'));
    expect(loadKeybindings(dir).bindings).toEqual(DEFAULT_KEYBINDINGS);
    writeFileSync(join(dir, 'keybindings.json'), JSON.stringify({ approve: 'a' }), 'utf8');
    expect(loadKeybindings(dir).bindings.approve).toBe('a');
    writeFileSync(join(dir, 'keybindings.json'), '{broken', 'utf8');
    const bad = loadKeybindings(dir);
    expect(bad.bindings).toEqual(DEFAULT_KEYBINDINGS);
    expect(bad.warnings).toHaveLength(1);
  });

  it('chordForEvent / actionForEvent map Ink events to actions', () => {
    expect(chordForEvent('t', { ctrl: true })).toBe('ctrl+t');
    expect(chordForEvent('', { return: true })).toBe('enter');
    expect(actionForEvent(DEFAULT_KEYBINDINGS, 'y', {})).toBe('approve');
    expect(actionForEvent(DEFAULT_KEYBINDINGS, 'n', {})).toBe('deny');
    expect(actionForEvent(DEFAULT_KEYBINDINGS, 't', { ctrl: true })).toBe('cancel');
    expect(actionForEvent(DEFAULT_KEYBINDINGS, 'q', {})).toBeNull();
    const custom = { ...DEFAULT_KEYBINDINGS, approve: 'a' };
    expect(actionForEvent(custom, 'a', {})).toBe('approve');
    expect(actionForEvent(custom, 'y', {})).toBeNull();
  });

  it('/rewind and /diff are known TUI commands', () => {
    expect(isKnownCommand('rewind')).toBe(true);
    expect(isKnownCommand('diff')).toBe(true);
    expect(parseSlashCommand('/rewind 2 code')).toEqual({ name: 'rewind', args: '2 code' });
  });
});

describe('terminal signals (CA-28)', () => {
  it('emits bell and OSC sequences through the writer', () => {
    const out: string[] = [];
    emitTerminalSignal('bell', 'turn-complete', (s) => out.push(s));
    expect(out).toEqual(['\x07']);
    expect(signalSequence('osc', 'turn-complete')).toContain('\x1b]9;Turn complete\x07');
    expect(signalSequence('osc', 'turn-complete')).toContain('\x1b]777;notify;KriyaDot;Turn complete\x07');
    expect(signalSequence('off', 'approval-needed')).toBe('');
  });
});
