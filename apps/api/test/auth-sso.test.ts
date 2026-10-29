// SPDX-License-Identifier: Apache-2.0
// OIDC SSO tests: stub issuer via injected fetch + a locally generated RSA
// keypair signing REAL JWTs. Zero real network. Covers the full callback
// flow through the router plus the verify failure matrix.

import { generateKeyPairSync, sign as cryptoSign, createPrivateKey } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { OidcClient, SessionTokenStore, type FetchFn } from '../src/auth-sso.js';
import { createAuthSsoRouter } from '../src/auth-sso-routes.js';

const ISSUER = 'https://idp.example.test';
const CLIENT_ID = 'kriyadot-client';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
const JWKS = { keys: [{ ...jwk, kid: 'test-key-1', alg: 'RS256', use: 'sig' }] };

function signJwt(claims: Record<string, unknown>, opts: { kid?: string; key?: ReturnType<typeof createPrivateKey> } = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: opts.kid ?? 'test-key-1' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const sig = cryptoSign('RSA-SHA256', Buffer.from(`${header}.${payload}`), opts.key ?? privateKey).toString('base64url');
  return `${header}.${payload}.${sig}`;
}

function baseClaims(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ISSUER,
    aud: CLIENT_ID,
    sub: 'user-42',
    email: 'alice@example.com',
    name: 'Alice A',
    exp: Math.floor(Date.now() / 1000) + 600,
    iat: Math.floor(Date.now() / 1000),
    ...extra,
  };
}

