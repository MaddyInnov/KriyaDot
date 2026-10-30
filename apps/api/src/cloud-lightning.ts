// SPDX-License-Identifier: Apache-2.0
// Lightning AI cloud layer — SDK/CLI adapter (Octomind-parity closure, C2–C4).
//
// Design (see hidden_files/lightning-ai-cloud-feasibility.md, 2026-10-29):
// - There is NO silent auto-sign-in into Lightning and no third-party OAuth
//   connect flow. The one-tap equivalent is a single "Connect Lightning"
//   step: the user signs in to Lightning themselves (a separate Lightning
//   account — they may use the same Google login there), copies their
//   user ID + API key from Lightning's account settings → Keys →
//   Programmatic Login, and pastes them into KriyaDot. Those credentials
//   are stored ONLY in the encrypted SecureVault (see VaultCloudSecretStore
//   below, mirroring the Composio/GitHub vault patterns in this codebase).
// - The official Lightning SDK is Python (`lightning-sdk`). The pragmatic
//   real implementation here therefore shells out to the user's installed
//   `lightning` CLI for lifecycle operations and spawns `python3 -c …`
//   against `lightning_sdk` for in-Studio command execution (the SDK's
//   documented `Studio.run(...)`). Both go through an injectable
//   CommandRunner so tests mock every subprocess — no test ever spawns a
//   real process or touches the network.
// - Credentials reach subprocesses ONLY via the LIGHTNING_USER_ID /
//   LIGHTNING_API_KEY environment variables (the SDK's documented
//   programmatic-login env names). They are never placed in argv (visible
//   in process listings) and never logged.
//
// Honest limits (from the feasibility report):
// - No documented public API exists for a Lightning account's credit
//   balance, remaining free hours, or billing-period usage totals. This
//   adapter exposes only operational Studio state; cloud-routes.ts
//   deep-links to Lightning for anything billing-shaped and NEVER
//   fabricates a balance.
// - Free tier = ONE concurrently running CPU Studio, force-restarted
//   every 4 hours, sleeping when idle. That is "always reachable", not
//   "always running" — see cloud-supervisor.ts.

import { execFile } from 'node:child_process';
import { SecureVault } from '@mvp/vault';

// ---------------------------------------------------------------------------
// Secret storage
// ---------------------------------------------------------------------------

/** Vault secret names for the Lightning programmatic-login pair. */
export const LIGHTNING_USER_ID_SECRET = 'lightning-user-id';
export const LIGHTNING_API_KEY_SECRET = 'lightning-api-key';

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
    return new SecureVault(this.dataDir, userId, 'cloud-lightning');
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
    else vault.create(name, value, 'Lightning AI programmatic-login credential (cloud layer)');
  }

  delete(userId: string, name: string): void {
    try {
      this.vault(userId).delete(name);
    } catch {
      // Already gone / vault unreadable — disconnect stays idempotent.
    }
  }
}

/** The user's own Lightning programmatic-login credentials. */
export interface LightningCredentials {
  userId: string;
  apiKey: string;
}

/** Read the stored credential pair for a KriyaDot user, if connected. */
export function readLightningCredentials(
  store: CloudSecretStore,
  userId: string,
): LightningCredentials | undefined {
  const lightningUserId = store.get(userId, LIGHTNING_USER_ID_SECRET);
  const apiKey = store.get(userId, LIGHTNING_API_KEY_SECRET);
  if (!lightningUserId || !apiKey) return undefined;
  return { userId: lightningUserId, apiKey };
}

// ---------------------------------------------------------------------------
// Command runner (injectable subprocess seam)
// ---------------------------------------------------------------------------

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommandRunnerOptions {
  env?: Record<string, string>;
  timeoutMs?: number;
}

/** Runs one argv vector (never a shell string) and captures its output. */
export type CommandRunner = (
  command: string,
  args: string[],
  opts?: CommandRunnerOptions,
) => Promise<CommandResult>;

/** Real runner: execFile without a shell, credentials passed via env only. */
export const execFileCommandRunner: CommandRunner = (command, args, opts) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        timeout: opts?.timeoutMs ?? 120_000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, ...(opts?.env ?? {}) },
      },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: unknown }).code === 'number'
            ? ((err as { code: number }).code as number)
            : err
              ? 1
              : 0;
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), exitCode: code });
      },
    );
  });

