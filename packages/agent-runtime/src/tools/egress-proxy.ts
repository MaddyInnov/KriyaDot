// SPDX-License-Identifier: Apache-2.0
//
// Per-mission network egress journal (Timon parity programme, item A13).
//
// WHY THIS EXISTS
// KriyaDot's audit trail records WHICH tools ran, but not WHERE a
// sandboxed command connected. This module adds the missing destination
// record for the one path the runtime controls end to end: the child
// process environment of sandboxed command execution (run_command).
//
// HOW IT WORKS
// When the feature is enabled for a run, the runtime starts a per-run
// forward proxy bound to 127.0.0.1 on an ephemeral port and injects
// HTTP_PROXY / HTTPS_PROXY (plus lowercase variants) into the sandboxed
// child's environment. The run id travels as the proxy credential
// (the Basic-auth username), so journal entries attribute to the run
// even if a client passes the credential through explicitly.
//
// WHAT IS JOURNALED — AND WHAT IS NEVER JOURNALED
// Per connection: run id, host, port, bytes up/down (counted on the
// proxy's sockets, so TLS payloads count as ciphertext bytes), a status,
// and a timestamp. NEVER journaled: URL paths, query strings, headers,
// bodies, or credentials — they routinely carry secrets. For HTTPS the
// journal sees only the CONNECT host:port (the TLS stream is opaque by
// design). For plain HTTP the path is stripped before journaling; the
// proxy itself forwards the request with standard forward-proxy
// semantics, but only host:port reaches the journal sink.
//
// THREAT MODEL / HONEST LIMITS — "Visible, not confined"
// This is a VISIBILITY layer, not a confinement layer. It records the
// traffic that voluntarily honours the proxy environment variables. It
// does NOT see, and must never be described as covering:
//   - processes that connect directly (raw IPs, tools that ignore
//     *_PROXY env, statically-linked clients with their own resolvers),
//   - desktop / browser / API-server traffic (out of scope for A13 —
//     the API server's own provider calls are NOT proxied here),
//   - host-opt-out executions (SANDBOX_ALLOW_HOST / SANDBOX_BACKEND=host
//     semantics are unchanged; such runs only journal if the caller
//     still routes them through this proxy env, which the sandbox layer
//     does for the local host backend),
//   - container (Docker) and cloud (E2B) sandbox backends: a localhost
//     proxy is unreachable from inside them, so those runs report
//     journaling as UNAVAILABLE instead of pretending coverage.
// Failure posture: a proxy that cannot start, or a journal sink that
// throws, fails the JOURNAL — never the mission. The run proceeds
// without proxy env and the unavailability is itself journaled/logged.

import http from 'node:http';
import net from 'node:net';

/** The one honest label every surface for this feature must carry. */
export const EGRESS_JOURNAL_LABEL = 'Visible, not confined';

/** Copy fragment reused by settings + Activity so wording never drifts. */
export const EGRESS_JOURNAL_LIMITS =
  'Records host and port only (never paths, headers, or content) for sandboxed commands that use the proxy. ' +
  'Traffic that bypasses the proxy — direct connections, desktop/browser traffic, and host-opt-out runs — is NOT covered.';

/** Audit action/kind under which egress entries land in the Activity store. */
export const EGRESS_AUDIT_KIND = 'egress';

export type EgressConnectionStatus =
  | 'forwarded' // plain-HTTP request proxied to the origin
  | 'tunnel-established' // CONNECT tunnel opened (HTTPS / opaque TCP)
  | 'tunnel-failed' // CONNECT target unreachable / refused
  | 'failed' // plain-HTTP upstream error
  | 'unavailable'; // journaling was requested but could not be provided

/** One journal record. Deliberately has NO path/query/header/body fields. */
export interface EgressJournalEntry {
  runId: string;
  host: string;
  port: number;
  bytesUp: number;
  bytesDown: number;
  status: EgressConnectionStatus;
  /** Epoch ms when the connection started (or the note was written). */
  ts: number;
}

