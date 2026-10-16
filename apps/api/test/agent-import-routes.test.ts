// SPDX-License-Identifier: Apache-2.0
// Tests for the agent-import API surface (Atomic parity):
// detection, preview, and the additive-only import run.
//
// Zero paid usage, no real home-dir access: HOME is pointed at a temp dir
// before the router is created (os.homedir() reads $HOME on POSIX).

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionStore, TieredMemoryStore, type BotConfig } from '@mvp/agent-runtime';
import { createAgentImportRouter } from '../src/agent-import-routes.js';

const bot = (over: Partial<BotConfig> = {}): BotConfig =>
  ({
    id: 'bot_import',
    name: 'Import Bot',
    description: 'test bot',
    systemPrompt: 'You are a test bot.',
    provider: 'groq',
    model: 'test-model',
    skills: [],
    tools: [],
    mcpServers: [],
    ...over,
  }) as BotConfig;

let dir: string;
let fakeHome: string;
let bots: BotConfig[];
let store: TieredMemoryStore;
let sessionStore: SessionStore;
let app: express.Express;
let base: string;
let server: ReturnType<express.Express['listen']>;
const audits: Array<{ action: string; fields: Record<string, unknown> }> = [];
const realHome = process.env.HOME;

function write(p: string, content: string) {
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content, 'utf8');
}

