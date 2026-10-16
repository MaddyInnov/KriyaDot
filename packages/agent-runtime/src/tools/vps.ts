// SPDX-License-Identifier: Apache-2.0
// BYO VPS (bring-your-own-VPS) support (OpenMausBot parity P1 #24).
//
// Lets a bot run commands, move files, and drive a desktop on the user's own
// server over SSH instead of (only) the local machine or Docker:
//
//   VpsProfile      — per-bot (or global default) connection profile. The
//                     profile JSON never holds secrets: an SSH private key is
//                     referenced by vault secret NAME (privateKeyRef) and a
//                     password is prompted at connect time, never stored.
//   VpsConnection   — one live SSH connection: TOFU host-key pinning,
//                     reconnect with backoff, exec + SFTP.
//   VpsSandbox      — the sandbox command interface (same shape as
//                     tools/sandbox.ts: runCommand/readFile/writeFile) over SSH.
//   VpsComputerLayer— OSScreenLayer driving the VPS desktop via xdotool over
//                     SSH (screenshot via ImageMagick `import`, scrot fallback).
//   VpsConnectionPool — per-key connection cache (the API wires one up with
//                     a vault-backed key resolver).
//
// Trust model:
//   - Host keys are verified on EVERY connect. First connect without a pinned
//     fingerprint throws VpsTrustRequiredError (the UI shows the observed
//     SHA256 fingerprint and asks the user to trust it). A changed key is a
//     hard stop: VpsFingerprintMismatchError, no auto-reconnect (MITM).
//   - Auth failures never trigger backoff reconnects.
//   - Passwords are transient (connect-call only), never persisted or cached.
//   - Private keys are read from the vault at connect time and live in memory
//     only; they never appear in profiles, logs, or errors.
//   - Approval gating stays orthogonal: computer tools on the VPS surface are
//     still require-approval, audited via onRealAction.

import { createHash } from 'node:crypto';
import { Client } from 'ssh2';
import type {
  ChordModifier,
  ClickOptions,
  DisplaySize,
  DragOptions,
  OSScreenLayer,
  Screenshot,
} from './computer.js';
import type {
  SandboxCommandOptions,
  SandboxCommandResult,
} from './sandbox.js';

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

/** How the bot authenticates to the VPS. */
export type VpsAuthMethod = 'key' | 'password-prompt' | 'agent';

export const VPS_AUTH_METHODS: readonly VpsAuthMethod[] = [
  'key',
  'password-prompt',
  'agent',
];

/**
 * A VPS connection profile. Persisted WITHOUT secrets: `privateKeyRef` is a
 * vault secret NAME; passwords are never stored anywhere.
 */
export interface VpsProfile {
  host: string;
  port: number;
  user: string;
  authMethod: VpsAuthMethod;
  /** Vault secret name holding the PEM private key (authMethod 'key'). */
  privateKeyRef?: string;
  /** TOFU-pinned host key fingerprint, e.g. "SHA256:AbC...". */
  fingerprint?: string;
  /** X display for desktop control. Default ":0". */
  display?: string;
  /** Human label shown in the UI. */
  label?: string;
}

export class VpsProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VpsProfileError';
  }
}

const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9._-]{0,253}[A-Za-z0-9])?$/;
const DISPLAY_RE = /^:[0-9]+(\.[0-9]+)?$/;
const SECRET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isVpsAuthMethod(v: unknown): v is VpsAuthMethod {
  return (
    typeof v === 'string' && (VPS_AUTH_METHODS as readonly string[]).includes(v)
  );
}

/**
 * Validate a user-supplied profile object. Returns a sanitized VpsProfile.
 * Throws VpsProfileError on anything invalid. Secrets (password/privateKey
 * material) are never accepted here — only references.
 */
export function validateVpsProfile(input: unknown): VpsProfile {
  if (typeof input !== 'object' || input === null) {
    throw new VpsProfileError('VPS profile must be an object');
  }
  const o = input as Record<string, unknown>;

  const host = typeof o.host === 'string' ? o.host.trim() : '';
  if (!host || host.length > 255 || !HOST_RE.test(host)) {
    throw new VpsProfileError(
      '"host" must be a plain hostname or IP address (no scheme, no path)',
    );
  }
  const port =
    typeof o.port === 'number' && Number.isInteger(o.port) ? o.port : 22;
  if (typeof o.port !== 'undefined' && (port < 1 || port > 65535)) {
    throw new VpsProfileError('"port" must be an integer 1-65535');
  }
  const user = typeof o.user === 'string' ? o.user.trim() : '';
  if (!user || user.length > 64 || /[\s@/]/.test(user)) {
    throw new VpsProfileError('"user" must be a non-empty login name');
  }
  const authMethod = o.authMethod ?? 'key';
  if (!isVpsAuthMethod(authMethod)) {
    throw new VpsProfileError(
      `"authMethod" must be one of ${VPS_AUTH_METHODS.join(', ')}`,
    );
  }
  // Refuse secret material outright: only a vault reference may be stored.
  for (const banned of ['password', 'privateKey', 'passphrase']) {
    if (o[banned] !== undefined) {
      throw new VpsProfileError(
        `"${banned}" must never be stored in a VPS profile (use privateKeyRef / prompt at connect time)`,
      );
    }
  }
  let privateKeyRef: string | undefined;
  if (o.privateKeyRef !== undefined) {
    if (typeof o.privateKeyRef !== 'string' || !SECRET_NAME_RE.test(o.privateKeyRef)) {
      throw new VpsProfileError('"privateKeyRef" must be a valid vault secret name');
    }
    privateKeyRef = o.privateKeyRef;
  }
  if (authMethod === 'key' && !privateKeyRef) {
    throw new VpsProfileError(
      'authMethod "key" requires "privateKeyRef" (a vault secret name holding the PEM key)',
    );
  }
  let fingerprint: string | undefined;
  if (o.fingerprint !== undefined) {
    if (typeof o.fingerprint !== 'string' || !/^SHA256:[A-Za-z0-9+/=]+$/.test(o.fingerprint.trim())) {
      throw new VpsProfileError('"fingerprint" must look like "SHA256:..."');
    }
    fingerprint = o.fingerprint.trim();
  }
  let display: string | undefined;
  if (o.display !== undefined) {
    if (typeof o.display !== 'string' || !DISPLAY_RE.test(o.display.trim())) {
      throw new VpsProfileError('"display" must look like ":0" or ":0.0"');
    }
    display = o.display.trim();
  }
  const label =
    typeof o.label === 'string' && o.label.trim()
      ? o.label.trim().slice(0, 80)
      : undefined;

  const profile: VpsProfile = { host, port, user, authMethod };
  if (privateKeyRef) profile.privateKeyRef = privateKeyRef;
  if (fingerprint) profile.fingerprint = fingerprint;
  if (display) profile.display = display;
  if (label) profile.label = label;
  return profile;
}

