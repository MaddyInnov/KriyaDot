// SPDX-License-Identifier: Apache-2.0
// Tests for BYO VPS support (OpenMausBot parity P1 #24): profile validation,
// TOFU fingerprint pinning, reconnect backoff, VpsSandbox command interface,
// VpsComputerLayer xdotool command construction, and the 'vps' surface.
// All SSH is faked — zero network, zero paid API usage.

import { describe, expect, it, vi } from 'vitest';
import {
  PerBotComputerManager,
  isComputerSurface,
  resolveSurfaceKind,
} from '../src/tools/computer-surfaces.js';
import type { OSScreenLayer } from '../src/tools/computer.js';
import {
  VpsAuthError,
  VpsComputerLayer,
  VpsConnection,
  VpsConnectionPool,
  VpsFingerprintMismatchError,
  VpsNotConfiguredError,
  VpsPasswordRequiredError,
  VpsProfileError,
  VpsSandbox,
  VpsTrustRequiredError,
  VpsTimeoutError,
  fingerprintSha256,
  pngDimensions,
  validateVpsProfile,
} from '../src/tools/vps.js';
import type {
  SshClientLike,
  SshConnectRequest,
  SshExecOptions,
  SshExecResult,
  VpsProfile,
} from '../src/tools/vps.js';

const FAKE_KEY = Buffer.from('fake-host-key-bytes');

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeSshClient implements SshClientLike {
  readonly commands: Array<{ command: string; stdin?: string }> = [];
  readonly files = new Map<string, Buffer>();
  private _alive = true;
  /** 'ok' | 'hang' (never resolves, to test timeouts). */
  mode: 'ok' | 'hang' = 'ok';
  execResult: SshExecResult = { stdout: '', stderr: '', exitCode: 0 };

  get alive(): boolean {
    return this._alive;
  }

  /** When false, `command -v` reports no tools (tests the missing-tool error). */
  toolsPresent = true;

  async exec(command: string, opts: SshExecOptions): Promise<SshExecResult> {
    this.commands.push({ command, stdin: opts.stdin });
    if (command.includes('command -v xdotool')) {
      return {
        stdout: this.toolsPresent ? '/usr/bin/xdotool\n/usr/bin/import\n' : '\n',
        stderr: '',
        exitCode: 0,
      };
    }
    if (this.mode === 'hang') {
      await new Promise((_, reject) =>
        setTimeout(
          () => reject(new VpsTimeoutError('fake exec', opts.timeoutMs)),
          opts.timeoutMs,
        ),
      );
      throw new Error('unreachable');
    }
    // Honor the output cap like the real adapter.
    const half = Math.floor(opts.maxOutputBytes / 2);
    let { stdout, stderr } = this.execResult;
    let truncated = false;
    if (Buffer.byteLength(stdout) > half) {
      stdout = stdout.slice(0, half);
      truncated = true;
    }
    if (Buffer.byteLength(stderr) > half) {
      stderr = stderr.slice(0, half);
      truncated = true;
    }
    return { ...this.execResult, stdout, stderr, truncated };
  }

  async readFile(path: string, maxBytes: number): Promise<Buffer> {
    const data = this.files.get(path);
    if (!data) throw new Error(`fake: no such file ${path}`);
    return data.subarray(0, maxBytes);
  }

  async writeFile(path: string, data: string | Buffer): Promise<void> {
    this.files.set(path, typeof data === 'string' ? Buffer.from(data) : data);
  }

  close(): void {
    this._alive = false;
  }

  kill(): void {
    this._alive = false;
  }
}

interface FakeFactoryOpts {
  /** Reject connect() with this error instead of succeeding. */
  connectError?: Error;
  /** Host key bytes presented by the fake server. */
  hostKey?: Buffer;
  /** Per-attempt connect errors (for backoff tests). */
  connectErrors?: Array<Error | null>;
}

function fakeClientFactory(
  client: FakeSshClient,
  seen: SshConnectRequest[],
  opts: FakeFactoryOpts = {},
) {
  let attempts = 0;
  return async (req: SshConnectRequest): Promise<SshClientLike> => {
    seen.push(req);
    const queued = opts.connectErrors?.[attempts] ?? opts.connectError ?? null;
    attempts += 1;
    if (queued) throw queued;
    // Simulate ssh2's hostVerifier: reject the handshake when it returns false.
    const ok = req.verifyHostKey(opts.hostKey ?? FAKE_KEY, 'ssh-rsa');
    if (!ok) throw new Error('Handshake failed: hostVerifier returned false');
    return client;
  };
}

