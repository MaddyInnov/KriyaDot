// SPDX-License-Identifier: Apache-2.0
// Composio connector (Workstream E): lets bots reach 1,000+ external apps
// (Gmail, Slack, GitHub, …) through one Composio API key.
//
// Mount (do NOT edit index.ts; the integrator adds this to routes.ts):
//   import { registerComposioRoutes } from './composio.js';
//   registerComposioRoutes(router, { config, governance, bots });
//
// Routes (registered on the router passed in, relative paths → /api/...):
//   GET    /composio/status            → { connected: boolean }
//   POST   /composio/connect           → { apiKey } → validate → { connected: true }
//   DELETE /composio/connect           → forget the key → { connected: false }
//   GET    /composio/apps[?botId=]     → { connected, apps: ComposioApp[] (+enabled when botId) }
//   POST   /composio/apps/:appId       → { botId, enabled } → per-bot enable toggle
//                                        (+ grants/revokes the composio_call &
//                                        composio_list_actions agent tools)
//
// Connected accounts live in ./composio-accounts.js (registerComposioAccountRoutes):
//   POST   /composio/accounts/link     → { toolkitSlug, label? } → { redirectUrl }
//   GET    /composio/accounts          → { connected, accounts: [...] }
//   POST   /composio/accounts/:id/label → { label } → rename an account
//   DELETE /composio/accounts/:id      → revoke + delete the account
//   GET    /composio/accounts/:id/tools[?botId=] → actions for the account
//
// Tool execution lives in ./composio-tools.js (registerComposioTools):
//   composio_list_actions — read-only discovery (auto-allowed)
//   composio_call         — execute one action (approval-gated, per-bot enabled)
//
// Key handling: the API key is validated against the Composio backend, then
// stored ONLY in the per-user encrypted vault (SecureVault, secret name
// `composio-api-key`). It is never logged, never returned by any endpoint,
// and never appears in audit detail. Without a configured key every endpoint
// answers gracefully ({ connected: false }) — never a 500.
//
// Testing: the Composio HTTP client is behind the ComposioClient interface.
// Production uses fetchComposioClient (real fetch); tests inject a mock via
// deps.composioClient, so zero paid API calls happen in tests.

import express from 'express';
import type { Request, Response } from 'express';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SecureVault } from '@mvp/vault';
import type { BotConfig } from '@mvp/agent-runtime';
import type { RouteDeps } from './routes.js';

// ---------------------------------------------------------------------------
// Composio HTTP client (interface + production fetch implementation)
// ---------------------------------------------------------------------------

export interface ComposioApp {
  /** Stable Composio toolkit id, e.g. "gmail", "slack". */
  appId: string;
  name: string;
  description?: string;
  logo?: string;
  categories?: string[];
}

export interface ComposioValidateResult {
  ok: boolean;
  orgName?: string;
}

/**
 * Thin HTTP facade over the Composio backend API. Kept behind this interface
 * so tests can inject a deterministic mock — the real client is never used
 * in tests (zero paid API usage).
 */
