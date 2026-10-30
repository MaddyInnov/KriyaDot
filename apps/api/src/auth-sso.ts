// SPDX-License-Identifier: Apache-2.0
// OIDC single sign-on (authorization-code flow + PKCE) — original code.
//
// Flow: buildAuthorizeUrl() → IdP → handleCallback(code, verifier) exchanges
// the code at the token endpoint, verifies the id_token against the issuer's
// JWKS (RS256 only: kid match, signature via node:crypto JWK import, plus
// iss/aud/exp/nonce checks), maps claims to a tenancy user, and issues a
// local session.
//
// Session integration (honest note): the app's existing auth is a per-boot
// loopback bearer (loopback-auth.ts) — there is no per-user session record
// to reuse. SSO therefore issues a *tenancy-scoped session token* via
// SessionTokenStore below (random 32-byte token, only its SHA-256 hash is
// persisted to <dataDir>/sso-sessions.json, org/user/role claims attached,
// TTL-bound, revocable). Routes accept it as `Authorization: Bearer <token>`
// through resolveSessionToken(); the parent may additionally accept the
// HS256 tenancy JWT from @mvp/tenancy (signTenancyJwt) minted at login.
//
// Config comes from env or admin-supplied config object:
//   KRIYADOT_OIDC_ISSUER, KRIYADOT_OIDC_CLIENT_ID, KRIYADOT_OIDC_CLIENT_SECRET,
//   KRIYADOT_OIDC_REDIRECT_URI, KRIYADOT_OIDC_CREATE_USERS (default "1").

import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify as cryptoVerify } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes?: string[];
  /** Create a tenancy user on first login (default true). */
  createOnFirstLogin?: boolean;
  /** Org new users join when created (optional). */
  defaultOrgId?: string;
}

export function oidcConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OidcConfig | null {
  const issuer = env.KRIYADOT_OIDC_ISSUER;
  const clientId = env.KRIYADOT_OIDC_CLIENT_ID;
  const clientSecret = env.KRIYADOT_OIDC_CLIENT_SECRET;
  const redirectUri = env.KRIYADOT_OIDC_REDIRECT_URI;
  if (!issuer || !clientId || !clientSecret || !redirectUri) return null;
  return {
    issuer: issuer.replace(/\/$/, ''),
    clientId,
    clientSecret,
    redirectUri,
    createOnFirstLogin: env.KRIYADOT_OIDC_CREATE_USERS !== '0',
    defaultOrgId: env.KRIYADOT_OIDC_DEFAULT_ORG || undefined,
  };
}

export type FetchFn = (url: string, init?: Record<string, unknown>) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

const defaultFetch: FetchFn = (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<FetchFn>;

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  [key: string]: unknown;
}

export class OidcClient {
  private discoveryCache: OidcDiscovery | null = null;
  private jwksCache: { keys: Array<Record<string, unknown>> } | null = null;

  constructor(
    readonly config: OidcConfig,
    private readonly fetchFn: FetchFn = defaultFetch,
  ) {}

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

  /** PKCE authorization URL + the verifier/state the caller must persist. */
  async buildAuthorizeUrl(): Promise<{ url: string; codeVerifier: string; state: string; nonce: string }> {
    const discovery = await this.discover();
    const codeVerifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const state = randomBytes(16).toString('base64url');
    const nonce = randomBytes(16).toString('base64url');
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      scope: (this.config.scopes ?? ['openid', 'profile', 'email']).join(' '),
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    return { url: `${discovery.authorization_endpoint}?${params.toString()}`, codeVerifier, state, nonce };
  }