function keyProfile(overrides: Partial<VpsProfile> = {}): VpsProfile {
  return {
    host: 'vps.example.com',
    port: 22,
    user: 'bot',
    authMethod: 'key',
    privateKeyRef: 'vps-key-test',
    fingerprint: fingerprintSha256(FAKE_KEY),
    ...overrides,
  };
}

function connDeps(
  profile: VpsProfile,
  client: FakeSshClient,
  seen: SshConnectRequest[],
  extra: Record<string, unknown> = {},
) {
  return {
    profile,
    resolvePrivateKey: (ref: string) => (ref === 'vps-key-test' ? 'PEM-DATA' : undefined),
    createSshClient: fakeClientFactory(client, seen),
    sleep: async () => undefined,
    ...extra,
  };
}

/** Minimal valid PNG with the given dimensions (signature + IHDR only). */
function tinyPng(w: number, h: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4);
  ihdr.writeUInt32BE(w, 8);
  ihdr.writeUInt32BE(h, 12);
  return Buffer.concat([sig, ihdr]);
}

// ---------------------------------------------------------------------------
// Profile validation
// ---------------------------------------------------------------------------

describe('validateVpsProfile', () => {
  it('accepts a minimal key-auth profile with defaults', () => {
    const p = validateVpsProfile({ host: 'vps.example.com', user: 'bot', privateKeyRef: 'k1' });
    expect(p.host).toBe('vps.example.com');
    expect(p.port).toBe(22);
    expect(p.authMethod).toBe('key');
    expect(p.fingerprint).toBeUndefined();
  });

  it('rejects bad hosts', () => {
    for (const host of ['', 'https://vps.example.com', 'vps example.com', 'http://1.2.3.4/x']) {
      expect(() => validateVpsProfile({ host, user: 'u', privateKeyRef: 'k' })).toThrow(
        VpsProfileError,
      );
    }
    expect(validateVpsProfile({ host: '1.2.3.4', user: 'u', privateKeyRef: 'k' }).host).toBe(
      '1.2.3.4',
    );
  });

  it('rejects bad ports and users', () => {
    expect(() =>
      validateVpsProfile({ host: 'h', user: 'u', port: 0, privateKeyRef: 'k' }),
    ).toThrow(/port/);
    expect(() =>
      validateVpsProfile({ host: 'h', user: 'u', port: 70000, privateKeyRef: 'k' }),
    ).toThrow(/port/);
    expect(() => validateVpsProfile({ host: 'h', user: '', privateKeyRef: 'k' })).toThrow(/user/);
    expect(() => validateVpsProfile({ host: 'h', user: 'a@b', privateKeyRef: 'k' })).toThrow(/user/);
  });

  it('requires privateKeyRef for key auth', () => {
    expect(() => validateVpsProfile({ host: 'h', user: 'u' })).toThrow(/privateKeyRef/);
    expect(() =>
      validateVpsProfile({ host: 'h', user: 'u', authMethod: 'password-prompt' }),
    ).not.toThrow();
    expect(() =>
      validateVpsProfile({ host: 'h', user: 'u', authMethod: 'agent' }),
    ).not.toThrow();
  });

  it('refuses secret material in the profile', () => {
    for (const banned of ['password', 'privateKey', 'passphrase']) {
      expect(() =>
        validateVpsProfile({ host: 'h', user: 'u', privateKeyRef: 'k', [banned]: 'x' }),
      ).toThrow(/never be stored/);
    }
  });

  it('validates fingerprint and display formats', () => {
    expect(() =>
      validateVpsProfile({ host: 'h', user: 'u', privateKeyRef: 'k', fingerprint: 'nope' }),
    ).toThrow(/fingerprint/);
    expect(() =>
      validateVpsProfile({
        host: 'h',
        user: 'u',
        privateKeyRef: 'k',
        fingerprint: 'SHA256:abc123+/=',
        display: ':0',
      }),
    ).not.toThrow();
    expect(() =>
      validateVpsProfile({ host: 'h', user: 'u', privateKeyRef: 'k', display: 'x11' }),
    ).toThrow(/display/);
  });

  it('fingerprintSha256 is stable and OpenSSH-shaped', () => {
    const a = fingerprintSha256(FAKE_KEY);
    expect(a).toBe(fingerprintSha256(Buffer.from('fake-host-key-bytes')));
    expect(a.startsWith('SHA256:')).toBe(true);
    expect(fingerprintSha256(Buffer.from('other'))).not.toBe(a);
  });
});

