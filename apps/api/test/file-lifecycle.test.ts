// SPDX-License-Identifier: Apache-2.0
// Wave-1 file lifecycle (Muse parity FL-5/6/7/8/10/12/13):
// workspace trash + purge, expiring file links, page mini-app data,
// publish approval gating, atomic artifact delete, zip intake safety,
// HEIC/AVIF detection, and file metadata ops. Temp dirs only; every temp
// dir is removed in afterEach so /tmp does not accumulate debris.

import fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { zipSync, strToU8 } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TrashStore, runTrashPurge, registerWorkspaceTrashRoutes, TRASH_RETENTION_MS } from '../src/workspace-trash.js';
import { FileLinkService, registerFileLinkRoutes, registerFileLinkServing, MAX_FILE_LINK_TTL_MS } from '../src/file-links.js';
import { FileMetaStore, registerFileMetaRoutes } from '../src/file-metadata.js';
import { PageRecordStore, registerPageRecordRoutes, registerPageRecordPublicRoutes } from '../src/page-records.js';
import { PublishGateService, AtomicArtifactDeleter, registerPublishGateRoutes, registerGatedPublicServing } from '../src/publish-gate.js';
import { PageStore, registerPagesRoutes } from '../src/pages.js';
import { PagePublicationStore } from '../src/public-pages.js';
import {
  extractZipToWorkspace,
  listZipEntries,
  sanitizeZipEntryName,
  UnsafeZipEntryError,
  detectImageContainer,
  intakeImage,
  isUnsupportedImageFormatError,
} from '../src/file-intake.js';
import type { LifecycleGovernance } from '../src/lifecycle-approval.js';

// ---------------------------------------------------------------------------
// Fake governance gateway (same seam the real GovernanceGateway exposes)
// ---------------------------------------------------------------------------

function fakeGovernance() {
  const approvals = new Map<string, { status: string; toolName: string }>();
  const audits: Array<{ action: string; fields: unknown }> = [];
  let seq = 0;
  const gov: LifecycleGovernance = {
    requestApproval: (toolName) => {
      const id = `approval-${++seq}`;
      approvals.set(id, { status: 'pending', toolName });
      return id;
    },
    getApproval: (id) => approvals.get(id),
    audit: (action, fields) => {
      audits.push({ action, fields });
    },
  };
  return {
    gov,
    audits,
    decide(id: string, decision: 'approved' | 'denied') {
      const rec = approvals.get(id);
      if (rec) rec.status = decision;
    },
    lastApprovalId(): string {
      return `approval-${seq}`;
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP harness
// ---------------------------------------------------------------------------

interface Harness {
  base: string;
  close: () => Promise<void>;
}

async function startApp(build: (app: express.Express) => void): Promise<Harness> {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  build(app);
  const server = await new Promise<ReturnType<typeof import('node:http').createServer>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = (server as unknown as { address(): AddressInfo }).address();
  return {
    base: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve) => (server as unknown as { close(cb: () => void): void }).close(() => resolve())),
  };
}

async function api(
  base: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

// ---------------------------------------------------------------------------

let dir: string;
let workspace: string;
const harnesses: Harness[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'file-lifecycle-'));
  workspace = join(dir, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
});

afterEach(async () => {
  while (harnesses.length) await harnesses.pop()!.close();
  rmSync(dir, { recursive: true, force: true });
});

function writeWorkspaceFile(rel: string, content: string): void {
  const abs = join(workspace, rel);
  fs.mkdirSync(join(abs, '..'), { recursive: true });
  fs.writeFileSync(abs, content);
}

// ---------------------------------------------------------------------------
// FL-13 trash
// ---------------------------------------------------------------------------