// ---------------------------------------------------------------------------
// Studio model + status mapping
// ---------------------------------------------------------------------------

/**
 * KriyaDot's mapped Studio state. `waking` is a KriyaDot-side transitional
 * state (a start was requested / traffic arrived while the Studio slept);
 * Lightning itself reports running/sleeping/stopped/starting-style states.
 */
export type LightningStudioState =
  | 'running'
  | 'sleeping'
  | 'stopped'
  | 'starting'
  | 'waking'
  | 'unknown';

export interface LightningStudio {
  name: string;
  teamspace?: string;
  /** Raw status text as reported by the CLI/SDK, preserved for debugging. */
  rawStatus: string;
  state: LightningStudioState;
  /** Machine descriptor as reported (e.g. "CPU-4"), when known. */
  machine?: string;
  /** Public (ports-plugin) URL for the Studio's primary app port, if any. */
  publicUrl?: string;
  /** All resolved public port URLs keyed by in-Studio port. */
  portUrls: Record<number, string>;
  /** Seconds since the Studio (last) started, when the runner can report it. */
  uptimeSeconds?: number;
  /** Epoch ms when the Studio (last) started, when known. */
  startedAt?: number;
}

/** Map a raw Lightning status string onto KriyaDot's state vocabulary. */
export function mapLightningStatus(raw: string): LightningStudioState {
  const s = raw.trim().toLowerCase();
  if (s === 'running' || s === 'run' || s === 'active' || s === 'ready') return 'running';
  if (s === 'sleeping' || s === 'sleep' || s === 'idle' || s === 'paused') return 'sleeping';
  if (s === 'stopped' || s === 'stop' || s === 'off' || s === 'terminated') return 'stopped';
  if (s === 'starting' || s === 'pending' || s === 'provisioning' || s === 'booting')
    return 'starting';
  return 'unknown';
}

/**
 * Extract public port URLs from CLI/SDK output text. Lightning exposes a
 * process listening on a port inside a Studio through the ports plugin at
 * a Lightning URL; deploy/status output mentions those URLs. We accept any
 * https URL that names the port (`-8080.` / `:8080` / `/8080`) and fall
 * back to the first Lightning URL for the requested primary port.
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
  if (ports.length > 0 && out[ports[0]] === undefined) {
    const lightningUrl = urls.find((u) => u.includes('lightning.ai'));
    if (lightningUrl) out[ports[0]] = lightningUrl;
  }
  return out;
}

/** Resolve the public URL for one port from a Studio record. */
export function resolveStudioPublicUrl(
  studio: Pick<LightningStudio, 'portUrls' | 'publicUrl'>,
  port: number,
): string | undefined {
  return studio.portUrls[port] ?? studio.publicUrl;
}

// ---------------------------------------------------------------------------
// Client interface
// ---------------------------------------------------------------------------

export interface LightningRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface LightningClient {
  /** Verify the credential pair works (one cheap authenticated call). */
  verifyCredentials(): Promise<{ ok: boolean; detail?: string }>;
  listStudios(): Promise<LightningStudio[]>;
  getStudio(name: string): Promise<LightningStudio | undefined>;
  /** Create the Studio if missing (create_ok semantics), then return it. */
  ensureStudio(name: string, opts?: { teamspace?: string }): Promise<LightningStudio>;
  startStudio(name: string): Promise<LightningStudio>;
  stopStudio(name: string): Promise<LightningStudio>;
  /** Run a shell command inside the Studio (SDK `Studio.run`). */
  runInStudio(name: string, command: string): Promise<LightningRunResult>;
  /** Bytes used by the KriyaDot app dir inside the Studio, if measurable. */
  studioDiskUsageBytes(name: string): Promise<number | undefined>;
}

/** Default KriyaDot Studio name inside the user's Lightning account. */
export const DEFAULT_STUDIO_NAME = 'kriyadot';
/** Primary port the KriyaDot server listens on inside the Studio. */
export const DEFAULT_STUDIO_PORT = 8080;

// ---------------------------------------------------------------------------
// CLI / SDK-backed real client
// ---------------------------------------------------------------------------

