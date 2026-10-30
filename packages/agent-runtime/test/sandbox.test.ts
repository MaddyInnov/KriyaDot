// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the sandboxed command backend (src/tools/sandbox.ts).
 *
 * The real E2B network client and the real docker CLI are NEVER touched here:
 *  - 'e2b' is replaced with a fake Sandbox class via vi.mock.
 *  - 'node:child_process' is replaced with fake spawn/spawnSync.
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Fake E2B module state (mutable per test; referenced by the hoisted factory)
// ---------------------------------------------------------------------------
interface FakeHandle {
  wait: () => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  kill: () => Promise<boolean>;
}

interface FakeSandbox {
  commands: { run: (cmd: string, opts: Record<string, unknown>) => Promise<FakeHandle> };
  kill: () => Promise<boolean>;
  killed: boolean;
}

interface E2BState {
  createCalls: unknown[];
  createError: Error | null;
  makeSandbox: () => FakeSandbox;
  runCalls: Array<{ cmd: string; opts: Record<string, unknown> }>;
  handle: FakeHandle;
  stdoutChunks: string[];
  stderrChunks: string[];
  lastSandbox: FakeSandbox | null;
}

const e2bState: E2BState = {
  createCalls: [],
  createError: null,
  makeSandbox: () => {
    const sbx: FakeSandbox = {
      killed: false,
      commands: {
        run: async (cmd: string, opts: Record<string, unknown>) => {
          e2bState.runCalls.push({ cmd, opts });
          // Deliver any pre-configured chunks through the streaming callbacks.
          for (const chunk of e2bState.stdoutChunks) {
            await (opts.onStdout as ((d: string) => unknown) | undefined)?.(chunk);
          }
          for (const chunk of e2bState.stderrChunks) {
            await (opts.onStderr as ((d: string) => unknown) | undefined)?.(chunk);
          }
          return e2bState.handle;
        },
      },
      kill: async () => {
        sbx.killed = true;
        return true;
      },
    };
    e2bState.lastSandbox = sbx;
    return sbx;
  },
  runCalls: [],
  handle: { wait: async () => ({ exitCode: 0, stdout: '', stderr: '' }), kill: async () => true },
  stdoutChunks: [],
  stderrChunks: [],
  lastSandbox: null,
};

vi.mock('e2b', () => {
  class Sandbox {
    static async create(opts: unknown): Promise<FakeSandbox> {
      e2bState.createCalls.push(opts);
      if (e2bState.createError) throw e2bState.createError;
      return e2bState.makeSandbox();
    }
  }
  return { Sandbox };
});

// ---------------------------------------------------------------------------
// Fake child_process state
// ---------------------------------------------------------------------------
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killedSignal: string | null = null;
  kill(signal?: string): boolean {
    this.killedSignal = signal ?? 'SIGTERM';
    return true;
  }
}

interface DockerState {
  spawnSyncImpl: (...args: unknown[]) => { status: number; error?: Error };
  spawnImpl: (...args: unknown[]) => FakeChild;
  spawnCalls: Array<{ cmd: string; args: string[] }>;
}

const dockerState: DockerState = {
  spawnSyncImpl: () => ({ status: 0 }),
  spawnImpl: () => new FakeChild(),
  spawnCalls: [],
};

vi.mock('node:child_process', () => ({
  spawnSync: (...args: unknown[]) => dockerState.spawnSyncImpl(...args),
  spawn: (cmd: string, args: string[]) => {
    dockerState.spawnCalls.push({ cmd, args });
    return dockerState.spawnImpl(cmd, args);
  },
}));

// Import AFTER the mocks (vi.mock is hoisted, so this resolves to the fakes).
import { executeSandboxedCommand, sandboxBackend } from '../src/tools/sandbox.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const REAL_KEY = process.env.E2B_API_KEY;
const HANG = new Promise<{ exitCode: number; stdout: string; stderr: string }>(() => {});

// #117: the kernel sandbox is in the DEFAULT resolution chain now, so
// tests that assert container-only selection / legacy fail-closed must
// pin the sandbox env knobs explicitly (documented opt-outs) instead
// of relying on the kernel being absent.
const SANDBOX_ENV_KEYS = [
  'SANDBOX_BACKEND',
  'SANDBOX_KERNEL_FALLBACK',
  'SANDBOX_DISABLE_KERNEL',
  'SANDBOX_ALLOW_HOST',
  'SANDBOX_HOST_FALLBACK',
  'SANDBOX_STRICT',
] as const;
const REAL_SANDBOX_ENV = Object.fromEntries(SANDBOX_ENV_KEYS.map((k) => [k, process.env[k]]));