export interface ComposioClient {
  /** Validate an API key; ok=false when the key is rejected. */
  validateApiKey(apiKey: string): Promise<ComposioValidateResult>;
  /** List available app/toolkits for a validated key. */
  listApps(apiKey: string): Promise<ComposioApp[]>;
  /**
   * Create a Composio Connect Link for one toolkit (managed OAuth — no
   * custom OAuth credentials needed). Returns the hosted sign-in URL the
   * user must open to authorize the connection.
   */
  createAuthLink(
    apiKey: string,
    opts: { toolkitSlug: string; userId: string; label?: string },
  ): Promise<{ redirectUrl: string }>;
  /** List this user's connected accounts (nanoid, toolkit, status). */
  listConnectedAccounts(apiKey: string, userId: string): Promise<ComposioConnectedAccount[]>;
  /** Fetch one connected account by nanoid; null when it does not exist. */
  getConnectedAccount(apiKey: string, nanoid: string): Promise<ComposioConnectedAccount | null>;
  /** Permanently delete a connected account (credentials revoked). */
  deleteConnectedAccount(apiKey: string, nanoid: string): Promise<void>;
  /**
   * Revoke the provider grant for a connected account without deleting the
   * record. Best-effort: uses the v3.1 revoke endpoint; failures are
   * swallowed by callers that follow up with delete.
   */
  revokeConnectedAccount(apiKey: string, nanoid: string): Promise<void>;
  /** List executable tools (actions) for a toolkit. */
  listTools(apiKey: string, toolkitSlug?: string): Promise<ComposioToolDefinition[]>;
  /**
   * Execute one tool against a connected account.
   * Body: { connected_account_id, user_id, arguments }.
   */
  executeTool(
    apiKey: string,
    input: { toolSlug: string; connectedAccountId: string; userId: string; args: Record<string, unknown> },
  ): Promise<ComposioExecuteResult>;
}

/** One user-authorized connection to a toolkit (e.g. a Gmail account). */
export interface ComposioConnectedAccount {
  /** Composio nanoid, e.g. "ca_abc123". */
  id: string;
  /** Toolkit slug, e.g. "gmail". */
  toolkitSlug: string;
  toolkitName?: string;
  /** ACTIVE | INACTIVE | EXPIRED | ... */
  status: string;
  createdAt?: string;
}

/** One executable Composio action. */
export interface ComposioToolDefinition {
  /** Stable slug, e.g. "GMAIL_SEND_EMAIL". */
  slug: string;
  name: string;
  description?: string;
  /** JSON Schema for the action's arguments. */
  inputParameters: Record<string, unknown>;
}

export interface ComposioExecuteResult {
  successful: boolean;
  data?: unknown;
  error?: string;
}

const COMPOSIO_API_BASE = 'https://backend.composio.dev/api/v3';

function composioRequest(apiKey: string, path: string) {
  return fetch(`${COMPOSIO_API_BASE}${path}`, {
    headers: { 'x-api-key': apiKey, accept: 'application/json' },
    // AbortSignal.timeout is available in Node 22; fall back gracefully.
    signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(12_000) : undefined,
  });
}

function composioPost(apiKey: string, path: string, body: Record<string, unknown>) {
  return fetch(`${COMPOSIO_API_BASE}${path}`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(20_000) : undefined,
  });
}

function firstString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function normalizeApp(raw: unknown): ComposioApp {
  const r = (raw ?? {}) as Record<string, unknown>;
  const appId = String(r.app_id ?? r.appId ?? r.slug ?? r.name ?? '');
  return {
    appId,
    name: String(r.name ?? appId),
    description: typeof r.description === 'string' ? r.description : undefined,
    logo: typeof r.logo === 'string' ? r.logo : undefined,
    categories: Array.isArray(r.categories) ? r.categories.map(String) : undefined,
  };
}

function isAuthFailure(status: number): boolean {
  return status === 401 || status === 403;
}

function normalizeConnectedAccount(raw: unknown): ComposioConnectedAccount | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const id = firstString(r.id, r.nanoid, r.connected_account_id);
  if (!id) return null;
  const toolkit = (r.toolkit ?? {}) as Record<string, unknown>;
  const toolkitSlug =
    firstString(r.toolkit_slug, toolkit.slug) ??
    firstString(r.app_id, r.appId, r.slug) ??
    '';
  return {
    id,
    toolkitSlug,
    toolkitName: firstString(r.toolkit_name, toolkit.name),
    status: firstString(r.status, r.state) ?? 'UNKNOWN',
    createdAt: firstString(r.created_at, r.createdAt),
  };
}

function normalizeTool(raw: unknown): ComposioToolDefinition | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const slug = firstString(r.slug, r.name, r.tool_slug);
  if (!slug) return null;
  const params = r.input_parameters;
  return {
    slug,
    name: firstString(r.display_name, r.name) ?? slug,
    description: typeof r.description === 'string' ? r.description : undefined,
    inputParameters:
      params && typeof params === 'object' && !Array.isArray(params)
        ? (params as Record<string, unknown>)
        : { type: 'object', properties: {} },
  };
}

