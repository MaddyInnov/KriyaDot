// SPDX-License-Identifier: Apache-2.0
// CLI configuration: ~/.kriyadot/cli.json (KRIYADOT_CONFIG_DIR to override).
//
// Resolution order for the API URL and the auth token:
//   1. explicit CLI flags (--api, --token)
//   2. the config file
//   3. environment (KRIYADOT_API_URL, KRIYADOT_TOKEN)
//   4. for a loopback API URL: the per-boot bearer <redacted> the API writes to
//      <dataDir>/.api-token (KRIYADOT_DATA_DIR, else ./data under the cwd),
//      exactly like the TUI does.
//
// The token file is written with mode 0600 and is never printed.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface CliConfig {
  /** API base URL, e.g. http://localhost:4000 */
  apiUrl: string;
  /** Bearer token for the loopback auth (empty = unresolved). */
  token: string;
}

export const DEFAULT_API_URL = 'http://localhost:4000';
export const LOOPBACK_TOKEN_FILENAME = '.api-token';

export function configDir(): string {
  return process.env.KRIYADOT_CONFIG_DIR ?? join(homedir(), '.kriyadot');
}

export function configPath(): string {
  return join(configDir(), 'cli.json');
}

/** Normalize a base URL: trim, strip trailing slashes. Rejects non-http(s). */
export function normalizeApiUrl(raw: string): string {
  const v = raw.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(v)) {
    throw new Error(`Invalid API URL "${raw}" — expected http(s)://host[:port]`);
  }
  return v;
}

export function loadConfigFile(): CliConfig {
  const fallback: CliConfig = { apiUrl: DEFAULT_API_URL, token: '' };
  let file: Partial<CliConfig> = {};
  try {
    if (existsSync(configPath())) {
      file = JSON.parse(readFileSync(configPath(), 'utf8')) as Partial<CliConfig>;
    }
  } catch {
    file = {};
  }
  const apiUrl =
    typeof file.apiUrl === 'string' && file.apiUrl ? safeNormalize(file.apiUrl) ?? DEFAULT_API_URL : DEFAULT_API_URL;
  const token = typeof file.token === 'string' ? file.token.trim() : '';
  return { apiUrl, token };
}

function safeNormalize(raw: string): string | null {
  try {
    return normalizeApiUrl(raw);
  } catch {
    return null;
  }
}

/** Persist the config (mode 0600 — it may hold the API token). */
export function saveConfigFile(cfg: CliConfig): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(configPath(), `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(configPath(), 0o600);
  } catch {
    // best effort on filesystems without chmod
  }
}

/**
 * Resolve the API's data dir the same way apps/api's loadConfig() does:
 * KRIYADOT_DATA_DIR (DATA_DIR alias), else ./data under the cwd.
 */
export function resolveApiDataDir(): string {
  const fromEnv = process.env.KRIYADOT_DATA_DIR ?? process.env.DATA_DIR;
  return fromEnv ? resolve(fromEnv) : resolve(process.cwd(), 'data');
}

/** Read the per-boot loopback bearer <redacted> the API writes to <dataDir>/.api-token. */
export function readLoopbackToken(dataDir: string = resolveApiDataDir()): string | null {
  try {
    const token = readFileSync(join(dataDir, LOOPBACK_TOKEN_FILENAME), 'utf8').trim();
    return token || null;
  } catch {
    return null;
  }
}

/** True for API URLs that resolve to the local machine (loopback token applies). */
export function isLoopbackUrl(apiUrl: string): boolean {
  try {
    const host = new URL(apiUrl).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

/** Effective config after flags, file, env and the loopback token fallback. */
export function resolveConfig(opts: { api?: string; token?: string } = {}): CliConfig {
  const file = loadConfigFile();
  let apiUrl = file.apiUrl;
  if (opts.api) apiUrl = normalizeApiUrl(opts.api);
  else if (process.env.KRIYADOT_API_URL) apiUrl = normalizeApiUrl(process.env.KRIYADOT_API_URL);

  let token = opts.token?.trim() || file.token || process.env.KRIYADOT_TOKEN?.trim() || '';
  if (!token && isLoopbackUrl(apiUrl)) {
    token = readLoopbackToken() ?? '';
  }
  return { apiUrl, token };
}

/** Where the resolved token came from (for helpful error messages). */
export function tokenSource(opts: { token?: string } = {}): string {
  if (opts.token?.trim()) return 'the --token flag';
  const file = loadConfigFile();
  if (file.token) return `the config file (${configPath()})`;
  if (process.env.KRIYADOT_TOKEN?.trim()) return 'KRIYADOT_TOKEN';
  return 'the API loopback token file';
}