function clearSandboxEnv(): void {
  for (const k of SANDBOX_ENV_KEYS) delete process.env[k];
}

function setEnv(key: string | undefined): void {
  if (key === undefined) delete process.env.E2B_API_KEY;
  else process.env.E2B_API_KEY = key;
}

beforeEach(() => {
  setEnv(undefined);
  clearSandboxEnv();
  e2bState.createCalls = [];
  e2bState.createError = null;
  e2bState.runCalls = [];
  e2bState.stdoutChunks = [];
  e2bState.stderrChunks = [];
  e2bState.lastSandbox = null;
  e2bState.handle = { wait: async () => ({ exitCode: 0, stdout: '', stderr: '' }), kill: async () => true };
  dockerState.spawnCalls = [];
  dockerState.spawnSyncImpl = () => ({ status: 0 });
  dockerState.spawnImpl = () => new FakeChild();
});

afterEach(() => {
  if (REAL_KEY === undefined) delete process.env.E2B_API_KEY;
  else process.env.E2B_API_KEY = REAL_KEY;
  clearSandboxEnv();
  for (const k of SANDBOX_ENV_KEYS) {
    const v = REAL_SANDBOX_ENV[k];
    if (v !== undefined) process.env[k] = v;
  }
});

// ---------------------------------------------------------------------------
// Backend selection
// ---------------------------------------------------------------------------
describe('sandboxBackend()', () => {
  it('selects e2b when E2B_API_KEY is set', () => {
    setEnv('test-key');
    dockerState.spawnSyncImpl = () => {
      throw new Error('docker must not be probed');
    };
    expect(sandboxBackend()).toBe('e2b');
  });

  it('ignores a blank E2B_API_KEY', () => {
    setEnv('   ');
    expect(sandboxBackend()).toBe('docker');
  });

  it('selects docker when no key but the docker CLI works', () => {
    expect(sandboxBackend()).toBe('docker');
  });

  it('fails closed to none when there is no key and docker is missing', () => {
    // #117 adjustment: the kernel is in the default chain now, so this
    // legacy assertion pins the documented kernel opt-out
    // (SANDBOX_DISABLE_KERNEL=1) to isolate the container-only path.
    process.env.SANDBOX_DISABLE_KERNEL = '1';
    dockerState.spawnSyncImpl = () => {
      throw Object.assign(new Error('spawnSync docker ENOENT'), { code: 'ENOENT' });
    };
    expect(sandboxBackend()).toBe('none');
  });

  it('selects the kernel backend by default when no container is available (#117)', () => {
    // Docker probe fails; on this Linux VM the Landlock helper binary
    // exists once compiled (sandbox-kernel tests compile it), so the
    // default chain resolves container → kernel. Where the helper has
    // never been compiled the sync probe reports 'none' and the async
    // first-use path in executeSandboxedCommand compiles it instead.
    dockerState.spawnSyncImpl = () => ({ status: 1 });
    const backend = sandboxBackend();
    expect(['landlock', 'none']).toContain(backend);
  });

  it('selects host only on the explicit opt-out (#117)', () => {
    process.env.SANDBOX_DISABLE_KERNEL = '1';
    process.env.SANDBOX_ALLOW_HOST = '1';
    dockerState.spawnSyncImpl = () => ({ status: 1 });
    expect(sandboxBackend()).toBe('host');
  });
});

