// SPDX-License-Identifier: Apache-2.0
// C-15 / FL-11 / FL-14: unified Library aggregation, system-files view,
// in-viewer editing through the owning stores.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ModuleDb, ArtifactStore, SlideDeckStore } from '@mvp/muse-modules';
import { buildLibraryItems, filterLibraryItems, listSystemFiles, categorizeSystemFile } from '../src/library.js';
import { createLibraryRouter } from '../src/library-routes.js';

let dir: string; let base: string; let server: Server;
let artifacts: ArtifactStore; let decks: SlideDeckStore;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'library-'));
  writeFileSync(join(dir, 'chat.db'), 'x');
  writeFileSync(join(dir, 'vault.default-user.json'), '{}');
  const ws = join(dir, 'ws'); writeFileSync(join(dir, 'readme.txt'), 'hi');
  const mdb = new ModuleDb(join(dir, 'muse-modules.db'));
  artifacts = new ArtifactStore(mdb);
  decks = new SlideDeckStore(mdb);
  artifacts.create({ title: 'Launch plan', content: '# Plan\n\nShip it.' });
  decks.create({ title: 'Pitch', slides: [{ layout: 'title', heading: 'Hi', bullets: [], extra: [], notes: '' }] });
  const app = express(); app.use(express.json());
  app.use('/api', createLibraryRouter({ dataDir: dir, workspaceDir: dir, artifacts, decks }));
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => { await new Promise<void>((r) => server.close(() => r())); rmSync(dir, { recursive: true, force: true }); });

describe('C-15 unified library', () => {
  it('unifies artifacts + decks + files in one list with editability flags', () => {
    const items = buildLibraryItems({
      artifacts: () => artifacts.list(), decks: () => decks.list(),
      media: () => [{ id: 'm1', kind: 'image', prompt: 'a cat', url: 'mock://media/m1.png', mimeType: 'image/png', byteLength: 10, provider: 'mock' }],
      files: () => [{ name: 'readme.txt', path: 'readme.txt', type: 'file', size: 2 }],
    });
    expect(items.map((i) => i.kind).sort()).toEqual(['artifact', 'deck', 'file', 'media']);
    expect(items.find((i) => i.kind === 'artifact')?.editable).toBe(true);
    expect(items.find((i) => i.kind === 'deck')?.editable).toBe(true);
    expect(items.find((i) => i.kind === 'media')?.editable).toBe(false);
    expect(items.find((i) => i.kind === 'file')?.editable).toBe(false);
  });
  it('search + kind filter work over the unified list', () => {
    const items = buildLibraryItems({ artifacts: () => artifacts.list(), decks: () => decks.list(), media: () => [], files: () => [] });
    expect(filterLibraryItems(items, 'launch')).toHaveLength(1);
    expect(filterLibraryItems(items, undefined, 'deck')).toHaveLength(1);
    expect(filterLibraryItems(items, 'nope')).toHaveLength(0);
  });
  it('GET /api/library returns items + counts', async () => {
    const res = await fetch(`${base}/api/library`);
    const body = (await res.json()) as { items: unknown[]; counts: Record<string, number> };
    expect(body.counts.artifact).toBe(1);
    expect(body.counts.deck).toBe(1);
  });
});

describe('FL-11 system files', () => {
  it('categorizes and lists data-dir metadata without contents', async () => {
    expect(categorizeSystemFile('a.db')).toBe('database');
    expect(categorizeSystemFile('a.json')).toBe('store');
    const files = listSystemFiles(dir);
    expect(files.some((f) => f.name === 'chat.db')).toBe(true);
    expect(JSON.stringify(files)).not.toContain('"content"');
    const res = await fetch(`${base}/api/library/system-files`);
    expect(res.status).toBe(200);
  });
  it('missing dir lists empty instead of throwing', () => {
    expect(listSystemFiles(join(dir, 'nope'))).toEqual([]);
  });
});

describe('FL-14 in-viewer editing', () => {
  it('PUT artifact edit creates a new version in the owning store', async () => {
    const a = artifacts.list()[0]!;
    const res = await fetch(`${base}/api/library/artifacts/${a.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: '# Plan v2' }),
    });
    expect(res.status).toBe(200);
    expect(artifacts.get(a.id).version).toBe(2);
    expect(artifacts.get(a.id).content).toBe('# Plan v2');
    expect(artifacts.versions(a.id)).toHaveLength(2);
  });
  it('PUT deck edit validates + saves through the owning store', async () => {
    const d = decks.list()[0]!;
    const res = await fetch(`${base}/api/library/decks/${d.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Pitch v2', slides: [{ layout: 'bullets', heading: 'Why', bullets: ['because'], extra: [], notes: '' }] }),
    });
    expect(res.status).toBe(200);
    expect(decks.get(d.id).title).toBe('Pitch v2');
    const bad = await fetch(`${base}/api/library/decks/${d.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slides: 'nope' }),
    });
    expect(bad.status).toBe(400);
  });
});
