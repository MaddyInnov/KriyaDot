// SPDX-License-Identifier: Apache-2.0
// Managed Composio transport (KriyaDot WORKER CLIENT): a ComposioClient
// implementation that talks to the KriyaDot managed-apps service instead of
// backend.composio.dev. The instance stores a per-user front-door-format
// service token (Ed25519) in the vault under `composio-managed-token`; every
// request carries it as `Authorization: Bearer <token>`.
//
// Service contract (fixed — built by the managed-apps service worker):
//   base URL from instance env KRIYADOT_MANAGED_APPS_URL
//   GET    /v1/apps                          → { apps }
//   POST   /v1/connect-link {toolkitSlug,label?} → { redirectUrl }
//   GET    /v1/accounts                      → { accounts }
//   POST   /v1/accounts/:id/label
//   DELETE /v1/accounts/:id
//   GET    /v1/tools?toolkitSlug=            → { tools }
//   POST   /v1/execute {toolkitSlug?,accountId?,actionName,arguments,kind}
//                                            → ExecuteResult-shaped JSON
//   GET    /v1/usage                         → { plan, used, quota, month, globalCapReached }
//   errors carry { code } incl. 403 not_entitled,
//   429 quota_exceeded / operator_cap_reached
//
// Response shapes mirror the api's own ComposioApp / ComposioConnectedAccount
// / ComposioToolDefinition / ComposioExecuteResult interfaces; the normalize
// helpers below mirror fetchComposioClient's (composio.ts) and additionally
// accept the already-normalized camelCase shapes.
//
// IMPORT RULE: this module uses ONLY `import type` for composio.ts — it must
// never runtime-import composio.ts (composio.ts runtime-imports this module
// for the resolver; a runtime import back would be a cycle).

import type {
  ComposioApp,
  ComposioClient,
  ComposioConnectedAccount,
  ComposioExecuteResult,
  ComposioToolDefinition,
  ComposioValidateResult,
} from './composio.js';

/** Injectable fetch (tests pass a mock; production uses the global fetch). */
export type ManagedFetch = typeof fetch;

export interface ManagedUsage {
  plan?: string;
  used?: number;
  quota?: number;
  month?: string;
  globalCapReached?: boolean;
}

/** Error carrying the managed service's HTTP status + machine code. */
export class ManagedAppsError extends Error {
  status?: number;
  code?: string;
  constructor(message: string, opts?: { status?: number; code?: string }) {
    super(message);
    this.name = 'ManagedAppsError';
    this.status = opts?.status;
    this.code = opts?.code;
  }
}

// ---------------------------------------------------------------------------
// Normalize helpers (mirror composio.ts fetchComposioClient + camelCase)
// ---------------------------------------------------------------------------

function firstString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function normalizeApp(raw: unknown): ComposioApp {
  const r = (raw ?? {}) as Record<string, unknown>;
  const appId = String(r.app_id ?? r.appId ?? r.slug ?? r.id ?? r.name ?? '');
  return {
    appId,
    name: String(r.name ?? appId),
    description: typeof r.description === 'string' ? r.description : undefined,
    logo: typeof r.logo === 'string' ? r.logo : undefined,
    categories: Array.isArray(r.categories) ? r.categories.map(String) : undefined,
  };
}

function normalizeConnectedAccount(raw: unknown): ComposioConnectedAccount | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const id = firstString(r.id, r.nanoid, r.connected_account_id, r.accountId);
  if (!id) return null;
  const toolkit = (r.toolkit ?? {}) as Record<string, unknown>;
  const toolkitSlug =
    firstString(r.toolkit_slug, toolkit.slug, r.toolkitSlug) ??
    firstString(r.app_id, r.appId, r.slug) ??
    '';
  return {
    id,
    toolkitSlug,
    toolkitName: firstString(r.toolkit_name, toolkit.name, r.toolkitName),
    status: firstString(r.status, r.state) ?? 'UNKNOWN',
    createdAt: firstString(r.created_at, r.createdAt),
  };
}

function normalizeTool(raw: unknown): ComposioToolDefinition | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const slug = firstString(r.slug, r.name, r.tool_slug);
  if (!slug) return null;
  const params = r.inputParameters ?? r.input_parameters;
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

