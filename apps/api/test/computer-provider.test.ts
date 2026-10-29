// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import type { BotConfig, PerBotComputerManager } from '@mvp/agent-runtime';
import { computerProviderReport, loadComputerSurfaceOverlay, saveBotComputerProvider } from '../src/computer-surfaces.js';
import { registerComputerSurfaceRoutes } from '../src/computer-surface-routes.js';

const bot = (over: Partial<BotConfig> = {}): BotConfig => ({
  id: 'b1', name: 'B', description: '', systemPrompt: '', provider: 'mock', model: 'm',
  skills: [], tools: [], mcpServers: [], ...over,
} as BotConfig);

describe('computerProvider overlay + reporting', () => {
  it('persists per-bot provider and applies on reload', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cp-'));
    const bots = [bot()];
    expect(saveBotComputerProvider(dir, bots, 'b1', 'docker')).toBe('docker');
    expect(bots[0].computerProvider).toBe('docker');
    expect(loadComputerSurfaceOverlay(dir).providers).toEqual({ b1: 'docker' });
    expect(() => saveBotComputerProvider(dir, bots, 'b1', 'vps')).toThrow(/computerProvider/);
  });
  it('report explains source: config > env > auto, off is unavailable', () => {
    expect(computerProviderReport(bot({ computerProvider: 'mock' }), { COMPUTER_USE_DOCKER: '1' } as NodeJS.ProcessEnv)).toMatchObject({ activeBackend: 'mock', source: 'config' });
    expect(computerProviderReport(bot(), { COMPUTER_USE_PLAYWRIGHT: '1' } as NodeJS.ProcessEnv)).toMatchObject({ activeBackend: 'playwright', source: 'env' });
    expect(computerProviderReport(bot(), {} as NodeJS.ProcessEnv)).toMatchObject({ activeBackend: 'mock', source: 'auto' });
    expect(computerProviderReport(bot({ computerSurface: 'off' }), {} as NodeJS.ProcessEnv)).toMatchObject({ activeBackend: null, source: 'unavailable' });
  });
});

describe('computer surface routes report the provider', () => {
  let server: ReturnType<typeof express.application.listen> | undefined;
  afterEach(() => server?.close());
  it('GET reports backend+source and PUT computerProvider persists it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cp-route-'));
    const bots = [bot({ computerProvider: 'playwright' })];
    const manager = {
      profileInfo: () => ({ botId: 'b1', profileDir: '/tmp/p', exists: false, bytes: 0, files: 0 }),
      status: () => [], listPins: () => [], pinSurface: () => {}, setSurface: async () => {}, restart: async () => {},
      wipeBrowserProfile: async () => ({ botId: 'b1', profileDir: '/tmp/p', wiped: false, bytesFreed: 0 }),
    } as unknown as PerBotComputerManager;
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerComputerSurfaceRoutes(router, { bots, dataDir: dir, computerManager: manager, errorBody: (error, detail) => ({ error, detail }) });
    app.use('/api', router);
    server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
    const get = await (await fetch(`${base}/bots/b1/computer`)).json() as Record<string, unknown>;
    expect(get).toMatchObject({ computerProvider: 'playwright', activeBackend: 'playwright', providerSource: 'config' });
    const put = await (await fetch(`${base}/bots/b1/computer`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ computerProvider: 'docker' }) })).json() as Record<string, unknown>;
    expect(put).toMatchObject({ computerProvider: 'docker', activeBackend: 'docker', providerSource: 'config' });
    expect(loadComputerSurfaceOverlay(dir).providers.b1).toBe('docker');
  });
});
