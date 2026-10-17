// SPDX-License-Identifier: Apache-2.0
// Generic OAuth2 connected-app framework (Phase 3, Workstream B).
//
// Connects user-owned accounts (Google: Gmail + Calendar read, more providers
// later) so bots can read data on the user's behalf. Client ids and secrets
// are NEVER hardcoded: they come from env vars (real env first) or from the
// encrypted local store (saveProviderKey into the same AES-256-GCM
// providers.local.json file, mode 0600 — see providers.ts). Access/refresh
// tokens are persisted the same way, never in plaintext, and never returned
// by any endpoint or logged.
//
// OAuth tokens are stored as a JSON blob under a synthesized custom provider
// id ("custom-oauth-<provider>") so they ride on the exact same encrypted
// file, machine key, 0600 perms, and env-bridging as provider API keys.
// Real env vars always win over the stored blob.

import express from 'express';
import { randomUUID } from 'node:crypto';
import type { GovernanceGateway } from '@mvp/governance';
import type { AppConfig } from './config.js';
import { removeProviderKey, saveProviderKey, syncProviderKeysToEnv } from './providers.js';

export interface OAuthProviderConfig {
  /** Registry key, e.g. 'google'. */
  id: string;
  /** Human-readable name shown in the UI. */
  name: string;
  /** Authorization endpoint (user's browser is redirected here). */
  authUrl: string;
  /** Token endpoint (server-side code exchange + refresh). */
  tokenUrl: string;
  /** Scopes requested at consent time. */
  scopes: string[];
  /** Env var holding the OAuth client id (e.g. GOOGLE_OAUTH_CLIENT_ID). */
  clientIdEnv: string;
  /** Env var holding the OAuth client secret (e.g. GOOGLE_OAUTH_CLIENT_SECRET). */
  clientSecretEnv: string;
}

/** Token set as returned by the provider's token endpoint. */
export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms at which accessToken expires. */
  expiresAt: number;
  scope?: string;
  tokenType?: string;
}

export interface OAuthStatus {
  id: string;
  name: string;
  connected: boolean;
  /** Epoch ms — present when connected. */
  expiresAt?: number;
  hasRefreshToken: boolean;
}

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

const registry = new Map<string, OAuthProviderConfig>();

export function registerOAuthProvider(config: OAuthProviderConfig): void {
  registry.set(config.id, config);
}

export function getOAuthProvider(id: string): OAuthProviderConfig | undefined {
  return registry.get(id);
}

export function listOAuthProviders(): OAuthProviderConfig[] {
  return [...registry.values()];
}

// First preset: Google with least-privilege read scopes (Gmail + Calendar).
registerOAuthProvider({
  id: 'google',
  name: 'Google (Gmail + Calendar)',
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  scopes: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/calendar.readonly'],
  clientIdEnv: 'GOOGLE_OAUTH_CLIENT_ID',
  clientSecretEnv: 'GOOGLE_OAUTH_CLIENT_SECRET',
});

// ---------------------------------------------------------------------------
// Token storage — through the existing encrypted credential store.
// ---------------------------------------------------------------------------

/** Synthesized custom provider id so tokens live in providers.local.json. */
function storeProviderId(providerId: string): string {
  return `custom-oauth-${providerId}`;
}

/** Env var under which the token blob is mirrored (via saveProviderKey). */
function tokenEnvKey(providerId: string): string {
  return `CUSTOM_OAUTH_${providerId.toUpperCase().replace(/-/g, '_')}_API_KEY`;
}

function cacheKey(dataDir: string, providerId: string): string {
  return `${dataDir}::${providerId}`;
}

function persistTokens(dataDir: string, providerId: string, tokens: OAuthTokens): void {
  tokenCache.set(cacheKey(dataDir, providerId), tokens);
  saveProviderKey(dataDir, storeProviderId(providerId), { apiKey: JSON.stringify(tokens) });
}

/**
 * In-process token cache. The encrypted store's env-bridging
 * (syncProviderKeysToEnv) never overwrites an env var it already injected —
 * correct for real user env vars, but it means a refreshed token blob would
 * go stale for this process. The cache carries in-process updates; a fresh
 * process (cold start) falls through to the encrypted file.
 */
