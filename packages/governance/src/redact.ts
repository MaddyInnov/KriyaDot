// SPDX-License-Identifier: Apache-2.0

/** Placeholder substituted for any secret value. */
export const REDACTED = '[REDACTED]';

/**
 * Matches object keys whose values must be treated as secrets:
 * api keys, tokens, secrets, passwords, auth headers, bearer tokens, cookies.
 */
export const SECRET_KEY_RE =
  /api[_-]?key|token|secret|password|passwd|authorization|bearer|cookie/i;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}

/**
 * Recursively clone `value`, replacing any value stored under a secret-like
 * key with '[REDACTED]'. The input is never mutated.
 *
 * Cycle-safe: circular references are replaced with '[CIRCULAR]'.
 */
export function redactSecrets<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  if (seen.has(value)) {
    return '[CIRCULAR]' as unknown as T;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const out = value.map((item) => redactSecrets(item, seen));
    return out as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    out[key] = isSecretKey(key) ? REDACTED : redactSecrets(entryValue, seen);
  }
  return out as unknown as T;
}
