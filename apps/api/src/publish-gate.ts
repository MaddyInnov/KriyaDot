// SPDX-License-Identifier: Apache-2.0
// FL-6 — Publish approval: first publish AND every subsequent update to a
// public page requires an approval record. Unapproved updates stay draft.
//
// How it works (additive over public-pages.ts, whose legacy un-gated
// publish route stays for back-compat — see the wiring note in the worker
// report):
//   - requestPublish(page) snapshots the page's current title/content/
//     format into a publish request. `kind` is 'first' when the page has
//     no publication yet, 'update' otherwise.
//   - Approval uses the shared lifecycle seam (lifecycle-approval.ts):
//     with a governance gateway, a real approval is minted
//     (tool 'page.publish') and the request stays `pending` until the
//     gateway approves it; without a gateway an explicit
//     `confirmed: true` is required. Denial marks the request `denied`
//     and nothing goes live.
//   - Only an approved request is applied: the publication is created /
//     kept (stable slug via PagePublicationStore) and the approved
//     snapshot is stored in `publish_snapshots`.
//   - Gated serving (registerGatedPublicServing) serves the APPROVED
//     SNAPSHOT for gated pages — later draft edits to the Page do not
//     leak to the public URL until a new update request is approved.
//     Pages published through the legacy route (no snapshot) keep the
//     legacy live-content behaviour.
//
// FL-8 — Atomic artifact delete lives here too:
// AtomicArtifactDeleter.deletePage() removes, in ONE pages.db transaction,
// the page row, its versions, comments, mentions, mini-app collections +
// records (FL-5), publish requests + snapshots, and its publication
// (public share). File links pointing at the page id are revoked first
// (revocation is fail-safe: if the transaction later fails, links stay
// revoked rather than shares staying live). If any step inside the
// transaction throws, everything rolls back — no half-deleted artifact.

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Router } from 'express';
import type { Express, Request, Response } from 'express';
import { openDb as openSqliteDb } from '@mvp/agent-runtime';
import { PageStore, type Page, type PageFormat } from './pages.js';
import {
  PagePublicationStore,
  PUBLIC_PAGE_CSP,
  publicPathForSlug,
  renderPublicDocument,
  type PagePublication,
  type PublicationContentKind,
} from './public-pages.js';
import { PageRecordStore } from './page-records.js';
import type { FileLinkService } from './file-links.js';
import {
  LifecycleAuditLog,
  auditLifecycle,
  beginApproval,
  isApprovalRequiredError,
  syncApprovalStatus,
  type LifecycleGovernance,
} from './lifecycle-approval.js';

export type PublishRequestKind = 'first' | 'update';
export type PublishRequestStatus = 'pending' | 'approved' | 'denied';

export interface PublishRequest {
  id: string;
  pageId: string;
  kind: PublishRequestKind;
  title: string;
  content: string;
  format: PageFormat;
  status: PublishRequestStatus;
  approvalId?: string;
  approvalMode?: 'governance' | 'confirmed-flag';
  requestedBy: string;
  createdAt: number;
  decidedAt?: number;
}

export interface PublishSnapshot {
  pageId: string;
  requestId: string;
  title: string;
  content: string;
  format: PageFormat;
  publishedAt: number;
}

interface PublishRequestRow {
  id: string;
  page_id: string;
  kind: string;
  title: string;
  content: string;
  format: string;
  status: string;
  approval_id: string | null;
  approval_mode: string | null;
  requested_by: string;
  created_at: number;
  decided_at: number | null;
}

interface SnapshotRow {
  page_id: string;
  request_id: string;
  title: string;
  content: string;
  format: string;
  published_at: number;
}

