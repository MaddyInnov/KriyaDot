// SPDX-License-Identifier: Apache-2.0
// Integration tests for federation-routes.ts: TWO federation instances over
// real HTTP on ephemeral ports — invite/accept handshake, signed expert
// listing, a peer chat round-trip executed on the HOME instance, tunnel
// policy denial, bad-signature rejection, pause refusal, and unlink.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FederationService, type BotConfig } from '@mvp/agent-runtime/dist/federation.js';
import { createFederationRouter } from '../src/federation-routes.js';

function bot(id: string): BotConfig {
  return {
    id,
    name: `Bot ${id}`,
    description: `desc ${id}`,
    systemPrompt: 'p',
    provider: 'mock',
    model: 'm',
    skills: [],
    tools: [],
    mcpServers: [],
  };
}

interface Instance {
  base: string;
  service: FederationService;
  audits: string[];
  turns: Array<{ botId: string; message: string; sessionId: string; peerId: string }>;
  close: () => Promise<void>;
}

let dirA: string;
let dirB: string;
let A: Instance;
let B: Instance;
let bPaused = false;

async function makeInstance(
  dir: string,
  name: string,
  bots: BotConfig[],
  opts: { globalJsonFirst?: boolean; isPaused?: () => boolean } = {},
): Promise<Instance> {
  const service = new FederationService({ storePath: join(dir, 'federation.json'), name });
  const audits: string[] = [];
  const turns: Instance['turns'] = [];
  const app = express();
  // Instance B simulates the production host: a global express.json() runs
  // BEFORE the router, so the router must verify signatures via its
  // re-serialisation fallback (see rawBodyOf in federation-routes.ts).
  if (opts.globalJsonFirst) app.use(express.json({ limit: '5mb' }));
  app.use(
    '/api/federation',
    createFederationRouter({
      service,
      getBots: () => bots,
      executePeerTurn: async ({ bot: b, message, sessionId, peerId }) => {
        turns.push({ botId: b.id, message, sessionId, peerId });
        return { text: `${name}/${b.id} echo: ${message}`, deniedTools: [] };
      },
      audit: (action) => {
        audits.push(action);
      },
      ...(opts.isPaused ? { isPaused: opts.isPaused } : {}),
    }),
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}/api/federation`;
  service.setPublicUrl(base);
  return {
    base,
    service,
    audits,
    turns,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function api(inst: Instance, path: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${inst.base}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

/** Link B to A: A creates an invite, B accepts (B exposes 'helper' to A). */
async function link(): Promise<{ aId: string; bId: string }> {
  const inv = await api(A, '/invites', {
    method: 'POST',
    body: JSON.stringify({ policyForPeer: { exposedBotIds: ['a-bot'] } }),
  });
  expect(inv.status).toBe(200);
  const acc = await api(B, '/accept', {
    method: 'POST',
    body: JSON.stringify({ payload: inv.body.payload, policy: { exposedBotIds: ['helper'] } }),
  });
  expect(acc.status).toBe(200);
  expect((acc.body.peer as { status: string }).status).toBe('active');
  return { aId: A.service.identity().instanceId, bId: B.service.identity().instanceId };
}

beforeEach(async () => {
  dirA = mkdtempSync(join(tmpdir(), 'fed-a-'));
  dirB = mkdtempSync(join(tmpdir(), 'fed-b-'));
  bPaused = false;
  A = await makeInstance(dirA, 'A', [bot('a-bot')]);
  B = await makeInstance(dirB, 'B', [bot('helper'), bot('secret')], {
    globalJsonFirst: true,
    isPaused: () => bPaused,
  });
});

afterEach(async () => {
  await A.close();
  await B.close();
  rmSync(dirA, { recursive: true, force: true });
  rmSync(dirB, { recursive: true, force: true });
});

describe('federation handshake', () => {
  it('identity endpoints expose distinct Ed25519 identities', async () => {
    const ia = await api(A, '/identity');
    const ib = await api(B, '/identity');
    expect(ia.body.identity).toMatchObject({ name: 'A' });
    expect((ia.body.identity as { instanceId: string }).instanceId).not.toBe(
      (ib.body.identity as { instanceId: string }).instanceId,
    );
  });

  it('accept is audit-logged and both sides end linked', async () => {
    const { aId, bId } = await link();
    expect(B.audits).toContain('federation.accept');
    expect(B.audits).toContain('federation.linked');
    expect(A.audits).toContain('federation.linked');
    const peersA = await api(A, '/peers');
    const peersB = await api(B, '/peers');
    expect(peersA.body.peers).toMatchObject([{ peerId: bId, status: 'active', policy: { exposedBotIds: ['a-bot'] } }]);
    expect(peersB.body.peers).toMatchObject([{ peerId: aId, status: 'active', policy: { exposedBotIds: ['helper'] } }]);
  });

  it('an invite cannot be accepted twice (code is single-use)', async () => {
    const inv = await api(A, '/invites', { method: 'POST', body: JSON.stringify({}) });
    const payload = inv.body.payload as string;
    const first = await api(B, '/accept', { method: 'POST', body: JSON.stringify({ payload, policy: { exposedBotIds: ['helper'] } }) });
    expect(first.status).toBe(200);
    // Second accept: B re-records the peer, but A's handshake refuses the
    // already-used code → 502 handshake_refused.
    const second = await api(B, '/accept', { method: 'POST', body: JSON.stringify({ payload }) });
    expect(second.status).toBe(502);
    expect(second.body.code).toBe('handshake_refused');
  });
});

describe('signed expert listing + peer chat (home-executed)', () => {
  it('lists only the exposed experts over a signed request', async () => {
    const { bId } = await link();
    const r = await api(A, `/peers/${bId}/experts`);
    expect(r.status).toBe(200);
    expect(r.body.experts).toEqual([{ id: 'helper', name: 'Bot helper', description: 'desc helper' }]);
  });

  it('runs the turn on the home instance and stores only a stub locally', async () => {
    const { aId, bId } = await link();
    const r = await api(A, `/peers/${bId}/experts/helper/chat`, {
      method: 'POST',
      body: JSON.stringify({ message: 'hello peer' }),
    });
    expect(r.status).toBe(200);
    expect(r.body.text).toBe('B/helper echo: hello peer');
    // Executed on B (home), attributed to peer A, in a federation session.
    expect(B.turns).toHaveLength(1);
    expect(B.turns[0]).toMatchObject({ botId: 'helper', message: 'hello peer', peerId: aId });
    expect(B.turns[0]!.sessionId).toContain('fed_');
    // A stores ONLY a reference stub — no transcript fields.
    const stub = r.body.stub as Record<string, unknown>;
    expect(stub).toMatchObject({ peerId: bId, botId: 'helper', turnCount: 1 });
    expect(stub.remoteSessionId).toBe(B.turns[0]!.sessionId);
    expect(Object.keys(stub).sort()).toEqual(['botId', 'createdAt', 'peerId', 'remoteSessionId', 'turnCount', 'updatedAt']);
    // Second turn continues the same home session.
    const r2 = await api(A, `/peers/${bId}/experts/helper/chat`, {
      method: 'POST',
      body: JSON.stringify({ message: 'again' }),
    });
    expect((r2.body.stub as { remoteSessionId: string }).remoteSessionId).toBe(stub.remoteSessionId);
    expect((r2.body.stub as { turnCount: number }).turnCount).toBe(2);
    expect(B.turns).toHaveLength(2);
  });

  it('policy denial: an unexposed bot returns 403 and never executes', async () => {
    const { bId } = await link();
    const r = await api(A, `/peers/${bId}/experts/secret/chat`, {
      method: 'POST',
      body: JSON.stringify({ message: 'let me in' }),
    });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('bot_not_exposed');
    expect(B.turns).toHaveLength(0);
    expect(B.audits).toContain('federation.inbound_denied');
  });

  it('global pause on the home instance refuses peer turns with 503', async () => {
    const { bId } = await link();
    bPaused = true;
    const r = await api(A, `/peers/${bId}/experts/helper/chat`, {
      method: 'POST',
      body: JSON.stringify({ message: 'while paused' }),
    });
    expect(r.status).toBe(503);
    expect(B.turns).toHaveLength(0);
  });
});

describe('signature enforcement + unlink', () => {
  it('bad signature → 401, and a replayed request → 401', async () => {
    const { aId } = await link();
    // Forged signature against B's inbound experts endpoint.
    const headers = A.service.signRequestHeaders('GET', '/api/federation/inbound/experts', '');
    const forged = await fetch(`${B.base}/inbound/experts`, {
      headers: { ...headers, 'x-kriyadot-fed-sig': 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==' },
    });
    expect(forged.status).toBe(401);
    // A genuine signed request succeeds once…
    const genuine = await fetch(`${B.base}/inbound/experts`, { headers });
    expect(genuine.status).toBe(200);
    // …and its exact replay is rejected.
    const replay = await fetch(`${B.base}/inbound/experts`, { headers });
    expect(replay.status).toBe(401);
    expect(aId).toBe(A.service.identity().instanceId);
  });

  it('unlink stops access in both directions', async () => {
    const { aId, bId } = await link();
    // A unlinks B: A's own proxied routes now 404.
    const del = await api(A, `/peers/${bId}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    const experts = await api(A, `/peers/${bId}/experts`);
    expect(experts.status).toBe(404);
    // B unlinks A: A's still-signed direct requests are refused 401 by B
    // (B no longer holds A's key), even though A kept its peer record.
    await api(B, `/peers/${aId}`, { method: 'DELETE' });
    const headers = A.service.signRequestHeaders('GET', '/api/federation/inbound/experts', '');
    const direct = await fetch(`${B.base}/inbound/experts`, { headers });
    expect(direct.status).toBe(401);
  });

  it('policy updates take effect on the receiving side', async () => {
    const { aId, bId } = await link();
    // B stops exposing 'helper' to A.
    const upd = await api(B, `/peers/${aId}/policy`, {
      method: 'PUT',
      body: JSON.stringify({ exposedBotIds: [] }),
    });
    expect(upd.status).toBe(200);
    const r = await api(A, `/peers/${bId}/experts`);
    expect(r.body.experts).toEqual([]);
    const chat = await api(A, `/peers/${bId}/experts/helper/chat`, {
      method: 'POST',
      body: JSON.stringify({ message: 'still there?' }),
    });
    expect(chat.status).toBe(403);
  });
});
