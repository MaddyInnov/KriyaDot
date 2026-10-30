// SPDX-License-Identifier: Apache-2.0
// BR-7 — Formal file grants for browser tasks (Muse parity audit §4.11).
//
// A browser task may touch local files ONLY under a grant a person
// minted for it. A grant is:
//
//   scoped    — one browser profile, optionally one task and one chat
//               session, one direction (upload | download), and one
//               path scope: a workspace-relative file or directory
//               prefix the file must live under (confinement-checked
//               with the same confineFile the file routes use).
//   sized     — the grant names a SIZE CLASS and the file's real size
//               must fit it. Classes exist because browser file grants
//               have a hard classification ceiling: a 162 MB upload was
//               rejected by the grant classifier in production while an
//               84 MB copy passed. The ceiling here is therefore a
//               hard 100 MiB: no grant can authorize a larger file, in
//               any class, ever — the runner must shrink the file
//               (e.g. re-encode) and present the smaller copy instead.
//   bounded   — expiring (≤ 24h), use-counted (default single-use for
//               uploads), revocable; only the token's SHA-256 hash is
//               stored and the token is shown exactly once at mint.
//
// authorize() is the runner's gate: it validates token, scope, path
// confinement and size, and consumes one use — atomically, fail-closed.
// A denied authorize() never consumes a use.
//
// Persistence: SQLite (browser-file-grants.db under the host data dir),
// following the file-links.ts store pattern.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import express, { type Router } from 'express';
import { openDb as openSqliteDb } from '@mvp/agent-runtime';
import { confineFile } from './files.js';

export const FILE_GRANT_SIZE_CLASSES = {
  /** ≤ 10 MiB — documents, images, small clips. */
  S: 10 * 1024 * 1024,
  /** ≤ 50 MiB — short videos, archives, datasets. */
  M: 50 * 1024 * 1024,
  /** ≤ 100 MiB — the hard classification ceiling (see header). */
  L: 100 * 1024 * 1024,
} as const;
export type FileGrantSizeClass = keyof typeof FILE_GRANT_SIZE_CLASSES;

/** Hard ceiling: no grant, in any class, can authorize a larger file. */
export const FILE_GRANT_HARD_MAX_BYTES = FILE_GRANT_SIZE_CLASSES.L;

export function isFileGrantSizeClass(v: unknown): v is FileGrantSizeClass {
  return v === 'S' || v === 'M' || v === 'L';
}

/** Classify a byte count; null when it exceeds the hard ceiling. */
export function classifyFileSize(sizeBytes: number): FileGrantSizeClass | null {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return null;
  if (sizeBytes <= FILE_GRANT_SIZE_CLASSES.S) return 'S';
  if (sizeBytes <= FILE_GRANT_SIZE_CLASSES.M) return 'M';
  if (sizeBytes <= FILE_GRANT_SIZE_CLASSES.L) return 'L';
  return null;
}

export type FileGrantDirection = 'upload' | 'download';

export interface BrowserFileGrant {
  id: string;
  direction: FileGrantDirection;
  profileId: string;
  taskId?: string;
  sessionId?: string;
  /** Workspace-relative scope: a file path, or a directory prefix ending in '/'. */
  pathScope: string;
  sizeClass: FileGrantSizeClass;
  maxBytes: number;
  grantedBy: string;
  createdAt: number;
  expiresAt: number;
  maxUses: number;
  usedCount: number;
  revokedAt?: number;
}

export interface FileGrantAuthorization {
  ok: true;
  grant: BrowserFileGrant;
  /** The size class the presented file actually falls in. */
  actualClass: FileGrantSizeClass;
}

export class FileGrantDeniedError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`file grant denied: ${reason}`);
    this.name = 'FileGrantDeniedError';
    this.reason = reason;
  }
}

