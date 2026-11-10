// SPDX-License-Identifier: Apache-2.0
/**
 * Approval-gated PC file access (2026-11-10).
 *
 * Bots' file tools are fenced to the app workspace. This module lets the
 * USER grant bots read access to real PC folders (Desktop, Documents, any
 * folder) under governance — the "middle path" between the workspace
 * fence and the governed host-execution opt-out:
 *
 * - Grants are persisted (SQLite, `pc-access.db` in the data dir) and are
 *   created ONLY by the user: in Settings → Permissions → PC file access,
 *   or by approving a just-in-time request card with "Always allow".
 *   A bot can never create or extend a grant.
 * - Grants are READ-ONLY (v1: list + read; no writes outside the
 *   workspace) and scoped: all bots, or one bot id.
 * - When a bot tries to list/read an ungranted absolute path mid-turn,
 *   the file tools raise a request card through the PcAccessHost (same
 *   card family as credential proposals): the user picks Allow once
 *   (this session), Always allow this folder (creates a bot-scoped
 *   grant), or Deny. The turn pauses on the card.
 * - Path safety: every path is canonicalized (realpath via the nearest
 *   existing ancestor) and containment is checked segment-by-segment, so
 *   `..`, symlink escapes and prefix tricks (`/Desktop2` vs `/Desktop`)
 *   fail. Segment comparison is case-insensitive on win32, matching
 *   Windows path semantics (Ashutosh's machine is Windows).
 */

import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from './sqlite.js';
import type { ToolContext } from './types.js';

// ---------------------------------------------------------------------------
// Path helpers (pure — exported for tests)
// ---------------------------------------------------------------------------

/**
 * Canonicalize an absolute path: resolve `.`/`..` lexically, then realpath
 * the nearest existing ancestor and re-append the remainder (the target
 * itself may not exist for checks against a folder about to be read —
 * for reads the file exists, so it fully realpaths, which is what makes
 * symlink escapes resolve to their true target before containment runs).
 */
export function canonicalizeAbsolutePath(p: string): string {
  const resolved = resolve(p);
  if (existsSync(resolved)) {
    try {
      return stripTrailingSep(realpathSync(resolved));
    } catch {
      return resolved;
    }
  }
  let ancestor = resolved;
  const rest: string[] = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break; // filesystem root
    rest.unshift(basename(ancestor));
    ancestor = parent;
  }
  try {
    let real = realpathSync(ancestor);
    for (const seg of rest) real = resolve(real, seg);
    return stripTrailingSep(real);
  } catch {
    return resolved;
  }
}

function stripTrailingSep(p: string): string {
  if (p.length <= 1) return p;
  const stripped = p.replace(/[\\/]+$/, '');
  if (stripped === '') return p; // was all separators ("/")
  // "C:\" stripped to "C:" would change meaning (drive-relative) — restore.
  if (/^[A-Za-z]:$/.test(stripped)) return `${stripped}\\`;
  return stripped;
}

/** Split a path into segments on either separator (win32 accepts both). */
export function pathSegments(p: string): string[] {
  return p.split(/[\\/]+/).filter((s) => s.length > 0);
}

/**
 * Segment-wise containment: true when `candidate` equals `root` or lives
 * strictly below it. Segment comparison defeats the `/Desktop2` prefix
 * trick (a naive startsWith would pass it). Callers must canonicalize
 * both sides first (`..` and symlinks are resolved there). Comparison is
 * case-insensitive when `caseInsensitive` is set (default: win32 hosts).
 */