/** The profile as shown in the UI / API: no secret material by construction. */
export function publicVpsProfile(p: VpsProfile): VpsProfile {
  return { ...p };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class VpsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VpsError';
  }
}

/** No profile configured for this bot (and no global default). */
export class VpsNotConfiguredError extends VpsError {
  readonly botId: string;
  constructor(botId: string) {
    super(
      `no VPS profile configured for bot "${botId}". Add one in Bots → Computer → VPS.`,
    );
    this.name = 'VpsNotConfiguredError';
    this.botId = botId;
  }
}

/** First connect: the user must explicitly trust the observed host key. */
export class VpsTrustRequiredError extends VpsError {
  readonly fingerprint: string;
  readonly host: string;
  readonly port: number;
  constructor(host: string, port: number, fingerprint: string) {
    super(
      `VPS ${host}:${port} presents an untrusted host key (${fingerprint}). ` +
        'Trust this fingerprint to connect (TOFU).',
    );
    this.name = 'VpsTrustRequiredError';
    this.host = host;
    this.port = port;
    this.fingerprint = fingerprint;
  }
}

/** The server's host key changed since it was pinned: possible MITM. Hard stop. */
export class VpsFingerprintMismatchError extends VpsError {
  readonly expected: string;
  readonly observed: string;
  constructor(expected: string, observed: string) {
    super(
      `VPS host key MISMATCH: pinned ${expected} but server presented ${observed}. ` +
        'Refusing to connect (possible man-in-the-middle). Re-trust the key explicitly if you rotated it.',
    );
    this.name = 'VpsFingerprintMismatchError';
    this.expected = expected;
    this.observed = observed;
  }
}

/** The connection dropped and the profile needs an interactive password. */
export class VpsPasswordRequiredError extends VpsError {
  constructor() {
    super(
      'VPS connection needs a password (authMethod "password-prompt"): ' +
        'reconnect explicitly — passwords are never stored or reused automatically.',
    );
    this.name = 'VpsPasswordRequiredError';
  }
}

export class VpsAuthError extends VpsError {
  constructor(detail: string) {
    super(`VPS authentication failed: ${detail}`);
    this.name = 'VpsAuthError';
  }
}

export class VpsTimeoutError extends VpsError {
  constructor(what: string, ms: number) {
    super(`${what} timed out after ${ms}ms`);
    this.name = 'VpsTimeoutError';
  }
}

// ---------------------------------------------------------------------------
// Fingerprints
// ---------------------------------------------------------------------------

/** OpenSSH-style SHA256 host-key fingerprint: "SHA256:<base64>". */
export function fingerprintSha256(hostKey: Buffer): string {
  return `SHA256:${createHash('sha256').update(hostKey).digest('base64').replace(/=+$/, '')}`;
}

function normalizeFingerprint(fp: string): string {
  return fp.trim().replace(/=+$/, '');
}

// ---------------------------------------------------------------------------
// SSH client abstraction (injectable for tests)
// ---------------------------------------------------------------------------

export interface SshExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal?: string;
  truncated?: boolean;
}

export interface SshExecOptions {
  timeoutMs: number;
  maxOutputBytes: number;
  /** Bytes piped to the command's stdin (e.g. for `xdotool type --file -`). */
  stdin?: string;
}

export interface SshClientLike {
  /** Run a command; resolves when the remote process exits. */
  exec(command: string, opts: SshExecOptions): Promise<SshExecResult>;
  /** Read a remote file, capped at maxBytes. */
  readFile(path: string, maxBytes: number): Promise<Buffer>;
  /** Write a remote file (creates parent dirs). */
  writeFile(path: string, data: string | Buffer): Promise<void>;
  /** Close the underlying transport. */
  close(): void | Promise<void>;
  /** False after close/timeout — the connection must be re-established. */
  readonly alive: boolean;
}

const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
const DEFAULT_EXEC_MAX_BYTES = 256 * 1024;

function resolveTimeoutMs(v: number | undefined): number {
  return typeof v === 'number' && v > 0 ? Math.min(Math.floor(v), 3_600_000) : DEFAULT_EXEC_TIMEOUT_MS;
}

function resolveMaxBytes(v: number | undefined): number {
  return typeof v === 'number' && v > 0 ? Math.floor(v) : DEFAULT_EXEC_MAX_BYTES;
}

/** Real ssh2-backed client. Construct via connectSsh(). */
class Ssh2ClientAdapter implements SshClientLike {
  private _alive = true;
  constructor(private readonly conn: Client) {}

  get alive(): boolean {
    return this._alive;
  }

  private die(): void {
    this._alive = false;
    try {
      this.conn.end();
    } catch {
      // best-effort
    }
  }