// ---------------------------------------------------------------------------
// E2B path
// ---------------------------------------------------------------------------
describe('E2B backend', () => {
  function enableE2B(): void {
    setEnv('test-key');
  }

  it('runs a command and returns stdout/stderr/exitCode', async () => {
    enableE2B();
    e2bState.stdoutChunks = ['hello\n'];
    e2bState.stderrChunks = ['warn\n'];
    const res = await executeSandboxedCommand('echo hello');
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe('hello\n');
    expect(res.stderr).toBe('warn\n');
    expect(e2bState.runCalls[0].cmd).toBe('echo hello');
    expect(e2bState.lastSandbox?.killed).toBe(true); // sandbox killed afterwards
  });

  it('creates the sandbox with no internet access by default', async () => {
    enableE2B();
    await executeSandboxedCommand('echo hi');
    expect(e2bState.createCalls[0]).toMatchObject({ allowInternetAccess: false });
  });

  it('passes network:true through as allowInternetAccess:true when opted in', async () => {
    enableE2B();
    await executeSandboxedCommand('echo hi', { network: true });
    expect(e2bState.createCalls[0]).toMatchObject({ allowInternetAccess: true });
  });

  it('forwards the requested timeout to the remote command', async () => {
    enableE2B();
    await executeSandboxedCommand('echo hi', { timeoutMs: 5_000 });
    expect(e2bState.runCalls[0].opts).toMatchObject({ timeoutMs: 5_000 });
  });

  it('converts a non-zero exit into a result (does not throw)', async () => {
    enableE2B();
    // Mirrors the SDK: output streams via onStdout/onStderr first, then wait()
    // throws a CommandExitError carrying the same exitCode/stdout/stderr.
    e2bState.stdoutChunks = ['partial\n'];
    e2bState.stderrChunks = ['boom\n'];
    e2bState.handle = {
      wait: async () => {
        throw Object.assign(new Error('Command exited with code 3'), {
          exitCode: 3,
          stdout: 'partial\n',
          stderr: 'boom\n',
        });
      },
      kill: async () => true,
    };
    const res = await executeSandboxedCommand('exit 3');
    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe('partial\n');
    expect(res.stderr).toBe('boom\n');
  });

  it('kills the remote process and reports timedOut on timeout', async () => {
    enableE2B();
    let killCalled = false;
    e2bState.handle = { wait: () => HANG, kill: async () => ((killCalled = true), true) };
    const res = await executeSandboxedCommand('sleep 999', { timeoutMs: 50 });
    expect(res.exitCode).toBe(124);
    expect(res.timedOut).toBe(true);
    expect(killCalled).toBe(true);
    expect(e2bState.lastSandbox?.killed).toBe(true); // still cleaned up
  });

  it('truncates oversized output with a notice', async () => {
    enableE2B();
    e2bState.stdoutChunks = ['x'.repeat(500)];
    const res = await executeSandboxedCommand('yes', { maxOutputBytes: 100 });
    expect(Buffer.byteLength(res.stdout, 'utf8')).toBeLessThanOrEqual(100 + 60);
    expect(res.stdout.endsWith('…[truncated to 100 bytes]')).toBe(true);
  });

  it('throws a clear error when sandbox creation fails', async () => {
    enableE2B();
    e2bState.createError = new Error('401 Unauthorized');
    await expect(executeSandboxedCommand('echo hi')).rejects.toThrow(/E2B sandbox creation failed/);
  });

  it('throws a clear error when command execution fails unexpectedly', async () => {
    enableE2B();
    e2bState.handle = {
      wait: async () => {
        throw new Error('connection reset');
      },
      kill: async () => true,
    };
    await expect(executeSandboxedCommand('echo hi')).rejects.toThrow(/E2B sandbox execution failed/);
  });
});

