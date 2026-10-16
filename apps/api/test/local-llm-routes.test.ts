// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi, beforeEach } from 'vitest';
import express from 'express';
import type { LocalLlmManager, LocalLlmStatus } from '@mvp/agent-runtime';
import { createLocalLlmRouter } from '../src/local-llm-routes.js';

function fakeStatus(over: Partial<LocalLlmStatus> = {}): LocalLlmStatus {
  return {
    installed: true,
    running: false,
    port: 11435,
    model: null,
    pid: null,
    startedAt: null,
    gpu: { kind: 'cpu', detail: 'CPU only' },
    asset: { file: 'llama-b11683-bin-ubuntu-x64.tar.gz', url: 'https://example.invalid/x', archiveKind: 'tar.gz' },
    models: [],
    storageBytes: 1234,
    logTail: [],
    restarts: 0,
    lastError: null,
    ...over,
  };
}

function makeManager(over: Partial<Record<string, unknown>> = {}) {
  const calls: string[] = [];
  const manager = {
    getStatus: async () => fakeStatus(),
    listModels: async () => [],
    downloadBinary: async () => {
      calls.push('downloadBinary');
      return { file: 'x', url: 'https://example.invalid/x', archiveKind: 'tar.gz' as const };
    },
    downloadModel: async (modelId: string) => {
      calls.push(`downloadModel:${modelId}`);
      if (modelId === 'nope') throw new Error('unknown model "nope"');
      return { id: modelId };
    },
    start: async (modelId?: string) => {
      calls.push(`start:${modelId ?? ''}`);
    },
    stop: async () => {
      calls.push('stop');
    },
    restart: async (modelId?: string) => {
      calls.push(`restart:${modelId ?? ''}`);
    },
    ...over,
  };
  return { manager: manager as unknown as LocalLlmManager, calls };
}

function makeApp(manager: LocalLlmManager) {
  const app = express();
  app.use(express.json());
  app.use('/api/local-llm', createLocalLlmRouter(manager));
  return app;
}

async function listen(app: express.Express) {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.on('listening', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { server, base: `http://127.0.0.1:${port}` };
}

async function req(base: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe('local-llm routes', () => {
  let base: string;
  let server: { close: (cb?: () => void) => void };
  let calls: string[];

  beforeEach(async () => {
    const m = makeManager();
    calls = m.calls;
    const app = makeApp(m.manager);
    const l = await listen(app);
    server = l.server;
    base = l.base;
    return () => new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('GET /status returns the manager status', async () => {
    const { status, json } = await req(base, 'GET', '/api/local-llm/status');
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect((json.status as LocalLlmStatus).port).toBe(11435);
    expect((json.status as LocalLlmStatus).gpu.kind).toBe('cpu');
  });

  it('GET /models returns the curated list', async () => {
    const { status, json } = await req(base, 'GET', '/api/local-llm/models');
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(Array.isArray(json.models)).toBe(true);
  });

  it('POST /download-binary delegates to the manager', async () => {
    const { status, json } = await req(base, 'POST', '/api/local-llm/download-binary');
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(calls).toContain('downloadBinary');
  });

  it('POST /download-model requires modelId and rejects unknown ids', async () => {
    const bad = await req(base, 'POST', '/api/local-llm/download-model', {});
    expect(bad.status).toBe(400);
    const unknown = await req(base, 'POST', '/api/local-llm/download-model', { modelId: 'nope' });
    expect(unknown.status).toBe(500);
    expect(String(unknown.json.error)).toMatch(/unknown model/);
    const good = await req(base, 'POST', '/api/local-llm/download-model', { modelId: 'qwen2.5-1.5b-instruct-q4_k_m' });
    expect(good.status).toBe(200);
    expect(calls).toContain('downloadModel:qwen2.5-1.5b-instruct-q4_k_m');
  });

  it('POST /start|/stop|/restart drive the lifecycle', async () => {
    const start = await req(base, 'POST', '/api/local-llm/start', { modelId: 'm1' });
    expect(start.status).toBe(200);
    expect(calls).toContain('start:m1');
    const stop = await req(base, 'POST', '/api/local-llm/stop');
    expect(stop.status).toBe(200);
    expect(calls).toContain('stop');
    const restart = await req(base, 'POST', '/api/local-llm/restart');
    expect(restart.status).toBe(200);
    expect(calls).toContain('restart:');
  });

  it('never leaks absolute host paths in errors', async () => {
    const m = makeManager({
      getStatus: async () => {
        throw new Error('boom at /home/secret-user/data/x');
      },
    });
    const app = makeApp(m.manager);
    const l = await listen(app);
    try {
      const res = await fetch(`${l.base}/api/local-llm/status`);
      const json = (await res.json()) as { error: string };
      expect(res.status).toBe(500);
      expect(json.error).not.toContain('/home/secret-user');
    } finally {
      await new Promise<void>((resolve) => l.server.close(() => resolve()));
    }
  });

  it('start failure surfaces a 500 with the message', async () => {
    const m = makeManager({
      start: async () => {
        throw new Error('llama.cpp is not installed');
      },
    });
    const app = makeApp(m.manager);
    const l = await listen(app);
    try {
      const res = await fetch(`${l.base}/api/local-llm/start`, { method: 'POST' });
      expect(res.status).toBe(500);
      const json = (await res.json()) as { error: string };
      expect(json.error).toMatch(/not installed/);
    } finally {
      await new Promise<void>((resolve) => l.server.close(() => resolve()));
    }
  });
});