const tokenCache = new Map<string, OAuthTokens>();

function loadTokens(dataDir: string, providerId: string): OAuthTokens | undefined {
  const cached = tokenCache.get(cacheKey(dataDir, providerId));
  if (cached) return cached;
  syncProviderKeysToEnv(dataDir);
  const raw = process.env[tokenEnvKey(providerId)];
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<OAuthTokens>;
    if (typeof parsed.accessToken !== 'string' || typeof parsed.expiresAt !== 'number') return undefined;
    return parsed as OAuthTokens;
  } catch {
    return undefined;
  }
}

export function getOAuthStatus(dataDir: string): OAuthStatus[] {
  return listOAuthProviders().map((p) => {
    const tokens = loadTokens(dataDir, p.id);
    return {
      id: p.id,
      name: p.name,
      connected: tokens !== undefined,
      expiresAt: tokens?.expiresAt,
      hasRefreshToken: Boolean(tokens?.refreshToken),
    };
  });
}

export function disconnectOAuth(dataDir: string, providerId: string): boolean {
  tokenCache.delete(cacheKey(dataDir, providerId));
  return removeProviderKey(dataDir, storeProviderId(providerId));
}

// ---------------------------------------------------------------------------
// OAuth2 flow
// ---------------------------------------------------------------------------

/**
 * Mirror any stored client id/secret into process.env before reading — the
 * flat encrypted key file can hold them under the raw env var names
 * (e.g. GOOGLE_OAUTH_CLIENT_ID), mirroring provider keys. Real env vars
 * always win.
 */
function requireClientCredentials(
  dataDir: string,
  provider: OAuthProviderConfig,
): { clientId: string; clientSecret: string } {
  syncProviderKeysToEnv(dataDir);
  const clientId = process.env[provider.clientIdEnv];
  const clientSecret = process.env[provider.clientSecretEnv];
  if (!clientId || !clientSecret) {
    throw new Error(
      `OAuth provider "${provider.id}" is missing credentials: ` +
        `set ${provider.clientIdEnv} and ${provider.clientSecretEnv} (env or encrypted store).`,
    );
  }
  return { clientId, clientSecret };
}

export function buildAuthUrl(providerId: string, state: string, redirectUri: string): string {
  const provider = getOAuthProvider(providerId);
  if (!provider) throw new Error(`Unknown OAuth provider "${providerId}"`);
  const clientId = process.env[provider.clientIdEnv];
  if (!clientId) {
    throw new Error(
      `OAuth provider "${providerId}" has no client id: set ${provider.clientIdEnv} (env or encrypted store).`,
    );
  }
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: provider.scopes.join(' '),
    state,
    access_type: 'offline',
    prompt: 'consent',
  });
  return `${provider.authUrl}?${params.toString()}`;
}

async function postTokenForm(tokenUrl: string, fields: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    // Non-JSON error body: surface the status.
  }
  if (!res.ok) {
    const err = typeof body.error_description === 'string' ? body.error_description : body.error;
    throw new Error(`Token request failed (${res.status}): ${err ?? 'unknown error'}`);
  }
  return body;
}

function tokensFromResponse(body: Record<string, unknown>, previous?: OAuthTokens): OAuthTokens {
  const accessToken = body.access_token;
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new Error('Token response did not contain an access_token');
  }
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600;
  // Google omits refresh_token on refresh; keep the previous one.
  const refreshToken =
    typeof body.refresh_token === 'string' ? body.refresh_token : previous?.refreshToken;
  return {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
    scope: typeof body.scope === 'string' ? body.scope : undefined,
    tokenType: typeof body.token_type === 'string' ? body.token_type : undefined,
  };
}

/**
 * Exchange an authorization code for tokens and persist them encrypted.
 * `fetch` is the seam — tests stub it, production hits the real tokenUrl.
 */
