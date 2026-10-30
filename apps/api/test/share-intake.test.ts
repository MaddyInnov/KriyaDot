// SPDX-License-Identifier: Apache-2.0
// C-11: PWA share-target intake — payload normalization, URL lifting,
// durable store, consume-once semantics, manifest fragment.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ShareIntakeStore, normalizeSharePayload, shareTargetManifest, createShareIntakeRouter } from '../src/share-intake.js';

describe('normalizeSharePayload', () => {
  it('keeps title/text/url and rejects empty shares', () => {
    expect(normalizeSharePayload({ title: 'T', text: 'x', url: 'https://a.example' })?.url).toBe('https://a.example');
    expect(normalizeSharePayload({})).toBeNull();
    expect(normalizeSharePayload({ title: ' ', text: ' ' })).toBeNull();
  });
  it('lifts a URL out of text (Android-style shares)', () => {
    const item = normalizeSharePayload({ text: 'look at https://example.com/post now' });
    expect(item?.url).toBe('https://example.com/post');
  });
  it('drops non-web URLs', () => {
    expect(normalizeSharePayload({ text: 'hi', url: 'file:///etc/passwd' })?.url).toBe('');
  });
});

describe('manifest fragment', () => {
  it('declares a GET share_target at /share-target with title/text/url params', () => {
    const m = shareTargetManifest() as { share_target: { action: string; method: string; params: Record<string, string> } };
    expect(m.share_target.action).toBe('/share-target');
    expect(m.share_target.params).toEqual({ title: 'title', text: 'text', url: 'url' });
  });
});

describe('ShareIntakeStore + routes', () => {
  let dir: string; let store: ShareIntakeStore; let server: Server; let base: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'share-intake-'));
    store = new ShareIntakeStore(dir);
    const app = express(); app.use(express.json()); app.use(express.urlencoded({ extended: true }));
    app.use('/api', createShareIntakeRouter({ store }));
    server = app.listen(0); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => { await new Promise<void>((r) => server.close(() => r())); store.close(); rmSync(dir, { recursive: true, force: true }); });

  it('POST /share-target stores a durable item; recent lists it; consume works once', async () => {
    const res = await fetch(`${base}/api/share-target`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Hi', text: 'shared body' }) });
    expect(res.status).toBe(201);
    const { item } = (await res.json()) as { item: { id: string } };
    const recent = (await (await fetch(`${base}/api/share-target/recent?unconsumed=1`)).json()) as { items: unknown[] };
    expect(recent.items).toHaveLength(1);
    expect((await fetch(`${base}/api/share-target/${item.id}/consume`, { method: 'POST' })).status).toBe(200);
    expect((await fetch(`${base}/api/share-target/${item.id}/consume`, { method: 'POST' })).status).toBe(404);
    const after = (await (await fetch(`${base}/api/share-target/recent?unconsumed=1`)).json()) as { items: unknown[] };
    expect(after.items).toHaveLength(0);
  });
  it('empty share is a 400', async () => {
    expect((await fetch(`${base}/api/share-target`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(400);
  });
});
