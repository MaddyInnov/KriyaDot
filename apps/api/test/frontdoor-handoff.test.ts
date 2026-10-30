// SPDX-License-Identifier: Apache-2.0
// Front-door handoff exchange + link flow (Part 3). Tokens are signed with
// a throwaway Ed25519 keypair; the "front door" registry is a tiny local
// stub server. No external network.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import {
  HANDOFF_PAGE_HTML,
  createFrontdoorRouter,
  handoffPageHandler,
  signHandoffToken,
  writeFrontdoorLink,
  type HandoffPayload,
} from '../src/handoff.js';
import { SessionTokenStore } from '../src/auth-sso.js';

const OWNER = 'owner-token-abc';

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    pub: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    priv: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

const KP = keypair();
const OTHER = keypair();

function payload(overrides: Partial<HandoffPayload> = {}): HandoffPayload {
  const now = Date.now();
  return {
    v: 1,
    iss: 'kriyadot-frontdoor',
    accountId: 'acc-1',
    email: 'owner@example.com',
    name: 'Owner',
    instanceUrl: 'https://instance.example',
    nonce: `nonce-${Math.random().toString(36).slice(2)}`,
    iat: now,
    exp: now + 60_000,
    ...overrides,
  };
}

async function listen(app: express.Express) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.on('listening', r));
  const addr = server.address();
  return { server, base: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}` };
}

describe('handoff exchange', () => {
  let dir: string;
  let sessions: SessionTokenStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-'));
    sessions = new SessionTokenStore(dir);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function app(opts?: { unconfigured?: boolean }) {
    const a = express();
    a.use(express.json());
    a.use(
      '/api',
      createFrontdoorRouter({
        dataDir: dir,
        publicKeyPem: opts?.unconfigured ? undefined : KP.pub,
        sessions,
        loopbackToken: OWNER,
      }),
    );
    a.get('/handoff', handoffPageHandler);
    return a;
  }

  async function exchange(base: string, token: string) {
    const res = await fetch(`${base}/api/handoff/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    return { status: res.status, json: (await res.json()) as Record<string, never> };
  }

  it('valid exchange mints a resolvable SSO session for the mapped tenancy user', async () => {
    writeFrontdoorLink(dir, { frontdoorUrl: 'https://fd.example', accountId: 'acc-1', workspaceId: 'ws-1' });
    const { server, base } = await listen(app());
    try {
      const { status, json } = await exchange(base, signHandoffToken(payload(), KP.priv));
      expect(status).toBe(200);
      expect(json.user).toMatchObject({ email: 'owner@example.com' });
      const rec = sessions.resolve(json.sessionToken);
      expect(rec).not.toBeNull();
      expect(rec?.userId).toBe(json.user.userId);
      expect(rec?.email).toBe('owner@example.com');
      expect(rec?.provider).toBe('oidc');
    } finally { server.close(); }
  });

  it('bad signature → 401', async () => {
    writeFrontdoorLink(dir, { frontdoorUrl: 'https://fd.example', accountId: 'acc-1', workspaceId: 'ws-1' });
    const { server, base } = await listen(app());
    try {
      const { status } = await exchange(base, signHandoffToken(payload(), OTHER.priv));
      expect(status).toBe(401);
    } finally { server.close(); }
  });

  it('expired token → 401', async () => {
    writeFrontdoorLink(dir, { frontdoorUrl: 'https://fd.example', accountId: 'acc-1', workspaceId: 'ws-1' });
    const { server, base } = await listen(app());
    try {
      const now = Date.now();
      const { status } = await exchange(base, signHandoffToken(payload({ iat: now - 120_000, exp: now - 60_000 }), KP.priv));
      expect(status).toBe(401);
    } finally { server.close(); }
  });

  it('lifetime over 120s → 401', async () => {
    writeFrontdoorLink(dir, { frontdoorUrl: 'https://fd.example', accountId: 'acc-1', workspaceId: 'ws-1' });
    const { server, base } = await listen(app());
    try {
      const now = Date.now();
      const { status } = await exchange(base, signHandoffToken(payload({ iat: now, exp: now + 300_000 }), KP.priv));
      expect(status).toBe(401);
    } finally { server.close(); }
  });

  it('replay of a consumed token → 401', async () => {
    writeFrontdoorLink(dir, { frontdoorUrl: 'https://fd.example', accountId: 'acc-1', workspaceId: 'ws-1' });
    const { server, base } = await listen(app());
    try {
      const token = signHandoffToken(payload(), KP.priv);
      expect((await exchange(base, token)).status).toBe(200);
      expect((await exchange(base, token)).status).toBe(401);
      // Nonce persisted on disk, not just in memory.
      const nonces = JSON.parse(fs.readFileSync(path.join(dir, 'handoff-nonces.json'), 'utf8')) as { nonces: Record<string, number> };
      expect(Object.keys(nonces.nonces).length).toBe(1);
    } finally { server.close(); }
  });

  it('seconds-based token (front-door service convention) verifies + replay is rejected', async () => {
    writeFrontdoorLink(dir, { frontdoorUrl: 'https://fd.example', accountId: 'acc-1', workspaceId: 'ws-1' });
    const { server, base } = await listen(app());
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const token = signHandoffToken(payload({ iat: nowSec, exp: nowSec + 120 }), KP.priv);
      expect((await exchange(base, token)).status).toBe(200);
      // The nonce must be stored with a MILLISECOND expiry, or the replay
      // check (compared against Date.now()) would silently never match.
      expect((await exchange(base, token)).status).toBe(401);
      const expiredSec = signHandoffToken(payload({ iat: nowSec - 300, exp: nowSec - 180 }), KP.priv);
      expect((await exchange(base, expiredSec)).status).toBe(401);
    } finally { server.close(); }
  });

  it('no link record → 409 workspace-not-linked; wrong account → 409', async () => {
    const { server, base } = await listen(app());
    try {
      const noLink = await exchange(base, signHandoffToken(payload(), KP.priv));
      expect(noLink.status).toBe(409);
      expect(noLink.json.error).toBe('workspace-not-linked');
      writeFrontdoorLink(dir, { frontdoorUrl: 'https://fd.example', accountId: 'someone-else', workspaceId: 'ws-9' });
      const wrong = await exchange(base, signHandoffToken(payload(), KP.priv));
      expect(wrong.status).toBe(409);
    } finally { server.close(); }
  });

  it('unconfigured public key → 503 frontdoor-not-configured', async () => {
    const saved = process.env.KRIYADOT_FRONTDOOR_PUBLIC_KEY;
    delete process.env.KRIYADOT_FRONTDOOR_PUBLIC_KEY;
    const { server, base } = await listen(app({ unconfigured: true }));
    try {
      const { status, json } = await exchange(base, signHandoffToken(payload(), KP.priv));
      expect(status).toBe(503);
      expect(json.error).toBe('frontdoor-not-configured');
    } finally {
      server.close();
      if (saved !== undefined) process.env.KRIYADOT_FRONTDOOR_PUBLIC_KEY = saved;
    }
  });

  it('public key can come from <dataDir>/frontdoor-pubkey.pem', async () => {
    fs.writeFileSync(path.join(dir, 'frontdoor-pubkey.pem'), KP.pub);
    writeFrontdoorLink(dir, { frontdoorUrl: 'https://fd.example', accountId: 'acc-1', workspaceId: 'ws-1' });
    const saved = process.env.KRIYADOT_FRONTDOOR_PUBLIC_KEY;
    delete process.env.KRIYADOT_FRONTDOOR_PUBLIC_KEY;
    const a = express();
    a.use(express.json());
    a.use('/api', createFrontdoorRouter({ dataDir: dir, sessions, loopbackToken: OWNER }));
    const { server, base } = await listen(a);
    try {
      expect((await exchange(base, signHandoffToken(payload(), KP.priv))).status).toBe(200);
    } finally {
      server.close();
      if (saved !== undefined) process.env.KRIYADOT_FRONTDOOR_PUBLIC_KEY = saved;
    }
  });

  it('serves the /handoff page that stores the session token and redirects home', async () => {
    const { server, base } = await listen(app());
    try {
      const res = await fetch(`${base}/handoff`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toBe(HANDOFF_PAGE_HTML);
      expect(html).toContain("localStorage.setItem(\"kriyadot:sessionToken\"");
      expect(html).toContain("location.replace('/')");
      expect(html).toContain("location.hash");
      expect(html).toContain('/api/handoff/exchange');
    } finally { server.close(); }
  });
});