export interface CliLightningClientOptions {
  credentials: LightningCredentials | (() => LightningCredentials | undefined);
  runner?: CommandRunner;
  /** `lightning` CLI binary name/path. Default: "lightning". */
  cliBinary?: string;
  /** Python interpreter for the lightning_sdk run channel. Default: "python3". */
  pythonBinary?: string;
  teamspace?: string;
  /** Ports whose public URLs should be resolved from output. */
  ports?: number[];
}

function parseStudioJson(text: string): Record<string, unknown>[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) return parsed as Record<string, unknown>[];
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      if (Array.isArray(obj.studios)) return obj.studios as Record<string, unknown>[];
      return [obj];
    }
  } catch {
    // Not JSON — caller falls back to text parsing.
  }
  return [];
}

function studioFromRecord(
  rec: Record<string, unknown>,
  fallbackName: string,
  ports: number[],
): LightningStudio {
  const name = typeof rec.name === 'string' ? rec.name : fallbackName;
  const rawStatus =
    typeof rec.status === 'string'
      ? rec.status
      : typeof rec.state === 'string'
        ? rec.state
        : 'unknown';
  const portUrls: Record<number, string> = {};
  if (rec.portUrls && typeof rec.portUrls === 'object') {
    for (const [k, v] of Object.entries(rec.portUrls as Record<string, unknown>)) {
      const port = Number(k);
      if (Number.isFinite(port) && typeof v === 'string') portUrls[port] = v;
    }
  }
  if (typeof rec.publicUrl === 'string') {
    portUrls[ports[0] ?? DEFAULT_STUDIO_PORT] ??= rec.publicUrl;
  }
  Object.assign(portUrls, extractPublicUrls(JSON.stringify(rec), ports));
  return {
    name,
    ...(typeof rec.teamspace === 'string' ? { teamspace: rec.teamspace } : {}),
    rawStatus,
    state: mapLightningStatus(rawStatus),
    ...(typeof rec.machine === 'string' ? { machine: rec.machine } : {}),
    ...(portUrls[ports[0] ?? DEFAULT_STUDIO_PORT]
      ? { publicUrl: portUrls[ports[0] ?? DEFAULT_STUDIO_PORT] }
      : {}),
    portUrls,
    ...(typeof rec.uptimeSeconds === 'number' ? { uptimeSeconds: rec.uptimeSeconds } : {}),
    ...(typeof rec.startedAt === 'number' ? { startedAt: rec.startedAt } : {}),
  };
}

/**
 * Real client backed by the user's own `lightning` CLI (lifecycle) and
 * the Python `lightning_sdk` (in-Studio runs). The user installs these
 * themselves (`pip install lightning-sdk` provides both); KriyaDot never
 * bundles or silently installs them, and never signs the user in — the
 * env credentials come from the vault pair the user pasted at connect.
 */
export class CliLightningClient implements LightningClient {
  private readonly runner: CommandRunner;
  private readonly cliBinary: string;
  private readonly pythonBinary: string;
  private readonly ports: number[];

  constructor(private readonly opts: CliLightningClientOptions) {
    this.runner = opts.runner ?? execFileCommandRunner;
    this.cliBinary = opts.cliBinary ?? 'lightning';
    this.pythonBinary = opts.pythonBinary ?? 'python3';
    this.ports = opts.ports ?? [DEFAULT_STUDIO_PORT];
  }

  private credentials(): LightningCredentials {
    const creds =
      typeof this.opts.credentials === 'function'
        ? (this.opts.credentials as () => LightningCredentials | undefined)()
        : this.opts.credentials;
    if (!creds) throw new Error('Lightning is not connected (no stored credentials)');
    return creds;
  }

  private env(): Record<string, string> {
    const creds = this.credentials();
    // Documented programmatic-login env names (lightning_sdk package page).
    return { LIGHTNING_USER_ID: creds.userId, LIGHTNING_API_KEY: creds.apiKey };
  }

  private teamspaceArgs(): string[] {
    const ts = this.opts.teamspace;
    return ts ? ['--teamspace', ts] : [];
  }