function itemsOf(body: unknown): unknown[] {
  const b = (body ?? {}) as Record<string, unknown>;
  if (Array.isArray(body)) return body;
  if (Array.isArray(b.items)) return b.items;
  if (Array.isArray(b.results)) return b.results;
  return [];
}

/** Production client: real HTTP to backend.composio.dev. Never used in tests. */
export const fetchComposioClient: ComposioClient = {
  async validateApiKey(apiKey: string): Promise<ComposioValidateResult> {
    const res = await composioRequest(apiKey, '/whoami');
    if (isAuthFailure(res.status)) return { ok: false };
    if (!res.ok) throw new Error(`Composio validation failed (HTTP ${res.status})`);
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const orgName =
      typeof body.org_name === 'string' ? body.org_name : typeof body.name === 'string' ? body.name : undefined;
    return { ok: true, orgName };
  },
  async listApps(apiKey: string): Promise<ComposioApp[]> {
    const res = await composioRequest(apiKey, '/apps');
    if (isAuthFailure(res.status)) throw new Error('Composio rejected the stored API key (HTTP ' + res.status + ')');
    if (!res.ok) throw new Error(`Composio app list failed (HTTP ${res.status})`);
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const items = Array.isArray(body) ? body : Array.isArray(body.apps) ? body.apps : [];
    return items.map(normalizeApp).filter((a) => a.appId.length > 0);
  },

  async createAuthLink(
    apiKey: string,
    opts: { toolkitSlug: string; userId: string; label?: string },
  ): Promise<{ redirectUrl: string }> {
    // The link endpoint needs an auth_config_id. Reuse an existing
    // Composio-managed auth config for the toolkit, or create one (managed
    // auth is the default — no custom OAuth credentials required).
    const listRes = await composioRequest(
      apiKey,
      `/auth_configs?toolkit_slug=${encodeURIComponent(opts.toolkitSlug)}`,
    );
    if (isAuthFailure(listRes.status)) throw new Error('Composio rejected the stored API key (HTTP ' + listRes.status + ')');
    if (!listRes.ok) throw new Error(`Composio auth-config list failed (HTTP ${listRes.status})`);
    const configs = itemsOf(await listRes.json().catch(() => ({})));
    let authConfigId = firstString(
      ...configs.map((c) => ((c ?? {}) as Record<string, unknown>).id),
    );
    if (!authConfigId) {
      const createRes = await composioPost(apiKey, '/auth_configs', {
        toolkit: { slug: opts.toolkitSlug },
        // Explicit managed auth (also the server default): Composio hosts
        // the OAuth flow; credentials never pass through KriyaDot.
        auth_config: { type: 'use_composio_managed_auth', credentials: {} },
      });
      if (isAuthFailure(createRes.status)) {
        throw new Error('Composio rejected the stored API key (HTTP ' + createRes.status + ')');
      }
      if (!createRes.ok) throw new Error(`Composio auth-config create failed (HTTP ${createRes.status})`);
      const created = (await createRes.json().catch(() => ({}))) as Record<string, unknown>;
      authConfigId = firstString(created.id, created.nanoid, created.auth_config_id);
      if (!authConfigId) throw new Error('Composio did not return an auth config id');
    }
    const linkRes = await composioPost(apiKey, '/connected_accounts/link', {
      auth_config_id: authConfigId,
      user_id: opts.userId,
      ...(opts.label ? { alias: opts.label } : {}),
    });
    if (isAuthFailure(linkRes.status)) {
      throw new Error('Composio rejected the stored API key (HTTP ' + linkRes.status + ')');
    }
    if (!linkRes.ok) throw new Error(`Composio auth-link create failed (HTTP ${linkRes.status})`);
    const linkBody = (await linkRes.json().catch(() => ({}))) as Record<string, unknown>;
    const redirectUrl = firstString(
      linkBody.redirect_url,
      linkBody.redirectUrl,
      linkBody.link,
      linkBody.url,
    );
    if (!redirectUrl) throw new Error('Composio did not return an auth redirect URL');
    return { redirectUrl };
  },

  async listConnectedAccounts(apiKey: string, userId: string): Promise<ComposioConnectedAccount[]> {
    const res = await composioRequest(
      apiKey,
      `/connected_accounts?user_id=${encodeURIComponent(userId)}`,
    );
    if (isAuthFailure(res.status)) throw new Error('Composio rejected the stored API key (HTTP ' + res.status + ')');
    if (!res.ok) throw new Error(`Composio connected-account list failed (HTTP ${res.status})`);
    return itemsOf(await res.json().catch(() => ({})))
      .map(normalizeConnectedAccount)
      .filter((a): a is ComposioConnectedAccount => a !== null);
  },

  async getConnectedAccount(apiKey: string, nanoid: string): Promise<ComposioConnectedAccount | null> {
    const res = await composioRequest(apiKey, `/connected_accounts/${encodeURIComponent(nanoid)}`);
    if (res.status === 404) return null;
    if (isAuthFailure(res.status)) throw new Error('Composio rejected the stored API key (HTTP ' + res.status + ')');
    if (!res.ok) throw new Error(`Composio connected-account fetch failed (HTTP ${res.status})`);
    return normalizeConnectedAccount(await res.json().catch(() => ({})));
  },

  async deleteConnectedAccount(apiKey: string, nanoid: string): Promise<void> {
    // Revoke the provider grant first (best-effort), then delete the record.
    try {
      await fetchComposioClient.revokeConnectedAccount(apiKey, nanoid);
    } catch {
      // Revoke is advisory; delete is authoritative.
    }
    const res = await fetch(`${COMPOSIO_API_BASE}/connected_accounts/${encodeURIComponent(nanoid)}`, {
      method: 'DELETE',
      headers: { 'x-api-key': apiKey, accept: 'application/json' },
      signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(12_000) : undefined,
    });
    if (res.status === 404) return; // Already gone — idempotent.
    if (isAuthFailure(res.status)) throw new Error('Composio rejected the stored API key (HTTP ' + res.status + ')');
    if (!res.ok) throw new Error(`Composio connected-account delete failed (HTTP ${res.status})`);
  },

  async revokeConnectedAccount(apiKey: string, nanoid: string): Promise<void> {
    const res = await composioPost(apiKey, `/connected_accounts/${encodeURIComponent(nanoid)}/revoke`, {});
    if (res.status === 404) return;
    if (isAuthFailure(res.status)) throw new Error('Composio rejected the stored API key (HTTP ' + res.status + ')');
    if (!res.ok) throw new Error(`Composio connected-account revoke failed (HTTP ${res.status})`);
  },

  async listTools(apiKey: string, toolkitSlug?: string): Promise<ComposioToolDefinition[]> {
    const path = toolkitSlug
      ? `/tools?toolkit_slug=${encodeURIComponent(toolkitSlug)}`
      : '/tools';
    const res = await composioRequest(apiKey, path);
    if (isAuthFailure(res.status)) throw new Error('Composio rejected the stored API key (HTTP ' + res.status + ')');
    if (!res.ok) throw new Error(`Composio tool list failed (HTTP ${res.status})`);
    return itemsOf(await res.json().catch(() => ({})))
      .map(normalizeTool)
      .filter((t): t is ComposioToolDefinition => t !== null);
  },

  async executeTool(
    apiKey: string,
    input: { toolSlug: string; connectedAccountId: string; userId: string; args: Record<string, unknown> },
  ): Promise<ComposioExecuteResult> {
    const res = await composioPost(apiKey, `/tools/execute/${encodeURIComponent(input.toolSlug)}`, {
      connected_account_id: input.connectedAccountId,
      user_id: input.userId,
      arguments: input.args,
    });
    if (isAuthFailure(res.status)) throw new Error('Composio rejected the stored API key (HTTP ' + res.status + ')');
    if (!res.ok) {
      const detail = await res.text().catch(() => '').then((t) => t.slice(0, 300));
      throw new Error(`Composio tool execution failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}`);
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return {
      successful: body.successful === true,
      data: body.data,
      error:
        typeof body.error === 'string'
          ? body.error
          : body.error != null
            ? JSON.stringify(body.error).slice(0, 500)
            : undefined,
    };
  },
};

// ---------------------------------------------------------------------------
// Storage: vault (key) + JSON file (per-bot per-app enablement)
// ---------------------------------------------------------------------------

/** Vault secret name holding the Composio API key (per-user namespace). */
export const COMPOSIO_KEY_NAME = 'composio-api-key';

function callerOf(req: Request): string {
  const header = req.header('x-user-id');
  return typeof header === 'string' && header.length > 0 ? header : 'default-user';
}

/** Public alias: the KriyaDot user id for a request (used by account routes). */
export function composioCallerOf(req: Request): string {
  return callerOf(req);
}

function sanitizeNamespace(ns: string): string {
  return ns.toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 64) || 'user';
}