// ---------------------------------------------------------------------------
// Docker path
// ---------------------------------------------------------------------------
describe('docker backend', () => {
  function finishChild(child: FakeChild, stdout = 'ok\n', code: number | null = 0): void {
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from(stdout));
      child.emit('close', code, null);
    });
  }

  it('runs via `docker run --rm` with resource limits and no network by default', async () => {
    dockerState.spawnImpl = () => {
      const child = new FakeChild();
      finishChild(child);
      return child;
    };
    const res = await executeSandboxedCommand('echo hi');
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe('ok\n');
    const [{ cmd, args }] = dockerState.spawnCalls;
    expect(cmd).toBe('docker');
    expect(args.slice(0, 3)).toEqual(['run', '--rm', '--name']);
    expect(args[3]).toMatch(/^kriyadot-sandbox-/);
    expect(args).toContain('--network');
    expect(args).toContain('none');
    expect(args).toContain('--memory');
    expect(args).toContain('512m');
    expect(args).toContain('--cpus');
    expect(args).toContain('1.0');
    expect(args).toContain('--read-only');
    expect(args.slice(-3)).toEqual(['sh', '-c', 'echo hi']);
  });

  it('uses the bridge network when network:true is passed', async () => {
    dockerState.spawnImpl = () => {
      const child = new FakeChild();
      finishChild(child);
      return child;
    };
    await executeSandboxedCommand('echo hi', { network: true });
    const [{ args }] = dockerState.spawnCalls;
    const netIdx = args.indexOf('--network');
    expect(args[netIdx + 1]).toBe('bridge');
  });

  it('kills the container and reports timedOut on timeout', async () => {
    let childRef: FakeChild | null = null;
    dockerState.spawnImpl = (_cmd: unknown, args: unknown) => {
      // The M7 reapContainer() also spawns (`docker kill`); only the `run`
      // child is the one under test.
      if (Array.isArray(args) && args[0] === 'kill') return new FakeChild();
      childRef = new FakeChild(); // never emits close
      return childRef;
    };
    const res = await executeSandboxedCommand('sleep 999', { timeoutMs: 50 });
    expect(res.exitCode).toBe(124);
    expect(res.timedOut).toBe(true);
    expect(childRef!.killedSignal).toBe('SIGKILL');
  });

  it('names the container uniquely and docker-kills it on timeout (M7)', async () => {
    dockerState.spawnImpl = () => new FakeChild(); // never emits close → timeout
    const res = await executeSandboxedCommand('sleep 999', { timeoutMs: 50 });
    expect(res.timedOut).toBe(true);
    const runCall = dockerState.spawnCalls.find((c) => c.cmd === 'docker' && c.args[0] === 'run');
    expect(runCall).toBeDefined();
    const nameIdx = runCall!.args.indexOf('--name');
    expect(nameIdx).toBeGreaterThan(-1);
    const name = runCall!.args[nameIdx + 1];
    expect(name).toMatch(/^kriyadot-sandbox-[0-9a-f]{12}$/);
    const killCall = dockerState.spawnCalls.find(
      (c) => c.cmd === 'docker' && c.args[0] === 'kill',
    );
    expect(killCall).toBeDefined();
    expect(killCall!.args).toEqual(['kill', name]);
  });

  it('docker-kills the container on normal completion too (M7, best-effort)', async () => {
    dockerState.spawnImpl = () => {
      const child = new FakeChild();
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    };
    const res = await executeSandboxedCommand('echo hi');
    expect(res.exitCode).toBe(0);
    const killCalls = dockerState.spawnCalls.filter(
      (c) => c.cmd === 'docker' && c.args[0] === 'kill',
    );
    expect(killCalls).toHaveLength(1);
  });

  it('truncates oversized docker output with a notice', async () => {
    dockerState.spawnImpl = () => {
      const child = new FakeChild();
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('y'.repeat(500)));
        child.emit('close', 0, null);
      });
      return child;
    };
    const res = await executeSandboxedCommand('yes', { maxOutputBytes: 100 });
    expect(res.stdout.endsWith('…[truncated to 100 bytes]')).toBe(true);
  });

  it('fails closed when the docker CLI cannot start', async () => {
    dockerState.spawnImpl = () => {
      throw new Error('spawn docker ENOENT');
    };
    await expect(executeSandboxedCommand('echo hi')).rejects.toThrow(/Docker backend failed/);
  });

  it('reports a non-zero container exit code without throwing', async () => {
    dockerState.spawnImpl = () => {
      const child = new FakeChild();
      finishChild(child, '', 3);
      return child;
    };
    const res = await executeSandboxedCommand('exit 3');
    expect(res.exitCode).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Fail closed with neither backend
// ---------------------------------------------------------------------------
describe('fail-closed', () => {
  it('throws a descriptive error in strict mode when no backend is available', async () => {
    // #117 adjustment: the DEFAULT no-backend behaviour is now a host
    // fallback with a loud warning (existing deployments must not
    // break); failing closed is the STRICT mode contract, so this
    // test opts into it explicitly (kernel pinned off via the
    // documented opt-out so no backend can be found).
    process.env.SANDBOX_STRICT = '1';
    process.env.SANDBOX_DISABLE_KERNEL = '1';
    dockerState.spawnSyncImpl = () => ({ status: 1 }); // docker probe fails
    await expect(executeSandboxedCommand('echo hi')).rejects.toThrow(/No sandbox backend available/);
  });

  it('falls back to host WITH warning metadata when the kernel is unavailable (non-strict)', async () => {
    // Kernel pinned off + docker missing + no E2B: the availability
    // fallback runs on the host and stamps sandboxed:false + warning.
    // The mocked spawn never emits close for a plain sh child, so use
    // a child that finishes immediately.
    process.env.SANDBOX_DISABLE_KERNEL = '1';
    dockerState.spawnSyncImpl = () => ({ status: 1 });
    dockerState.spawnImpl = () => {
      const child = new FakeChild();
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('host-ok\n'));
        child.emit('close', 0, null);
      });
      return child;
    };
    const res = await executeSandboxedCommand('echo host-ok');
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe('host-ok\n');
    expect(res.sandboxed).toBe(false);
    expect(res.backend).toBe('host');
    expect(res.warning).toMatch(/UNSANDBOXED/);
  });
});
