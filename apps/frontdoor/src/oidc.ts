// SPDX-License-Identifier: Apache-2.0
// Google OIDC sign-in client (authorization-code + PKCE), written against
// node:crypto only. id_token verification mirrors the rigor of the instance
// SSO verifier: RS256 only, kid-matched JWKS key imported via JWK, and
// iss / aud / exp / nonce claim checks. The issuer base is overridable
// (FRONTDOOR_OIDC_ISSUER) and the fetch function is injectable so tests can
// run a local fake issuer end to end.

import { createHash, createPublicKey, randomBytes, verify as cryptoVerify } from 'node:crypto';

export type FetchFn = typeof fetch;

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

interface PendingFlow {
  codeVerifier: string;
  nonce: string;
  redirectUri: string;
  createdAt: number;
}

const PENDING_TTL_MS = 10 * 60 * 1000;

export interface OidcClaims {
  sub: string;
  email: string;
  name: string;
  picture?: string;
  [key: string]: unknown;
}

export class OidcClient {
  private discoveryCache: OidcDiscovery | null = null;
  private jwksCache: { keys: Array<Record<string, unknown>> } | null = null;
  private readonly pending = new Map<string, PendingFlow>();

  constructor(
    private readonly config: { issuer: string; clientId: string; clientSecret: string },
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  get issuer(): string {
    return this.config.issuer;
  }

  async discover(force = false): Promise<OidcDiscovery> {
    if (this.discoveryCache && !force) return this.discoveryCache;
    const url = `${this.config.issuer}/.well-known/openid-configuration`;
    const res = await this.fetchFn(url);
    if (!res.ok) throw new Error(`OIDC discovery failed: HTTP ${res.status}`);
    const doc = (await res.json()) as OidcDiscovery;
    if (doc.issuer !== this.config.issuer) throw new Error('OIDC discovery issuer mismatch');
    this.discoveryCache = doc;
    return doc;
  }

  /** Begin a flow: returns the provider authorization URL to redirect to. */
  async buildAuthorizationUrl(redirectUri: string): Promise<{ url: string; state: string }> {
    const discovery = await this.discover();
    const state = randomBytes(16).toString('base64url');
    const nonce = randomBytes(16).toString('base64url');
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    this.pending.set(state, { codeVerifier, nonce, redirectUri, createdAt: Date.now() });
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: redirectUri,
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    return { url: `${discovery.authorization_endpoint}?${params.toString()}`, state };
  }

  private takePending(state: string): PendingFlow {
    const flow = this.pending.get(state);
    if (!flow) throw new Error('unknown or already-used sign-in state');
    this.pending.delete(state);
    if (Date.now() - flow.createdAt > PENDING_TTL_MS) throw new Error('sign-in flow expired');
    return flow;
  }

  private async fetchJwks(force = false): Promise<{ keys: Array<Record<string, unknown>> }> {
    if (this.jwksCache && !force) return this.jwksCache;
    const discovery = await this.discover();
    const res = await this.fetchFn(discovery.jwks_uri);
    if (!res.ok) throw new Error(`OIDC JWKS fetch failed: HTTP ${res.status}`);
    this.jwksCache = (await res.json()) as { keys: Array<Record<string, unknown>> };
    return this.jwksCache;
  }

  /** Verify an id_token: RS256 signature against JWKS (kid match), then claims. */
  async verifyIdToken(idToken: string, expectedNonce?: string): Promise<OidcClaims> {
    const parts = idToken.split('.');
    if (parts.length !== 3) throw new Error('id_token is not a JWT');
    const [headerSeg, payloadSeg, signatureSeg] = parts as [string, string, string];
    const header = JSON.parse(Buffer.from(headerSeg, 'base64url').toString('utf8')) as { alg?: string; kid?: string };
    if (header.alg !== 'RS256') throw new Error(`id_token alg must be RS256, got ${header.alg ?? 'none'}`);
    let jwks = await this.fetchJwks();
    let jwk = jwks.keys.find((k) => k.kid === header.kid);
    if (!jwk) {
      jwks = await this.fetchJwks(true);
      jwk = jwks.keys.find((k) => k.kid === header.kid);
    }
    if (!jwk) throw new Error(`no JWKS key for kid ${header.kid ?? 'none'}`);
    const key = createPublicKey({ key: jwk as unknown as import('node:crypto').JsonWebKey, format: 'jwk' });
    const signingInput = Buffer.from(`${headerSeg}.${payloadSeg}`, 'utf8');
    const signature = Buffer.from(signatureSeg, 'base64url');
    if (!cryptoVerify('RSA-SHA256', signingInput, key, signature)) throw new Error('id_token signature invalid');
    const claims = JSON.parse(Buffer.from(payloadSeg, 'base64url').toString('utf8')) as OidcClaims;
    const discovery = await this.discover();
    if (claims.iss !== discovery.issuer) throw new Error('id_token issuer mismatch');
    const audiences = Array.isArray(claims.aud) ? (claims.aud as string[]) : [claims.aud as string];
    if (!audiences.includes(this.config.clientId)) throw new Error('id_token audience mismatch');
    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== 'number' || claims.exp <= now) throw new Error('id_token expired');
    if (expectedNonce !== undefined && claims.nonce !== expectedNonce) throw new Error('id_token nonce mismatch');
    if (typeof claims.sub !== 'string' || !claims.sub) throw new Error('id_token has no sub');
    return claims;
  }

  /** Full callback: look up the pending flow, exchange the code, verify the id_token. */
  async handleCallback(code: string, state: string): Promise<OidcClaims> {
    const flow = this.takePending(state);
    const discovery = await this.discover();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: flow.redirectUri,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      code_verifier: flow.codeVerifier,
    });
    const res = await this.fetchFn(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) throw new Error(`OIDC token exchange failed: HTTP ${res.status}`);
    const tokens = (await res.json()) as { id_token?: string };
    if (!tokens.id_token) throw new Error('token response has no id_token');
    return this.verifyIdToken(tokens.id_token, flow.nonce);
  }
}
