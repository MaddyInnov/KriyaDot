// SPDX-License-Identifier: Apache-2.0
// Frontdoor tests: fake OIDC issuer (local http server with a real RSA
// keypair + JWKS) drives the full Google sign-in flow; the link-code
// lifecycle, handoff minting/verification, registry field discipline,
// changelog fallback, and static-serving guards are covered against the
// real HTTP server on an ephemeral port.

import { generateKeyPairSync, randomBytes, sign as cryptoSign } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, request as httpRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { createFrontdoor, type Frontdoor } from '../src/server.js';
import { verifyHandoffToken } from '../src/handoff.js';
import { hashToken } from '../src/store.js';

const closers: Array<() => Promise<void>> = [];

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  closers.push(() => new Promise<void>((r) => server.close(() => r())));
  return `http://127.0.0.1:${addr.port}`;
}

function tempSite(): string {
  const dir = mkdtempSync(join(tmpdir(), 'frontdoor-site-'));
  writeFileSync(join(dir, 'index.html'), '<!DOCTYPE html><title>landing</title><h1>KriyaDot landing</h1>');
  writeFileSync(join(dir, 'styles.css'), 'body { color: rebeccapurple; }');
  return dir;
}

async function startFrontdoor(overrides: Partial<Parameters<typeof createFrontdoor>[0]> = {}): Promise<{ fd: Frontdoor; base: string }> {
  const fd = createFrontdoor({
    stateDir: mkdtempSync(join(tmpdir(), 'frontdoor-state-')),
    siteDir: tempSite(),
    log: () => undefined,
    ...overrides,
  });
  const base = await listen(fd.server);
  return { fd, base };
}

/** Seed an account + session directly through the store; returns the cookie header. */
function seedSession(fd: Frontdoor, sub: string, email: string): string {
  const account = fd.store.upsertAccount({ sub, email, name: `User ${sub}` });
  const token = randomBytes(32).toString('base64url');
  fd.store.createSession(hashToken(token), account.id);
  return `fd_session=${token}`;
}

// ---------------------------------------------------------------------------
// Fake OIDC issuer
// ---------------------------------------------------------------------------

function startFakeIssuer() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  const kid = 'fake-key-1';
  let issuerUrl = '';
  let expectedNonce = '';
  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://issuer.local');
    if (url.pathname === '/.well-known/openid-configuration') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          issuer: issuerUrl,
          authorization_endpoint: `${issuerUrl}/authorize`,
          token_endpoint: `${issuerUrl}/token`,
          jwks_uri: `${issuerUrl}/jwks`,
        }),
      );
      return;
    }
    if (url.pathname === '/jwks') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] }));
      return;
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const now = Math.floor(Date.now() / 1000);
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })).toString('base64url');
      const claims = Buffer.from(
        JSON.stringify({
          iss: issuerUrl,
          sub: 'google-sub-123',
          aud: 'test-client-id',
          email: 'ada@example.com',
          name: 'Ada Test',
          picture: 'https://example.com/ada.png',
          iat: now,
          exp: now + 600,
          nonce: expectedNonce,
        }),
      ).toString('base64url');
      const signature = cryptoSign('sha256', Buffer.from(`${header}.${claims}`), privateKey).toString('base64url');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id_token: `${header}.${claims}.${signature}`, access_token: 'fake', token_type: 'Bearer' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return {
    server,
    setIssuerUrl(u: string) {
      issuerUrl = u;
    },
    setNonce(n: string) {
      expectedNonce = n;
    },
  };
}

// ---------------------------------------------------------------------------

