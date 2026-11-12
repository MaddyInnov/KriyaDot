// SPDX-License-Identifier: Apache-2.0
// Tests for the secrets broker routes (item A12):
// - identity connect/disconnect stores the token in the encrypted vault;
//   the token string appears in NO route response, journal row, or audit
// - standing grants: CRUD, validation, per-bot scope; revoke immediate
// - request cards: approve mints a per-run grant only (never a standing
//   grant); deny grants nothing; decide is one-shot

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrokerStore } from '@mvp/agent-runtime';
import { SecureVault } from '@mvp/vault';
import { createBrokerRouter } from '../src/broker-routes.js';

const FAKE_TOKEN = 'ghp_ROUTE_fake_token_9988776655';

describe('broker routes', () => {
  let dir: string;
  let baseUrl: string;
  let server: { close(cb: () => void): void } | null = null;
  let store: BrokerStore;
  let audits: Array<{ action: string; fields: unknown }>;
  let responses: string[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'brokerroutes-'));
    store = new BrokerStore(dir);
    audits = [];
    responses = [];
    const app = express();
    app.use(express.json());
    app.use(
      '/api',
      createBrokerRouter({
        store,
        vault: () => new SecureVault(dir, 'default-user', 'broker-test'),
        audit: (action, fields) => audits.push({ action, fields }),
        botIds: () => ['scout', 'coder'],
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
  });

  async function call(path: string, init?: RequestInit): Promise<{ status: number; json: unknown }> {
    const res = await fetch(`${baseUrl}${path}`, init);
    const text = await res.text();
    responses.push(text);
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }
  const post = (path: string, body: unknown) =>
    call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  function expectTokenNowhere(): void {
    const surfaces = [...responses, JSON.stringify(audits), JSON.stringify(store.listJournal())];
    for (const s of surfaces) expect(s).not.toContain(FAKE_TOKEN);
  }

  it('connects GitHub into the vault; token appears in NO response/journal/audit surface', async () => {
    const before = (await call('/broker/identities')).json as {
      identities: Array<{ identity: string; host: string; connected: boolean }>;
    };
    expect(before.identities).toEqual([{ identity: 'github', host: 'api.github.com', connected: false }]);

    const connected = await post('/broker/identities/github', { token: FAKE_TOKEN });
    expect(connected.status).toBe(200);
    // The vault itself holds the token (server-side only)…
    expect(new SecureVault(dir, 'default-user', 'check').get('broker-github')?.value).toBe(FAKE_TOKEN);
    // …and Settings now reports the identity connected.
    const after = (await call('/broker/identities')).json as {
      identities: Array<{ connected: boolean }>;
    };
    expect(after.identities[0]!.connected).toBe(true);

    // Reconnect replaces the token; disconnect removes it.
    expect((await post('/broker/identities/github', { token: FAKE_TOKEN })).status).toBe(200);
    const disc = await call('/broker/identities/github', { method: 'DELETE' });
    expect(disc.status).toBe(200);
    expect(new SecureVault(dir, 'default-user', 'check').list().map((s) => s.name)).not.toContain('broker-github');
    expect((await call('/broker/identities/github', { method: 'DELETE' })).status).toBe(404);
    expect((await post('/broker/identities/github', { token: '' })).status).toBe(400);
    expect((await post('/broker/identities/github', {})).status).toBe(400);

    expect(store.listJournal().map((j) => j.event)).toEqual(
      expect.arrayContaining(['identity_connected', 'identity_disconnected']),
    );
    expectTokenNowhere();
  });

  it('standing grants: create/list/revoke with validation and per-bot scope', async () => {
    const created = await post('/broker/grants', { identity: 'github', actionClass: 'write', scope: 'coder' });
    expect(created.status).toBe(200);
    const { grant } = created.json as { grant: { id: string; scope: string; createdVia: string } };
    expect(grant.scope).toBe('coder');
    expect(grant.createdVia).toBe('settings');
    expect(store.hasStandingGrant('coder', 'github', 'write')).toBe(true);
    expect(store.hasStandingGrant('scout', 'github', 'write')).toBe(false);

    const list = (await call('/broker/grants')).json as { grants: Array<{ id: string }> };
    expect(list.grants.map((g) => g.id)).toContain(grant.id);

    expect((await post('/broker/grants', { identity: 'gitlab', actionClass: 'read' })).status).toBe(400);
    expect((await post('/broker/grants', { identity: 'github', actionClass: 'admin' })).status).toBe(400);
    expect((await post('/broker/grants', { identity: 'github', actionClass: 'read', scope: 'ghost' })).status).toBe(400);

    const del = await call(`/broker/grants/${grant.id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    // Revocation is effective immediately — the store check the broker
    // performs on every execution already says no.
    expect(store.hasStandingGrant('coder', 'github', 'write')).toBe(false);
    expect((await call(`/broker/grants/${grant.id}`, { method: 'DELETE' })).status).toBe(404);
    expect(audits.map((a) => a.action)).toEqual(
      expect.arrayContaining(['broker.standing_grant_created', 'broker.standing_grant_revoked']),
    );
    expectTokenNowhere();
  });

  it('request cards: approve grants this run only; deny grants nothing; decide is one-shot', async () => {
    const card = store.requestGrant({
      botId: 'scout',
      sessionId: 'sess-1',
      identity: 'github',
      actionClass: 'write',
      action: 'github.create_issue',
      resource: 'octocat/hello-world',
    });
    const pending = (await call('/broker/requests?status=pending')).json as { cards: Array<{ id: string }> };
    expect(pending.cards.map((c) => c.id)).toContain(card.id);

    expect((await post(`/broker/requests/${card.id}`, { decision: 'approve' })).status).toBe(200);
    expect(store.hasRunGrant('scout', 'sess-1', 'github', 'write')).toBe(true);
    // A card approval NEVER mints a standing grant.
    expect(store.listStandingGrants()).toHaveLength(0);
    expect((await post(`/broker/requests/${card.id}`, { decision: 'deny' })).status).toBe(409);

    const card2 = store.requestGrant({
      botId: 'coder',
      sessionId: 'sess-2',
      identity: 'github',
      actionClass: 'read',
      action: 'github.list_repos',
    });
    expect((await post(`/broker/requests/${card2.id}`, { decision: 'deny' })).status).toBe(200);
    expect(store.hasRunGrant('coder', 'sess-2', 'github', 'read')).toBe(false);

    expect((await post(`/broker/requests/${card2.id}`, { decision: 'maybe' })).status).toBe(400);
    expect((await post('/broker/requests/nope', { decision: 'deny' })).status).toBe(404);
    expectTokenNowhere();
  });

  it('journal endpoint returns entries with ids/hashes only', async () => {
    store.appendJournal({
      botId: 'scout',
      sessionId: 's',
      identity: 'github',
      action: 'github.create_issue',
      actionClass: 'write',
      event: 'action_executed',
      resource: 'octocat/hello-world',
      argsHash: 'a'.repeat(64),
      detail: 'http_201',
    });
    const out = (await call('/broker/journal')).json as {
      entries: Array<{ event: string; resource: string; argsHash: string }>;
    };
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]).toMatchObject({ event: 'action_executed', resource: 'octocat/hello-world' });
    expectTokenNowhere();
  });
});
