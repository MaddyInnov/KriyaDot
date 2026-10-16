// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  CURATED_MODELS,
  LocalLlmManager,
  detectGpu,
  llamacppBaseUrl,
  llamacppPort,
  llamacppRelease,
  selectBinaryAsset,
  sha256File,
  type ExecFn,
} from '../src/local-llm.js';

const realEnv = { ...process.env };
afterEach(() => {
  process.env = { ...realEnv };
  vi.restoreAllMocks();
});

describe('llamacppRelease', () => {
  it('pins b11683 by default', () => {
    delete process.env.KRIYADOT_LLAMACPP_RELEASE;
    expect(llamacppRelease()).toBe('b11683');
  });
  it('honors the env override', () => {
    process.env.KRIYADOT_LLAMACPP_RELEASE = 'b99999';
    expect(llamacppRelease()).toBe('b99999');
  });
});

describe('llamacppPort', () => {
  it('defaults to 11435', () => {
    delete process.env.KRIYADOT_LLAMACPP_PORT;
    expect(llamacppPort()).toBe(11435);
    expect(llamacppBaseUrl()).toBe('http://127.0.0.1:11435');
  });
  it('honors a valid env port', () => {
    process.env.KRIYADOT_LLAMACPP_PORT = '18080';
    expect(llamacppPort()).toBe(18080);
  });
  it('rejects garbage ports', () => {
    process.env.KRIYADOT_LLAMACPP_PORT = 'banana';
    expect(llamacppPort()).toBe(11435);
    process.env.KRIYADOT_LLAMACPP_PORT = '99999';
    expect(llamacppPort()).toBe(11435);
  });
});

describe('detectGpu', () => {
  const ok = (stdout: string): ExecFn => async () => ({ stdout, stderr: '' });
  const fail: ExecFn = async () => {
    throw new Error('not found');
  };

  it('detects CUDA via nvidia-smi', async () => {
    const gpu = await detectGpu({ platform: 'linux', run: ok('NVIDIA GeForce RTX 4060\n') });
    expect(gpu).toEqual({ kind: 'cuda', detail: 'NVIDIA GeForce RTX 4060' });
  });

  it('detects Metal on macOS when no NVIDIA driver', async () => {
    const gpu = await detectGpu({ platform: 'darwin', run: fail });
    expect(gpu).toEqual({ kind: 'metal', detail: 'Apple Metal' });
  });

  it('detects Vulkan when vulkaninfo runs', async () => {
    const run: ExecFn = async (cmd) => {
      if (cmd === 'nvidia-smi') throw new Error('not found');
      return { stdout: 'devices: ...', stderr: '' };
    };
    const gpu = await detectGpu({ platform: 'linux', run });
    expect(gpu).toEqual({ kind: 'vulkan', detail: 'Vulkan-capable GPU' });
  });

  it('falls back to CPU when nothing is found', async () => {
    const gpu = await detectGpu({ platform: 'linux', run: fail });
    expect(gpu).toEqual({ kind: 'cpu', detail: 'CPU only' });
  });

  it('prefers CUDA over Vulkan', async () => {
    const run: ExecFn = async (cmd) => {
      if (cmd === 'nvidia-smi') return { stdout: 'NVIDIA A100\n', stderr: '' };
      return { stdout: 'vulkan ok', stderr: '' };
    };
    const gpu = await detectGpu({ platform: 'linux', run });
    expect(gpu.kind).toBe('cuda');
  });
});