const MAX_GRANT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_GRANT_TTL_MS = 60 * 60 * 1000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS browser_file_grants (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    direction TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    task_id TEXT,
    session_id TEXT,
    path_scope TEXT NOT NULL,
    size_class TEXT NOT NULL,
    max_bytes INTEGER NOT NULL,
    granted_by TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    max_uses INTEGER NOT NULL,
    used_count INTEGER NOT NULL DEFAULT 0,
    revoked_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_browser_file_grants_profile ON browser_file_grants(profile_id, expires_at);
`;

interface GrantRow {
  id: string;
  direction: string;
  profile_id: string;
  task_id: string | null;
  session_id: string | null;
  path_scope: string;
  size_class: string;
  max_bytes: number;
  granted_by: string;
  created_at: number;
  expires_at: number;
  max_uses: number;
  used_count: number;
  revoked_at: number | null;
}

function rowToGrant(r: GrantRow): BrowserFileGrant {
  return {
    id: r.id,
    direction: r.direction === 'download' ? 'download' : 'upload',
    profileId: r.profile_id,
    taskId: r.task_id ?? undefined,
    sessionId: r.session_id ?? undefined,
    pathScope: r.path_scope,
    sizeClass: r.size_class as FileGrantSizeClass,
    maxBytes: r.max_bytes,
    grantedBy: r.granted_by,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    maxUses: r.max_uses,
    usedCount: r.used_count,
    revokedAt: r.revoked_at ?? undefined,
  };
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Normalize a workspace-relative scope: no leading '/', no '..' escapes. */
export function normalizePathScope(raw: string): string {
  const v = raw.trim().split(path.sep).join('/');
  if (!v || v.startsWith('/') || v.split('/').includes('..')) {
    throw new Error(`invalid path scope: ${raw}`);
  }
  return v;
}

/** Is `relPath` inside the grant's scope (exact file, or directory prefix)? */
export function pathWithinScope(pathScope: string, relPath: string): boolean {
  const rel = relPath.split(path.sep).join('/');
  if (pathScope.endsWith('/')) return rel.startsWith(pathScope) && rel.length > pathScope.length;
  return rel === pathScope;
}

export class BrowserFileGrantStore {
  protected readonly db: DatabaseSync;
  private readonly nowFn: () => number;

  constructor(
    protected readonly dataDir: string,
    opts: { now?: () => number } = {},
  ) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = openSqliteDb(path.join(dataDir, 'browser-file-grants.db'));
    this.db.exec(SCHEMA);
    this.nowFn = opts.now ?? (() => Date.now());
  }

  mint(input: {
    direction: FileGrantDirection;
    profileId: string;
    taskId?: string;
    sessionId?: string;
    pathScope: string;
    sizeClass: FileGrantSizeClass;
    grantedBy?: string;
    ttlMs?: number;
    maxUses?: number;
  }): { grant: BrowserFileGrant; token: string } {
    if (input.direction !== 'upload' && input.direction !== 'download') {
      throw new Error('direction must be upload | download');
    }
    if (!input.profileId) throw new Error('profileId is required');
    if (!isFileGrantSizeClass(input.sizeClass)) throw new Error('sizeClass must be S | M | L');
    const ttlMs = input.ttlMs ?? DEFAULT_GRANT_TTL_MS;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > MAX_GRANT_TTL_MS) {
      throw new Error('file grant ttl must be within (0, 24h]');
    }
    const maxUses = input.maxUses ?? (input.direction === 'upload' ? 1 : 5);
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 100) {
      throw new Error('maxUses must be an integer within [1, 100]');
    }
    const now = this.nowFn();
    const token = randomBytes(32).toString('base64url');
    const grant: BrowserFileGrant = {
      id: randomUUID(),
      direction: input.direction,
      profileId: input.profileId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      pathScope: normalizePathScope(input.pathScope),
      sizeClass: input.sizeClass,
      maxBytes: FILE_GRANT_SIZE_CLASSES[input.sizeClass],
      grantedBy: (input.grantedBy ?? '').slice(0, 100),
      createdAt: now,
      expiresAt: now + ttlMs,
      maxUses,
      usedCount: 0,
    };
    this.db
      .prepare(
        `INSERT INTO browser_file_grants (id, token_hash, direction, profile_id, task_id, session_id, path_scope, size_class, max_bytes, granted_by, created_at, expires_at, max_uses, used_count, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)`,
      )
      .run(
        grant.id,
        hashToken(token),
        grant.direction,
        grant.profileId,
        grant.taskId ?? null,
        grant.sessionId ?? null,
        grant.pathScope,
        grant.sizeClass,
        grant.maxBytes,
        grant.grantedBy,
        grant.createdAt,
        grant.expiresAt,
        grant.maxUses,
      );
    return { grant, token };
  }

  get(id: string): BrowserFileGrant | undefined {
    const row = this.db.prepare('SELECT * FROM browser_file_grants WHERE id = ?').get(id) as unknown as GrantRow | undefined;
    return row ? rowToGrant(row) : undefined;
  }

  list(profileId?: string): BrowserFileGrant[] {
    const rows = (
      profileId
        ? this.db.prepare('SELECT * FROM browser_file_grants WHERE profile_id = ? ORDER BY created_at DESC').all(profileId)
        : this.db.prepare('SELECT * FROM browser_file_grants ORDER BY created_at DESC').all()
    ) as unknown as GrantRow[];
    return rows.map(rowToGrant);
  }

  revoke(id: string): BrowserFileGrant {
    const grant = this.get(id);
    if (!grant) throw new Error(`unknown file grant: ${id}`);
    if (grant.revokedAt) return grant;
    const now = this.nowFn();
    this.db.prepare('UPDATE browser_file_grants SET revoked_at = ? WHERE id = ?').run(now, id);
    return { ...grant, revokedAt: now };
  }

  /**
   * The runner's gate. Validates everything and consumes one use.
   * `workspaceRoot` confinement is checked when provided: the file must
   * really exist under it, inside the grant's path scope.
   * Throws FileGrantDeniedError (fail-closed) on any mismatch.
   */
  authorize(input: {
    token: string;
    direction: FileGrantDirection;
    profileId: string;
    taskId?: string;
    sessionId?: string;
    relPath: string;
    sizeBytes: number;
    workspaceRoot?: string;
  }): FileGrantAuthorization {
    if (!input.token || typeof input.token !== 'string') throw new FileGrantDeniedError('no grant token presented');
    const row = this.db
      .prepare('SELECT * FROM browser_file_grants WHERE token_hash = ?')
      .get(hashToken(input.token)) as unknown as GrantRow | undefined;
    if (!row) throw new FileGrantDeniedError('unknown grant token');
    const grant = rowToGrant(row);
    const now = this.nowFn();
    if (grant.revokedAt) throw new FileGrantDeniedError('grant was revoked');
    if (now >= grant.expiresAt) throw new FileGrantDeniedError('grant expired');
    if (grant.usedCount >= grant.maxUses) throw new FileGrantDeniedError('grant use count exhausted');
    if (grant.direction !== input.direction) {
      throw new FileGrantDeniedError(`grant is for ${grant.direction}, not ${input.direction}`);
    }
    if (grant.profileId !== input.profileId) throw new FileGrantDeniedError('grant is scoped to a different browser profile');
    if (grant.taskId && grant.taskId !== input.taskId) throw new FileGrantDeniedError('grant is scoped to a different task');
    if (grant.sessionId && grant.sessionId !== input.sessionId) {
      throw new FileGrantDeniedError('grant is scoped to a different chat session');
    }
    const rel = input.relPath.split(path.sep).join('/');
    if (!pathWithinScope(grant.pathScope, rel)) {
      throw new FileGrantDeniedError(`path "${rel}" is outside the grant scope "${grant.pathScope}"`);
    }
    const actualClass = classifyFileSize(input.sizeBytes);
    if (actualClass === null) {
      throw new FileGrantDeniedError(
        `file is ${input.sizeBytes} bytes — above the ${FILE_GRANT_HARD_MAX_BYTES}-byte hard classification ceiling; no grant can authorize it (shrink the file and retry)`,
      );
    }
    if (input.sizeBytes > grant.maxBytes) {
      throw new FileGrantDeniedError(
        `file is ${input.sizeBytes} bytes (class ${actualClass}) but the grant caps at class ${grant.sizeClass} (${grant.maxBytes} bytes)`,
      );
    }
    if (input.workspaceRoot) {
      // Real confinement + existence check against the workspace.
      const abs = confineFile(input.workspaceRoot, rel);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        throw new FileGrantDeniedError(`file not found in workspace: ${rel}`);
      }
      if (!stat.isFile()) throw new FileGrantDeniedError(`not a file: ${rel}`);
      if (stat.size !== input.sizeBytes) {
        throw new FileGrantDeniedError(`size mismatch: runner reported ${input.sizeBytes}, file is ${stat.size}`);
      }
    }
    const res = this.db
      .prepare('UPDATE browser_file_grants SET used_count = used_count + 1 WHERE id = ? AND used_count < max_uses AND revoked_at IS NULL')
      .run(grant.id);
    if (Number((res as { changes?: number }).changes ?? 0) === 0) {
      throw new FileGrantDeniedError('grant use count exhausted');
    }
    return { ok: true, grant: { ...grant, usedCount: grant.usedCount + 1 }, actualClass };
  }
}

// ---------------------------------------------------------------------------
// Routes — mount under /api/browser (paths are /file-grants…)
// ---------------------------------------------------------------------------

export interface BrowserFileGrantRouterDeps {
  store: BrowserFileGrantStore;
  /** Workspace root for confinement checks on authorize; may be a getter. */
  workspaceRoot?: string | (() => string);
  audit?: (action: string, fields: { actor?: string; detail?: unknown }) => void;
}

export function registerBrowserFileGrantRoutes(router: Router, deps: BrowserFileGrantRouterDeps): void {
  const { store } = deps;
  const root = (): string | undefined =>
    typeof deps.workspaceRoot === 'function' ? deps.workspaceRoot() : deps.workspaceRoot;

  router.post('/file-grants', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const { grant, token } = store.mint({
        direction: body.direction as FileGrantDirection,
        profileId: typeof body.profileId === 'string' ? body.profileId : '',
        taskId: typeof body.taskId === 'string' ? body.taskId : undefined,
        sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
        pathScope: typeof body.pathScope === 'string' ? body.pathScope : '',
        sizeClass: body.sizeClass as FileGrantSizeClass,
        grantedBy: typeof body.grantedBy === 'string' ? body.grantedBy : undefined,
        ttlMs: typeof body.ttlMs === 'number' ? body.ttlMs : undefined,
        maxUses: typeof body.maxUses === 'number' ? body.maxUses : undefined,
      });
      deps.audit?.('browser.file_grant_minted', {
        actor: grant.grantedBy || undefined,
        detail: {
          grantId: grant.id,
          direction: grant.direction,
          profileId: grant.profileId,
          pathScope: grant.pathScope,
          sizeClass: grant.sizeClass,
        },
      });
      res.status(201).json({ ok: true, grant, token });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/file-grants', (req, res) => {
    const profileId = typeof req.query.profileId === 'string' ? req.query.profileId : undefined;
    res.json({ ok: true, sizeClasses: FILE_GRANT_SIZE_CLASSES, hardMaxBytes: FILE_GRANT_HARD_MAX_BYTES, grants: store.list(profileId) });
  });

  router.post('/file-grants/:id/revoke', (req, res) => {
    try {
      const grant = store.revoke(req.params.id);
      deps.audit?.('browser.file_grant_revoked', { detail: { grantId: grant.id } });
      res.json({ ok: true, grant });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/file-grants/authorize', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const auth = store.authorize({
        token: typeof body.token === 'string' ? body.token : '',
        direction: body.direction as FileGrantDirection,
        profileId: typeof body.profileId === 'string' ? body.profileId : '',
        taskId: typeof body.taskId === 'string' ? body.taskId : undefined,
        sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
        relPath: typeof body.relPath === 'string' ? body.relPath : '',
        sizeBytes: typeof body.sizeBytes === 'number' ? body.sizeBytes : NaN,
        workspaceRoot: root(),
      });
      res.json({ ok: true, authorization: auth });
    } catch (err) {
      const status = err instanceof FileGrantDeniedError ? 403 : 400;
      res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}

export function createBrowserFileGrantRouter(deps: BrowserFileGrantRouterDeps): Router {
  const router = express.Router();
  registerBrowserFileGrantRoutes(router, deps);
  return router;
}
