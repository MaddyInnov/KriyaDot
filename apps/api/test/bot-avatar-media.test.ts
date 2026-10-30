// SPDX-License-Identifier: Apache-2.0
// C-16: generated avatar media for bot identity — deterministic prompt +
// style seed, mock media provider only (zero paid API use).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockMediaProvider } from '@mvp/muse-modules';
import { BotAvatarStore, avatarStyleSeed, buildAvatarPrompt, generateBotAvatar, createBotAvatarRouter } from '../src/bot-avatar-media.js';

const BOT = { id: 'scout', name: 'Scout', description: 'Research helper' };

describe('avatar prompt + seed', () => {
  it('seed is stable per bot and differs across bots', () => {
    expect(avatarStyleSeed('scout')).toBe(avatarStyleSeed('scout'));
    expect(avatarStyleSeed('scout')).not.toBe(avatarStyleSeed('coder'));
  });
  it('prompt carries name, description, palette and seed; extra prompt appends capped', () => {
    const p = buildAvatarPrompt(BOT);
    expect(p).toContain('Scout');
    expect(p).toContain('Research helper');
    expect(p).toContain(avatarStyleSeed('scout'));
    expect(buildAvatarPrompt(BOT, 'wearing a tiny hat')).toContain('tiny hat');
  });
});

describe('BotAvatarStore + generation + routes', () => {
  let dir: string; let store: BotAvatarStore; let server: Server; let base: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'avatars-'));
    store = new BotAvatarStore(dir);
    const app = express(); app.use(express.json());
    app.use('/api', createBotAvatarRouter({ store, provider: new MockMediaProvider(), getBot: (id) => (id === 'scout' ? BOT : null) }));
    server = app.listen(0); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => { await new Promise<void>((r) => server.close(() => r())); store.close(); rmSync(dir, { recursive: true, force: true }); });

  it('generates via the media provider and persists the record', async () => {
    const avatar = await generateBotAvatar(store, new MockMediaProvider(), BOT);
    expect(avatar.provider).toBe('mock');
    expect(avatar.url).toMatch(/^mock:\/\/media\//);
    expect(store.get('scout')?.assetId).toBe(avatar.assetId);
  });
  it('routes: 404 before generation, generate → get → delete', async () => {
    expect((await fetch(`${base}/api/bots/scout/avatar`)).status).toBe(404);
    const gen = await fetch(`${base}/api/bots/scout/avatar/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(gen.status).toBe(201);
    expect((await fetch(`${base}/api/bots/scout/avatar`)).status).toBe(200);
    expect((await fetch(`${base}/api/bots/ghost/avatar/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(404);
    expect((await fetch(`${base}/api/bots/scout/avatar`, { method: 'DELETE' })).status).toBe(200);
    expect((await fetch(`${base}/api/bots/scout/avatar`)).status).toBe(404);
  });
  it('regeneration replaces the record (one avatar per bot)', async () => {
    await generateBotAvatar(store, new MockMediaProvider(), BOT);
    const second = await generateBotAvatar(store, new MockMediaProvider(), BOT, 'rounder');
    expect(store.get('scout')?.prompt).toBe(second.prompt);
    expect(second.prompt).toContain('rounder');
  });
});
