// SPDX-License-Identifier: Apache-2.0
// BR-12 — Browser downloads & screenshots as protected artifacts
// (Muse parity audit §4.11; builds on FL-7 expiring file links,
// apps/api/src/file-links.ts, shipped in Slice 1).
//
// A file a browser task downloads — and every screenshot it takes — is
// evidence about what the bot saw and did. It must not land as a bare
// file in a shared folder. Instead it is registered here:
//
//   - bytes are written under a dedicated artifact root
//     (<dataDir>/browser-artifacts/) with an opaque stored name;
//   - an index record keeps kind (download | screenshot), the browser
//     profile + task it came from, source URL, SHA-256, size and MIME;
//   - the ONLY ways in are (a) the authenticated management routes
//     below (the host's auth applies upstream, as with the other
//     /api/browser routers) and (b) an FL-7 expiring link minted for
//     the artifact through FileLinkService — approval-gated and
//     revocable exactly like any other file link, TTL capped at 48h
//     by FL-7 itself;
//   - deleting an artifact removes the bytes AND revokes every FL-7
//     link pointing at it (FileLinkService.revokeForRef), so a shared
//     link can never outlive the artifact it exposed.
//
// There is deliberately NO public/unauthenticated route in this module:
// the public /f/<token> serving belongs to FL-7 and is only reachable
// with a link someone minted through the gated path.

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import express, { type Router } from 'express';
import { openDb as openSqliteDb } from '@mvp/agent-runtime';
import { FileLinkService, type FileLink } from './file-links.js';

export type BrowserArtifactKind = 'download' | 'screenshot';

