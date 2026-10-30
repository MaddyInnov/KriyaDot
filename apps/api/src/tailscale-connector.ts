// SPDX-License-Identifier: Apache-2.0
// Tailscale (+ Headscale) host connector (Muse parity audit §4.14:
// DV-17 / DV-18).
//
// DV-17: join the user's private network (tailnet) from the app as an
// approved, CLIENT-ONLY device: this connector never advertises routes,
// never offers an exit node and never accepts inbound connections on the
// product's behalf — it only brings the host onto the tailnet so the
// governed TCP rail (tailnet-tcp.ts, DV-19) can reach private machines.
//
// DV-18: a self-hosted control server (Headscale) is supported via the
// standard `--login-server <https origin>` flag, and disconnect ERASES
// the local network identity: `tailscale down` + `tailscale logout`
// (logout deletes the node's keys / local state on the host) plus
// deletion of this connector's own identity record. disconnect()
// verifies the erasure (identity record gone, status no longer joined)
// and reports `identityErased` — it does not claim success silently.
//
// The tailscale CLI is reached ONLY through an injectable command
// runner, so tests mock the CLI completely: zero live calls, zero
// network joins from the test suite.

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the tailscale CLI with argv (never a shell string). */
export type TailscaleCommandRunner = (args: string[]) => Promise<CommandResult>;

/** Production runner: execFile against the local `tailscale` binary. */
export function createExecFileRunner(binary = 'tailscale'): TailscaleCommandRunner {
  return (args) =>
    new Promise<CommandResult>((resolve) => {
      execFile(binary, args, { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error && typeof (error as NodeJS.ErrnoException).code === 'string' && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          resolve({ code: 127, stdout: '', stderr: 'tailscale_cli_not_found' });
          return;
        }
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      });
    });
}

export type TailscaleAudit = (event: string, detail: Record<string, unknown>) => void;

export interface TailnetPeer {
  id: string;
  hostName: string;
  dnsName: string;
  addresses: string[];
  online: boolean;
  os: string;
}

export interface TailnetStatus {
  /** True only when the backend reports Running with a self node. */
  joined: boolean;
  /** Raw BackendState from `tailscale status --json` (Running, NeedsLogin, Stopped, …). */
  backendState: string;
  tailnet: string | null;
  /** The login/control server in use (null for the default Tailscale control plane). */
  loginServer: string | null;
  self: { id: string; hostName: string; dnsName: string; addresses: string[] } | null;
  peers: TailnetPeer[];
}

export interface TailscaleIdentityRecord {
  nodeId: string;
  hostName: string;
  dnsName: string;
  tailnet: string | null;
  loginServer: string | null;
  addresses: string[];
  joinedAt: number;
}

export interface JoinResult {
  status: TailnetStatus;
  /** Browser URL the user must open to approve this device, when the CLI asks for one. */
  authUrl: string | null;
}

export interface DisconnectResult {
  disconnected: boolean;
  /** Verified: no identity record remains and status no longer reports joined. */
  identityErased: boolean;
}

