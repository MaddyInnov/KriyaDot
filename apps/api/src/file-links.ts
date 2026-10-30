// SPDX-License-Identifier: Apache-2.0
// FL-7 — Expiring public file download links.
//
// A link gives an unauthenticated holder a time-boxed download of ONE
// workspace file (or one chat upload). Rules:
//   - TTL is per-link, 1 minute … 48 hours. 48h is a hard cap
//     (MAX_FILE_LINK_TTL_MS); the service cap can be lowered by the host
//     but never raised above it.
//   - Creation is approval-gated (see lifecycle-approval.ts): with a
//     governance gateway wired, creation mints a real approval and the
//     link stays `pending-approval` (publicly unusable) until the gateway
//     records an approval; without a gateway an explicit
//     `confirmed: true` is required and is recorded on the link + audit.
//   - Only the SHA-256 hash of the token is stored; the token itself is
//     returned exactly once at creation.
//   - A link can be revoked at any time; expiry and revocation are both
//     checked on every public download. Downloads are counted.
//
// Public serving: GET /f/<token> (registerFileLinkServing — mount on the
// express app, outside /api, like the /p/<slug> public page route).
// Management: registerFileLinkRoutes — mount on a router at /api/files
// (paths are /links…).

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Router } from 'express';
import type { Express, Request, Response } from 'express';
import { openDb as openSqliteDb } from '@mvp/agent-runtime';
import { confineFile } from './files.js';
import {
  LifecycleAuditLog,
  auditLifecycle,
  beginApproval,
  isApprovalRequiredError,
  syncApprovalStatus,
  type LifecycleGovernance,
} from './lifecycle-approval.js';

export const MAX_FILE_LINK_TTL_MS = 48 * 60 * 60 * 1000;
export const DEFAULT_FILE_LINK_TTL_MS = 24 * 60 * 60 * 1000;
const MIN_FILE_LINK_TTL_MS = 60 * 1000;

export type FileLinkStatus = 'pending-approval' | 'active' | 'denied' | 'revoked';
export type FileLinkKind = 'workspace' | 'upload';

export interface FileLink {
  id: string;
  kind: FileLinkKind;
  /** Workspace root (kind 'workspace') or uploads dir (kind 'upload'). */
  root: string;
  /** Workspace-relative path, or stored upload filename. */
  relPath: string;
  uploadId?: string;
  label: string;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  revokedAt?: number;
  status: FileLinkStatus;
  approvalId?: string;
  approvalMode?: 'governance' | 'confirmed-flag';
  downloads: number;
}

interface FileLinkRow {
  id: string;
  token_hash: string;
  kind: string;
  root: string;
  rel_path: string;
  upload_id: string | null;
  label: string;
  created_by: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  status: string;
  approval_id: string | null;
  approval_mode: string | null;
  downloads: number;
}