describe('frontdoor service', () => {
  afterAll(async () => {
    for (const close of closers.splice(0)) await close();
  });

  it('serves health and the handoff public key', async () => {
    const { base } = await startFrontdoor();
    const health = await (await fetch(`${base}/api/health`)).json();
    expect(health).toEqual({ ok: true, service: 'kriyadot-frontdoor' });
    const keyRes = await fetch(`${base}/api/handoff/public-key`);
    const keyBody = await keyRes.json();
    expect(keyBody.publicKey).toContain('BEGIN PUBLIC KEY');
    expect(keyBody.ephemeral).toBe(true); // no key configured in tests
  });

  it('rejects unauthenticated API calls with 401', async () => {
    const { base } = await startFrontdoor();
    for (const [method, path] of [
      ['GET', '/api/me'],
      ['GET', '/api/workspaces'],
      ['POST', '/api/link-codes'],
      ['POST', '/api/handoff'],
      ['GET', '/api/lightning'],
      ['GET', '/api/plan'],
      ['GET', '/api/changelog'],
    ] as const) {
      const res = await fetch(`${base}${path}`, { method });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it('returns 503 with an honest page when Google sign-in is not configured', async () => {
    const { base } = await startFrontdoor();
    const res = await fetch(`${base}/auth/google`);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('not configured');
  });

  it('runs the full OIDC sign-in flow against a fake issuer', async () => {
    const fake = startFakeIssuer();
    const issuerUrl = await listen(fake.server);
    fake.setIssuerUrl(issuerUrl);
    const { fd, base } = await startFrontdoor({
      googleClientId: 'test-client-id',
      googleClientSecret: 'test-secret',
      oidcIssuer: issuerUrl,
    });

    const begin = await fetch(`${base}/auth/google`, { redirect: 'manual' });
    expect(begin.status).toBe(302);
    const location = begin.headers.get('location') ?? '';
    expect(location.startsWith(`${issuerUrl}/authorize?`)).toBe(true);
    const authParams = new URL(location).searchParams;
    expect(authParams.get('code_challenge_method')).toBe('S256');
    expect(authParams.get('client_id')).toBe('test-client-id');
    fake.setNonce(authParams.get('nonce') ?? '');

    const callback = await fetch(
      `${base}/auth/google/callback?code=fake-code&state=${encodeURIComponent(authParams.get('state') ?? '')}`,
      { redirect: 'manual' },
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('/app');
    const cookie = callback.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('fd_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');

    const sessionCookie = cookie.split(';')[0]!;
    const me = await (await fetch(`${base}/api/me`, { headers: { cookie: sessionCookie } })).json();
    expect(me.id).toBe('google-sub-123');
    expect(me.email).toBe('ada@example.com');
    expect(me.name).toBe('Ada Test');
    expect(fd.store.getAccount('google-sub-123')?.email).toBe('ada@example.com');

    // A bogus state is rejected.
    const bad = await fetch(`${base}/auth/google/callback?code=x&state=nope`, { redirect: 'manual' });
    expect(bad.status).toBe(400);
  });

  it('link code lifecycle: mint → register → listed; reuse and expiry fail; re-link is idempotent', async () => {
    // Fake user instance with a health endpoint.
    const instance = createHttpServer((req, res) => {
      if (req.url === '/api/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    const instanceUrl = await listen(instance);

    const { fd, base } = await startFrontdoor();
    const cookieA = seedSession(fd, 'sub-a', 'a@example.com');

    const mint = await fetch(`${base}/api/link-codes`, { method: 'POST', headers: { cookie: cookieA } });
    expect(mint.status).toBe(201);
    const { code, expiresAt } = await mint.json();
    expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());

    const register = await fetch(`${base}/api/registry/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, instanceUrl, name: 'Ada WS', tier: 'Free' }),
    });
    expect(register.status).toBe(201);
    const { workspaceId, accountId } = await register.json();
    expect(accountId).toBe('sub-a');
    expect(typeof workspaceId).toBe('string');

    const list = await (await fetch(`${base}/api/workspaces`, { headers: { cookie: cookieA } })).json();
    expect(list.workspaces).toHaveLength(1);
    expect(list.workspaces[0].name).toBe('Ada WS');
    expect(list.workspaces[0].status).toBe('online');

    // Code reuse fails.
    const reuse = await fetch(`${base}/api/registry/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, instanceUrl }),
    });
    expect(reuse.status).toBe(400);
    expect((await reuse.json()).error).toBe('code-used');

    // Unknown code fails.
    const unknown = await fetch(`${base}/api/registry/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'ZZZZZZZZ', instanceUrl }),
    });
    expect(unknown.status).toBe(400);

    // Expired code fails.
    fd.store.addLinkCode({ code: 'EXPIRED9', accountId: 'sub-a', expiresAt: new Date(Date.now() - 1000).toISOString() });
    const expired = await fetch(`${base}/api/registry/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'EXPIRED9', instanceUrl }),
    });
    expect(expired.status).toBe(400);
    expect((await expired.json()).error).toBe('code-expired');

    // Idempotent re-link: fresh code, same instanceUrl → same workspace.
    const mint2 = await (await fetch(`${base}/api/link-codes`, { method: 'POST', headers: { cookie: cookieA } })).json();
    const relink = await fetch(`${base}/api/registry/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: mint2.code, instanceUrl }),
    });
    expect(relink.status).toBe(200);
    expect((await relink.json()).workspaceId).toBe(workspaceId);
    const list2 = await (await fetch(`${base}/api/workspaces`, { headers: { cookie: cookieA } })).json();
    expect(list2.workspaces).toHaveLength(1);
  });

  it('mints handoff tokens that verify with the public key; other accounts are rejected', async () => {
    const { fd, base } = await startFrontdoor();
    const cookieA = seedSession(fd, 'sub-a', 'a@example.com');
    const cookieB = seedSession(fd, 'sub-b', 'b@example.com');
    const workspace = fd.store.addWorkspace({ accountId: 'sub-a', name: 'WS', instanceUrl: 'https://ws.example.com' });

    const mintRes = await fetch(`${base}/api/handoff`, {
      method: 'POST',
      headers: { cookie: cookieA, 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: workspace.id }),
    });
    expect(mintRes.status).toBe(200);
    const { redirectUrl, expiresAt } = await mintRes.json();
    expect(redirectUrl.startsWith('https://ws.example.com/handoff#t=')).toBe(true);
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());

    const token = redirectUrl.split('#t=')[1]!;
    const { publicKey } = await (await fetch(`${base}/api/handoff/public-key`)).json();
    const payload = verifyHandoffToken(token, publicKey);
    expect(payload).not.toBeNull();
    expect(payload?.v).toBe(1);
    expect(payload?.iss).toBe('kriyadot-frontdoor');
    expect(payload?.accountId).toBe('sub-a');
    expect(payload?.email).toBe('a@example.com');
    expect(payload?.instanceUrl).toBe('https://ws.example.com');
    expect(payload!.exp - payload!.iat).toBe(120);
    expect(Buffer.from(payload!.nonce, 'base64url')).toHaveLength(16);

    // Tampering breaks the signature.
    const tampered = `${token.split('.')[0]}x.${token.split('.')[1]}`;
    expect(verifyHandoffToken(tampered, publicKey)).toBeNull();

    // Another account cannot mint for this workspace.
    const foreign = await fetch(`${base}/api/handoff`, {
      method: 'POST',
      headers: { cookie: cookieB, 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: workspace.id }),
    });
    expect(foreign.status).toBe(404);
  });

  it('removes workspaces and reports offline instances', async () => {
    const { fd, base } = await startFrontdoor();
    const cookie = seedSession(fd, 'sub-a', 'a@example.com');
    const workspace = fd.store.addWorkspace({ accountId: 'sub-a', name: 'Dead', instanceUrl: 'http://127.0.0.1:1' });
    const list = await (await fetch(`${base}/api/workspaces`, { headers: { cookie } })).json();
    expect(list.workspaces[0].status).toBe('offline');

    const remove = await fetch(`${base}/api/workspaces/${workspace.id}/remove`, { method: 'POST', headers: { cookie } });
    expect(remove.status).toBe(200);
    const after = await (await fetch(`${base}/api/workspaces`, { headers: { cookie } })).json();
    expect(after.workspaces).toHaveLength(0);
  });

  it('serves plan + lightning payloads with no hard-coded prices', async () => {
    const { fd, base } = await startFrontdoor();
    const cookie = seedSession(fd, 'sub-a', 'a@example.com');
    fd.store.addWorkspace({ accountId: 'sub-a', name: 'WS', instanceUrl: 'https://ws.example.com', tier: 'Pro' });

    const plan = await (await fetch(`${base}/api/plan`, { headers: { cookie } })).json();
    expect(plan.gatingEnabled).toBe(false);
    expect(plan.platform).toContain('Apache-2.0');

    const lightning = await (await fetch(`${base}/api/lightning`, { headers: { cookie } })).json();
    expect(lightning.pricingUrl).toBe('https://lightning.ai/pricing');
    expect(lightning.tiers.map((t: { name: string }) => t.name)).toEqual(['Free', 'Pro', 'Teams', 'Enterprise']);
    expect(JSON.stringify(lightning)).not.toMatch(/\$\d|\d+\s*\/\s*mo/);
    expect(lightning.workspaces).toEqual([{ name: 'WS', tierReportedByInstance: 'Pro' }]);
  });

  it('registry state file stores ONLY allowed fields (no chat content or credentials)', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'frontdoor-state-scan-'));
    const { fd, base } = await startFrontdoor({ stateDir });
    const cookie = seedSession(fd, 'sub-a', 'a@example.com');
    const { code } = await (await fetch(`${base}/api/link-codes`, { method: 'POST', headers: { cookie } })).json();
    await fetch(`${base}/api/registry/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, instanceUrl: 'https://ws.example.com', name: 'WS' }),
    });
    const raw = readFileSync(join(stateDir, 'frontdoor-state.json'), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    const forbidden = new Set(['messages', 'message', 'chat', 'chathistory', 'apikey', 'api_key', 'credentials', 'credential', 'password', 'prompt', 'token', 'content']);
    const keys: string[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
          keys.push(k.toLowerCase());
          walk(v);
        }
      }
    };
    walk(parsed);
    for (const key of keys) expect(forbidden.has(key), `forbidden key persisted: ${key}`).toBe(false);
    // Session tokens are stored only as hashes (cookie value must not appear).
    const sessionToken = cookie.split('=')[1]!;
    expect(raw).not.toContain(sessionToken);
  });

  it('changelog falls back to an empty list when GitHub fetch fails, and maps releases on success', async () => {
    const failing = await startFrontdoor({
      fetchFn: (async () => {
        throw new Error('network down');
      }) as typeof fetch,
    });
    const failCookie = seedSession(failing.fd, 'sub-a', 'a@example.com');
    const fallback = await (await fetch(`${failing.base}/api/changelog`, { headers: { cookie: failCookie } })).json();
    expect(fallback).toEqual({ releases: [] });

    const okFetch = (async (input: unknown) => {
      if (String(input).includes('api.github.com')) {
        return new Response(
          JSON.stringify([
            { tag_name: 'v9.9.9', name: 'Big Release', published_at: '2026-10-01T00:00:00Z', html_url: 'https://example.com/rel', body: 'notes here' },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error('unexpected fetch');
    }) as typeof fetch;
    const ok = await startFrontdoor({ fetchFn: okFetch });
    const okCookie = seedSession(ok.fd, 'sub-a', 'a@example.com');
    const mapped = await (await fetch(`${ok.base}/api/changelog`, { headers: { cookie: okCookie } })).json();
    expect(mapped.releases).toHaveLength(1);
    expect(mapped.releases[0]).toEqual({
      tag: 'v9.9.9',
      name: 'Big Release',
      publishedAt: '2026-10-01T00:00:00Z',
      url: 'https://example.com/rel',
      notesExcerpt: 'notes here',
    });
  });

  it('serves the static site, the app CSS, guards traversal, and gates /app behind a session', async () => {
    const { fd, base } = await startFrontdoor();
    const home = await fetch(`${base}/`);
    expect(home.status).toBe(200);
    expect(await home.text()).toContain('KriyaDot landing');
    expect(home.headers.get('content-type')).toContain('text/html');

    const css = await fetch(`${base}/styles.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');

    const appCss = await fetch(`${base}/frontdoor-assets/app.css`);
    expect(appCss.status).toBe(200);
    expect(await appCss.text()).toContain('fd-card');

    const missing = await fetch(`${base}/no-such-page`);
    expect(missing.status).toBe(404);

    // Raw traversal attempt (encoded dot segments, sent verbatim).
    const port = Number(new URL(base).port);
    const traversalStatus = await new Promise<number>((resolveStatus) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: '/%2e%2e%2f%2e%2e%2fsecret.txt', method: 'GET' }, (res) => {
        res.resume();
        res.on('end', () => resolveStatus(res.statusCode ?? 0));
      });
      req.end();
    });
    expect(traversalStatus).toBe(404);

    const anon = await fetch(`${base}/app`, { redirect: 'manual' });
    expect(anon.status).toBe(302);
    expect(anon.headers.get('location')).toBe('/');

    const cookie = seedSession(fd, 'sub-a', 'a@example.com');
    const app = await fetch(`${base}/app`, { headers: { cookie } });
    expect(app.status).toBe(200);
    expect(await app.text()).toContain('Your front door');
  });
});
