// SPDX-License-Identifier: Apache-2.0
// Published bots + org library: publish/list/install/unpublish with
// audience honoring, and org-library CRUD/install with cross-org isolation.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPublishedBotsRouter } from '../src/published-bots-routes.js';
import { createOrgLibraryRouter } from '../src/org-library.js';
import type { BotConfig } from '@mvp/agent-runtime';

function bot(id: string): BotConfig {
  return { id, name: `Bot ${id}`, description: 'd', systemPrompt: 'p', provider: 'groq', model: 'm', skills: ['s1'], tools: [], mcpServers: [] };
}

async function serve(app: express.Express): Promise<{ base: string; close: () => void }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

const OWNER_TOKEN = 'test-owner-token'; // OPEN-1: requests authenticate as the loopback owner; x-user-id then asserts the local profile
const H = (user: string, org?: string) => ({
  'content-type': 'application/json',
  authorization: `Bearer ${OWNER_TOKEN}`,
  'x-user-id': user,
  ...(org ? { 'x-org-id': org } : {}),
});

describe('published bots', () => {
  let bots: BotConfig[];
  let srv: { base: string; close: () => void };
  afterEach(() => srv?.close());
  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pub-bots-'));
    bots = [bot('expert-1')];
    const app = express();
    app.use(express.json());
    app.use('/api/published-bots', createPublishedBotsRouter({ dataDir: dir, getBots: () => bots, loopbackToken: OWNER_TOKEN }));
    srv = await serve(app);
  });
  const url = () => `${srv.base}/api/published-bots`;

  it('publish → list → install makes an independent copy; unpublish works', async () => {
    const pub = await (await fetch(url(), { method: 'POST', headers: H('alice', 'org-a'), body: JSON.stringify({ botId: 'expert-1', orgId: 'org-a' }) })).json() as { ok: boolean; published: { id: string } };
    expect(pub.ok).toBe(true);
    const listed = await (await fetch(`${url()}?orgId=org-a`, { headers: H('bob', 'org-a') })).json() as { published: unknown[] };
    expect(listed.published).toHaveLength(1);
    const installed = await (await fetch(`${url()}/${pub.published.id}/install`, { method: 'POST', headers: H('bob', 'org-a'), body: JSON.stringify({}) })).json() as { ok: boolean; bot: BotConfig };
    expect(installed.ok).toBe(true);
    expect(installed.bot.id).toBe('expert-1-copy-2');
    expect(bots.map((b) => b.id)).toContain('expert-1-copy-2');
    // Only the publisher can unpublish.
    const denied = await fetch(`${url()}/${pub.published.id}`, { method: 'DELETE', headers: H('bob', 'org-a') });
    expect(denied.status).toBe(403);
    const gone = await fetch(`${url()}/${pub.published.id}`, { method: 'DELETE', headers: H('alice', 'org-a') });
    expect(gone.status).toBe(200);
    expect(bots.map((b) => b.id)).toContain('expert-1-copy-2'); // copy survives
  });

  it('cross-org and private visibility are honored', async () => {
    await fetch(url(), { method: 'POST', headers: H('alice', 'org-a'), body: JSON.stringify({ botId: 'expert-1', orgId: 'org-a', visibility: 'private' }) });
    const otherOrg = await (await fetch(`${url()}?orgId=org-b`, { headers: H('carol', 'org-b') })).json() as { published: unknown[] };
    expect(otherOrg.published).toHaveLength(0);
    const sameOrgPrivate = await (await fetch(`${url()}?orgId=org-a`, { headers: H('bob', 'org-a') })).json() as { published: unknown[] };
    expect(sameOrgPrivate.published).toHaveLength(0);
    const owner = await (await fetch(`${url()}?orgId=org-a`, { headers: H('alice', 'org-a') })).json() as { published: unknown[] };
    expect(owner.published).toHaveLength(1);
  });

  it('publishing an unknown bot is 404', async () => {
    const res = await fetch(url(), { method: 'POST', headers: H('alice', 'org-a'), body: JSON.stringify({ botId: 'nope' }) });
    expect(res.status).toBe(404);
  });
});

describe('org library', () => {
  let bots: BotConfig[];
  let srv: { base: string; close: () => void };
  afterEach(() => srv?.close());
  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'org-lib-'));
    bots = [];
    const app = express();
    app.use(express.json());
    app.use('/api/org-library', createOrgLibraryRouter({ dataDir: dir, getBots: () => bots, loopbackToken: OWNER_TOKEN }));
    srv = await serve(app);
  });
  const url = () => `${srv.base}/api/org-library`;

  it('CRUD + bot-template install creates a bot', async () => {
    const created = await (await fetch(url(), { method: 'POST', headers: H('alice', 'org-a'), body: JSON.stringify({ kind: 'bot-template', name: 'Helper', payload: bot('helper') }) })).json() as { ok: boolean; entry: { id: string } };
    expect(created.ok).toBe(true);
    const installed = await fetch(`${url()}/${created.entry.id}/install`, { method: 'POST', headers: H('bob', 'org-a'), body: JSON.stringify({}) });
    expect(installed.status).toBe(201);
    expect(bots.map((b) => b.id)).toEqual(['helper']);
    const updated = await (await fetch(`${url()}/${created.entry.id}`, { method: 'PUT', headers: H('alice', 'org-a'), body: JSON.stringify({ name: 'Helper v2' }) })).json() as { entry: { name: string } };
    expect(updated.entry.name).toBe('Helper v2');
    const del = await fetch(`${url()}/${created.entry.id}`, { method: 'DELETE', headers: H('alice', 'org-a') });
    expect(del.status).toBe(200);
  });

  it('cross-org isolation: org B cannot see, read, or install org A entries', async () => {
    const created = await (await fetch(url(), { method: 'POST', headers: H('alice', 'org-a'), body: JSON.stringify({ kind: 'skill', name: 'S', payload: { name: 's' } }) })).json() as { entry: { id: string } };
    const listB = await (await fetch(url(), { headers: H('carol', 'org-b') })).json() as { entries: unknown[] };
    expect(listB.entries).toHaveLength(0);
    const getB = await fetch(`${url()}/${created.entry.id}`, { headers: H('carol', 'org-b') });
    expect(getB.status).toBe(404);
    const installB = await fetch(`${url()}/${created.entry.id}/install`, { method: 'POST', headers: H('carol', 'org-b'), body: JSON.stringify({}) });
    expect(installB.status).toBe(404);
  });

  it('skill/team installs without hooks return the payload with a note', async () => {
    const skill = await (await fetch(url(), { method: 'POST', headers: H('alice', 'org-a'), body: JSON.stringify({ kind: 'skill', name: 'S', payload: { name: 'deep-research' } }) })).json() as { entry: { id: string } };
    const res = await (await fetch(`${url()}/${skill.entry.id}/install`, { method: 'POST', headers: H('alice', 'org-a'), body: JSON.stringify({}) })).json() as { note?: string; installed: { payload: { name: string } } };
    expect(res.note).toMatch(/no skill-store hook/);
    expect(res.installed.payload.name).toBe('deep-research');
  });
});
