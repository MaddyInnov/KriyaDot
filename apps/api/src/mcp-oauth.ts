// SPDX-License-Identifier: Apache-2.0
// MCP OAuth routes — connect OAuth-protected MCP servers.
//
// The MCP spec's authorization flow is OAuth 2.1 (authorization code +
// PKCE). The protocol mechanics live in @mvp/agent-runtime/mcp-oauth.ts;
// this module adds:
//   - Encrypted token storage (same AES-256-GCM providers.local.json as
//     provider API keys and connected-app OAuth tokens — see providers.ts
//     and oauth.ts). Tokens are never logged or returned by any endpoint.
//   - Client credential resolution: MCP_OAUTH_<SERVER>_CLIENT_ID/SECRET
//     (env or encrypted store) wins; otherwise RFC 7591 dynamic client
//     registration against the metadata's registration_endpoint.
//   - HTTP routes: start / callback / status / revoke.
//   - An McpOAuthTokenStore implementation for the tool registry so MCP
//     HTTP servers configured with `oauth: true` connect with a bearer token.
//
// Env naming: server id "my-server" → MCP_OAUTH_MY_SERVER_CLIENT_ID.

import express from 'express';
import {
  McpOAuthClient,
  McpOAuthClientInfo,
  McpOAuthTokenStore,
  McpOAuthTokens,
  AuthorizationServerMetadata,
  discoverAuthorizationServerMetadata,
  generateCodeVerifier,
  generateOAuthState,
  probeMcpServerAuth,
  registerOAuthClient,
} from '@mvp/agent-runtime';
import type { GovernanceGateway } from '@mvp/governance';
import type { AppConfig } from './config.js';
import type { McpServerConfig } from './seed.js';
import { removeProviderKey, saveProviderKey, syncProviderKeysToEnv } from './providers.js';

// ---------------------------------------------------------------------------
// Encrypted token storage (mirrors apps/api/src/oauth.ts patterns)
// ---------------------------------------------------------------------------

/** Synthesized provider id so tokens ride the encrypted providers file. */
function tokenProviderId(serverId: string): string {
  return `custom-mcp-oauth-${serverId}`;
}

