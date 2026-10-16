// SPDX-License-Identifier: Apache-2.0
// MCP OAuth 2.1 client — authorization code flow with PKCE (S256).
//
// Implements the protocol mechanics from the MCP authorization spec:
//   - RFC 8414 authorization-server metadata discovery
//   - OAuth 2.1 authorization code + PKCE (S256) (RFC 7636)
//   - RFC 8707 resource indicators (the MCP server URL as `resource`)
//   - RFC 7591 dynamic client registration (fallback when no pre-registered client)
//   - Token refresh on expiry / 401
//
// Token persistence is injected via McpOAuthTokenStore so the host
// (apps/api) can use its AES-256-GCM encrypted credential store.
// This module never logs tokens.
//
// `fetchFn` is the seam — tests stub it, production uses global fetch.

import { createHash, randomBytes } from 'node:crypto';

export type FetchFn = typeof fetch;

// ---------------------------------------------------------------------------
// PKCE (RFC 7636)
// ---------------------------------------------------------------------------

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Generate a PKCE code verifier: 32 random bytes → 43 base64url chars,
 * inside the 43–128 character range required by RFC 7636.
 */
export function generateCodeVerifier(): string {
  return base64url(randomBytes(32));
}

/** S256 code challenge for a verifier. */
export function codeChallengeS256(verifier: string): string {
  return base64url(createHash('sha256').update(verifier, 'utf8').digest());
}

/** Generate an opaque `state` value (CSRF protection). */
export function generateOAuthState(): string {
  return base64url(randomBytes(16));
}

// ---------------------------------------------------------------------------
// RFC 8414 authorization-server metadata
// ---------------------------------------------------------------------------

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  response_types_supported?: string[];
  code_challenge_methods_supported?: string[];
}

/**
 * Parse + validate an authorization-server metadata document.
 * Throws on missing required fields.
 */
export function parseAuthorizationServerMetadata(body: unknown): AuthorizationServerMetadata {
  if (typeof body !== 'object' || body === null) {
    throw new Error('OAuth metadata is not a JSON object');
  }
  const b = body as Record<string, unknown>;
  const required = ['issuer', 'authorization_endpoint', 'token_endpoint'] as const;
  for (const key of required) {
    if (typeof b[key] !== 'string' || !(b[key] as string)) {
      throw new Error(`OAuth metadata missing required field "${key}"`);
    }
  }
  const meta: AuthorizationServerMetadata = {
    issuer: b.issuer as string,
    authorization_endpoint: b.authorization_endpoint as string,
    token_endpoint: b.token_endpoint as string,
  };
  if (typeof b.registration_endpoint === 'string') meta.registration_endpoint = b.registration_endpoint;
  if (Array.isArray(b.scopes_supported)) meta.scopes_supported = b.scopes_supported.filter((s): s is string => typeof s === 'string');
  if (Array.isArray(b.response_types_supported)) meta.response_types_supported = b.response_types_supported.filter((s): s is string => typeof s === 'string');
  if (Array.isArray(b.code_challenge_methods_supported)) meta.code_challenge_methods_supported = b.code_challenge_methods_supported.filter((s): s is string => typeof s === 'string');
  return meta;
}

// ---------------------------------------------------------------------------
// RFC 9728 protected-resource metadata
// ---------------------------------------------------------------------------

/**
 * Protected-resource metadata document (RFC 9728), served by the MCP
 * server at `/.well-known/oauth-protected-resource`. This is the first
 * discovery step in the MCP authorization spec: on a 401 the server
 * advertises this document (directly or via the WWW-Authenticate
 * `resource_metadata` parameter), and it names the authorization
 * server(s) to use.
 */
export interface ProtectedResourceMetadata {
  /** The protected resource identifier (usually the MCP server URL). */
  resource: string;
  /** Authorization server issuer URLs that can mint tokens for this resource. */
  authorizationServers: string[];
  scopesSupported?: string[];
  bearerMethodsSupported?: string[];
}

