// SPDX-License-Identifier: Apache-2.0
/**
 * Rich session tool-history entries (guardrails-as-code, #66).
 *
 * The governance engine matches `requiresHistory` rule conditions
 * against the session's tool history. Name-only entries can satisfy
 * name conditions, but argument-qualified conditions (argDigest /
 * argPattern) need the rich shape: { name, argDigest, argSummary }.
 *
 * The digest/summary formats are a WIRE CONVENTION shared with
 * @mvp/governance's history.ts (this package deliberately does not
 * import governance): canonical JSON = JSON with object keys sorted
 * recursively; argDigest = SHA-256 hex of the canonical JSON of the
 * args; argSummary = sorted `key=value` pairs, values truncated to
 * 200 chars, whole summary truncated to 500. The tests pin the digest
 * for a fixture so the two implementations cannot drift silently.
 */

import { createHash } from 'node:crypto';

export interface SessionToolHistoryEntry {
  name: string;
  argDigest?: string;
  argSummary?: string;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export function computeArgDigest(args: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(args ?? {}), 'utf8').digest('hex');
}

const SUMMARY_VALUE_MAX = 200;
const SUMMARY_MAX = 500;

export function summarizeArgs(args: Record<string, unknown>): string {
  const keys = Object.keys(args ?? {}).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const v = args[key];
    const text = typeof v === 'string' ? v : canonicalJson(v);
    parts.push(`${key}=${text.slice(0, SUMMARY_VALUE_MAX)}`);
  }
  return parts.join(' ').slice(0, SUMMARY_MAX);
}

/** Build the rich history entry for one executed tool call. */
export function makeToolHistoryEntry(
  name: string,
  args?: Record<string, unknown>,
): SessionToolHistoryEntry {
  if (!args) return { name };
  return { name, argDigest: computeArgDigest(args), argSummary: summarizeArgs(args) };
}