function arrayOf(body: unknown, keys: string[]): unknown[] {
  if (Array.isArray(body)) return body;
  const b = (body ?? {}) as Record<string, unknown>;
  for (const k of keys) {
    if (Array.isArray(b[k])) return b[k] as unknown[];
  }
  if (Array.isArray(b.items)) return b.items;
  if (Array.isArray(b.results)) return b.results;
  return [];
}

function codeOf(body: unknown): string | undefined {
  const b = (body ?? {}) as Record<string, unknown>;
  return typeof b.code === 'string' ? b.code : undefined;
}

/**
 * Map a non-2xx managed-service response to the error wording the chat/UI
 * surfaces rely on:
 *   403 + not_entitled            → "not included in your plan"
 *   429 + quota_exceeded /
 *         operator_cap_reached    → "managed allowance" + the code
 */
function managedError(status: number, body: unknown, context: string): ManagedAppsError {
  const code = codeOf(body);
  if (status === 403 && code === 'not_entitled') {
    return new ManagedAppsError(
      `${context}: this app or action is not included in your plan (not_entitled)`,
      { status, code },
    );
  }
  if (status === 429 && (code === 'quota_exceeded' || code === 'operator_cap_reached')) {
    return new ManagedAppsError(
      `${context}: managed allowance exceeded (${code}) — the managed plan allowance for this period is used up`,
      { status, code },
    );
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const detail =
    typeof b.error === 'string' ? b.error : typeof b.message === 'string' ? b.message : undefined;
  return new ManagedAppsError(
    `${context} failed (HTTP ${status})${code ? ` [${code}]` : ''}${detail ? `: ${detail}` : ''}`,
    { status, code },
  );
}

interface ManagedResponse {
  status: number;
  ok: boolean;
  body: unknown;
}

async function managedRequest(
  fetchFn: ManagedFetch,
  serviceUrl: string,
  token: string,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<ManagedResponse> {
  const res = await fetchFn(`${serviceUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(20_000) : undefined,
  });
  const parsed: unknown = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, body: parsed };
}

function usageOf(body: unknown): ManagedUsage {
  const b = (body ?? {}) as Record<string, unknown>;
  const usage: ManagedUsage = {};
  if (typeof b.plan === 'string' && b.plan) usage.plan = b.plan;
  if (typeof b.used === 'number' && Number.isFinite(b.used)) usage.used = b.used;
  if (typeof b.quota === 'number' && Number.isFinite(b.quota)) usage.quota = b.quota;
  if (typeof b.month === 'string' && b.month) usage.month = b.month;
  if (typeof b.globalCapReached === 'boolean') usage.globalCapReached = b.globalCapReached;
  return usage;
}

/**
 * Fetch the caller's managed usage (GET /v1/usage). Throws a
 * ManagedAppsError carrying the HTTP status on any failure — callers map
 * 401/403 to "token rejected" and everything else to "service unreachable",
 * or fail soft (status route).
 */
export async function fetchManagedUsage(
  serviceUrl: string,
  token: string,
  fetchFn: ManagedFetch = globalThis.fetch,
): Promise<ManagedUsage> {
  const root = serviceUrl.replace(/\/+$/, '');
  let res: ManagedResponse;
  try {
    res = await managedRequest(fetchFn, root, token, 'GET', '/v1/usage');
  } catch (err) {
    throw new ManagedAppsError(
      `Could not reach the managed apps service: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) throw managedError(res.status, res.body, 'Managed usage check');
  return usageOf(res.body);
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export function createManagedComposioClient(opts: {
  serviceUrl: string;
  token: string;
  /** Injectable fetch for tests; defaults to the global fetch. */
  fetchFn?: ManagedFetch;
}): ComposioClient {
  const fetchFn: ManagedFetch = opts.fetchFn ?? globalThis.fetch;
  const root = opts.serviceUrl.replace(/\/+$/, '');
  const token = opts.token;

  /** Authenticated request that throws the mapped managed errors on non-2xx. */
  async function call(
    method: string,
    path: string,
    context: string,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    const res = await managedRequest(fetchFn, root, token, method, path, body);
    if (!res.ok) throw managedError(res.status, res.body, context);
    return res.body;
  }

  const client: ComposioClient = {
    /**
     * Validate a token against GET /v1/usage: 200 = valid (the plan is
     * mapped into orgName, the field the existing connect flow audits);
     * 401/403 = rejected. A candidate apiKey argument wins over the
     * closure token so pre-storage validation works.
     */
    async validateApiKey(apiKey: string): Promise<ComposioValidateResult> {
      const bearer = typeof apiKey === 'string' && apiKey.length > 0 ? apiKey : token;
      let res: ManagedResponse;
      try {
        res = await managedRequest(fetchFn, root, bearer, 'GET', '/v1/usage');
      } catch (err) {
        throw new ManagedAppsError(
          `Could not reach the managed apps service: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (res.status === 401) return { ok: false };
      if (res.status === 403 && codeOf(res.body) !== 'not_entitled') return { ok: false };
      if (!res.ok) throw managedError(res.status, res.body, 'Managed token validation');
      const usage = usageOf(res.body);
      return { ok: true, ...(usage.plan ? { orgName: usage.plan } : {}) };
    },

    async listApps(_apiKey: string): Promise<ComposioApp[]> {
      const body = await call('GET', '/v1/apps', 'Managed app list');
      return arrayOf(body, ['apps'])
        .map(normalizeApp)
        .filter((a) => a.appId.length > 0);
    },

    async createAuthLink(
      _apiKey: string,
      linkOpts: { toolkitSlug: string; userId: string; label?: string },
    ): Promise<{ redirectUrl: string }> {
      const body = (await call('POST', '/v1/connect-link', 'Managed connect link', {
        toolkitSlug: linkOpts.toolkitSlug,
        ...(linkOpts.label ? { label: linkOpts.label } : {}),
      })) as Record<string, unknown>;
      const redirectUrl = firstString(body.redirectUrl, body.redirect_url, body.link, body.url);
      if (!redirectUrl) throw new Error('Managed apps service did not return a connect redirect URL');
      return { redirectUrl };
    },

    async listConnectedAccounts(_apiKey: string, _userId: string): Promise<ComposioConnectedAccount[]> {
      const body = await call('GET', '/v1/accounts', 'Managed connected-account list');
      return arrayOf(body, ['accounts'])
        .map(normalizeConnectedAccount)
        .filter((a): a is ComposioConnectedAccount => a !== null);
    },

    async getConnectedAccount(_apiKey: string, nanoid: string): Promise<ComposioConnectedAccount | null> {
      // The service contract has no single-account GET — resolve via the list.
      const accounts = await client.listConnectedAccounts(_apiKey, '');
      return accounts.find((a) => a.id === nanoid) ?? null;
    },

    async deleteConnectedAccount(_apiKey: string, nanoid: string): Promise<void> {
      const res = await managedRequest(
        fetchFn, root, token, 'DELETE', `/v1/accounts/${encodeURIComponent(nanoid)}`,
      );
      if (res.status === 404) return; // Already gone — idempotent.
      if (!res.ok) throw managedError(res.status, res.body, 'Managed connected-account delete');
    },

    async revokeConnectedAccount(_apiKey: string, nanoid: string): Promise<void> {
      // The managed service revokes the provider grant as part of delete;
      // there is no separate revoke endpoint in the contract.
      await client.deleteConnectedAccount(_apiKey, nanoid);
    },

    async listTools(_apiKey: string, toolkitSlug?: string): Promise<ComposioToolDefinition[]> {
      const path = toolkitSlug
        ? `/v1/tools?toolkitSlug=${encodeURIComponent(toolkitSlug)}`
        : '/v1/tools';
      const body = await call('GET', path, 'Managed tool list');
      return arrayOf(body, ['tools'])
        .map(normalizeTool)
        .filter((t): t is ComposioToolDefinition => t !== null);
    },

    async executeTool(
      _apiKey: string,
      input: { toolSlug: string; connectedAccountId: string; userId: string; args: Record<string, unknown> },
    ): Promise<ComposioExecuteResult> {
      const body = (await call('POST', '/v1/execute', 'Managed tool execution', {
        accountId: input.connectedAccountId,
        actionName: input.toolSlug,
        arguments: input.args,
        kind: 'chat',
      })) as Record<string, unknown>;
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
  return client;
}