export interface BrowserArtifact {
  id: string;
  kind: BrowserArtifactKind;
  profileId: string;
  taskId?: string;
  /** Original file name as offered by the page / chosen for the screenshot. */
  fileName: string;
  /** Opaque name under the artifact root. Never client-chosen. */
  storedName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  sourceUrl?: string;
  createdAt: number;
  createdBy: string;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS browser_artifacts (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    task_id TEXT,
    file_name TEXT NOT NULL,
    stored_name TEXT NOT NULL UNIQUE,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    source_url TEXT,
    created_at INTEGER NOT NULL,
    created_by TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_browser_artifacts_profile ON browser_artifacts(profile_id, created_at DESC);
`;

interface ArtifactRow {
  id: string;
  kind: string;
  profile_id: string;
  task_id: string | null;
  file_name: string;
  stored_name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  source_url: string | null;
  created_at: number;
  created_by: string;
}

function rowToArtifact(r: ArtifactRow): BrowserArtifact {
  return {
    id: r.id,
    kind: r.kind === 'screenshot' ? 'screenshot' : 'download',
    profileId: r.profile_id,
    taskId: r.task_id ?? undefined,
    fileName: r.file_name,
    storedName: r.stored_name,
    mimeType: r.mime_type,
    sizeBytes: r.size_bytes,
    sha256: r.sha256,
    sourceUrl: r.source_url ?? undefined,
    createdAt: r.created_at,
    createdBy: r.created_by,
  };
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.html': 'text/html',
};

function sanitizeFileName(name: string): string {
  const base = path.basename(name || 'download').replace(/[^\w.\- ]+/g, '_').slice(0, 120);
  return base || 'download';
}

export interface BrowserArtifactStoreDeps {
  /** FL-7 service for expiring links; defaults to one over the same data dir. */
  fileLinks?: FileLinkService;
  audit?: (action: string, fields: { actor?: string; detail?: unknown }) => void;
  now?: () => number;
  /** Per-artifact byte cap (default 100 MiB — the BR-7 hard ceiling). */
  maxBytes?: number;
}

export const DEFAULT_ARTIFACT_MAX_BYTES = 100 * 1024 * 1024;

export class BrowserArtifactStore {
  protected readonly db: DatabaseSync;
  /** Artifact root: the FL-7 'workspace' root links are confined to. */
  readonly artifactDir: string;
  readonly fileLinks: FileLinkService;
  private readonly audit?: BrowserArtifactStoreDeps['audit'];
  private readonly nowFn: () => number;
  private readonly maxBytes: number;

  constructor(
    protected readonly dataDir: string,
    deps: BrowserArtifactStoreDeps = {},
  ) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.artifactDir = path.join(dataDir, 'browser-artifacts');
    fs.mkdirSync(this.artifactDir, { recursive: true });
    this.db = openSqliteDb(path.join(dataDir, 'browser-artifacts.db'));
    this.db.exec(SCHEMA);
    this.fileLinks = deps.fileLinks ?? new FileLinkService(dataDir);
    this.audit = deps.audit;
    this.nowFn = deps.now ?? (() => Date.now());
    this.maxBytes = deps.maxBytes ?? DEFAULT_ARTIFACT_MAX_BYTES;
  }

  /**
   * Register bytes the browser produced. `bytes` for in-memory captures
   * (screenshots) or `sourcePath` for a file the driver downloaded to
   * disk (it is copied in; the original is left untouched).
   */
  register(input: {
    kind: BrowserArtifactKind;
    profileId: string;
    taskId?: string;
    fileName: string;
    bytes?: Uint8Array;
    sourcePath?: string;
    mimeType?: string;
    sourceUrl?: string;
    createdBy?: string;
  }): BrowserArtifact {
    if (input.kind !== 'download' && input.kind !== 'screenshot') throw new Error('kind must be download | screenshot');
    if (!input.profileId) throw new Error('profileId is required');
    let bytes: Uint8Array;
    if (input.bytes) {
      bytes = input.bytes;
    } else if (input.sourcePath) {
      bytes = fs.readFileSync(input.sourcePath);
    } else {
      throw new Error('register requires bytes or sourcePath');
    }
    if (bytes.length > this.maxBytes) {
      throw new Error(`artifact is ${bytes.length} bytes, above the ${this.maxBytes}-byte artifact cap`);
    }
    const fileName = sanitizeFileName(input.fileName);
    const ext = path.extname(fileName).toLowerCase();
    const id = randomUUID();
    const storedName = `${id}${ext}`;
    fs.writeFileSync(path.join(this.artifactDir, storedName), bytes);
    const artifact: BrowserArtifact = {
      id,
      kind: input.kind,
      profileId: input.profileId,
      taskId: input.taskId,
      fileName,
      storedName,
      mimeType: input.mimeType ?? MIME_BY_EXT[ext] ?? 'application/octet-stream',
      sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sourceUrl: input.sourceUrl,
      createdAt: this.nowFn(),
      createdBy: (input.createdBy ?? '').slice(0, 100),
    };
    this.db
      .prepare(
        `INSERT INTO browser_artifacts (id, kind, profile_id, task_id, file_name, stored_name, mime_type, size_bytes, sha256, source_url, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        artifact.id,
        artifact.kind,
        artifact.profileId,
        artifact.taskId ?? null,
        artifact.fileName,
        artifact.storedName,
        artifact.mimeType,
        artifact.sizeBytes,
        artifact.sha256,
        artifact.sourceUrl ?? null,
        artifact.createdAt,
        artifact.createdBy,
      );
    this.audit?.('browser.artifact_registered', {
      actor: artifact.createdBy || undefined,
      detail: { artifactId: id, kind: artifact.kind, profileId: artifact.profileId, sizeBytes: artifact.sizeBytes, sha256: artifact.sha256 },
    });
    return artifact;
  }

  get(id: string): BrowserArtifact | undefined {
    const row = this.db.prepare('SELECT * FROM browser_artifacts WHERE id = ?').get(id) as unknown as ArtifactRow | undefined;
    return row ? rowToArtifact(row) : undefined;
  }

  list(filter: { profileId?: string; kind?: BrowserArtifactKind } = {}): BrowserArtifact[] {
    const rows = (
      filter.profileId
        ? this.db.prepare('SELECT * FROM browser_artifacts WHERE profile_id = ? ORDER BY created_at DESC').all(filter.profileId)
        : this.db.prepare('SELECT * FROM browser_artifacts ORDER BY created_at DESC').all()
    ) as unknown as ArtifactRow[];
    return rows.map(rowToArtifact).filter((a) => !filter.kind || a.kind === filter.kind);
  }

  /** Read the bytes back (authenticated callers only — route or host code). */
  readBytes(id: string): { artifact: BrowserArtifact; bytes: Buffer } {
    const artifact = this.get(id);
    if (!artifact) throw new Error(`unknown browser artifact: ${id}`);
    return { artifact, bytes: fs.readFileSync(path.join(this.artifactDir, artifact.storedName)) };
  }

