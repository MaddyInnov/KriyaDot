// SPDX-License-Identifier: Apache-2.0
// Managed knowledge bases: store limits/sharing/citations, routes, tools.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { KbStore, chunkKbText, type KbActor } from '../src/kb.js';
import { createKbRouter } from '../src/kb-routes.js';
import { createKbTools } from '../src/kb-tools.js';

const owner: KbActor = { userId: 'alice' };
const reader: KbActor = { userId: 'bob' };
const contributor: KbActor = { userId: 'carol' };
const stranger: KbActor = { userId: 'mallory' };

describe('chunkKbText', () => {
  it('chunks word-boundary with overlap', () => {
    expect(chunkKbText('hello world')).toEqual(['hello world']);
    expect(chunkKbText('   ')).toEqual([]);
    const chunks = chunkKbText('word '.repeat(1000));
    expect(chunks.length).toBeGreaterThan(1);
  });
});

describe('KbStore', () => {
  let dir: string;
  let store: KbStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kb-managed-'));
    store = new KbStore(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('creates corpora with folders, documents, and cited search', async () => {
    const kb = store.createCorpus(owner, { name: 'Product Docs' });
    expect(kb.embeddingProvider).toBe('local');
    const folder = store.addFolder(owner, kb.id, 'Guides');
    const doc = store.addDocument(owner, kb.id, {
      title: 'Refund Policy',
      text: 'Customers can request a refund within thirty days of purchase. Refunds go to the original payment method.',
      folderId: folder.id,
    });
    expect(doc.originalText).toContain('thirty days');
    expect(doc.editedText).toBeNull();
    expect(doc.chunkCount).toBeGreaterThan(0);

    const citations = store.search(owner, 'refund thirty days', { kbId: kb.id });
    expect(citations.length).toBeGreaterThan(0);
    expect(citations[0]).toMatchObject({ kbId: kb.id, docId: doc.id, docTitle: 'Refund Policy', chunkIndex: 0 });
    expect(citations[0].excerpt).toContain('refund');
  });

  it('enforces per-KB doc and byte limits', () => {
    const kb = store.createCorpus(owner, { name: 'Tiny', maxDocs: 1, maxBytes: 100 });
    store.addDocument(owner, kb.id, { title: 'One', text: 'small' });
    expect(() => store.addDocument(owner, kb.id, { title: 'Two', text: 'small' })).toThrow(/document limit/);
    const kb2 = store.createCorpus(owner, { name: 'Bytes', maxBytes: 10 });
    expect(() => store.addDocument(owner, kb2.id, { title: 'Big', text: 'this is way more than ten bytes' })).toThrow(/byte limit/);
  });

  it('edits retain the original text and re-index', () => {
    const kb = store.createCorpus(owner, { name: 'Editable' });
    const doc = store.addDocument(owner, kb.id, { title: 'Plan', text: 'The launch is in March.' });
    const edited = store.editDocument(owner, kb.id, doc.id, 'The launch moved to September.');
    expect(edited.originalText).toContain('March');
    expect(edited.editedText).toContain('September');
    const hits = store.search(owner, 'September launch', { kbId: kb.id });
    expect(hits[0]?.excerpt).toContain('September');
  });

  it('sharing: read cannot contribute, contribute can, unshare revokes, org shares work', () => {
    const kb = store.createCorpus(owner, { name: 'Shared' });
    store.addDocument(owner, kb.id, { title: 'Spec', text: 'The widget supports dark mode and keyboard shortcuts.' });
    // Stranger sees nothing.
    expect(store.listCorpora(stranger)).toHaveLength(0);
    expect(() => store.search(stranger, 'widget')).toHaveLength(0);

    store.share(owner, kb.id, { principalType: 'user', principalId: 'bob', role: 'read' });
    expect(store.listCorpora(reader)).toHaveLength(1);
    expect(store.search(reader, 'widget dark mode', { kbId: kb.id }).length).toBeGreaterThan(0);
    expect(() => store.addDocument(reader, kb.id, { title: 'X', text: 'nope' })).toThrow(/contribute/);

    store.share(owner, kb.id, { principalType: 'user', principalId: 'carol', role: 'contribute' });
    const added = store.addDocument(contributor, kb.id, { title: 'Extra', text: 'Carol added this document about widgets.' });
    expect(added.kbId).toBe(kb.id);

    // Org share: anyone with the org id can read.
    store.share(owner, kb.id, { principalType: 'org', principalId: 'acme', role: 'read' });
    expect(store.listCorpora({ userId: 'dave', orgId: 'acme' })).toHaveLength(1);
    expect(store.listCorpora({ userId: 'dave', orgId: 'other-org' })).toHaveLength(0);

    // Only the owner can share.
    expect(() => store.share(reader, kb.id, { principalType: 'user', principalId: 'x', role: 'read' })).toThrow(/only the owner/);

    store.unshare(owner, kb.id, 'user', 'bob');
    expect(store.listCorpora(reader)).toHaveLength(0);
  });

  it('per-KB embedding provider choice is stored and used', () => {
    const kb = store.createCorpus(owner, { name: 'Neural KB', embeddingProvider: 'neural' });
    expect(kb.embeddingProvider).toBe('neural');
    store.addDocument(owner, kb.id, { title: 'N', text: 'Neural corpora still index and search locally by default.' });
    expect(store.search(owner, 'neural corpora search', { kbId: kb.id }).length).toBeGreaterThan(0);
    const updated = store.updateCorpus(owner, kb.id, { embeddingProvider: 'local' });
    expect(updated.embeddingProvider).toBe('local');
  });

  it('persists across store instances', () => {
    const kb = store.createCorpus(owner, { name: 'Durable' });
    const again = new KbStore(dir);
    expect(again.listCorpora(owner).map((c) => c.id)).toContain(kb.id);
  });
});

describe('kb routes + tools', () => {
  let dir: string;
  let server: ReturnType<express.Express['listen']>;
  let base: string;
  let store: KbStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kb-routes-'));
    store = new KbStore(dir);
    const app = express();
    app.use(express.json());
    app.use('/api/kb', createKbRouter({ dataDir: dir, store }));
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/kb`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  const call = async (method: string, path: string, user: string, body?: unknown) => {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-user-id': user },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: (await r.json()) as any };
  };

  it('full route flow with sharing enforcement', async () => {
    const created = await call('POST', '/', 'alice', { name: 'Route KB', maxDocs: 5 });
    expect(created.status).toBe(201);
    const kbId = created.json.id as string;

    const doc = await call('POST', `/${kbId}/documents`, 'alice', {
      title: 'Onboarding',
      text: 'New engineers get a laptop, a mentor, and access to the staging environment.',
    });
    expect(doc.status).toBe(201);

    // Bob cannot see it yet.
    expect((await call('GET', '/', 'bob')).json.corpora).toHaveLength(0);
    const forbidden = await call('GET', `/${kbId}/search?q=laptop`, 'bob');
    expect(forbidden.json.citations).toEqual([]);

    await call('POST', `/${kbId}/share`, 'alice', { principalType: 'user', principalId: 'bob', role: 'read' });
    const search = await call('GET', `/${kbId}/search?q=laptop+mentor`, 'bob');
    expect(search.json.citations.length).toBeGreaterThan(0);
    expect(search.json.citations[0]).toMatchObject({ kbId, docTitle: 'Onboarding' });

    // Bob (read) cannot add documents.
    const denied = await call('POST', `/${kbId}/documents`, 'bob', { title: 'Nope', text: 'denied text' });
    expect(denied.status).toBe(403);
  });

  it('tools return citations for the default user', async () => {
    const kb = store.createCorpus({ userId: 'default-user' }, { name: 'Tool KB' });
    store.addDocument({ userId: 'default-user' }, kb.id, {
      title: 'Deploy Guide',
      text: 'Deployments run through the blue green pipeline with automated rollback.',
    });
    const tools = createKbTools(store);
    const search = tools.find((t) => t.name === 'kb_search_managed')!;
    const result = (await search.handler({ query: 'blue green deployment rollback' }, { sessionId: 's', botId: 'b' } as never)) as {
      citations: Array<{ docTitle: string; kbId: string }>;
    };
    expect(result.citations.length).toBeGreaterThan(0);
    expect(result.citations[0].docTitle).toBe('Deploy Guide');
    const list = tools.find((t) => t.name === 'kb_list_managed')!;
    const listed = (await list.handler({}, { sessionId: 's', botId: 'b' } as never)) as { corpora: unknown[] };
    expect(listed.corpora).toHaveLength(1);
  });
});
