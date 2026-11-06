// SPDX-License-Identifier: Apache-2.0
// KriyaDot Managed Apps service: one small node:http server that lets
// entitled KriyaDot instances use Composio through the OPERATOR's central
// Composio account ("managed mode"), instead of each user pasting their
// own key (BYOK, which keeps working unchanged in apps/api).
//
// The operator key (KRIYADOT_MANAGED_COMPOSIO_API_KEY) lives ONLY in this
// service's env. It is never returned by any endpoint and never reaches a
// user instance. Without it the Composio-backed routes fail closed with
// 503 { code: 'operator_key_missing' }.
//
// Auth: every /v1 request carries `Authorization: Bearer <token>` where the
// token is the front-door handoff-format Ed25519 token (see auth.ts),
// verified against the front-door PUBLIC key from env. The Composio entity
// id is derived server-side from the token's accountId — any userId /
// entity / user_id field in a request body or query is IGNORED, never read.
//
// Privacy: tool arguments and results transit this service but are never
// stored. Metering is count-only (see store.ts).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { deriveEntityId, resolveFrontdoorPublicKey, verifyServiceToken, type ServiceTokenPayload } from './auth.js';
import { fetchComposioClient, type ComposioClient, type ComposioConnectedAccount } from './composio.js';
import { ManagedStore, monthKeyOf, normalizeKind, type ExecutionKind } from './store.js';

export interface ManagedAppsConfig {
  /** Directory holding usage.jsonl + store.json. Default: env MANAGED_APPS_DATA_DIR or ./data. */
  dataDir?: string;
  /** Front-door public key PEM (override; else MANAGED_APPS_FRONTDOOR_PUBLIC_KEY_PEM / _FILE). */
  frontdoorPublicKeyPem?: string;
  frontdoorPublicKeyFile?: string;
  /** Operator Composio API key (override; else env KRIYADOT_MANAGED_COMPOSIO_API_KEY). */
  operatorKey?: string;
  /** Operator bearer token for GET /v1/operator/usage (override; else env MANAGED_APPS_OPERATOR_TOKEN). */
  operatorToken?: string;
  /** Plans entitled to managed mode (override; else env MANAGED_APPS_ENTITLED_PLANS). */
  entitledPlans?: string[];
  /** Per-plan monthly execution quotas (override; else env MANAGED_APPS_QUOTAS_JSON). */
  quotas?: Record<string, number>;
  /** Global monthly execution cap across all customers (override; else env MANAGED_APPS_GLOBAL_MONTHLY_CAP). */
  globalCap?: number;
  /** Injectable Composio client (tests); defaults to the real fetch client. */
  composioClient?: ComposioClient;
  /** Injectable clock (tests). */
  now?: () => number;
  log?: (msg: string) => void;
}

export interface ResolvedManagedAppsConfig {
  dataDir: string;
  frontdoorPublicKeyPem: string | null;
  operatorKey: string | undefined;
  operatorToken: string | undefined;
  entitledPlans: string[];
  quotas: Record<string, number>;
  globalCap: number;
}

export interface ManagedApps {
  server: Server;
  store: ManagedStore;
  config: ResolvedManagedAppsConfig;
}

export const DEFAULT_ENTITLED_PLANS = ['pro', 'team', 'business'];
export const DEFAULT_QUOTAS: Record<string, number> = { free: 0, pro: 1000, team: 5000, business: 25000 };
export const DEFAULT_GLOBAL_CAP = 100_000;

const MAX_BODY_BYTES = 1024 * 1024;
const ACCOUNT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TOOLKIT_RE = /^[a-z0-9_-]{1,64}$/;

function parseEntitledPlans(raw: string | undefined): string[] {
  if (!raw) return [...DEFAULT_ENTITLED_PLANS];
  const plans = raw.split(',').map((p) => p.trim().toLowerCase()).filter(Boolean);
  return plans.length ? plans : [...DEFAULT_ENTITLED_PLANS];
}