  exec(command: string, opts: SshExecOptions): Promise<SshExecResult> {
    const timeoutMs = opts.timeoutMs;
    const maxBytes = opts.maxOutputBytes;
    return new Promise<SshExecResult>((resolve, reject) => {
      let settled = false;
      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.die();
        reject(err);
      };
      const timer = setTimeout(() => {
        fail(new VpsTimeoutError(`SSH exec "${command.slice(0, 80)}"`, timeoutMs));
      }, timeoutMs);
      // Unref so a hung exec can't hold the process open by itself.
      if (typeof timer.unref === 'function') timer.unref();

      this.conn.exec(command, (err, stream) => {
        if (settled) return;
        if (err || !stream) {
          fail(err ?? new VpsError('SSH exec failed to open a channel'));
          return;
        }
        let outLen = 0;
        let errLen = 0;
        let truncated = false;
        let stdout = '';
        let stderr = '';
        const half = Math.floor(maxBytes / 2);
        const append = (chunk: Buffer, isErr: boolean): void => {
          let len = isErr ? errLen : outLen;
          const room = Math.max(0, half - len);
          if (room <= 0) {
            truncated = true;
            return;
          }
          const slice = chunk.subarray(0, room);
          if (slice.length < chunk.length) truncated = true;
          if (isErr) {
            stderr += slice.toString('utf8');
            errLen += slice.length;
          } else {
            stdout += slice.toString('utf8');
            outLen += slice.length;
          }
        };
        stream.on('data', (d: Buffer) => append(d, false));
        stream.stderr.on('data', (d: Buffer) => append(d, true));
        stream.on('error', (e: Error) => fail(e));
        stream.on('close', (code: number, signal: string) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (truncated) {
            const note = '\n[output truncated: exceeded size cap]';
            if (stdout.length >= stderr.length) stdout += note;
            else stderr += note;
          }
          resolve({
            stdout,
            stderr,
            exitCode: typeof code === 'number' ? code : -1,
            signal: typeof signal === 'string' ? signal : undefined,
            truncated,
          });
        });
        if (opts.stdin !== undefined) {
          stream.end(opts.stdin);
        }
      });
    });
  }

  private withSftp<T>(fn: (sftp: SftpShim) => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.conn.sftp((err, sftp) => {
        if (err || !sftp) {
          reject(err ?? new VpsError('SSH SFTP subsystem unavailable'));
          return;
        }
        fn(sftp as unknown as SftpShim).then(resolve, reject);
      });
    });
  }

  readFile(path: string, maxBytes: number): Promise<Buffer> {
    return this.withSftp(
      (sftp) =>
        new Promise<Buffer>((resolve, reject) => {
          sftp.open(path, 'r', (err, handle) => {
            if (err || !handle) {
              reject(err ?? new VpsError(`SFTP open failed for "${path}"`));
              return;
            }
            const chunks: Buffer[] = [];
            let pos = 0;
            let total = 0;
            const step = (): void => {
              const want = Math.min(64 * 1024, maxBytes - total);
              if (want <= 0) return done(null);
              const buf = Buffer.alloc(want);
              sftp.read(handle, buf, 0, want, pos, (rerr, _bytes, data) => {
                if (rerr) return done(rerr);
                const n = Buffer.isBuffer(data) ? data.length : 0;
                if (n === 0) return done(null);
                chunks.push(data.subarray(0, n));
                pos += n;
                total += n;
                step();
              });
            };
            const done = (e: Error | null): void => {
              sftp.close(handle, () => undefined);
              if (e) reject(e);
              else resolve(Buffer.concat(chunks, total));
            };
            step();
          });
        }),
    );
  }

  writeFile(path: string, data: string | Buffer): Promise<void> {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    if (buf.length > 64 * 1024 * 1024) {
      return Promise.reject(new VpsError('refusing to write >64MB over SFTP'));
    }
    return this.withSftp(
      (sftp) =>
        new Promise<void>((resolve, reject) => {
          // Ensure the parent directory exists (best-effort).
          const dir = path.split('/').slice(0, -1).join('/') || '/';
          sftp.mkdir(dir, () => {
            sftp.open(path, 'w', (err, handle) => {
              if (err || !handle) {
                reject(err ?? new VpsError(`SFTP open for write failed for "${path}"`));
                return;
              }
              sftp.write(handle, buf, 0, buf.length, 0, (werr) => {
                sftp.close(handle, () => undefined);
                if (werr) reject(werr);
                else resolve();
              });
            });
          });
        }),
    );
  }

  close(): void {
    this.die();
  }
}

/** Minimal structural view of ssh2's SFTP wrapper (enough for our use). */
interface SftpShim {
  open(path: string, mode: string, cb: (err: Error | undefined, handle: unknown) => void): void;
  read(
    handle: unknown,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    cb: (err: Error | undefined, bytesRead: number, data: Buffer) => void,
  ): void;
  write(
    handle: unknown,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    cb: (err: Error | undefined) => void,
  ): void;
  close(handle: unknown, cb: () => void): void;
  mkdir(path: string, cb: () => void): void;
}

export interface SshConnectRequest {
  host: string;
  port: number;
  username: string;
  privateKey?: string;
  passphrase?: string;
  password?: string;
  /** Path to the ssh-agent socket (authMethod 'agent'). */
  agentSocket?: string;
  /**
   * Host-key verifier. Return true to accept the key, false to reject.
   * Called during the handshake; MUST be fail-closed (default reject).
   */
  verifyHostKey: (hostKey: Buffer, algo: string) => boolean;
  readyTimeoutMs?: number;
}

/**
 * Open a real SSH connection via ssh2. The hostVerifier is always installed —
 * there is no "trust on first use silently" path; callers implement TOFU by
 * throwing VpsTrustRequiredError when no fingerprint is pinned.
 */
