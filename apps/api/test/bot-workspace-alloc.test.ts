// SPDX-License-Identifier: Apache-2.0
// Tests for auto-allocated per-bot workspaces (Codync parity).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { BotConfig } from '@mvp/agent-runtime';
import {
  allocateBotWorkspace,
  allocateBotWorkspaces,
  botWorkspacePath,
  ensureBotWorkspaceDir,
} from '../src/bot-workspace-alloc.js';

function makeBot(id: string, workspace?: string): BotConfig {
  const bot = {
    id,
    name: `Bot ${id}`,
    systemPrompt: 'test',
    provider: 'groq',
    model: 'test-model',
    tools: [],
  } as BotConfig;
  if (workspace !== undefined) bot.workspace = workspace;
  return bot;
}

describe('bot-workspace-alloc', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kriyadot-ws-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates <dataDir>/bots/<botId>/workspace', () => {
    const dir = ensureBotWorkspaceDir('helper', tmpDir);
    expect(dir).toBe(path.resolve(tmpDir, 'bots', 'helper', 'workspace'));
    expect(fs.statSync(dir).isDirectory()).toBe(true);
  });

  it('is idempotent (second call does not throw)', () => {
    const d1 = ensureBotWorkspaceDir('helper', tmpDir);
    const d2 = ensureBotWorkspaceDir('helper', tmpDir);
    expect(d1).toBe(d2);
  });

  it('rejects invalid bot ids', () => {
    expect(() => ensureBotWorkspaceDir('../evil', tmpDir)).toThrow();
    expect(() => ensureBotWorkspaceDir('a/b', tmpDir)).toThrow();
  });

  it('allocateBotWorkspace sets bot.workspace and creates the dir', () => {
    const bot = makeBot('coder');
    const dir = allocateBotWorkspace(bot, tmpDir);
    expect(dir).toBe(path.resolve(tmpDir, 'bots', 'coder', 'workspace'));
    expect(bot.workspace).toBe(dir);
    expect(fs.statSync(dir).isDirectory()).toBe(true);
  });

  it('allocateBotWorkspace does not override an explicit workspace', () => {
    const bot = makeBot('coder', 'my-custom-ws');
    const dir = allocateBotWorkspace(bot, tmpDir);
    expect(dir).toBeNull();
    expect(bot.workspace).toBe('my-custom-ws');
  });

  it('allocateBotWorkspaces allocates for all bots without explicit workspaces', () => {
    const bots = [makeBot('a'), makeBot('b', 'explicit'), makeBot('c')];
    const allocated = allocateBotWorkspaces(bots, tmpDir);
    expect(allocated).toEqual(['a', 'c']);
    expect(bots[0].workspace).toContain(path.join('bots', 'a', 'workspace'));
    expect(bots[1].workspace).toBe('explicit');
  });

  it('botWorkspacePath returns the configured workspace when set', () => {
    const bot = makeBot('coder', 'custom');
    expect(botWorkspacePath(bot, tmpDir)).toBe(path.resolve('custom'));
  });

  it('botWorkspacePath creates and returns the default when unset', () => {
    const bot = makeBot('coder');
    const p = botWorkspacePath(bot, tmpDir);
    expect(p).toBe(path.resolve(tmpDir, 'bots', 'coder', 'workspace'));
    expect(fs.statSync(p).isDirectory()).toBe(true);
  });
});
