// SPDX-License-Identifier: Apache-2.0
// BR-13 — Browser permission suite (Muse parity audit §4.11).
//
// Per-action permission settings for a bot's browser, over the five
// action kinds a browser runner performs:
//
//   visit      navigate to a page (read)
//   submit     submit a form / click a committing control
//   download   save a file the page offers
//   upload     send a local file to the page (additionally needs a
//              BR-7 file grant — see browser-file-grants.ts)
//   fill-creds type a credential into a login form
//
// Each action has a standing effect per browser profile, optionally
// overridden per origin (exact host or `*.domain` suffix):
//
//   allow — the runner may proceed (still subject to holds, hard
//           denials and governance below)
//   ask   — the runner must obtain an approval for this one action
//   deny  — the runner must not perform the action at all
//
// COMPOSITION RULES (this suite never weakens anything):
//   - A host-supplied hard-deny hook (governance hard floors / learned
//     deny preferences, adapted by the host) is consulted FIRST and a
//     hit is a deny no matter what any setting says.
//   - `fill-creds` can NEVER be given a standing `allow`: credential
//     entry requires an explicit per-action permission, every time.
//     Setting it throws; evaluating it without a one-time grant
//     returns `ask`. A one-time grant (minted by a person, single-use,
//     short TTL) is the only way fill-creds evaluates to `allow`, and
//     it is consumed by the evaluation that uses it.
//   - One-time grants exist for every action kind (a person can
//     pre-approve exactly one submit, etc.) and are single-use.
//   - Defaults are `ask` for everything: out of the box the suite is
//     exactly as strict as the approval-gated browser that shipped
//     before it (muse-modules BrowserAutomation).
//
// Persistence: SQLite (browser-permissions.db under the host data dir),
// following the file-links.ts store pattern.
//
// HOST WIRING: see hidden_files/wave4-browser-WIRING.md —
//   registerBrowserPermissionRoutes(router, { store }) mounted under
//   /api/browser, and the runner consults store.evaluate(...) (usually
//   through BrowserActionGate in browser-action-gate.ts).

import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import express, { type Router } from 'express';
import { openDb as openSqliteDb } from '@mvp/agent-runtime';

export const BROWSER_ACTIONS = ['visit', 'submit', 'download', 'upload', 'fill-creds'] as const;
export type BrowserActionKind = (typeof BROWSER_ACTIONS)[number];
export type BrowserActionEffect = 'allow' | 'ask' | 'deny';

export function isBrowserActionKind(v: unknown): v is BrowserActionKind {
  return typeof v === 'string' && (BROWSER_ACTIONS as readonly string[]).includes(v);
}
export function isBrowserActionEffect(v: unknown): v is BrowserActionEffect {
  return v === 'allow' || v === 'ask' || v === 'deny';
}

/** Standing defaults: ask for everything (never weaker than before). */
export const BROWSER_ACTION_DEFAULTS: Readonly<Record<BrowserActionKind, BrowserActionEffect>> = {
  visit: 'ask',
  submit: 'ask',
  download: 'ask',
  upload: 'ask',
  'fill-creds': 'ask',
};

export interface BrowserPermissionRule {
  id: string;
  /** Browser profile id (bot id whose persistent profile it is). */
  profileId: string;
  action: BrowserActionKind;
  effect: BrowserActionEffect;
  /** Origin scope: exact host (`shop.example.com`) or suffix (`*.example.com`). Null = all origins. */
  origin: string | null;
  updatedBy: string;
  updatedAt: number;
}

export interface OneTimeBrowserGrant {
  id: string;
  profileId: string;
  action: BrowserActionKind;
  origin: string | null;
  grantedBy: string;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
}

export interface BrowserPermissionEvaluation {
  effect: BrowserActionEffect;
  action: BrowserActionKind;
  profileId: string;
  origin: string | null;
  /** Where the decision came from. */
  source: 'hard-deny' | 'one-time-grant' | 'origin-rule' | 'profile-rule' | 'default';
  reason: string;
  /** Set when source is 'one-time-grant': the grant that was consumed. */
  grantId?: string;
}

