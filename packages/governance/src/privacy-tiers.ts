// SPDX-License-Identifier: Apache-2.0
// Privacy tiers: 3-level data classification enforced across vault, memory,
// and every cloud-egress path.
//
// ## Tier semantics
//
// - `metadata`: Non-sensitive facts about data, not the data itself — ids,
//   timestamps, counts, token totals, feature names. May travel anywhere:
//   logs, telemetry, prompts, cloud providers. It is the only tier allowed
//   in audit/telemetry payloads by default.
// - `cloud-ok`: User/bot content that MAY be sent to cloud providers (LLM
//   APIs) and other network egress. This is the default for conversational
//   data (chat messages, distilled memory atoms, workflow inputs) — the
//   platform cannot function without sending it to the model provider.
// - `local-only`: MUST NEVER leave the machine. Blocked from all cloud
//   provider calls and network egress; usable only in local processing
//   (local models, local tools, on-disk storage). A single local-only item
//   in an egress payload denies the WHOLE call (fail closed) and writes an
//   audit entry — partial redaction is not attempted because a missed field
//   is a silent leak.
//
// ## Write-time tagging
//
// Every store tags data at write time via `resolveTier(source, override)`:
// the source supplies the default (e.g. vault secrets default to
// `local-only`, memory atoms to `cloud-ok`) and the caller may override
// explicitly. Overrides are deliberate — there is no silent promotion from
// `local-only` to a weaker tier anywhere in the read path.
//
// ## Enforcement points
//
// - Vault: secrets carry a tier (default `local-only`); `EgressGate` denies
//   any cloud egress containing them.
// - Memory: `TieredMemoryStore.recallForPrompt()` excludes `local-only`
//   atoms from cloud prompts by default.
// - Runtime: `AgentRuntime.runTurn()` accepts `egressItems` + `privacyGate`
//   and asserts the gate before every provider.chat call.
// - `EgressGate.assertEgress()` is the shared choke point: deny + audit.

/** Data classification tier. Ordered least → most restrictive. */
export type PrivacyTier = 'metadata' | 'cloud-ok' | 'local-only';

const VALID_TIERS: ReadonlySet<string> = new Set(['metadata', 'cloud-ok', 'local-only']);

/** Rank for comparison: metadata < cloud-ok < local-only. */
export function tierRank(tier: PrivacyTier): number {
  switch (tier) {
    case 'metadata':
      return 0;
    case 'cloud-ok':
      return 1;
    case 'local-only':
      return 2;
  }
}

/** True when `tier` is at most as restrictive as `max` (e.g. cloud-ok ≤ cloud-ok). */
export function tierAtMost(tier: PrivacyTier, max: PrivacyTier): boolean {
  return tierRank(tier) <= tierRank(max);
}

/** True when data at this tier may be sent to a cloud provider / network egress. */
export function allowsCloudEgress(tier: PrivacyTier): boolean {
  return tier !== 'local-only';
}

export function isPrivacyTier(value: unknown): value is PrivacyTier {
  return typeof value === 'string' && VALID_TIERS.has(value);
}

