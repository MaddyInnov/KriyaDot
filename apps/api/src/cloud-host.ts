// SPDX-License-Identifier: Apache-2.0
// Cloud host layer — host-agnostic credentials, instance model, and the
// client interface a deploy driver implements.
//
// Design:
// - There is NO silent auto-sign-in into any cloud host and no third-party
//   OAuth connect flow. The connect step is explicit: the user signs in to
//   their own cloud host themselves, copies their account id + API key
//   from that host's account settings, and pastes them into KriyaDot.
//   Those credentials are stored ONLY in the encrypted SecureVault (see
//   VaultCloudSecretStore below, mirroring the Composio/GitHub vault
//   patterns in this codebase).
// - This module ships NO real host implementation: no CLI client, no SDK
//   client. A host driver is pluggable — the host wires a factory that
//   builds a CloudHostClient for a stored credential pair (see
//   cloud-routes.ts). Until a driver is configured, the cloud routes fail
//   honestly instead of pretending a host exists.
// - Tests use FakeCloudHostClient below: no subprocess, no network, no
//   real account.
//
// Honest limits:
// - A generic host driver exposes only operational instance state. There
//   is no assumption of a billing/balance API on the host; cloud-routes.ts
//   reports only driver-visible facts and NEVER fabricates a balance.
// - Whether an instance is "always-on" depends on the tier the host
//   reports; see cloud-supervisor.ts for the honest state model.

import { SecureVault } from '@mvp/vault';

// ---------------------------------------------------------------------------
// Secret storage
// ---------------------------------------------------------------------------

/** Vault secret names for the cloud-host credential pair. */
export const CLOUD_HOST_ACCOUNT_SECRET = 'cloud-host-account';
export const CLOUD_HOST_API_KEY_SECRET = 'cloud-host-api-key';

/**
 * Secret-store seam for the cloud layer. Routes depend on this interface,
 * not on the vault directly, so tests use InMemoryCloudSecretStore and the
 * host wires VaultCloudSecretStore.
 */
export interface CloudSecretStore {
  get(userId: string, name: string): string | undefined;
  set(userId: string, name: string, value: string): void;
  delete(userId: string, name: string): void;
}

/** In-memory secret store for tests. Values never leave the process. */
export class InMemoryCloudSecretStore implements CloudSecretStore {
  private readonly map = new Map<string, string>();
  private key(userId: string, name: string): string {
    return `${userId}::${name}`;
  }
  get(userId: string, name: string): string | undefined {
    return this.map.get(this.key(userId, name));
  }
  set(userId: string, name: string, value: string): void {
    this.map.set(this.key(userId, name), value);
  }
  delete(userId: string, name: string): void {
    this.map.delete(this.key(userId, name));
  }
}

/**
 * Production secret store: the per-user encrypted SecureVault, exactly the
 * pattern used for the Composio key (composio.ts) — namespace = the
 * KriyaDot user id, actor = the same id, create-or-update on write.
 *
 * HOST WIRING (index.ts): `new VaultCloudSecretStore(config.dataDir)`.
 */
export class VaultCloudSecretStore implements CloudSecretStore {
  constructor(private readonly dataDir: string) {}

  private vault(userId: string): SecureVault {
    return new SecureVault(this.dataDir, userId, 'cloud-host');
  }

  get(userId: string, name: string): string | undefined {
    try {
      return this.vault(userId).get(name)?.value;
    } catch {
      return undefined;
    }
  }

  set(userId: string, name: string, value: string): void {
    const vault = this.vault(userId);
    let existing: unknown;
    try {
      existing = vault.get(name);
    } catch {
      existing = undefined;
    }
    if (existing) vault.update(name, value);
    else vault.create(name, value, 'Cloud host credential (cloud layer)');
  }

  delete(userId: string, name: string): void {
    try {
      this.vault(userId).delete(name);
    } catch {
      // Already gone / vault unreadable — disconnect stays idempotent.
    }
  }
}

/** The user's own cloud-host credentials. */
export interface CloudHostCredentials {
  accountId: string;
  apiKey: string;
}

/** Read the stored credential pair for a KriyaDot user, if connected. */
export function readCloudHostCredentials(
  store: CloudSecretStore,
  userId: string,
): CloudHostCredentials | undefined {
  const accountId = store.get(userId, CLOUD_HOST_ACCOUNT_SECRET);
  const apiKey = store.get(userId, CLOUD_HOST_API_KEY_SECRET);
  if (!accountId || !apiKey) return undefined;
  return { accountId, apiKey };
}