/** Host hook for governance hard denials. Return a reason string to deny. */
export type BrowserHardDenyHook = (input: {
  profileId: string;
  action: BrowserActionKind;
  origin: string | null;
  url?: string;
}) => string | undefined;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS browser_permission_rules (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    action TEXT NOT NULL,
    effect TEXT NOT NULL,
    origin TEXT,
    updated_by TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL,
    UNIQUE(profile_id, action, origin)
  );
  CREATE TABLE IF NOT EXISTS browser_once_grants (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    profile_id TEXT NOT NULL,
    action TEXT NOT NULL,
    origin TEXT,
    granted_by TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_browser_perm_rules_profile ON browser_permission_rules(profile_id, action);
`;

import { createHash } from 'node:crypto';
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Extract the lowercase host from an http(s) URL; null for anything else. */
export function originHostOf(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Does a rule origin pattern (`host` or `*.domain`, already lowercased) match a host? */
export function originMatches(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase();
  const h = host.toLowerCase();
  if (p.startsWith('*.')) {
    const suffix = p.slice(1); // ".example.com"
    return h.length > suffix.length && h.endsWith(suffix);
  }
  return p === h;
}

/** Validate + normalize an origin pattern from user input. */
export function normalizeOriginPattern(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'string') throw new Error('origin must be a string host or "*.domain" pattern');
  const v = raw.trim().toLowerCase();
  if (!/^(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(v) || v.includes('..')) {
    throw new Error(`invalid origin pattern: ${raw}`);
  }
  return v;
}

export const MAX_ONCE_GRANT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_ONCE_GRANT_TTL_MS = 5 * 60 * 1000;

interface RuleRow {
  id: string;
  profile_id: string;
  action: string;
  effect: string;
  origin: string | null;
  updated_by: string;
  updated_at: number;
}

interface GrantRow {
  id: string;
  profile_id: string;
  action: string;
  origin: string | null;
  granted_by: string;
  created_at: number;
  expires_at: number;
  used_at: number | null;
}

export class BrowserPermissionStore {
  protected readonly db: DatabaseSync;
  private readonly hardDeny?: BrowserHardDenyHook;
  private readonly nowFn: () => number;

  constructor(
    protected readonly dataDir: string,
    opts: { hardDeny?: BrowserHardDenyHook; now?: () => number } = {},
  ) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = openSqliteDb(path.join(dataDir, 'browser-permissions.db'));
    this.db.exec(SCHEMA);
    this.hardDeny = opts.hardDeny;
    this.nowFn = opts.now ?? (() => Date.now());
  }

  // -------------------------------------------------------------------------
  // Standing rules
  // -------------------------------------------------------------------------

  /**
   * Set a standing rule. Throws for `fill-creds` + `allow`: credential
   * entry has no standing allow, by design (per-action permission only).
   */
  setRule(input: {
    profileId: string;
    action: BrowserActionKind;
    effect: BrowserActionEffect;
    origin?: string | null;
    updatedBy?: string;
  }): BrowserPermissionRule {
    if (!input.profileId) throw new Error('profileId is required');
    if (!isBrowserActionKind(input.action)) throw new Error(`unknown browser action: ${input.action}`);
    if (!isBrowserActionEffect(input.effect)) throw new Error(`unknown effect: ${input.effect}`);
    if (input.action === 'fill-creds' && input.effect === 'allow') {
      throw new Error(
        'fill-creds cannot be set to a standing "allow": credential entry always requires an explicit per-action permission (use a one-time grant)',
      );
    }
    const origin = normalizeOriginPattern(input.origin ?? null);
    const rule: BrowserPermissionRule = {
      id: randomUUID(),
      profileId: input.profileId,
      action: input.action,
      effect: input.effect,
      origin,
      updatedBy: (input.updatedBy ?? '').slice(0, 100),
      updatedAt: this.nowFn(),
    };
    // Replace any existing rule for the same (profile, action, origin).
    // (A SQL UNIQUE index treats NULL origins as distinct, so an
    // ON CONFLICT upsert cannot be trusted for the profile-wide row —
    // delete-then-insert is the reliable shape here.)
    this.db
      .prepare('DELETE FROM browser_permission_rules WHERE profile_id = ? AND action = ? AND origin IS ?')
      .run(rule.profileId, rule.action, rule.origin);
    this.db
      .prepare(
        `INSERT INTO browser_permission_rules (id, profile_id, action, effect, origin, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(rule.id, rule.profileId, rule.action, rule.effect, rule.origin, rule.updatedBy, rule.updatedAt);
    const stored = this.getRule(rule.profileId, rule.action, rule.origin);
    return stored ?? rule;
  }

  getRule(profileId: string, action: BrowserActionKind, origin: string | null): BrowserPermissionRule | undefined {
    const row = this.db
      .prepare('SELECT * FROM browser_permission_rules WHERE profile_id = ? AND action = ? AND origin IS ?')
      .get(profileId, action, origin) as unknown as RuleRow | undefined;
    return row
      ? {
          id: row.id,
          profileId: row.profile_id,
          action: row.action as BrowserActionKind,
          effect: row.effect as BrowserActionEffect,
          origin: row.origin,
          updatedBy: row.updated_by,
          updatedAt: row.updated_at,
        }
      : undefined;
  }

  deleteRule(profileId: string, action: BrowserActionKind, origin: string | null): boolean {
    const res = this.db
      .prepare('DELETE FROM browser_permission_rules WHERE profile_id = ? AND action = ? AND origin IS ?')
      .run(profileId, action, normalizeOriginPattern(origin));
    return Number((res as { changes?: number }).changes ?? 0) > 0;
  }

  listRules(profileId?: string): BrowserPermissionRule[] {
    const rows = (
      profileId
        ? this.db.prepare('SELECT * FROM browser_permission_rules WHERE profile_id = ? ORDER BY action, origin').all(profileId)
        : this.db.prepare('SELECT * FROM browser_permission_rules ORDER BY profile_id, action, origin').all()
    ) as unknown as RuleRow[];
    return rows.map((r) => ({
      id: r.id,
      profileId: r.profile_id,
      action: r.action as BrowserActionKind,
      effect: r.effect as BrowserActionEffect,
      origin: r.origin,
      updatedBy: r.updated_by,
      updatedAt: r.updated_at,
    }));
  }

  /** The full effective settings matrix for a profile (defaults filled in). */
  settingsFor(profileId: string): Record<BrowserActionKind, BrowserActionEffect> {
    const out = { ...BROWSER_ACTION_DEFAULTS };
    for (const rule of this.listRules(profileId)) {
      if (rule.origin === null) out[rule.action] = rule.effect;
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // One-time per-action grants
  // -------------------------------------------------------------------------

  /**
   * Mint a single-use per-action grant. The token is returned exactly
   * once; only its SHA-256 hash is stored. This is the ONLY mechanism
   * that lets `fill-creds` evaluate to `allow`.
   */
  grantOnce(input: {
    profileId: string;
    action: BrowserActionKind;
    origin?: string | null;
    grantedBy?: string;
    ttlMs?: number;
  }): { grant: OneTimeBrowserGrant; token: string } {
    if (!input.profileId) throw new Error('profileId is required');
    if (!isBrowserActionKind(input.action)) throw new Error(`unknown browser action: ${input.action}`);
    const ttlMs = input.ttlMs ?? DEFAULT_ONCE_GRANT_TTL_MS;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > MAX_ONCE_GRANT_TTL_MS) {
      throw new Error(`one-time grant ttl must be within (0, ${MAX_ONCE_GRANT_TTL_MS / 60000}min]`);
    }
    const now = this.nowFn();
    const token = randomBytes(24).toString('base64url');
    const grant: OneTimeBrowserGrant = {
      id: randomUUID(),
      profileId: input.profileId,
      action: input.action,
      origin: normalizeOriginPattern(input.origin ?? null),
      grantedBy: (input.grantedBy ?? '').slice(0, 100),
      createdAt: now,
      expiresAt: now + ttlMs,
      usedAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO browser_once_grants (id, token_hash, profile_id, action, origin, granted_by, created_at, expires_at, used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(grant.id, hashToken(token), grant.profileId, grant.action, grant.origin, grant.grantedBy, grant.createdAt, grant.expiresAt);
    return { grant, token };
  }

  listGrants(profileId?: string): OneTimeBrowserGrant[] {
    const rows = (
      profileId
        ? this.db.prepare('SELECT * FROM browser_once_grants WHERE profile_id = ? ORDER BY created_at DESC').all(profileId)
        : this.db.prepare('SELECT * FROM browser_once_grants ORDER BY created_at DESC').all()
    ) as unknown as GrantRow[];
    return rows.map((r) => ({
      id: r.id,
      profileId: r.profile_id,
      action: r.action as BrowserActionKind,
      origin: r.origin,
      grantedBy: r.granted_by,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      usedAt: r.used_at,
    }));
  }

  revokeGrant(id: string): boolean {
    const res = this.db
      .prepare('UPDATE browser_once_grants SET used_at = ? WHERE id = ? AND used_at IS NULL')
      .run(this.nowFn(), id);
    return Number((res as { changes?: number }).changes ?? 0) > 0;
  }

  /** Look up a grant row by its presented token (hash comparison only). */
  private findGrantByToken(token: string): GrantRow | undefined {
    return this.db
      .prepare('SELECT * FROM browser_once_grants WHERE token_hash = ?')
      .get(hashToken(token)) as unknown as GrantRow | undefined;
  }

  // -------------------------------------------------------------------------
  // Evaluation — the runner's one question: may I do this action now?
  // -------------------------------------------------------------------------

  evaluate(input: {
    profileId: string;
    action: BrowserActionKind;
    /** URL or bare host the action targets, when known. */
    url?: string;
    origin?: string | null;
    /** One-time grant token presented by the runner for THIS action. */
    onceToken?: string;
  }): BrowserPermissionEvaluation {
    const host = input.origin !== undefined ? input.origin : originHostOf(input.url);
    const base = { action: input.action, profileId: input.profileId, origin: host };

    // 1. Hard denials first — no setting or grant can widen them.
    const hardReason = this.hardDeny?.({ profileId: input.profileId, action: input.action, origin: host, url: input.url });
    if (hardReason) {
      return { ...base, effect: 'deny', source: 'hard-deny', reason: hardReason };
    }

    // 2. A presented one-time grant token: must match profile/action/origin
    //    exactly, be unused and unexpired. Consumed on use. A token that
    //    does not match is ignored (falls through to standing rules) —
    //    never an implicit allow.
    if (input.onceToken) {
      const row = this.findGrantByToken(input.onceToken);
      if (
        row &&
        row.profile_id === input.profileId &&
        row.action === input.action &&
        row.used_at === null &&
        row.expires_at > this.nowFn() &&
        (row.origin === null || (host !== null && originMatches(row.origin, host)))
      ) {
        // Consume exactly the presented grant (atomic single-use claim).
        const now = this.nowFn();
        const res = this.db
          .prepare('UPDATE browser_once_grants SET used_at = ? WHERE id = ? AND used_at IS NULL')
          .run(now, row.id);
        if (Number((res as { changes?: number }).changes ?? 0) > 0) {
          return {
            ...base,
            effect: 'allow',
            source: 'one-time-grant',
            reason: `one-time per-action grant by ${row.granted_by || 'a person'} consumed for this ${input.action}`,
            grantId: row.id,
          };
        }
      }
    }

    // 3. Standing rules: origin-scoped beats profile-wide beats default.
    const rules = this.listRules(input.profileId).filter((r) => r.action === input.action);
    if (host !== null) {
      const originRule = rules.find((r) => r.origin !== null && originMatches(r.origin, host));
      if (originRule) {
        return {
          ...base,
          effect: originRule.effect,
          source: 'origin-rule',
          reason: `standing rule for ${input.action} on ${originRule.origin}: ${originRule.effect}`,
        };
      }
    }
    const profileRule = rules.find((r) => r.origin === null);
    if (profileRule) {
      return {
        ...base,
        effect: profileRule.effect,
        source: 'profile-rule',
        reason: `standing rule for ${input.action}: ${profileRule.effect}`,
      };
    }
    return {
      ...base,
      effect: BROWSER_ACTION_DEFAULTS[input.action],
      source: 'default',
      reason: `default for ${input.action}: ${BROWSER_ACTION_DEFAULTS[input.action]}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Routes — mount under /api/browser (paths are /permissions…)
// ---------------------------------------------------------------------------

export interface BrowserPermissionRouterDeps {
  store: BrowserPermissionStore;
  audit?: (action: string, fields: { actor?: string; detail?: unknown }) => void;
}

export function registerBrowserPermissionRoutes(router: Router, deps: BrowserPermissionRouterDeps): void {
  const { store } = deps;

  router.get('/permissions', (req, res) => {
    const profileId = typeof req.query.profileId === 'string' ? req.query.profileId : undefined;
    res.json({
      ok: true,
      actions: BROWSER_ACTIONS,
      defaults: BROWSER_ACTION_DEFAULTS,
      ...(profileId ? { settings: store.settingsFor(profileId) } : {}),
      rules: store.listRules(profileId),
      onceGrants: store.listGrants(profileId),
    });
  });

  router.put('/permissions', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      if (!isBrowserActionKind(body.action)) {
        res.status(400).json({ error: `action must be one of: ${BROWSER_ACTIONS.join(', ')}` });
        return;
      }
      if (!isBrowserActionEffect(body.effect)) {
        res.status(400).json({ error: 'effect must be allow | ask | deny' });
        return;
      }
      const rule = store.setRule({
        profileId: typeof body.profileId === 'string' ? body.profileId : '',
        action: body.action,
        effect: body.effect,
        origin: (body.origin as string | null | undefined) ?? null,
        updatedBy: typeof body.updatedBy === 'string' ? body.updatedBy : undefined,
      });
      deps.audit?.('browser.permission_set', {
        actor: rule.updatedBy || undefined,
        detail: { profileId: rule.profileId, action: rule.action, effect: rule.effect, origin: rule.origin },
      });
      res.json({ ok: true, rule });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.delete('/permissions', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!isBrowserActionKind(body.action)) {
      res.status(400).json({ error: `action must be one of: ${BROWSER_ACTIONS.join(', ')}` });
      return;
    }
    const removed = store.deleteRule(
      typeof body.profileId === 'string' ? body.profileId : '',
      body.action,
      (body.origin as string | null | undefined) ?? null,
    );
    res.json({ ok: true, removed });
  });

  router.post('/permissions/once-grants', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      if (!isBrowserActionKind(body.action)) {
        res.status(400).json({ error: `action must be one of: ${BROWSER_ACTIONS.join(', ')}` });
        return;
      }
      const { grant, token } = store.grantOnce({
        profileId: typeof body.profileId === 'string' ? body.profileId : '',
        action: body.action,
        origin: (body.origin as string | null | undefined) ?? null,
        grantedBy: typeof body.grantedBy === 'string' ? body.grantedBy : undefined,
        ttlMs: typeof body.ttlMs === 'number' ? body.ttlMs : undefined,
      });
      deps.audit?.('browser.once_grant_minted', {
        actor: grant.grantedBy || undefined,
        detail: { profileId: grant.profileId, action: grant.action, origin: grant.origin, expiresAt: grant.expiresAt },
      });
      res.status(201).json({ ok: true, grant, token });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/permissions/once-grants/:id/revoke', (req, res) => {
    res.json({ ok: true, revoked: store.revokeGrant(req.params.id) });
  });

  /** Dry-run evaluation for the settings UI / runner debugging. Does NOT consume grants unless a token is presented and matches. */
  router.post('/permissions/evaluate', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!isBrowserActionKind(body.action)) {
      res.status(400).json({ error: `action must be one of: ${BROWSER_ACTIONS.join(', ')}` });
      return;
    }
    const evaluation = store.evaluate({
      profileId: typeof body.profileId === 'string' ? body.profileId : '',
      action: body.action,
      url: typeof body.url === 'string' ? body.url : undefined,
      onceToken: typeof body.onceToken === 'string' ? body.onceToken : undefined,
    });
    res.json({ ok: true, evaluation });
  });
}

export function createBrowserPermissionRouter(deps: BrowserPermissionRouterDeps): Router {
  const router = express.Router();
  registerBrowserPermissionRoutes(router, deps);
  return router;
}
