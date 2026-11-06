// SPDX-License-Identifier: Apache-2.0
// Composio HTTP client for the Managed Apps service.
//
// The interface and the normalized shapes mirror apps/api/src/composio.ts
// EXACTLY (ComposioApp / ComposioConnectedAccount / ComposioToolDefinition /
// ComposioExecuteResult / ComposioValidateResult) so the operator service
// speaks to the same Composio backend (https://backend.composio.dev/api/v3)
// the same way a user instance does — except the API key here is the
// OPERATOR's central key, supplied per call by the server from its env and
// never exposed to callers.
//
// Testing: production uses fetchComposioClient (real fetch); tests inject a
// mock via ManagedAppsConfig.composioClient, so zero paid API calls happen
// in tests.

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
