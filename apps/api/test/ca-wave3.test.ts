// SPDX-License-Identifier: Apache-2.0
// Wave-3 worker API tests: CA-15 (slash-command v2), CA-6 (/init),
// CA-17 (output styles + /style), CA-37 (incognito thread routes),
// CA-2 (bot approval modes accept the new named modes).

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionStore } from '@mvp/agent-runtime';
import {
  expandPositional,
  expandSlashCommand,
  expandSlashCommandV2,
  executeInitCommand,
  isInitCommand,
  loadSlashCommands,
  saveSlashCommand,
  splitCommandArgs,
  type SlashCommandMap,
} from '../src/slash-commands.js';
import {
  OutputStyleStore,
  authorOutputStyle,
  buildStylePrompt,
  deriveStyleFromSamples,
  parseStyleCommand,
} from '../src/session-craft.js';
import { SessionCommandService } from '../src/session-commands-routes.js';
import { createChatThreadsRouter } from '../src/chat-threads-routes.js';
import { saveBotApprovalModeForBot, getBotApprovalMode } from '../src/bot-approval-modes.js';
import type { BotConfig } from '@mvp/agent-runtime';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ca-wave3-api-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('CA-15 slash command frontmatter v2', () => {
  const commands: SlashCommandMap = {
    greet: { description: 'g', prompt: 'Hello $1, you said: $ARGUMENTS (legacy {args})', agent: 'scout', model: 'mock-1', subtask: true },
    plain: { description: 'p', prompt: 'Args: {args}' },
  };

  it('loads + persists agent/model/subtask fields', () => {
    saveSlashCommand(dir, 'task', { description: 't', prompt: 'Do $ARGUMENTS', agent: 'coder', model: 'm1', subtask: true });
    const loaded = loadSlashCommands(dir);
    expect(loaded.task).toMatchObject({ agent: 'coder', model: 'm1', subtask: true });
  });

  it('positional expansion: $ARGUMENTS and $1..$n, quotes respected', () => {
    expect(splitCommandArgs('a "b c" d')).toEqual(['a', 'b c', 'd']);
    expect(expandPositional('[$1][$2][$ARGUMENTS][$9]', 'x y')).toBe('[x][y][x y][]');
    const out = expandSlashCommand('/greet bob hope', commands);
    expect(out?.expanded).toBe('Hello bob, you said: bob hope (legacy bob hope)');
  });

  it('v2 returns pinning fields and keeps legacy templates working', async () => {
    const v2 = await expandSlashCommandV2('/greet amy', commands, {});
    expect(v2).toMatchObject({ commandName: 'greet', agent: 'scout', model: 'mock-1', subtask: true });
    const legacy = await expandSlashCommandV2('/plain hi there', commands, {});
    expect(legacy).toMatchObject({ expanded: 'Args: hi there', subtask: false });
  });

  it('@file refs are workspace-confined and size-capped', async () => {
    const ws = join(dir, 'ws');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'note.md'), 'NOTE CONTENT');
    const cmds: SlashCommandMap = { show: { description: '', prompt: 'Read @note.md and @../escape.md' } };
    const out = await expandSlashCommandV2('/show', cmds, { workspaceDir: ws });
    expect(out && 'expanded' in out ? out.expanded : '').toContain('NOTE CONTENT');
    expect(out && 'expanded' in out ? out.expanded : '').toContain('outside the workspace');
  });

  it('!`cmd` injection only runs when governance allows', async () => {
    const cmds: SlashCommandMap = { today: { description: '', prompt: 'Date: !`date +%F`' } };
    const allowed = await expandSlashCommandV2('/today', cmds, { shellGate: () => 'allow', shellRunner: () => '2026-10-30' });
    expect(allowed && 'expanded' in allowed ? allowed.expanded : '').toContain('2026-10-30');
    const denied = await expandSlashCommandV2('/today', cmds, { shellGate: () => 'deny', shellRunner: () => 'PWNED' });
    const deniedText = denied && 'expanded' in denied ? denied.expanded : '';
    expect(deniedText).toContain('denied by governance');
    expect(deniedText).not.toContain('PWNED');
    const unwired = await expandSlashCommandV2('/today', cmds, {});
    expect(unwired && 'expanded' in unwired ? unwired.expanded : '').toContain('not run');
  });
});

