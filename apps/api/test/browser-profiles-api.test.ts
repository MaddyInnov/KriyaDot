// SPDX-License-Identifier: Apache-2.0
// W4 API tests: per-bot browser profile info in GET /bots/:id/computer and
// the audited POST /bots/:id/computer/wipe-browser-profile endpoint.
// Temp dirs only; no browser is launched and no network beyond localhost.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PerBotComputerManager } from '@mvp/agent-runtime';
import type { BotConfig } from '@mvp/agent-runtime';
import { registerComputerSurfaceRoutes } from '../src/computer-surface-routes.js';

const bots = [
  { id: 'scout', name: 'Scout', description: '', systemPrompt: '', provider: 'groq', model: 'm', skills: [], tools: [], mcpServers: [] },
] as unknown as BotConfig[];

describe('browser profile routes (W4)', () => {
  let dir: string;
  let profileRoot: string;
  let manager: PerBotComputerManager;
  let server: { close(cb: () => void): void } | null = null;
  let baseUrl = '';
  const audit = vi.fn();
  const errorBody = (error: string, detail?: string) => (detail ? { error, detail } : { error });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'browser-profiles-api-'));
    profileRoot = join(dir, 'browser-profiles');
    audit.mockClear();
    manager = new PerBotComputerManager({ browserProfileRoot: profileRoot });
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerComputerSurfaceRoutes(router, {
      bots,
      dataDir: dir,
      computerManager: manager,
      errorBody,
      audit,
    });
    app.use('/api', router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve()) as unknown as { close(cb: () => void): void };
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}/api`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  async function call(method: string, path: string) {
    const res = await fetch(`${baseUrl}${path}`, { method });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, json };
  }

  function seedProfile(): string {
    const profileDir = manager.profileDirFor('scout');
    mkdirSync(join(profileDir, 'Default'), { recursive: true });
    writeFileSync(join(profileDir, 'Default', 'Cookies'), 'fake-cookie-store');
    return profileDir;
  }

  it('GET computer reports browserProfile existence + disk usage', async () => {
    seedProfile();
    const { status, json } = await call('GET', '/bots/scout/computer');
    expect(status).toBe(200);
    const bp = json.browserProfile as { profileDir: string; exists: boolean; bytes: number; files: number };
    expect(bp.exists).toBe(true);
    expect(bp.bytes).toBeGreaterThan(0);
    expect(bp.files).toBe(1);
    expect(bp.profileDir).toBe(manager.profileDirFor('scout'));
  });

  it('wipe deletes the profile, is audited, and GET then reports no profile', async () => {
    const profileDir = seedProfile();
    const { status, json } = await call('POST', '/bots/scout/computer/wipe-browser-profile');
    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, botId: 'scout', wiped: true });
    expect((json.bytesFreed as number) > 0).toBe(true);
    expect(existsSync(profileDir)).toBe(false);
    expect(audit).toHaveBeenCalledWith(
      'computer.browser_profile_wiped',
      expect.objectContaining({ detail: expect.objectContaining({ botId: 'scout', wiped: true }) }),
    );
    const after = await call('GET', '/bots/scout/computer');
    expect((after.json.browserProfile as { exists: boolean }).exists).toBe(false);
    // A second wipe is a clean no-op.
    const again = await call('POST', '/bots/scout/computer/wipe-browser-profile');
    expect(again.json).toMatchObject({ ok: true, wiped: false });
  });

  it('restart KEEPS the profile (only the explicit wipe deletes it)', async () => {
    const profileDir = seedProfile();
    const { status } = await call('POST', '/bots/scout/computer/restart');
    expect(status).toBe(200);
    expect(existsSync(profileDir)).toBe(true);
  });

  it('wipe validates the bot', async () => {
    expect((await call('POST', '/bots/ghost/computer/wipe-browser-profile')).status).toBe(404);
    expect((await call('POST', '/bots/bad!!/computer/wipe-browser-profile')).status).toBe(400);
  });
});