describe('frontdoor link flow', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-link-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('link calls the registry, stores frontdoor.json (0600), status reflects it', async () => {
    // Stub front door registry.
    const seen: Array<Record<string, unknown>> = [];
    const fd = express();
    fd.use(express.json());
    fd.post('/api/registry/register', (req, res) => {
      seen.push(req.body as Record<string, unknown>);
      res.json({ ok: true, accountId: 'acc-77', workspaceId: 'ws-77' });
    });
    const fdSrv = await listen(fd);
    const a = express();
    a.use(express.json());
    a.use('/api', createFrontdoorRouter({ dataDir: dir, publicKeyPem: KP.pub, loopbackToken: OWNER, getTier: () => 'free' }));
    const { server, base } = await listen(a);
    try {
      const unauth = await fetch(`${base}/api/frontdoor/link`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ frontdoorUrl: fdSrv.base, code: 'CODE1', instanceUrl: 'https://inst.example' }),
      });
      expect(unauth.status).toBe(401);

      const res = await fetch(`${base}/api/frontdoor/link`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${OWNER}` },
        body: JSON.stringify({ frontdoorUrl: fdSrv.base, code: 'CODE1', instanceUrl: 'https://inst.example' }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, never>;
      expect(json).toMatchObject({ linked: true, accountId: 'acc-77', workspaceId: 'ws-77' });
      expect(seen[0]).toMatchObject({ code: 'CODE1', instanceUrl: 'https://inst.example', tier: 'free' });

      const stored = JSON.parse(fs.readFileSync(path.join(dir, 'frontdoor.json'), 'utf8')) as Record<string, unknown>;
      expect(stored).toMatchObject({ frontdoorUrl: fdSrv.base, accountId: 'acc-77', workspaceId: 'ws-77' });
      expect(fs.statSync(path.join(dir, 'frontdoor.json')).mode & 0o777).toBe(0o600);

      const status = await (await fetch(`${base}/api/frontdoor/status`, { headers: { authorization: `Bearer ${OWNER}` } })).json() as Record<string, never>;
      expect(status).toMatchObject({ linked: true, accountId: 'acc-77', workspaceId: 'ws-77' });
    } finally { server.close(); fdSrv.server.close(); }
  });
});