function rowToLink(r: FileLinkRow): FileLink {
  return {
    id: r.id,
    kind: r.kind === 'upload' ? 'upload' : 'workspace',
    root: r.root,
    relPath: r.rel_path,
    uploadId: r.upload_id ?? undefined,
    label: r.label,
    createdBy: r.created_by,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at ?? undefined,
    status: r.status as FileLinkStatus,
    approvalId: r.approval_id ?? undefined,
    approvalMode: (r.approval_mode as FileLink['approvalMode']) ?? undefined,
    downloads: r.downloads,
  };
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS file_links (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    root TEXT NOT NULL,
    rel_path TEXT NOT NULL,
    upload_id TEXT,
    label TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER,
    status TEXT NOT NULL,
    approval_id TEXT,
    approval_mode TEXT,
    downloads INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_file_links_status ON file_links(status, expires_at);
`;

export function hashFileLinkToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 32 random bytes → 43 base64url chars (~256 bits). Unguessable. */
export function generateFileLinkToken(): string {
  return randomBytes(32).toString('base64url');
}

export interface FileLinkServiceOptions {
  governance?: LifecycleGovernance;
  auditLog?: LifecycleAuditLog;
  /** Host-lowered TTL cap; clamped to (0, 48h]. */
  maxTtlMs?: number;
  now?: () => number;
}

export interface CreateFileLinkInput {
  kind: FileLinkKind;
  /** Workspace root (kind 'workspace') or uploads dir (kind 'upload'). */
  root: string;
  /** Workspace-relative path (kind 'workspace') or upload id (kind 'upload'). */
  pathOrUploadId: string;
  label?: string;
  createdBy?: string;
  ttlMs?: number;
  /** Required when no governance gateway is wired (see lifecycle-approval). */
  confirmed?: boolean;
}

export class FileLinkService {
  protected readonly db: DatabaseSync;
  private readonly governance?: LifecycleGovernance;
  private readonly auditLog?: LifecycleAuditLog;
  private readonly maxTtlMs: number;
  private readonly nowFn: () => number;

  constructor(
    protected readonly dataDir: string,
    opts: FileLinkServiceOptions = {},
  ) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = openSqliteDb(path.join(dataDir, 'file-lifecycle.db'));
    this.db.exec(SCHEMA);
    this.governance = opts.governance;
    this.auditLog = opts.auditLog ?? new LifecycleAuditLog(dataDir);
    this.maxTtlMs = Math.min(Math.max(opts.maxTtlMs ?? MAX_FILE_LINK_TTL_MS, MIN_FILE_LINK_TTL_MS), MAX_FILE_LINK_TTL_MS);
    this.nowFn = opts.now ?? (() => Date.now());
  }

  get maxTtl(): number {
    return this.maxTtlMs;
  }

  /** Resolve + validate the target file; returns the stored relPath. */
  private resolveTarget(input: CreateFileLinkInput): { relPath: string; uploadId?: string } {
    if (input.kind === 'workspace') {
      const abs = confineFile(input.root, input.pathOrUploadId);
      const stat = fs.statSync(abs);
      if (!stat.isFile()) throw new Error(`not a file: ${input.pathOrUploadId}`);
      return { relPath: input.pathOrUploadId.split(path.sep).join('/') };
    }
    const uploadId = input.pathOrUploadId;
    if (!/^[0-9a-f-]{36}$/i.test(uploadId)) throw new Error(`invalid upload id: ${uploadId}`);
    const entries = fs.readdirSync(input.root);
    const match = entries.find((f) => f.startsWith(`${uploadId}-`) && !f.endsWith('.meta.json') && !f.endsWith('.extracted.txt'));
    if (!match) throw new Error(`upload not found: ${uploadId}`);
    return { relPath: match, uploadId };
  }

  /**
   * Create a link. Returns the link plus the one-time token. With a
   * governance gateway the link is `pending-approval` until syncStatus()
   * observes the approval; the token is still returned at creation so the
   * requester can share it once approved (it 404s while pending).
   */
  create(input: CreateFileLinkInput): { link: FileLink; token: string; path: string } {
    const ttlMs = input.ttlMs ?? DEFAULT_FILE_LINK_TTL_MS;
    if (!Number.isFinite(ttlMs) || ttlMs < MIN_FILE_LINK_TTL_MS) {
      throw new Error(`file link ttl must be at least ${MIN_FILE_LINK_TTL_MS / 1000}s`);
    }
    if (ttlMs > this.maxTtlMs) {
      throw new Error(`file link ttl exceeds the ${Math.round(this.maxTtlMs / 3600_000)}h cap`);
    }
    if (ttlMs > MAX_FILE_LINK_TTL_MS) {
      throw new Error('file link ttl exceeds the 48h cap');
    }
    const target = this.resolveTarget(input);
    const createdBy = (input.createdBy ?? '').slice(0, 100);
    const approval = beginApproval({
      governance: this.governance,
      toolName: 'file_link.create',
      args: {
        kind: input.kind,
        path: target.relPath,
        ttlHours: Math.round((ttlMs / 3600_000) * 100) / 100,
        label: (input.label ?? '').slice(0, 200),
      },
      actor: createdBy || 'api',
      confirmed: input.confirmed,
    });
    const now = this.nowFn();
    const token = generateFileLinkToken();
    const link: FileLink = {
      id: randomUUID(),
      kind: input.kind,
      root: path.resolve(input.root),
      relPath: target.relPath,
      uploadId: target.uploadId,
      label: (input.label ?? '').slice(0, 200),
      createdBy,
      createdAt: now,
      expiresAt: now + ttlMs,
      status: approval.status === 'active' ? 'active' : 'pending-approval',
      approvalId: approval.approvalId,
      approvalMode: approval.mode,
      downloads: 0,
    };
    this.db
      .prepare(
        `INSERT INTO file_links (id, token_hash, kind, root, rel_path, upload_id, label, created_by, created_at, expires_at, revoked_at, status, approval_id, approval_mode, downloads)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 0)`,
      )
      .run(
        link.id,
        hashFileLinkToken(token),
        link.kind,
        link.root,
        link.relPath,
        link.uploadId ?? null,
        link.label,
        link.createdBy,
        link.createdAt,
        link.expiresAt,
        link.status,
        link.approvalId ?? null,
        link.approvalMode ?? null,
      );
    auditLifecycle(this.governance, this.auditLog, 'file_link.created', createdBy || 'api', {
      linkId: link.id,
      kind: link.kind,
      path: link.relPath,
      expiresAt: link.expiresAt,
      status: link.status,
      approvalMode: link.approvalMode,
      approvalId: link.approvalId,
    });
    return { link, token, path: `/f/${token}` };
  }

  get(id: string): FileLink | undefined {
    const row = this.db.prepare('SELECT * FROM file_links WHERE id = ?').get(id) as unknown as FileLinkRow | undefined;
    return row ? rowToLink(row) : undefined;
  }

  list(): FileLink[] {
    const rows = this.db.prepare('SELECT * FROM file_links ORDER BY created_at DESC').all() as unknown as FileLinkRow[];
    return rows.map(rowToLink);
  }

  /** Promote/deny a pending link from the gateway's decision. Returns the fresh link. */
  syncStatus(id: string): FileLink {
    const link = this.get(id);
    if (!link) throw new Error(`unknown file link: ${id}`);
    if (link.status !== 'pending-approval') return link;
    const mapped = syncApprovalStatus(
      this.governance,
      link.approvalId,
      link.status === 'pending-approval' ? 'pending' : link.status === 'active' ? 'active' : 'denied',
    );
    const next: FileLinkStatus = mapped === 'active' ? 'active' : mapped === 'denied' ? 'denied' : 'pending-approval';
    if (next !== link.status) {
      this.db.prepare('UPDATE file_links SET status = ? WHERE id = ?').run(next, id);
      auditLifecycle(this.governance, this.auditLog, 'file_link.approval_synced', link.createdBy || 'api', {
        linkId: id,
        status: next,
        approvalId: link.approvalId,
      });
      return { ...link, status: next };
    }
    return link;
  }

  revoke(id: string): FileLink {
    const link = this.get(id);
    if (!link) throw new Error(`unknown file link: ${id}`);
    if (link.status === 'revoked') return link;
    const now = this.nowFn();
    this.db.prepare("UPDATE file_links SET status = 'revoked', revoked_at = ? WHERE id = ?").run(now, id);
    auditLifecycle(this.governance, this.auditLog, 'file_link.revoked', link.createdBy || 'api', { linkId: id });
    return { ...link, status: 'revoked', revokedAt: now };
  }

  /** Revoke every non-revoked link pointing at `ref` (a relPath or upload id). Used by atomic artifact delete (FL-8). */
  revokeForRef(ref: string): number {
    const rows = this.db
      .prepare("SELECT * FROM file_links WHERE status != 'revoked' AND (rel_path = ? OR upload_id = ?)")
      .all(ref, ref) as unknown as FileLinkRow[];
    for (const row of rows) this.revoke(row.id);
    return rows.length;
  }

  /**
   * Validate a presented token for a public download. Checks (in order):
   * known token → approval status (synced) → not revoked/denied → not
   * expired. Returns the link or throws with a stable reason.
   */
  resolveToken(token: string): FileLink {
    if (!token || token.length < 20 || token.length > 128) throw new Error('invalid file link token');
    const row = this.db
      .prepare('SELECT * FROM file_links WHERE token_hash = ?')
      .get(hashFileLinkToken(token)) as unknown as FileLinkRow | undefined;
    if (!row) throw new Error('file link not found');
    let link = rowToLink(row);
    if (link.status === 'pending-approval') link = this.syncStatus(link.id);
    if (link.status === 'revoked') throw new Error('file link revoked');
    if (link.status === 'denied') throw new Error('file link approval denied');
    if (link.status === 'pending-approval') throw new Error('file link pending approval');
    if (this.nowFn() >= link.expiresAt) throw new Error('file link expired');
    return link;
  }

  /** Absolute path + download filename for a validated link. */
  fileForDownload(link: FileLink): { absPath: string; fileName: string; size: number } {
    const absPath =
      link.kind === 'workspace' ? confineFile(link.root, link.relPath) : path.join(link.root, link.relPath);
    if (link.kind === 'upload' && path.dirname(absPath) !== path.resolve(link.root)) {
      throw new Error('file link target escapes uploads dir');
    }
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) throw new Error('file link target is not a file');
    return { absPath, fileName: path.basename(link.relPath), size: stat.size };
  }

  recordDownload(id: string): void {
    this.db.prepare('UPDATE file_links SET downloads = downloads + 1 WHERE id = ?').run(id);
  }
}

// ---------------------------------------------------------------------------
// Management routes — mount on a router at /api/files (paths are /links…)
// ---------------------------------------------------------------------------

export interface FileLinkDeps {
  dataDir: string;
  workspaceRoot: string | (() => string);
  uploadsDir?: string;
  service?: FileLinkService;
  governance?: LifecycleGovernance;
}

export function registerFileLinkRoutes(router: Router, deps: FileLinkDeps): void {
  const service =
    deps.service ?? new FileLinkService(deps.dataDir, { governance: deps.governance });
  const uploadsDir = deps.uploadsDir ?? path.join(deps.dataDir, 'uploads');
  const root = (): string => (typeof deps.workspaceRoot === 'function' ? deps.workspaceRoot() : deps.workspaceRoot);

  router.post('/links', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as {
        path?: unknown;
        uploadId?: unknown;
        ttlHours?: unknown;
        ttlMs?: unknown;
        label?: unknown;
        createdBy?: unknown;
        confirmed?: unknown;
      };
      const ttlMs =
        typeof body.ttlMs === 'number'
          ? body.ttlMs
          : typeof body.ttlHours === 'number'
            ? body.ttlHours * 3600_000
            : undefined;
      const createdBy = typeof body.createdBy === 'string' ? body.createdBy : undefined;
      let created: { link: FileLink; token: string; path: string };
      if (typeof body.uploadId === 'string' && body.uploadId) {
        created = service.create({
          kind: 'upload',
          root: uploadsDir,
          pathOrUploadId: body.uploadId,
          ttlMs,
          label: typeof body.label === 'string' ? body.label : undefined,
          createdBy,
          confirmed: body.confirmed === true,
        });
      } else if (typeof body.path === 'string' && body.path) {
        created = service.create({
          kind: 'workspace',
          root: root(),
          pathOrUploadId: body.path,
          ttlMs,
          label: typeof body.label === 'string' ? body.label : undefined,
          createdBy,
          confirmed: body.confirmed === true,
        });
      } else {
        res.status(400).json({ error: '"path" (workspace-relative) or "uploadId" is required' });
        return;
      }
      res.status(created.link.status === 'pending-approval' ? 202 : 201).json({
        ok: true,
        link: created.link,
        token: created.token,
        path: created.path,
        url: created.path,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'failed to create file link';
      res.status(isApprovalRequiredError(err) ? 403 : /not found|ENOENT/.test(message) ? 404 : 400).json({ error: message });
    }
  });

  router.get('/links', (_req: Request, res: Response) => {
    res.json({ ok: true, links: service.list().map((l) => service.syncStatus(l.id)) });
  });

  router.post('/links/:id/sync', (req: Request, res: Response) => {
    try {
      res.json({ ok: true, link: service.syncStatus(req.params.id) });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : 'unknown file link' });
    }
  });

  router.post('/links/:id/revoke', (req: Request, res: Response) => {
    try {
      res.json({ ok: true, link: service.revoke(req.params.id) });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : 'unknown file link' });
    }
  });

  router.delete('/links/:id', (req: Request, res: Response) => {
    try {
      res.json({ ok: true, link: service.revoke(req.params.id) });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : 'unknown file link' });
    }
  });
}

// ---------------------------------------------------------------------------
// Public serving — mount on the express app, outside /api (no auth)
// ---------------------------------------------------------------------------

export function registerFileLinkServing(app: Express, deps: FileLinkDeps): void {
  const service =
    deps.service ?? new FileLinkService(deps.dataDir, { governance: deps.governance });

  app.get('/f/:token', (req: Request, res: Response) => {
    let link: FileLink;
    try {
      link = service.resolveToken(req.params.token);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'not found';
      const status = /expired/.test(message) ? 410 : /revoked|denied|pending/.test(message) ? 403 : 404;
      res.status(status).type('text').send(status === 410 ? 'Link expired' : 'Not found');
      return;
    }
    try {
      const { absPath, fileName } = service.fileForDownload(link);
      service.recordDownload(link.id);
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store');
      const stream = fs.createReadStream(absPath);
      stream.on('error', () => {
        if (!res.headersSent) res.status(404).type('text').send('Not found');
      });
      stream.pipe(res);
    } catch {
      res.status(404).type('text').send('Not found');
    }
  });
}