export async function connectSsh(
  req: SshConnectRequest,
  deps: { createClient?: () => Client } = {},
): Promise<SshClientLike> {
  const conn = deps.createClient ? deps.createClient() : new Client();
  return new Promise<SshClientLike>((resolve, reject) => {
    let settled = false;
    const readyTimeout = req.readyTimeoutMs ?? 20_000;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          conn.end();
        } catch {
          // ignore
        }
        reject(new VpsTimeoutError(`SSH connect to ${req.host}:${req.port}`, readyTimeout));
      }
    }, readyTimeout);
    if (typeof timer.unref === 'function') timer.unref();

    conn.on('ready', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(new Ssh2ClientAdapter(conn));
    });
    conn.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      if (/all configured authentication methods failed/i.test(msg)) {
        reject(new VpsAuthError(msg));
      } else {
        reject(new VpsError(`SSH connect to ${req.host}:${req.port} failed: ${msg}`));
      }
    });
    try {
      conn.connect({
        host: req.host,
        port: req.port,
        username: req.username,
        ...(req.privateKey ? { privateKey: req.privateKey } : {}),
        ...(req.passphrase ? { passphrase: req.passphrase } : {}),
        ...(req.password ? { password: req.password } : {}),
        ...(req.agentSocket ? { agent: req.agentSocket } : {}),
        readyTimeout,
        hostVerifier: (key: Buffer) => {
          try {
            return req.verifyHostKey(key, 'unknown') === true;
          } catch {
            return false;
          }
        },
      });
    } catch (err) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err instanceof Error ? err : new VpsError(String(err)));
      }
    }
  });
}

// ---------------------------------------------------------------------------
// VpsConnection — one managed SSH connection with TOFU + reconnect
// ---------------------------------------------------------------------------

export type VpsConnStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface VpsConnectOptions {
  /** Transient password (authMethod 'password-prompt'). Never stored. */
  password?: string;
  /** Accept + report the observed host key (first-trust flow). */
  trustFingerprint?: boolean;
}

export interface VpsConnectionDeps {
  profile: VpsProfile;
  /** Resolve a vault secret name → PEM text. Called at connect time. */
  resolvePrivateKey: (ref: string) => string | undefined;
  /** Test seam: inject a fake client factory. */
  createSshClient?: (req: SshConnectRequest) => Promise<SshClientLike>;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Max auto-reconnect attempts in ensureConnected(). Default 5. */
  maxReconnectAttempts?: number;
  /** Notified when a NEW fingerprint is trusted (API persists it). */
  onFingerprintTrusted?: (fingerprint: string) => void;
  /** Notified on fingerprint mismatch (API surfaces the warning). */
  onFingerprintMismatch?: (expected: string, observed: string) => void;
}

