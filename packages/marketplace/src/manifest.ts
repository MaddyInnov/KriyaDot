// SPDX-License-Identifier: Apache-2.0
/**
 * Manifest transforms (Octomind parity #158, #165).
 *
 * PLACEHOLDERS: manifest string fields may embed `{{env:NAME}}` or
 * `{{config:key}}` placeholders. At install time they are substituted
 * from a caller-provided values map. An unresolved placeholder is an
 * EXPLICIT BLOCKER — it never degrades to a silent null/empty string:
 * strict mode throws UnresolvedPlaceholdersError, lenient mode returns
 * the placeholder names in `blockers` and leaves the token in place so
 * the failure stays visible in the installed artifact.
 *
 * OVERRIDES: a per-capability/model override layer keyed by entry id
 * (or by `category:variant` package name) applied on top of the
 * manifest at install: model/provider swap, enabled flag, and config
 * values merged into the payload.
 *
 * TOOL FILTERS (#165): capability bundles carry allow/deny wildcard
 * patterns over tool names. Deny always wins; an empty allow list
 * means "allow everything not denied".
 */

import type { MarketplaceEntry } from './registry.js';

export interface PlaceholderValues {
  env?: Record<string, string>;
  config?: Record<string, string>;
}

const PLACEHOLDER_RE = /\{\{\s*(env|config):([A-Za-z0-9_.\-]+)\s*\}\}/g;

export class UnresolvedPlaceholdersError extends Error {
  readonly unresolved: string[];
  constructor(unresolved: string[]) {
    super(`unresolved manifest placeholders: ${unresolved.join(', ')}`);
    this.name = 'UnresolvedPlaceholdersError';
    this.unresolved = unresolved;
  }
}

/** Find every `{{env:X}}` / `{{config:key}}` token in a string. */
export function findPlaceholders(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(PLACEHOLDER_RE)) out.push(`${m[1]}:${m[2]}`);
  return out;
}

export interface SubstitutionResult<T> {
  value: T;
  /** Placeholder keys (`env:FOO`, `config:key`) that had no value. */
  unresolved: string[];
}

/** Deep-substitute placeholders in any JSON-shaped value. Pure: inputs are not mutated. */
export function substitutePlaceholders<T>(input: T, values: PlaceholderValues): SubstitutionResult<T> {
  const unresolved: string[] = [];
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      return v.replace(PLACEHOLDER_RE, (whole, ns: string, key: string) => {
        const table = ns === 'env' ? values.env : values.config;
        const replacement = table?.[key];
        if (replacement === undefined) {
          unresolved.push(`${ns}:${key}`);
          return whole; // leave the token visible — never a silent null
        }
        return replacement;
      });
    }
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === 'object' && v !== null) {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return { value: walk(input) as T, unresolved: [...new Set(unresolved)] };
}

// ---------------------------------------------------------------------------
// Per-capability / per-model overrides
// ---------------------------------------------------------------------------

export interface CapabilityOverride {
  model?: string;
  provider?: string;
  /** When false, the entry is installed but recorded disabled. */
  enabled?: boolean;
  /** Merged into the payload's `config` object (created when absent). */
  config?: Record<string, unknown>;
}

/** Keyed by entry id, bundle id, or `category:variant` package name. */
export type OverrideMap = Record<string, CapabilityOverride>;

export function lookupOverride(
  overrides: OverrideMap | undefined,
  keys: Array<string | undefined>,
): CapabilityOverride | undefined {
  if (!overrides) return undefined;
  for (const k of keys) if (k && overrides[k]) return overrides[k];
  return undefined;
}

/** Apply one override to a deep copy of an entry. Returns the copy + whether it applied. */
export function applyOverrideToEntry(
  entry: MarketplaceEntry,
  override: CapabilityOverride | undefined,
): { entry: MarketplaceEntry; applied: boolean } {
  if (!override) return { entry, applied: false };
  const copy = JSON.parse(JSON.stringify(entry)) as MarketplaceEntry & {
    enabledOverride?: boolean;
  };
  const payload = copy.payload as unknown as Record<string, unknown>;
  if (override.model !== undefined && typeof payload.model === 'string') payload.model = override.model;
  if (override.provider !== undefined && typeof payload.provider === 'string') payload.provider = override.provider;
  if (override.config) {
    const existing = (payload.config as Record<string, unknown> | undefined) ?? {};
    payload.config = { ...existing, ...override.config };
  }
  if (override.enabled !== undefined) copy.enabledOverride = override.enabled;
  return { entry: copy, applied: true };
}

// ---------------------------------------------------------------------------
// Combined install-time transform (#158)
// ---------------------------------------------------------------------------

export interface TransformOptions {
  values?: PlaceholderValues;
  overrides?: OverrideMap;
  /** Extra lookup keys for the override map (e.g. the bundle's package name). */
  overrideKeys?: string[];
  /**
   * 'throw' (default): unresolved placeholders throw.
   * 'block': unresolved placeholders are returned as blockers and the
   * tokens stay in place (used by bundle installs, which report rather
   * than abort the whole unit).
   */
  onUnresolved?: 'throw' | 'block';
}

export interface TransformedEntry {
  entry: MarketplaceEntry;
  blockers: string[];
  overrideApplied: boolean;
  enabled: boolean;
}

export function transformEntryForInstall(entry: MarketplaceEntry, opts: TransformOptions = {}): TransformedEntry {
  const override = lookupOverride(opts.overrides, [entry.id, ...(opts.overrideKeys ?? [])]);
  const { entry: overridden, applied } = applyOverrideToEntry(entry, override);
  const enabled = (overridden as { enabledOverride?: boolean }).enabledOverride ?? true;

  let finalEntry = overridden;
  let blockers: string[] = [];
  // Only run substitution when the manifest actually uses our placeholder
  // syntax OR values were supplied — workflow `{{input}}`/`{{nodes.x}}`
  // tokens are runtime syntax, not manifest placeholders, and the
  // regex above never matches them.
  const serialized = JSON.stringify(overridden);
  if (opts.values || findPlaceholders(serialized).length > 0) {
    const { value, unresolved } = substitutePlaceholders(overridden, opts.values ?? {});
    finalEntry = value;
    if (unresolved.length > 0) {
      if ((opts.onUnresolved ?? 'throw') === 'throw') throw new UnresolvedPlaceholdersError(unresolved);
      blockers = unresolved.map((u) => `unresolved-placeholder:${u}`);
    }
  }
  return { entry: finalEntry, blockers, overrideApplied: applied, enabled };
}

// ---------------------------------------------------------------------------
// Tool filters (#165 capability bundles)
// ---------------------------------------------------------------------------

export interface ToolFilters {
  allow: string[];
  deny: string[];
}

/** Wildcard match: `*` matches any run of characters (e.g. `fs_*`, `*_read`, `*`). */
export function toolMatchesPattern(tool: string, pattern: string): boolean {
  const re = new RegExp(
    '^' + pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$',
  );
  return re.test(tool);
}

/** Deny wins. Empty allow = allow all (subject to deny). */
export function isToolAllowed(tool: string, filters: ToolFilters): boolean {
  if (filters.deny.some((p) => toolMatchesPattern(tool, p))) return false;
  if (filters.allow.length === 0) return true;
  return filters.allow.some((p) => toolMatchesPattern(tool, p));
}

/** Filter a tool list through a capability's filters, preserving order. */
export function filterTools(tools: string[], filters: ToolFilters): string[] {
  return tools.filter((t) => isToolAllowed(t, filters));
}
