// SPDX-License-Identifier: Apache-2.0

/**
 * Sandboxed command execution backend for `run_command`.
 *
 * Backend selection (first match wins):
 *   1. E2B cloud sandbox, when `E2B_API_KEY` is set in the environment
 *      (free tier; API key is read from env only, never hardcoded).
 *   2. Local Docker, via `docker run` with resource limits and no network.
 *   3. Fail closed with a descriptive error when neither is available.
 *
 * Trust guarantees kept: deny-by-default approvals stay in the caller
 * (coordinator wiring), sandbox commands run with no network access unless
 * the caller explicitly opts in, and output is capped to bound memory.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Sandbox } from 'e2b';
import {
  landlockHelperReady,
  runInLandlock,
  runInSeatbelt,
  seatbeltAvailable,
} from './sandbox-kernel.js';

export interface SandboxCommandOptions {
  /** Kill the command after this many ms (default 60_000). */
  timeoutMs?: number;
  /** Cap each of stdout/stderr at this many bytes (default 256KB), truncating with a notice. */
  maxOutputBytes?: number;
  /** Allow network access inside the sandbox. Default false (no network). */
  network?: boolean;
}

export interface SandboxCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** True when the command was killed because it exceeded timeoutMs. */
  timedOut?: boolean;
}

export type SandboxBackend = 'e2b' | 'docker' | 'landlock' | 'seatbelt' | 'none';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024; // 256KB
const TIMEOUT_EXIT_CODE = 124;

/** Sentinel brand for "our own timeout fired" so we can report timedOut. */
const kTimedOut = Symbol('timedOut');

interface TimeoutRejection extends Error {
  [kTimedOut]?: true;
}

function resolveTimeoutMs(timeoutMs?: number): number {
  return typeof timeoutMs === 'number' && timeoutMs > 0
    ? Math.min(Math.floor(timeoutMs), 3_600_000)
    : DEFAULT_TIMEOUT_MS;
}

function resolveMaxOutputBytes(maxOutputBytes?: number): number {
  return typeof maxOutputBytes === 'number' && maxOutputBytes > 0
    ? Math.floor(maxOutputBytes)
    : DEFAULT_MAX_OUTPUT_BYTES;
}

/** Race a promise against `ms`; on expiry runs `onExpire` and rejects with a branded error. */
function withTimeout<T>(promise: Promise<T>, ms: number, onExpire: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`Command timed out after ${ms}ms`) as TimeoutRejection;
      err[kTimedOut] = true;
      try {
        onExpire();
      } catch {
        /* best-effort cleanup */
      }
      reject(err);
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function isOurTimeout(err: unknown): err is TimeoutRejection {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as TimeoutRejection)[kTimedOut] === true
  );
}

/** E2B's CommandExitError carries exitCode/stdout/stderr getters; duck-type it so we stay robust to SDK changes. */
function asCompletedResult(err: unknown): { exitCode: number; stdout: string; stderr: string } | null {
  if (typeof err !== 'object' || err === null) return null;
  const e = err as { exitCode?: unknown; stdout?: unknown; stderr?: unknown };
  if (typeof e.exitCode === 'number' && typeof e.stdout === 'string' && typeof e.stderr === 'string') {
    return { exitCode: e.exitCode, stdout: e.stdout, stderr: e.stderr };
  }
  return null;
}

/**
 * Which sandbox backend is available right now.
 * E2B wins when `E2B_API_KEY` is present; otherwise Docker if the CLI
 * works. `SANDBOX_BACKEND` forces a backend (validated against
 * availability; an unavailable choice falls through to auto). With
 * `SANDBOX_KERNEL_FALLBACK=1`, kernel backends join the auto chain
 * after Docker: Landlock on Linux (once its helper is compiled) and
 * Seatbelt on macOS.
 */
export function sandboxBackend(): SandboxBackend {
  const forced = (process.env.SANDBOX_BACKEND ?? '').trim().toLowerCase();
  if (forced === 'landlock' && landlockHelperReady()) return 'landlock';
  if (forced === 'seatbelt' && seatbeltAvailable()) return 'seatbelt';
  if (forced === 'none') return 'none';
  if (typeof process.env.E2B_API_KEY === 'string' && process.env.E2B_API_KEY.trim() !== '') {
    return 'e2b';
  }
  if (dockerAvailable()) return 'docker';
  if ((process.env.SANDBOX_KERNEL_FALLBACK ?? '') === '1') {
    if (landlockHelperReady()) return 'landlock';
    if (seatbeltAvailable()) return 'seatbelt';
  }
  return 'none';
}

