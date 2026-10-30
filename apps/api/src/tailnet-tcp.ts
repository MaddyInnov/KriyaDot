// SPDX-License-Identifier: Apache-2.0
// Governed TCP reach to private machines over the tailnet (Muse parity
// audit §4.14: DV-19, built on the DV-17/18 connector in
// tailscale-connector.ts).
//
// Governance shape — deliberately the same as the other device rails:
//   * The host must be joined to the tailnet (connector status Running).
//   * EVERY destination host needs its own explicit, time-boxed approval
//     (per-host, exact-address match: a MagicDNS name, an IPv4 and an
//     IPv6 address of the same machine are DIFFERENT approvals). One
//     approval covers all TCP ports on that host for its lifetime,
//     matching the connector doc's per-address approval model.
//   * No approval → no dial. There is no fallback to the public
//     internet: the dialer only ever connects to the requested tailnet
//     address, and failures surface as errors, never reroutes.
//   * Every grant, revoke, connect and refusal is audited.
//
// The dialer is injectable so tests never open a real socket.

import { connect as netConnect, type Socket } from 'node:net';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TailscaleConnector } from './tailscale-connector.js';

export type TailnetAudit = (event: string, detail: Record<string, unknown>) => void;

export interface TailnetHostApproval {
  /** Exact address as approved: MagicDNS name, IPv4 or IPv6 literal. */
  host: string;
  approvedAt: number;
  expiresAt: number;
  note?: string;
}

const APPROVALS_FILE = 'tailnet-approvals.json';
export const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_APPROVAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Normalize + validate a tailnet address. Lowercases DNS names, strips a
 * trailing dot and IPv6 brackets. Rejects anything with whitespace, a
 * scheme, a path, or a port (ports are a separate field everywhere).
 */
export function normalizeTailnetHost(input: unknown): string {
  if (typeof input !== 'string') throw new TailnetTcpError('invalid_host', 'host must be a string');
  let host = input.trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host.length === 0 || host.length > 253) throw new TailnetTcpError('invalid_host', 'host is empty or too long');
  if (/[\s/:@]/.test(host.replace(/:/g, '')) || host.includes('://')) {
    throw new TailnetTcpError('invalid_host', 'host must be a bare DNS name or IP literal (no scheme, path or port)');
  }
  const isIpv6 = host.includes(':');
  if (isIpv6) {
    if (!/^[0-9a-f:]+$/.test(host)) throw new TailnetTcpError('invalid_host', 'malformed IPv6 literal');
  } else if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    for (const octet of host.split('.')) {
      if (Number(octet) > 255) throw new TailnetTcpError('invalid_host', 'malformed IPv4 literal');
    }
  } else if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host)) {
    throw new TailnetTcpError('invalid_host', 'malformed DNS name');
  }
  return host;
}

export class TailnetTcpError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

/** Per-host approval store, persisted as JSON (status metadata only — no secrets). */
export class TailnetApprovalStore {
  private readonly file: string;
  private readonly now: () => number;
  private approvals = new Map<string, TailnetHostApproval>();

  constructor(stateDir: string, now: () => number = () => Date.now()) {
    mkdirSync(stateDir, { recursive: true });
    this.file = join(stateDir, APPROVALS_FILE);
    this.now = now;
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as { approvals?: TailnetHostApproval[] };
      for (const a of parsed.approvals ?? []) {
        if (a && typeof a.host === 'string') this.approvals.set(a.host, a);
      }
    } catch {
      // Missing/corrupt file → no approvals (fail closed).
    }
  }

  private persist(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ approvals: [...this.approvals.values()] }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  grant(rawHost: unknown, opts: { ttlMs?: number; note?: string } = {}): TailnetHostApproval {
    const host = normalizeTailnetHost(rawHost);
    const ttl = Math.min(Math.max(opts.ttlMs ?? DEFAULT_APPROVAL_TTL_MS, 60_000), MAX_APPROVAL_TTL_MS);
    const approval: TailnetHostApproval = {
      host,
      approvedAt: this.now(),
      expiresAt: this.now() + ttl,
      ...(opts.note ? { note: String(opts.note).slice(0, 200) } : {}),
    };
    this.approvals.set(host, approval);
    this.persist();
    return approval;
  }

  revoke(rawHost: unknown): boolean {
    const host = normalizeTailnetHost(rawHost);
    const existed = this.approvals.delete(host);
    if (existed) this.persist();
    return existed;
  }

  /** Live (unexpired) approval for exactly this host, else null. Expired entries are pruned. */
  get(rawHost: unknown): TailnetHostApproval | null {
    let host: string;
    try {
      host = normalizeTailnetHost(rawHost);
    } catch {
      return null;
    }
    const approval = this.approvals.get(host);
    if (!approval) return null;
    if (approval.expiresAt <= this.now()) {
      this.approvals.delete(host);
      this.persist();
      return null;
    }
    return approval;
  }

  list(): TailnetHostApproval[] {
    return [...this.approvals.values()].filter((a) => a.expiresAt > this.now());
  }
}