const GATE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS publish_requests (
    id TEXT PRIMARY KEY,
    page_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    format TEXT NOT NULL DEFAULT 'markdown',
    status TEXT NOT NULL,
    approval_id TEXT,
    approval_mode TEXT,
    requested_by TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    decided_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_publish_requests_page ON publish_requests(page_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS publish_snapshots (
    page_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    format TEXT NOT NULL DEFAULT 'markdown',
    published_at INTEGER NOT NULL
  );
`;

function openGateDb(dataDir: string): DatabaseSync {
  const { mkdirSync } = require('node:fs') as typeof import('node:fs');
  const { join } = require('node:path') as typeof import('node:path');
  mkdirSync(dataDir, { recursive: true });
  const db = openSqliteDb(join(dataDir, 'pages.db'));
  db.exec(GATE_SCHEMA);
  return db;
}

function rowToRequest(r: PublishRequestRow): PublishRequest {
  return {
    id: r.id,
    pageId: r.page_id,
    kind: r.kind === 'update' ? 'update' : 'first',
    title: r.title,
    content: r.content,
    format: r.format === 'html' ? 'html' : 'markdown',
    status: r.status as PublishRequestStatus,
    approvalId: r.approval_id ?? undefined,
    approvalMode: (r.approval_mode as PublishRequest['approvalMode']) ?? undefined,
    requestedBy: r.requested_by,
    createdAt: r.created_at,
    decidedAt: r.decided_at ?? undefined,
  };
}

export interface PublishGateOptions {
  governance?: LifecycleGovernance;
  auditLog?: LifecycleAuditLog;
  publicationStore?: PagePublicationStore;
  pageStore?: PageStore;
}

export class PublishGateService {
  protected readonly db: DatabaseSync;
  private readonly governance?: LifecycleGovernance;
  private readonly auditLog: LifecycleAuditLog;
  private readonly publications: PagePublicationStore;
  private readonly pages: PageStore;

  constructor(
    protected readonly dataDir: string,
    opts: PublishGateOptions = {},
  ) {
    this.db = openGateDb(dataDir);
    this.governance = opts.governance;
    this.auditLog = opts.auditLog ?? new LifecycleAuditLog(dataDir);
    this.publications = opts.publicationStore ?? new PagePublicationStore(dataDir);
    this.pages = opts.pageStore ?? new PageStore(dataDir);
  }

  /**
   * Create a publish request for the page's CURRENT content. With a
   * gateway the request is pending until approved; with the confirmed
   * flag it is approved + applied immediately.
   */
  requestPublish(pageId: string, opts: { requestedBy?: string; confirmed?: boolean } = {}): PublishRequest {
    const page = this.pages.get(pageId);
    if (!page) throw new Error(`unknown page: ${pageId}`);
    const kind: PublishRequestKind = this.publications.getForPage(pageId) ? 'update' : 'first';
    const requestedBy = (opts.requestedBy ?? '').slice(0, 100);
    const approval = beginApproval({
      governance: this.governance,
      toolName: 'page.publish',
      args: { pageId, title: page.title, kind, version: page.version },
      actor: requestedBy || 'api',
      confirmed: opts.confirmed,
    });
    const now = Date.now();
    const request: PublishRequest = {
      id: randomUUID(),
      pageId,
      kind,
      title: page.title,
      content: page.content,
      format: page.format,
      status: approval.status === 'active' ? 'approved' : 'pending',
      approvalId: approval.approvalId,
      approvalMode: approval.mode,
      requestedBy,
      createdAt: now,
      decidedAt: approval.status === 'active' ? now : undefined,
    };
    this.db
      .prepare(
        `INSERT INTO publish_requests (id, page_id, kind, title, content, format, status, approval_id, approval_mode, requested_by, created_at, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        request.id,
        request.pageId,
        request.kind,
        request.title,
        request.content,
        request.format,
        request.status,
        request.approvalId ?? null,
        request.approvalMode ?? null,
        request.requestedBy,
        request.createdAt,
        request.decidedAt ?? null,
      );
    auditLifecycle(this.governance, this.auditLog, 'page.publish_requested', requestedBy || 'api', {
      requestId: request.id,
      pageId,
      kind,
      status: request.status,
      approvalMode: request.approvalMode,
      approvalId: request.approvalId,
    });
    if (request.status === 'approved') this.applyApproved(request);
    return request;
  }

  getRequest(id: string): PublishRequest | undefined {
    const row = this.db.prepare('SELECT * FROM publish_requests WHERE id = ?').get(id) as unknown as
      | PublishRequestRow
      | undefined;
    return row ? rowToRequest(row) : undefined;
  }

  listRequests(pageId: string): PublishRequest[] {
    const rows = this.db
      .prepare('SELECT * FROM publish_requests WHERE page_id = ? ORDER BY created_at DESC')
      .all(pageId) as unknown as PublishRequestRow[];
    return rows.map(rowToRequest);
  }

  /**
   * Re-check a pending request against the gateway. On approval the
   * request is applied (publication + snapshot); on denial it is marked
   * denied and nothing goes live. Returns the fresh request.
   */
  syncRequest(id: string): PublishRequest {
    const request = this.getRequest(id);
    if (!request) throw new Error(`unknown publish request: ${id}`);
    if (request.status !== 'pending') return request;
    const mapped = syncApprovalStatus(this.governance, request.approvalId, 'pending');
    if (mapped === 'pending') return request;
    const status: PublishRequestStatus = mapped === 'active' ? 'approved' : 'denied';
    const now = Date.now();
    this.db.prepare('UPDATE publish_requests SET status = ?, decided_at = ? WHERE id = ?').run(status, now, id);
    const updated: PublishRequest = { ...request, status, decidedAt: now };
    auditLifecycle(this.governance, this.auditLog, 'page.publish_decided', request.requestedBy || 'api', {
      requestId: id,
      pageId: request.pageId,
      status,
      approvalId: request.approvalId,
    });
    if (status === 'approved') this.applyApproved(updated);
    return updated;
  }

  /** Apply an approved request: publish (stable slug) + store the approved snapshot. */
  applyApproved(request: PublishRequest): PagePublication {
    const pub = this.publications.publishPage({ id: request.pageId, title: request.title });
    this.db
      .prepare(
        `INSERT INTO publish_snapshots (page_id, request_id, title, content, format, published_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(page_id) DO UPDATE SET request_id = excluded.request_id, title = excluded.title, content = excluded.content, format = excluded.format, published_at = excluded.published_at`,
      )
      .run(request.pageId, request.id, request.title, request.content, request.format, Date.now());
    return pub;
  }

  getSnapshot(pageId: string): PublishSnapshot | undefined {
    const row = this.db.prepare('SELECT * FROM publish_snapshots WHERE page_id = ?').get(pageId) as unknown as
      | SnapshotRow
      | undefined;
    if (!row) return undefined;
    return {
      pageId: row.page_id,
      requestId: row.request_id,
      title: row.title,
      content: row.content,
      format: row.format === 'html' ? 'html' : 'markdown',
      publishedAt: row.published_at,
    };
  }

  /**
   * Content a gated public route should serve for a publication: the
   * approved snapshot when one exists (draft edits stay private),
   * otherwise the live page (legacy-published pages).
   */
  contentForPublication(
    pub: PagePublication,
    livePage: Page | undefined,
  ): { title: string; content: string; contentKind: PublicationContentKind } | undefined {
    if (pub.pageId) {
      const snapshot = this.getSnapshot(pub.pageId);
      if (snapshot) {
        return {
          title: snapshot.title,
          content: snapshot.content,
          contentKind: snapshot.format === 'html' ? 'html' : 'markdown',
        };
      }
      if (!livePage) return undefined;
      return {
        title: livePage.title,
        content: livePage.content,
        contentKind: livePage.format === 'html' ? 'html' : 'markdown',
      };
    }
    return { title: pub.title, content: pub.content ?? '', contentKind: pub.contentKind };
  }
}