function parseQuotas(raw: string | undefined): Record<string, number> {
  if (!raw) return { ...DEFAULT_QUOTAS };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k.toLowerCase()] = Math.floor(v);
      }
      return out;
    }
  } catch {
    // Fall through to defaults — a bad quotas env must not crash the service.
  }
  return { ...DEFAULT_QUOTAS };
}

function parseGlobalCap(raw: string | undefined): number {
  if (!raw) return DEFAULT_GLOBAL_CAP;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_GLOBAL_CAP;
}

export function resolveManagedAppsConfig(config: ManagedAppsConfig): ResolvedManagedAppsConfig {
  return {
    dataDir: config.dataDir ?? process.env.MANAGED_APPS_DATA_DIR ?? './data',
    frontdoorPublicKeyPem: resolveFrontdoorPublicKey({
      pem: config.frontdoorPublicKeyPem,
      keyFile: config.frontdoorPublicKeyFile,
    }),
    operatorKey: config.operatorKey ?? process.env.KRIYADOT_MANAGED_COMPOSIO_API_KEY ?? undefined,
    operatorToken: config.operatorToken ?? process.env.MANAGED_APPS_OPERATOR_TOKEN ?? undefined,
    entitledPlans: config.entitledPlans
      ? config.entitledPlans.map((p) => p.trim().toLowerCase()).filter(Boolean)
      : parseEntitledPlans(process.env.MANAGED_APPS_ENTITLED_PLANS),
    quotas: config.quotas
      ? Object.fromEntries(Object.entries(config.quotas).map(([k, v]) => [k.toLowerCase(), v]))
      : parseQuotas(process.env.MANAGED_APPS_QUOTAS_JSON),
    globalCap: config.globalCap ?? parseGlobalCap(process.env.MANAGED_APPS_GLOBAL_MONTHLY_CAP),
  };
}

/** Entitled iff the token carries the 'managed-apps' feature OR an entitled plan. */
export function isEntitled(payload: ServiceTokenPayload, entitledPlans: readonly string[]): boolean {
  if (Array.isArray(payload.features) && payload.features.includes('managed-apps')) return true;
  const plan = typeof payload.plan === 'string' ? payload.plan.trim().toLowerCase() : '';
  return plan.length > 0 && entitledPlans.includes(plan);
}

/** Monthly execution quota for a plan; unknown plans get 0. */
export function quotaFor(plan: string | undefined, quotas: Record<string, number>): number {
  if (!plan) return 0;
  const q = quotas[plan.trim().toLowerCase()];
  return typeof q === 'number' ? q : 0;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buf);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

interface Caller {
  payload: ServiceTokenPayload;
  accountId: string;
  entityId: string;
  plan: string;
}