describe('CA-6 /init chat command', () => {
  it('writes a starter AGENTS.md and refuses to overwrite without --force', () => {
    const ws = join(dir, 'repo');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'package.json'), JSON.stringify({ name: 'repo-x', scripts: { test: 'vitest' } }));
    expect(isInitCommand('/init')).toBe(true);
    expect(isInitCommand('/initialize')).toBe(false);
    const first = executeInitCommand('/init', { workspaceDir: ws });
    expect(first.ok).toBe(true);
    expect(readFileSync(join(ws, 'AGENTS.md'), 'utf8')).toContain('# repo-x');
    const second = executeInitCommand('/init', { workspaceDir: ws });
    expect(second.ok).toBe(false);
    expect(second.error).toContain('--force');
    const forced = executeInitCommand('/init --force', { workspaceDir: ws });
    expect(forced.ok).toBe(true);
  });
});

describe('CA-17 output styles', () => {
  it('store: builtins + per-user custom styles, decoupled and persistent', () => {
    const store = OutputStyleStore.forDataDir(dir);
    expect(store.list('u1').map((s) => s.name)).toContain('concise');
    store.save('u1', { name: 'My Voice', description: 'mine', prompt: 'Write like me.' });
    expect(store.get('u1', 'my-voice')?.prompt).toBe('Write like me.');
    expect(store.get('u2', 'my-voice')).toBeUndefined(); // per-user isolation
    const reopened = OutputStyleStore.forDataDir(dir);
    expect(reopened.get('u1', 'my-voice')).toBeDefined();
  });

  it('session switching via the store + prompt fragment', () => {
    const store = OutputStyleStore.forDataDir(dir);
    store.setSessionStyle('sess-1', 'u1', 'concise');
    expect(store.getSessionStyle('sess-1')?.name).toBe('concise');
    expect(buildStylePrompt(store.getSessionStyle('sess-1'))).toContain('# Output style: concise');
    store.setSessionStyle('sess-1', 'u1', null);
    expect(store.getSessionStyle('sess-1')).toBeUndefined();
    expect(buildStylePrompt(undefined)).toBe('');
  });

  it('sample authoring: deterministic stats fallback is honest + labelled', async () => {
    const style = deriveStyleFromSamples('mine', [
      "I don't think so. It won't work, and that's fine. We'll see.",
      "Nope. Can't do it. Don't ask again, we're done here.",
    ]);
    expect(style.source).toBe('samples-stats');
    expect(style.description).toContain('surface statistics');
    expect(style.prompt).toContain('short sentences');
    const viaSeam = await authorOutputStyle('llmstyle', ['sample text here.'], async () => ({ description: 'LLM desc', prompt: 'LLM prompt' }));
    expect(viaSeam.source).toBe('samples-llm');
    const seamDown = await authorOutputStyle('fallback', ['Some sample. More text.'], async () => { throw new Error('no llm'); });
    expect(seamDown.source).toBe('samples-stats');
  });

  it('/style command through SessionCommandService', async () => {
    const store = OutputStyleStore.forDataDir(dir);
    const svc = new SessionCommandService({
      getMessages: () => [],
      sessionStyle: {
        list: (u) => store.list(u),
        get: (u, n) => store.get(u, n),
        getSession: (s) => store.getSessionStyle(s),
        setSession: (s, u, n) => store.setSessionStyle(s, u, n),
      },
    });
    expect(parseStyleCommand('/style concise')).toEqual({ action: 'set', name: 'concise' });
    const set = await svc.execute('sess-9', 'bot', '/style concise');
    expect(set.handled).toBe(true);
    expect(set.reply).toContain('concise');
    expect(store.getSessionStyle('sess-9')?.name).toBe('concise');
    const bad = await svc.execute('sess-9', 'bot', '/style nope-not-real');
    expect(bad.reply).toContain('Unknown style');
    const cleared = await svc.execute('sess-9', 'bot', '/style clear');
    expect(cleared.reply).toContain('cleared');
    expect(store.getSessionStyle('sess-9')).toBeUndefined();
  });
});

