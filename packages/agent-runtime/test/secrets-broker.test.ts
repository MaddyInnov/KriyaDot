// SPDX-License-Identifier: Apache-2.0
// Tests for secrets-broker.ts + tools/broker.ts (item A12):
// - the broker executes a catalogue action with the APP-held token
//   against a fake GitHub API server on 127.0.0.1 (never the real API)
// - the token string appears NOWHERE in tool results, errors, journal
//   rows, or audit fan-out (grep assertion over every surface)
// - ungranted request → approval card raised, no call made; denied → no
//   call; run-grant expiry fails closed
// - host-allowlist: construction refuses a non-allowlisted base, and
//   steering arguments (url/host/token keys, traversal repos) are refused
// - standing grants: CRUD, per-bot scoping, revoke effective immediately,
//   and request-card approval NEVER creates one

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BrokerStore,
  SecretsBroker,
  type BrokerJournalEntry,
} from '../src/secrets-broker.js';
import { createBrokerTool } from '../src/tools/broker.js';
import type { ToolContext } from '../src/types.js';

const FAKE_TOKEN = 'ghp_FAKE_token_for_tests_0123456789abcdef';

interface SeenRequest {
  method: string;
  url: string;
  authorization: string | null;
  body: string;
}

describe('secrets broker (fake GitHub API on 127.0.0.1)', () => {
  let dir: string;
  let store: BrokerStore;
  let server: Server;
  let baseUrl: string;
  let seen: SeenRequest[];
  let journalFanout: BrokerJournalEntry[];
  /** When set, the fake API echoes the Authorization header in an error
   *  body — the broker must scrub it before quoting anything. */
  let echoTokenInError = false;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'broker-'));
    store = new BrokerStore(dir);
    seen = [];
    journalFanout = [];
    echoTokenInError = false;
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({
          method: req.method ?? '',
          url: req.url ?? '',
          authorization: req.headers.authorization ?? null,
          body,
        });
        const send = (status: number, payload: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        };
        if (echoTokenInError) {
          send(422, { message: `Validation Failed for token ${req.headers.authorization ?? ''}` });
          return;
        }
        if (req.method === 'POST' && req.url === '/repos/octocat/hello-world/issues') {
          const parsed = JSON.parse(body) as { title: string };
          send(201, {
            number: 42,
            html_url: 'https://github.com/octocat/hello-world/issues/42',
            state: 'open',
            title: parsed.title,
          });
          return;
        }
        if (req.method === 'POST' && req.url === '/repos/octocat/hello-world/issues/7/comments') {
          send(201, { id: 9001, html_url: 'https://github.com/octocat/hello-world/issues/7#issuecomment-9001' });
          return;
        }
        if (req.method === 'GET' && req.url?.startsWith('/user/repos')) {
          send(200, [{ full_name: 'octocat/hello-world', private: false, default_branch: 'main', secret_field: 'x' }]);
          return;
        }
        send(404, { message: 'Not Found' });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    store.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  /** Broker wired like production, except GitHub points at the fake. */
  function makeBroker(opts?: { withHost?: boolean; autoDecide?: 'approve' | 'deny' }) {
    const withHost = opts?.withHost ?? true;
    return new SecretsBroker({
      store,
      getCredential: () => FAKE_TOKEN,
      baseUrls: { github: baseUrl },
      allowedHosts: ['127.0.0.1'],
      onJournal: (e) => journalFanout.push(e),
      approvalHost: withHost
        ? {
            requestGrant: async (input) => {
              const card = store.requestGrant(input);
              if (opts?.autoDecide) store.decide(card.id, opts.autoDecide);
              return store.awaitOutcome(card.id, 5_000);
            },
          }
        : undefined,
    });
  }

  const issueArgs = { owner: 'octocat', repo: 'hello-world', title: 'Broker test issue', body: 'opened by the broker' };

  function expectTokenNowhere(...surfaces: unknown[]): void {
    for (const surface of surfaces) {
      const text = typeof surface === 'string' ? surface : JSON.stringify(surface);
      expect(text).not.toContain(FAKE_TOKEN);
      expect(text).not.toContain('ghp_FAKE');
    }
  }

  it('executes create_issue with the app-held token; token appears NOWHERE in result/journal/audit', async () => {
    store.addStandingGrant({ identity: 'github', actionClass: 'write' });
    const broker = makeBroker();
    const out = await broker.execute({
      botId: 'scout',
      sessionId: 'sess-1',
      identity: 'github',
      action: 'github.create_issue',
      args: issueArgs,
    });
    expect(out.ok).toBe(true);
    expect(out.result).toMatchObject({ number: 42, state: 'open' });
    // The fake server saw exactly one call, carrying the app-held token.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.url).toBe('/repos/octocat/hello-world/issues');
    expect(seen[0]!.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(JSON.parse(seen[0]!.body)).toMatchObject({ title: 'Broker test issue' });
    // Grep assertion: token in NO output surface.
    const journal = store.listJournal();
    expectTokenNowhere(out, journal, journalFanout);
    const executed = journal.find((j) => j.event === 'action_executed');
    expect(executed).toMatchObject({
      identity: 'github',
      action: 'github.create_issue',
      actionClass: 'write',
      resource: 'octocat/hello-world',
      detail: 'http_201',
    });
    expect(executed!.argsHash).toMatch(/^[a-f0-9]{64}$/);
    // Journal carries ids/hashes, never the issue title/body content.
    expect(JSON.stringify(journal)).not.toContain('Broker test issue');
    expect(JSON.stringify(journal)).not.toContain('opened by the broker');
  });

  it('bot-initiated run through the broker_action tool creates an issue + journal (live-proof shape)', async () => {
    store.addStandingGrant({ identity: 'github', actionClass: 'write', botId: 'scout' });
    const tool = createBrokerTool({ broker: makeBroker() });
    const ctx = { sessionId: 'sess-proof', botId: 'scout' } as ToolContext;
    const out = (await tool.handler(
      { identity: 'github', action: 'github.create_issue', args: issueArgs },
      ctx,
    )) as { ok: boolean; result?: { number: number } };
    expect(out.ok).toBe(true);
    expect(out.result?.number).toBe(42);
    expect(seen).toHaveLength(1);
    expect(store.listJournal().some((j) => j.event === 'action_executed')).toBe(true);
    expectTokenNowhere(out, store.listJournal());
  });

  it('ungranted request raises an approval card and makes NO call until approved; approval covers the rest of the run only', async () => {
    const broker = makeBroker(); // host mints a card; nobody decides yet
    const tool = createBrokerTool({ broker });
    const ctx = { sessionId: 'sess-2', botId: 'scout' } as ToolContext;
    const pending = tool.handler(
      { identity: 'github', action: 'github.create_issue', args: issueArgs },
      ctx,
    );
    // Card raised, still no HTTP call.
    await new Promise((r) => setTimeout(r, 25));
    expect(store.listRequests('pending')).toHaveLength(1);
    expect(seen).toHaveLength(0);
    const card = store.listRequests('pending')[0]!;
    expect(card).toMatchObject({ identity: 'github', actionClass: 'write', botId: 'scout' });
    store.decide(card.id, 'approve');
    const out = (await pending) as { ok: boolean };
    expect(out.ok).toBe(true);
    expect(seen).toHaveLength(1);
    // Approving the card created NO standing grant — run grant only.
    expect(store.listStandingGrants()).toHaveLength(0);
    expect(store.hasRunGrant('scout', 'sess-2', 'github', 'write')).toBe(true);
    expect(store.hasRunGrant('scout', 'other-session', 'github', 'write')).toBe(false);
    // Second call in the same run: no new card.
    const out2 = (await tool.handler(
      { identity: 'github', action: 'github.create_issue', args: issueArgs },
      ctx,
    )) as { ok: boolean };
    expect(out2.ok).toBe(true);
    expect(store.listRequests()).toHaveLength(1);
    const events = store.listJournal().map((j) => j.event);
    expect(events).toContain('grant_requested');
    expect(events).toContain('grant_approved');
  });

  it('denied grant → no call, refusal result, journal shows grant_denied', async () => {
    const broker = makeBroker({ autoDecide: 'deny' });
    const tool = createBrokerTool({ broker });
    const out = (await tool.handler(
      { identity: 'github', action: 'github.create_issue', args: issueArgs },
      { sessionId: 'sess-3', botId: 'scout' } as ToolContext,
    )) as { ok: boolean; code?: string; error?: string };
    expect(out.ok).toBe(false);
    expect(out.code).toBe('grant_denied');
    expect(seen).toHaveLength(0);
    expect(store.listJournal().some((j) => j.event === 'grant_denied')).toBe(true);
    expectTokenNowhere(out, store.listJournal());
  });

  it('no approval host attached → ungranted request refuses, no call', async () => {
    const broker = makeBroker({ withHost: false });
    await expect(
      broker.execute({ botId: 'scout', sessionId: 's', identity: 'github', action: 'github.list_repos', args: {} }),
    ).rejects.toMatchObject({ code: 'grant_required' });
    expect(seen).toHaveLength(0);
  });

  it('run-grant expiry fails closed (next call needs a fresh grant)', async () => {
    const broker = makeBroker({ autoDecide: 'approve' });
    const input = { botId: 'scout', sessionId: 'sess-x', identity: 'github', action: 'github.list_repos', args: {} };
    await broker.execute(input);
    expect(store.hasRunGrant('scout', 'sess-x', 'github', 'read')).toBe(true);
    // Time-travel past the run-grant TTL: the stored grant is dead.
    expect(store.hasRunGrant('scout', 'sess-x', 'github', 'read', Date.now() + 2 * 60 * 60 * 1000)).toBe(false);
    expect(store.hasRunGrant('scout', 'sess-x', 'github', 'read')).toBe(false); // swept by the check above
    // A fresh execution must go through the card flow again (2nd card).
    const cardsBefore = store.listRequests().length;
    await broker.execute(input);
    expect(store.listRequests().length).toBe(cardsBefore + 1);
  });

  it('request cards expire fail-closed: waiter resolves denied, no call', async () => {
    const card = store.requestGrant({
      botId: 'scout',
      sessionId: 's',
      identity: 'github',
      actionClass: 'read',
      action: 'github.list_repos',
    });
    const outcome = store.awaitOutcome(card.id, 60_000);
    expect(store.expireStale(Date.now() + 16 * 60 * 1000)).toContain(card.id);
    await expect(outcome).resolves.toBe(false);
    expect(store.getRequest(card.id)?.status).toBe('expired');
  });

  it('host allowlist: construction refuses a base whose host is not allowlisted', () => {
    expect(
      () =>
        new SecretsBroker({
          store,
          getCredential: () => FAKE_TOKEN,
          baseUrls: { github: 'https://evil.example.com' },
          allowedHosts: ['api.github.com'],
        }),
    ).toThrow(/allowlist/);
    expect(
      () =>
        new SecretsBroker({
          store,
          getCredential: () => FAKE_TOKEN,
          baseUrls: { github: 'https://api.github.com.evil.com' },
        }),
    ).toThrow(/allowlist/);
  });

  it('steering arguments are rejected before any call (url/host/token keys, traversal repo)', async () => {
    store.addStandingGrant({ identity: 'github', actionClass: 'read' });
    store.addStandingGrant({ identity: 'github', actionClass: 'write' });
    const broker = makeBroker();
    const base = { botId: 'scout', sessionId: 's', identity: 'github' };
    await expect(
      broker.execute({ ...base, action: 'github.get_repo', args: { owner: 'octocat', repo: 'hello-world', url: 'https://evil.example.com/x' } }),
    ).rejects.toMatchObject({ code: 'steering_rejected' });
    await expect(
      broker.execute({ ...base, action: 'github.get_repo', args: { owner: 'octocat', repo: '../../etc' } }),
    ).rejects.toMatchObject({ code: 'invalid_args' });
    await expect(
      broker.execute({ ...base, action: 'github.get_repo', args: { owner: 'octo/cat', repo: 'hello-world' } }),
    ).rejects.toMatchObject({ code: 'invalid_args' });
    await expect(
      broker.execute({ ...base, action: 'github.create_issue', args: { ...issueArgs, token: FAKE_TOKEN } }),
    ).rejects.toMatchObject({ code: 'steering_rejected' });
    expect(seen).toHaveLength(0);
    expectTokenNowhere(store.listJournal());
  });

  it('upstream error text is scrubbed even when the API echoes the credential', async () => {
    echoTokenInError = true;
    store.addStandingGrant({ identity: 'github', actionClass: 'write' });
    const broker = makeBroker();
    let caught: unknown;
    try {
      await broker.execute({ botId: 'scout', sessionId: 's', identity: 'github', action: 'github.create_issue', args: issueArgs });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expectTokenNowhere((caught as Error).message, store.listJournal(), journalFanout);
    expect((caught as Error).message).toContain('HTTP 422');
    expect((caught as Error).message).toContain('[redacted]');
  });

  it('missing credential refuses with credential_not_connected and no call', async () => {
    const broker = new SecretsBroker({
      store,
      getCredential: () => undefined,
      baseUrls: { github: baseUrl },
      allowedHosts: ['127.0.0.1'],
    });
    await expect(
      broker.execute({ botId: 'scout', sessionId: 's', identity: 'github', action: 'github.list_repos', args: {} }),
    ).rejects.toMatchObject({ code: 'credential_not_connected' });
    expect(seen).toHaveLength(0);
  });

  it('read actions work under a read standing grant; write still needs its own grant', async () => {
    store.addStandingGrant({ identity: 'github', actionClass: 'read' });
    const broker = makeBroker({ withHost: false });
    const out = await broker.execute({ botId: 'anyone', sessionId: 's', identity: 'github', action: 'github.list_repos', args: {} });
    expect(out.ok).toBe(true);
    expect(out.result).toEqual([{ full_name: 'octocat/hello-world', private: false, default_branch: 'main' }]);
    await expect(
      broker.execute({ botId: 'anyone', sessionId: 's', identity: 'github', action: 'github.create_issue', args: issueArgs }),
    ).rejects.toMatchObject({ code: 'grant_required' });
  });
});