/** Parse + validate a protected-resource metadata document. Throws on bad shape. */
export function parseProtectedResourceMetadata(body: unknown): ProtectedResourceMetadata {
  if (typeof body !== 'object' || body === null) {
    throw new Error('Protected-resource metadata is not a JSON object');
  }
  const b = body as Record<string, unknown>;
  if (typeof b.resource !== 'string' || !b.resource) {
    throw new Error('Protected-resource metadata missing required field "resource"');
  }
  const servers = b.authorization_servers;
  if (!Array.isArray(servers) || servers.length === 0 || !servers.every((s) => typeof s === 'string')) {
    throw new Error('Protected-resource metadata missing non-empty "authorization_servers"');
  }
  const meta: ProtectedResourceMetadata = {
    resource: b.resource,
    authorizationServers: servers as string[],
  };
  if (Array.isArray(b.scopes_supported)) {
    meta.scopesSupported = b.scopes_supported.filter((s): s is string => typeof s === 'string');
  }
  if (Array.isArray(b.bearer_methods_supported)) {
    meta.bearerMethodsSupported = b.bearer_methods_supported.filter((s): s is string => typeof s === 'string');
  }
  return meta;
}

/**
 * Fetch protected-resource metadata for an MCP server URL (RFC 9728 §3).
 * Tries the path-scoped well-known URI first, then the origin-scoped one.
 * Returns undefined (does not throw) when the server serves no metadata —
 * many plain servers simply have none.
 */
export async function discoverProtectedResourceMetadata(
  mcpServerUrl: string,
  fetchFn: FetchFn = fetch,
): Promise<ProtectedResourceMetadata | undefined> {
  let serverUrl: URL;
  try {
    serverUrl = new URL(mcpServerUrl);
  } catch {
    return undefined;
  }
  const candidates = [
    `${serverUrl.origin}/.well-known/oauth-protected-resource${serverUrl.pathname}`,
    `${serverUrl.origin}/.well-known/oauth-protected-resource`,
  ];
  for (const url of candidates) {
    try {
      const res = await fetchFn(url, { headers: { accept: 'application/json' } });
      if (!res.ok) continue;
      return parseProtectedResourceMetadata(await res.json());
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * Extract the `resource_metadata` URI from a WWW-Authenticate header.
 * Servers refusing a request advertise e.g.:
 *   WWW-Authenticate: Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"
 * Returns undefined when the header is absent or has no resource_metadata param.
 */
export function parseWwwAuthenticateResourceMetadata(header: string | null | undefined): string | undefined {
  if (!header) return undefined;
  const m = /resource_metadata="([^"]+)"/i.exec(header);
  return m ? m[1] : undefined;
}

/**
 * Fetch protected-resource metadata from an explicit URI (e.g. the one
 * advertised in WWW-Authenticate). Throws on fetch/parse failure.
 */
export async function fetchProtectedResourceMetadata(
  metadataUrl: string,
  fetchFn: FetchFn = fetch,
): Promise<ProtectedResourceMetadata> {
  const res = await fetchFn(metadataUrl, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`Protected-resource metadata fetch failed (HTTP ${res.status})`);
  }
  return parseProtectedResourceMetadata(await res.json());
}

// ---------------------------------------------------------------------------
// MCP authorization probe — does this server need OAuth?
// ---------------------------------------------------------------------------

export interface McpAuthProbeResult {
  /** True when the server requires OAuth before bots may use it. */
  requiresOAuth: boolean;
  /** Where protected-resource metadata was found, if anywhere. */
  resourceMetadataUrl?: string;
  /** Authorization server issuers named by the metadata, if any. */
  authorizationServers?: string[];
  /** Scopes the resource advertises, if any. */
  scopesSupported?: string[];
  /** Human-readable explanation of the verdict. */
  detail: string;
}

function mcpInitializeBody(): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mvp-agent-runtime', version: '0.1.0' },
    },
  });
}

/**
 * Probe an MCP server to determine whether it requires OAuth.
 *
 * Follows the MCP authorization spec / Codync behavior:
 *  1. POST an unauthenticated `initialize`. 2xx → no OAuth needed.
 *  2. On 401, look for `WWW-Authenticate: ... resource_metadata="..."`,
 *     fetch that document, and report the authorization servers.
 *  3. Even without a 401 challenge, protected-resource metadata that
 *     names an authorization server marks the server as OAuth-gated
 *     (some servers only refuse at tool-call time).
 *
 * Never throws for "not OAuth" verdicts — only for invalid URLs.
 */
