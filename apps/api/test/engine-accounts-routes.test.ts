// SPDX-License-Identifier: Apache-2.0
// Engine accounts + custom ACP engines settings API (ENGINES pack):
// profile CRUD (labels + paths only — never secret material), per-bot
// profile resolution, custom engine CRUD + merged selectable list, and
// the ACP discovery probe route with an injected probe stub. The real
// probe against a stub binary is covered in agent-runtime tests.

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BotConfig } from '@mvp/agent-runtime';
import {
  createEngineAccountsRouter,
  customEnginesPath,
  engineAccountsPath,
  getSelectableEngines,
  loadClaudeProfiles,
  loadCustomAcpEngines,
} from '../src/engine-accounts-routes.js';

let dataDir: string;
let homeDir: string;
let server: { close(cb: () => void): void } | null = null;
let baseUrl = '';
const audits: Array<{ action: string; fields: unknown }> = [];

const bots: BotConfig[] = [
  {
    id: 'bot-work',
    name: 'Work Bot',
    description: '',
    systemPrompt: '',
    provider: 'claude-subscription',
    model: 'claude-sonnet-4-5',
    skills: [],
    tools: [],
    mcpServers: [],
    accountProfile: 'work',
  },
  {
    id: 'bot-plain',
    name: 'Plain Bot',
    description: '',
    systemPrompt: '',
    provider: 'claude-subscription',
    model: 'claude-sonnet-4-5',
    skills: [],
    tools: [],
    mcpServers: [],
  },
];

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

beforeEach(async () => {
  audits.length = 0;
  dataDir = mkdtempSync(join(tmpdir(), 'engine-accounts-'));
  homeDir = mkdtempSync(join(tmpdir(), 'engine-accounts-home-'));
  const app = express();
  app.use(express.json());
  app.use(
    '/api',
    createEngineAccountsRouter({
      dataDir,
      bots,
      homeDir,
      audit: (action, fields) => void audits.push({ action, fields }),
      probeFn: async () => ({ agentName: 'stub-agent', models: [{ id: 'm1', name: 'Model 1' }] }),
    }),
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve()) as unknown as { close(cb: () => void): void };
  });
  const addr = (server as unknown as { address(): AddressInfo }).address();
  baseUrl = `http://127.0.0.1:${addr.port}/api`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = null;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

describe('Claude account profiles API', () => {
  it('creates, lists, resolves, and deletes a profile — paths + labels only', async () => {
    const created = await api('POST', '/engine-accounts', {
      id: 'work',
      label: 'Work Claude',
      configDir: 'claude-work',
    });
    expect(created.status).toBe(201);
    const profile = created.json.profile as { id: string; label: string; configDir: string };
    expect(profile.configDir).toBe(join(homeDir, 'claude-work'));
    // No secret-shaped fields anywhere in the payload.
    expect(JSON.stringify(created.json)).not.toMatch(/accessToken|oauth|apiKey/i);
    expect(existsSync(engineAccountsPath(dataDir))).toBe(true);
    expect(loadClaudeProfiles(dataDir, homeDir).map((p) => p.id)).toEqual(['work']);

    const list = await api('GET', '/engine-accounts');
    expect((list.json.profiles as unknown[]).length).toBe(1);

    const resolved = await api('GET', '/engine-accounts/resolve/bot-work');
    expect(resolved.status).toBe(200);
    expect(resolved.json.configDir).toBe(join(homeDir, 'claude-work'));
    expect((resolved.json.profile as { id: string }).id).toBe('work');

    const plain = await api('GET', '/engine-accounts/resolve/bot-plain');
    expect(plain.json.profile).toBeNull();
    expect(plain.json.configDir).toBe(join(homeDir, '.claude'));

    const missing = await api('GET', '/engine-accounts/resolve/nope');
    expect(missing.status).toBe(404);

    const del = await api('DELETE', '/engine-accounts/work');
    expect(del.status).toBe(200);
    expect(loadClaudeProfiles(dataDir, homeDir)).toEqual([]);
    expect(audits.map((a) => a.action)).toContain('engine_accounts.profile_deleted');
  });

  it('rejects an invalid profile with a 400', async () => {
    const res = await api('POST', '/engine-accounts', { id: 'Bad Id!', label: 'x', configDir: 'y' });
    expect(res.status).toBe(400);
  });
});

describe('custom ACP engines API', () => {
  it('creates a custom engine, merges it into the selectable list, probes, and deletes it', async () => {
    const created = await api('POST', '/custom-engines', {
      id: 'my-agent',
      label: 'My Agent',
      command: 'my-agent',
      args: ['acp'],
      env: { MY_AGENT_HOME: '/tmp/my-agent' },
    });
    expect(created.status).toBe(201);
    expect((created.json.engine as { id: string }).id).toBe('custom-my-agent');
    expect(existsSync(customEnginesPath(dataDir))).toBe(true);
    expect(loadCustomAcpEngines(dataDir).map((e) => e.id)).toEqual(['custom-my-agent']);

    const list = await api('GET', '/custom-engines');
    const engines = list.json.engines as Array<{ id: string; custom: boolean }>;
    expect(engines.find((e) => e.id === 'copilot')?.custom).toBe(false);
    expect(engines.find((e) => e.id === 'custom-my-agent')?.custom).toBe(true);
    expect(engines.length).toBe(getSelectableEngines(dataDir).length);

    const probe = await api('POST', '/custom-engines/custom-my-agent/probe');
    expect(probe.status).toBe(200);
    expect(probe.json.agentName).toBe('stub-agent');
    expect(probe.json.models).toEqual([{ id: 'm1', name: 'Model 1' }]);

    const del = await api('DELETE', '/custom-engines/custom-my-agent');
    expect(del.status).toBe(200);
    const after = await api('GET', '/custom-engines');
    expect((after.json.custom as unknown[]).length).toBe(0);
  });

  it('rejects a custom engine carrying a foreign provider key', async () => {
    const res = await api('POST', '/custom-engines', {
      id: 'evil',
      label: 'Evil',
      command: 'evil',
      env: { ANTHROPIC_API_KEY: 'sk-ant-nope' },
    });
    expect(res.status).toBe(400);
    expect(String(res.json.error)).toMatch(/refused/);
  });

  it('probe of an unknown engine is a 404', async () => {
    const res = await api('POST', '/custom-engines/custom-ghost/probe');
    expect(res.status).toBe(404);
  });
});