  async exchangeCode(code: string, codeVerifier: string): Promise<{ idToken: string; accessToken?: string }> {
    const discovery = await this.discover();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.config.redirectUri,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      code_verifier: codeVerifier,
    });
    const res = await this.fetchFn(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) throw new Error(`OIDC token exchange failed: HTTP ${res.status}`);
    const json = (await res.json()) as { id_token?: string; access_token?: string };
    if (!json.id_token) throw new Error('OIDC token response has no id_token');
    return { idToken: json.id_token, accessToken: json.access_token };
  }

  async fetchJwks(force = false): Promise<{ keys: Array<Record<string, unknown>> }> {
    if (this.jwksCache && !force) return this.jwksCache;
    const discovery = await this.discover();
    const res = await this.fetchFn(discovery.jwks_uri);
    if (!res.ok) throw new Error(`OIDC JWKS fetch failed: HTTP ${res.status}`);
    this.jwksCache = (await res.json()) as { keys: Array<Record<string, unknown>> };
    return this.jwksCache;
  }

  /**
   * Verify an id_token: RS256 signature against JWKS (kid-matched), then
   * iss / aud / exp / nonce claim checks. Throws on any failure.
   */
  async verifyIdToken(idToken: string, expectedNonce?: string): Promise<Record<string, unknown>> {
    const parts = idToken.split('.');
    if (parts.length !== 3) throw new Error('id_token is not a compact JWS');
    const [headerB64, payloadB64, sigB64] = parts as [string, string, string];
    const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8')) as { alg?: string; kid?: string };
    if (header.alg !== 'RS256') throw new Error(`id_token alg must be RS256, got ${header.alg ?? 'none'}`);
    if (!header.kid) throw new Error('id_token has no kid');
    let jwks = await this.fetchJwks();
    let jwk = jwks.keys.find((k) => k.kid === header.kid);
    if (!jwk) {
      jwks = await this.fetchJwks(true);
      jwk = jwks.keys.find((k) => k.kid === header.kid);
    }
    if (!jwk) throw new Error(`no JWKS key for kid ${header.kid}`);
    const key = createPublicKey({ key: jwk as unknown as import('node:crypto').JsonWebKey, format: 'jwk' });
    const signed = Buffer.from(`${headerB64}.${payloadB64}`, 'ascii');
    const signature = Buffer.from(sigB64, 'base64url');
    if (!cryptoVerify('RSA-SHA256', signed, key, signature)) throw new Error('id_token signature invalid');
    const claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (claims.iss !== this.config.issuer) throw new Error('id_token iss mismatch');
    const aud = claims.aud;
    const audOk = aud === this.config.clientId || (Array.isArray(aud) && aud.includes(this.config.clientId));
    if (!audOk) throw new Error('id_token aud mismatch');
    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) throw new Error('id_token expired');
    if (expectedNonce !== undefined && claims.nonce !== expectedNonce) throw new Error('id_token nonce mismatch');
    return claims;
  }

  /** Full callback: exchange + verify. Returns verified claims. */
  async handleCallback(code: string, codeVerifier: string, expectedNonce?: string): Promise<Record<string, unknown>> {
    const { idToken } = await this.exchangeCode(code, codeVerifier);
    return this.verifyIdToken(idToken, expectedNonce);
  }
}

// ---------------------------------------------------------------------------
// Tenancy-scoped session tokens (see header note on session integration)
// ---------------------------------------------------------------------------

export interface SessionRecord {
  userId: string;
  email: string;
  orgId?: string;
  role?: string;
  provider: 'oidc' | 'ldap';
  createdAt: number;
  expiresAt: number;
}

export class SessionTokenStore {
  private readonly records = new Map<string, SessionRecord>();
  private readonly file?: string;

  constructor(dataDir?: string, private readonly ttlMs = 8 * 60 * 60 * 1000) {
    if (dataDir) {
      this.file = path.join(dataDir, 'sso-sessions.json');
      try {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, SessionRecord>;
        for (const [hash, rec] of Object.entries(parsed)) {
          if (rec.expiresAt > Date.now()) this.records.set(hash, rec);
        }
      } catch {
        // No prior sessions — fine.
      }
    }
  }

  private persist(): void {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.records)), { mode: 0o600 });
    } catch {
      // Best-effort persistence.
    }
  }

  static hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  issue(rec: Omit<SessionRecord, 'createdAt' | 'expiresAt'>): { token: string; record: SessionRecord } {
    const token = randomBytes(32).toString('base64url');
    const record: SessionRecord = { ...rec, createdAt: Date.now(), expiresAt: Date.now() + this.ttlMs };
    this.records.set(SessionTokenStore.hashToken(token), record);
    this.persist();
    return { token, record };
  }

  resolve(token: unknown): SessionRecord | null {
    if (typeof token !== 'string' || !token) return null;
    const hash = SessionTokenStore.hashToken(token);
    const provided = Buffer.from(hash, 'hex');
    for (const [key, rec] of this.records) {
      const candidate = Buffer.from(key, 'hex');
      if (candidate.length === provided.length && timingSafeEqual(candidate, provided)) {
        if (rec.expiresAt <= Date.now()) {
          this.records.delete(key);
          this.persist();
          return null;
        }
        return rec;
      }
    }
    return null;
  }

  revoke(token: string): boolean {
    const existed = this.records.delete(SessionTokenStore.hashToken(token));
    if (existed) this.persist();
    return existed;
  }
}

// ---------------------------------------------------------------------------
// Shared per-data-dir session store (OPEN-1): the SSO router issues tokens
// and the principal resolver (principal.ts) verifies them — both must see
// the SAME in-process instance, because records are loaded from disk only
// at construction. Keyed by resolved data dir.
// ---------------------------------------------------------------------------

const sharedSessionStores = new Map<string, SessionTokenStore>();

export function getSharedSsoSessionStore(dataDir: string): SessionTokenStore {
  const key = path.resolve(dataDir);
  let store = sharedSessionStores.get(key);
  if (!store) {
    store = new SessionTokenStore(dataDir);
    sharedSessionStores.set(key, store);
  }
  return store;
}