/** Per-user enablement file: { [botId]: { [appId]: boolean } }. */
function enablesPath(dataDir: string, userId: string): string {
  const suffix = userId === 'default-user' ? '' : `.${sanitizeNamespace(userId)}`;
  return join(dataDir, `composio-enables${suffix}.json`);
}

/** Read per-bot per-app enablement. Exported for the tool-execution bridge. */
export function readComposioEnables(
  dataDir: string,
  userId: string,
): Record<string, Record<string, boolean>> {
  try {
    const parsed = JSON.parse(readFileSync(enablesPath(dataDir, userId), 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, Record<string, boolean>>;
    }
  } catch {
    // Missing or corrupt file → treat as empty (never 500).
  }
  return {};
}

function writeEnables(dataDir: string, userId: string, state: Record<string, Record<string, boolean>>): void {
  writeFileSync(enablesPath(dataDir, userId), JSON.stringify(state, null, 2), { mode: 0o600 });
}

/**
 * The stored Composio API key for a user, or undefined when not connected.
 * Server-side only — never returned by any route.
 */
export function getComposioApiKey(dataDir: string, userId: string): string | undefined {
  try {
    return new SecureVault(dataDir, userId, userId).get(COMPOSIO_KEY_NAME)?.value;
  } catch {
    return undefined;
  }
}

/**
 * Stable Composio entity id for a KriyaDot user. Composio scopes connected
 * accounts and tool executions to this entity; it must be identical at
 * link time and at execution time.
 */
export function composioEntityId(userId: string): string {
  return sanitizeNamespace(userId);
}

// ---------------------------------------------------------------------------
// Agent tool grants: bots gain composio_call / composio_list_actions when
// they have at least one Composio app enabled.
// ---------------------------------------------------------------------------

/** Agent tool names the Composio bridge registers into the tool registry. */
export const COMPOSIO_TOOL_NAMES = ['composio_call', 'composio_list_actions'] as const;

/**
 * Grant the Composio agent tools to every bot that has at least one app
 * enabled (union across all per-user enables files). Called at boot so
 * grants survive restarts; the enables files are the source of truth.
 * Mutates the passed BotConfig objects in place (same pattern as the other
 * boot overlays in index.ts).
 */
export function applyComposioToolGrants(bots: BotConfig[], dataDir: string): void {
  const granted = new Set<string>();
  let files: string[] = [];
  try {
    files = readdirSync(dataDir).filter(
      (f) => f === 'composio-enables.json' || (f.startsWith('composio-enables.') && f.endsWith('.json')),
    );
  } catch {
    return;
  }
  for (const f of files) {
    try {
      const parsed = JSON.parse(readFileSync(join(dataDir, f), 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      for (const [botId, apps] of Object.entries(parsed as Record<string, Record<string, boolean>>)) {
        if (apps && typeof apps === 'object' && Object.values(apps).some((v) => v === true)) {
          granted.add(botId);
        }
      }
    } catch {
      // Corrupt file → skip (the route reader treats it as empty too).
    }
  }
  for (const bot of bots) {
    if (!granted.has(bot.id)) continue;
    if (!Array.isArray(bot.tools)) bot.tools = [];
    for (const name of COMPOSIO_TOOL_NAMES) {
      if (!bot.tools.includes(name)) bot.tools.push(name);
    }
  }
}

/**
 * Sync one bot's tool list with its enablement: grant the Composio tools
 * when the bot has ≥1 enabled app, revoke them when it has none. Called by
 * the toggle route so no restart is needed.
 */
export function syncComposioToolGrant(bot: BotConfig, dataDir: string, userId: string): void {
  const perBot = readComposioEnables(dataDir, userId)[bot.id] ?? {};
  const anyEnabled = Object.values(perBot).some((v) => v === true);
  if (!Array.isArray(bot.tools)) bot.tools = [];
  if (anyEnabled) {
    for (const name of COMPOSIO_TOOL_NAMES) {
      if (!bot.tools.includes(name)) bot.tools.push(name);
    }
  } else {
    bot.tools = bot.tools.filter((t) => !(COMPOSIO_TOOL_NAMES as readonly string[]).includes(t));
  }
}

export type ComposioDeps = Pick<RouteDeps, 'config' | 'governance' | 'bots'> & {
  /** Injected in tests; defaults to the real fetch client in production. */
  composioClient?: ComposioClient;
};

function errorBody(error: string, detail?: string): { error: string; detail?: string } {
  return detail ? { error, detail } : { error };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerComposioRoutes(router: express.Router, deps: ComposioDeps): void {
  const { config, governance, bots } = deps;
  const client: ComposioClient = deps.composioClient ?? fetchComposioClient;

  const vaultOf = (req: Request): SecureVault =>
    new SecureVault(config.dataDir, callerOf(req), callerOf(req));

  /** The stored key, or undefined when not connected. */
  const storedKey = (req: Request): string | undefined =>
    getComposioApiKey(config.dataDir, callerOf(req));

  /** Persist the key: create the vault secret, or update it when present. */
  const saveKey = (req: Request, apiKey: string): void => {
    const vault = vaultOf(req);
    const existing = (() => {
      try {
        return vault.get(COMPOSIO_KEY_NAME);
      } catch {
        return undefined;
      }
    })();
    if (existing) {
      vault.update(COMPOSIO_KEY_NAME, apiKey);
    } else {
      vault.create(COMPOSIO_KEY_NAME, apiKey, 'Composio API key (Workstream E connector)');
    }
  };

  const connectedResponse = (req: Request, res: Response): void => {
    res.json({ connected: storedKey(req) !== undefined });
  };

  const r = express.Router();

  // GET /composio/status — graceful when no key is configured.
  r.get('/status', (req: Request, res: Response) => {
    connectedResponse(req, res);
  });

  // POST /composio/connect — validate the key, then store it in the vault.
  // The key is never logged, never echoed back, never in audit detail.
  r.post('/connect', async (req: Request, res: Response) => {
    const apiKey = (req.body as { apiKey?: unknown } | undefined)?.apiKey;
    if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
      res.status(400).json({ connected: false, ...errorBody('apiKey is required') });
      return;
    }
    let validation: ComposioValidateResult;
    try {
      validation = await client.validateApiKey(apiKey.trim());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res
        .status(502)
        .json({ connected: false, ...errorBody('Could not reach the Composio API', message) });
      return;
    }
    if (!validation.ok) {
      res.status(401).json({ connected: false, ...errorBody('Composio rejected the API key') });
      return;
    }
    try {
      saveKey(req, apiKey.trim());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ connected: false, ...errorBody('Failed to store the API key', message) });
      return;
    }
    governance.audit('composio.connected', {
      actor: callerOf(req),
      toolName: 'composio',
      detail: validation.orgName ? { orgName: validation.orgName } : undefined,
    });
    res.json({ connected: true });
  });

  // DELETE /composio/connect — forget the key (idempotent).
  r.delete('/connect', (req: Request, res: Response) => {
    try {
      vaultOf(req).delete(COMPOSIO_KEY_NAME);
    } catch {
      // Unknown/missing secret is fine — the result is "not connected".
    }
    governance.audit('composio.disconnected', { actor: callerOf(req), toolName: 'composio' });
    res.json({ connected: false });
  });

  // GET /composio/apps[?botId=] — catalog of connected apps. Without a key:
  // { connected: false }. With ?botId=, each app carries `enabled` for that bot.
  r.get('/apps', async (req: Request, res: Response) => {
    const apiKey = storedKey(req);
    if (!apiKey) {
      res.json({ connected: false, apps: [] as ComposioApp[] });
      return;
    }
    let apps: ComposioApp[];
    try {
      apps = await client.listApps(apiKey);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(502).json({ connected: true, apps: [] as ComposioApp[], ...errorBody('Could not reach the Composio API', message) });
      return;
    }
    const botId = typeof req.query.botId === 'string' ? req.query.botId : undefined;
    if (!botId) {
      res.json({ connected: true, apps });
      return;
    }
    const enables = readComposioEnables(config.dataDir, callerOf(req));
    const perBot = enables[botId] ?? {};
    res.json({
      connected: true,
      apps: apps.map((a) => ({ ...a, enabled: perBot[a.appId] ?? false })),
    });
  });

  // POST /composio/apps/:appId — enable/disable one app for one bot.
  r.post('/apps/:appId', async (req: Request, res: Response) => {
    const apiKey = storedKey(req);
    if (!apiKey) {
      res
        .status(400)
        .json({ connected: false, ...errorBody('Composio is not connected — connect an API key first') });
      return;
    }
    const body = (req.body ?? {}) as { botId?: unknown; enabled?: unknown };
    if (typeof body.botId !== 'string' || body.botId.length === 0) {
      res.status(400).json(errorBody('botId is required'));
      return;
    }
    if (typeof body.enabled !== 'boolean') {
      res.status(400).json(errorBody('enabled must be a boolean'));
      return;
    }
    const bot = bots.find((b) => b.id === body.botId);
    if (!bot) {
      res.status(404).json(errorBody(`unknown bot: ${body.botId}`));
      return;
    }
    let apps: ComposioApp[];
    try {
      apps = await client.listApps(apiKey);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(502).json(errorBody('Could not reach the Composio API', message));
      return;
    }
    const app = apps.find((a) => a.appId === req.params.appId);
    if (!app) {
      res.status(404).json(errorBody(`unknown Composio app: ${req.params.appId}`));
      return;
    }
    const userId = callerOf(req);
    const enables = readComposioEnables(config.dataDir, userId);
    const perBot = enables[body.botId] ?? {};
    perBot[req.params.appId] = body.enabled;
    enables[body.botId] = perBot;
    try {
      writeEnables(config.dataDir, userId, enables);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json(errorBody('Failed to persist the app toggle', message));
      return;
    }
    governance.audit(body.enabled ? 'composio.app_enabled' : 'composio.app_disabled', {
      actor: userId,
      toolName: 'composio',
      detail: { botId: body.botId, appId: req.params.appId },
    });
    // Keep the bot's agent tool list in sync: the bridge tools
    // (composio_call / composio_list_actions) are granted while the bot has
    // ≥1 enabled app and revoked when the last one is disabled — no restart
    // needed. Boot re-derives the same grants from the enables files.
    syncComposioToolGrant(bot, config.dataDir, userId);
    res.json({ ok: true, botId: body.botId, appId: req.params.appId, enabled: body.enabled });
  });

  router.use('/composio', r);
}