// ---------------------------------------------------------------------------
// FL-8 — Atomic artifact delete
// ---------------------------------------------------------------------------

export interface AtomicDeleteResult {
  pageId: string;
  unpublished: boolean;
  collectionsRemoved: number;
  recordsRemoved: number;
  linksRevoked: number;
  publishRequestsRemoved: number;
}

export interface AtomicDeleterDeps {
  dataDir: string;
  pageStore?: PageStore;
  publicationStore?: PagePublicationStore;
  recordStore?: PageRecordStore;
  gateService?: PublishGateService;
  fileLinkService?: FileLinkService;
  governance?: LifecycleGovernance;
}

export class AtomicArtifactDeleter {
  protected readonly db: DatabaseSync;
  private readonly auditLog: LifecycleAuditLog;
  private readonly governance?: LifecycleGovernance;
  private readonly fileLinks?: FileLinkService;

  constructor(protected readonly deps: AtomicDeleterDeps) {
    this.db = openGateDb(deps.dataDir);
    // Ensure the records + publications tables exist on this connection too.
    new PageRecordStore(deps.dataDir);
    new PagePublicationStore(deps.dataDir);
    new PageStore(deps.dataDir);
    this.auditLog = new LifecycleAuditLog(deps.dataDir);
    this.governance = deps.governance;
    this.fileLinks = deps.fileLinkService;
  }