describe('selectBinaryAsset', () => {
  it('picks the real pinned assets per platform', () => {
    expect(selectBinaryAsset({ platform: 'linux', arch: 'x64', gpu: 'cpu' }).file).toBe(
      'llama-b11683-bin-ubuntu-x64.tar.gz',
    );
    expect(selectBinaryAsset({ platform: 'linux', arch: 'x64', gpu: 'cuda' }).file).toBe(
      'llama-b11683-bin-ubuntu-cuda-12.8-x64.tar.gz',
    );
    expect(selectBinaryAsset({ platform: 'linux', arch: 'x64', gpu: 'vulkan' }).file).toBe(
      'llama-b11683-bin-ubuntu-vulkan-x64.tar.gz',
    );
    expect(selectBinaryAsset({ platform: 'darwin', arch: 'arm64', gpu: 'metal' }).file).toBe(
      'llama-b11683-bin-macos-arm64.tar.gz',
    );
    expect(selectBinaryAsset({ platform: 'win32', arch: 'x64', gpu: 'cuda' }).file).toBe(
      'llama-b11683-bin-win-cuda-12.4-x64.zip',
    );
    expect(selectBinaryAsset({ platform: 'win32', arch: 'x64', gpu: 'cpu' }).file).toBe(
      'llama-b11683-bin-win-cpu-x64.zip',
    );
  });

  it('points at the official ggml-org release', () => {
    const a = selectBinaryAsset({ platform: 'linux', arch: 'x64', gpu: 'cpu' });
    expect(a.url).toBe(
      'https://github.com/ggml-org/llama.cpp/releases/download/b11683/llama-b11683-bin-ubuntu-x64.tar.gz',
    );
  });

  it('carries pre-verified sha256 pins for the hashed variants', () => {
    const ubuntu = selectBinaryAsset({ platform: 'linux', arch: 'x64', gpu: 'cpu' });
    expect(ubuntu.sha256).toBe(
      '261410c6fa6b4b375e8b904f2169ca4ef5ea620f6b1cee6b2c66cdc1521ac9a6',
    );
    const mac = selectBinaryAsset({ platform: 'darwin', arch: 'arm64', gpu: 'metal' });
    expect(mac.sha256).toBe(
      '0c0154f043a7fe8fc0d5c100b5067ef9ca42d07d9993ee62fdce451662aa9b35',
    );
  });

  it('uses TOFU (no pin) for variants not hashed at build time', () => {
    const cuda = selectBinaryAsset({ platform: 'linux', arch: 'x64', gpu: 'cuda' });
    expect(cuda.sha256).toBeUndefined();
  });

  it('throws for unsupported platforms', () => {
    expect(() => selectBinaryAsset({ platform: 'freebsd', arch: 'x64', gpu: 'cpu' })).toThrow(
      /no prebuilt llama.cpp binary/i,
    );
  });

  it('honors a release override (pins no longer apply)', () => {
    const a = selectBinaryAsset({ platform: 'linux', arch: 'x64', gpu: 'cpu' }, 'b99999');
    expect(a.file).toBe('llama-b99999-bin-ubuntu-x64.tar.gz');
    expect(a.sha256).toBeUndefined();
  });
});

describe('CURATED_MODELS', () => {
  it('has unique ids and pinned https URLs on huggingface.co', () => {
    const ids = CURATED_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of CURATED_MODELS) {
      expect(m.url.startsWith('https://huggingface.co/')).toBe(true);
      expect(m.sizeBytes).toBeGreaterThan(100 * 1024 * 1024);
      expect(m.url.endsWith('.gguf')).toBe(true);
    }
  });

  it('includes a sub-1GB default-friendly model', () => {
    const small = CURATED_MODELS.filter((m) => m.sizeBytes < 1024 * 1024 * 1024);
    expect(small.length).toBeGreaterThan(0);
  });
});

