// SPDX-License-Identifier: Apache-2.0
/**
 * Argument-qualified session history (#66).
 *
 * Session history used to record tool NAMES only, so a
 * `requiresHistory` condition could express "review ran" but not
 * "shell ran with command matching git status". This module defines
 * the contract the runtime records and the gateway matches against:
 *
 *   SessionHistoryEntry = { name, argDigest?, argSummary? }
 *
 * - `argDigest` is a SHA-256 hex digest over the canonical JSON of the
 *   call arguments (object keys sorted recursively), produced by
 *   {@link computeArgDigest}. It lets a policy demand an EXACT prior
 *   call without governance ever seeing the raw arguments.
 * - `argSummary` is a compact string built by {@link summarizeArgs}
 *   ("command=git status path=src"), matched by RegExp. It is a
 *   matcher aid, NOT a secret store: runtimes must build it from
 *   already-redacted arguments (the gateway's own audit path redacts;
 *   history summaries are the runtime's responsibility — keep them
 *   short and free of credentials).
 *
 * Backward compatibility: legacy entries are plain strings (name
 * only). They satisfy name-only conditions exactly as before and NEVER
 * satisfy an argument-qualified condition (fail-closed).
 */

import { createHash } from 'node:crypto';
import type { SessionHistoryEntry, SessionToolHistory } from './types.js';

/** Canonical JSON: object keys sorted recursively, arrays preserved. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/** SHA-256 hex digest of a tool call's arguments (canonical JSON). */
export function computeArgDigest(args: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(args ?? {}), 'utf8').digest('hex');
}

const SUMMARY_VALUE_MAX = 200;
const SUMMARY_MAX = 500;

/**
 * Compact, deterministic argument summary for pattern matching:
 * `key=value` pairs sorted by key, values stringified (objects via
 * canonical JSON) and truncated. Example: `{command: 'git status'}`
 * → `"command=git status"`, so a history `argPattern` of
 * `command=git\\s+status` (or just `git status`) matches.
 */
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

/** Build a rich history entry for one executed tool call. */
export function makeHistoryEntry(
  name: string,
  args?: Record<string, unknown>,
): SessionHistoryEntry {
  if (!args) return { name };
  return { name, argDigest: computeArgDigest(args), argSummary: summarizeArgs(args) };
}

/** Tool name of either history entry shape. */
export function historyEntryName(entry: string | SessionHistoryEntry): string {
  return typeof entry === 'string' ? entry : entry.name;
}

/** Normalize either shape to a rich entry (legacy strings get no digest/summary). */
export function normalizeHistoryEntry(entry: string | SessionHistoryEntry): SessionHistoryEntry {
  return typeof entry === 'string' ? { name: entry } : entry;
}

/**
 * Does one history entry satisfy a `requiresHistory` condition?
 *
 * Name must match `toolPattern` (case-insensitive RegExp). When the
 * condition is argument-qualified, the entry must be a rich entry
 * carrying the exact `argDigest` and/or an `argSummary` matching
 * `argPattern`; legacy name-only entries and missing fields fail
 * closed, as do invalid patterns.
 */
export function historyEntryMatches(
  entry: string | SessionHistoryEntry,
  condition: { toolPattern: string; argDigest?: string; argPattern?: string },
): boolean {
  let nameRe: RegExp;
  try {
    nameRe = new RegExp(condition.toolPattern, 'i');
  } catch {
    return false;
  }
  const rich = normalizeHistoryEntry(entry);
  if (!nameRe.test(rich.name)) return false;
  if (condition.argDigest !== undefined) {
    if (!rich.argDigest) return false;
    if (rich.argDigest.toLowerCase() !== condition.argDigest.toLowerCase()) return false;
  }
  if (condition.argPattern !== undefined) {
    if (!rich.argSummary) return false;
    let argRe: RegExp;
    try {
      argRe = new RegExp(condition.argPattern);
    } catch {
      return false;
    }
    if (!argRe.test(rich.argSummary)) return false;
  }
  return true;
}

/** Count history entries satisfying a `requiresHistory` condition. */
export function countMatchingHistory(
  history: SessionToolHistory | undefined,
  condition: { toolPattern: string; minCount?: number; argDigest?: string; argPattern?: string },
): number {
  if (!history) return 0;
  return history.filter((e) => historyEntryMatches(e, condition)).length;
}