  /**
   * Mint an FL-7 expiring link for this artifact. All FL-7 rules apply:
   * approval-gated (governance or explicit confirmed flag), ≤48h TTL,
   * token shown once, revocable. The link is confined to the artifact
   * root and points at the opaque stored name.
   */
  mintLink(
    id: string,
    input: { ttlMs?: number; label?: string; createdBy?: string; confirmed?: boolean } = {},
  ): { link: FileLink; token: string; path: string; artifact: BrowserArtifact } {
    const artifact = this.get(id);
    if (!artifact) throw new Error(`unknown browser artifact: ${id}`);
    const created = this.fileLinks.create({
      kind: 'workspace',
      root: this.artifactDir,
      pathOrUploadId: artifact.storedName,
      ttlMs: input.ttlMs,
      label: input.label ?? `${artifact.kind}: ${artifact.fileName}`,
      createdBy: input.createdBy ?? artifact.createdBy,
      confirmed: input.confirmed,
    });
    this.audit?.('browser.artifact_link_minted', {
      actor: input.createdBy ?? artifact.createdBy,
      detail: { artifactId: id, linkId: created.link.id, expiresAt: created.link.expiresAt, status: created.link.status },
    });
    return { ...created, artifact };
  }

  /** Delete bytes + record, and revoke every FL-7 link to this artifact. */
  delete(id: string): { artifact: BrowserArtifact; linksRevoked: number } {
    const artifact = this.get(id);
    if (!artifact) throw new Error(`unknown browser artifact: ${id}`);
    const linksRevoked = this.fileLinks.revokeForRef(artifact.storedName);
    try {
      fs.unlinkSync(path.join(this.artifactDir, artifact.storedName));
    } catch {
      // Bytes already gone — the record + link revocation still proceed.
    }
    this.db.prepare('DELETE FROM browser_artifacts WHERE id = ?').run(id);
    this.audit?.('browser.artifact_deleted', {
      detail: { artifactId: id, profileId: artifact.profileId, linksRevoked },
    });
    return { artifact, linksRevoked };
  }
}

// ---------------------------------------------------------------------------
// Routes — mount under /api/browser (paths are /artifacts…)
// ---------------------------------------------------------------------------

export function registerBrowserArtifactRoutes(router: Router, deps: { store: BrowserArtifactStore }): void {
  const { store } = deps;

  router.get('/artifacts', (req, res) => {
    res.json({
      ok: true,
      artifacts: store.list({
        profileId: typeof req.query.profileId === 'string' ? req.query.profileId : undefined,
        kind: req.query.kind === 'download' || req.query.kind === 'screenshot' ? req.query.kind : undefined,
      }),
    });
  });

  router.get('/artifacts/:id', (req, res) => {
    const artifact = store.get(req.params.id);
    if (!artifact) {
      res.status(404).json({ error: `unknown browser artifact: ${req.params.id}` });
      return;
    }
    res.json({ ok: true, artifact });
  });

  /** Authenticated download of the raw bytes (host auth applies upstream). */
  router.get('/artifacts/:id/download', (req, res) => {
    try {
      const { artifact, bytes } = store.readBytes(req.params.id);
      res.setHeader('Content-Type', artifact.mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(artifact.fileName)}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store');
      res.send(bytes);
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Mint an FL-7 expiring link (approval-gated by FL-7 itself). */
  router.post('/artifacts/:id/link', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const created = store.mintLink(req.params.id, {
        ttlMs: typeof body.ttlMs === 'number' ? body.ttlMs : undefined,
        label: typeof body.label === 'string' ? body.label : undefined,
        createdBy: typeof body.createdBy === 'string' ? body.createdBy : undefined,
        confirmed: body.confirmed === true,
      });
      res.status(created.link.status === 'pending-approval' ? 202 : 201).json({
        ok: true,
        artifact: created.artifact,
        link: created.link,
        token: created.token,
        path: created.path,
        url: created.path,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(/unknown browser artifact/.test(message) ? 404 : 400).json({ error: message });
    }
  });

  router.delete('/artifacts/:id', (req, res) => {
    try {
      res.json({ ok: true, ...store.delete(req.params.id) });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}

export function createBrowserArtifactRouter(deps: { store: BrowserArtifactStore }): Router {
  const router = express.Router();
  registerBrowserArtifactRoutes(router, deps);
  return router;
}