// ---------------------------------------------------------------------------
// TOFU
// ---------------------------------------------------------------------------

describe('VpsConnection TOFU', () => {
  it('throws VpsTrustRequiredError on first connect without a pin', async () => {
    const client = new FakeSshClient();
    const seen: SshConnectRequest[] = [];
    const conn = new VpsConnection(connDeps(keyProfile({ fingerprint: undefined }), client, seen));
    await expect(conn.connect()).rejects.toBeInstanceOf(VpsTrustRequiredError);
    const err = await conn.connect().catch((e) => e);
    expect(err.fingerprint).toBe(fingerprintSha256(FAKE_KEY));
    expect(conn.statusInfo().status).toBe('error');
  });

  it('trust flow connects and reports the new fingerprint', async () => {
    const client = new FakeSshClient();
    const seen: SshConnectRequest[] = [];
    const trusted: string[] = [];
    const conn = new VpsConnection(
      connDeps(keyProfile({ fingerprint: undefined }), client, seen, {
        onFingerprintTrusted: (fp: string) => trusted.push(fp),
      }),
    );
    const res = await conn.connect({ trustFingerprint: true });
    expect(res.newlyTrusted).toBe(true);
    expect(res.fingerprint).toBe(fingerprintSha256(FAKE_KEY));
    expect(trusted).toEqual([res.fingerprint]);
    expect(conn.isConnected()).toBe(true);
    // The private key went to the handshake but is not retained.
    expect(seen[0].privateKey).toBe('PEM-DATA');
  });

  it('connects with a matching pinned fingerprint', async () => {
    const client = new FakeSshClient();
    const seen: SshConnectRequest[] = [];
    const conn = new VpsConnection(connDeps(keyProfile(), client, seen));
    const res = await conn.connect();
    expect(res.newlyTrusted).toBe(false);
    expect(conn.isConnected()).toBe(true);
  });

  it('mismatched fingerprint is a hard stop (MITM)', async () => {
    const client = new FakeSshClient();
    const seen: SshConnectRequest[] = [];
    const mismatches: Array<[string, string]> = [];
    const conn = new VpsConnection(
      connDeps(keyProfile({ fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }), client, seen, {
        onFingerprintMismatch: (e: string, o: string) => mismatches.push([e, o]),
      }),
    );
    await expect(conn.connect()).rejects.toBeInstanceOf(VpsFingerprintMismatchError);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0][1]).toBe(fingerprintSha256(FAKE_KEY));
    // ensureConnected must NOT retry into a mismatch.
    await expect(conn.ensureConnected()).rejects.toThrow(/blocked/);
  });

  it('missing vault key fails closed with VpsAuthError', async () => {
    const client = new FakeSshClient();
    const seen: SshConnectRequest[] = [];
    const conn = new VpsConnection({
      profile: keyProfile({ privateKeyRef: 'missing-key' }),
      resolvePrivateKey: () => undefined,
      createSshClient: fakeClientFactory(client, seen),
      sleep: async () => undefined,
    });
    await expect(conn.connect()).rejects.toBeInstanceOf(VpsAuthError);
  });

  it('password-prompt without a password throws VpsPasswordRequiredError', async () => {
    const client = new FakeSshClient();
    const seen: SshConnectRequest[] = [];
    const conn = new VpsConnection(
      connDeps(
        keyProfile({
          authMethod: 'password-prompt',
          privateKeyRef: undefined,
          fingerprint: undefined,
        }),
        client,
        seen,
      ),
    );
    await expect(conn.connect()).rejects.toBeInstanceOf(VpsPasswordRequiredError);
    const res = await conn.connect({ password: 's3cret', trustFingerprint: true });
    expect(res.newlyTrusted).toBe(true);
    expect(seen[seen.length - 1].password).toBe('s3cret');
  });
});

// ---------------------------------------------------------------------------
// Reconnect backoff
// ---------------------------------------------------------------------------