export async function handleCallback(
  providerId: string,
  code: string,
  redirectUri: string,
  dataDir: string,
): Promise<OAuthTokens> {
  const provider = getOAuthProvider(providerId);
  if (!provider) throw new Error(`Unknown OAuth provider "${providerId}"`);
  if (!code) throw new Error('Missing authorization code');
  const { clientId, clientSecret } = requireClientCredentials(dataDir, provider);
  const body = await postTokenForm(provider.tokenUrl, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const tokens = tokensFromResponse(body);
  persistTokens(dataDir, providerId, tokens);
  return tokens;
}

/**
 * Refresh an expired access token using the stored refresh token.
 * Returns the refreshed token set.
 */
export async function refreshTokens(providerId: string, dataDir: string): Promise<OAuthTokens> {
  const provider = getOAuthProvider(providerId);
  if (!provider) throw new Error(`Unknown OAuth provider "${providerId}"`);
  const current = loadTokens(dataDir, providerId);
  if (!current) throw new Error(`OAuth provider "${providerId}" is not connected`);
  if (!current.refreshToken) {
    throw new Error(
      `OAuth provider "${providerId}" has no refresh token — reconnect to grant offline access.`,
    );
  }
  const { clientId, clientSecret } = requireClientCredentials(dataDir, provider);
  const body = await postTokenForm(provider.tokenUrl, {
    grant_type: 'refresh_token',
    refresh_token: current.refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const tokens = tokensFromResponse(body, current);
  persistTokens(dataDir, providerId, tokens);
  return tokens;
}

/** Milliseconds of safety margin before expiry to proactively refresh. */
const REFRESH_SKEW_MS = 60_000;

/**
 * Return a usable access token for the provider, refreshing via the stored
 * refresh_token when the current token is expired (or within the skew
 * window). Throws when not connected or refresh fails — callers fail
 * closed rather than sending unauthenticated requests.
 */
export async function getValidToken(providerId: string, dataDir: string): Promise<string> {
  const tokens = loadTokens(dataDir, providerId);
  if (!tokens) throw new Error(`OAuth provider "${providerId}" is not connected`);
  if (tokens.expiresAt - REFRESH_SKEW_MS > Date.now()) return tokens.accessToken;
  const refreshed = await refreshTokens(providerId, dataDir);
  return refreshed.accessToken;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export interface OAuthRouteDeps {
  config: AppConfig;
  governance: GovernanceGateway;
}

/**
 * CSRF states pending callback, mapped to the redirect_uri used at auth
 * time. In-memory (MVP): a restart invalidates in-flight flows, which fail
 * closed at the callback.
 */
const pendingStates = new Map<string, { redirectUri: string; expires: number }>();
const STATE_TTL_MS = 10 * 60 * 1000;
const STATE_SWEEP_INTERVAL_MS = 60_000;

function pruneStates(): void {
  const now = Date.now();
  for (const [k, v] of pendingStates) {
    if (v.expires <= now) pendingStates.delete(k);
  }
}

let stateSweepTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Periodic purge of expired pending OAuth states (L7). Pruning also runs
 * opportunistically on route hits, but abandoned flows with no further
 * traffic would linger without this — mirrors the WS-ticket sweeper in
 * loopback-auth.ts.
 */
function scheduleStateSweep(): void {
  if (stateSweepTimer) return;
  stateSweepTimer = setInterval(() => {
    pruneStates();
  }, STATE_SWEEP_INTERVAL_MS);
  // Never keep the process alive just for the sweep.
  if (typeof stateSweepTimer.unref === 'function') stateSweepTimer.unref();
}

/** Test-only hooks for the pending-state sweeper (L7). Not public API. */
export const __testOAuthHooks = {
  addPendingState: (state: string, ttlMs: number): void => {
    pendingStates.set(state, { redirectUri: 'http://localhost/cb', expires: Date.now() + ttlMs });
    scheduleStateSweep();
  },
  pendingStateCount: (): number => pendingStates.size,
  /** Clear the interval (lets a test re-schedule it under fake timers). */
  stopSweepForTest: (): void => {
    if (stateSweepTimer) {
      clearInterval(stateSweepTimer);
      stateSweepTimer = null;
    }
  },
};

function errorBody(error: string, detail?: string): { error: string; detail?: string } {
  return detail ? { error, detail } : { error };
}

export function registerOAuthRoutes(router: express.Router, deps: OAuthRouteDeps): void {
  const { config, governance } = deps;

  // GET /api/oauth/:provider/start — begin the connect flow (302 to the
  // provider's consent screen). `?state=` is optional; one is generated
  // otherwise and must be echoed back at the callback (CSRF check).
  router.get('/oauth/:provider/start', (req, res) => {
    const provider = getOAuthProvider(req.params.provider);
    if (!provider) {
      res.status(404).json(errorBody(`Unknown OAuth provider "${req.params.provider}"`));
      return;
    }
    pruneStates();
    const state = typeof req.query.state === 'string' && req.query.state ? req.query.state : randomUUID();
    const redirectUri = `${req.protocol}://${req.get('host')}/api/oauth/${provider.id}/callback`;
    pendingStates.set(state, { redirectUri, expires: Date.now() + STATE_TTL_MS });
    scheduleStateSweep();
    try {
      const url = buildAuthUrl(provider.id, state, redirectUri);
      res.redirect(url);
    } catch (err) {
      pendingStates.delete(state);
      res.status(400).json(errorBody('Failed to start OAuth flow', err instanceof Error ? err.message : String(err)));
    }
  });

  // GET /api/oauth/:provider/callback?code=...&state=... — the provider
  // redirects the user's browser here after consent. Exchanges the code
  // server-side and stores the tokens encrypted.
  router.get('/oauth/:provider/callback', async (req, res) => {
    const provider = getOAuthProvider(req.params.provider);
    if (!provider) {
      res.status(404).json(errorBody(`Unknown OAuth provider "${req.params.provider}"`));
      return;
    }
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const pending = state ? pendingStates.get(state) : undefined;
    pruneStates();
    if (!pending) {
      res.status(400).json(errorBody('Invalid or expired OAuth state — restart the connect flow'));
      return;
    }
    pendingStates.delete(state);
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!code) {
      res.status(400).json(errorBody('Missing authorization code'));
      return;
    }
    try {
      const tokens = await handleCallback(provider.id, code, pending.redirectUri, config.dataDir);
      governance.audit('oauth.connected', {
        actor: 'api',
        toolName: 'oauth',
        detail: { provider: provider.id, expiresAt: tokens.expiresAt },
      });
      console.log(`[oauth] connected provider "${provider.id}" (tokens stored encrypted)`);
      res.json({ ok: true, provider: provider.id, expiresAt: tokens.expiresAt });
    } catch (err) {
      res.status(400).json(errorBody('OAuth callback failed', err instanceof Error ? err.message : String(err)));
    }
  });

  // GET /api/oauth/status — connected providers. Tokens are never returned.
  router.get('/oauth/status', (_req, res) => {
    try {
      res.json(getOAuthStatus(config.dataDir));
    } catch (err) {
      res.status(500).json(errorBody('Failed to read OAuth status', err instanceof Error ? err.message : String(err)));
    }
  });

  // DELETE /api/oauth/:provider — disconnect: drop stored tokens.
  router.delete('/oauth/:provider', (req, res) => {
    const provider = getOAuthProvider(req.params.provider);
    if (!provider) {
      res.status(404).json(errorBody(`Unknown OAuth provider "${req.params.provider}"`));
      return;
    }
    try {
      const removed = disconnectOAuth(config.dataDir, provider.id);
      if (!removed) {
        res.status(404).json(errorBody(`OAuth provider "${provider.id}" is not connected`));
        return;
      }
      governance.audit('oauth.disconnected', { actor: 'api', toolName: 'oauth', detail: { provider: provider.id } });
      console.log(`[oauth] disconnected provider "${provider.id}"`);
      res.json({ ok: true, provider: provider.id });
    } catch (err) {
      res.status(500).json(errorBody('Failed to disconnect OAuth provider', err instanceof Error ? err.message : String(err)));
    }
  });
}
