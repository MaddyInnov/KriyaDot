// SPDX-License-Identifier: Apache-2.0
// Home-device control proxy (Muse parity audit §4.14, DV-13).
//
// A single governed path for talking HTTP to devices on the user's own
// network (smart plugs, bridges, printers, …):
//
//   - FIRST contact with a host requires an explicit approval. A call to an
//     unapproved host does NOT touch the network: it records a pending
//     request and returns { status: 'approval_required', hostKey }.
//   - Approval is per host:port (HostGrantStore, persisted to
//     <dataDir>/home-host-grants.json) and is granted out-of-band by the
//     user (routes below / the web UI) — a bot can never approve its own
//     first contact.
//   - Subsequent calls ride the grant until it is revoked or expires.
//   - EVERY outcome is audited: approval_required, denied-by-absence,
//     proxied calls (method + path + status — never bodies or headers,
//     which may carry device credentials), approvals and revocations.
//
// Device-specific clients (Shelly DV-15, HAP DV-14, IPP DV-16) can ride
// this proxy by using `proxyTransport()` as their injectable transport.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Request, Response, Router } from 'express';
import type { ToolContext, ToolDefinition } from '@mvp/agent-runtime';
import { PAUSED_MESSAGE } from './system-pause.js';

// ---------------------------------------------------------------------------
// Host keys
// ---------------------------------------------------------------------------

const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;

/**
 * Normalize a host reference ("192.168.1.20", "plug.local:80",
 * "http://192.168.1.20:8080/x") to a canonical `host:port` grant key.
 * Rejects credentials-in-URL, paths-as-identity tricks and junk input:
 * a grant must name exactly one network endpoint.
 */
export function normalizeHostKey(input: string, defaultPort = 80): string {
  if (typeof input !== 'string' || !input.trim() || input.length > 253) {
    throw new Error('"host" is required (host, host:port, or an http(s) URL)');
  }
  let host = input.trim();
  let port = defaultPort;
  if (/^https?:\/\//i.test(host)) {
    let url: URL;
    try { url = new URL(host); } catch { throw new Error('"host" URL is not parseable'); }
    if (url.username || url.password) throw new Error('"host" must not embed credentials');
    host = url.hostname;
    port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  } else {
    const m = /^(.+):(\d{1,5})$/.exec(host);
    if (m) {
      host = m[1] as string;
      port = Number(m[2]);
    }
  }
  host = host.toLowerCase();
  if (!HOST_RE.test(host)) throw new Error(`"host" ${JSON.stringify(host)} is not a valid hostname or IP`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('"port" must be 1-65535');
  return `${host}:${port}`;
}

// ---------------------------------------------------------------------------
// Grant store
// ---------------------------------------------------------------------------

export interface HostGrant {
  hostKey: string;
  label?: string;
  approvedAt: number;
  approvedBy?: string;
  /** Epoch ms; absent = no expiry. Expired grants behave as unapproved. */
  expiresAt?: number;
}

export interface PendingHostRequest {
  hostKey: string;
  firstRequestedAt: number;
  lastRequestedAt: number;
  attempts: number;
  lastMethod?: string;
  lastPath?: string;
}

interface GrantFile {
  grants: HostGrant[];
  pending: PendingHostRequest[];
}

export class HostGrantStore {
  private readonly file: string;
  private state: GrantFile = { grants: [], pending: [] };

  constructor(dataDir: string) {
    this.file = join(dataDir, 'home-host-grants.json');
    try {
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<GrantFile>;
        if (Array.isArray(raw.grants)) this.state.grants = raw.grants.filter(isGrant);
        if (Array.isArray(raw.pending)) this.state.pending = raw.pending.filter(isPending);
      }
    } catch { /* corrupt store → empty; approvals are re-earnable, never guessed */ }
  }

  private save(): void {
    mkdirSync(join(this.file, '..'), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.state, null, 2), 'utf8');
  }

  getGrant(hostKey: string, now: number = Date.now()): HostGrant | undefined {
    const g = this.state.grants.find((x) => x.hostKey === hostKey);
    if (!g) return undefined;
    if (g.expiresAt !== undefined && g.expiresAt <= now) return undefined;
    return g;
  }

  listGrants(): HostGrant[] {
    return [...this.state.grants];
  }

  listPending(): PendingHostRequest[] {
    return [...this.state.pending];
  }

  approve(hostKey: string, opts: { label?: string; approvedBy?: string; ttlMs?: number; now?: number } = {}): HostGrant {
    const now = opts.now ?? Date.now();
    const grant: HostGrant = {
      hostKey,
      ...(opts.label ? { label: opts.label } : {}),
      approvedAt: now,
      ...(opts.approvedBy ? { approvedBy: opts.approvedBy } : {}),
      ...(opts.ttlMs ? { expiresAt: now + opts.ttlMs } : {}),
    };
    this.state.grants = [...this.state.grants.filter((g) => g.hostKey !== hostKey), grant];
    this.state.pending = this.state.pending.filter((p) => p.hostKey !== hostKey);
    this.save();
    return grant;
  }

  revoke(hostKey: string): boolean {
    const before = this.state.grants.length;
    this.state.grants = this.state.grants.filter((g) => g.hostKey !== hostKey);
    if (this.state.grants.length !== before) {
      this.save();
      return true;
    }
    return false;
  }

  /** Record a first-contact attempt (no grant yet). Returns the pending row. */
  notePending(hostKey: string, method: string, path: string, now: number = Date.now()): PendingHostRequest {
    const existing = this.state.pending.find((p) => p.hostKey === hostKey);
    if (existing) {
      existing.lastRequestedAt = now;
      existing.attempts += 1;
      existing.lastMethod = method;
      existing.lastPath = path;
      this.save();
      return existing;
    }
    const row: PendingHostRequest = {
      hostKey, firstRequestedAt: now, lastRequestedAt: now, attempts: 1, lastMethod: method, lastPath: path,
    };
    this.state.pending.push(row);
    this.save();
    return row;
  }
}