export function isPathInsideRoot(
  root: string,
  candidate: string,
  opts?: { caseInsensitive?: boolean },
): boolean {
  const ci = opts?.caseInsensitive ?? process.platform === 'win32';
  const r = pathSegments(root);
  const c = pathSegments(candidate);
  // Belt-and-braces: dot segments must never reach the comparison —
  // callers canonicalize first, but a stray `..` resolves OUTSIDE the
  // root lexically, so refuse it outright rather than prefix-matching.
  if (c.some((s) => s === '..' || s === '.') || r.some((s) => s === '..' || s === '.')) {
    return false;
  }
  if (c.length < r.length) return false;
  for (let i = 0; i < r.length; i++) {
    const a = ci ? r[i]!.toLowerCase() : r[i]!;
    const b = ci ? c[i]!.toLowerCase() : c[i]!;
    if (a !== b) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Special folders (Desktop / Documents / Downloads / Home)
// ---------------------------------------------------------------------------

export type SpecialFolderName = 'desktop' | 'documents' | 'downloads' | 'home';

export const SPECIAL_FOLDER_NAMES: readonly SpecialFolderName[] = [
  'desktop',
  'documents',
  'downloads',
  'home',
];

/**
 * Resolve a well-known folder for the API host's OS. Win32: USERPROFILE-
 * based (with HOMEDRIVE+HOMEPATH fallback). POSIX: HOME + XDG user dirs
 * when set. Returns null when the base home cannot be determined.
 */
export function resolveSpecialFolder(
  name: SpecialFolderName,
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform === 'win32') {
    const joinW = path.win32.join;
    const up =
      env.USERPROFILE ||
      (env.HOMEDRIVE && env.HOMEPATH ? `${env.HOMEDRIVE}${env.HOMEPATH}` : undefined);
    if (!up) return null;
    switch (name) {
      case 'home':
        return up;
      case 'desktop':
        return joinW(up, 'Desktop');
      case 'documents':
        return joinW(up, 'Documents');
      case 'downloads':
        return joinW(up, 'Downloads');
    }
  }
  const joinP = path.posix.join;
  const home = env.HOME;
  if (!home) return null;
  switch (name) {
    case 'home':
      return home;
    case 'desktop':
      return env.XDG_DESKTOP_DIR || joinP(home, 'Desktop');
    case 'documents':
      return env.XDG_DOCUMENTS_DIR || joinP(home, 'Documents');
    case 'downloads':
      return env.XDG_DOWNLOAD_DIR || joinP(home, 'Downloads');
  }
}

export function resolveSpecialFolders(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<SpecialFolderName, string | null> {
  return {
    desktop: resolveSpecialFolder('desktop', env, platform),
    documents: resolveSpecialFolder('documents', env, platform),
    downloads: resolveSpecialFolder('downloads', env, platform),
    home: resolveSpecialFolder('home', env, platform),
  };
}

// ---------------------------------------------------------------------------
// Grants + just-in-time access requests
// ---------------------------------------------------------------------------

export type PcGrantScope = 'all' | string; // 'all' or a bot id

export interface PcFolderGrant {
  id: string;
  /** Canonical absolute folder path. */
  path: string;
  /** 'all' = every bot; otherwise the single bot id this grant is for. */
  scope: PcGrantScope;
  /** Grants are always read-only in v1. */
  readOnly: true;
  createdAt: number;
  createdVia: 'settings' | 'approval';
}

export type PcAccessAction = 'list' | 'read';

export type PcAccessOutcome = 'allow-once' | 'always' | 'denied';

export type PcAccessRequestStatus =
  | 'pending'
  | 'allowed-once'
  | 'always-allowed'
  | 'denied'
  | 'expired';

export interface PcAccessRequest {
  id: string;
  botId: string;
  sessionId: string;
  /** Canonical folder the bot wants access to (the grant unit). */
  folder: string;
  action: PcAccessAction;
  /** For reads: the exact file the bot asked for (display only). */
  filePath: string | null;
  status: PcAccessRequestStatus;
  createdAt: number;
  expiresAt: number | null;
  decidedAt: number | null;
}

export const PC_ACCESS_REQUEST_TTL_MS = 15 * 60 * 1000;

interface GrantRow {
  id: string;
  path: string;
  bot_id: string; // '' = all bots
  created_via: string;
  created_at: number;
}

interface RequestRow {
  id: string;
  bot_id: string;
  session_id: string;
  folder: string;
  action: string;
  file_path: string | null;
  status: string;
  created_at: number;
  expires_at: number | null;
  decided_at: number | null;
}

export class PcAccessStore {
  private readonly db: DatabaseSync;
  /** requestId → waiter for the in-flight tool call. */
  private readonly waiters = new Map<string, (outcome: PcAccessOutcome) => void>();
  /** sessionId → canonical folders allowed once (this session only). */
  private readonly onceAllowances = new Map<string, Set<string>>();

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = openDb(join(dataDir, 'pc-access.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pc_folder_grants (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        bot_id TEXT NOT NULL DEFAULT '',
        created_via TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pc_grants_path ON pc_folder_grants (path, bot_id);
      CREATE TABLE IF NOT EXISTS pc_access_requests (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        folder TEXT NOT NULL,
        action TEXT NOT NULL,
        file_path TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        decided_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_pc_requests_status ON pc_access_requests (status, expires_at);
    `);
  }

  // ---- grants ------------------------------------------------------------

  /**
   * Create a grant. The path is canonicalized here so every stored grant
   * is in the same canonical form containment checks compare against.
   * Re-adding the same (path, scope) returns the existing grant.
   */
  addGrant(input: {
    path: string;
    botId?: string | null;
    createdVia: 'settings' | 'approval';
  }): PcFolderGrant {
    const canonical = canonicalizeAbsolutePath(input.path);
    const botKey = input.botId ?? '';
    const existing = this.db
      .prepare('SELECT * FROM pc_folder_grants WHERE path = ? AND bot_id = ? LIMIT 1')
      .get(canonical, botKey) as GrantRow | undefined;
    if (existing) return this.rowToGrant(existing);
    const grant: PcFolderGrant = {
      id: randomUUID(),
      path: canonical,
      scope: botKey === '' ? 'all' : botKey,
      readOnly: true,
      createdAt: Date.now(),
      createdVia: input.createdVia,
    };
    this.db
      .prepare(
        'INSERT INTO pc_folder_grants (id, path, bot_id, created_via, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(grant.id, grant.path, botKey, grant.createdVia, grant.createdAt);
    return grant;
  }

  listGrants(): PcFolderGrant[] {
    const rows = this.db
      .prepare('SELECT * FROM pc_folder_grants ORDER BY created_at ASC')
      .all() as unknown as GrantRow[];
    return rows.map((r) => this.rowToGrant(r));
  }

  revokeGrant(id: string): PcFolderGrant | null {
    const row = this.db.prepare('SELECT * FROM pc_folder_grants WHERE id = ?').get(id) as
      | GrantRow
      | undefined;
    if (!row) return null;
    this.db.prepare('DELETE FROM pc_folder_grants WHERE id = ?').run(id);
    return this.rowToGrant(row);
  }

  /** Canonical grant roots applicable to a bot ('all' grants + its own). */
  grantsForBot(botId: string): string[] {
    const rows = this.db
      .prepare("SELECT path FROM pc_folder_grants WHERE bot_id = '' OR bot_id = ?")
      .all(botId) as unknown as Array<{ path: string }>;
    return rows.map((r) => r.path);
  }

  /**
   * The grant root containing `canonicalPath` for this bot, or null.
   * `canonicalPath` must already be canonicalized.
   */
  containingGrantRoot(botId: string, canonicalPath: string): string | null {
    for (const root of this.grantsForBot(botId)) {
      if (isPathInsideRoot(root, canonicalPath)) return root;
    }
    return null;
  }

  // ---- allow-once memory (per session, never persisted) -------------------

  recordOnceAllowance(sessionId: string, canonicalFolder: string): void {
    let set = this.onceAllowances.get(sessionId);
    if (!set) {
      set = new Set();
      this.onceAllowances.set(sessionId, set);
    }
    set.add(canonicalFolder);
  }

  /**
   * True when some folder allowed once in this session contains the path
   * (or is the path itself). Input must be canonicalized.
   */
  isOnceAllowed(sessionId: string, canonicalPath: string): boolean {
    const set = this.onceAllowances.get(sessionId);
    if (!set) return false;
    for (const folder of set) {
      if (isPathInsideRoot(folder, canonicalPath)) return true;
    }
    return false;
  }

  // ---- just-in-time requests ----------------------------------------------

  /**
   * Mint a request card. Reuses the pending card for the same
   * (bot, folder) so a bot retrying in the same turn doesn't stack cards.
   * The folder is canonicalized by the caller-facing wrapper in the tool
   * layer; here we canonicalize defensively as well.
   */
  requestAccess(input: {
    botId: string;
    sessionId: string;
    folder: string;
    action: PcAccessAction;
    filePath?: string | null;
  }): PcAccessRequest {
    const folder = canonicalizeAbsolutePath(input.folder);
    const existing = this.db
      .prepare(
        "SELECT * FROM pc_access_requests WHERE bot_id = ? AND folder = ? AND status = 'pending' LIMIT 1",
      )
      .get(input.botId, folder) as RequestRow | undefined;
    if (existing) return this.rowToRequest(existing);
    const now = Date.now();
    const req: PcAccessRequest = {
      id: randomUUID(),
      botId: input.botId,
      sessionId: input.sessionId,
      folder,
      action: input.action,
      filePath: input.filePath ?? null,
      status: 'pending',
      createdAt: now,
      expiresAt: now + PC_ACCESS_REQUEST_TTL_MS,
      decidedAt: null,
    };
    this.db
      .prepare(
        'INSERT INTO pc_access_requests (id, bot_id, session_id, folder, action, file_path, status, created_at, expires_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        req.id, req.botId, req.sessionId, req.folder, req.action, req.filePath,
        req.status, req.createdAt, req.expiresAt, null,
      );
    return req;
  }

  getRequest(id: string): PcAccessRequest | undefined {
    const row = this.db.prepare('SELECT * FROM pc_access_requests WHERE id = ?').get(id) as
      | RequestRow
      | undefined;
    return row ? this.rowToRequest(row) : undefined;
  }

  listRequests(status?: PcAccessRequestStatus): PcAccessRequest[] {
    const rows = (status
      ? this.db
          .prepare('SELECT * FROM pc_access_requests WHERE status = ? ORDER BY created_at DESC')
          .all(status)
      : this.db
          .prepare('SELECT * FROM pc_access_requests ORDER BY created_at DESC')
          .all()) as unknown as RequestRow[];
    return rows.map((r) => this.rowToRequest(r));
  }

  /**
   * Settle a request with the user's decision (wire spelling: 'deny').
   * 'always' also creates a grant scoped to the requesting bot (least
   * privilege — an all-bots grant is a deliberate Settings action).
   * 'allow-once' records a session-scoped allowance. Waiting tool calls
   * resolve with the PcAccessOutcome spelling ('denied'). Returns null
   * when the card isn't pending.
   */
  decide(id: string, decision: 'allow-once' | 'always' | 'deny'): PcAccessRequest | null {
    const req = this.getRequest(id);
    if (!req || req.status !== 'pending') return null;
    const outcome: PcAccessOutcome =
      decision === 'allow-once' ? 'allow-once' : decision === 'always' ? 'always' : 'denied';
    const status: PcAccessRequestStatus =
      outcome === 'allow-once' ? 'allowed-once' : outcome === 'always' ? 'always-allowed' : 'denied';
    const now = Date.now();
    this.db
      .prepare('UPDATE pc_access_requests SET status = ?, decided_at = ? WHERE id = ?')
      .run(status, now, id);
    if (outcome === 'always') {
      this.addGrant({ path: req.folder, botId: req.botId, createdVia: 'approval' });
    } else if (outcome === 'allow-once') {
      this.recordOnceAllowance(req.sessionId, req.folder);
    }
    const waiter = this.waiters.get(id);
    if (waiter) {
      this.waiters.delete(id);
      waiter(outcome);
    }
    return { ...req, status, decidedAt: now };
  }

  /** Transition past-TTL pending cards to 'expired'. Returns expired ids. */
  expireStale(now = Date.now()): string[] {
    const rows = this.db
      .prepare(
        "SELECT id FROM pc_access_requests WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?",
      )
      .all(now) as unknown as Array<{ id: string }>;
    for (const r of rows) {
      this.db
        .prepare("UPDATE pc_access_requests SET status = 'expired', decided_at = ? WHERE id = ?")
        .run(now, r.id);
      const waiter = this.waiters.get(r.id);
      if (waiter) {
        this.waiters.delete(r.id);
        waiter('denied');
      }
    }
    return rows.map((r) => r.id);
  }

  /**
   * Wait for the user to decide a request. Resolves 'denied' on
   * deny/expire/timeout (fail-closed — the tool call then refuses).
   */
  awaitOutcome(id: string, timeoutMs = PC_ACCESS_REQUEST_TTL_MS): Promise<PcAccessOutcome> {
    const req = this.getRequest(id);
    if (!req) return Promise.resolve('denied');
    if (req.status === 'allowed-once') return Promise.resolve('allow-once');
    if (req.status === 'always-allowed') return Promise.resolve('always');
    if (req.status !== 'pending') return Promise.resolve('denied');
    return new Promise<PcAccessOutcome>((resolvePromise) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        resolvePromise('denied');
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.waiters.set(id, (outcome) => {
        clearTimeout(timer);
        resolvePromise(outcome);
      });
    });
  }

  close(): void {
    this.db.close();
  }

  private rowToGrant(row: GrantRow): PcFolderGrant {
    return {
      id: row.id,
      path: row.path,
      scope: row.bot_id === '' ? 'all' : row.bot_id,
      readOnly: true,
      createdAt: row.created_at,
      createdVia: row.created_via === 'approval' ? 'approval' : 'settings',
    };
  }

  private rowToRequest(row: RequestRow): PcAccessRequest {
    return {
      id: row.id,
      botId: row.bot_id,
      sessionId: row.session_id,
      folder: row.folder,
      action: row.action === 'read' ? 'read' : 'list',
      filePath: row.file_path,
      status: row.status as PcAccessRequestStatus,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      decidedAt: row.decided_at,
    };
  }
}

// ---------------------------------------------------------------------------
// Per-turn host (wired by the API, mirroring CredentialProposer)
// ---------------------------------------------------------------------------

export interface PcAccessHost {
  /** Canonical grant roots applicable to this bot. */
  grantedRoots(botId: string): readonly string[];
  /** Session-scoped allow-once check; input is a canonical folder/path. */
  isOnceAllowed(sessionId: string, canonicalPath: string): boolean;
  /**
   * Raise a just-in-time request card for a folder and await the user's
   * decision. Implementations mint the card, wait, and return the outcome
   * ('denied' on timeout/expiry — fail-closed).
   */
  requestAccess(input: {
    botId: string;
    sessionId: string;
    folder: string;
    action: PcAccessAction;
    filePath?: string | null;
  }): Promise<PcAccessOutcome>;
}

/**
 * The access decision the file tools make before touching a PC path
 * outside the workspace. Order: standing grant → allow-once (this
 * session) → just-in-time request card. Returns the folder/root the
 * access is anchored to, or a refusal reason for the model.
 */
export async function ensurePcFolderAccess(
  ctx: ToolContext,
  canonicalFolder: string,
  action: PcAccessAction,
  filePath?: string | null,
): Promise<{ ok: true; via: 'grant' | 'once' | 'approved'; root: string } | { ok: false; reason: string }> {
  const host = ctx.pcAccess;
  if (!host) {
    return {
      ok: false,
      reason:
        `Access to "${canonicalFolder}" is outside the workspace and PC file access is not ` +
        'attached to this turn (headless/CI). The user can grant folders in Settings → ' +
        'Permissions → PC file access.',
    };
  }
  for (const root of host.grantedRoots(ctx.botId)) {
    if (isPathInsideRoot(root, canonicalFolder)) return { ok: true, via: 'grant', root };
  }
  if (host.isOnceAllowed(ctx.sessionId, canonicalFolder)) {
    return { ok: true, via: 'once', root: canonicalFolder };
  }
  const outcome = await host.requestAccess({
    botId: ctx.botId,
    sessionId: ctx.sessionId,
    folder: canonicalFolder,
    action,
    filePath: filePath ?? null,
  });
  if (outcome === 'denied') {
    return {
      ok: false,
      reason:
        `The user denied access to "${canonicalFolder}". Do not retry this path in this ` +
        'conversation unless the user asks again or grants the folder in Settings → ' +
        'Permissions → PC file access.',
    };
  }
  return { ok: true, via: 'approved', root: canonicalFolder };
}