function dockerAvailable(): boolean {
  try {
    const res = spawnSync('docker', ['info', '--format', '{{json .ServerVersion}}'], {
      timeout: 8_000,
      windowsHide: true,
      stdio: 'ignore',
    });
    return !res.error && res.status === 0;
  } catch {
    return false;
  }
}

function dockerImage(): string {
  return process.env.SANDBOX_DOCKER_IMAGE?.trim() || 'alpine:latest';
}

/** E2B path: run `cmd` in a fresh cloud sandbox with no network by default. */
async function runInE2B(cmd: string, opts: SandboxCommandOptions): Promise<SandboxCommandResult> {
  const timeoutMs = resolveTimeoutMs(opts.timeoutMs);
  const maxBytes = resolveMaxOutputBytes(opts.maxOutputBytes);
  const allowInternetAccess = opts.network === true;

  let sbx: Sandbox;
  try {
    // Sandbox lifetime is bounded to just over the command timeout so a stuck
    // run can't leave the sandbox alive; we still kill it explicitly below.
    // Honor the process egress proxy when set (some sandboxes/VPNs route all
    // egress through a proxy the SDK's bundled fetch would otherwise ignore).
    const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
    sbx = await Sandbox.create({
      allowInternetAccess,
      timeoutMs: timeoutMs + 30_000,
      ...(proxy ? { proxy } : {}),
    });
  } catch (err) {
    throw new Error(
      `E2B sandbox creation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Accumulate stream chunks with a hard per-stream cap (bounds memory even
  // for pathological `yes`-style output); truncation notice added at the end.
  let stdout = '';
  let stderr = '';
  let truncatedStdout = false;
  let truncatedStderr = false;
  const onChunk = (into: 'stdout' | 'stderr', chunk: string): void => {
    let target = into === 'stdout' ? stdout : stderr;
    const room = maxBytes - Buffer.byteLength(target, 'utf8');
    if (room <= 0) {
      if (into === 'stdout') truncatedStdout = true;
      else truncatedStderr = true;
      return;
    }
    const bytes = Buffer.from(chunk, 'utf8');
    if (bytes.byteLength > room) {
      target += bytes.subarray(0, room).toString('utf8');
      if (into === 'stdout') truncatedStdout = true;
      else truncatedStderr = true;
    } else {
      target += chunk;
    }
    if (into === 'stdout') stdout = target;
    else stderr = target;
  };
  const capNotice = (s: string, wasTruncated: boolean): string =>
    wasTruncated ? s + `\n…[truncated to ${maxBytes} bytes]` : s;
  const finalize = (result: { exitCode: number; timedOut?: boolean }): SandboxCommandResult => ({
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stdout: capNotice(stdout, truncatedStdout),
    stderr: capNotice(stderr, truncatedStderr),
  });

  try {
    const handle = await sbx.commands.run(cmd, {
      background: true,
      timeoutMs, // envd kills the process remotely at this deadline
      onStdout: (data) => onChunk('stdout', data),
      onStderr: (data) => onChunk('stderr', data),
    });
    const result = await withTimeout(handle.wait(), timeoutMs, () => {
      // Belt-and-braces: if our own timer fires first, kill the remote process.
      void handle.kill().catch(() => {});
    });
    return finalize({ exitCode: result.exitCode });
  } catch (err) {
    if (isOurTimeout(err)) {
      return finalize({ exitCode: TIMEOUT_EXIT_CODE, timedOut: true });
    }
    const completed = asCompletedResult(err); // CommandExitError on non-zero exit
    if (completed) {
      return finalize({ exitCode: completed.exitCode });
    }
    throw new Error(
      `E2B sandbox execution failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    await sbx.kill().catch(() => {});
  }
}

/** Docker path: `docker run --rm` with resource limits, no network by default. */
async function runInDocker(cmd: string, opts: SandboxCommandOptions): Promise<SandboxCommandResult> {
  const timeoutMs = resolveTimeoutMs(opts.timeoutMs);
  const maxBytes = resolveMaxOutputBytes(opts.maxOutputBytes);
  const network = opts.network === true;

  // M7: unique container name so a timed-out / errored / completed run can
  // be reaped explicitly. `--rm` removes the container on clean exit, but a
  // SIGKILLed `docker run` client can leave the container behind — hence the
  // best-effort `docker kill` on every terminal path below.
  const containerName = `kriyadot-sandbox-${randomUUID().replace(/-/g, '').slice(0, 12)}`;

  const args = [
    'run',
    '--rm',
    '--name',
    containerName,
    '--network',
    network ? 'bridge' : 'none',
    '--memory',
    '512m',
    '--memory-swap',
    '512m',
    '--cpus',
    '1.0',
    '--pids-limit',
    '256',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=64m',
    '--workdir',
    '/tmp',
    dockerImage(),
    'sh',
    '-c',
    cmd,
  ];

  return new Promise<SandboxCommandResult>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      reject(new Error(`Docker backend failed to start: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }

    /** Best-effort container reaping (M7): never throws, never blocks. */
    const reapContainer = (): void => {
      try {
        const killer = spawn('docker', ['kill', containerName], {
          stdio: 'ignore',
          windowsHide: true,
        });
        killer.on('error', () => {});
        (killer as { unref?: () => void }).unref?.();
      } catch {
        // ignore — cleanup is best-effort
      }
    };

    let stdout = '';
    let stderr = '';
    let truncatedStdout = false;
    let truncatedStderr = false;
    const onData = (into: 'stdout' | 'stderr', data: Buffer): void => {
      let target = into === 'stdout' ? stdout : stderr;
      const room = maxBytes - Buffer.byteLength(target, 'utf8');
      if (room <= 0) {
        if (into === 'stdout') truncatedStdout = true;
        else truncatedStderr = true;
        return;
      }
      if (data.byteLength > room) {
        target += data.subarray(0, room).toString('utf8');
        if (into === 'stdout') truncatedStdout = true;
        else truncatedStderr = true;
      } else {
        target += data.toString('utf8');
      }
      if (into === 'stdout') stdout = target;
      else stderr = target;
    };
    const capNotice = (s: string, wasTruncated: boolean): string =>
      wasTruncated ? s + `\n…[truncated to ${maxBytes} bytes]` : s;
    const finish = (exitCode: number, timedOut = false): SandboxCommandResult => ({
      exitCode,
      timedOut: timedOut || undefined,
      stdout: capNotice(stdout, truncatedStdout),
      stderr: capNotice(stderr, truncatedStderr),
    });

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reapContainer(); // M7: the SIGKILLed client may leave the container behind
      resolve(finish(TIMEOUT_EXIT_CODE, true));
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on('data', (d: Buffer) => onData('stdout', d));
    child.stderr?.on('data', (d: Buffer) => onData('stderr', d));
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reapContainer(); // M7: clean up the container on spawn/stream errors too
      reject(new Error(`Docker backend failed: ${err.message}`));
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reapContainer(); // M7: no-op when --rm already removed it; ignored on error
      resolve(finish(signal === 'SIGKILL' ? TIMEOUT_EXIT_CODE : (code ?? 1)));
    });
  });
}

/**
 * Execute a shell command inside an isolated sandbox (E2B cloud or local Docker).
 * No network access inside the sandbox unless `opts.network` is true.
 * Throws (fail closed) when no backend is available.
 */
export async function executeSandboxedCommand(
  cmd: string,
  opts: SandboxCommandOptions = {},
): Promise<SandboxCommandResult> {
  const backend = sandboxBackend();
  if (backend === 'e2b') return runInE2B(cmd, opts);
  if (backend === 'docker') return runInDocker(cmd, opts);
  if (backend === 'landlock') return runInLandlock(cmd, opts);
  if (backend === 'seatbelt') return runInSeatbelt(cmd, opts);
  // First-use path: kernel fallback requested but the Landlock helper
  // is not compiled yet — compile + probe now, then run confined
  // rather than failing closed when the kernel can protect the run.
  const forced = (process.env.SANDBOX_BACKEND ?? '').trim().toLowerCase();
  if (forced === 'landlock' || (process.env.SANDBOX_KERNEL_FALLBACK ?? '') === '1') {
    if (process.platform === 'linux') return runInLandlock(cmd, opts);
    if (process.platform === 'darwin') return runInSeatbelt(cmd, opts);
  }
  throw new Error(
    'No sandbox backend available: set E2B_API_KEY for the E2B cloud sandbox, ' +
      'install Docker for the local sandbox, or enable a kernel backend ' +
      '(SANDBOX_KERNEL_FALLBACK=1 for Landlock on Linux / Seatbelt on macOS).',
  );
}

/**
 * Connect to an existing persistent E2B sandbox by ID.
 * Throws if E2B_API_KEY is not set or the sandbox is gone.
 */
export async function connectPersistentSandbox(sandboxId: string): Promise<Sandbox> {
  if (typeof process.env.E2B_API_KEY !== 'string' || process.env.E2B_API_KEY.trim() === '') {
    throw new Error('E2B_API_KEY is not set — persistent environments require E2B.');
  }
  try {
    return await Sandbox.connect(sandboxId);
  } catch (err) {
    throw new Error(
      `Failed to connect to sandbox "${sandboxId}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Create a new persistent E2B sandbox (long-lived, not killed after use).
 * Returns the sandbox ID for reconnection. The sandbox stays alive for
 * `timeoutMs` (default 12h); callers should handle expiry by recreating.
 */
export async function createPersistentSandbox(timeoutMs = 12 * 3_600_000): Promise<string> {
  if (typeof process.env.E2B_API_KEY !== 'string' || process.env.E2B_API_KEY.trim() === '') {
    throw new Error('E2B_API_KEY is not set — persistent environments require E2B.');
  }
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  try {
    const sbx = await Sandbox.create({
      timeoutMs,
      ...(proxy ? { proxy } : {}),
    });
    return sbx.sandboxId;
  } catch (err) {
    throw new Error(
      `E2B persistent sandbox creation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Run a command inside an existing persistent E2B sandbox.
 * The sandbox is NOT killed — it stays alive for reuse.
 */
export async function executeInPersistentSandbox(
  sandboxId: string,
  cmd: string,
  opts: SandboxCommandOptions = {},
): Promise<SandboxCommandResult> {
  const sbx = await connectPersistentSandbox(sandboxId);
  const timeoutMs = resolveTimeoutMs(opts.timeoutMs);
  const maxBytes = resolveMaxOutputBytes(opts.maxOutputBytes);

  let stdout = '';
  let stderr = '';
  let truncatedStdout = false;
  let truncatedStderr = false;
  const onChunk = (into: 'stdout' | 'stderr', chunk: string): void => {
    let target = into === 'stdout' ? stdout : stderr;
    const room = maxBytes - Buffer.byteLength(target, 'utf8');
    if (room <= 0) {
      if (into === 'stdout') truncatedStdout = true;
      else truncatedStderr = true;
      return;
    }
    const bytes = Buffer.from(chunk, 'utf8');
    if (bytes.byteLength > room) {
      target += bytes.subarray(0, room).toString('utf8');
      if (into === 'stdout') truncatedStdout = true;
      else truncatedStderr = true;
    } else {
      target += chunk;
    }
    if (into === 'stdout') stdout = target;
    else stderr = target;
  };
  const capNotice = (s: string, wasTruncated: boolean): string =>
    wasTruncated ? s + `\n…[truncated to ${maxBytes} bytes]` : s;

  try {
    const handle = await sbx.commands.run(cmd, {
      background: true,
      timeoutMs,
      onStdout: (data) => onChunk('stdout', data),
      onStderr: (data) => onChunk('stderr', data),
    });
    const result = await withTimeout(handle.wait(), timeoutMs, () => {
      void handle.kill().catch(() => {});
    });
    return {
      exitCode: result.exitCode,
      stdout: capNotice(stdout, truncatedStdout),
      stderr: capNotice(stderr, truncatedStderr),
    };
  } catch (err) {
    if (isOurTimeout(err)) {
      return { exitCode: TIMEOUT_EXIT_CODE, timedOut: true, stdout: capNotice(stdout, truncatedStdout), stderr: capNotice(stderr, truncatedStderr) };
    }
    const completed = asCompletedResult(err);
    if (completed) {
      return { exitCode: completed.exitCode, stdout: capNotice(stdout, truncatedStdout), stderr: capNotice(stderr, truncatedStderr) };
    }
    throw new Error(
      `E2B persistent sandbox execution failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // NOTE: intentionally no sbx.kill() — the sandbox persists.
}

/**
 * Kill a persistent E2B sandbox by ID. Best-effort; never throws.
 */
export async function killPersistentSandbox(sandboxId: string): Promise<void> {
  try {
    const sbx = await Sandbox.connect(sandboxId);
    await sbx.kill();
  } catch {
    // Already gone or unreachable — treat as stopped.
  }
}

/**
 * List files in a persistent E2B sandbox at the given path.
 */
export async function listPersistentSandboxFiles(
  sandboxId: string,
  path = '/',
): Promise<Array<{ name: string; type: 'file' | 'dir'; size?: number }>> {
  const sbx = await connectPersistentSandbox(sandboxId);
  try {
    const entries = await sbx.files.list(path);
    return entries.map((e) => ({
      name: e.name,
      type: e.type === 'dir' ? 'dir' : 'file',
    }));
  } catch (err) {
    throw new Error(
      `Failed to list files in sandbox "${sandboxId}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
