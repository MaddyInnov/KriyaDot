// SPDX-License-Identifier: Apache-2.0
// Tests for the PC file access routes:
// - grant CRUD: create (path + special folder), validation errors
//   (relative path, missing folder, file-not-folder, unknown bot scope),
//   list, revoke
// - special folders resolve for the host (injected win32 env)
// - just-in-time request cards: list + decide (allow-once / always
//   creates a bot-scoped grant / deny), one-shot semantics

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PcAccessStore } from '@mvp/agent-runtime';
import { createPcAccessRouter } from '../src/pc-access-routes.js';

describe('pc-access routes', () => {
  let dir: string;
  let pcRoot: string;
  let baseUrl: string;
  let server: { close(cb: () => void): void } | null = null;
  let store: PcAccessStore;
  let audits: Array<{ action: string; fields: unknown }>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pcroutes-'));
    pcRoot = realpathSync(mkdtempSync(join(tmpdir(), 'pcroutes-pc-')));
    mkdirSync(join(pcRoot, 'Desktop'), { recursive: true });
    writeFileSync(join(pcRoot, 'a-file.txt'), 'not a folder');
    store = new PcAccessStore(dir);
    audits = [];
    const app = express();
    app.use(express.json());
    app.use(
      '/api',
      createPcAccessRouter({
        store,
        audit: (action, fields) => audits.push({ action, fields }),
        botIds: () => ['scout', 'coder'],
        // Host-platform resolution against the POSIX temp tree (win32
        // string resolution itself is unit-tested in agent-runtime).
        env: { HOME: pcRoot },
        platform: 'linux',
      }),
    );
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve()) as unknown as {
        close(cb: () => void): void;
      };
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}/api`;
  });

  afterEach(async () => {
    store.close();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
    rmSync(pcRoot, { recursive: true, force: true });
  });

  const post = (path: string, body: unknown) =>
    fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('creates, lists and revokes a grant by absolute path', async () => {
    const created = await post('/pc-access/grants', { path: join(pcRoot, 'Desktop') });
    expect(created.status).toBe(200);
    const { grant } = (await created.json()) as { grant: { id: string; path: string; scope: string } };
    expect(grant.path).toBe(join(pcRoot, 'Desktop'));
    expect(grant.scope).toBe('all');

    const list = (await (await fetch(`${baseUrl}/pc-access/grants`)).json()) as {
      grants: Array<{ id: string }>;
    };
    expect(list.grants.map((g) => g.id)).toContain(grant.id);

    const del = await fetch(`${baseUrl}/pc-access/grants/${grant.id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(store.listGrants()).toHaveLength(0);
    const delAgain = await fetch(`${baseUrl}/pc-access/grants/${grant.id}`, { method: 'DELETE' });
    expect(delAgain.status).toBe(404);
    expect(audits.map((a) => a.action)).toEqual(
      expect.arrayContaining(['pc-access.grant_created', 'pc-access.grant_revoked']),
    );
  });

  it('creates a grant from a special folder + per-bot scope', async () => {
    const created = await post('/pc-access/grants', { specialFolder: 'desktop', scope: 'scout' });
    expect(created.status).toBe(200);
    const { grant } = (await created.json()) as { grant: { path: string; scope: string } };
    expect(grant.path).toBe(join(pcRoot, 'Desktop'));
    expect(grant.scope).toBe('scout');
    expect(store.grantsForBot('coder')).toEqual([]);
  });

  it('rejects invalid grants: relative path, missing folder, file, unknown bot', async () => {
    expect((await post('/pc-access/grants', { path: 'relative/folder' })).status).toBe(400);
    expect((await post('/pc-access/grants', { path: join(pcRoot, 'nope') })).status).toBe(400);
    expect((await post('/pc-access/grants', { path: join(pcRoot, 'a-file.txt') })).status).toBe(400);
    expect(
      (await post('/pc-access/grants', { path: join(pcRoot, 'Desktop'), scope: 'ghost' })).status,
    ).toBe(400);
    expect((await post('/pc-access/grants', { specialFolder: 'attic' })).status).toBe(400);
    expect((await post('/pc-access/grants', {})).status).toBe(400);
    expect(store.listGrants()).toHaveLength(0);
  });

  it('serves special folders resolved for this host', async () => {
    const res = (await (await fetch(`${baseUrl}/pc-access/special-folders`)).json()) as {
      folders: Array<{ name: string; path: string; exists: boolean }>;
    };
    const desktop = res.folders.find((f) => f.name === 'desktop');
    expect(desktop?.path).toBe(join(pcRoot, 'Desktop'));
    expect(desktop?.exists).toBe(true);
    const documents = res.folders.find((f) => f.name === 'documents');
    expect(documents?.exists).toBe(false); // resolved but not created on disk
  });

  it('decides a request card: always creates a bot-scoped grant', async () => {
    const card = store.requestAccess({
      botId: 'scout',
      sessionId: 'sess-1',
      folder: join(pcRoot, 'Desktop'),
      action: 'list',
    });
    const pending = (await (await fetch(`${baseUrl}/pc-access/requests?status=pending`)).json()) as {
      cards: Array<{ id: string; folder: string }>;
    };
    expect(pending.cards.map((c) => c.id)).toContain(card.id);

    const decided = await post(`/pc-access/requests/${card.id}`, { decision: 'always' });
    expect(decided.status).toBe(200);
    expect(store.getRequest(card.id)?.status).toBe('always-allowed');
    expect(store.listGrants()).toHaveLength(1);
    expect(store.listGrants()[0]).toMatchObject({ scope: 'scout', createdVia: 'approval' });

    // One-shot: deciding again conflicts.
    expect((await post(`/pc-access/requests/${card.id}`, { decision: 'deny' })).status).toBe(409);
  });

  it('decides allow-once and deny without persisting grants', async () => {
    const c1 = store.requestAccess({
      botId: 'scout',
      sessionId: 'sess-1',
      folder: join(pcRoot, 'Desktop'),
      action: 'read',
      filePath: join(pcRoot, 'Desktop', 'x.txt'),
    });
    expect((await post(`/pc-access/requests/${c1.id}`, { decision: 'allow-once' })).status).toBe(200);
    expect(store.isOnceAllowed('sess-1', join(pcRoot, 'Desktop'))).toBe(true);
    expect(store.listGrants()).toHaveLength(0);

    const c2 = store.requestAccess({
      botId: 'coder',
      sessionId: 'sess-2',
      folder: join(pcRoot, 'Desktop'),
      action: 'list',
    });
    expect((await post(`/pc-access/requests/${c2.id}`, { decision: 'deny' })).status).toBe(200);
    expect(store.getRequest(c2.id)?.status).toBe('denied');
    expect(store.listGrants()).toHaveLength(0);
  });

  it('validates decide bodies and unknown cards', async () => {
    const card = store.requestAccess({
      botId: 'scout',
      sessionId: 'sess-1',
      folder: join(pcRoot, 'Desktop'),
      action: 'list',
    });
    expect((await post(`/pc-access/requests/${card.id}`, { decision: 'maybe' })).status).toBe(400);
    expect((await post('/pc-access/requests/nope', { decision: 'deny' })).status).toBe(404);
  });
});