export function createManagedApps(config: ManagedAppsConfig = {}): ManagedApps {
  const resolved = resolveManagedAppsConfig(config);
  const log = config.log ?? ((msg: string) => console.log(msg));
  const now = config.now ?? (() => Date.now());
  const store = new ManagedStore(resolved.dataDir);
  const client: ComposioClient = config.composioClient ?? fetchComposioClient;
  const operatorKey = resolved.operatorKey;

  function currentMonth(): string {
    return monthKeyOf(new Date(now()));
  }

  function authenticate(req: IncomingMessage): Caller | null {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
    const payload = verifyServiceToken(header.slice('Bearer '.length).trim(), resolved.frontdoorPublicKeyPem, now());
    if (!payload) return null;
    return {
      payload,
      accountId: payload.accountId,
      entityId: deriveEntityId(payload.accountId),
      plan: typeof payload.plan === 'string' && payload.plan ? payload.plan : 'free',
    };
  }

  /** Ownership: the normalized ComposioConnectedAccount shape (mirrored
   *  from apps/api) carries no entity/user field, so ownership is verified
   *  by membership in the caller's own connected-account list. */
  async function findOwnedAccount(entityId: string, accountId: string): Promise<ComposioConnectedAccount | null> {
    const mine = await client.listConnectedAccounts(operatorKey!, entityId);
    return mine.find((a) => a.id === accountId) ?? null;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://managed-apps.local');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    // ---- health (no auth) ---------------------------------------------------
    if (method === 'GET' && path === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // ---- operator usage (separate operator token; no user token) ------------
    if (method === 'GET' && path === '/v1/operator/usage') {
      const expected = resolved.operatorToken;
      const header = req.headers.authorization;
      if (!expected || header !== `Bearer ${expected}`) {
        sendJson(res, 401, { code: 'unauthorized', error: 'operator token required' });
        return;
      }
      const month = currentMonth();
      const records = store.readMeter().filter((r) => monthKeyOf(r.ts) === month);
      const byCustomer = new Map<string, { accountId: string; used: number; byToolkit: Record<string, number> }>();
      for (const r of records) {
        let entry = byCustomer.get(r.accountId);
        if (!entry) {
          entry = { accountId: r.accountId, used: 0, byToolkit: {} };
          byCustomer.set(r.accountId, entry);
        }
        entry.used += 1;
        entry.byToolkit[r.toolkit] = (entry.byToolkit[r.toolkit] ?? 0) + 1;
      }
      sendJson(res, 200, {
        month,
        totalUsed: records.length,
        globalCap: resolved.globalCap,
        customers: [...byCustomer.values()].sort((a, b) => a.accountId.localeCompare(b.accountId)),
      });
      return;
    }

    if (!path.startsWith('/v1/')) {
      sendJson(res, 404, { code: 'not_found', error: 'not found' });
      return;
    }

    // ---- auth (every /v1 route below) ---------------------------------------
    const caller = authenticate(req);
    if (!caller) {
      sendJson(res, 401, { code: 'unauthorized', error: 'invalid or expired token' });
      return;
    }
    if (!isEntitled(caller.payload, resolved.entitledPlans)) {
      sendJson(res, 403, { code: 'not_entitled' });
      return;
    }

    // ---- usage (service-local; no Composio key needed) -----------------------
    if (method === 'GET' && path === '/v1/usage') {
      const month = currentMonth();
      sendJson(res, 200, {
        plan: caller.plan,
        used: store.countFor(caller.accountId, month),
        quota: quotaFor(caller.plan, resolved.quotas),
        month,
        globalCapReached: store.totalFor(month) >= resolved.globalCap,
      });
      return;
    }

    // ---- everything below talks to Composio: fail closed without the key ----
    if (!operatorKey) {
      sendJson(res, 503, { code: 'operator_key_missing' });
      return;
    }

    try {
      // GET /v1/apps → { apps }
      if (method === 'GET' && path === '/v1/apps') {
        const apps = await client.listApps(operatorKey);
        sendJson(res, 200, { apps });
        return;
      }

      // POST /v1/connect-link { toolkitSlug, label? } → { redirectUrl }
      if (method === 'POST' && path === '/v1/connect-link') {
        const body = await readJsonBody(req).catch(() => null);
        if (!body) {
          sendJson(res, 400, { code: 'bad_request', error: 'invalid JSON body' });
          return;
        }
        const toolkitSlug = typeof body.toolkitSlug === 'string' ? body.toolkitSlug.trim().toLowerCase() : '';
        if (!TOOLKIT_RE.test(toolkitSlug)) {
          sendJson(res, 400, { code: 'bad_request', error: 'toolkitSlug is required (lowercase letters, digits, _ -)' });
          return;
        }
        const label = typeof body.label === 'string' ? body.label.trim().slice(0, 64) : '';
        const { redirectUrl } = await client.createAuthLink(operatorKey, {
          toolkitSlug,
          userId: caller.entityId,
          label: label || undefined,
        });
        // Remember the pending label (plus the baseline of already-known
        // account ids) so it can be applied when the new account appears.
        let seenIds: string[] = [];
        try {
          seenIds = (await client.listConnectedAccounts(operatorKey, caller.entityId)).map((a) => a.id);
        } catch {
          // Non-fatal: without a baseline, the first account seen for the
          // toolkit on the next list still receives the label.
        }
        store.addPending({
          entityId: caller.entityId,
          toolkitSlug,
          label: label || undefined,
          requestedAt: now(),
          seenIds,
        });
        sendJson(res, 200, { redirectUrl });
        return;
      }

      // GET /v1/accounts → { accounts } merged with service-side labels.
      if (method === 'GET' && path === '/v1/accounts') {
        const live = await client.listConnectedAccounts(operatorKey, caller.entityId);
        // Consume pending labels: a live account for the toolkit that was
        // not known at link time receives the pending label.
        for (const pending of store.listPending(caller.entityId)) {
          const match = live.find((a) => a.toolkitSlug === pending.toolkitSlug && !pending.seenIds.includes(a.id));
          if (match) {
            if (pending.label && !store.getLabel(caller.entityId, match.id)) {
              store.setLabel(caller.entityId, match.id, pending.label);
            }
            store.removePending(caller.entityId, pending.toolkitSlug, pending.requestedAt);
          }
        }
        const accounts = live.map((a) => {
          const label = store.getLabel(caller.entityId, a.id);
          return {
            id: a.id,
            toolkitSlug: a.toolkitSlug,
            ...(a.toolkitName ? { toolkitName: a.toolkitName } : {}),
            status: a.status,
            ...(a.createdAt ? { createdAt: a.createdAt } : {}),
            ...(label ? { label } : {}),
          };
        });
        sendJson(res, 200, { accounts });
        return;
      }

      // POST /v1/accounts/:id/label { label }
      const labelMatch = path.match(/^\/v1\/accounts\/([^/]+)\/label$/);
      if (method === 'POST' && labelMatch) {
        const id = decodeURIComponent(labelMatch[1]!);
        const body = await readJsonBody(req).catch(() => null);
        if (!body) {
          sendJson(res, 400, { code: 'bad_request', error: 'invalid JSON body' });
          return;
        }
        const label = typeof body.label === 'string' ? body.label.trim() : '';
        if (!label || label.length > 64) {
          sendJson(res, 400, { code: 'bad_request', error: 'label is required (1-64 chars)' });
          return;
        }
        if (!ACCOUNT_ID_RE.test(id) || !(await findOwnedAccount(caller.entityId, id))) {
          sendJson(res, 404, { code: 'not_found', error: 'account not found' });
          return;
        }
        store.setLabel(caller.entityId, id, label);
        sendJson(res, 200, { ok: true, id, label });
        return;
      }

      // DELETE /v1/accounts/:id → revoke + delete.
      const deleteMatch = path.match(/^\/v1\/accounts\/([^/]+)$/);
      if (method === 'DELETE' && deleteMatch) {
        const id = decodeURIComponent(deleteMatch[1]!);
        if (!ACCOUNT_ID_RE.test(id) || !(await findOwnedAccount(caller.entityId, id))) {
          sendJson(res, 404, { code: 'not_found', error: 'account not found' });
          return;
        }
        try {
          await client.revokeConnectedAccount(operatorKey, id);
        } catch {
          // Revoke is best-effort; delete is authoritative (same contract
          // as apps/api's deleteConnectedAccount).
        }
        await client.deleteConnectedAccount(operatorKey, id);
        store.deleteLabel(caller.entityId, id);
        sendJson(res, 200, { ok: true });
        return;
      }

      // GET /v1/tools?toolkitSlug= → { tools }
      if (method === 'GET' && path === '/v1/tools') {
        const toolkitSlug = url.searchParams.get('toolkitSlug') ?? undefined;
        const tools = await client.listTools(operatorKey, toolkitSlug || undefined);
        sendJson(res, 200, { tools });
        return;
      }

      // POST /v1/execute { toolkitSlug?, accountId?, actionName, arguments?, kind? }
      if (method === 'POST' && path === '/v1/execute') {
        const body = await readJsonBody(req).catch(() => null);
        if (!body) {
          sendJson(res, 400, { code: 'bad_request', error: 'invalid JSON body' });
          return;
        }
        // NOTE: body.userId / body.entity / body.user_id are never read —
        // the entity is derived from the verified token, full stop.
        const actionName =
          typeof body.actionName === 'string' && body.actionName
            ? body.actionName
            : typeof body.toolSlug === 'string'
              ? body.toolSlug
              : '';
        if (!actionName) {
          sendJson(res, 400, { code: 'bad_request', error: 'actionName is required' });
          return;
        }
        const rawArgs = body.arguments ?? body.args ?? {};
        if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
          sendJson(res, 400, { code: 'bad_request', error: 'arguments must be an object' });
          return;
        }
        const args = rawArgs as Record<string, unknown>;
        const kind: ExecutionKind = normalizeKind(body.kind);
        const requestedAccountId = typeof body.accountId === 'string' ? body.accountId : '';
        const requestedToolkit = typeof body.toolkitSlug === 'string' ? body.toolkitSlug.trim().toLowerCase() : '';

        // Resolve the target among the CALLER's accounts only.
        let target: ComposioConnectedAccount | null = null;
        if (requestedAccountId) {
          target = ACCOUNT_ID_RE.test(requestedAccountId)
            ? await findOwnedAccount(caller.entityId, requestedAccountId)
            : null;
          if (!target) {
            sendJson(res, 404, { code: 'not_found', error: 'account not found' });
            return;
          }
        } else if (requestedToolkit) {
          const mine = await client.listConnectedAccounts(operatorKey, caller.entityId);
          target = mine.find((a) => a.toolkitSlug === requestedToolkit && a.status === 'ACTIVE') ?? null;
          if (!target) {
            sendJson(res, 404, { code: 'not_found', error: 'no active account for toolkit' });
            return;
          }
        } else {
          sendJson(res, 400, { code: 'bad_request', error: 'accountId or toolkitSlug is required' });
          return;
        }

        // Quota checks BEFORE calling Composio (blocked calls are not metered).
        const month = currentMonth();
        const quota = quotaFor(caller.plan, resolved.quotas);
        const used = store.countFor(caller.accountId, month);
        if (used >= quota) {
          sendJson(res, 429, { code: 'quota_exceeded', plan: caller.plan, used, quota });
          return;
        }
        if (store.totalFor(month) >= resolved.globalCap) {
          sendJson(res, 429, { code: 'operator_cap_reached' });
          return;
        }

        // Execute, then meter EVERY attempt (success and upstream failure),
        // count-only: arguments and results are never persisted.
        try {
          const result = await client.executeTool(operatorKey, {
            toolSlug: actionName,
            connectedAccountId: target.id,
            userId: caller.entityId,
            args,
          });
          store.appendMeter({
            ts: new Date(now()).toISOString(),
            accountId: caller.accountId,
            toolkit: target.toolkitSlug,
            action: actionName,
            ok: result.successful === true,
            kind,
          });
          sendJson(res, 200, result);
        } catch (err) {
          store.appendMeter({
            ts: new Date(now()).toISOString(),
            accountId: caller.accountId,
            toolkit: target.toolkitSlug,
            action: actionName,
            ok: false,
            kind,
          });
          const message = err instanceof Error ? err.message : String(err);
          sendJson(res, 502, { code: 'upstream_error', error: message });
        }
        return;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[managed-apps] upstream failure: ${message}`);
      sendJson(res, 502, { code: 'upstream_error', error: message });
      return;
    }

    sendJson(res, 404, { code: 'not_found', error: 'not found' });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      log(`[managed-apps] request failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) sendJson(res, 500, { code: 'internal_error', error: 'internal error' });
      else res.end();
    });
  });

  return { server, store, config: resolved };
}

/** Convenience factory returning just the http.Server (tests listen on port 0). */
export function createManagedAppsServer(config: ManagedAppsConfig = {}): Server {
  return createManagedApps(config).server;
}
