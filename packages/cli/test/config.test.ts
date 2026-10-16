// SPDX-License-Identifier: Apache-2.0
// Tests for CLI config (config.ts): URL normalization, loopback detection,
// config file load/save, and token resolution order.
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  configPath,
  isLoopbackUrl,
  loadConfigFile,
  normalizeApiUrl,
  resolveApiDataDir,
  resolveConfig,
  saveConfigFile,
} from '../src/config.js';

describe('config', () => {
  let dir: string;
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kriyadot-cli-'));
    savedEnv = { ...process.env };
    process.env.KRIYADOT_CONFIG_DIR = dir;
    delete process.env.KRIYADOT_API_URL;
    delete process.env.KRIYADOT_TOKEN;
    delete process.env.KRIYADOT_DATA_DIR;
    delete process.env.DATA_DIR;
  });

  afterEach(() => {
    process.env = savedEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  it('normalizes API URLs and rejects non-http(s)', () => {
    expect(normalizeApiUrl('http://localhost:4000/')).toBe('http://localhost:4000');
    expect(normalizeApiUrl('  https://example.com/// ')).toBe('https://example.com');
    expect(() => normalizeApiUrl('ftp://x')).toThrow(/Invalid API URL/);
    expect(() => normalizeApiUrl('notaurl')).toThrow(/Invalid API URL/);
  });

  it('detects loopback URLs', () => {
    expect(isLoopbackUrl('http://localhost:4000')).toBe(true);
    expect(isLoopbackUrl('http://127.0.0.1:4000')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:4000')).toBe(true);
    expect(isLoopbackUrl('https://example.com')).toBe(false);
    expect(isLoopbackUrl('garbage')).toBe(false);
  });

  it('falls back to defaults when no config file exists', () => {
    const cfg = loadConfigFile();
    expect(cfg.apiUrl).toBe('http://localhost:4000');
    expect(cfg.token).toBe('');
  });

  it('round-trips the config file with mode 0600', () => {
    saveConfigFile({ apiUrl: 'https://remote.example:4000', token: 'secret-token' });
    const cfg = loadConfigFile();
    expect(cfg.apiUrl).toBe('https://remote.example:4000');
    expect(cfg.token).toBe('secret-token');
    const mode = statSync(configPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('tolerates a corrupt config file', () => {
    writeFileSync(configPath(), 'not json{{{', 'utf8');
    const cfg = loadConfigFile();
    expect(cfg.apiUrl).toBe('http://localhost:4000');
  });

  it('resolves token from flag > file > env', () => {
    saveConfigFile({ apiUrl: 'http://localhost:4000', token: 'file-token' });
    process.env.KRIYADOT_TOKEN = 'env-token';
    // flag wins
    expect(resolveConfig({ token: 'flag-token' }).token).toBe('flag-token');
    // file wins over env
    expect(resolveConfig().token).toBe('file-token');
  });

  it('uses env token when no file token exists', () => {
    process.env.KRIYADOT_TOKEN = 'env-token';
    expect(resolveConfig().token).toBe('env-token');
  });

  it('falls back to the loopback token file for local APIs', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'kriyadot-data-'));
    process.env.KRIYADOT_DATA_DIR = dataDir;
    writeFileSync(join(dataDir, '.api-token'), 'loopback-abc\n', 'utf8');
    try {
      const cfg = resolveConfig();
      expect(cfg.token).toBe('loopback-abc');
      // ...but not for remote APIs
      saveConfigFile({ apiUrl: 'https://remote.example', token: '' });
      expect(resolveConfig().token).toBe('');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('resolves the API data dir from env', () => {
    process.env.KRIYADOT_DATA_DIR = '/tmp/custom-data';
    expect(resolveApiDataDir()).toBe('/tmp/custom-data');
  });
});