describe('CA-2 bot approval modes accept the new modes', () => {
  it('persists acceptEdits and dontAsk per bot', () => {
    const bot: BotConfig = { id: 'b1', name: 'b1', description: '', systemPrompt: '', provider: 'mock', model: 'mock', skills: [], tools: [], mcpServers: [] };
    expect(saveBotApprovalModeForBot(dir, [bot], 'b1', 'acceptEdits')).toBe('acceptEdits');
    expect(getBotApprovalMode(dir, 'b1')).toBe('acceptEdits');
    expect(saveBotApprovalModeForBot(dir, [bot], 'b1', 'dontAsk')).toBe('dontAsk');
    expect(bot.approvalMode).toBe('dontAsk');
  });
});

describe('CA-37 incognito thread routes', () => {
  let server: { close(cb: () => void): void } | null = null;
  let baseUrl = '';
  let store: SessionStore;

  beforeEach(async () => {
    store = new SessionStore(join(dir, 'sessions.db'));
    const app = express();
    app.use(express.json());
    app.use('/api/chat/threads', createChatThreadsRouter({
      dataDir: dir,
      listThreads: (opts) => store.listSessions(opts ?? {}),
      branchSession: (id, msgId, opts) => store.branchSession(id, msgId, opts?.botId),
      listThreadMessages: (id) => store.listThreadMessages(id),
      duplicateThread: (id) => store.duplicateSession(id),
      deleteThread: (id) => store.deleteSession(id),
      createIncognitoThread: (botId) => store.createSession(botId, { incognito: true }),
      closeIncognitoThread: (id) => store.closeIncognitoSession(id),
      audit: () => {},
    }));
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()) as unknown as { close(cb: () => void): void }; });
    baseUrl = `http://127.0.0.1:${(server as unknown as { address(): AddressInfo }).address().port}/api/chat/threads`;
  });
  afterEach(async () => {
    store.close();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  });

  it('creates an incognito thread, badges it in the list, closes it', async () => {
    const created = await fetch(`${baseUrl}/incognito`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ botId: 'bot-a' }) });
    expect(created.status).toBe(201);
    const cj = (await created.json()) as { thread: { id: string; incognito: boolean } };
    expect(cj.thread.incognito).toBe(true);
    store.appendMessage(cj.thread.id, { role: 'user', content: 'ephemeral hello' });

    const list = await fetch(`${baseUrl}?limit=10`);
    const lj = (await list.json()) as { threads: Array<{ id: string; incognito: boolean; messageCount: number }> };
    const found = lj.threads.find((t) => t.id === cj.thread.id)!;
    expect(found.incognito).toBe(true);
    expect(found.messageCount).toBe(1);

    const closed = await fetch(`${baseUrl}/${cj.thread.id}/close-incognito`, { method: 'POST' });
    expect(closed.status).toBe(200);
    expect(store.getSession(cj.thread.id)).toBeUndefined();
    expect(existsSync(join(dir, 'sessions.db'))).toBe(true);
  });

  it('normal threads are badged incognito:false', async () => {
    const id = store.createSession('bot-a');
    store.appendMessage(id, { role: 'user', content: 'hi' });
    const list = await fetch(`${baseUrl}?limit=10`);
    const lj = (await list.json()) as { threads: Array<{ id: string; incognito: boolean }> };
    expect(lj.threads.find((t) => t.id === id)?.incognito).toBe(false);
  });
});