describe('VpsConnection reconnect', () => {
  it('backs off exponentially then succeeds', async () => {
    const client = new FakeSshClient();
    const seen: SshConnectRequest[] = [];
    const delays: number[] = [];
    const t1 = new Error('transport reset');
    const t2 = new Error('transport reset');
    const conn = new VpsConnection(
      connDeps(keyProfile(), client, seen, {
        createSshClient: fakeClientFactory(client, seen, { connectErrors: [t1, t2, null] }),
        sleep: async (ms: number) => {
          delays.push(ms);
        },
      }),
    );
    await conn.ensureConnected();
    expect(conn.isConnected()).toBe(true);
    expect(delays).toEqual([1000, 2000]);
    expect(seen).toHaveLength(3);
  });

  it('gives up after maxReconnectAttempts', async () => {
    const client = new FakeSshClient();
    const seen: SshConnectRequest[] = [];
    const conn = new VpsConnection(
      connDeps(keyProfile(), client, seen, {
        createSshClient: fakeClientFactory(client, seen, {
          connectErrors: [new Error('down'), new Error('down'), new Error('down')],
        }),
        maxReconnectAttempts: 3,
      }),
    );
    await expect(conn.ensureConnected()).rejects.toThrow('down');
    expect(seen).toHaveLength(3);
  });

  it('never backoffs into auth failures', async () => {
    const client = new FakeSshClient();
    const seen: SshConnectRequest[] = [];
    const conn = new VpsConnection(
      connDeps(keyProfile(), client, seen, {
        createSshClient: fakeClientFactory(client, seen, {
          connectErrors: [new VpsAuthError('bad key')],
        }),
        sleep: async () => {
          throw new Error('sleep should not be called');
        },
      }),
    );
    await expect(conn.ensureConnected()).rejects.toBeInstanceOf(VpsAuthError);
    expect(seen).toHaveLength(1);
  });

  it('password-auth drops require explicit reconnect (no cached password)', async () => {
    const client = new FakeSshClient();
    const seen: SshConnectRequest[] = [];
    const conn = new VpsConnection(
      connDeps(
        keyProfile({ authMethod: 'password-prompt', privateKeyRef: undefined }),
        client,
        seen,
      ),
    );
    await conn.connect({ password: 'pw', trustFingerprint: true });
    expect(conn.isConnected()).toBe(true);
    // Simulate a drop: kill the transport.
    client.kill();
    await expect(conn.ensureConnected()).rejects.toBeInstanceOf(VpsPasswordRequiredError);
  });
});

// ---------------------------------------------------------------------------
// VpsSandbox
// ---------------------------------------------------------------------------