function assertTier(value: unknown, name: string): PrivacyTier {
  if (!isPrivacyTier(value)) {
    throw new Error(`${name} must be one of metadata|cloud-ok|local-only, got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Default tier per data source, used when the writer does not override.
 * Secrets stay local by default; conversational content is cloud-bound by
 * necessity; derived facts/metadata are unrestricted.
 */
export const DEFAULT_TIER_BY_SOURCE: Readonly<Record<string, PrivacyTier>> = {
  vault: 'local-only',
  memory: 'cloud-ok',
  chat: 'cloud-ok',
  workflow: 'cloud-ok',
  system: 'metadata',
  telemetry: 'metadata',
};

/**
 * Tag data at write time: explicit override wins, otherwise the source
 * default, otherwise `cloud-ok` for unknown sources. Never throws for
 * unknown sources (fail open to the conversational default); throws for
 * an invalid explicit override.
 */
export function resolveTier(source: string, override?: unknown): PrivacyTier {
  if (override !== undefined) return assertTier(override, 'tier override');
  const def = (DEFAULT_TIER_BY_SOURCE as Record<string, PrivacyTier | undefined>)[source];
  return def ?? 'cloud-ok';
}

/** A single item presented to the egress gate. */
export interface TieredItem {
  /** Stable identifier for audit messages (never a secret value). */
  id?: string;
  tier: PrivacyTier;
}

export interface EgressCheckResult {
  allowed: boolean;
  /** Items whose tier forbids cloud egress (empty when allowed). */
  blocked: TieredItem[];
}

/** Thrown by EgressGate.assertEgress when local-only data would egress. */
export class PrivacyTierDeniedError extends Error {
  readonly blocked: TieredItem[];
  readonly context: Record<string, unknown>;
  constructor(blocked: TieredItem[], context: Record<string, unknown> = {}) {
    const ids = blocked.map((b) => b.id ?? '<untagged>').join(', ');
    super(
      `Privacy tier violation: ${blocked.length} local-only item(s) blocked from cloud egress [${ids}]. ` +
        `Local-only data must never leave the machine.`,
    );
    this.name = 'PrivacyTierDeniedError';
    this.blocked = blocked;
    this.context = context;
  }
}

/** Audit sink for denied egress attempts. Must never receive item contents. */
export type EgressAuditFn = (action: string, detail: Record<string, unknown>) => void;

/**
 * Choke point for every cloud-egress path. `check()` is pure;
 * `assertEgress()` denies fail-closed and writes an audit entry carrying
 * only item ids/tiers — never contents.
 */
export class EgressGate {
  private readonly audit?: EgressAuditFn;

  constructor(audit?: EgressAuditFn) {
    this.audit = audit;
  }

  /** Pure check: which items (if any) forbid cloud egress. */
  check(items: TieredItem[]): EgressCheckResult {
    const blocked = items.filter((i) => !allowsCloudEgress(i.tier));
    return { allowed: blocked.length === 0, blocked };
  }

  /**
   * Fail-closed assertion for a cloud egress (provider call, webhook,
   * external send). Throws PrivacyTierDeniedError and audits when any
   * item is local-only. Audit detail carries ids/tiers only.
   */
  assertEgress(items: TieredItem[], context: Record<string, unknown> = {}): void {
    const { allowed, blocked } = this.check(items);
    if (allowed) return;
    const detail = {
      ...context,
      blocked: blocked.map((b) => ({ id: b.id ?? '<untagged>', tier: b.tier })),
      count: blocked.length,
    };
    try {
      this.audit?.('privacy.egress_denied', detail);
    } catch {
      // Audit must never break the denial.
    }
    throw new PrivacyTierDeniedError(blocked, context);
  }

  /** Convenience: drop every item that may not go to the cloud. */
  filterForCloud<T extends TieredItem>(items: T[]): T[] {
    return items.filter((i) => allowsCloudEgress(i.tier));
  }
}

// ---------------------------------------------------------------------------
// Telemetry ingestion guard ("eyes for your AI", PII-safe).
//
// Runtime telemetry is metadata-tier by design (ids, counts, timings —
// DEFAULT_TIER_BY_SOURCE['telemetry'] === 'metadata'), but telemetry
// producers are sloppy: a route label can embed a user id, and a careless
// payload can smuggle request bodies, headers, cookies, or query values.
// This guard is the single choke point every telemetry payload passes
// through BEFORE it is stored or served:
//
// 1. Name normalization — route/screen/path/url/botName fields are reduced
//    to templates: UUIDs, numeric path segments, and long hex ids become
//    `:id`, and query strings are stripped entirely. Cardinality stays
//    bounded and raw identifiers never persist.
// 2. PII refusal — any payload carrying request/response bodies, headers,
//    cookies, or query values is REFUSED: the payload is dropped, a warning
//    is logged (key paths only, never values), and nothing is stored.
//    Fail closed: a guard that throws also refuses the payload.
//
// The collector in @mvp/agent-runtime takes this guard as an injected
// callback so the runtime package keeps its type-only relationship with
// governance; the API server wires `sanitizeTelemetry` in at boot.

/** Telemetry fields whose string values are normalized to id-templates. */
const TELEMETRY_NAME_FIELDS: ReadonlySet<string> = new Set([
  'route',
  'screen',
  'path',
  'url',
  'endpoint',
  'botName',
  'name',
]);

/**
 * Payload keys that are never allowed in telemetry. Bodies, headers,
 * cookies, and query values are PII-bearing by construction; credential-ish
 * keys are refused on the same fail-closed principle.
 */
const FORBIDDEN_TELEMETRY_KEYS: ReadonlySet<string> = new Set([
  'body',
  'requestbody',
  'responsebody',
  'headers',
  'requestheaders',
  'responseheaders',
  'cookie',
  'cookies',
  'set-cookie',
  'setcookie',
  'query',
  'querystring',
  'queryparams',
  'searchparams',
  'authorization',
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'api_key',
]);

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const LONG_HEX_RE = /\b[0-9a-f]{16,}\b/gi;
const NUM_PATH_SEG_RE = /(?<=\/)\d+(?=\/|$)/g;

/**
 * Reduce a route/screen/bot name to a template: UUIDs, numeric path
 * segments, and long hex ids become `:id`; query strings are stripped.
 * `/api/bots/8f3a…/chat?session=abc` → `/api/bots/:id/chat`.
 */
export function normalizeTelemetryName(name: string): string {
  if (typeof name !== 'string') return '';
  const pathOnly = name.split('?')[0] ?? '';
  return pathOnly
    .replace(UUID_RE, ':id')
    .replace(NUM_PATH_SEG_RE, ':id')
    .replace(LONG_HEX_RE, ':id');
}

export interface SanitizeTelemetryResult {
  accepted: boolean;
  /** Name-normalized copy of the payload. Present only when accepted. */
  sanitized?: Record<string, unknown>;
  /** Why the payload was refused. Present only when !accepted. */
  reason?: string;
  /** Key paths that triggered refusal (names only, never values). */
  droppedFields?: string[];
}

/** Warning sink for refused telemetry payloads. Receives names, never values. */
export type TelemetryWarnFn = (message: string, detail: Record<string, unknown>) => void;

const MAX_TELEMETRY_SCAN_DEPTH = 8;
const MAX_TELEMETRY_SCAN_KEYS = 2000;

function scanForbiddenKeys(
  value: unknown,
  path: string,
  depth: number,
  seen: WeakSet<object>,
  hits: string[],
  budget: { keys: number },
): void {
  if (hits.length > 0 || budget.keys > MAX_TELEMETRY_SCAN_KEYS || depth > MAX_TELEMETRY_SCAN_DEPTH) return;
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    budget.keys += 1;
    if (budget.keys > MAX_TELEMETRY_SCAN_KEYS) return;
    const childPath = path ? `${path}.${key}` : key;
    if (FORBIDDEN_TELEMETRY_KEYS.has(key.toLowerCase())) {
      hits.push(childPath);
      return; // one hit is enough to refuse; no need to keep scanning
    }
    scanForbiddenKeys(child, childPath, depth + 1, seen, hits, budget);
    if (hits.length > 0) return;
  }
}

function normalizeNames(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object' || depth > MAX_TELEMETRY_SCAN_DEPTH) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => normalizeNames(v, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] =
      TELEMETRY_NAME_FIELDS.has(key) && typeof child === 'string'
        ? normalizeTelemetryName(child)
        : normalizeNames(child, depth + 1, seen);
  }
  return out;
}

/**
 * Ingestion guard for telemetry payloads. Returns `{ accepted: true,
 * sanitized }` for clean payloads (with route/screen/bot names reduced to
 * templates) and `{ accepted: false, reason, droppedFields }` for payloads
 * carrying bodies/headers/cookies/query values — those are dropped, never
 * stored, and reported via `warn` (key paths only, never values).
 */
export function sanitizeTelemetry(
  payload: unknown,
  warn?: TelemetryWarnFn,
): SanitizeTelemetryResult {
  const report = (message: string, detail: Record<string, unknown>): void => {
    try {
      (warn ?? ((m, d) => console.warn(`[telemetry-guard] ${m}`, d)))(message, detail);
    } catch {
      // Warning must never break the refusal.
    }
  };
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    const reason = 'telemetry payload must be a plain object';
    report('telemetry payload refused', { reason });
    return { accepted: false, reason, droppedFields: [] };
  }
  const hits: string[] = [];
  try {
    scanForbiddenKeys(payload, '', 0, new WeakSet(), hits, { keys: 0 });
  } catch {
    const reason = 'telemetry guard scan failed';
    report('telemetry payload refused', { reason });
    return { accepted: false, reason, droppedFields: [] };
  }
  if (hits.length > 0) {
    const reason = `telemetry payload carries forbidden PII-bearing field(s): ${hits.join(', ')}`;
    report('telemetry payload refused', { reason, droppedFields: hits });
    return { accepted: false, reason, droppedFields: hits };
  }
  const sanitized = normalizeNames(payload, 0, new WeakSet()) as Record<string, unknown>;
  return { accepted: true, sanitized };
}