function isGrant(v: unknown): v is HostGrant {
  return !!v && typeof v === 'object' && typeof (v as HostGrant).hostKey === 'string' && typeof (v as HostGrant).approvedAt === 'number';
}
function isPending(v: unknown): v is PendingHostRequest {
  return !!v && typeof v === 'object' && typeof (v as PendingHostRequest).hostKey === 'string';
}

// ---------------------------------------------------------------------------
// Proxy
// ---------------------------------------------------------------------------

export interface HttpTransportRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface HttpTransportResponse {
  status: number;
  bodyText: string;
}

export type HttpTransport = (req: HttpTransportRequest) => Promise<HttpTransportResponse>;

/** Default transport: global fetch, no redirect following beyond fetch defaults, 10s cap. */
export const fetchHttpTransport: HttpTransport = async (req) => {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
    signal: AbortSignal.timeout(10_000),
  });
  return { status: res.status, bodyText: await res.text() };
};

export type ProxyCallResult =
  | { status: 'approval_required'; hostKey: string; pending: PendingHostRequest }
  | { status: 'ok'; hostKey: string; httpStatus: number; bodyText: string }
  | { status: 'transport_error'; hostKey: string; error: string };

export interface HomeProxyAudit {
  (action: string, fields: { actor?: string; toolName?: string; detail?: unknown; sessionId?: string }): void;
}

export class HomeControlProxy {
  constructor(
    private readonly store: HostGrantStore,
    private readonly transport: HttpTransport = fetchHttpTransport,
    private readonly audit?: HomeProxyAudit,
  ) {}

  private emit(action: string, detail: unknown, actor?: string): void {
    try { this.audit?.(action, { actor, detail }); } catch { /* audit must never break control */ }
  }

  /**
   * Call a device through the proxy. Unapproved host → approval_required
   * (network untouched, pending recorded, audited). Approved → proxied +
   * audited (method/path/status only).
   */
  async call(input: {
    host: string;
    method?: string;
    path: string;
    body?: string;
    headers?: Record<string, string>;
    actor?: string;
  }): Promise<ProxyCallResult> {
    const hostKey = normalizeHostKey(input.host);
    const method = (input.method ?? 'GET').toUpperCase();
    if (!/^[A-Z]+$/.test(method) || method.length > 10) throw new Error('"method" is invalid');
    const path = input.path;
    if (typeof path !== 'string' || !path.startsWith('/') || path.length > 2048) {
      throw new Error('"path" must be an absolute path starting with "/"');
    }
    const grant = this.store.getGrant(hostKey);
    if (!grant) {
      const pending = this.store.notePending(hostKey, method, path);
      this.emit('home_proxy.approval_required', { hostKey, method, path }, input.actor);
      return { status: 'approval_required', hostKey, pending };
    }
    const [host, port] = splitHostKey(hostKey);
    const scheme = port === '443' ? 'https' : 'http';
    const url = `${scheme}://${host}${port && port !== '80' && port !== '443' ? `:${port}` : ''}${path}`;
    try {
      const res = await this.transport({ method, url, headers: input.headers, body: input.body });
      this.emit('home_proxy.call', { hostKey, method, path, httpStatus: res.status }, input.actor);
      return { status: 'ok', hostKey, httpStatus: res.status, bodyText: res.bodyText };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.emit('home_proxy.transport_error', { hostKey, method, path, error }, input.actor);
      return { status: 'transport_error', hostKey, error };
    }
  }

  approve(hostKeyInput: string, opts: { label?: string; approvedBy?: string; ttlMs?: number } = {}): HostGrant {
    const hostKey = normalizeHostKey(hostKeyInput);
    const grant = this.store.approve(hostKey, opts);
    this.emit('home_proxy.approved', { hostKey, approvedBy: opts.approvedBy });
    return grant;
  }