describe('VpsSandbox', () => {
  async function connectedSandbox(client?: FakeSshClient) {
    const c = client ?? new FakeSshClient();
    const seen: SshConnectRequest[] = [];
    const conn = new VpsConnection(connDeps(keyProfile(), c, seen));
    await conn.connect();
    return new VpsSandbox(conn);
  }

  it('runs commands and returns the sandbox result shape', async () => {
    const client = new FakeSshClient();
    client.execResult = { stdout: 'hello\n', stderr: '', exitCode: 0 };
    const sb = await connectedSandbox(client);
    const r = await sb.runCommand('echo hello', { timeoutMs: 5000 });
    expect(r.stdout).toBe('hello\n');
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBeUndefined();
    expect(client.commands[0].command).toBe('echo hello');
  });

  it('reports timeouts with exit code 124 like the local sandbox', async () => {
    const client = new FakeSshClient();
    client.mode = 'hang';
    const sb = await connectedSandbox(client);
    const r = await sb.runCommand('sleep 999', { timeoutMs: 40 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(124);
  });

  it('caps output', async () => {
    const client = new FakeSshClient();
    client.execResult = { stdout: 'x'.repeat(10000), stderr: '', exitCode: 0 };
    const sb = await connectedSandbox(client);
    const r = await sb.runCommand('yes', { maxOutputBytes: 100 });
    expect(r.stdout.length).toBeLessThanOrEqual(50 + 100);
  });

  it('reads and writes files over SFTP', async () => {
    const sb = await connectedSandbox();
    await sb.writeFile('/tmp/note.txt', 'hello vps');
    expect(await sb.readFile('/tmp/note.txt')).toBe('hello vps');
  });

  it('osInfo parses uname output', async () => {
    const client = new FakeSshClient();
    client.execResult = { stdout: 'Linux 6.8.0 x86_64\n', stderr: '', exitCode: 0 };
    const sb = await connectedSandbox(client);
    expect(await sb.osInfo()).toEqual({ os: 'Linux', kernel: '6.8.0', arch: 'x86_64' });
  });
});

// ---------------------------------------------------------------------------
// VpsComputerLayer
// ---------------------------------------------------------------------------

describe('VpsComputerLayer', () => {
  async function layerWith(client?: FakeSshClient) {
    const c = client ?? new FakeSshClient();
    const seen: SshConnectRequest[] = [];
    const conn = new VpsConnection(connDeps(keyProfile(), c, seen));
    await conn.connect();
    const actions: Array<[string, unknown]> = [];
    const layer = new VpsComputerLayer(conn, {
      onRealAction: (a, d) => actions.push([a, d]),
    });
    return { layer, client: c, actions };
  }

  /** Recorded xdotool action commands (excluding the `command -v` probe). */
  function toolCmds(client: FakeSshClient): Array<{ command: string; stdin?: string }> {
    return client.commands.filter(
      (c) => c.command.includes('xdotool') && !c.command.includes('command -v'),
    );
  }

  it('click builds the xdotool command with DISPLAY prefix', async () => {
    const { layer, client } = await layerWith();
    client.commands.length = 0;
    client.execResult = { stdout: '', stderr: '', exitCode: 0 };
    await layer.click(100, 200, { button: 'left', clicks: 2 });
    expect(toolCmds(client)[0].command).toBe(
      'DISPLAY=:0 xdotool mousemove --sync 100 200 click --clearmodifiers --repeat 2 1',
    );
  });

  it('maps right/middle buttons', async () => {
    const { layer, client } = await layerWith();
    client.commands.length = 0;
    client.execResult = { stdout: '', stderr: '', exitCode: 0 };
    await layer.click(1, 2, { button: 'right' });
    expect(toolCmds(client)[0].command).toContain(' 3');
    await layer.click(1, 2, { button: 'middle' });
    expect(toolCmds(client)[1].command).toContain(' 2');
  });

  it('types via stdin (no shell quoting issues)', async () => {
    const { layer, client } = await layerWith();
    client.commands.length = 0;
    client.execResult = { stdout: '', stderr: '', exitCode: 0 };
    await layer.type('hello; rm -rf /');
    const cmd = toolCmds(client)[0];
    expect(cmd.command).toBe('DISPLAY=:0 xdotool type --clearmodifiers --delay 0 --file -');
    expect(cmd.stdin).toBe('hello; rm -rf /');
  });

  it('maps key names to xdotool keysyms', async () => {
    const { layer, client } = await layerWith();
    client.commands.length = 0;
    client.execResult = { stdout: '', stderr: '', exitCode: 0 };
    await layer.key('Enter');
    expect(toolCmds(client)[0].command).toBe('DISPLAY=:0 xdotool key --clearmodifiers Return');
    await layer.keyChord(['ctrl', 'shift'], 's');
    expect(toolCmds(client)[1].command).toBe('DISPLAY=:0 xdotool key --clearmodifiers ctrl+shift+s');
    await layer.keyChord(['meta'], 'Tab');
    expect(toolCmds(client)[2].command).toBe('DISPLAY=:0 xdotool key --clearmodifiers Super_L+Tab');
  });

  it('scrolls down with button 5 and up with button 4', async () => {
    const { layer, client } = await layerWith();
    client.commands.length = 0;
    client.execResult = { stdout: '', stderr: '', exitCode: 0 };
    await layer.scroll(50, 60, 0, 240);
    expect(toolCmds(client)[0].command).toContain('click --clearmodifiers --repeat 2 5');
    await layer.scroll(50, 60, 0, -120);
    expect(toolCmds(client)[1].command).toContain('click --clearmodifiers --repeat 1 4');
  });

  it('drags with mousedown/mousemove/mouseup', async () => {
    const { layer, client } = await layerWith();
    client.commands.length = 0;
    client.execResult = { stdout: '', stderr: '', exitCode: 0 };
    await layer.drag(10, 10, 90, 90, { button: 'left', steps: 10 });
    expect(toolCmds(client)[0].command).toBe(
      'DISPLAY=:0 xdotool mousemove --sync 10 10 mousedown 1 mousemove --sync 90 90 mouseup 1',
    );
  });

  it('parses display geometry', async () => {
    const { layer, client } = await layerWith();
    client.commands.length = 0;
    client.execResult = { stdout: '1920 1080\n', stderr: '', exitCode: 0 };
    expect(await layer.displaySize()).toEqual({ width: 1920, height: 1080 });
  });

  it('screenshot pulls a PNG over SFTP and parses dimensions', async () => {
    const { layer, client } = await layerWith();
    const png = tinyPng(800, 600);
    client.files.set('/tmp/kriyadot-shot-1.png', png);
    // screenshotViaTempFile generates its own tmp name; intercept by making
    // readFile serve the png for any /tmp/kriyadot-shot-* path.
    const origRead = client.readFile.bind(client);
    client.readFile = async (path: string, max: number) => {
      if (path.startsWith('/tmp/kriyadot-shot-')) return png.subarray(0, max);
      return origRead(path, max);
    };
    client.execResult = { stdout: '12345\n', stderr: '', exitCode: 0 };
    const shot = await layer.screenshot();
    expect(shot.width).toBe(800);
    expect(shot.height).toBe(600);
    expect(shot.png[0]).toBe(0x89);
  });

  it('fails clearly when xdotool is missing', async () => {
    const client = new FakeSshClient();
    client.toolsPresent = false;
    const seen: SshConnectRequest[] = [];
    const conn = new VpsConnection(connDeps(keyProfile(), client, seen));
    await conn.connect();
    const layer = new VpsComputerLayer(conn);
    await expect(layer.click(1, 1)).rejects.toThrow(/xdotool/);
  });

  it('validates coordinates and display', async () => {
    const { layer } = await layerWith();
    await expect(layer.click(-1, 0)).rejects.toThrow(/integer 0-32767/);
    const seen: SshConnectRequest[] = [];
    const conn = new VpsConnection(connDeps(keyProfile(), new FakeSshClient(), seen));
    expect(() => new VpsComputerLayer(conn, { display: 'evil; rm' })).toThrow(/invalid X display/);
  });

  it('audits real input actions', async () => {
    const { layer, client, actions } = await layerWith();
    client.commands.length = 0;
    client.execResult = { stdout: '', stderr: '', exitCode: 0 };
    await layer.click(5, 5);
    expect(actions[0][0]).toBe('vps:click');
  });

  it('pngDimensions parses IHDR', () => {
    expect(pngDimensions(tinyPng(320, 200))).toEqual({ w: 320, h: 200 });
    expect(pngDimensions(Buffer.from('not a png'))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Pool + surface selection
// ---------------------------------------------------------------------------

describe('VpsConnectionPool', () => {
  it('reuses connections for the same profile and replaces on change', async () => {
    const pool = new VpsConnectionPool({
      resolvePrivateKey: () => 'PEM',
      createSshClient: fakeClientFactory(new FakeSshClient(), []),
      sleep: async () => undefined,
    });
    const a = pool.getOrCreate('bot:x', keyProfile());
    const b = pool.getOrCreate('bot:x', keyProfile());
    expect(a).toBe(b);
    const c = pool.getOrCreate('bot:x', keyProfile({ host: 'other.example.com' }));
    expect(c).not.toBe(a);
    await pool.drop('bot:x');
    expect(pool.get('bot:x')).toBeUndefined();
    await pool.closeAll();
  });

  it('VpsNotConfiguredError names the bot', () => {
    expect(() => {
      throw new VpsNotConfiguredError('coder');
    }).toThrow(/coder/);
  });
});

describe('vps computer surface', () => {
  it('is a known surface resolving to itself', () => {
    expect(isComputerSurface('vps')).toBe(true);
    expect(resolveSurfaceKind('vps')).toBe('vps');
    expect(isComputerSurface('mainframe')).toBe(false);
  });

  it('manager routes the vps surface through vpsLayerFor', async () => {
    const fakeLayer = {
      displaySize: async () => ({ width: 1, height: 1 }),
      screenshot: async () => ({ png: new Uint8Array(), width: 1, height: 1 }),
      click: async () => undefined,
      type: async () => undefined,
      key: async () => undefined,
      keyChord: async () => undefined,
      scroll: async () => undefined,
      drag: async () => undefined,
      move: async () => undefined,
    } as unknown as OSScreenLayer;
    const seenBots: string[] = [];
    const mgr = new PerBotComputerManager({
      vpsLayerFor: (botId: string) => {
        seenBots.push(botId);
        return fakeLayer;
      },
    });
    const size = await mgr.getLayer('coder', { surface: 'vps' }).displaySize();
    expect(size).toEqual({ width: 1, height: 1 });
    expect(seenBots).toEqual(['coder']);
    const status = mgr.status('coder');
    expect(status[0].resolved).toBe('vps');
  });

  it('vps surface without a resolver fails with a clear error', async () => {
    const mgr = new PerBotComputerManager();
    await expect(mgr.getLayer('coder', { surface: 'vps' }).displaySize()).rejects.toThrow(
      /VPS profile/,
    );
  });
});