// ---------------------------------------------------------------------------
// Instance model + status mapping
// ---------------------------------------------------------------------------

/**
 * KriyaDot's mapped instance state. `waking` is a KriyaDot-side
 * transitional state (a start was requested / traffic arrived while the
 * instance slept); a host itself reports running/sleeping/stopped/
 * starting-style states.
 */
export type CloudHostState =
  | 'running'
  | 'sleeping'
  | 'stopped'
  | 'starting'
  | 'waking'
  | 'unknown';

export interface CloudHostInstance {
  name: string;
  teamspace?: string;
  /** Raw status text as reported by the host, preserved for debugging. */
  rawStatus: string;
  state: CloudHostState;
  /** Machine descriptor as reported (e.g. "CPU-4"), when known. */
  machine?: string;
  /** Public URL for the instance's primary app port, if any. */
  publicUrl?: string;
  /** All resolved public port URLs keyed by in-instance port. */
  portUrls: Record<number, string>;
  /** Seconds since the instance (last) started, when the host reports it. */
  uptimeSeconds?: number;
  /** Epoch ms when the instance (last) started, when known. */
  startedAt?: number;
}

/** Map a raw host status string onto KriyaDot's state vocabulary. */
export function mapCloudHostStatus(raw: string): CloudHostState {
  const s = raw.trim().toLowerCase();
  if (s === 'running' || s === 'run' || s === 'active' || s === 'ready') return 'running';
  if (s === 'sleeping' || s === 'sleep' || s === 'idle' || s === 'paused') return 'sleeping';
  if (s === 'stopped' || s === 'stop' || s === 'off' || s === 'terminated') return 'stopped';
  if (s === 'starting' || s === 'pending' || s === 'provisioning' || s === 'booting')
    return 'starting';
  return 'unknown';
}

/**
 * Extract public port URLs from driver output text. A host exposes a
 * process listening on a port inside an instance through a public URL;
 * deploy/status output mentions those URLs. We accept any https URL that
 * names the port (`-8080.` / `:8080` / `/8080`) and fall back to the
 * first https URL for the requested primary port.
 */