  async verifyCredentials(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const res = await this.runner(this.cliBinary, ['studio', 'list', ...this.teamspaceArgs()], {
        env: this.env(),
      });
      if (res.exitCode !== 0) {
        return { ok: false, detail: (res.stderr || res.stdout).slice(0, 300) || 'lightning CLI failed' };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  async listStudios(): Promise<LightningStudio[]> {
    const res = await this.runner(this.cliBinary, ['studio', 'list', ...this.teamspaceArgs()], {
      env: this.env(),
    });
    if (res.exitCode !== 0) {
      throw new Error(`lightning studio list failed: ${(res.stderr || res.stdout).slice(0, 300)}`);
    }
    const records = parseStudioJson(res.stdout);
    if (records.length > 0) {
      return records.map((r) => studioFromRecord(r, DEFAULT_STUDIO_NAME, this.ports));
    }
    // Text fallback: one Studio per line, "name status …url…".
    const studios: LightningStudio[] = [];
    for (const line of res.stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [name, status] = trimmed.split(/\s+/);
      if (!name) continue;
      const portUrls = extractPublicUrls(trimmed, this.ports);
      studios.push({
        name,
        rawStatus: status ?? 'unknown',
        state: mapLightningStatus(status ?? ''),
        portUrls,
        ...(portUrls[this.ports[0]] ? { publicUrl: portUrls[this.ports[0]] } : {}),
      });
    }
    return studios;
  }

  async getStudio(name: string): Promise<LightningStudio | undefined> {
    const all = await this.listStudios();
    return all.find((s) => s.name === name);
  }

  async ensureStudio(name: string, opts?: { teamspace?: string }): Promise<LightningStudio> {
    const existing = await this.getStudio(name);
    if (existing) return existing;
    // Documented CLI shape: `lightning studio start --name <n> --create`
    // creates the Studio if missing and starts it.
    const teamspace = opts?.teamspace ?? this.opts.teamspace;
    const args = ['studio', 'start', '--name', name, '--create'];
    if (teamspace) args.push('--teamspace', teamspace);
    const res = await this.runner(this.cliBinary, args, { env: this.env() });
    if (res.exitCode !== 0) {
      throw new Error(`lightning studio start --create failed: ${(res.stderr || res.stdout).slice(0, 300)}`);
    }
    const created = await this.getStudio(name);
    if (created) return created;
    const portUrls = extractPublicUrls(res.stdout, this.ports);
    return {
      name,
      rawStatus: 'starting',
      state: 'starting',
      portUrls,
      ...(portUrls[this.ports[0]] ? { publicUrl: portUrls[this.ports[0]] } : {}),
    };
  }

  async startStudio(name: string): Promise<LightningStudio> {
    const res = await this.runner(
      this.cliBinary,
      ['studio', 'start', '--name', name, ...this.teamspaceArgs()],
      { env: this.env() },
    );
    if (res.exitCode !== 0) {
      throw new Error(`lightning studio start failed: ${(res.stderr || res.stdout).slice(0, 300)}`);
    }
    return (await this.getStudio(name)) ?? { name, rawStatus: 'starting', state: 'starting', portUrls: {} };
  }

  async stopStudio(name: string): Promise<LightningStudio> {
    const res = await this.runner(
      this.cliBinary,
      ['studio', 'stop', '--name', name, ...this.teamspaceArgs()],
      { env: this.env() },
    );
    if (res.exitCode !== 0) {
      throw new Error(`lightning studio stop failed: ${(res.stderr || res.stdout).slice(0, 300)}`);
    }
    return (await this.getStudio(name)) ?? { name, rawStatus: 'stopped', state: 'stopped', portUrls: {} };
  }

  async runInStudio(name: string, command: string): Promise<LightningRunResult> {
    // The SDK's documented in-Studio run channel is Python:
    //   Studio(name, create_ok=False).run(command)
    // Credentials travel via env (above), the Studio name + command via
    // argv to a fixed script — no user input is interpolated into code.
    const script = [
      'import json,sys',
      'from lightning_sdk import Studio',
      'out = Studio(sys.argv[1], create_ok=False).run(sys.argv[2])',
      'sys.stdout.write(out if isinstance(out, str) else json.dumps(out))',
    ].join('\n');
    const res = await this.runner(this.pythonBinary, ['-c', script, name, command], {
      env: this.env(),
      timeoutMs: 300_000,
    });
    return { stdout: res.stdout, stderr: res.stderr, exitCode: res.exitCode };
  }

  async studioDiskUsageBytes(name: string): Promise<number | undefined> {
    const res = await this.runInStudio(name, 'du -sb ~/kriyadot 2>/dev/null | cut -f1');
    if (res.exitCode !== 0) return undefined;
    const n = Number(res.stdout.trim());
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  }
}

// ---------------------------------------------------------------------------
// Fake client (tests)
// ---------------------------------------------------------------------------

export interface FakeStudioSeed {
  name: string;
  state?: LightningStudioState;
  machine?: string;
  teamspace?: string;
  publicUrl?: string;
  uptimeSeconds?: number;
  startedAt?: number;
}

/**
 * In-memory LightningClient for tests. Records every call in `calls` and
 * every in-Studio command in `runCommands` (in order) so deploy tests can
 * assert the exact step sequence. No subprocess, no network.
 */
export class FakeLightningClient implements LightningClient {
  readonly calls: string[] = [];
  readonly runCommands: string[] = [];
  readonly studios = new Map<string, LightningStudio>();
  /** Canned run responses: first substring match wins; default exit 0. */
  runResponses: { match: string; result: LightningRunResult }[] = [];
  diskUsageBytes: number | undefined = 123_456_789;
  verifyResult: { ok: boolean; detail?: string } = { ok: true };

  constructor(seed: FakeStudioSeed[] = []) {
    for (const s of seed) this.addStudio(s);
  }

  addStudio(seed: FakeStudioSeed): LightningStudio {
    const state = seed.state ?? 'stopped';
    const studio: LightningStudio = {
      name: seed.name,
      ...(seed.teamspace ? { teamspace: seed.teamspace } : {}),
      rawStatus: state,
      state,
      ...(seed.machine ? { machine: seed.machine } : { machine: 'CPU-4' }),
      ...(seed.publicUrl
        ? { publicUrl: seed.publicUrl, portUrls: { [DEFAULT_STUDIO_PORT]: seed.publicUrl } }
        : { portUrls: {} }),
      ...(seed.uptimeSeconds !== undefined ? { uptimeSeconds: seed.uptimeSeconds } : {}),
      ...(seed.startedAt !== undefined ? { startedAt: seed.startedAt } : {}),
    };
    this.studios.set(seed.name, studio);
    return studio;
  }

  /** Test helper: mutate a Studio's state/uptime as Lightning would. */
  setStudioState(name: string, patch: Partial<LightningStudio>): void {
    const cur = this.studios.get(name);
    if (!cur) return;
    const next = { ...cur, ...patch };
    if (patch.state) next.rawStatus = patch.state;
    this.studios.set(name, next);
  }

  async verifyCredentials(): Promise<{ ok: boolean; detail?: string }> {
    this.calls.push('verifyCredentials');
    return this.verifyResult;
  }

  async listStudios(): Promise<LightningStudio[]> {
    this.calls.push('listStudios');
    return [...this.studios.values()];
  }

  async getStudio(name: string): Promise<LightningStudio | undefined> {
    this.calls.push(`getStudio:${name}`);
    return this.studios.get(name);
  }

  async ensureStudio(name: string): Promise<LightningStudio> {
    this.calls.push(`ensureStudio:${name}`);
    const existing = this.studios.get(name);
    if (existing) return existing;
    return this.addStudio({ name, state: 'starting' });
  }

  async startStudio(name: string): Promise<LightningStudio> {
    this.calls.push(`startStudio:${name}`);
    const studio = this.studios.get(name) ?? this.addStudio({ name });
    this.setStudioState(name, {
      state: 'running',
      startedAt: studio.startedAt ?? 0,
      uptimeSeconds: studio.uptimeSeconds ?? 0,
    });
    return this.studios.get(name)!;
  }

  async stopStudio(name: string): Promise<LightningStudio> {
    this.calls.push(`stopStudio:${name}`);
    const studio = this.studios.get(name) ?? this.addStudio({ name });
    this.setStudioState(name, { state: 'stopped' });
    return this.studios.get(name) ?? studio;
  }

  async runInStudio(name: string, command: string): Promise<LightningRunResult> {
    this.calls.push(`runInStudio:${name}`);
    this.runCommands.push(command);
    for (const r of this.runResponses) {
      if (command.includes(r.match)) return r.result;
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  async studioDiskUsageBytes(name: string): Promise<number | undefined> {
    this.calls.push(`studioDiskUsageBytes:${name}`);
    return this.diskUsageBytes;
  }
}
