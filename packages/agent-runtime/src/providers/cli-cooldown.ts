// SPDX-License-Identifier: Apache-2.0
// Cooldown registry for subscription CLI bridge backends (Timon parity A1 §2).
//
// Why this module exists
// ----------------------
// Before A1, a bridge backend that hit its plan limit was retried blindly
// on the next turn (and the one after), because nothing remembered WHY it
// died. This registry classifies bridge failures into three families with
// different revival semantics, persists them beside the existing provider
// state (a JSON file in the API data dir, written atomically with the same
// temp+rename idiom as providers.local.json), and is consulted by the
// runtime's resolver: a backend in active cooldown is SKIPPED with the
// reason visible — never retried blindly.
//
// Families
// --------
// - `rate_limit`: the window is exhausted but self-heals at its reset.
//   Active until the provider's reset instant (or retry-after / default
//   backoff when no reset was reported); then it expires on its own.
// - `exhausted`: credits / balance / plan hard-limit. Time alone does NOT
//   revive it — only a top-up/reset event reported by the host, a success,
//   or a manual user re-check (the Providers "Re-check" action) clears it.
// - `unavailable`: a circuit breaker. After N consecutive sterile turns
//   (a turn that completes with no content) or failed turns of a
//   non-limit class, the backend is skipped for a backoff window that
//   doubles on each re-open (capped). When the window lapses the breaker
//   is HALF-OPEN: one probe turn is allowed; success closes it, failure
//   re-opens it with the next backoff.
//
// Account dimension (A6 readiness): every entry is keyed by
// (bridgeId, accountId) — 'default' until multiple sign-ins land — so the
// store needs no rewrite when A6 adds accounts.
//
// The registry is deliberately bridge-scoped: API providers keep their
// existing W1 failover/health machinery. Failure classification reuses
// failover.ts (classifyProviderError / computeResumeAtMs) so "limit"
// means exactly the same thing everywhere in the runtime.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { classifyProviderError, computeResumeAtMs, type ClassifiedProviderError } from '../failover.js';
import type { CliBridgeId } from './cli-bridge.js';
import { DEFAULT_BRIDGE_ACCOUNT_ID } from './cli-usage.js';

export type CooldownFamily = 'rate_limit' | 'exhausted' | 'unavailable';

export interface CooldownEntry {
  bridgeId: CliBridgeId;
  accountId: string;
  family: CooldownFamily;
  /** Plain-words reason the backend is cooled (shown in UI + swap notices). */
  reason: string;
  /** Epoch ms the cooldown began. */
  sinceMs: number;
  /**
   * Epoch ms the cooldown lapses, or null when time alone never revives
   * it (`exhausted`). For `unavailable` this is the backoff deadline —
   * after it, the breaker is half-open.
   */
  untilMs: number | null;
  /** Consecutive failed turns (any class) since the last success. */
  consecutiveFailures: number;
  /** Consecutive sterile (empty-content) turns since the last success. */
  sterileStreak: number;
  /** How many times the circuit breaker has opened for this backend. */
  openCount: number;
  /** Backoff applied at the latest `unavailable` opening. */
  backoffMs: number;
}

export interface CooldownCheck {
  /** True while the backend must be skipped. */
  active: boolean;
  /** True when an `unavailable` backoff has lapsed and one probe is allowed. */
  halfOpen: boolean;
  entry?: CooldownEntry;
  /** Plain-words skip reason (set when active or halfOpen). */
  reason?: string;
}

/** Phrasing that means "money/plan is gone", not "window is full". */
const EXHAUSTED_TEXT_RE =
  /out of credits|insufficient (?:credits|balance)|billing hard limit|hard limit reached|plan limit (?:reached|exceeded)|quota exhausted|credits exhausted|no credits remaining/i;

/**
 * Classify a bridge failure into a cooldown family. Returns null when the
 * failure is not a limit-class death (the circuit breaker counts those
 * separately via the registry's recordFailure).
 */
