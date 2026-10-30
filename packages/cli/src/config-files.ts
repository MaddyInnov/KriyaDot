// SPDX-License-Identifier: Apache-2.0
// Multi-file CLI config (#115, CLI side) + config validation/init (#111).
//
// Multi-file: in addition to the main cli.json, every *.json file in the
// sibling cli.d/ directory is merged in ALPHABETICAL order (deep-merge,
// later files win), then cli.json itself is merged on top (the main file
// is the most specific). Files may be JSONC — // and /* */ comments are
// stripped by a string-aware scanner so `config init` can ship a
// commented template that still loads.
//
// TOML seam: no TOML parser exists anywhere in this workspace's
// dependency tree, and adding one was out of scope for this row, so
// *.toml files in cli.d/ are NOT parsed — they are reported by
// listConfigDropIns() with format 'toml' and skipped with a documented
// seam: drop a parser behind parseConfigText(text, 'toml') and they
// light up with no other changes.
//
// Migrations: a config may carry a numeric `version`. MIGRATIONS is the
// registry of step functions keyed by the version they upgrade FROM;
// migrateConfig() walks the chain to CURRENT_CONFIG_VERSION. The first
// registered migration (1 → 2) is intentionally a no-op example: it only
// stamps the new version, proving the chain runs end to end.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Strip line and block comments without touching string literals. */
export function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      if (i < text.length) out += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++; // land on '/', loop increment moves past it
      continue;
    }
    out += ch;
  }
  return out;
}

/** Parse config text in the given format. TOML is the documented seam (see header). */
export function parseConfigText(text: string, format: 'json' | 'toml'): Record<string, unknown> {
  if (format === 'toml') {
    throw new Error(
      'TOML config files are not parsed yet: no TOML parser exists in this workspace. Convert the file to JSON (same keys) — see config-files.ts for the seam.',
    );
  }
  const parsed = JSON.parse(stripJsonComments(text)) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('config file must contain a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep-merge source into target (source wins). Plain objects merge; arrays and scalars replace. */
export function deepMerge<T extends Record<string, unknown>>(target: T, source: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(source)) {
    const existing = out[key];
    if (isPlainObject(existing) && isPlainObject(value)) out[key] = deepMerge(existing, value);
    else out[key] = value;
  }
  return out as T;
}

export interface ConfigDropIn {
  path: string;
  format: 'json' | 'toml';
}

/** List the cli.d/ drop-in files in merge (alphabetical) order. */
export function listConfigDropIns(dir: string): ConfigDropIn[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') || f.endsWith('.toml'))
    .sort()
    .map((f) => ({ path: join(dir, f), format: f.endsWith('.toml') ? ('toml' as const) : ('json' as const) }));
}

/** Load + merge all drop-ins in `dir` (JSON only; TOML skipped via the seam). Bad files are skipped, never fatal. */
export function loadDropInConfig(dir: string): Record<string, unknown> {
  let merged: Record<string, unknown> = {};
  for (const drop of listConfigDropIns(dir)) {
    if (drop.format !== 'json') continue; // TOML seam — see header
    try {
      merged = deepMerge(merged, parseConfigText(readFileSync(drop.path, 'utf8'), 'json'));
    } catch {
      // A broken drop-in must not break the CLI; `config validate` reports it.
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

export const CURRENT_CONFIG_VERSION = 2;

export type ConfigMigration = (cfg: Record<string, unknown>) => Record<string, unknown>;

/** Registry keyed by the version a migration upgrades FROM. */
export const MIGRATIONS: Record<number, ConfigMigration> = {
  // 1 → 2: no-op example (first registered migration). Real migrations
  // rename/move keys here; this one only proves the chain + stamps v2.
  1: (cfg) => ({ ...cfg, version: 2 }),
};

/** Apply the migration chain to a raw config object. Unknown/future versions pass through untouched. */
export function migrateConfig(raw: Record<string, unknown>): Record<string, unknown> {
  let cfg = raw;
  let version = typeof cfg.version === 'number' && Number.isFinite(cfg.version) ? Math.floor(cfg.version) : 1;
  while (version < CURRENT_CONFIG_VERSION && MIGRATIONS[version]) {
    cfg = MIGRATIONS[version]!(cfg);
    version = typeof cfg.version === 'number' ? Math.floor(cfg.version) : version + 1;
  }
  return cfg;
}

// ---------------------------------------------------------------------------
// Validation + init template (#111)
// ---------------------------------------------------------------------------

/** Keys the CLI config understands (derived from config.ts CliConfig + sessions + version). */
export const KNOWN_CONFIG_KEYS = ['apiUrl', 'token', 'sessions', 'logLevel', 'version'] as const;

export interface ConfigValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/** Validate a raw (parsed) config object: hard errors for wrong types, warnings for unknown keys. */
export function validateConfigObject(raw: unknown): ConfigValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isPlainObject(raw)) {
    return { valid: false, errors: ['config must be a JSON object'], warnings };
  }
  for (const key of Object.keys(raw)) {
    if (!(KNOWN_CONFIG_KEYS as readonly string[]).includes(key)) {
      warnings.push(`unknown key "${key}" — ignored by this CLI version (typo? or a newer version's key?)`);
    }
  }
  if ('apiUrl' in raw && (typeof raw.apiUrl !== 'string' || !/^https?:\/\//i.test(raw.apiUrl))) {
    errors.push('"apiUrl" must be an http(s):// URL string');
  }
  if ('token' in raw && typeof raw.token !== 'string') errors.push('"token" must be a string');
  if ('logLevel' in raw && !['debug', 'info', 'warn', 'error', 'silent'].includes(raw.logLevel as string)) {
    errors.push('"logLevel" must be one of debug, info, warn, error, silent');
  }
  if ('version' in raw && typeof raw.version !== 'number') errors.push('"version" must be a number');
  if ('sessions' in raw) {
    if (!isPlainObject(raw.sessions)) {
      errors.push('"sessions" must be an object keyed by session name');
    } else {
      for (const [name, s] of Object.entries(raw.sessions)) {
        if (!isPlainObject(s) || typeof s.sessionId !== 'string' || typeof s.botId !== 'string') {
          errors.push(`sessions."${name}" must be an object with string sessionId and botId`);
        }
      }
    }
  }
  return { valid: errors.length === 0, errors, warnings };
}

/** The commented default config written by `kriyadot config init` (JSONC — loads via stripJsonComments). */
export function defaultConfigTemplate(): string {
  return [
    '{',
    '  // KriyaDot CLI config — see "kriyadot config validate" to check it.',
    '  // API base URL of the KriyaDot server (default http://localhost:4000).',
    '  "apiUrl": "http://localhost:4000",',
    '  // Auth token. Leave empty for a local server: the loopback token is',
    '  // picked up automatically. Prefer the KRIYADOT_TOKEN env var in CI.',
    '  "token": "",',
    '  // CLI diagnostic verbosity: debug | info | warn | error | silent.',
    '  // The KRIYADOT_LOG_LEVEL env var overrides this per process.',
    '  "logLevel": "info",',
    `  // Config schema version (migrations run automatically on load).`,
    `  "version": ${CURRENT_CONFIG_VERSION}`,
    '}',
    '',
  ].join('\n');
}