/**
 * Journal sink: receives one entry per connection. May be sync or async;
 * the proxy NEVER lets a sink error affect the proxied traffic.
 */
export type EgressJournalSink = (entry: EgressJournalEntry) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Settings (opt-in, default OFF — same posture as product analytics)
// ---------------------------------------------------------------------------

export interface EgressJournalSettings {
  /** Master switch. Default false. */
  enabled: boolean;
}

export const DEFAULT_EGRESS_JOURNAL_SETTINGS: EgressJournalSettings = { enabled: false };

/** Boot-time env opt-in: KRIYADOT_EGRESS_JOURNAL=1|true|yes. */
export function egressJournalEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.KRIYADOT_EGRESS_JOURNAL ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Process-wide settings holder. The API layer loads the persisted
 * settings file into this holder at boot (egress-routes.ts); the
 * run_command tool reads it per call. Default: env boot value or OFF.
 */
class EgressJournalSettingsHolder {
  private current: EgressJournalSettings = {
    enabled: egressJournalEnabledFromEnv(),
  };

  getSettings(): EgressJournalSettings {
    return { ...this.current };
  }

  updateSettings(next: Partial<EgressJournalSettings>): EgressJournalSettings {
    this.current = { enabled: next.enabled === true };
    return this.getSettings();
  }

  get isEnabled(): boolean {
    return this.current.enabled;
  }
}

export const egressJournalSettings = new EgressJournalSettingsHolder();

/** True when egress journaling is currently enabled (default OFF). */
export function isEgressJournalEnabled(): boolean {
  return egressJournalSettings.isEnabled;
}

// ---------------------------------------------------------------------------
// Target parsing — host:port ONLY ever leaves this section
// ---------------------------------------------------------------------------

/** Parse `host:port` (CONNECT authority form). Returns null when malformed. */
export function parseAuthority(authority: string): { host: string; port: number } | null {
  const a = authority.trim();
  if (!a) return null;
  if (a.startsWith('[')) {
    const close = a.indexOf(']');
    if (close < 0) return null;
    const host = a.slice(1, close).toLowerCase();
    const rest = a.slice(close + 1);
    const port = rest.startsWith(':') ? Number(rest.slice(1)) : 443;
    return host && Number.isInteger(port) && port > 0 && port <= 65535 ? { host, port } : null;
  }
  const idx = a.lastIndexOf(':');
  if (idx < 0) return { host: a.toLowerCase(), port: 443 };
  const host = a.slice(0, idx).toLowerCase();
  const port = Number(a.slice(idx + 1));
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host, port };
}

/**
 * Extract host:port from a plain-HTTP proxy request WITHOUT retaining
 * the path/query: absolute-form URLs are parsed and only the authority
 * is kept; origin-form falls back to the Host header.
 */
export function httpTargetOf(req: http.IncomingMessage): { host: string; port: number } | null {
  const raw = req.url ?? '';
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
      return u.hostname ? { host: u.hostname.toLowerCase(), port } : null;
    } catch {
      return null;
    }
  }
  const hostHeader = req.headers.host;
  if (typeof hostHeader === 'string' && hostHeader) {
    const parsed = parseAuthority(hostHeader);
    if (parsed) {
      // No explicit :port in the Host header → plain-HTTP default (80),
      // not parseAuthority's CONNECT default (443).
      const hasExplicitPort = /:\d+$/.test(hostHeader) && !hostHeader.endsWith(']');
      return { host: parsed.host, port: hasExplicitPort ? parsed.port : 80 };
    }
  }
  return null;
}

