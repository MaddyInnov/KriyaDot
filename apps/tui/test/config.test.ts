// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, normalizeApiUrl, parseCliArgs, printHelp, saveConfig, DEFAULT_CONFIG } from '../src/config.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tui-config-'));
  vi.stubEnv('KRIYADOT_CONFIG_DIR', dir);
  vi.stubEnv('KRIYADOT_API_URL', '');
  vi.stubEnv('KRIYADOT_TUI_THEME', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('normalizeApiUrl', () => {
  it('strips trailing slashes', () => {
    expect(normalizeApiUrl('http://localhost:4000///')).toBe('http://localhost:4000');
  });

  it('rejects non-http URLs', () => {
    expect(() => normalizeApiUrl('ftp://x')).toThrow();
    expect(() => normalizeApiUrl('notaurl')).toThrow();
  });
});

describe('loadConfig/saveConfig', () => {
  it('returns defaults when no file exists', () => {
    expect(loadConfig()).toEqual(DEFAULT_CONFIG);
  });

  it('round-trips through disk', () => {
    saveConfig({ apiUrl: 'http://pi:4000', defaultBot: 'helper', theme: 'midnight' });
    expect(loadConfig()).toEqual({ apiUrl: 'http://pi:4000', defaultBot: 'helper', theme: 'midnight' });
  });

  it('ignores invalid theme names in the file', () => {
    saveConfig({ apiUrl: 'http://localhost:4000', defaultBot: '', theme: 'neon' as never });
    expect(loadConfig().theme).toBe('dark');
  });

  it('env overrides the file', () => {
    saveConfig({ apiUrl: 'http://file:4000', defaultBot: '', theme: 'dark' });
    vi.stubEnv('KRIYADOT_API_URL', 'http://env:4000');
    vi.stubEnv('KRIYADOT_TUI_THEME', 'ocean');
    const cfg = loadConfig();
    expect(cfg.apiUrl).toBe('http://env:4000');
    expect(cfg.theme).toBe('ocean');
  });

  it('survives a corrupt file', () => {
    writeFileSync(join(dir, 'tui.json'), '{not json', 'utf8');
    expect(loadConfig()).toEqual(DEFAULT_CONFIG);
  });
});

describe('parseCliArgs', () => {
  it('parses flags', () => {
    expect(parseCliArgs(['--api', 'http://x:4000', '--bot', 'helper', '--theme', 'porcelain'])).toEqual({
      api: 'http://x:4000',
      bot: 'helper',
      theme: 'porcelain',
    });
  });

  it('ignores invalid theme flag values', () => {
    expect(parseCliArgs(['--theme', 'neon'])).toEqual({});
  });

  it('ignores unknown flags', () => {
    expect(parseCliArgs(['--bogus', 'x'])).toEqual({});
  });

  it('printHelp documents the flags', () => {
    const h = printHelp();
    expect(h).toContain('--api');
    expect(h).toContain('--theme');
    expect(h).toContain('--bot');
  });
});