const IDENTITY_FILE = 'tailscale-connector.json';
const AUTH_URL_RE = /https:\/\/[^\s"']+/;

export class TailscaleConnectorError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

export interface TailscaleConnectorDeps {
  /** Directory holding this connector's identity record (created if missing). */
  stateDir: string;
  runner?: TailscaleCommandRunner;
  audit?: TailscaleAudit;
  now?: () => number;
}

export class TailscaleConnector {
  private readonly stateDir: string;
  private readonly runner: TailscaleCommandRunner;
  private readonly audit: TailscaleAudit;
  private readonly now: () => number;

  constructor(deps: TailscaleConnectorDeps) {
    this.stateDir = deps.stateDir;
    mkdirSync(this.stateDir, { recursive: true });
    this.runner = deps.runner ?? createExecFileRunner();
    this.audit = deps.audit ?? (() => {});
    this.now = deps.now ?? (() => Date.now());
  }

  private get identityPath(): string {
    return join(this.stateDir, IDENTITY_FILE);
  }

  /** The locally recorded identity, or null when none is held. */
  readIdentity(): TailscaleIdentityRecord | null {
    try {
      if (!existsSync(this.identityPath)) return null;
      const parsed = JSON.parse(readFileSync(this.identityPath, 'utf8')) as TailscaleIdentityRecord;
      return typeof parsed?.nodeId === 'string' ? parsed : null;
    } catch {
      return null;
    }
  }

  private async run(args: string[]): Promise<CommandResult> {
    const result = await this.runner(args);
    if (result.code === 127 && result.stderr.includes('tailscale_cli_not_found')) {
      throw new TailscaleConnectorError('tailscale_unavailable', 'tailscale CLI not found on this host');
    }
    return result;
  }

  /** Inspect enrollment state + peers. Read-only; never joins or leaves. */
  async status(): Promise<TailnetStatus> {
    const result = await this.run(['status', '--json']);
    if (result.code !== 0) {
      // `tailscale status` exits non-zero when logged out on some builds;
      // treat unparseable output as "not joined" rather than an error.
      return { joined: false, backendState: 'Unknown', tailnet: null, loginServer: this.readIdentity()?.loginServer ?? null, self: null, peers: [] };
    }
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(result.stdout) as Record<string, unknown>;
    } catch {
      return { joined: false, backendState: 'Unknown', tailnet: null, loginServer: null, self: null, peers: [] };
    }
    const self = (raw.Self ?? null) as null | {
      ID?: string; HostName?: string; DNSName?: string; TailscaleIPs?: string[];
    };
    const backendState = typeof raw.BackendState === 'string' ? raw.BackendState : 'Unknown';
    const tailnetName =
      (raw.CurrentTailnet as { Name?: string } | undefined)?.Name ??
      (typeof raw.MagicDNSSuffix === 'string' ? raw.MagicDNSSuffix : null);
    const peers: TailnetPeer[] = [];
    const peerMap = (raw.Peer ?? {}) as Record<string, { ID?: string; HostName?: string; DNSName?: string; TailscaleIPs?: string[]; Online?: boolean; OS?: string }>;
    for (const peer of Object.values(peerMap)) {
      peers.push({
        id: peer.ID ?? '',
        hostName: peer.HostName ?? '',
        dnsName: (peer.DNSName ?? '').replace(/\.$/, ''),
        addresses: peer.TailscaleIPs ?? [],
        online: peer.Online === true,
        os: peer.OS ?? '',
      });
    }
    const joined = backendState === 'Running' && !!self?.ID;
    return {
      joined,
      backendState,
      tailnet: tailnetName,
      loginServer: this.readIdentity()?.loginServer ?? null,
      self: self?.ID
        ? { id: self.ID, hostName: self.HostName ?? '', dnsName: (self.DNSName ?? '').replace(/\.$/, ''), addresses: self.TailscaleIPs ?? [] }
        : null,
      peers,
    };
  }

  /**
   * Join the tailnet (DV-17). Client-only: no route advertisement, no
   * exit node. `loginServer` selects a Headscale / self-hosted control
   * server (DV-18) and must be an https origin. When the control server
   * requires interactive approval, the CLI prints an auth URL which is
   * returned for the user to open — the join completes only after they
   * approve the device there.
   */
  async join(opts: { loginServer?: string } = {}): Promise<JoinResult> {
    let loginServer: string | null = null;
    if (opts.loginServer !== undefined) {
      let parsed: URL;
      try {
        parsed = new URL(opts.loginServer);
      } catch {
        throw new TailscaleConnectorError('invalid_login_server', 'loginServer must be an https origin URL');
      }
      if (parsed.protocol !== 'https:') {
        throw new TailscaleConnectorError('invalid_login_server', 'loginServer must be an https origin URL');
      }
      loginServer = parsed.origin;
    }
    const args = ['up'];
    if (loginServer) args.push('--login-server', loginServer);
    this.audit('tailscale.join_requested', { loginServer });
    const result = await this.run(args);
    const combined = `${result.stdout}\n${result.stderr}`;
    const authUrl = combined.match(AUTH_URL_RE)?.[0] ?? null;
    const status = await this.status();
    if (status.joined && status.self) {
      const record: TailscaleIdentityRecord = {
        nodeId: status.self.id,
        hostName: status.self.hostName,
        dnsName: status.self.dnsName,
        tailnet: status.tailnet,
        loginServer,
        addresses: status.self.addresses,
        joinedAt: this.now(),
      };
      writeFileSync(this.identityPath, JSON.stringify(record, null, 2), { mode: 0o600 });
      this.audit('tailscale.joined', { nodeId: record.nodeId, tailnet: record.tailnet, loginServer });
    } else {
      this.audit('tailscale.join_pending', { authUrl: authUrl !== null, backendState: status.backendState });
    }
    return { status, authUrl };
  }

  /**
   * Disconnect AND erase the local network identity (DV-18 hard
   * requirement): `tailscale down` stops the tunnel, `tailscale logout`
   * deletes the node's local keys/state, and this connector's identity
   * record is removed. Erasure is then VERIFIED (record absent + status
   * not joined) and reported honestly in the result.
   */
  async disconnect(): Promise<DisconnectResult> {
    this.audit('tailscale.disconnect_requested', {});
    await this.run(['down']);
    // logout is what actually erases the identity (keys + profile) from
    // the host; tolerate "already logged out" style failures — erasure is
    // verified below either way.
    await this.run(['logout']);
    rmSync(this.identityPath, { force: true });
    const status = await this.status();
    const identityErased = this.readIdentity() === null && !status.joined && status.self === null;
    this.audit('tailscale.disconnected', { identityErased });
    return { disconnected: !status.joined, identityErased };
  }
}
