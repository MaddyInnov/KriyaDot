// SPDX-License-Identifier: Apache-2.0
// Per-run config overrides: the repeatable `-c key=value` flag on
// `chat` / `run`. Overrides apply to that single invocation only — they
// are resolved in memory and are NEVER written to the config file.
// Unknown keys are a usage error: a typo like `-c mdoel=x` must fail
// loudly instead of silently running with the default model.
import { normalizeApiUrl } from './config.js';
import type { OutputFormat } from './args.js';

/** Keys `-c` may set. Deliberately small: the per-run knobs scripts need. */
export const OVERRIDE_KEYS = ['bot', 'provider', 'model', 'apiUrl', 'format'] as const;
export type OverrideKey = (typeof OVERRIDE_KEYS)[number];

export interface ConfigOverrides {
  bot?: string;
  provider?: string;
  model?: string;
  apiUrl?: string;
  format?: OutputFormat;
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
  for (const item of raw) {
    const eq = item.indexOf('=');
    if (eq <= 0) {
      throw new UsageError(`Invalid -c override "${item}" — expected key=value (keys: ${OVERRIDE_KEYS.join(', ')})`);
    }
    const key = item.slice(0, eq).trim();
    const value = item.slice(eq + 1).trim();
    if (!(OVERRIDE_KEYS as readonly string[]).includes(key)) {
      throw new UsageError(`Unknown -c key "${key}". Supported keys: ${OVERRIDE_KEYS.join(', ')}`);
    }
    if (!value) throw new UsageError(`-c ${key}= needs a non-empty value`);
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
  return out;
}