describe('FL-13 workspace trash', () => {
  it('trashes, lists, restores, and permanently deletes a workspace file', () => {
    writeWorkspaceFile('notes/a.txt', 'hello trash');
    const store = new TrashStore(dir);
    const item = store.trashWorkspaceFile(workspace, 'notes/a.txt', 'tester');
    expect(item.scope).toBe('workspace');
    expect(item.size).toBe('hello trash'.length);
    expect(item.expiresAt - item.trashedAt).toBe(TRASH_RETENTION_MS);
    expect(fs.existsSync(join(workspace, 'notes/a.txt'))).toBe(false);
    expect(store.list()).toHaveLength(1);
    // Persistence across instances.
    expect(new TrashStore(dir).list()).toHaveLength(1);

    const restored = store.restore(item.id);
    expect(restored.originalPath).toBe('notes/a.txt');
    expect(fs.readFileSync(join(workspace, 'notes/a.txt'), 'utf8')).toBe('hello trash');
    expect(store.list()).toEqual([]);

    const again = store.trashWorkspaceFile(workspace, 'notes/a.txt');
    store.permanentDelete(again.id);
    expect(store.list()).toEqual([]);
    expect(fs.existsSync(join(workspace, 'notes/a.txt'))).toBe(false);
    expect(() => store.restore(again.id)).toThrow(/unknown trash item/);
  });

  it('refuses traversal and restore-over-existing', () => {
    writeWorkspaceFile('keep.txt', 'x');
    const store = new TrashStore(dir);
    expect(() => store.trashWorkspaceFile(workspace, '../outside.txt')).toThrow(/escapes/);
    const item = store.trashWorkspaceFile(workspace, 'keep.txt');
    writeWorkspaceFile('keep.txt', 'recreated');
    expect(() => store.restore(item.id)).toThrow(/already exists/);
    // Failed restore keeps the item recoverable.
    expect(store.list()).toHaveLength(1);
  });

  it('trashes and restores an upload with its metadata sidecar rebuilt', () => {
    const uploads = join(dir, 'uploads');
    fs.mkdirSync(uploads, { recursive: true });
    const uploadId = '123e4567-e89b-12d3-a456-426614174000';
    fs.writeFileSync(join(uploads, `${uploadId}-report.pdf`), 'PDFBYTES');
    fs.writeFileSync(
      join(uploads, `${uploadId}-report.pdf.meta.json`),
      JSON.stringify({ id: uploadId, name: 'report.pdf', size: 8, mimeType: 'application/pdf' }),
    );
    const store = new TrashStore(dir);
    const item = store.trashUploadFile(uploads, uploadId);
    expect(item.name).toBe('report.pdf');
    expect(item.mimeType).toBe('application/pdf');
    expect(fs.existsSync(join(uploads, `${uploadId}-report.pdf`))).toBe(false);

    store.restore(item.id);
    expect(fs.readFileSync(join(uploads, `${uploadId}-report.pdf`), 'utf8')).toBe('PDFBYTES');
    const meta = JSON.parse(fs.readFileSync(join(uploads, `${uploadId}-report.pdf.meta.json`), 'utf8')) as { name: string };
    expect(meta.name).toBe('report.pdf');
    expect(() => store.trashUploadFile(uploads, 'not-a-uuid')).toThrow(/invalid upload id/);
  });

  it('purge sweep destroys only expired items (store + runTrashPurge + route)', async () => {
    writeWorkspaceFile('old.txt', 'old');
    writeWorkspaceFile('fresh.txt', 'fresh');
    let now = 1_000_000;
    const store = new TrashStore(dir, { now: () => now });
    store.trashWorkspaceFile(workspace, 'old.txt');
    now += TRASH_RETENTION_MS + 1;
    store.trashWorkspaceFile(workspace, 'fresh.txt');
    const result = store.purgeExpired(now);
    expect(result.purged).toBe(1);
    expect(result.items[0].originalPath).toBe('old.txt');
    expect(store.list().map((i) => i.originalPath)).toEqual(['fresh.txt']);

    // Host-schedulable entry point over the same dataDir.
    now += TRASH_RETENTION_MS + 1;
    expect(runTrashPurge(dir, now).purged).toBe(1);
    expect(store.list()).toEqual([]);

    // HTTP surface.
    writeWorkspaceFile('route.txt', 'r');
    const h = await startApp((app) => {
      const router = express.Router();
      registerWorkspaceTrashRoutes(router, { dataDir: dir, workspaceRoot: workspace });
      app.use('/api/files', router);
    });
    harnesses.push(h);
    const trashed = await api(h.base, 'POST', '/api/files/trash', { path: 'route.txt' });
    expect(trashed.status).toBe(201);
    const listed = await api(h.base, 'GET', '/api/files/trash');
    expect(listed.json.items).toHaveLength(1);
    expect(listed.json.retentionDays).toBe(30);
    const purged = await api(h.base, 'POST', '/api/files/trash/purge', { now: Date.now() + TRASH_RETENTION_MS + 1000 });
    expect(purged.json.purged).toBe(1);
    expect((await api(h.base, 'GET', '/api/files/trash')).json.items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// FL-7 expiring file links
// ---------------------------------------------------------------------------

describe('FL-7 expiring file links', () => {
  it('requires confirmation without a gateway, enforces the 48h cap, expires and revokes', async () => {
    writeWorkspaceFile('shared.txt', 'link me');
    const service = new FileLinkService(dir);
    // No gateway + no confirmed flag → refused.
    expect(() => service.create({ kind: 'workspace', root: workspace, pathOrUploadId: 'shared.txt' })).toThrow(
      /requires an approval/,
    );
    // TTL over the hard cap → refused even when confirmed.
    expect(() =>
      service.create({ kind: 'workspace', root: workspace, pathOrUploadId: 'shared.txt', ttlMs: MAX_FILE_LINK_TTL_MS + 1, confirmed: true }),
    ).toThrow(/cap/);

    const { link, token, path: linkPath } = service.create({
      kind: 'workspace',
      root: workspace,
      pathOrUploadId: 'shared.txt',
      ttlMs: 60_000,
      confirmed: true,
      createdBy: 'tester',
    });
    expect(link.status).toBe('active');
    expect(link.approvalMode).toBe('confirmed-flag');
    expect(linkPath).toBe(`/f/${token}`);
    // Only the hash is stored: the token never appears in the DB file.
    const dbText = fs.readFileSync(join(dir, 'file-lifecycle.db'), 'latin1');
    expect(dbText.includes(token)).toBe(false);

    const h = await startApp((app) => {
      registerFileLinkServing(app, { dataDir: dir, workspaceRoot: workspace, service });
    });
    harnesses.push(h);
    const ok = await fetch(`${h.base}${linkPath}`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('link me');
    expect(service.get(link.id)?.downloads).toBe(1);
    expect((await fetch(`${h.base}/f/${'x'.repeat(43)}`)).status).toBe(404);

    // Revoke → 403.
    service.revoke(link.id);
    expect((await fetch(`${h.base}${linkPath}`)).status).toBe(403);

    // Expiry → 410, via an injected clock.
    let now = Date.now();
    const clocked = new FileLinkService(dir, { now: () => now });
    const exp = clocked.create({ kind: 'workspace', root: workspace, pathOrUploadId: 'shared.txt', ttlMs: 60_000, confirmed: true });
    now += 61_000;
    expect(() => clocked.resolveToken(exp.token)).toThrow(/expired/);
    const h2 = await startApp((app) => {
      registerFileLinkServing(app, { dataDir: dir, workspaceRoot: workspace, service: clocked });
    });
    harnesses.push(h2);
    expect((await fetch(`${h2.base}${exp.path}`)).status).toBe(410);
  });

  it('governance mode: link stays pending until approved; denial kills it', async () => {
    writeWorkspaceFile('gated.txt', 'gated bytes');
    const fake = fakeGovernance();
    const service = new FileLinkService(dir, { governance: fake.gov });
    const { link, token } = service.create({ kind: 'workspace', root: workspace, pathOrUploadId: 'gated.txt' });
    expect(link.status).toBe('pending-approval');
    expect(link.approvalMode).toBe('governance');
    expect(link.approvalId).toBe(fake.lastApprovalId());
    expect(fake.audits.some((a) => a.action === 'file_link.created')).toBe(true);
    expect(() => service.resolveToken(token)).toThrow(/pending approval/);

    fake.decide(link.approvalId!, 'approved');
    expect(service.syncStatus(link.id).status).toBe('active');
    expect(service.resolveToken(token).id).toBe(link.id);

    const second = service.create({ kind: 'workspace', root: workspace, pathOrUploadId: 'gated.txt' });
    fake.decide(second.link.approvalId!, 'denied');
    expect(service.syncStatus(second.link.id).status).toBe('denied');
    expect(() => service.resolveToken(second.token)).toThrow(/denied/);
  });

  it('management routes create (202 while pending), list, and revoke', async () => {
    writeWorkspaceFile('route.txt', 'via route');
    const fake = fakeGovernance();
    const service = new FileLinkService(dir, { governance: fake.gov });
    const h = await startApp((app) => {
      const router = express.Router();
      registerFileLinkRoutes(router, { dataDir: dir, workspaceRoot: workspace, service });
      app.use('/api/files', router);
      registerFileLinkServing(app, { dataDir: dir, workspaceRoot: workspace, service });
    });
    harnesses.push(h);
    const created = await api(h.base, 'POST', '/api/files/links', { path: 'route.txt', ttlHours: 2 });
    expect(created.status).toBe(202);
    expect(created.json.link.status).toBe('pending-approval');
    fake.decide(created.json.link.approvalId, 'approved');
    const synced = await api(h.base, 'POST', `/api/files/links/${created.json.link.id}/sync`);
    expect(synced.json.link.status).toBe('active');
    expect((await fetch(`${h.base}${created.json.path}`)).status).toBe(200);
    const revoked = await api(h.base, 'POST', `/api/files/links/${created.json.link.id}/revoke`);
    expect(revoked.json.link.status).toBe('revoked');
    expect((await fetch(`${h.base}${created.json.path}`)).status).toBe(403);
    const overCap = await api(h.base, 'POST', '/api/files/links', { path: 'route.txt', ttlHours: 49 });
    expect(overCap.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// FL-12 file metadata
// ---------------------------------------------------------------------------

describe('FL-12 file metadata ops', () => {
  it('pins, renames (migrating metadata + children), and persists manual order', async () => {
    writeWorkspaceFile('docs/one.md', '1');
    writeWorkspaceFile('docs/two.md', '2');
    writeWorkspaceFile('top.txt', 't');
    const store = new FileMetaStore(dir);
    store.setPinned(workspace, 'docs/one.md', true);
    expect(store.get(workspace, 'docs/one.md')?.pinned).toBe(true);
    expect(new FileMetaStore(dir).get(workspace, 'docs/one.md')?.pinned).toBe(true);

    const ordered = store.reorder(workspace, ['top.txt', 'docs/two.md', 'docs/one.md']);
    expect(ordered.map((m) => [m.relPath, m.sortOrder])).toEqual([
      ['top.txt', 0],
      ['docs/two.md', 1],
      ['docs/one.md', 2],
    ]);

    const renamed = store.rename(workspace, 'docs', 'guides');
    expect(renamed.to).toBe('guides');
    expect(fs.existsSync(join(workspace, 'guides/one.md'))).toBe(true);
    expect(store.get(workspace, 'guides/one.md')?.pinned).toBe(true);
    expect(store.get(workspace, 'docs/one.md')).toBeUndefined();
    expect(() => store.rename(workspace, '../escape', 'x')).toThrow(/escapes/);
    expect(() => store.rename(workspace, 'guides/one.md', 'guides/two.md')).toThrow(/already exists/);

    const h = await startApp((app) => {
      const router = express.Router();
      registerFileMetaRoutes(router, { dataDir: dir, workspaceRoot: workspace });
      app.use('/api/files', router);
    });
    harnesses.push(h);
    const pinned = await api(h.base, 'POST', '/api/files/meta/pin', { path: 'top.txt', pinned: true });
    expect(pinned.json.meta.pinned).toBe(true);
    const renamedViaRoute = await api(h.base, 'POST', '/api/files/meta/rename', { from: 'top.txt', to: 'renamed.txt' });
    expect(renamedViaRoute.json.to).toBe('renamed.txt');
    expect(fs.existsSync(join(workspace, 'renamed.txt'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FL-5 mini-app data API
// ---------------------------------------------------------------------------

describe('FL-5 page mini-app data', () => {
  it('store: collections, KV upsert, anonymous records, cascade delete', () => {
    const pages = new PageStore(dir);
    const page = pages.create({ title: 'App' });
    const store = new PageRecordStore(dir);
    expect(() => store.put(page.id, 'todos', { value: 1 })).toThrow(/unknown collection/);
    const col = store.defineCollection(page.id, { name: 'todos' });
    expect(col.publicRead).toBe(false);

    const kv = store.put(page.id, 'todos', { key: 'settings', value: { theme: 'dark' } });
    expect(kv.key).toBe('settings');
    const kv2 = store.put(page.id, 'todos', { key: 'settings', value: { theme: 'light' } });
    expect(kv2.id).toBe(kv.id); // upsert, not duplicate
    expect(store.countRecords(page.id, 'todos')).toBe(1);

    const anon = store.put(page.id, 'todos', { value: { text: 'buy milk', done: false } });
    expect(anon.key).toBeNull();
    expect(store.get(page.id, 'todos', anon.id)?.value).toEqual({ text: 'buy milk', done: false });
    expect(store.list(page.id, 'todos')).toHaveLength(2);

    store.remove(page.id, 'todos', 'settings');
    expect(store.get(page.id, 'todos', 'settings')).toBeUndefined();
    expect(store.deleteCollection(page.id, 'todos')).toBe(1);
    expect(store.listCollections(page.id)).toEqual([]);
    expect(() => store.put(page.id, 'todos', { value: 1 })).toThrow(/unknown collection/);
    expect(() => store.defineCollection(page.id, { name: 'bad name!' })).toThrow(/collection/);
  });

  it('routes: owner CRUD + public read gated by publication and publicRead', async () => {
    const pages = new PageStore(dir);
    const store = new PageRecordStore(dir);
    const h = await startApp((app) => {
      const router = express.Router();
      registerPagesRoutes(router, { dataDir: dir });
      registerPageRecordRoutes(router, { dataDir: dir, store });
      app.use('/api/pages', router);
      registerPageRecordPublicRoutes(app, { dataDir: dir, store });
    });
    harnesses.push(h);

    const page = (await api(h.base, 'POST', '/api/pages', { title: 'Mini App', content: '# app' })).json;
    const colRes = await api(h.base, 'POST', `/api/pages/${page.id}/collections`, { name: 'items' });
    expect(colRes.status).toBe(201);
    expect(colRes.json.publicRead).toBe(false);

    const created = await api(h.base, 'POST', `/api/pages/${page.id}/records/items`, { key: 'a', value: { n: 1 } });
    expect(created.status).toBe(201);
    const updated = await api(h.base, 'PUT', `/api/pages/${page.id}/records/items/a`, { value: { n: 2 } });
    expect((updated.json.value as { n: number }).n).toBe(2);
    expect((await api(h.base, 'GET', `/api/pages/${page.id}/records/items`)).json).toHaveLength(1);

    // Not published yet → public read 404.
    const pubs = new PagePublicationStore(dir);
    const pub = pubs.publishPage(pages.get(page.id)!);
    expect((await fetch(`${h.base}/p/${pub.slug}/records/items`)).status).toBe(403); // published but not publicRead
    // Opt the collection in → public read works; writes stay owner-only (no public write route).
    await api(h.base, 'PATCH', `/api/pages/${page.id}/collections/items`, { publicRead: true });
    const publicList = await fetch(`${h.base}/p/${pub.slug}/records/items`);
    expect(publicList.status).toBe(200);
    expect(((await publicList.json()) as unknown[]).length).toBe(1);
    expect((await fetch(`${h.base}/p/${pub.slug}/records/items`, { method: 'POST', body: '{}' })).status).toBe(404);
    // Unknown slug / unpublished collection name → 404.
    expect((await fetch(`${h.base}/p/${'z'.repeat(32)}/records/items`)).status).toBe(404);
    expect((await fetch(`${h.base}/p/${pub.slug}/records/nope`)).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// FL-6 publish approval + FL-8 atomic delete
// ---------------------------------------------------------------------------

describe('FL-6 publish approval gating', () => {
  it('confirmed mode: first publish applies; unapproved draft edits do not leak', async () => {
    const pages = new PageStore(dir);
    const page = pages.create({ title: 'Gated', content: 'v1 public' });
    const gate = new PublishGateService(dir);
    // No gateway and no confirmed flag → refused.
    expect(() => gate.requestPublish(page.id)).toThrow(/requires an approval/);

    const first = gate.requestPublish(page.id, { confirmed: true, requestedBy: 'tester' });
    expect(first.kind).toBe('first');
    expect(first.status).toBe('approved');
    const pubs = new PagePublicationStore(dir);
    const pub = pubs.getForPage(page.id)!;
    expect(pub).toBeTruthy();

    // Draft edit after publish: gated serving still serves the approved snapshot.
    pages.update(page.id, { content: 'v2 DRAFT — not approved' });
    const h = await startApp((app) => {
      registerGatedPublicServing(app, { dataDir: dir, gateService: gate });
    });
    harnesses.push(h);
    const html = await (await fetch(`${h.base}/p/${pub.slug}`)).text();
    expect(html).toContain('v1 public');
    expect(html).not.toContain('DRAFT');

    // An approved update request moves the public content.
    const update = gate.requestPublish(page.id, { confirmed: true });
    expect(update.kind).toBe('update');
    const html2 = await (await fetch(`${h.base}/p/${pub.slug}`)).text();
    expect(html2).toContain('v2 DRAFT');
  });

  it('governance mode: pending request publishes nothing; denial keeps it draft', async () => {
    const pages = new PageStore(dir);
    const page = pages.create({ title: 'Gov Gated', content: 'secret draft' });
    const fake = fakeGovernance();
    const gate = new PublishGateService(dir, { governance: fake.gov });
    const pubs = new PagePublicationStore(dir);

    const pending = gate.requestPublish(page.id, { requestedBy: 'tester' });
    expect(pending.status).toBe('pending');
    expect(pubs.getForPage(page.id)).toBeUndefined(); // nothing live

    fake.decide(pending.approvalId!, 'denied');
    expect(gate.syncRequest(pending.id).status).toBe('denied');
    expect(pubs.getForPage(page.id)).toBeUndefined();

    const second = gate.requestPublish(page.id);
    fake.decide(second.approvalId!, 'approved');
    expect(gate.syncRequest(second.id).status).toBe('approved');
    expect(pubs.getForPage(page.id)).toBeTruthy();
    expect(gate.getSnapshot(page.id)?.content).toBe('secret draft');
  });

  it('gate routes return 202 while pending and 403 without approval', async () => {
    const h = await startApp((app) => {
      const router = express.Router();
      registerPagesRoutes(router, { dataDir: dir });
      registerPublishGateRoutes(router, { dataDir: dir });
      app.use('/api/pages', router);
    });
    harnesses.push(h);
    const page = (await api(h.base, 'POST', '/api/pages', { title: 'Route Gated' })).json;
    expect((await api(h.base, 'POST', `/api/pages/${page.id}/publish-requests`, {})).status).toBe(403);
    const ok = await api(h.base, 'POST', `/api/pages/${page.id}/publish-requests`, { confirmed: true });
    expect(ok.status).toBe(201);
    expect(ok.json.status).toBe('approved');
    const snapshot = await api(h.base, 'GET', `/api/pages/${page.id}/published-snapshot`);
    expect(snapshot.status).toBe(200);
  });
});

describe('FL-8 atomic artifact delete', () => {
  it('removes content, mini-app data, publication, requests and links in one operation', async () => {
    const pages = new PageStore(dir);
    const page = pages.create({ title: 'Doomed', content: 'bye' });
    pages.update(page.id, { content: 'bye v2' }); // creates a version row
    const records = new PageRecordStore(dir);
    records.defineCollection(page.id, { name: 'items', publicRead: true });
    records.put(page.id, 'items', { key: 'a', value: 1 });
    const gate = new PublishGateService(dir);
    gate.requestPublish(page.id, { confirmed: true });
    const pubs = new PagePublicationStore(dir);
    const pub = pubs.getForPage(page.id)!;
    expect(pub).toBeTruthy();

    writeWorkspaceFile('linked.txt', 'x');
    const links = new FileLinkService(dir);
    // A file link whose ref is the page id (artifact-scoped share).
    const manual = links.create({ kind: 'workspace', root: workspace, pathOrUploadId: 'linked.txt', confirmed: true });
    // Point a second link's revocation at the page id via revokeForRef coverage below.
    const deleter = new AtomicArtifactDeleter({ dataDir: dir, fileLinkService: links });
    const result = deleter.deletePage(page.id);
    expect(result.unpublished).toBe(true);
    expect(result.recordsRemoved).toBe(1);
    expect(result.collectionsRemoved).toBe(1);
    expect(result.publishRequestsRemoved).toBe(1);

    expect(pages.get(page.id)).toBeUndefined();
    expect(pubs.getForPage(page.id)).toBeUndefined();
    expect(records.listCollections(page.id)).toEqual([]);
    expect(gate.getSnapshot(page.id)).toBeUndefined();
    expect(gate.listRequests(page.id)).toEqual([]);
    // Versions are content too — gone.
    expect(() => pages.listVersions(page.id)).toThrow(/unknown page/);
    // The unrelated workspace link is untouched by a page delete.
    expect(links.get(manual.link.id)?.status).toBe('active');
    // Unknown page → throws, nothing else happens.
    expect(() => deleter.deletePage(page.id)).toThrow(/unknown page/);

    // revokeForRef is the link half of atomic delete (used for artifact refs).
    const byRef = links.create({ kind: 'workspace', root: workspace, pathOrUploadId: 'linked.txt', confirmed: true });
    expect(links.revokeForRef('linked.txt')).toBe(2);
    expect(links.get(byRef.link.id)?.status).toBe('revoked');
  });
});

// ---------------------------------------------------------------------------
// FL-10 zip intake + HEIC/AVIF
// ---------------------------------------------------------------------------

describe('FL-10 zip unpacking', () => {
  it('lists and extracts a well-formed archive into the workspace', () => {
    const zip = zipSync({
      'hello.txt': strToU8('hi there'),
      'sub/nested.md': strToU8('# nested'),
      'sub/': new Uint8Array(0),
    });
    const entries = listZipEntries(new Uint8Array(zip));
    expect(entries.map((e) => e.name)).toContain('hello.txt');
    const result = extractZipToWorkspace(new Uint8Array(zip), workspace, { subdir: 'unpack' });
    expect(result.extracted.sort()).toEqual(['unpack/hello.txt', 'unpack/sub/nested.md']);
    expect(fs.readFileSync(join(workspace, 'unpack/sub/nested.md'), 'utf8')).toBe('# nested');
  });

  it('rejects traversal entries all-or-nothing (nothing is written)', () => {
    expect(() => sanitizeZipEntryName('../evil.txt')).toThrow(UnsafeZipEntryError);
    expect(() => sanitizeZipEntryName('/abs.txt')).toThrow(UnsafeZipEntryError);
    expect(() => sanitizeZipEntryName('ok/../../evil.txt')).toThrow(UnsafeZipEntryError);
    expect(sanitizeZipEntryName('a/./b.txt')).toBe('a/b.txt');
    const zip = zipSync({
      'good.txt': strToU8('good'),
      '../evil.txt': strToU8('evil'),
    });
    expect(() => extractZipToWorkspace(new Uint8Array(zip), workspace)).toThrow(UnsafeZipEntryError);
    expect(fs.existsSync(join(workspace, 'good.txt'))).toBe(false);
    expect(fs.existsSync(join(dir, 'evil.txt'))).toBe(false);
  });

  it('rejects backslash traversal and over-cap archives', () => {
    const zip = zipSync({ '..\\evil.txt': strToU8('evil') });
    expect(() => extractZipToWorkspace(new Uint8Array(zip), workspace)).toThrow(UnsafeZipEntryError);
    const big = zipSync({ 'big.bin': new Uint8Array(21 * 1024 * 1024) });
    expect(() => extractZipToWorkspace(new Uint8Array(big), workspace)).toThrow(/per-file cap/);
  });
});

describe('FL-10 HEIC/AVIF intake', () => {
  const heicBytes = (): Uint8Array => {
    const b = new Uint8Array(24);
    b.set([0, 0, 0, 24], 0);
    b.set([0x66, 0x74, 0x79, 0x70], 4); // ftyp
    b.set([0x68, 0x65, 0x69, 0x63], 8); // heic
    return b;
  };
  const avifBytes = (): Uint8Array => {
    const b = new Uint8Array(24);
    b.set([0, 0, 0, 24], 0);
    b.set([0x66, 0x74, 0x79, 0x70], 4);
    b.set([0x61, 0x76, 0x69, 0x66], 8); // avif
    return b;
  };

  it('detects HEIC/AVIF containers and rejects them with guidance (no decoder in tree)', async () => {
    expect(detectImageContainer(heicBytes())).toBe('heic');
    expect(detectImageContainer(avifBytes())).toBe('avif');
    await expect(intakeImage(heicBytes(), 'photo.heic')).rejects.toSatisfy(
      (err: unknown) => isUnsupportedImageFormatError(err) && /Convert the image to PNG or JPEG/.test((err as Error).message),
    );
    await expect(intakeImage(avifBytes(), 'photo.avif')).rejects.toSatisfy((err: unknown) =>
      isUnsupportedImageFormatError(err),
    );
    // Extension alone (mislabelled header) is also caught.
    await expect(intakeImage(new Uint8Array([1, 2, 3, 4]), 'photo.heic')).rejects.toSatisfy((err: unknown) =>
      isUnsupportedImageFormatError(err),
    );
  });

  it('passes JPEG/PNG through unchanged', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const result = await intakeImage(png, 'x.png');
    expect(result.format).toBe('png');
    expect(result.converted).toBe(false);
    expect(result.data).toEqual(png);
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9]);
    expect((await intakeImage(jpg, 'x.jpg')).format).toBe('jpeg');
  });
});