  /**
   * Delete a page artifact atomically: publication (public share),
   * publish requests + snapshot, mini-app collections + records, comments,
   * mentions, versions, and the page row — in one transaction. File links
   * referencing the page id are revoked first (fail-safe direction).
   * Throws (and changes nothing in pages.db) when the page is unknown.
   */
  deletePage(pageId: string): AtomicDeleteResult {
    const pageRow = this.db.prepare('SELECT id FROM pages WHERE id = ?').get(pageId);
    if (!pageRow) throw new Error(`unknown page: ${pageId}`);

    // 1) Revoke public file links for this artifact first: if anything
    //    below fails, shares are dead rather than content half-deleted.
    let linksRevoked = 0;
    if (this.fileLinks) linksRevoked = this.fileLinks.revokeForRef(pageId);

    // 2) One transaction over every pages.db table the artifact owns.
    let result: AtomicDeleteResult;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const pub = this.db.prepare('DELETE FROM page_publications WHERE page_id = ?').run(pageId);
      const records = this.db.prepare('DELETE FROM page_records WHERE page_id = ?').run(pageId);
      const collections = this.db.prepare('DELETE FROM page_collections WHERE page_id = ?').run(pageId);
      const requests = this.db.prepare('DELETE FROM publish_requests WHERE page_id = ?').run(pageId);
      this.db.prepare('DELETE FROM publish_snapshots WHERE page_id = ?').run(pageId);
      this.db.prepare('DELETE FROM page_comments WHERE page_id = ?').run(pageId);
      this.db.prepare('DELETE FROM page_mentions WHERE page_id = ?').run(pageId);
      this.db.prepare('DELETE FROM page_versions WHERE page_id = ?').run(pageId);
      this.db.prepare('DELETE FROM pages WHERE id = ?').run(pageId);
      this.db.exec('COMMIT');
      result = {
        pageId,
        unpublished: Number(pub.changes) > 0,
        collectionsRemoved: Number(collections.changes),
        recordsRemoved: Number(records.changes),
        linksRevoked,
        publishRequestsRemoved: Number(requests.changes),
      };
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    }
    auditLifecycle(this.governance, this.auditLog, 'artifact.deleted', 'api', { ...result });
    return result;
  }

  /** Delete a standalone artifact publication + revoke links minted for its slug. */
  deleteArtifactPublication(slug: string): { slug: string; linksRevoked: number } {
    let linksRevoked = 0;
    if (this.fileLinks) linksRevoked = this.fileLinks.revokeForRef(slug);
    const removed = this.db.prepare('DELETE FROM page_publications WHERE slug = ?').run(slug);
    if (removed.changes === 0) throw new Error(`unknown publication: ${slug}`);
    auditLifecycle(this.governance, this.auditLog, 'artifact.publication_deleted', 'api', { slug, linksRevoked });
    return { slug, linksRevoked };
  }
}

// ---------------------------------------------------------------------------
// Routes — publish-gate management on the pages router + gated serving
// ---------------------------------------------------------------------------