  revoke(hostKeyInput: string): boolean {
    const hostKey = normalizeHostKey(hostKeyInput);
    const ok = this.store.revoke(hostKey);
    if (ok) this.emit('home_proxy.revoked', { hostKey });
    return ok;
  }
}

function splitHostKey(hostKey: string): [string, string] {
  const idx = hostKey.lastIndexOf(':');
  return [hostKey.slice(0, idx), hostKey.slice(idx + 1)];
}

/**
 * Adapt the proxy to the simple (url, init) → {status, bodyText} transport
 * shape device clients (Shelly/HAP/IPP) consume: the client builds full
 * URLs, the proxy extracts the host, enforces the grant, and forwards the
 * path. Throws an `approval_required` Error for unapproved hosts so client
 * code surfaces it verbatim.
 */
export function proxyTransport(proxy: HomeControlProxy): HttpTransport {
  return async (req) => {
    const url = new URL(req.url);
    const path = url.pathname + url.search;
    const result = await proxy.call({
      host: url.host,
      method: req.method,
      path,
      body: req.body,
      headers: req.headers,
    });
    if (result.status === 'approval_required') {
      throw new Error(`approval_required: first contact with ${result.hostKey} needs the user's approval (Home grants) before any device call is proxied`);
    }
    if (result.status === 'transport_error') throw new Error(`transport error calling ${result.hostKey}: ${result.error}`);
    return { status: result.httpStatus, bodyText: result.bodyText };
  };
}

// ---------------------------------------------------------------------------
// Tool + routes
// ---------------------------------------------------------------------------

export interface HomeProxyToolDeps {
  proxy: HomeControlProxy;
  audit?: HomeProxyAudit;
  isPaused?: () => boolean;
}

export function createHomeProxyTools(deps: HomeProxyToolDeps): ToolDefinition[] {
  return [
    {
      name: 'home_device_call',
      description:
        'Call an HTTP endpoint on a device on the user\'s own network through the DV-13 control proxy. FIRST contact with a host returns approval_required and makes NO network call — the user approves the host once (Home grants), then calls ride the grant. Every call is audited.',
      parameters: {
        type: 'object',
        properties: {
          host: { type: 'string', description: 'Device host, host:port, or http(s) URL base' },
          method: { type: 'string', description: 'HTTP method (default GET)' },
          path: { type: 'string', description: 'Absolute path on the device, e.g. /relay/0?turn=on' },
          body: { type: 'string', description: 'Optional request body' },
        },
        required: ['host', 'path'],
        additionalProperties: false,
      },
      handler: async (args, ctx: ToolContext) => {
        if (deps.isPaused?.()) throw new Error(`paused: ${PAUSED_MESSAGE}`);
        const host = args['host'];
        const path = args['path'];
        if (typeof host !== 'string' || typeof path !== 'string') throw new Error('"host" and "path" are required strings');
        const result = await deps.proxy.call({
          host,
          path,
          method: typeof args['method'] === 'string' ? args['method'] : undefined,
          body: typeof args['body'] === 'string' ? args['body'] : undefined,
          actor: ctx.botId,
        });
        return result;
      },
    } satisfies ToolDefinition,
  ];
}

export function registerHomeProxyTools(registry: Map<string, ToolDefinition>, deps: HomeProxyToolDeps): void {
  for (const tool of createHomeProxyTools(deps)) {
    if (!registry.has(tool.name)) registry.set(tool.name, tool);
  }
}

/** Grant-management routes. Mount under /home-proxy. Approval happens HERE (user surface), never via the bot tool. */
export function registerHomeProxyRoutes(
  router: Router,
  deps: { proxy: HomeControlProxy; store: HostGrantStore },
): void {
  router.get('/grants', (_req: Request, res: Response) => {
    res.json({ ok: true, grants: deps.store.listGrants(), pending: deps.store.listPending() });
  });
  router.post('/grants', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { host?: unknown; label?: unknown; ttlMs?: unknown };
    if (typeof body.host !== 'string') {
      res.status(400).json({ error: 'invalid_host', detail: '"host" is required' });
      return;
    }
    try {
      const grant = deps.proxy.approve(body.host, {
        label: typeof body.label === 'string' ? body.label.slice(0, 80) : undefined,
        ttlMs: typeof body.ttlMs === 'number' && body.ttlMs > 0 ? body.ttlMs : undefined,
        approvedBy: 'user',
      });
      res.json({ ok: true, grant });
    } catch (e) {
      res.status(400).json({ error: 'invalid_host', detail: e instanceof Error ? e.message : String(e) });
    }
  });
  router.delete('/grants/:hostKey', (req: Request, res: Response) => {
    const hostKey = req.params['hostKey'] ?? '';
    res.json({ ok: true, revoked: deps.proxy.revoke(hostKey) });
  });
}
