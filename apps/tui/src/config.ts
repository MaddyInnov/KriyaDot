// SPDX-License-Identifier: Apache-2.0
// TUI configuration: ~/.kriyadot/tui.json with env/CLI overrides.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ThemeName } from './themes.js';
import { THEME_NAMES } from './themes.js';

export interface TuiConfig {
  /** API base URL, e.g. http://localhost:4000 */
  apiUrl: string;
  /** Bot id to select on startup (empty = show bot picker). */
  defaultBot: string;
  theme: ThemeName;
}

export const DEFAULT_CONFIG: TuiConfig = {
  apiUrl: 'http://localhost:4000',
  defaultBot: '',
  theme: 'dark',
};

export function configDir(): string {
  return process.env.KRIYADOT_CONFIG_DIR ?? join(homedir(), '.kriyadot');
}

export function configPath(): string {
  return join(configDir(), 'tui.json');
}

/** Load config from disk; missing/invalid files fall back to defaults. */
export function loadConfig(): TuiConfig {
  let file: Partial<TuiConfig> = {};
  try {
    if (existsSync(configPath())) {
      file = JSON.parse(readFileSync(configPath(), 'utf8')) as Partial<TuiConfig>;
    }
  } catch {
    file = {};
  }
  const cfg: TuiConfig = {
    apiUrl: typeof file.apiUrl === 'string' && file.apiUrl ? file.apiUrl : DEFAULT_CONFIG.apiUrl,
    defaultBot: typeof file.defaultBot === 'string' ? file.defaultBot : DEFAULT_CONFIG.defaultBot,
    theme: THEME_NAMES.includes(file.theme as ThemeName) ? (file.theme as ThemeName) : DEFAULT_CONFIG.theme,
  };
  // Environment overrides (highest precedence short of CLI flags).
  if (process.env.KRIYADOT_API_URL) cfg.apiUrl = process.env.KRIYADOT_API_URL;
  if (process.env.KRIYADOT_TUI_THEME && THEME_NAMES.includes(process.env.KRIYADOT_TUI_THEME as ThemeName)) {
    cfg.theme = process.env.KRIYADOT_TUI_THEME as ThemeName;
  }
  return cfg;
}

export function saveConfig(cfg: TuiConfig): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(configPath(), `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
}

/** Normalize a base URL: trim, strip trailing slashes. Rejects non-http(s). */
export function normalizeApiUrl(raw: string): string {
  const v = raw.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(v)) throw new Error(`Invalid API URL "${raw}" — expected http(s)://host[:port]`);
  return v;
}

/** Parse argv flags: --api <url> --bot <id> --theme <name> */
export function parseCliArgs(argv: string[]): { api?: string; bot?: string; theme?: ThemeName } {
  const out: { api?: string; bot?: string; theme?: ThemeName } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '--api' || a === '--bot' || a === '--theme') && i + 1 < argv.length) {
      const v = argv[++i];
      if (a === '--api') out.api = v;
      else if (a === '--bot') out.bot = v;
      else if (THEME_NAMES.includes(v as ThemeName)) out.theme = v as ThemeName;
    } else if (a === '--help' || a === '-h') {
      out.api = undefined; // no-op; index.tsx prints help when it sees the flag
    }
  }
  return out;
}

export function printHelp(): string {
  return [
    'kriyadot-tui — terminal client for KriyaDot',
    '',
    'Usage: kriyadot-tui [--api <url>] [--bot <id>] [--theme <name>]',
    '',
    '  --api    API base URL (default http://localhost:4000, env KRIYADOT_API_URL)',
    `  --theme  one of ${THEME_NAMES.join(', ')} (env KRIYADOT_TUI_THEME)`,
    '  --bot    bot id to open on startup',
    '',
    'Keys: ↑/↓ navigate · Enter select · Ctrl+C quit · /help lists commands',
  ].join('\n');
}
