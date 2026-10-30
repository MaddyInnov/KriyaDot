// SPDX-License-Identifier: Apache-2.0
// Ollama sidecar mode (free-LLM stack #5): status reporting,
// ensureSidecarModel() pulling exactly one configured model when disk
// suffices, and the standard-local-provider descriptor. All process
// execution goes through injected fake runners — no real pulls.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LocalLlmManager,
  SIDECAR_DEFAULT_MODEL,
  type ExecFn,
} from '../src/local-llm.js';

const LIST_HEADER = 'NAME              ID              SIZE      MODIFIED';

function makeSidecar(opts: {
  binaryPresent?: boolean;
  initialModels?: string[];
  freeBytes?: number | null;
}): {
  manager: LocalLlmManager;
  pulls: string[];
  dir: string;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-test-'));
  const state = {
    models: [...(opts.initialModels ?? [])],
  };
  const pulls: string[] = [];
  const exec: ExecFn = async (cmd, args) => {
    if (cmd !== 'ollama') throw new Error(`unexpected exec ${cmd}`);
    if (opts.binaryPresent === false) throw new Error('ollama: command not found');
    if (args[0] === '--version') return { stdout: 'ollama version is 0.9.0\n', stderr: '' };
    if (args[0] === 'list') {
      const lines = state.models.map((m) => `${m}        abc123        2.5 GB    1 hour ago`);
      return { stdout: [LIST_HEADER, ...lines].join('\n') + '\n', stderr: '' };
    }
    if (args[0] === 'pull') {
      pulls.push(args[1]!);
      state.models.push(args[1]!);
      return { stdout: 'success\n', stderr: '' };
    }
    throw new Error(`unexpected ollama args ${args.join(' ')}`);
  };
  const manager = new LocalLlmManager(dir, {
    exec,
    execLong: exec,
    freeSpaceFn: async () => (opts.freeBytes === undefined ? 9_000_000_000 : opts.freeBytes),
    platform: 'linux',
    arch: 'x64',
  });
  return { manager, pulls, dir };
}

let savedOllamaHost: string | undefined;
let savedSidecarModel: string | undefined;

beforeEach(() => {
  savedOllamaHost = process.env.OLLAMA_HOST;
  savedSidecarModel = process.env.KRIYADOT_SIDECAR_MODEL;
  delete process.env.OLLAMA_HOST;
  delete process.env.KRIYADOT_SIDECAR_MODEL;
});

afterEach(() => {
  if (savedOllamaHost === undefined) delete process.env.OLLAMA_HOST;
  else process.env.OLLAMA_HOST = savedOllamaHost;
  if (savedSidecarModel === undefined) delete process.env.KRIYADOT_SIDECAR_MODEL;
  else process.env.KRIYADOT_SIDECAR_MODEL = savedSidecarModel;
});

describe('Ollama sidecar status', () => {
  it('reports binary present, model not pulled, disk sufficient', async () => {
    const { manager, dir } = makeSidecar({});
    try {
      const status = await manager.sidecarStatus();
      expect(status.mode).toBe('ollama-sidecar');
      expect(status.providerId).toBe('ollama');
      expect(status.binaryPresent).toBe(true);
      expect(status.version).toContain('0.9.0');
      expect(status.model).toBe(SIDECAR_DEFAULT_MODEL);
      expect(status.model).toBe('qwen3:4b');
      expect(status.modelPulled).toBe(false);
      expect(status.ready).toBe(false);
      expect(status.diskSufficient).toBe(true);
      expect(status.baseUrl).toBe('http://localhost:11434/v1');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports binary missing cleanly', async () => {
    const { manager, dir } = makeSidecar({ binaryPresent: false });
    try {
      const status = await manager.sidecarStatus();
      expect(status.binaryPresent).toBe(false);
      expect(status.models).toEqual([]);
      expect(status.ready).toBe(false);
      await expect(manager.ensureSidecarModel()).rejects.toThrow(/not installed/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sees an already-pulled model (incl. tagged variants)', async () => {
    const { manager, dir } = makeSidecar({ initialModels: ['qwen3:4b'] });
    try {
      const status = await manager.sidecarStatus();
      expect(status.modelPulled).toBe(true);
      expect(status.ready).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ensureSidecarModel', () => {
  it('pulls exactly the one configured model, once', async () => {
    const { manager, pulls, dir } = makeSidecar({});
    try {
      const first = await manager.ensureSidecarModel();
      expect(first.pulled).toBe(true);
      expect(first.status.modelPulled).toBe(true);
      expect(pulls).toEqual(['qwen3:4b']);
      const second = await manager.ensureSidecarModel();
      expect(second.pulled).toBe(false);
      expect(pulls).toEqual(['qwen3:4b']); // still exactly one pull
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to pull when free disk is below model size + margin (10 GB Drive constraint)', async () => {
    const { manager, pulls, dir } = makeSidecar({ freeBytes: 1_000_000_000 });
    try {
      const status = await manager.sidecarStatus();
      expect(status.diskSufficient).toBe(false);
      await expect(manager.ensureSidecarModel()).rejects.toThrow(/not enough free disk/);
      expect(pulls).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not pull when the model is already there, even with low disk', async () => {
    const { manager, pulls, dir } = makeSidecar({
      initialModels: ['qwen3:4b'],
      freeBytes: 100,
    });
    try {
      const res = await manager.ensureSidecarModel();
      expect(res.pulled).toBe(false);
      expect(pulls).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('sidecar provider descriptor', () => {
  it('exposes the sidecar as the standard local ollama provider', () => {
    const { manager, dir } = makeSidecar({});
    try {
      expect(manager.sidecarProviderDescriptor()).toEqual({
        providerId: 'ollama',
        baseUrl: 'http://localhost:11434/v1',
        model: 'qwen3:4b',
        local: true,
        keyless: true,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