/** Env key under which the token blob is mirrored. */
function tokenEnvKey(serverId: string): string {
  return `CUSTOM_MCP_OAUTH_${serverId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
}

/** Synthesized provider id for dynamically-registered client credentials. */
function clientProviderId(serverId: string): string {
  return `custom-mcp-oauth-${serverId}-client`;
}

function clientEnvKey(serverId: string): string {
  return `CUSTOM_MCP_OAUTH_${serverId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_CLIENT`;
}

const tokenCache = new Map<string, McpOAuthTokens>();
const clientCache = new Map<string, McpOAuthClientInfo>();

function persistTokens(dataDir: string, serverId: string, tokens: McpOAuthTokens): void {
  tokenCache.set(`${dataDir}::${serverId}`, tokens);
  saveProviderKey(dataDir, tokenProviderId(serverId), { apiKey: JSON.stringify(tokens) });
}

function loadTokens(dataDir: string, serverId: string): McpOAuthTokens | undefined {
  const cached = tokenCache.get(`${dataDir}::${serverId}`);
  if (cached) return cached;
  syncProviderKeysToEnv(dataDir);
  const raw = process.env[tokenEnvKey(serverId)];
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<McpOAuthTokens>;
    if (typeof parsed.accessToken !== 'string' || typeof parsed.expiresAt !== 'number') return undefined;
    return parsed as McpOAuthTokens;
  } catch {
    return undefined;
  }
}

function persistClientInfo(dataDir: string, serverId: string, info: McpOAuthClientInfo): void {
  clientCache.set(`${dataDir}::${serverId}`, info);
  saveProviderKey(dataDir, clientProviderId(serverId), { apiKey: JSON.stringify(info) });
}

function loadClientInfo(dataDir: string, serverId: string): McpOAuthClientInfo | undefined {
  const cached = clientCache.get(`${dataDir}::${serverId}`);
  if (cached) return cached;
  syncProviderKeysToEnv(dataDir);
  const raw = process.env[clientEnvKey(serverId)];
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<McpOAuthClientInfo>;
    if (typeof parsed.clientId !== 'string' || !parsed.clientId) return undefined;
    return parsed as McpOAuthClientInfo;
  } catch {
    return undefined;
  }
}

/** McpOAuthTokenStore backed by the encrypted credential store. */
export function createMcpOAuthTokenStore(dataDir: string): McpOAuthTokenStore {
  return {
    getTokens: (serverId) => loadTokens(dataDir, serverId),
    saveTokens: (serverId, tokens) => persistTokens(dataDir, serverId, tokens),
    removeTokens: (serverId) => {
      tokenCache.delete(`${dataDir}::${serverId}`);
      return removeProviderKey(dataDir, tokenProviderId(serverId));
    },
    getClientInfo: (serverId) => loadClientInfo(dataDir, serverId),
    saveClientInfo: (serverId, info) => persistClientInfo(dataDir, serverId, info),
  };
}

// ---------------------------------------------------------------------------
// Client credential resolution
// ---------------------------------------------------------------------------

function preRegisteredClientIdEnv(serverId: string): string {
  return `MCP_OAUTH_${serverId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_CLIENT_ID`;
}

function preRegisteredClientSecretEnv(serverId: string): string {
  return `MCP_OAUTH_${serverId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_CLIENT_SECRET`;
}

/**
 * Peek at client credentials without attempting dynamic registration.
 * Used at boot/connect time: registration happens through the API connect
 * flow (which has the real redirect URI), not silently at startup.
 * Returns undefined when no client is known — the caller should surface
 * McpOAuthRequiredError pointing at the start URL.
 */
export function peekMcpOAuthClientInfo(
  dataDir: string,
  serverId: string,
): McpOAuthClientInfo | undefined {
  syncProviderKeysToEnv(dataDir);
  const clientId = process.env[preRegisteredClientIdEnv(serverId)];
  if (clientId) {
    const clientSecret = process.env[preRegisteredClientSecretEnv(serverId)];
    return clientSecret ? { clientId, clientSecret } : { clientId };
  }
  return loadClientInfo(dataDir, serverId);
}

/**
 * Resolve OAuth client credentials for an MCP server:
 * 1. Pre-registered MCP_OAUTH_<SERVER>_CLIENT_ID(/_SECRET) from env or the
 *    encrypted store (real env wins).
 * 2. Previously dynamically-registered client (encrypted store).
 * 3. Dynamic client registration (RFC 7591) when the metadata advertises a
 *    registration_endpoint — the issued credentials are persisted encrypted.
 */
export async function resolveMcpOAuthClient(
  dataDir: string,
  serverId: string,
  metadata: AuthorizationServerMetadata,
  redirectUri: string,
): Promise<McpOAuthClientInfo> {
  const peeked = peekMcpOAuthClientInfo(dataDir, serverId);
  if (peeked) return peeked;
  if (!metadata.registration_endpoint) {
    throw new Error(
      `MCP server "${serverId}" requires OAuth but no client is registered: ` +
        `set ${preRegisteredClientIdEnv(serverId)} (env or encrypted store), ` +
        `or use an authorization server with dynamic client registration.`,
    );
  }
  const info = await registerOAuthClient({
    registrationEndpoint: metadata.registration_endpoint,
    redirectUris: [redirectUri],
    clientName: 'mvp-agent-runtime',
  });
  persistClientInfo(dataDir, serverId, info);
  return info;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export interface McpOAuthRouteDeps {
  config: AppConfig;
  governance: GovernanceGateway;
  /** MCP server configs (to validate `server` and read the URL / oauth flag). */
  mcpServers: Record<string, McpServerConfig>;
}

export interface McpOAuthStatus {
  server: string;
  url?: string;
  oauth: boolean;
  connected: boolean;
  expiresAt?: number;
  hasRefreshToken: boolean;
}

function errorBody(error: string, detail?: string): { error: string; detail?: string } {
  return detail ? { error, detail } : { error };
}

interface PendingFlow {
  serverId: string;
  codeVerifier: string;
  redirectUri: string;
  /** 'deeplink' → callback 302s to kriyadot://oauth-callback for phone handoff. */
  display?: string;
  expires: number;
}

/** In-memory pending flows: state → PKCE verifier + redirect URI. */
const pendingFlows = new Map<string, PendingFlow>();
const FLOW_TTL_MS = 10 * 60 * 1000;
const FLOW_SWEEP_INTERVAL_MS = 60_000;

function pruneFlows(): void {
  const now = Date.now();
  for (const [k, v] of pendingFlows) {
    if (v.expires <= now) pendingFlows.delete(k);
  }
}

let flowSweepTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Periodic purge of expired pending MCP-OAuth flows (L7). Mirrors the
 * WS-ticket sweeper in loopback-auth.ts: opportunistic pruning on route
 * hits is not enough for abandoned flows with no further traffic.
 */
function scheduleFlowSweep(): void {
  if (flowSweepTimer) return;
  flowSweepTimer = setInterval(() => {
    pruneFlows();
  }, FLOW_SWEEP_INTERVAL_MS);
  // Never keep the process alive just for the sweep.
  if (typeof flowSweepTimer.unref === 'function') flowSweepTimer.unref();
}

/** Test-only hooks for the pending-flow sweeper (L7). Not public API. */
export const __testMcpOAuthHooks = {
  addPendingFlow: (state: string, ttlMs: number): void => {
    pendingFlows.set(
      state,
      { serverId: 'test', codeVerifier: 'v', redirectUri: 'http://localhost/cb', expires: Date.now() + ttlMs },
    );
    scheduleFlowSweep();
  },
  pendingFlowCount: (): number => pendingFlows.size,
  /** Clear the interval (lets a test re-schedule it under fake timers). */
  stopSweepForTest: (): void => {
    if (flowSweepTimer) {
      clearInterval(flowSweepTimer);
      flowSweepTimer = null;
    }
  },
};

function oauthServerConfig(
  mcpServers: Record<string, McpServerConfig>,
  serverId: string,
): { url: string } {
  const cfg = mcpServers[serverId];
  if (!cfg || !('url' in cfg) || !cfg.url) {
    throw new Error(
      `Unknown MCP server "${serverId}" — OAuth is only supported for HTTP(S) MCP servers configured in mcp.json`,
    );
  }
  return { url: cfg.url };
}

export function getMcpOAuthStatus(
  dataDir: string,
  mcpServers: Record<string, McpServerConfig>,
): McpOAuthStatus[] {
  return Object.entries(mcpServers)
    .filter(([, cfg]) => 'url' in cfg && cfg.url)
    .map(([serverId, cfg]) => {
      const tokens = loadTokens(dataDir, serverId);
      return {
        server: serverId,
        url: (cfg as { url: string }).url,
        oauth: (cfg as { oauth?: boolean }).oauth === true,
        connected: tokens !== undefined,
        expiresAt: tokens?.expiresAt,
        hasRefreshToken: Boolean(tokens?.refreshToken),
      };
    });
}

export function registerMcpOAuthRoutes(router: express.Router, deps: McpOAuthRouteDeps): void {
  const { config, governance, mcpServers } = deps;
  const store = createMcpOAuthTokenStore(config.dataDir);

  const makeClient = (serverId: string, serverUrl: string, redirectUri: string): McpOAuthClient =>
    new McpOAuthClient({
      serverId,
      serverUrl,
      store,
      resolveClient: (sid, metadata) => resolveMcpOAuthClient(config.dataDir, sid, metadata, redirectUri),
    });

  // GET /api/mcp/oauth/start?server=<id>[&scope=...][&display=deeplink] —
  // begin the connect flow. Returns the authorization URL as JSON (the UI
  // opens it); the PKCE verifier is kept server-side keyed by `state`.
  // display=deeplink: for the Android companion — the callback redirects
  // to kriyadot://oauth-callback instead of returning JSON.
  router.get('/mcp/oauth/start', async (req, res) => {
    const serverId = typeof req.query.server === 'string' ? req.query.server : '';
    if (!serverId) {
      res.status(400).json(errorBody('Query param "server" is required'));
      return;
    }
    let serverUrl: string;
    try {
      ({ url: serverUrl } = oauthServerConfig(mcpServers, serverId));
    } catch (err) {
      res.status(404).json(errorBody(err instanceof Error ? err.message : String(err)));
      return;
    }
    const redirectUri = `${req.protocol}://${req.get('host')}/api/mcp/oauth/callback`;
    const scope = typeof req.query.scope === 'string' ? req.query.scope : undefined;
    const display = req.query.display === 'deeplink' ? 'deeplink' : undefined;
    try {
      // Metadata discovery also validates the server speaks OAuth.
      await discoverAuthorizationServerMetadata(serverUrl);
      const state = generateOAuthState();
      const codeVerifier = generateCodeVerifier();
      pruneFlows();
      pendingFlows.set(state, {
        serverId,
        codeVerifier,
        redirectUri,
        display,
        expires: Date.now() + FLOW_TTL_MS,
      });
      scheduleFlowSweep();
      const client = makeClient(serverId, serverUrl, redirectUri);
      const authUrl = await client.buildAuthorizationUrl({ state, codeVerifier, redirectUri, scope });
      res.json({ ok: true, server: serverId, authUrl, state });
    } catch (err) {
      res.status(400).json(errorBody('Failed to start MCP OAuth flow', err instanceof Error ? err.message : String(err)));
    }
  });

  // GET /api/mcp/oauth/callback?code=...&state=... — the authorization
  // server redirects the user's browser here. Exchanges the code (PKCE)
  // and stores the tokens encrypted.
  //
  // Phone handoff: pass `display=deeplink` at /start time and the callback
  // 302-redirects to `kriyadot://oauth-callback?code=...&state=...` instead
  // of returning JSON. The companion app intercepts the deep link and POSTs
  // { code, state } to /api/mcp/oauth/manual. The authorization code is
  // useless without the PKCE verifier, which never leaves this host —
  // the same security property as Codync's stateless cloud page.
  router.get('/mcp/oauth/callback', async (req, res) => {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const flow = state ? pendingFlows.get(state) : undefined;
    pruneFlows();
    if (!flow) {
      res.status(400).json(errorBody('Invalid or expired OAuth state — restart the connect flow'));
      return;
    }
    pendingFlows.delete(state);
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!code) {
      res.status(400).json(errorBody('Missing authorization code'));
      return;
    }
    if (flow.display === 'deeplink') {
      // Don't consume the code here — hand it to the phone via deep link.
      // Re-register the flow so /manual can complete it.
      pendingFlows.set(state, flow);
      const deepLink =
        `kriyadot://oauth-callback?code=${encodeURIComponent(code)}` +
        `&state=${encodeURIComponent(state)}&server=${encodeURIComponent(flow.serverId)}`;
      res.redirect(302, deepLink);
      return;
    }
    let serverUrl: string;
    try {
      ({ url: serverUrl } = oauthServerConfig(mcpServers, flow.serverId));
    } catch (err) {
      res.status(404).json(errorBody(err instanceof Error ? err.message : String(err)));
      return;
    }
    try {
      const client = makeClient(flow.serverId, serverUrl, flow.redirectUri);
      const tokens = await client.handleCallback({
        code,
        codeVerifier: flow.codeVerifier,
        redirectUri: flow.redirectUri,
      });
      governance.audit('mcp.oauth.connected', {
        actor: 'api',
        toolName: 'mcp-oauth',
        detail: { server: flow.serverId, expiresAt: tokens.expiresAt },
      });
      console.log(`[mcp-oauth] connected MCP server "${flow.serverId}" (tokens stored encrypted)`);
      res.json({ ok: true, server: flow.serverId, expiresAt: tokens.expiresAt });
    } catch (err) {
      res.status(400).json(errorBody('MCP OAuth callback failed', err instanceof Error ? err.message : String(err)));
    }
  });

  // POST /api/mcp/oauth/manual — complete the flow with a pasted code.
  // Body: { code, state } — or { callbackUrl } containing both as query
  // params (for browsers that can't reach the loopback callback, or the
  // phone deep-link handoff). The PKCE verifier stays server-side.
  router.post('/mcp/oauth/manual', async (req, res) => {
    let { code, state } = req.body as { code?: unknown; state?: unknown; callbackUrl?: unknown };
    if (typeof req.body?.callbackUrl === 'string') {
      try {
        const u = new URL(req.body.callbackUrl);
        code = u.searchParams.get('code') ?? undefined;
        state = u.searchParams.get('state') ?? undefined;
      } catch {
        res.status(400).json(errorBody('callbackUrl is not a valid URL'));
        return;
      }
    }
    if (typeof code !== 'string' || !code || typeof state !== 'string' || !state) {
      res.status(400).json(errorBody('Body must contain { code, state } or { callbackUrl }'));
      return;
    }
    const flow = pendingFlows.get(state);
    pruneFlows();
    if (!flow) {
      res.status(400).json(errorBody('Invalid or expired OAuth state — restart the connect flow'));
      return;
    }
    pendingFlows.delete(state);
    let serverUrl: string;
    try {
      ({ url: serverUrl } = oauthServerConfig(mcpServers, flow.serverId));
    } catch (err) {
      res.status(404).json(errorBody(err instanceof Error ? err.message : String(err)));
      return;
    }
    try {
      const client = makeClient(flow.serverId, serverUrl, flow.redirectUri);
      const tokens = await client.handleCallback({
        code,
        codeVerifier: flow.codeVerifier,
        redirectUri: flow.redirectUri,
      });
      governance.audit('mcp.oauth.connected', {
        actor: 'api',
        toolName: 'mcp-oauth',
        detail: { server: flow.serverId, expiresAt: tokens.expiresAt, via: 'manual' },
      });
      console.log(`[mcp-oauth] connected MCP server "${flow.serverId}" via manual code entry`);
      res.json({ ok: true, server: flow.serverId, expiresAt: tokens.expiresAt });
    } catch (err) {
      res.status(400).json(errorBody('MCP OAuth code exchange failed', err instanceof Error ? err.message : String(err)));
    }
  });

  // POST /api/mcp/oauth/probe — Codync-style install probe: does this MCP
  // server require OAuth? Body: { server } (configured id) or { url }.
  // A server that refuses unauthenticated initialize, or whose
  // protected-resource metadata names an authorization server, is reported
  // as requiresOAuth (signed out) — bots don't get it until sign-in.
  router.post('/mcp/oauth/probe', async (req, res) => {
    const serverId = typeof req.body?.server === 'string' ? req.body.server : '';
    const rawUrl = typeof req.body?.url === 'string' ? req.body.url : '';
    let serverUrl = rawUrl;
    if (serverId) {
      try {
        ({ url: serverUrl } = oauthServerConfig(mcpServers, serverId));
      } catch (err) {
        res.status(404).json(errorBody(err instanceof Error ? err.message : String(err)));
        return;
      }
    }
    if (!serverUrl) {
      res.status(400).json(errorBody('Body must contain { server } or { url }'));
      return;
    }
    try {
      const probe = await probeMcpServerAuth(serverUrl);
      const tokens = serverId ? loadTokens(config.dataDir, serverId) : undefined;
      res.json({
        ok: true,
        server: serverId || undefined,
        url: serverUrl,
        requiresOAuth: probe.requiresOAuth,
        signedOut: probe.requiresOAuth && !tokens,
        connected: tokens !== undefined,
        authorizationServers: probe.authorizationServers,
        scopesSupported: probe.scopesSupported,
        detail: probe.detail,
      });
    } catch (err) {
      res.status(400).json(errorBody('Probe failed', err instanceof Error ? err.message : String(err)));
    }
  });

  // GET /api/mcp/oauth/status — per-server OAuth state. Tokens never leave.
  router.get('/mcp/oauth/status', (_req, res) => {
    try {
      res.json({ ok: true, servers: getMcpOAuthStatus(config.dataDir, mcpServers) });
    } catch (err) {
      res.status(500).json(errorBody('Failed to read MCP OAuth status', err instanceof Error ? err.message : String(err)));
    }
  });

  // DELETE /api/mcp/oauth/:serverId — revoke locally: drop stored tokens.
  // (Refresh tokens are single-server secrets; deleting them de-authorizes
  // this client. Server-side revocation via RFC 7009 is best-effort and
  // omitted — the tokens simply stop being used.)
  router.delete('/mcp/oauth/:serverId', (req, res) => {
    const serverId = req.params.serverId;
    try {
      oauthServerConfig(mcpServers, serverId);
    } catch (err) {
      res.status(404).json(errorBody(err instanceof Error ? err.message : String(err)));
      return;
    }
    try {
      const removed = store.removeTokens(serverId);
      if (!removed) {
        res.status(404).json(errorBody(`MCP server "${serverId}" has no stored OAuth tokens`));
        return;
      }
      governance.audit('mcp.oauth.disconnected', { actor: 'api', toolName: 'mcp-oauth', detail: { server: serverId } });
      console.log(`[mcp-oauth] revoked tokens for MCP server "${serverId}"`);
      res.json({ ok: true, server: serverId });
    } catch (err) {
      res.status(500).json(errorBody('Failed to revoke MCP OAuth tokens', err instanceof Error ? err.message : String(err)));
    }
  });
}