export function extractPublicUrls(text: string, ports: number[]): Record<number, string> {
  const urls = [...new Set([...text.matchAll(/https:\/\/[^\s"'<>]+/g)].map((m) => m[0]))];
  const out: Record<number, string> = {};
  for (const port of ports) {
    const named = urls.find(
      (u) => u.includes(`-${port}.`) || u.includes(`:${port}`) || u.includes(`/${port}`),
    );
    if (named) out[port] = named;
  }
  if (ports.length > 0 && out[ports[0]] === undefined && urls[0] !== undefined) {
    out[ports[0]] = urls[0];
  }
  return out;
}

/** Resolve the public URL for one port from an instance record. */
export function resolveInstancePublicUrl(
  instance: Pick<CloudHostInstance, 'portUrls' | 'publicUrl'>,
  port: number,
): string | undefined {
  return instance.portUrls[port] ?? instance.publicUrl;
}

// ---------------------------------------------------------------------------
// Client interface
// ---------------------------------------------------------------------------

export interface CloudHostRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CloudHostClient {
  /** Verify the credential pair works (one cheap authenticated call). */
  verifyCredentials(): Promise<{ ok: boolean; detail?: string }>;
  listInstances(): Promise<CloudHostInstance[]>;
  getInstance(name: string): Promise<CloudHostInstance | undefined>;
  /** Create the instance if missing (create_ok semantics), then return it. */
  ensureInstance(name: string, opts?: { teamspace?: string }): Promise<CloudHostInstance>;
  startInstance(name: string): Promise<CloudHostInstance>;
  stopInstance(name: string): Promise<CloudHostInstance>;
  /** Run a shell command inside the instance. */
  runOnInstance(name: string, command: string): Promise<CloudHostRunResult>;
  /** Bytes used by the KriyaDot app dir inside the instance, if measurable. */
  instanceDiskUsageBytes(name: string): Promise<number | undefined>;
}

/** Default KriyaDot instance name inside the user's cloud-host account. */
export const DEFAULT_INSTANCE_NAME = 'kriyadot';
/** Primary port the KriyaDot server listens on inside the instance. */
export const DEFAULT_INSTANCE_PORT = 8080;

// ---------------------------------------------------------------------------
// Fake client (tests)
// ---------------------------------------------------------------------------

export interface FakeInstanceSeed {
  name: string;
  state?: CloudHostState;
  machine?: string;
  teamspace?: string;
  publicUrl?: string;
  uptimeSeconds?: number;
  startedAt?: number;
}

/**
 * In-memory CloudHostClient for tests. Records every call in `calls` and
 * every in-instance command in `runCommands` (in order) so deploy tests
 * can assert the exact step sequence. No subprocess, no network.
 */
export class FakeCloudHostClient implements CloudHostClient {
  readonly calls: string[] = [];
  readonly runCommands: string[] = [];
  readonly instances = new Map<string, CloudHostInstance>();
  /** Canned run responses: first substring match wins; default exit 0. */
  runResponses: { match: string; result: CloudHostRunResult }[] = [];
  diskUsageBytes: number | undefined = 123_456_789;
  verifyResult: { ok: boolean; detail?: string } = { ok: true };

  constructor(seed: FakeInstanceSeed[] = []) {
    for (const s of seed) this.addInstance(s);
  }

  addInstance(seed: FakeInstanceSeed): CloudHostInstance {
    const state = seed.state ?? 'stopped';
    const instance: CloudHostInstance = {
      name: seed.name,
      ...(seed.teamspace ? { teamspace: seed.teamspace } : {}),
      rawStatus: state,
      state,
      ...(seed.machine ? { machine: seed.machine } : { machine: 'CPU-4' }),
      ...(seed.publicUrl
        ? { publicUrl: seed.publicUrl, portUrls: { [DEFAULT_INSTANCE_PORT]: seed.publicUrl } }
        : { portUrls: {} }),
      ...(seed.uptimeSeconds !== undefined ? { uptimeSeconds: seed.uptimeSeconds } : {}),
      ...(seed.startedAt !== undefined ? { startedAt: seed.startedAt } : {}),
    };
    this.instances.set(seed.name, instance);
    return instance;
  }

  /** Test helper: mutate an instance's state/uptime as the host would. */
  setInstanceState(name: string, patch: Partial<CloudHostInstance>): void {
    const cur = this.instances.get(name);
    if (!cur) return;
    const next = { ...cur, ...patch };
    if (patch.state) next.rawStatus = patch.state;
    this.instances.set(name, next);
  }

  async verifyCredentials(): Promise<{ ok: boolean; detail?: string }> {
    this.calls.push('verifyCredentials');
    return this.verifyResult;
  }

  async listInstances(): Promise<CloudHostInstance[]> {
    this.calls.push('listInstances');
    return [...this.instances.values()];
  }

  async getInstance(name: string): Promise<CloudHostInstance | undefined> {
    this.calls.push(`getInstance:${name}`);
    return this.instances.get(name);
  }

  async ensureInstance(name: string): Promise<CloudHostInstance> {
    this.calls.push(`ensureInstance:${name}`);
    const existing = this.instances.get(name);
    if (existing) return existing;
    return this.addInstance({ name, state: 'starting' });
  }

  async startInstance(name: string): Promise<CloudHostInstance> {
    this.calls.push(`startInstance:${name}`);
    const instance = this.instances.get(name) ?? this.addInstance({ name });
    this.setInstanceState(name, {
      state: 'running',
      startedAt: instance.startedAt ?? 0,
      uptimeSeconds: instance.uptimeSeconds ?? 0,
    });
    return this.instances.get(name)!;
  }

  async stopInstance(name: string): Promise<CloudHostInstance> {
    this.calls.push(`stopInstance:${name}`);
    const instance = this.instances.get(name) ?? this.addInstance({ name });
    this.setInstanceState(name, { state: 'stopped' });
    return this.instances.get(name) ?? instance;
  }

  async runOnInstance(name: string, command: string): Promise<CloudHostRunResult> {
    this.calls.push(`runOnInstance:${name}`);
    this.runCommands.push(command);
    for (const r of this.runResponses) {
      if (command.includes(r.match)) return r.result;
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  async instanceDiskUsageBytes(name: string): Promise<number | undefined> {
    this.calls.push(`instanceDiskUsageBytes:${name}`);
    return this.diskUsageBytes;
  }
}