/** Run id from the Proxy-Authorization Basic username (never journaled itself). */
function runIdFromProxyAuth(req: http.IncomingMessage): string | undefined {
  const header = req.headers['proxy-authorization'];
  if (typeof header !== 'string') return undefined;
  const m = /^Basic\s+(.+)$/i.exec(header.trim());
  if (!m) return undefined;
  try {
    const decoded = Buffer.from(m[1], 'base64').toString('utf8');
    const user = decoded.split(':')[0]?.trim();
    return user ? user : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// The proxy
// ---------------------------------------------------------------------------

export interface EgressProxyHandle {
  /** Port the proxy listens on (127.0.0.1 only). */
  port: number;
  /** Proxy URL WITHOUT credentials, e.g. http://127.0.0.1:54321 */
  proxyUrl: string;
  /**
   * Child-process env for one run: upper+lowercase proxy vars with the
   * run id as the credential username, and NO_PROXY emptied so even
   * loopback destinations are journaled rather than silently bypassed.
   */
  env: Record<string, string>;
  /** Stop listening and drain/destroy live sockets. Never throws. */
  close: () => Promise<void>;
}

export interface StartEgressProxyOptions {
  runId: string;
  sink: EgressJournalSink;
  /** Test seam: bind a specific port (default 0 = ephemeral). */
  port?: number;
}

/**
 * Start the per-run forward proxy on 127.0.0.1. Throws when the proxy
 * cannot start — callers must treat that as "journal unavailable" and
 * run WITHOUT proxy env (see sandbox.ts), never as a mission failure.
 */
export async function startEgressProxy(opts: StartEgressProxyOptions): Promise<EgressProxyHandle> {
  const { sink } = opts;
  const defaultRunId = opts.runId;
  const sockets = new Set<net.Socket>();

  const journal = (entry: EgressJournalEntry): void => {
    // A failing journal must fail the journal, not the mission: sink
    // errors (sync or async) are swallowed here, by construction.
    try {
      const res = sink(entry);
      if (res instanceof Promise) res.catch(() => undefined);
    } catch {
      /* journal failure never breaks traffic */
    }
  };

  const server = http.createServer();

  server.on('connection', (socket: net.Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  // -- Plain HTTP forwarding (standard forward-proxy semantics) --------
  server.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
    const target = httpTargetOf(req);
    if (!target) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('Bad proxy request');
      return;
    }
    const runId = runIdFromProxyAuth(req) ?? defaultRunId;
    const ts = Date.now();
    // Byte accounting "as measurable": bodies are counted on the wire;
    // the request head is counted from the raw headers the client sent
    // (headers are MEASURED here, never journaled).
    let bytesUp = Buffer.byteLength(
      `${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/${req.httpVersion}\r\n${(req.rawHeaders ?? []).join('\r\n')}\r\n\r\n`,
    );
    let bytesDown = 0;
    let journaled = false;
    const finish = (status: EgressConnectionStatus): void => {
      if (journaled) return;
      journaled = true;
      journal({ runId, host: target.host, port: target.port, bytesUp, bytesDown, status, ts });
    };

    const headers: http.OutgoingHttpHeaders = { ...req.headers };
    delete headers['proxy-authorization']; // the run credential never leaves this machine
    delete headers['proxy-connection'];
    // Forward with the path the CLIENT asked for (proxying behaviour is
    // standard); the journal above only ever received host:port.
    let upstreamPath = req.url ?? '/';
    if (/^https?:\/\//i.test(upstreamPath)) {
      try {
        const u = new URL(upstreamPath);
        upstreamPath = u.pathname + u.search;
      } catch {
        upstreamPath = '/';
      }
    }
    const upstream = http.request(
      {
        host: target.host,
        port: target.port,
        method: req.method ?? 'GET',
        path: upstreamPath,
        headers,
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.on('data', (chunk: Buffer) => {
          bytesDown += chunk.length;
        });
        upRes.pipe(res);
        upRes.on('end', () => finish('forwarded'));
        upRes.on('error', () => finish('failed'));
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end('Bad gateway');
      } else {
        res.destroy();
      }
      finish('failed');
    });
    req.on('data', (chunk: Buffer) => {
      bytesUp += chunk.length;
    });
    req.pipe(upstream);
    res.on('close', () => finish('forwarded'));
  });

  // -- CONNECT tunnelling (HTTPS): host:port only, payload is opaque ---
  server.on('connect', (req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer) => {
    const target = parseAuthority(req.url ?? '');
    const runId = runIdFromProxyAuth(req) ?? defaultRunId;
    const ts = Date.now();
    if (!target) {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    let bytesUp = 0;
    let bytesDown = 0;
    let established = false;
    let journaled = false;
    const finish = (): void => {
      if (journaled) return;
      journaled = true;
      journal({
        runId,
        host: target.host,
        port: target.port,
        bytesUp,
        bytesDown,
        status: established ? 'tunnel-established' : 'tunnel-failed',
        ts,
      });
    };
    const upstream = net.connect(target.port, target.host, () => {
      established = true;
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length > 0) {
        bytesUp += head.length;
        upstream.write(head);
      }
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });
    clientSocket.on('data', (chunk: Buffer) => {
      bytesUp += chunk.length;
    });
    upstream.on('data', (chunk: Buffer) => {
      bytesDown += chunk.length;
    });
    upstream.on('error', () => {
      if (!established && !clientSocket.destroyed) {
        clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      } else {
        clientSocket.destroy();
      }
      finish();
    });
    clientSocket.on('error', () => {
      upstream.destroy();
      finish();
    });
    clientSocket.on('close', () => {
      upstream.destroy();
      finish();
    });
    upstream.on('close', () => {
      clientSocket.destroy();
      finish();
    });
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const onError = (err: Error): void => rejectPromise(err);
    server.once('error', onError);
    // Localhost ONLY — this proxy must never be reachable off-box.
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolvePromise();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('egress proxy: could not determine listening port');
  }
  const port = address.port;
  const proxyUrl = `http://127.0.0.1:${port}`;
  const credentialed = `http://${encodeURIComponent(defaultRunId)}@127.0.0.1:${port}`;
  const env: Record<string, string> = {
    HTTP_PROXY: credentialed,
    HTTPS_PROXY: credentialed,
    http_proxy: credentialed,
    https_proxy: credentialed,
    // Empty NO_PROXY: loopback tool traffic is journaled too, instead of
    // silently bypassing the proxy via a pre-existing localhost exemption.
    NO_PROXY: '',
    no_proxy: '',
  };

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    const done = new Promise<void>((resolvePromise) => {
      server.close(() => resolvePromise());
    });
    // Give in-flight sockets a brief chance to finish (and journal)
    // naturally, then destroy the rest — destroying fires their close
    // handlers, which is what emits the final journal entries.
    await new Promise((r) => setTimeout(r, 50));
    for (const socket of sockets) socket.destroy();
    await Promise.race([done, new Promise((r) => setTimeout(r, 1_000))]);
  };

  return { port, proxyUrl, env, close };
}

/**
 * Build the "journaling unavailable" note entry (status 'unavailable').
 * Used when egress journaling was requested but the proxy could not be
 * provided for this run (proxy start failure, or a backend that cannot
 * reach a localhost proxy) — the run proceeds, and the gap is on record
 * rather than silently implied as coverage.
 */
export function egressUnavailableEntry(runId: string): EgressJournalEntry {
  return { runId, host: '(none)', port: 0, bytesUp: 0, bytesDown: 0, status: 'unavailable', ts: Date.now() };
}

/** Best-effort journaling of an unavailable note; never throws. */
export function journalEgressUnavailable(sink: EgressJournalSink, runId: string): void {
  try {
    const res = sink(egressUnavailableEntry(runId));
    if (res instanceof Promise) res.catch(() => undefined);
  } catch {
    /* the note is best-effort; the mission continues regardless */
  }
}
