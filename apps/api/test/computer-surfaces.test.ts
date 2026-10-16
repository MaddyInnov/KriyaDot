// SPDX-License-Identifier: Apache-2.0
// API-side tests for per-bot "Works on" computer surfaces (OpenMausBot
// parity P1 #14): overlay persistence (save/load/apply), pin persistence,
// and invalid-value rejection. No real input anywhere.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyComputerSurfacePins,
  applyComputerSurfaces,
  loadComputerSurfaceOverlay,
  loadComputerSurfacePins,
  saveBotComputerSurface,
  saveComputerSurfacePin,
} from '../src/computer-surfaces.js';
import { PerBotComputerManager } from '@mvp/agent-runtime';
import type { BotConfig } from '@mvp/agent-runtime';

let dir: string | undefined;
afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

function freshDir(): string {
  dir = mkdtempSync(join(tmpdir(), 'computer-surfaces-'));
  return dir;
}

function bots(): BotConfig[] {
  return [
    { id: 'scout', name: 'Scout', description: '', systemPrompt: '', provider: 'groq', model: 'm', skills: [], tools: [], mcpServers: [] },
    { id: 'coder', name: 'Coder', description: '', systemPrompt: '', provider: 'groq', model: 'm', skills: [], tools: [], mcpServers: [] },
  ];
}

describe('computer surface overlay', () => {
  it('saves and reloads a bot surface', () => {
    const d = freshDir();
    const bs = bots();
    expect(saveBotComputerSurface(d, bs, 'scout', 'docker')).toBe('docker');
    expect(bs[0].computerSurface).toBe('docker');
    const overlay = loadComputerSurfaceOverlay(d);
    expect(overlay.surfaces).toEqual({ scout: 'docker' });
  });

  it('rejects invalid surfaces and unknown bots', () => {
    const d = freshDir();
    const bs = bots();
    expect(() => saveBotComputerSurface(d, bs, 'scout', 'windows')).toThrow(/auto, local, docker, browser, off/);
    expect(() => saveBotComputerSurface(d, bs, 'ghost', 'docker')).toThrow(/Unknown bot/);
    // Nothing persisted on failure.
    expect(loadComputerSurfaceOverlay(d).surfaces).toEqual({});
  });

  it('applies the overlay onto bots at boot without clobbering seed values', () => {
    const d = freshDir();
    const bs = bots();
    saveBotComputerSurface(d, bs, 'scout', 'browser');
    const fresh = bots();
    fresh[1].computerSurface = 'local'; // seed-set value wins
    applyComputerSurfaces(fresh, d);
    expect(fresh[0].computerSurface).toBe('browser');
    expect(fresh[1].computerSurface).toBe('local');
  });

  it('drops invalid entries when loading a hand-edited file', () => {
    const d = freshDir();
    writeFileSync(
      join(d, 'computer-surfaces.json'),
      JSON.stringify({ surfaces: { scout: 'docker', coder: 'nonsense' }, pins: { 'scout:c1': 'bogus' } }),
    );
    const overlay = loadComputerSurfaceOverlay(d);
    expect(overlay.surfaces).toEqual({ scout: 'docker' });
    expect(overlay.pins).toEqual({});
  });

  it('persists conversation pins and loads them back', () => {
    const d = freshDir();
    saveComputerSurfacePin(d, 'scout', 'conv-1', 'browser');
    saveComputerSurfacePin(d, 'scout', 'conv-2', 'off');
    expect(loadComputerSurfacePins(d, 'scout')).toEqual([
      { conversationId: 'conv-1', surface: 'browser' },
      { conversationId: 'conv-2', surface: 'off' },
    ]);
    // Clearing removes the pin.
    saveComputerSurfacePin(d, 'scout', 'conv-1', null);
    expect(loadComputerSurfacePins(d, 'scout')).toEqual([
      { conversationId: 'conv-2', surface: 'off' },
    ]);
    expect(loadComputerSurfacePins(d, 'coder')).toEqual([]);
  });

  it('rejects bad pin inputs', () => {
    const d = freshDir();
    expect(() => saveComputerSurfacePin(d, 'scout', '', 'browser')).toThrow(/conversationId/);
    expect(() => saveComputerSurfacePin(d, 'scout', 'c1', 'windows' as never)).toThrow(/surface/);
  });

  it('applyComputerSurfacePins loads persisted pins into the manager', () => {
    const d = freshDir();
    saveComputerSurfacePin(d, 'scout', 'conv-9', 'docker');
    const mgr = new PerBotComputerManager();
    expect(applyComputerSurfacePins(mgr, d)).toBe(1);
    expect(mgr.getPin('scout', 'conv-9')).toBe('docker');
  });

  it('empty dataDir yields an empty overlay (no crash)', () => {
    const d = freshDir();
    expect(loadComputerSurfaceOverlay(d)).toEqual({ surfaces: {}, pins: {} });
    expect(applyComputerSurfaces(bots(), d)).toEqual({ surfaces: {}, pins: {} });
  });
});