export interface PublishGateDeps {
  dataDir: string;
  gateService?: PublishGateService;
  deleter?: AtomicArtifactDeleter;
  pageStore?: PageStore;
  publicationStore?: PagePublicationStore;
  governance?: LifecycleGovernance;
  fileLinkService?: FileLinkService;
}

export function registerPublishGateRoutes(router: Router, deps: PublishGateDeps): void {
  const gate =
    deps.gateService ??
    new PublishGateService(deps.dataDir, {
      governance: deps.governance,
      publicationStore: deps.publicationStore,
      pageStore: deps.pageStore,
    });
  const deleter =
    deps.deleter ??
    new AtomicArtifactDeleter({
      dataDir: deps.dataDir,
      governance: deps.governance,
      fileLinkService: deps.fileLinkService,
    });

  router.post('/:id/publish-requests', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { requestedBy?: unknown; confirmed?: unknown };
      const request = gate.requestPublish(req.params.id, {
        requestedBy: typeof body.requestedBy === 'string' ? body.requestedBy : undefined,
        confirmed: body.confirmed === true,
      });
      res.status(request.status === 'pending' ? 202 : 201).json(request);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'failed to request publish';
      const status = isApprovalRequiredError(err) ? 403 : /unknown page/.test(message) ? 404 : 400;
      res.status(status).json({ error: message });
    }
  });

  router.get('/:id/publish-requests', (req: Request, res: Response) => {
    res.json(gate.listRequests(req.params.id).map((r) => (r.status === 'pending' ? gate.syncRequest(r.id) : r)));
  });

  router.post('/:id/publish-requests/:requestId/sync', (req: Request, res: Response) => {
    try {
      const request = gate.syncRequest(req.params.requestId);
      if (request.pageId !== req.params.id) {
        res.status(404).json({ error: `unknown publish request: ${req.params.requestId}` });
        return;
      }
      res.json(request);
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : 'unknown publish request' });
    }
  });

  router.get('/:id/published-snapshot', (req: Request, res: Response) => {
    const snapshot = gate.getSnapshot(req.params.id);
    if (!snapshot) {
      res.status(404).json({ error: 'no approved snapshot for this page' });
      return;
    }
    res.json(snapshot);
  });

  // FL-8: atomic delete (content + mini-app data + public share + links).
  router.delete('/:id/atomic', (req: Request, res: Response) => {
    try {
      const result = deleter.deletePage(req.params.id);
      res.json({ ok: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'failed to delete artifact';
      res.status(/unknown page/.test(message) ? 404 : 500).json({ error: message });
    }
  });
}

/**
 * Gated public serving — a snapshot-aware replacement for
 * registerPublicPageServing. Mount INSTEAD of it (same /p/:slug path)
 * when the publish gate is enabled. Legacy publications without a
 * snapshot serve live content, exactly like the un-gated route.
 */
export function registerGatedPublicServing(app: Express, deps: PublishGateDeps): void {
  const gate =
    deps.gateService ??
    new PublishGateService(deps.dataDir, {
      governance: deps.governance,
      publicationStore: deps.publicationStore,
      pageStore: deps.pageStore,
    });
  const publications = deps.publicationStore ?? new PagePublicationStore(deps.dataDir);
  const pages = deps.pageStore ?? new PageStore(deps.dataDir);

  app.get('/p/:slug', (req: Request, res: Response) => {
    const pub = publications.getBySlug(req.params.slug);
    if (!pub) {
      res.status(404).type('text').send('Not found');
      return;
    }
    const livePage = pub.pageId ? pages.get(pub.pageId) : undefined;
    if (pub.pageId && !livePage && !gate.getSnapshot(pub.pageId)) {
      res.status(404).type('text').send('Not found');
      return;
    }
    const resolved = gate.contentForPublication(pub, livePage);
    if (!resolved) {
      res.status(404).type('text').send('Not found');
      return;
    }
    try {
      publications.incrementViews(pub.slug);
    } catch {
      /* best effort */
    }
    res
      .status(200)
      .set({
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': PUBLIC_PAGE_CSP,
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'no-cache',
      })
      .send(renderPublicDocument(resolved));
  });
}

export { publicPathForSlug };
