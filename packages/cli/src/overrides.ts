// SPDX-License-Identifier: Apache-2.0
// Per-run config overrides: the repeatable `-c key=value` flag on
// `chat` / `run`. Overrides apply to that single invocation only — they
// are resolved in memory and are NEVER written to the config file.
// Unknown keys are a usage error: a typo like `-c mdoel=x` must fail
// loudly instead of silently running with the default model.
import { normalizeApiUrl } from './config.js';
import type { OutputFormat } from './args.js';

/** Keys `-c` may set directly. Deliberately small: the per-run knobs scripts need. */
export const OVERRIDE_KEYS = ['bot', 'provider', 'model', 'apiUrl', 'format'] as const;
export type OverrideKey = (typeof OVERRIDE_KEYS)[number];

/**
 * Top-level roots allowed for DOTTED overrides (#110): `-c bot.temperature=0.7`
 * builds a nested run-config object. The root must be a known config root —
 * an unknown root (a typo like `-c mdoel.x=1`, or a bare unknown key like
 * `-c bogus=1`) is rejected with a helpful error, because silently ignoring
 * an override is worse than failing. Nested paths below a known root are
 * free-form: the runtime owns the nested schema, not the CLI.
 */
export const OVERRIDE_ROOTS = [...OVERRIDE_KEYS, 'session', 'run', 'daemon', 'ui', 'limits'] as const;

export interface ConfigOverrides {
  bot?: string;
  provider?: string;
  model?: string;
  apiUrl?: string;
  format?: OutputFormat;
  /** Dotted-path overrides (#110), e.g. { bot: { temperature: 0.7 } } from `-c bot.temperature=0.7`. */
  nested?: Record<string, unknown>;
}

/** Coerce a raw `-c` value: true/false → boolean, numeric → number, {/[ → JSON, else the string. */
export function coerceOverrideValue(raw: string): unknown {
  const v = raw.trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(v)) return Number(v);
  if (v.startsWith('{') || v.startsWith('[')) {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}

/** Set a dotted path (already split) into an object, creating intermediate objects. */
export function setDottedPath(target: Record<string, unknown>, path: string[], value: unknown): void {
  let cur = target;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!;
    const next = cur[key];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) cur[key] = {};
    cur = cur[key] as Record<string, unknown>;
  }
  cur[path[path.length - 1]!] = value;
}

/** An error in how the CLI was invoked (maps to exit code 2). */
export class UsageError extends Error {}

const FORMATS: readonly string[] = ['text', 'json', 'jsonl'];

/**
 * Parse raw `-c` strings ("key=value", repeatable; later wins) into a
 * typed override set. Throws UsageError on a malformed pair, an unknown
 * key, an empty value, a bad format, or a non-http(s) apiUrl.
 */
export function parseConfigOverrides(raw: readonly string[]): ConfigOverrides {
  const out: ConfigOverrides = {};
  const nested: Record<string, unknown> = {};
  let hasNested = false;
  for (const item of raw) {
    const eq = item.indexOf('=');
    if (eq <= 0) {
      throw new UsageError(`Invalid -c override "${item}" — expected key=value (keys: ${OVERRIDE_KEYS.join(', ')})`);
    }
    const key = item.slice(0, eq).trim();
    const value = item.slice(eq + 1).trim();
    if (!value) throw new UsageError(`-c ${key}= needs a non-empty value`);
    if (key.includes('.')) {
      // Dotted path (#110): root must be known; the rest is free-form.
      const path = key.split('.').map((s) => s.trim());
      if (path.some((s) => !s)) throw new UsageError(`Invalid -c key "${key}" — empty path segment`);
      if (!(OVERRIDE_ROOTS as readonly string[]).includes(path[0]!)) {
        throw new UsageError(
          `Unknown -c key "${key}". Supported keys: ${OVERRIDE_KEYS.join(', ')}; dotted paths must start with one of: ${OVERRIDE_ROOTS.join(', ')}`,
        );
      }
      setDottedPath(nested, path, coerceOverrideValue(value));
      hasNested = true;
      continue;
    }
    if (!(OVERRIDE_KEYS as readonly string[]).includes(key)) {
      throw new UsageError(`Unknown -c key "${key}". Supported keys: ${OVERRIDE_KEYS.join(', ')}`);
    }
    switch (key as OverrideKey) {
      case 'bot':
        out.bot = value;
        break;
      case 'provider':
        out.provider = value;
        break;
      case 'model':
        out.model = value;
        break;
      case 'format':
        if (!FORMATS.includes(value)) {
          throw new UsageError(`-c format= must be one of ${FORMATS.join(', ')}, got "${value}"`);
        }
        out.format = value as OutputFormat;
        break;
      case 'apiUrl':
        try {
          out.apiUrl = normalizeApiUrl(value);
        } catch {
          throw new UsageError(`-c apiUrl= must be an http(s) URL, got "${value}"`);
        }
        break;
    }
  }
  if (hasNested) out.nested = nested;
  return out;
}