export interface VpsStatusInfo {
  status: VpsConnStatus;
  lastError?: string;
  fingerprint?: string;
  connectedAtMs?: number;
  reconnectAttempts: number;
}

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export class VpsConnection {
  private readonly deps: VpsConnectionDeps;
  private client: SshClientLike | null = null;
  private status: VpsConnStatus = 'disconnected';
  private lastError?: string;
  private connectedAtMs?: number;
  private reconnectAttempts = 0;
  /** The fingerprint currently in effect (pinned or newly trusted). */
  private activeFingerprint: string | undefined;
  private closed = false;

  constructor(deps: VpsConnectionDeps) {
    this.deps = deps;
    this.activeFingerprint = deps.profile.fingerprint;
  }

  get profile(): VpsProfile {
    return this.deps.profile;
  }

  /** Update the pinned fingerprint (e.g. after the user trusts a rotation). */
  setFingerprint(fp: string | undefined): void {
    this.activeFingerprint = fp ? normalizeFingerprint(fp) : undefined;
  }

  statusInfo(): VpsStatusInfo {
    const out: VpsStatusInfo = {
      status: this.status,
      reconnectAttempts: this.reconnectAttempts,
    };
    if (this.lastError) out.lastError = this.lastError;
    if (this.activeFingerprint) out.fingerprint = this.activeFingerprint;
    if (this.connectedAtMs) out.connectedAtMs = this.connectedAtMs;
    return out;
  }

  /** True when there is a live, usable transport. */
  isConnected(): boolean {
    return this.status === 'connected' && !!this.client && this.client.alive;
  }

  private setStatus(s: VpsConnStatus, err?: string): void {
    this.status = s;
    this.lastError = err;
  }

  /**
   * Connect (single attempt). TOFU: without a pinned fingerprint this throws
   * VpsTrustRequiredError unless { trustFingerprint: true }. A changed key
   * throws VpsFingerprintMismatchError and marks the connection fatal (no
   * auto-reconnect).
   */
  async connect(opts: VpsConnectOptions = {}): Promise<{ fingerprint: string; newlyTrusted: boolean }> {
    if (this.closed) throw new VpsError('VPS connection was closed');
    const p = this.deps.profile;
    this.setStatus('connecting');
    this.dropClient();

    const hadPin = !!this.activeFingerprint;
    let observed: string | undefined;
    const verifyHostKey = (hostKey: Buffer): boolean => {
      observed = fingerprintSha256(hostKey);
      if (this.activeFingerprint) {
        return normalizeFingerprint(this.activeFingerprint) === normalizeFingerprint(observed);
      }
      // No pin yet: accept ONLY inside an explicit trust flow. The observed
      // fingerprint is reported back so the caller can persist it (TOFU).
      return opts.trustFingerprint === true;
    };

    if (p.authMethod === 'key') {
      const ref = p.privateKeyRef as string;
      // Key material is block-scoped: resolved fresh for this dial, never
      // stored on the connection object. (JS strings are immutable, so we
      // drop the reference instead of pretending to wipe it.)
      {
        const key = this.deps.resolvePrivateKey(ref);
        if (!key) {
          const err = `vault secret "${ref}" not found or empty`;
          this.setStatus('error', err);
          throw new VpsAuthError(err);
        }
        await this.dial({ privateKey: key }, verifyHostKey);
      }
    } else {
      await this.dial(opts.password ? { password: opts.password } : {}, verifyHostKey);
    }

    // The verifier accepted the key: record the observed fingerprint as the
    // active one (the pinned value, or the newly trusted key).
    if (observed) this.activeFingerprint = observed;
    const newlyTrusted = !hadPin && opts.trustFingerprint === true;
    if (newlyTrusted) {
      try {
        this.deps.onFingerprintTrusted?.(this.activeFingerprint as string);
      } catch {
        // notification must not break a good connection
      }
    }
    this.setStatus('connected');
    this.connectedAtMs = (this.deps.clock ?? Date.now)();
    this.reconnectAttempts = 0;
    return { fingerprint: this.activeFingerprint as string, newlyTrusted };
  }

  /**
   * One SSH dial with the connection's TOFU verifier. Classifies failures:
   * trust-required (no pin, not a trust flow), fingerprint mismatch (MITM),
   * auth, timeout, transport.
   */
  private async dial(
    dialOpts: { privateKey?: string; password?: string },
    verifyHostKey: (hostKey: Buffer) => boolean,
  ): Promise<void> {
    const p = this.deps.profile;
    let observed: string | undefined;
    const verifier = (hostKey: Buffer): boolean => {
      observed = fingerprintSha256(hostKey);
      return verifyHostKey(hostKey);
    };

    if (p.authMethod === 'password-prompt' && !dialOpts.password) {
      this.setStatus('error', 'password required');
      throw new VpsPasswordRequiredError();
    }

    const req: SshConnectRequest = {
      host: p.host,
      port: p.port,
      username: p.user,
      verifyHostKey: verifier,
    };
    if (dialOpts.privateKey) req.privateKey = dialOpts.privateKey;
    if (dialOpts.password) req.password = dialOpts.password;
    if (p.authMethod === 'agent') {
      const sock = process.env.SSH_AUTH_SOCK;
      if (!sock) {
        const err = 'SSH_AUTH_SOCK is not set (no ssh-agent available)';
        this.setStatus('error', err);
        throw new VpsAuthError(err);
      }
      req.agentSocket = sock;
    }

    try {
      const factory = this.deps.createSshClient ?? connectSsh;
      this.client = await factory(req);
    } catch (err) {
      // Distinguish "no pin yet" (trust flow) from "pin changed" (MITM).
      if (!this.activeFingerprint && observed) {
        this.setStatus('error', 'untrusted host key');
        throw new VpsTrustRequiredError(p.host, p.port, observed);
      }
      if (this.activeFingerprint && observed &&
        normalizeFingerprint(this.activeFingerprint) !== normalizeFingerprint(observed)) {
        this.setStatus('error', 'host key mismatch');
        try {
          this.deps.onFingerprintMismatch?.(this.activeFingerprint, observed);
        } catch {
          // notification must never break the hard stop
        }
        throw new VpsFingerprintMismatchError(this.activeFingerprint, observed);
      }
      if (err instanceof VpsAuthError || err instanceof VpsTimeoutError) {
        this.setStatus('error', err.message);
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      this.setStatus('error', msg);
      throw err instanceof VpsError ? err : new VpsError(msg);
    }
  }

  /**
   * Ensure a live connection, reconnecting with backoff on transport drops.
   * Never retries fingerprint mismatches or auth failures; password-auth
   * connections throw VpsPasswordRequiredError (passwords aren't cached).
   */
  async ensureConnected(): Promise<void> {
    if (this.isConnected()) return;
    if (this.closed) throw new VpsError('VPS connection was closed');
    const lastErr = this.lastError ?? '';
    if (/host key mismatch|untrusted host key/i.test(lastErr)) {
      throw new VpsError(`VPS connection is blocked: ${lastErr}`);
    }
    if (this.deps.profile.authMethod === 'password-prompt') {
      throw new VpsPasswordRequiredError();
    }
    const maxAttempts = this.deps.maxReconnectAttempts ?? 5;
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    let last: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      this.reconnectAttempts = attempt + 1;
      try {
        await this.connect();
        return;
      } catch (err) {
        last = err;
        // Fatal: never back off into these.
        if (
          err instanceof VpsFingerprintMismatchError ||
          err instanceof VpsTrustRequiredError ||
          err instanceof VpsAuthError
        ) {
          throw err;
        }
        if (attempt + 1 < maxAttempts) {
          const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
          await sleep(delay);
        }
      }
    }
    throw last instanceof Error ? last : new VpsError('VPS reconnect failed');
  }

  /** Run a command on the VPS (auto-reconnects on drops). */
  async exec(command: string, opts: { timeoutMs?: number; maxOutputBytes?: number; stdin?: string } = {}): Promise<SshExecResult> {
    await this.ensureConnected();
    const client = this.client;
    if (!client) throw new VpsError('VPS not connected');
    const timeoutMs = resolveTimeoutMs(opts.timeoutMs);
    const maxOutputBytes = resolveMaxBytes(opts.maxOutputBytes);
    const execOpts: SshExecOptions = { timeoutMs, maxOutputBytes };
    if (opts.stdin !== undefined) execOpts.stdin = opts.stdin;
    try {
      return await client.exec(command, execOpts);
    } catch (err) {
      // Transport died mid-command: fail this call; the next ensureConnected
      // will re-establish.
      this.dropClient();
      this.setStatus('disconnected', err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  async readFile(path: string, maxBytes = 1_048_576): Promise<Buffer> {
    await this.ensureConnected();
    const client = this.client;
    if (!client) throw new VpsError('VPS not connected');
    return client.readFile(path, maxBytes);
  }

  async writeFile(path: string, data: string | Buffer): Promise<void> {
    await this.ensureConnected();
    const client = this.client;
    if (!client) throw new VpsError('VPS not connected');
    await client.writeFile(path, data);
  }

  /** Best-effort OS identification for the Test-connection endpoint. */
  async osInfo(): Promise<{ os: string; kernel: string; arch: string }> {
    const r = await this.exec('uname -srm', { timeoutMs: 15_000, maxOutputBytes: 1024 });
    const parts = r.stdout.trim().split(/\s+/);
    return {
      os: parts[0] ?? 'unknown',
      kernel: parts[1] ?? 'unknown',
      arch: parts[2] ?? 'unknown',
    };
  }

  /** Close the connection permanently (pool drop / profile delete). */
  async close(): Promise<void> {
    this.closed = true;
    this.dropClient();
    this.setStatus('disconnected');
  }

  private dropClient(): void {
    const c = this.client;
    this.client = null;
    if (c) {
      try {
        const r = c.close();
        if (r instanceof Promise) r.catch(() => undefined);
      } catch {
        // best-effort
      }
    }
  }
}

// ---------------------------------------------------------------------------
// VpsSandbox — the sandbox command interface over SSH
// ---------------------------------------------------------------------------

/**
 * Implements the same command interface as tools/sandbox.ts
 * (SandboxCommandOptions → SandboxCommandResult) plus SFTP file access,
 * backed by a VpsConnection.
 */
export class VpsSandbox {
  constructor(private readonly conn: VpsConnection) {}

  get connection(): VpsConnection {
    return this.conn;
  }

  async runCommand(command: string, opts: SandboxCommandOptions = {}): Promise<SandboxCommandResult> {
    const timeoutMs = resolveTimeoutMs(opts.timeoutMs);
    const maxOutputBytes = resolveMaxBytes(opts.maxOutputBytes);
    try {
      const r = await this.conn.exec(command, { timeoutMs, maxOutputBytes });
      return {
        stdout: r.stdout,
        stderr: r.stderr,
        exitCode: r.exitCode,
        ...(r.signal === 'SIGTERM' || /timed out/i.test(r.stderr) ? { timedOut: true as const } : {}),
      };
    } catch (err) {
      if (err instanceof VpsTimeoutError) {
        return { stdout: '', stderr: err.message, exitCode: 124, timedOut: true };
      }
      throw err;
    }
  }

  /** Read a remote file as UTF-8 text (capped). */
  async readFile(path: string, maxBytes = 1_048_576): Promise<string> {
    return (await this.conn.readFile(path, maxBytes)).toString('utf8');
  }

  /** Write UTF-8 text to a remote file (creates parent dirs). */
  async writeFile(path: string, data: string): Promise<void> {
    await this.conn.writeFile(path, data);
  }

  async osInfo(): Promise<{ os: string; kernel: string; arch: string }> {
    return this.conn.osInfo();
  }
}

// ---------------------------------------------------------------------------
// VpsComputerLayer — OSScreenLayer driving the VPS desktop via xdotool
// ---------------------------------------------------------------------------

export interface VpsComputerLayerDeps {
  /** X display override (profile.display wins when set). */
  display?: string;
  /** Audit hook for real input actions (wired to governance by the host). */
  onRealAction?: (action: string, detail: unknown) => void;
  clock?: () => number;
}

const DISPLAY_PREFIX_RE = /^:[0-9]+(\.[0-9]+)?$/;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const KEYSYM_RE = /^[A-Za-z0-9_+-]+$/;

function checkCoord(n: number, what: string): number {
  if (!Number.isInteger(n) || n < 0 || n > 32767) {
    throw new VpsError(`VPS computer: ${what} must be an integer 0-32767 (got ${n})`);
  }
  return n;
}

/** Map KriyaDot key names to xdotool keysyms. */
function toXdotoolKey(name: string): string {
  const lower = name.toLowerCase();
  const map: Record<string, string> = {
    enter: 'Return',
    return: 'Return',
    space: 'space',
    escape: 'Escape',
    esc: 'Escape',
    backspace: 'BackSpace',
    delete: 'Delete',
    tab: 'Tab',
    up: 'Up',
    down: 'Down',
    left: 'Left',
    right: 'Right',
    home: 'Home',
    end: 'End',
    pageup: 'Page_Up',
    pagedown: 'Page_Down',
    printscreen: 'Print',
  };
  if (map[lower]) return map[lower];
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(name)) return name.toUpperCase();
  if (/^[a-z0-9]$/i.test(name)) return name.toLowerCase();
  if (KEYSYM_RE.test(name)) return name;
  throw new VpsError(`VPS computer: unsupported key name "${name}"`);
}

const XDOTOOL_MODIFIERS: Record<ChordModifier, string> = {
  ctrl: 'ctrl',
  shift: 'shift',
  alt: 'alt',
  meta: 'Super_L',
};

/** Parse "width height" from PNG IHDR (no decoder needed). */
export function pngDimensions(png: Buffer): { w: number; h: number } | null {
  if (png.length < 26) return null;
  if (png[12] !== 0x49 || png[13] !== 0x48 || png[14] !== 0x44 || png[15] !== 0x52) return null;
  return { w: png.readUInt32BE(16), h: png.readUInt32BE(20) };
}

/**
 * Drives the VPS's X11 desktop over SSH. Requires `xdotool` plus a screenshot
 * tool (ImageMagick `import`, scrot fallback) on the VPS — checked on first
 * use with a clear install hint when missing.
 */
export class VpsComputerLayer implements OSScreenLayer {
  private readonly display: string;
  private toolsChecked = false;
  private hasImport = false;
  private hasScrot = false;

  constructor(
    private readonly conn: VpsConnection,
    private readonly deps: VpsComputerLayerDeps = {},
  ) {
    const d = conn.profile.display ?? deps.display ?? ':0';
    if (!DISPLAY_PREFIX_RE.test(d)) {
      throw new VpsProfileError(`invalid X display "${d}"`);
    }
    this.display = d;
  }

  private audit(action: string, detail: unknown): void {
    try {
      this.deps.onRealAction?.(`vps:${action}`, detail);
    } catch {
      // audit must never break input
    }
  }

  private async sh(command: string, opts: { stdin?: string; timeoutMs?: number; maxOutputBytes?: number } = {}): Promise<SshExecResult> {
    // DISPLAY is validated against DISPLAY_PREFIX_RE at construction.
    return this.conn.exec(`DISPLAY=${this.display} ${command}`, {
      timeoutMs: opts.timeoutMs ?? 30_000,
      maxOutputBytes: opts.maxOutputBytes ?? 256 * 1024,
      ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
    });
  }

  /** Verify xdotool + a screenshot tool exist on the VPS (once). */
  private async ensureTools(): Promise<void> {
    if (this.toolsChecked) return;
    const r = await this.sh('command -v xdotool; command -v import; command -v scrot', {
      timeoutMs: 15_000,
      maxOutputBytes: 4096,
    });
    const lines = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    const hasXdotool = lines.some((l) => l.endsWith('/xdotool'));
    this.hasImport = lines.some((l) => l.endsWith('/import'));
    this.hasScrot = lines.some((l) => l.endsWith('/scrot'));
    if (!hasXdotool) {
      throw new VpsError(
        'VPS desktop control needs xdotool on the VPS (e.g. `sudo apt install xdotool`). ' +
          'Shell commands still work without it.',
      );
    }
    if (!this.hasImport && !this.hasScrot) {
      throw new VpsError(
        'VPS screenshots need ImageMagick (`sudo apt install imagemagick`) or scrot on the VPS.',
      );
    }
    this.toolsChecked = true;
  }

  async displaySize(): Promise<DisplaySize> {
    await this.ensureTools();
    const r = await this.sh('xdotool getdisplaygeometry', { timeoutMs: 15_000, maxOutputBytes: 256 });
    const m = r.stdout.trim().match(/^(\d+)\s+(\d+)$/);
    if (!m) throw new VpsError(`unexpected getdisplaygeometry output: ${r.stdout.slice(0, 80)}`);
    return { width: Number(m[1]), height: Number(m[2]) };
  }

  async screenshot(): Promise<Screenshot> {
    await this.ensureTools();
    // Binary-safe path: render to a temp file on the VPS, then pull it over
    // SFTP (exec() decodes stdout as UTF-8, which would corrupt PNG bytes).
    const png = this.hasImport
      ? await this.screenshotViaTempFile('import -window root')
      : await this.screenshotViaTempFile('scrot -z');
    if (!png || !png.subarray(0, 8).equals(PNG_SIG)) {
      throw new VpsError('VPS screenshot did not return PNG data');
    }
    const dims = pngDimensions(png);
    if (!dims) throw new VpsError('VPS screenshot returned an unreadable PNG');
    return { png: new Uint8Array(png), width: dims.w, height: dims.h };
  }

  private async screenshotViaTempFile(tool: 'import -window root' | 'scrot -z'): Promise<Buffer | null> {
    const tmp = `/tmp/kriyadot-shot-${Date.now()}-${Math.floor(Math.random() * 1e6)}.png`;
    try {
      const cmd =
        tool === 'import -window root'
          ? `import -window root '${tmp}'`
          : `scrot -z '${tmp}'`;
      // Single quotes: tmp is generated by us (no user input), safe.
      const r = await this.sh(`${cmd} && wc -c < '${tmp}'`, {
        timeoutMs: 30_000,
        maxOutputBytes: 256,
      });
      if (r.exitCode !== 0) return null;
      const size = Number(r.stdout.trim());
      if (!Number.isFinite(size) || size <= 0 || size > 12 * 1024 * 1024) return null;
      return await this.conn.readFile(tmp, 12 * 1024 * 1024);
    } catch {
      return null;
    } finally {
      try {
        await this.sh(`rm -f '${tmp}'`, { timeoutMs: 10_000, maxOutputBytes: 256 });
      } catch {
        // best-effort cleanup
      }
    }
  }

  async click(x: number, y: number, opts: ClickOptions = {}): Promise<void> {
    await this.ensureTools();
    checkCoord(x, 'x');
    checkCoord(y, 'y');
    const button = opts.button === 'right' ? 3 : opts.button === 'middle' ? 2 : 1;
    const clicks = Math.min(5, Math.max(1, Math.floor(opts.clicks ?? 1)));
    this.audit('click', { x, y, button, clicks });
    const r = await this.sh(
      `xdotool mousemove --sync ${x} ${y} click --clearmodifiers --repeat ${clicks} ${button}`,
    );
    if (r.exitCode !== 0) throw new VpsError(`xdotool click failed: ${r.stderr.slice(0, 200)}`);
  }

  async move(x: number, y: number): Promise<void> {
    await this.ensureTools();
    checkCoord(x, 'x');
    checkCoord(y, 'y');
    const r = await this.sh(`xdotool mousemove --sync ${x} ${y}`);
    if (r.exitCode !== 0) throw new VpsError(`xdotool mousemove failed: ${r.stderr.slice(0, 200)}`);
  }

  async type(text: string): Promise<void> {
    await this.ensureTools();
    if (!text) return;
    if (text.length > 20_000) {
      throw new VpsError('VPS type: text capped at 20,000 chars per call');
    }
    this.audit('type', { chars: text.length });
    // Via stdin: no shell quoting issues with special characters.
    const r = await this.sh('xdotool type --clearmodifiers --delay 0 --file -', {
      stdin: text,
      timeoutMs: 60_000,
      maxOutputBytes: 4096,
    });
    if (r.exitCode !== 0) throw new VpsError(`xdotool type failed: ${r.stderr.slice(0, 200)}`);
  }

  async key(name: string): Promise<void> {
    await this.ensureTools();
    const keysym = toXdotoolKey(name);
    this.audit('key', { key: keysym });
    const r = await this.sh(`xdotool key --clearmodifiers ${keysym}`);
    if (r.exitCode !== 0) throw new VpsError(`xdotool key failed: ${r.stderr.slice(0, 200)}`);
  }

  async keyChord(modifiers: ChordModifier[], key: string): Promise<void> {
    await this.ensureTools();
    const mods = modifiers.map((m) => {
      const mapped = XDOTOOL_MODIFIERS[m];
      if (!mapped) throw new VpsError(`VPS computer: unsupported modifier "${m}"`);
      return mapped;
    });
    const keysym = toXdotoolKey(key);
    const chord = [...mods, keysym].join('+');
    if (!/^[A-Za-z0-9_+]+$/.test(chord)) {
      throw new VpsError(`VPS computer: invalid chord "${chord}"`);
    }
    this.audit('keyChord', { chord });
    const r = await this.sh(`xdotool key --clearmodifiers ${chord}`);
    if (r.exitCode !== 0) throw new VpsError(`xdotool key failed: ${r.stderr.slice(0, 200)}`);
  }

  async scroll(x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
    await this.ensureTools();
    checkCoord(x, 'x');
    checkCoord(y, 'y');
    const stepsFor = (d: number): number =>
      d === 0 ? 0 : Math.min(10, Math.max(1, Math.round(Math.abs(d) / 120)));
    const vSteps = stepsFor(deltaY);
    const hSteps = stepsFor(deltaX);
    if (vSteps === 0 && hSteps === 0) return;
    this.audit('scroll', { x, y, deltaX, deltaY });
    const vButton = deltaY > 0 ? 5 : 4; // 5 = down, 4 = up
    const hButton = deltaX > 0 ? 7 : 6; // 7 = right, 6 = left
    const parts = [`mousemove --sync ${x} ${y}`];
    if (vSteps > 0) parts.push(`click --clearmodifiers --repeat ${vSteps} ${vButton}`);
    if (hSteps > 0) parts.push(`click --clearmodifiers --repeat ${hSteps} ${hButton}`);
    const r = await this.sh(`xdotool ${parts.join(' ')}`);
    if (r.exitCode !== 0) throw new VpsError(`xdotool scroll failed: ${r.stderr.slice(0, 200)}`);
  }

  async drag(x1: number, y1: number, x2: number, y2: number, opts: DragOptions): Promise<void> {
    await this.ensureTools();
    checkCoord(x1, 'x1');
    checkCoord(y1, 'y1');
    checkCoord(x2, 'x2');
    checkCoord(y2, 'y2');
    const button = opts.button === 'right' ? 3 : opts.button === 'middle' ? 2 : 1;
    this.audit('drag', { x1, y1, x2, y2, button });
    const r = await this.sh(
      `xdotool mousemove --sync ${x1} ${y1} mousedown ${button} mousemove --sync ${x2} ${y2} mouseup ${button}`,
      { timeoutMs: 60_000 },
    );
    if (r.exitCode !== 0) throw new VpsError(`xdotool drag failed: ${r.stderr.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// VpsConnectionPool — one managed connection per key
// ---------------------------------------------------------------------------

export interface VpsPoolDeps {
  /** Vault lookup: secret name → PEM text (server-side). */
  resolvePrivateKey: (ref: string) => string | undefined;
  createSshClient?: (req: SshConnectRequest) => Promise<SshClientLike>;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onFingerprintTrusted?: (key: string, fingerprint: string) => void;
  onFingerprintMismatch?: (key: string, expected: string, observed: string) => void;
}

/**
 * Owns VpsConnections keyed by an arbitrary id (the API uses `bot:<botId>`).
 * The pool does NOT store profiles — callers pass the current profile to
 * getOrCreate(); a changed profile (host/user/auth) replaces the connection.
 */
export class VpsConnectionPool {
  private readonly conns = new Map<string, VpsConnection>();
  private readonly deps: VpsPoolDeps;

  constructor(deps: VpsPoolDeps) {
    this.deps = deps;
  }

  private sameProfile(a: VpsProfile, b: VpsProfile): boolean {
    return (
      a.host === b.host &&
      a.port === b.port &&
      a.user === b.user &&
      a.authMethod === b.authMethod &&
      (a.privateKeyRef ?? '') === (b.privateKeyRef ?? '') &&
      (a.fingerprint ?? '') === (b.fingerprint ?? '') &&
      (a.display ?? '') === (b.display ?? '')
    );
  }

  getOrCreate(key: string, profile: VpsProfile): VpsConnection {
    const existing = this.conns.get(key);
    if (existing && this.sameProfile(existing.profile, profile)) return existing;
    if (existing) {
      void existing.close().catch(() => undefined);
      this.conns.delete(key);
    }
    const conn = new VpsConnection({
      profile,
      resolvePrivateKey: this.deps.resolvePrivateKey,
      ...(this.deps.createSshClient ? { createSshClient: this.deps.createSshClient } : {}),
      ...(this.deps.clock ? { clock: this.deps.clock } : {}),
      ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}),
      onFingerprintTrusted: (fp) => this.deps.onFingerprintTrusted?.(key, fp),
      onFingerprintMismatch: (expected, observed) =>
        this.deps.onFingerprintMismatch?.(key, expected, observed),
    });
    this.conns.set(key, conn);
    return conn;
  }

  get(key: string): VpsConnection | undefined {
    return this.conns.get(key);
  }

  /** Disconnect and forget a connection. Best-effort, never throws. */
  async drop(key: string): Promise<void> {
    const conn = this.conns.get(key);
    if (!conn) return;
    this.conns.delete(key);
    try {
      await conn.close();
    } catch {
      // ignore
    }
  }

  statuses(): Array<{ key: string } & VpsStatusInfo> {
    return [...this.conns.entries()].map(([key, conn]) => ({ key, ...conn.statusInfo() }));
  }

  /** Close everything (shutdown). */
  async closeAll(): Promise<void> {
    const keys = [...this.conns.keys()];
    await Promise.all(keys.map((k) => this.drop(k)));
  }
}

// Re-export the sandbox option/result types for consumers.
export type { SandboxCommandOptions, SandboxCommandResult };
