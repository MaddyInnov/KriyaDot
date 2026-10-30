// SPDX-License-Identifier: Apache-2.0
// C-12 per-message share/export + C-9 per-message delete (own only).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IdentifiedMessage } from '@mvp/agent-runtime';
import { createMessageShareRouter, isShareableMessage, renderMessageMarkdown } from '../src/message-share.js';
import { MessageDeletionStore, checkDeletable, createMessageDeleteRouter, filterDeletedMessages } from '../src/message-delete.js';
import { registerPublicPageServing } from '../src/public-pages.js';

const MSGS: IdentifiedMessage[] = [
  { id: 1, role: 'user', content: 'my question', ts: '2026-10-30T00:00:00.000Z' },
  { id: 2, role: 'assistant', content: 'the answer', ts: '2026-10-30T00:01:00.000Z' },
  { id: 3, role: 'tool', content: 'tool trace', ts: '2026-10-30T00:02:00.000Z', toolName: 'search' },
];
const list = () => MSGS;

let dir: string; let server: Server; let base: string; let deletions: MessageDeletionStore;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'msg-share-del-'));
  deletions = new MessageDeletionStore(dir);
  const app = express(); app.use(express.json());
  app.use('/api', createMessageShareRouter({ dataDir: dir, listThreadMessages: list }));
  app.use('/api', createMessageDeleteRouter({ store: deletions, listThreadMessages: list }));
  registerPublicPageServing(app, { dataDir: dir });
  server = app.listen(0); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => { await new Promise<void>((r) => server.close(() => r())); deletions.close(); rmSync(dir, { recursive: true, force: true }); });

describe('C-12 per-message share', () => {
  it('only user/assistant messages are shareable', () => {
    expect(isShareableMessage(MSGS[0]!)).toBe(true);
    expect(isShareableMessage(MSGS[2]!)).toBe(false);
    expect(renderMessageMarkdown(MSGS[1]!, 'sess_abcdefgh')).toContain('the answer');
  });
  it('POST share publishes a public page for exactly one message', async () => {
    const res = await fetch(`${base}/api/sessions/sess1/messages/2/share`, { method: 'POST' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { path: string };
    const page = await fetch(`${base}${body.path}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('the answer');
    expect(html).not.toContain('my question');
  });
  it('tool messages cannot be shared (422); unknown message 404', async () => {
    expect((await fetch(`${base}/api/sessions/sess1/messages/3/share`, { method: 'POST' })).status).toBe(422);
    expect((await fetch(`${base}/api/sessions/sess1/messages/99/share`, { method: 'POST' })).status).toBe(404);
  });
  it('export returns text / markdown / json downloads', async () => {
    const txt = await (await fetch(`${base}/api/sessions/sess1/messages/1/export?format=text`)).text();
    expect(txt).toBe('my question');
    const json = (await (await fetch(`${base}/api/sessions/sess1/messages/1/export?format=json`)).json()) as { content: string };
    expect(json.content).toBe('my question');
  });
});

describe('C-9 per-message delete (own messages only)', () => {
  it('pure rule: user role only; owner mismatch refused', () => {
    expect(checkDeletable(MSGS[0]!).ok).toBe(true);
    expect(checkDeletable(MSGS[1]!).reason).toBe('not-own-message');
    expect(checkDeletable(MSGS[0]!, { sessionOwnerId: 'you', requesterId: 'other' }).reason).toBe('not-owner');
    expect(checkDeletable(null).reason).toBe('not-found');
  });
  it('DELETE own message tombstones it and filters read paths', async () => {
    const res = await fetch(`${base}/api/sessions/sess1/messages/1`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(deletions.isDeleted('sess1', 1)).toBe(true);
    expect(filterDeletedMessages(deletions, 'sess1', MSGS).map((m) => m.id)).toEqual([2, 3]);
    const again = (await (await fetch(`${base}/api/sessions/sess1/messages/1`, { method: 'DELETE' })).json()) as { alreadyDeleted?: boolean };
    expect(again.alreadyDeleted).toBe(true);
  });
  it('DELETE assistant message is refused 403 and not tombstoned', async () => {
    const res = await fetch(`${base}/api/sessions/sess1/messages/2`, { method: 'DELETE' });
    expect(res.status).toBe(403);
    expect(deletions.isDeleted('sess1', 2)).toBe(false);
  });
});