/** Injected fetch implementing discovery + JWKS for the stub issuer. */
function issuerFetch(idToken: string): FetchFn {
  return async (url, init) => {
    const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks` });
    }
    if (url === `${ISSUER}/jwks`) return json(JWKS);
    if (url === `${ISSUER}/token`) {
      void init;
      return json({ id_token: idToken, access_token: 'at-1' });
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' };
  };
}

function client(idToken: string): OidcClient {
  return new OidcClient(
    { issuer: ISSUER, clientId: CLIENT_ID, clientSecret: 'sekret', redirectUri: 'http://localhost:3000/api/auth/sso/oidc/callback' },
    issuerFetch(idToken),
  );
}

describe('OidcClient.verifyIdToken', () => {
  it('accepts a correctly signed token', async () => {
    const claims = await client(signJwt(baseClaims())).verifyIdToken(signJwt(baseClaims()));
    expect(claims.email).toBe('alice@example.com');
  });

  it('rejects a bad signature (different key)', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const tok = signJwt(baseClaims(), { key: other.privateKey });
    await expect(client(tok).verifyIdToken(tok)).rejects.toThrow(/signature invalid/);
  });

  it('rejects wrong audience', async () => {
    const tok = signJwt(baseClaims({ aud: 'someone-else' }));
    await expect(client(tok).verifyIdToken(tok)).rejects.toThrow(/aud mismatch/);
  });

  it('rejects expired tokens', async () => {
    const tok = signJwt(baseClaims({ exp: Math.floor(Date.now() / 1000) - 10 }));
    await expect(client(tok).verifyIdToken(tok)).rejects.toThrow(/expired/);
  });

  it('rejects wrong issuer and unknown kid and nonce mismatch', async () => {
    const badIss = signJwt(baseClaims({ iss: 'https://evil.test' }));
    await expect(client(badIss).verifyIdToken(badIss)).rejects.toThrow(/iss mismatch/);
    const badKid = signJwt(baseClaims(), { kid: 'nope' });
    await expect(client(badKid).verifyIdToken(badKid)).rejects.toThrow(/no JWKS key/);
    const withNonce = signJwt(baseClaims({ nonce: 'n-1' }));
    await expect(client(withNonce).verifyIdToken(withNonce, 'n-2')).rejects.toThrow(/nonce mismatch/);
  });

  it('buildAuthorizeUrl carries PKCE S256 + state + nonce', async () => {
    const { url, codeVerifier, state, nonce } = await client(signJwt(baseClaims())).buildAuthorizeUrl();
    const u = new URL(url);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('code_challenge')!.length).toBeGreaterThan(20);
    expect(u.searchParams.get('state')).toBe(state);
    expect(u.searchParams.get('nonce')).toBe(nonce);
    expect(codeVerifier.length).toBeGreaterThan(20);
  });
});

describe('SSO router full flow', () => {
  let server: ReturnType<express.application.listen> | undefined;
  afterEach(() => server?.close());

  async function boot(idToken: string): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'sso-test-'));
    const app = express();
    app.use(express.json());
    app.use('/api/auth/sso', createAuthSsoRouter({
      dataDir: dir,
      oidcConfig: { issuer: ISSUER, clientId: CLIENT_ID, clientSecret: 'sekret', redirectUri: 'http://x/cb' },
      ldapConfig: null,
      fetchFn: issuerFetch(idToken),
    }));
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server!.address() as AddressInfo;
    return `http://127.0.0.1:${port}/api/auth/sso`;
  }

  it('authorize → callback issues a tenancy session for the mapped user', async () => {
    // The id_token nonce must match the one buildAuthorizeUrl generated, so
    // generate it through the client flow: first fetch authorize, parse the
    // nonce, then re-boot with a token carrying that nonce is not possible
    // (state lives in the first router). Instead: sign with the nonce from
    // the authorize response by using a mutable holder.
    const holder: { nonce?: string } = {};
    const dir = mkdtempSync(join(tmpdir(), 'sso-test-'));
    const fetchFn: FetchFn = async (url, init) => {
      const base = issuerFetch('placeholder');
      if (url === `${ISSUER}/token`) {
        void init;
        return { ok: true, status: 200, json: async () => ({ id_token: signJwt(baseClaims({ nonce: holder.nonce })) }), text: async () => '' };
      }
      return base(url, init);
    };
    const app = express();
    app.use(express.json());
    app.use('/api/auth/sso', createAuthSsoRouter({
      dataDir: dir,
      oidcConfig: { issuer: ISSUER, clientId: CLIENT_ID, clientSecret: 'sekret', redirectUri: 'http://x/cb' },
      ldapConfig: null,
      fetchFn,
    }));
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server!.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}/api/auth/sso`;
    const authRes = await (await fetch(`${base}/oidc/authorize`)).json() as { ok: boolean; url: string; state: string };
    expect(authRes.ok).toBe(true);
    holder.nonce = new URL(authRes.url).searchParams.get('nonce')!;
    const cb = await (await fetch(`${base}/oidc/callback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'auth-code-1', state: authRes.state }),
    })).json() as { ok: boolean; sessionToken: string; user: { email: string; userId: string } };
    expect(cb.ok).toBe(true);
    expect(cb.user.email).toBe('alice@example.com');
    expect(cb.user.userId).toBe('u-alice-example-com');
    const session = await (await fetch(`${base}/session`, { headers: { Authorization: `Bearer ${cb.sessionToken}` } })).json() as { ok: boolean; session: { userId: string; provider: string } };
    expect(session.ok).toBe(true);
    expect(session.session.provider).toBe('oidc');
    // State is single-use.
    const replay = await fetch(`${base}/oidc/callback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'auth-code-1', state: authRes.state }),
    });
    expect(replay.status).toBe(400);
  });

  it('callback with a bad-signature token is 401', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const bad = signJwt(baseClaims(), { key: other.privateKey });
    const base = await boot(bad);
    const authRes = await (await fetch(`${base}/oidc/authorize`)).json() as { state: string };
    const res = await fetch(`${base}/oidc/callback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'x', state: authRes.state }),
    });
    expect(res.status).toBe(401);
  });
});

describe('SessionTokenStore', () => {
  it('issues, resolves, expires and revokes hashed tokens', () => {
    const store = new SessionTokenStore(undefined, 60_000);
    const { token, record } = store.issue({ userId: 'u-1', email: 'a@b.co', provider: 'ldap' });
    expect(record.userId).toBe('u-1');
    expect(store.resolve(token)?.userId).toBe('u-1');
    expect(store.resolve('garbage')).toBeNull();
    expect(store.revoke(token)).toBe(true);
    expect(store.resolve(token)).toBeNull();
    const short = new SessionTokenStore(undefined, -1);
    const t2 = short.issue({ userId: 'u-2', email: 'c@d.co', provider: 'oidc' });
    expect(short.resolve(t2.token)).toBeNull();
  });
});