describe('BrokerStore standing grants', () => {
  let dir: string;
  let store: BrokerStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'broker-store-'));
    store = new BrokerStore(dir);
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('CRUD + idempotent add per (identity, class, scope)', () => {
    const g1 = store.addStandingGrant({ identity: 'github', actionClass: 'read' });
    expect(g1.scope).toBe('all');
    expect(g1.createdVia).toBe('settings');
    const g2 = store.addStandingGrant({ identity: 'github', actionClass: 'read' });
    expect(g2.id).toBe(g1.id);
    expect(store.listStandingGrants()).toHaveLength(1);
    expect(store.revokeStandingGrant(g1.id)?.id).toBe(g1.id);
    expect(store.listStandingGrants()).toHaveLength(0);
    expect(store.revokeStandingGrant(g1.id)).toBeNull();
  });

  it('scopes: all-bots vs one bot; revoke is effective on the very next check', () => {
    store.addStandingGrant({ identity: 'github', actionClass: 'read' }); // all
    const write = store.addStandingGrant({ identity: 'github', actionClass: 'write', botId: 'coder' });
    expect(store.hasStandingGrant('scout', 'github', 'read')).toBe(true);
    expect(store.hasStandingGrant('scout', 'github', 'write')).toBe(false);
    expect(store.hasStandingGrant('coder', 'github', 'write')).toBe(true);
    store.revokeStandingGrant(write.id);
    expect(store.hasStandingGrant('coder', 'github', 'write')).toBe(false);
  });
});