export function classifyBridgeFailure(
  err: unknown,
  opts: { providerId?: string; nowMs?: number } = {},
): { family: Extract<CooldownFamily, 'rate_limit' | 'exhausted'>; untilMs: number | null; reason: string; classified: ClassifiedProviderError } | null {
  const classified = classifyProviderError(err, opts);
  const message = classified.message;
  if (EXHAUSTED_TEXT_RE.test(`${classified.code ?? ''} ${message}`)) {
    return {
      family: 'exhausted',
      untilMs: null,
      reason: `plan/credits exhausted (${message.slice(0, 140)}) — revives only on a top-up/reset event or a manual re-check`,
      classified,
    };
  }
  if (classified.isLimit) {
    const untilMs = computeResumeAtMs(classified, { nowMs: opts.nowMs });
    return {
      family: 'rate_limit',
      untilMs,
      reason: `usage limit reached — window resets at ${new Date(untilMs).toISOString()}`,
      classified,
    };
  }
  return null;
}

/** True when a completed bridge turn produced no usable content (sterile). */
export function isSterileBridgeContent(content: string): boolean {
  const stripped = content
    .split('\n')
    .filter((l) => !/^\[external agent CLI \(/.test(l.trim()))
    .join('\n')
    .trim();
  return stripped.length === 0;
}

export interface BridgeCooldownRegistryOptions {
  /** JSON persistence file (beside providers.local.json). Unset = in-memory only. */
  filePath?: string;
  now?: () => number;
  /** Consecutive sterile/failed turns that open the circuit breaker. Default 3. */
  unavailableThreshold?: number;
  /** First circuit-breaker backoff. Default 60s. */
  baseBackoffMs?: number;
  /** Backoff cap. Default 30 min. */
  maxBackoffMs?: number;
}

interface PersistedCooldownFile {
  version: 1;
  entries: CooldownEntry[];
}

export class BridgeCooldownRegistry {
  private readonly entries = new Map<string, CooldownEntry>();
  private readonly filePath?: string;
  private readonly now: () => number;
  private readonly threshold: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;

  constructor(opts: BridgeCooldownRegistryOptions = {}) {
    this.filePath = opts.filePath;
    this.now = opts.now ?? (() => Date.now());
    this.threshold = Math.max(1, opts.unavailableThreshold ?? 3);
    this.baseBackoffMs = Math.max(1000, opts.baseBackoffMs ?? 60_000);
    this.maxBackoffMs = Math.max(this.baseBackoffMs, opts.maxBackoffMs ?? 30 * 60_000);
    this.load();
  }

  static key(bridgeId: string, accountId: string): string {
    return `${bridgeId}:${accountId}`;
  }

  private load(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as PersistedCooldownFile;
      if (parsed && parsed.version === 1 && Array.isArray(parsed.entries)) {
        for (const e of parsed.entries) {
          if (e && typeof e.bridgeId === 'string' && typeof e.accountId === 'string') {
            this.entries.set(BridgeCooldownRegistry.key(e.bridgeId, e.accountId), e);
          }
        }
      }
    } catch {
      // Corrupt state must never break turns: start empty (the file is
      // rewritten on the next mutation).
      console.warn(`[cli-cooldown] ignoring unreadable cooldown state at ${this.filePath}`);
      this.entries.clear();
    }
  }

  private save(): void {
    if (!this.filePath) return;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const payload: PersistedCooldownFile = { version: 1, entries: [...this.entries.values()] };
      const tmp = `${this.filePath}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
      renameSync(tmp, this.filePath);
    } catch (err) {
      console.warn(`[cli-cooldown] could not persist cooldown state: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private backoffFor(openCount: number): number {
    return Math.min(this.maxBackoffMs, this.baseBackoffMs * 2 ** Math.max(0, openCount - 1));
  }

  private openBreaker(entry: CooldownEntry, why: string): CooldownEntry {
    entry.openCount += 1;
    entry.backoffMs = this.backoffFor(entry.openCount);
    entry.family = 'unavailable';
    entry.untilMs = this.now() + entry.backoffMs;
    entry.reason = `${why} — circuit breaker open (attempt ${entry.openCount}), retry after ${new Date(entry.untilMs).toISOString()}`;
    return entry;
  }

  private blank(bridgeId: CliBridgeId, accountId: string): CooldownEntry {
    return {
      bridgeId,
      accountId,
      family: 'unavailable',
      reason: '',
      sinceMs: this.now(),
      untilMs: null,
      consecutiveFailures: 0,
      sterileStreak: 0,
      openCount: 0,
      backoffMs: 0,
    };
  }

  /**
   * Record a failed bridge turn. Limit-class deaths set `rate_limit` /
   * `exhausted` immediately; other failures count toward the circuit
   * breaker. Returns the resulting entry when a cooldown is (now) in
   * effect for limit-class deaths, else the entry-or-undefined for
   * breaker bookkeeping.
   */
  recordFailure(bridgeId: CliBridgeId, accountId: string, err: unknown): CooldownEntry | undefined {
    const key = BridgeCooldownRegistry.key(bridgeId, accountId);
    const existing = this.entries.get(key);
    const limit = classifyBridgeFailure(err, { nowMs: this.now() });
    if (limit) {
      const entry: CooldownEntry = {
        ...(existing ?? this.blank(bridgeId, accountId)),
        bridgeId,
        accountId,
        family: limit.family,
        reason: limit.reason,
        sinceMs: this.now(),
        untilMs: limit.untilMs,
        consecutiveFailures: (existing?.consecutiveFailures ?? 0) + 1,
        sterileStreak: existing?.sterileStreak ?? 0,
      };
      this.entries.set(key, entry);
      this.save();
      return entry;
    }
    // Non-limit failure: breaker bookkeeping. An existing limit cooldown
    // stays as-is (the failure doesn't extend a window reset).
    if (existing && (existing.family === 'rate_limit' || existing.family === 'exhausted')) {
      existing.consecutiveFailures += 1;
      this.save();
      return existing;
    }
    const entry = existing ?? this.blank(bridgeId, accountId);
    entry.consecutiveFailures += 1;
    const wasHalfOpen = existing !== undefined && existing.family === 'unavailable' && existing.untilMs !== null && existing.untilMs <= this.now();
    if (wasHalfOpen || entry.consecutiveFailures >= this.threshold) {
      this.openBreaker(entry, `backend failed ${entry.consecutiveFailures} consecutive turn(s)`);
      entry.sinceMs = this.now();
    }
    this.entries.set(key, entry);
    this.save();
    return entry.family === 'unavailable' && entry.untilMs !== null && entry.untilMs > this.now() ? entry : undefined;
  }

  /** Record a sterile (empty-content) completed turn; may open the breaker. */
  recordSterileTurn(bridgeId: CliBridgeId, accountId: string): CooldownEntry | undefined {
    const key = BridgeCooldownRegistry.key(bridgeId, accountId);
    const existing = this.entries.get(key);
    if (existing && (existing.family === 'rate_limit' || existing.family === 'exhausted')) {
      return existing; // a limit cooldown already explains the silence
    }
    const entry = existing ?? this.blank(bridgeId, accountId);
    entry.sterileStreak += 1;
    entry.consecutiveFailures += 1;
    const wasHalfOpen = existing !== undefined && existing.family === 'unavailable' && existing.untilMs !== null && existing.untilMs <= this.now();
    if (wasHalfOpen || entry.sterileStreak >= this.threshold) {
      this.openBreaker(entry, `${entry.sterileStreak} consecutive sterile (empty) turn(s)`);
      entry.sinceMs = this.now();
    }
    this.entries.set(key, entry);
    this.save();
    return entry.family === 'unavailable' && entry.untilMs !== null && entry.untilMs > this.now() ? entry : undefined;
  }

  /** A successful turn closes the breaker and clears any cooldown. */
  recordSuccess(bridgeId: CliBridgeId, accountId: string): void {
    const key = BridgeCooldownRegistry.key(bridgeId, accountId);
    if (this.entries.delete(key)) this.save();
  }

  /**
   * Manual revival: the user re-checked the account (Providers UI), or the
   * host learned of a top-up / plan reset event. Clears `exhausted` and
   * `unavailable` entries and resets the counters. A `rate_limit` entry is
   * NOT cleared by a re-check before its reset — the window is the
   * provider's, not ours — unless `force` is set (the re-check probe
   * itself succeeded, which the caller signals via recordSuccess instead).
   */
  recheck(bridgeId: CliBridgeId, accountId: string): boolean {
    const key = BridgeCooldownRegistry.key(bridgeId, accountId);
    const entry = this.entries.get(key);
    if (!entry) return false;
    if (entry.family === 'rate_limit') return false;
    this.entries.delete(key);
    this.save();
    return true;
  }

  /** A top-up / plan-reset event revives even a `rate_limit` entry early. */
  recordTopUp(bridgeId: CliBridgeId, accountId: string): void {
    const key = BridgeCooldownRegistry.key(bridgeId, accountId);
    if (this.entries.delete(key)) this.save();
  }

  /** Consult the registry before resolving/spawning a backend. */
  check(bridgeId: CliBridgeId, accountId: string): CooldownCheck {
    const key = BridgeCooldownRegistry.key(bridgeId, accountId);
    const entry = this.entries.get(key);
    if (!entry) return { active: false, halfOpen: false };
    const nowMs = this.now();
    if (entry.family === 'rate_limit') {
      if (entry.untilMs !== null && entry.untilMs > nowMs) {
        return { active: true, halfOpen: false, entry, reason: entry.reason };
      }
      // Window lapsed: self-healed. Drop the stale entry lazily.
      this.entries.delete(key);
      this.save();
      return { active: false, halfOpen: false };
    }
    if (entry.family === 'exhausted') {
      // Time never revives an exhausted backend.
      return { active: true, halfOpen: false, entry, reason: entry.reason };
    }
    // unavailable (circuit breaker)
    if (entry.untilMs !== null && entry.untilMs > nowMs) {
      return { active: true, halfOpen: false, entry, reason: entry.reason };
    }
    if (entry.untilMs !== null) {
      return { active: false, halfOpen: true, entry, reason: `${entry.reason} — half-open: one probe turn allowed` };
    }
    return { active: false, halfOpen: false };
  }

  /** The live entry for a backend (post-expiry semantics applied), if any. */
  get(bridgeId: CliBridgeId, accountId: string): CooldownEntry | undefined {
    const c = this.check(bridgeId, accountId);
    return c.entry;
  }

  list(): CooldownEntry[] {
    // Apply expiry semantics before listing so the UI never shows a
    // rate_limit entry whose window already reset.
    for (const e of [...this.entries.values()]) this.check(e.bridgeId, e.accountId);
    return [...this.entries.values()];
  }

  /** Test helper: drop all state (and persist the empty state). */
  clear(): void {
    this.entries.clear();
    this.save();
  }
}

/** Plain-words skip reason for resolver/UI surfaces, or null when usable. */
export function cooldownSkipReason(
  registry: BridgeCooldownRegistry,
  bridgeId: CliBridgeId,
  accountId: string = DEFAULT_BRIDGE_ACCOUNT_ID,
): string | null {
  const c = registry.check(bridgeId, accountId);
  if (!c.active) return null;
  return `${bridgeId} account "${accountId}" is in cooldown (${c.entry?.family ?? 'unavailable'}): ${c.reason ?? 'temporarily unavailable'}`;
}

// ---------------------------------------------------------------------------
// Process-wide registry. The API layer binds it to
// <dataDir>/bridge-state.json (beside providers.local.json) via
// getBridgeCooldownRegistry(filePath); tests inject their own instance
// into the runtime instead.
// ---------------------------------------------------------------------------

let sharedRegistry: BridgeCooldownRegistry | undefined;
let sharedRegistryFile: string | undefined;

export function getBridgeCooldownRegistry(filePath?: string): BridgeCooldownRegistry {
  if (!sharedRegistry) {
    sharedRegistry = new BridgeCooldownRegistry(filePath ? { filePath } : {});
    sharedRegistryFile = filePath;
    return sharedRegistry;
  }
  if (filePath && sharedRegistryFile !== filePath) {
    // Late binding: the host learned its data dir after first use. Reload
    // from the file, keeping any in-memory entries the file doesn't have.
    const fromFile = new BridgeCooldownRegistry({ filePath });
    for (const e of fromFile.list()) {
      // File state wins per key (it is the persisted truth).
      (sharedRegistry as unknown as { entries: Map<string, CooldownEntry> }).entries.set(
        BridgeCooldownRegistry.key(e.bridgeId, e.accountId),
        e,
      );
    }
    sharedRegistryFile = filePath;
    (sharedRegistry as unknown as { filePath?: string }).filePath = filePath;
  }
  return sharedRegistry;
}

/** Test helper: reset the process-wide registry. */
export function resetBridgeCooldownRegistry(): void {
  sharedRegistry = undefined;
  sharedRegistryFile = undefined;
}