describe('sha256File', () => {
  it('hashes a fixture correctly', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-test-'));
    try {
      const f = path.join(dir, 'x.bin');
      fs.writeFileSync(f, 'hello-local-llm');
      const expected = createHash('sha256').update('hello-local-llm').digest('hex');
      expect(await sha256File(f)).toBe(expected);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Manager lifecycle (fully mocked OS surface)
// ---------------------------------------------------------------------------

class FakeChild extends EventEmitter {
  pid = 4242;
  exitCode: number | null = null;
  killedWith: string | null = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill(sig?: string): boolean {
    this.killedWith = sig ?? 'SIGTERM';
    this.exitCode = 0;
    queueMicrotask(() => this.emit('exit', 0, null));
    return true;
  }
}

function makeManager() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localllm-test-'));
  const spawned: { cmd: string; args: string[]; child: FakeChild }[] = [];
  const downloaded: { url: string; dest: string }[] = [];

  const exec: ExecFn = async (cmd, args) => {
    if (cmd === 'nvidia-smi') throw new Error('not found');
    if (cmd === 'vulkaninfo') throw new Error('not found');
    if (cmd === 'tar' && args[0] === '-xzf') {
      // Fake extraction: plant a llama-server binary.
      const dest = args[args.indexOf('-C') + 1];
      const nested = path.join(dest, 'llama-b11683');
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(path.join(nested, 'llama-server'), '#!/bin/sh\necho fake\n');
      return { stdout: '', stderr: '' };
    }
    if (cmd === 'tar' && args[0] === 'tzf') return { stdout: 'llama-server\n', stderr: '' };
    throw new Error(`unexpected exec ${cmd} ${args.join(' ')}`);
  };

  const spawn = ((cmd: string, args: string[]) => {
    const child = new FakeChild();
    spawned.push({ cmd, args, child });
    return child as unknown as ReturnType<typeof import('node:child_process').spawn>;
  }) as import('../src/local-llm.js').LocalLlmDeps['spawn'];

  const download = async (url: string, dest: string) => {
    downloaded.push({ url, dest });
    fs.writeFileSync(dest, 'fake-payload-bytes');
  };

  const manager = new LocalLlmManager(dataDir, {
    exec,
    spawn,
    download,
    platform: 'linux',
    arch: 'x64',
  });
  return { manager, dataDir, spawned, downloaded, spawn, download, exec };
}

describe('LocalLlmManager', () => {
  let ctx: ReturnType<typeof makeManager>;
  beforeEach(() => {
    ctx = makeManager();
  });
  afterEach(() => {
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });

  it('refuses a checksum mismatch on a pinned variant', async () => {
    // linux/x64/cpu is sha256-pinned; our fake payload will not match.
    await expect(ctx.manager.downloadBinary()).rejects.toThrow(/checksum mismatch/i);
    expect(await ctx.manager.isBinaryInstalled()).toBe(false);
  });

  it('installs an unpinned variant via TOFU and records the manifest', async () => {
    // Force the cuda asset (no pin) by making nvidia-smi succeed.
    const m2 = new LocalLlmManager(ctx.dataDir, {
      platform: 'linux',
      arch: 'x64',
      spawn: ctx.spawn,
      download: async (url: string, dest: string) => {
        fs.writeFileSync(dest, 'fake-payload-bytes');
      },
      exec: async (cmd, args) => {
        if (cmd === 'nvidia-smi') return { stdout: 'NVIDIA Fake 9000\n', stderr: '' };
        if (cmd === 'tar' && args[0] === 'tzf') return { stdout: 'llama-server\n', stderr: '' };
        if (cmd === 'tar' && args[0] === '-xzf') {
          const dest = args[args.indexOf('-C') + 1];
          const nested = path.join(dest, 'llama-b11683');
          fs.mkdirSync(nested, { recursive: true });
          fs.writeFileSync(path.join(nested, 'llama-server'), 'fake');
          return { stdout: '', stderr: '' };
        }
        throw new Error('unexpected ' + cmd);
      },
    });
    const asset = await m2.downloadBinary();
    expect(asset.file).toBe('llama-b11683-bin-ubuntu-cuda-12.8-x64.tar.gz');
    expect(asset.url).toContain('https://github.com/ggml-org/llama.cpp/releases/download/b11683/');
    expect(await m2.isBinaryInstalled()).toBe(true);
    const manifest = await m2.readManifest();
    expect(manifest?.asset).toBe(asset.file);
    expect(manifest?.sha256).toHaveLength(64);
  });

  it('rejects unknown model ids (curated list only)', async () => {
    await expect(ctx.manager.downloadModel('https://evil.example/x.gguf')).rejects.toThrow(
      /only curated models/i,
    );
    await expect(ctx.manager.downloadModel('nope')).rejects.toThrow(/only curated models/i);
  });

  it('verifies exact model size after download', async () => {
    const id = CURATED_MODELS[0].id;
    // Fake payload is 18 bytes; pinned size is ~491MB → mismatch → removed.
    await expect(ctx.manager.downloadModel(id)).rejects.toThrow(/size mismatch/i);
    const models = await ctx.manager.listModels();
    expect(models.find((m) => m.id === id)?.downloaded).toBe(false);
  });

  it('start() fails fast when nothing is installed', async () => {
    await expect(ctx.manager.start()).rejects.toThrow(/not installed/i);
  });

  it('full lifecycle: install → model → start → status → stop', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('ok', { status: 200 })) as typeof fetch;
    try {
      // Install binary (unpinned cuda variant via TOFU path).
      const m = new LocalLlmManager(ctx.dataDir, {
        platform: 'linux',
        arch: 'x64',
        spawn: ctx.spawn,
        download: async (_url: string, dest: string) => {
          fs.writeFileSync(dest, 'fake-payload-bytes');
        },
        exec: async (cmd, args) => {
          if (cmd === 'nvidia-smi') return { stdout: 'NVIDIA Fake 9000\n', stderr: '' };
          if (cmd === 'tar' && args[0] === 'tzf') return { stdout: 'llama-server\n', stderr: '' };
          if (cmd === 'tar' && args[0] === '-xzf') {
            const dest = args[args.indexOf('-C') + 1];
            const nested = path.join(dest, 'llama-b11683');
            fs.mkdirSync(nested, { recursive: true });
            fs.writeFileSync(path.join(nested, 'llama-server'), 'fake');
            return { stdout: '', stderr: '' };
          }
          throw new Error('unexpected ' + cmd);
        },
      });
      await m.downloadBinary();
      // Plant a sparse model file of exactly the pinned size (no disk cost).
      const id = CURATED_MODELS[0].id;
      const modelsDir = path.join(ctx.dataDir, 'local-llm', 'models');
      fs.mkdirSync(modelsDir, { recursive: true });
      const fd = fs.openSync(path.join(modelsDir, `${id}.gguf`), 'w');
      fs.ftruncateSync(fd, CURATED_MODELS[0].sizeBytes);
      fs.closeSync(fd);

      await m.start(id);
      expect(m.isRunning()).toBe(true);
      const status = await m.getStatus();
      expect(status.installed).toBe(true);
      expect(status.running).toBe(true);
      expect(status.model).toBe(id);
      expect(status.port).toBe(11435);
      expect(status.models.find((x) => x.id === id)?.downloaded).toBe(true);
      expect(status.storageBytes).toBeGreaterThan(0);

      await m.stop();
      expect(m.isRunning()).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('server binds 127.0.0.1 only', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('ok', { status: 200 })) as typeof fetch;
    const spawnedArgs: string[][] = [];
    try {
      const m = new LocalLlmManager(ctx.dataDir, {
        platform: 'linux',
        arch: 'x64',
        spawn: ((cmd: string, args: string[]) => {
          spawnedArgs.push(args);
          return new FakeChild() as unknown as ReturnType<typeof import('node:child_process').spawn>;
        }) as import('../src/local-llm.js').LocalLlmDeps['spawn'],
        download: async (_u: string, d: string) => {
          fs.writeFileSync(d, 'x');
        },
        exec: async (cmd, args) => {
          if (cmd === 'nvidia-smi') return { stdout: 'NVIDIA Fake 9000\n', stderr: '' };
          if (cmd === 'tar') {
            if (args[0] === '-xzf') {
              const dest = args[args.indexOf('-C') + 1];
              fs.mkdirSync(path.join(dest, 'nb'), { recursive: true });
              fs.writeFileSync(path.join(dest, 'nb', 'llama-server'), 'fake');
            }
            return { stdout: '', stderr: '' };
          }
          throw new Error('unexpected ' + cmd);
        },
      });
      await m.downloadBinary();
      const id = CURATED_MODELS[0].id;
      const modelsDir = path.join(ctx.dataDir, 'local-llm', 'models');
      fs.mkdirSync(modelsDir, { recursive: true });
      const fd = fs.openSync(path.join(modelsDir, `${id}.gguf`), 'w');
      fs.ftruncateSync(fd, CURATED_MODELS[0].sizeBytes);
      fs.closeSync(fd);
      await m.start(id);
      const hostIdx = spawnedArgs[0].indexOf('--host');
      expect(spawnedArgs[0][hostIdx + 1]).toBe('127.0.0.1');
      expect(spawnedArgs[0]).not.toContain('0.0.0.0');
      await m.stop();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('unexpected exit is recorded and auto-restart is bounded', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('ok', { status: 200 })) as typeof fetch;
    // Real timers with a tiny restart backoff (injected seam).
    try {
      const spawns: FakeChild[] = [];
      const m = new LocalLlmManager(ctx.dataDir, {
        platform: 'linux',
        arch: 'x64',
        restartBaseDelayMs: 20,
        spawn: (() => {
          const c = new FakeChild();
          spawns.push(c);
          return c as unknown as ReturnType<typeof import('node:child_process').spawn>;
        }) as import('../src/local-llm.js').LocalLlmDeps['spawn'],
        download: async (_u: string, d: string) => {
          fs.writeFileSync(d, 'x');
        },
        exec: async (cmd, args) => {
          if (cmd === 'nvidia-smi') return { stdout: 'NVIDIA Fake 9000\n', stderr: '' };
          if (cmd === 'tar') {
            if (args[0] === '-xzf') {
              const dest = args[args.indexOf('-C') + 1];
              fs.mkdirSync(path.join(dest, 'nb'), { recursive: true });
              fs.writeFileSync(path.join(dest, 'nb', 'llama-server'), 'fake');
            }
            return { stdout: '', stderr: '' };
          }
          throw new Error('unexpected ' + cmd);
        },
      });
      await m.downloadBinary();
      const id = CURATED_MODELS[0].id;
      const modelsDir = path.join(ctx.dataDir, 'local-llm', 'models');
      fs.mkdirSync(modelsDir, { recursive: true });
      const fd = fs.openSync(path.join(modelsDir, `${id}.gguf`), 'w');
      fs.ftruncateSync(fd, CURATED_MODELS[0].sizeBytes);
      fs.closeSync(fd);
      await m.start(id);
      expect(spawns).toHaveLength(1);
      // Simulate a crash → bounded auto-restart kicks in.
      spawns[0].emit('exit', 1, null);
      await new Promise((r) => setTimeout(r, 500));
      expect(spawns.length).toBeGreaterThanOrEqual(2);
      const status = await m.getStatus();
      expect(status.restarts).toBe(1);
      expect(status.lastError).toMatch(/exited unexpectedly/);
      // Explicit stop: no further restarts after the crash loop is halted.
      await m.stop();
      const spawnsAfterStop = spawns.length;
      // Crash the (already stopped) children — nothing should respawn.
      for (const c of spawns) c.emit('exit', 1, null);
      await new Promise((r) => setTimeout(r, 300));
      expect(spawns.length).toBe(spawnsAfterStop);
      expect(m.isRunning()).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