export async function probeMcpServerAuth(
  mcpServerUrl: string,
  fetchFn: FetchFn = fetch,
): Promise<McpAuthProbeResult> {
  let serverUrl: URL;
  try {
    serverUrl = new URL(mcpServerUrl);
  } catch {
    throw new Error(`Invalid MCP server URL "${mcpServerUrl}"`);
  }

  const unauthenticatedInit = async (): Promise<{ status: number; wwwAuthenticate: string | null }> => {
    try {
      const res = await fetchFn(serverUrl.toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: mcpInitializeBody(),
      });
      const header =
        typeof res.headers?.get === 'function' ? res.headers.get('www-authenticate') : null;
      return { status: res.status, wwwAuthenticate: header };
    } catch (err) {
      // Unreachable server: not an OAuth verdict — say so plainly.
      return {
        status: -1,
        wwwAuthenticate: null,
      };
    }
  };

  const { status, wwwAuthenticate } = await unauthenticatedInit();
  if (status === -1) {
    return { requiresOAuth: false, detail: 'Server unreachable — cannot determine auth requirements' };
  }
  if (status >= 200 && status < 300) {
    return { requiresOAuth: false, detail: `Unauthenticated initialize succeeded (HTTP ${status})` };
  }

  if (status === 401 || status === 403) {
    // 1) Advertised metadata URI wins.
    const advertised = parseWwwAuthenticateResourceMetadata(wwwAuthenticate);
    if (advertised) {
      try {
        const prm = await fetchProtectedResourceMetadata(advertised, fetchFn);
        return {
          requiresOAuth: true,
          resourceMetadataUrl: advertised,
          authorizationServers: prm.authorizationServers,
          scopesSupported: prm.scopesSupported,
          detail: `Server refused unauthenticated initialize (HTTP ${status}) and advertises protected-resource metadata`,
        };
      } catch (err) {
        return {
          requiresOAuth: true,
          detail:
            `Server refused unauthenticated initialize (HTTP ${status}) and advertises ` +
            `protected-resource metadata, but it could not be fetched: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
    // 2) Fall back to well-known discovery.
    const prm = await discoverProtectedResourceMetadata(mcpServerUrl, fetchFn);
    if (prm) {
      return {
        requiresOAuth: true,
        authorizationServers: prm.authorizationServers,
        scopesSupported: prm.scopesSupported,
        detail: `Server refused unauthenticated initialize (HTTP ${status}); protected-resource metadata names an authorization server`,
      };
    }
    return {
      requiresOAuth: true,
      detail: `Server refused unauthenticated initialize (HTTP ${status}) without OAuth metadata — likely needs a static bearer token`,
    };
  }

  // Non-401 errors: check metadata anyway (servers that only refuse at
  // tool-call time, per Codync behavior).
  const prm = await discoverProtectedResourceMetadata(mcpServerUrl, fetchFn);
  if (prm) {
    return {
      requiresOAuth: true,
      authorizationServers: prm.authorizationServers,
      scopesSupported: prm.scopesSupported,
      detail: `Protected-resource metadata names an authorization server (initialize returned HTTP ${status})`,
    };
  }
  return { requiresOAuth: false, detail: `Initialize returned HTTP ${status} with no OAuth metadata` };
}

/**
 * Full discovery chain for an MCP server: protected-resource metadata →
 * first authorization server → RFC 8414 authorization-server metadata.
 * Falls back to direct RFC 8414 discovery when the server serves no
 * protected-resource metadata.
 */
export async function discoverAuthServerForMcp(
  mcpServerUrl: string,
  fetchFn: FetchFn = fetch,
): Promise<AuthorizationServerMetadata> {
  const prm = await discoverProtectedResourceMetadata(mcpServerUrl, fetchFn);
  if (prm && prm.authorizationServers.length > 0) {
    const issuer = prm.authorizationServers[0];
    // RFC 8414 well-known for the issuer.
    const issuerUrl = new URL(issuer);
    const wellKnown = `${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerUrl.pathname}`;
    try {
      const res = await fetchFn(wellKnown, { headers: { accept: 'application/json' } });
      if (res.ok) {
        return parseAuthorizationServerMetadata(await res.json());
      }
    } catch {
      // fall through to direct discovery
    }
  }
  return discoverAuthorizationServerMetadata(mcpServerUrl, fetchFn);
}

/**
 * Discover the authorization server for an MCP server URL (RFC 8414 §3).
 * Tries the path-scoped well-known URI first, then the origin-scoped one.
 */
export async function discoverAuthorizationServerMetadata(
  mcpServerUrl: string,
  fetchFn: FetchFn = fetch,
): Promise<AuthorizationServerMetadata> {
  let serverUrl: URL;
  try {
    serverUrl = new URL(mcpServerUrl);
  } catch {
    throw new Error(`Invalid MCP server URL "${mcpServerUrl}"`);
  }
  const candidates = [
    `${serverUrl.origin}/.well-known/oauth-authorization-server${serverUrl.pathname}`,
    `${serverUrl.origin}/.well-known/oauth-authorization-server`,
  ];
  let lastError = 'no candidates attempted';
  for (const url of candidates) {
    try {
      const res = await fetchFn(url, { headers: { accept: 'application/json' } });
      if (!res.ok) {
        lastError = `GET ${url} → HTTP ${res.status}`;
        continue;
      }
      const body: unknown = await res.json();
      return parseAuthorizationServerMetadata(body);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(`OAuth metadata discovery failed for ${mcpServerUrl}: ${lastError}`);
}

// ---------------------------------------------------------------------------
// Authorization URL
// ---------------------------------------------------------------------------

export interface McpAuthUrlParams {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  /** Space-delimited scopes (optional). */
  scope?: string;
  /** RFC 8707 resource indicator — the MCP server URL. */
  resource?: string;
}

/** Build the authorization URL for the OAuth 2.1 + PKCE flow. */
export function buildMcpAuthUrl(params: McpAuthUrlParams): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    code_challenge: params.codeChallenge,
    code_challenge_method: 'S256',
    state: params.state,
  });
  if (params.scope) q.set('scope', params.scope);
  if (params.resource) q.set('resource', params.resource);
  return `${params.authorizationEndpoint}?${q.toString()}`;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/** Token set for one MCP server. `expiresAt` is epoch ms. */
export interface McpOAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scope?: string;
  tokenType?: string;
}

/** Registered OAuth client credentials for one MCP server. */
export interface McpOAuthClientInfo {
  clientId: string;
  clientSecret?: string;
}

async function postTokenForm(
  tokenEndpoint: string,
  fields: Record<string, string>,
  fetchFn: FetchFn,
): Promise<Record<string, unknown>> {
  const res = await fetchFn(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(fields).toString(),
  });
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    // Non-JSON error body: surface the status below.
  }
  if (!res.ok) {
    const err = typeof body.error_description === 'string' ? body.error_description : body.error;
    throw new Error(`Token request failed (HTTP ${res.status}): ${err ?? 'unknown error'}`);
  }
  return body;
}

function tokensFromResponse(body: Record<string, unknown>, previous?: McpOAuthTokens): McpOAuthTokens {
  const accessToken = body.access_token;
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new Error('Token response did not contain an access_token');
  }
  const expiresIn = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3600;
  const refreshToken =
    typeof body.refresh_token === 'string' && body.refresh_token
      ? body.refresh_token
      : previous?.refreshToken;
  return {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
    scope: typeof body.scope === 'string' ? body.scope : previous?.scope,
    tokenType: typeof body.token_type === 'string' ? body.token_type : undefined,
  };
}

export interface ExchangeCodeParams {
  tokenEndpoint: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  client: McpOAuthClientInfo;
  /** RFC 8707 resource indicator — echo the MCP server URL when used at authorize time. */
  resource?: string;
}

/** Exchange an authorization code for tokens (PKCE). */
export async function exchangeCodeForTokens(
  params: ExchangeCodeParams,
  fetchFn: FetchFn = fetch,
): Promise<McpOAuthTokens> {
  if (!params.code) throw new Error('Missing authorization code');
  const fields: Record<string, string> = {
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    code_verifier: params.codeVerifier,
    client_id: params.client.clientId,
  };
  if (params.client.clientSecret) fields.client_secret = params.client.clientSecret;
  if (params.resource) fields.resource = params.resource;
  const body = await postTokenForm(params.tokenEndpoint, fields, fetchFn);
  return tokensFromResponse(body);
}

export interface RefreshTokenParams {
  tokenEndpoint: string;
  refreshToken: string;
  client: McpOAuthClientInfo;
  resource?: string;
}

/** Refresh an access token. */
export async function refreshAccessToken(
  params: RefreshTokenParams,
  fetchFn: FetchFn = fetch,
): Promise<McpOAuthTokens> {
  const fields: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: params.refreshToken,
    client_id: params.client.clientId,
  };
  if (params.client.clientSecret) fields.client_secret = params.client.clientSecret;
  if (params.resource) fields.resource = params.resource;
  const body = await postTokenForm(params.tokenEndpoint, fields, fetchFn);
  return tokensFromResponse(body);
}

// ---------------------------------------------------------------------------
// Dynamic client registration (RFC 7591) — fallback when the deployer has
// not pre-registered a client id/secret for the MCP server.
// ---------------------------------------------------------------------------

export interface RegisterClientParams {
  registrationEndpoint: string;
  redirectUris: string[];
  clientName?: string;
}

/** Register an OAuth client dynamically; returns the issued credentials. */
export async function registerOAuthClient(
  params: RegisterClientParams,
  fetchFn: FetchFn = fetch,
): Promise<McpOAuthClientInfo> {
  const res = await fetchFn(params.registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      redirect_uris: params.redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: params.clientName ?? 'mvp-agent-runtime',
      code_challenge_method: 'S256',
    }),
  });
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    // fall through to the status check
  }
  if (!res.ok) {
    const err = typeof body.error_description === 'string' ? body.error_description : body.error;
    throw new Error(`Client registration failed (HTTP ${res.status}): ${err ?? 'unknown error'}`);
  }
  const clientId = body.client_id;
  if (typeof clientId !== 'string' || !clientId) {
    throw new Error('Client registration response did not contain a client_id');
  }
  const info: McpOAuthClientInfo = { clientId };
  if (typeof body.client_secret === 'string' && body.client_secret) {
    info.clientSecret = body.client_secret;
  }
  return info;
}

// ---------------------------------------------------------------------------
// Token store (host-implemented with encrypted storage)
// ---------------------------------------------------------------------------

/**
 * Host-implemented token + client-info persistence. apps/api implements
 * this on top of its AES-256-GCM encrypted credential store.
 */
export interface McpOAuthTokenStore {
  getTokens(serverId: string): McpOAuthTokens | undefined;
  saveTokens(serverId: string, tokens: McpOAuthTokens): void;
  removeTokens(serverId: string): boolean;
  getClientInfo(serverId: string): McpOAuthClientInfo | undefined;
  saveClientInfo(serverId: string, info: McpOAuthClientInfo): void;
}

/** Thrown when an MCP server needs OAuth and no usable token exists. */
export class McpOAuthRequiredError extends Error {
  readonly serverId: string;
  /** API URL that starts the connect flow, e.g. /api/mcp/oauth/start?server=<id>. */
  readonly startUrl: string;

  constructor(serverId: string, startUrl: string) {
    super(
      `MCP server "${serverId}" requires OAuth authorization — ` +
        `connect it via ${startUrl} and then retry.`,
    );
    this.name = 'McpOAuthRequiredError';
    this.serverId = serverId;
    this.startUrl = startUrl;
  }
}

// ---------------------------------------------------------------------------
// High-level client: get a valid token, refreshing when needed.
// ---------------------------------------------------------------------------

/** Safety margin before expiry to proactively refresh. */
const REFRESH_SKEW_MS = 60_000;

export interface McpOAuthClientOptions {
  /** MCP server id (config key, e.g. "github-mcp"). */
  serverId: string;
  /** The MCP server's HTTP(S) URL — also the RFC 8707 resource indicator. */
  serverUrl: string;
  store: McpOAuthTokenStore;
  /**
   * Resolve client credentials for the server. The host reads
   * MCP_OAUTH_<SERVER>_CLIENT_ID/SECRET (env or encrypted store) and falls
   * back to dynamic registration when the metadata advertises it.
   */
  resolveClient: (serverId: string, metadata: AuthorizationServerMetadata) => Promise<McpOAuthClientInfo>;
  fetchFn?: FetchFn;
  /** Override for the "start OAuth" URL surfaced in McpOAuthRequiredError. */
  startUrl?: string;
}

export class McpOAuthClient {
  private readonly opts: McpOAuthClientOptions;
  private metadataCache: AuthorizationServerMetadata | undefined;

  constructor(opts: McpOAuthClientOptions) {
    this.opts = opts;
  }

  private get fetchFn(): FetchFn {
    return this.opts.fetchFn ?? fetch;
  }

  get startUrl(): string {
    return this.opts.startUrl ?? `/api/mcp/oauth/start?server=${encodeURIComponent(this.opts.serverId)}`;
  }

  /** Discover (and cache) the authorization server metadata. */
  async metadata(): Promise<AuthorizationServerMetadata> {
    if (!this.metadataCache) {
      // Full MCP chain: protected-resource metadata → auth server → RFC 8414.
      this.metadataCache = await discoverAuthServerForMcp(this.opts.serverUrl, this.fetchFn);
    }
    return this.metadataCache;
  }

  /**
   * Return a usable access token, refreshing via the stored refresh token
   * when the current one is expired (or within the skew window).
   * Throws McpOAuthRequiredError when no token exists and none can be minted.
   */
  async getValidAccessToken(): Promise<string> {
    const tokens = this.opts.store.getTokens(this.opts.serverId);
    if (!tokens) {
      throw new McpOAuthRequiredError(this.opts.serverId, this.startUrl);
    }
    if (tokens.expiresAt - REFRESH_SKEW_MS > Date.now()) {
      return tokens.accessToken;
    }
    if (!tokens.refreshToken) {
      // Token expired and cannot be refreshed — user must reconnect.
      this.opts.store.removeTokens(this.opts.serverId);
      throw new McpOAuthRequiredError(this.opts.serverId, this.startUrl);
    }
    const metadata = await this.metadata();
    const client = await this.opts.resolveClient(this.opts.serverId, metadata);
    try {
      const refreshed = await refreshAccessToken(
        {
          tokenEndpoint: metadata.token_endpoint,
          refreshToken: tokens.refreshToken,
          client,
          resource: this.opts.serverUrl,
        },
        this.fetchFn,
      );
      this.opts.store.saveTokens(this.opts.serverId, refreshed);
      return refreshed.accessToken;
    } catch {
      // Refresh failed (revoked, rotated, etc.) — drop the dead tokens and
      // send the user back through the connect flow. Never leak the error
      // detail beyond a generic message; tokens are never logged.
      this.opts.store.removeTokens(this.opts.serverId);
      throw new McpOAuthRequiredError(this.opts.serverId, this.startUrl);
    }
  }

  /**
   * Build the authorization URL to start the connect flow.
   * The caller must persist `codeVerifier` keyed by `state` until the callback.
   */
  async buildAuthorizationUrl(args: {
    state: string;
    codeVerifier: string;
    redirectUri: string;
    scope?: string;
  }): Promise<string> {
    const metadata = await this.metadata();
    const client = await this.opts.resolveClient(this.opts.serverId, metadata);
    return buildMcpAuthUrl({
      authorizationEndpoint: metadata.authorization_endpoint,
      clientId: client.clientId,
      redirectUri: args.redirectUri,
      codeChallenge: codeChallengeS256(args.codeVerifier),
      state: args.state,
      scope: args.scope,
      resource: this.opts.serverUrl,
    });
  }

  /**
   * Authenticated fetch against the MCP server: attaches the bearer token,
   * and on a 401 refreshes once and retries (Codync "refreshed on use (or
   * after a 401)" behavior). Throws McpOAuthRequiredError when no usable
   * token exists.
   */
  async authenticatedFetch(url: string, init?: RequestInit): Promise<Response> {
    const doFetch = async (token: string): Promise<Response> => {
      const headers = new Headers(init?.headers);
      headers.set('authorization', `Bearer ${token}`);
      return this.fetchFn(url, { ...init, headers });
    };
    let token = await this.getValidAccessToken();
    let res = await doFetch(token);
    if (res.status !== 401) return res;
    // Possibly revoked/rotated since the proactive check — refresh once.
    const stored = this.opts.store.getTokens(this.opts.serverId);
    if (!stored?.refreshToken) {
      this.opts.store.removeTokens(this.opts.serverId);
      throw new McpOAuthRequiredError(this.opts.serverId, this.startUrl);
    }
    const metadata = await this.metadata();
    const client = await this.opts.resolveClient(this.opts.serverId, metadata);
    try {
      const refreshed = await refreshAccessToken(
        {
          tokenEndpoint: metadata.token_endpoint,
          refreshToken: stored.refreshToken,
          client,
          resource: this.opts.serverUrl,
        },
        this.fetchFn,
      );
      this.opts.store.saveTokens(this.opts.serverId, refreshed);
      token = refreshed.accessToken;
    } catch {
      this.opts.store.removeTokens(this.opts.serverId);
      throw new McpOAuthRequiredError(this.opts.serverId, this.startUrl);
    }
    return doFetch(token);
  }

  /**
   * Complete the flow: exchange the code and persist the tokens.
   */
  async handleCallback(args: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<McpOAuthTokens> {
    const metadata = await this.metadata();
    const client = await this.opts.resolveClient(this.opts.serverId, metadata);
    const tokens = await exchangeCodeForTokens(
      {
        tokenEndpoint: metadata.token_endpoint,
        code: args.code,
        redirectUri: args.redirectUri,
        codeVerifier: args.codeVerifier,
        client,
        resource: this.opts.serverUrl,
      },
      this.fetchFn,
    );
    this.opts.store.saveTokens(this.opts.serverId, tokens);
    return tokens;
  }
}