/** Minimal socket surface the proxy needs — real net.Socket satisfies it. */
export interface TailnetSocket {
  end: () => void;
  destroy: (err?: Error) => void;
  on: (event: string, cb: (...args: never[]) => void) => unknown;
}

export type TailnetDialer = (host: string, port: number) => Promise<TailnetSocket>;

/** Production dialer: a direct TCP connect (the host OS routes tailnet IPs via tailscaled). */
export const defaultTailnetDialer: TailnetDialer = (host, port) =>
  new Promise<TailnetSocket>((resolve, reject) => {
    const socket: Socket = netConnect({ host, port });
    const onError = (err: Error) => {
      socket.destroy();
      reject(err);
    };
    socket.once('error', onError);
    socket.once('connect', () => {
      socket.removeListener('error', onError);
      resolve(socket as unknown as TailnetSocket);
    });
  });

export interface TailnetTcpDeps {
  connector: Pick<TailscaleConnector, 'status'>;
  approvals: TailnetApprovalStore;
  dial?: TailnetDialer;
  audit?: TailnetAudit;
}

function validatePort(port: unknown): number {
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TailnetTcpError('invalid_port', 'port must be an integer in 1..65535');
  }
  return port;
}

/**
 * Open a governed TCP connection to a tailnet machine. Throws
 * TailnetTcpError with code `tailnet_not_joined` or `host_not_approved`
 * BEFORE any dial happens; dial failures propagate as `dial_failed`.
 */
export async function connectViaTailnet(
  deps: TailnetTcpDeps,
  rawHost: unknown,
  rawPort: unknown,
): Promise<{ socket: TailnetSocket; approval: TailnetHostApproval }> {
  const audit = deps.audit ?? (() => {});
  const host = normalizeTailnetHost(rawHost);
  const port = validatePort(rawPort);
  const status = await deps.connector.status();
  if (!status.joined) {
    audit('tailnet.tcp_refused', { host, port, reason: 'tailnet_not_joined' });
    throw new TailnetTcpError('tailnet_not_joined', 'host is not joined to a tailnet');
  }
  const approval = deps.approvals.get(host);
  if (!approval) {
    audit('tailnet.tcp_refused', { host, port, reason: 'host_not_approved' });
    throw new TailnetTcpError('host_not_approved', `no live per-host approval for ${host}`);
  }
  const dial = deps.dial ?? defaultTailnetDialer;
  try {
    const socket = await dial(host, port);
    audit('tailnet.tcp_connected', { host, port });
    return { socket, approval };
  } catch (err) {
    audit('tailnet.tcp_refused', { host, port, reason: 'dial_failed' });
    throw new TailnetTcpError('dial_failed', err instanceof Error ? err.message : 'dial failed');
  }
}

/** Connect + immediately close: a real reachability test (a failed ping proves nothing on a tailnet). */
export async function probeViaTailnet(
  deps: TailnetTcpDeps,
  rawHost: unknown,
  rawPort: unknown,
): Promise<{ host: string; port: number; reachable: true; approvalExpiresAt: number }> {
  const host = normalizeTailnetHost(rawHost);
  const port = validatePort(rawPort);
  const { socket, approval } = await connectViaTailnet(deps, host, port);
  socket.end();
  return { host, port, reachable: true, approvalExpiresAt: approval.expiresAt };
}