async function req(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mvp-agentimport-'));
  fakeHome = mkdtempSync(join(tmpdir(), 'mvp-fakehome-'));
  process.env.HOME = fakeHome;
  audits.length = 0;
  bots = [bot()];
  store = new TieredMemoryStore(dir);
  sessionStore = new SessionStore(join(dir, 'sessions.db'));
  app = express();
  app.use(express.json());
  app.use(
    '/api/agent-import',
    createAgentImportRouter({
      dataDir: dir,
      getBots: () => bots,
      tieredMemoryStore: store,
      sessionStore,
      audit: (action, fields) => audits.push({ action, fields }),
    }),
  );
  server = app.listen(0);
  await new Promise<void>((resolve) => server.on('listening', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterEach(() => {
  server.close();
  process.env.HOME = realHome;
  rmSync(dir, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

function seedClaudeCode() {
  write(
    join(fakeHome, '.claude', 'skills', 'pdf', 'SKILL.md'),
    '---\nname: pdf\ndescription: Work with PDF files.\n---\n\nExtract text. api_key: "topsecret123".',
  );
  write(join(fakeHome, '.claude', 'CLAUDE.md'), 'I prefer concise answers. Always run tests.');
  write(
    join(fakeHome, '.claude', 'projects', 'proj', 'sess1.jsonl'),
    '{"type":"user","message":{"role":"user","content":"build it"},"timestamp":1}\n' +
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"done"}]},"timestamp":2}\n',
  );
  write(join(fakeHome, '.claude.json'), '{"model":"claude-x","customInstructions":"Be terse."}');
}

describe('GET /sources', () => {
  it('detects Claude Code with counts', async () => {
    seedClaudeCode();
    const { status, json } = await req('GET', '/api/agent-import/sources');
    expect(status).toBe(200);
    const sources = json.sources as Array<{ id: string; present: boolean; counts: Record<string, number> }>;
    const cc = sources.find((s) => s.id === 'claude-code')!;
    expect(cc.present).toBe(true);
    expect(cc.counts.skills).toBe(1);
    expect(cc.counts.sessions).toBe(1);
    expect(cc.counts.memoryFiles).toBe(1);
    expect(sources.find((s) => s.id === 'codex')!.present).toBe(false);
  });

  it('reports all six sources', async () => {
    const { json } = await req('GET', '/api/agent-import/sources');
    expect((json.sources as unknown[]).length).toBe(6);
  });
});

describe('POST /preview', () => {
  it('rejects unknown source ids', async () => {
    const { status } = await req('POST', '/api/agent-import/preview', { sourceId: 'nope' });
    expect(status).toBe(400);
  });

  it('previews importable items', async () => {
    seedClaudeCode();
    const { status, json } = await req('POST', '/api/agent-import/preview', { sourceId: 'claude-code' });
    expect(status).toBe(200);
    const items = json.items as Array<{ kind: string; id: string }>;
    expect(items.some((i) => i.kind === 'skill')).toBe(true);
    expect(items.some((i) => i.kind === 'memory')).toBe(true);
    expect(items.some((i) => i.kind === 'session')).toBe(true);
    expect((json.botProposal as { name: string }).name).toBe('Claude Code Import');
  });
});

describe('POST /run', () => {
  it('validates input', async () => {
    expect((await req('POST', '/api/agent-import/run', {})).status).toBe(400);
    expect(
      (await req('POST', '/api/agent-import/run', { sourceId: 'claude-code', itemIds: [] })).status,
    ).toBe(400);
    expect(
      (
        await req('POST', '/api/agent-import/run', {
          sourceId: 'claude-code',
          targetBotId: 'nope',
          itemIds: [],
        })
      ).status,
    ).toBe(404);
  });

  it('imports skills, memory, and sessions additively with secrets redacted', async () => {
    seedClaudeCode();
    const preview = await req('POST', '/api/agent-import/preview', { sourceId: 'claude-code' });
    const items = preview.json.items as Array<{ id: string }>;
    const itemIds = items.map((i) => i.id);

    const { status, json } = await req('POST', '/api/agent-import/run', {
      sourceId: 'claude-code',
      targetBotId: 'bot_import',
      itemIds,
    });
    expect(status).toBe(200);
    const imported = json.imported as { skills: string[]; memories: number; sessions: string[] };
    expect(imported.skills).toEqual(['pdf']);
    expect(imported.memories).toBeGreaterThan(0);
    expect(imported.sessions).toHaveLength(1);

    // Skill file written, secret redacted.
    const skillFile = join(dir, 'skills', 'pdf.md');
    expect(existsSync(skillFile)).toBe(true);
    const content = readFileSync(skillFile, 'utf8');
    expect(content).toContain('name: pdf');
    expect(content).not.toContain('topsecret123');

    // Memory atoms stored for the bot.
    const atoms = store.searchAtoms('bot_import', 'concise');
    expect(atoms.length).toBeGreaterThan(0);

    // Session archived with both messages.
    const sessionId = imported.sessions[0];
    const history = await sessionStore.getMessages(sessionId);
    expect(history.map((m) => m.content)).toEqual(['build it', 'done']);

    expect(audits.some((a) => a.action === 'agent_import.run')).toBe(true);
  });

  it('never overwrites existing skills or bots', async () => {
    seedClaudeCode();
    const preview = await req('POST', '/api/agent-import/preview', { sourceId: 'claude-code' });
    const items = preview.json.items as Array<{ id: string }>;
    const body = {
      sourceId: 'claude-code',
      targetBotId: 'bot_import',
      itemIds: items.map((i) => i.id),
      createBot: true,
      botName: 'Claude Import',
    };
    const first = await req('POST', '/api/agent-import/run', body);
    expect((first.json.imported as { bot?: string }).bot).toBe('claude-import');
    expect(bots.some((b) => b.id === 'claude-import')).toBe(true);

    const second = await req('POST', '/api/agent-import/run', body);
    const skipped = second.json.skipped as Array<{ id: string; reason: string }>;
    expect(skipped.some((s) => s.id.startsWith('skill:'))).toBe(true);
    expect(skipped.some((s) => s.id.startsWith('bot:'))).toBe(true);
    // Only one bot with that id exists.
    expect(bots.filter((b) => b.id === 'claude-import')).toHaveLength(1);
  });

  it('creates a bot from the proposal when requested', async () => {
    seedClaudeCode();
    const { json } = await req('POST', '/api/agent-import/run', {
      sourceId: 'claude-code',
      targetBotId: 'bot_import',
      itemIds: ['bot:claude-code'],
      createBot: true,
    });
    const imported = json.imported as { bot?: string };
    expect(imported.bot).toBe('imported-claude-code');
    const created = bots.find((b) => b.id === 'imported-claude-code')!;
    expect(created.systemPrompt).toBe('Be terse.');
    expect(created.provider).toBe('anthropic');
  });
});
