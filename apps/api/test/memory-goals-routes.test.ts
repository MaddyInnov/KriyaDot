// SPDX-License-Identifier: Apache-2.0
// Wave-5 memory & goals finishes (audit §4.4):
// MEM-4 merged search (memory + main chat + side chats, one box),
// MEM-5 memory explain (provenance, superseded-by chain, confidence),
// MEM-6 guided paste-import, MEM-7 ZIP chat-export intake (mock
// summariser — zero paid API), MEM-9 people/group pages,
// G-2/G-3/G-5/G-6/G-7/G-8 goal finishes over HTTP, G-10 tracked items.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { TieredMemoryStore } from '@mvp/agent-runtime';
import { ModuleDb, GoalStore, ReminderStore, CommitmentStore } from '@mvp/muse-modules';
// Real finishes stores, imported from source for the test (the package
// index export is added by the coordinator per the Wave-5 wiring note).
import { GoalFinishesStore } from '../../../packages/muse-modules/src/goals/finishes.js';
import { listTrackedItems } from '../../../packages/muse-modules/src/tracked-items/index.js';
import { ChannelSideChatStore } from '../src/channel-side-chats.js';
import { createMemoryGoalsRouter } from '../src/memory-goals-routes.js';
import { parseMemoryMarkdown, parseChatExportFile, extractiveConversationSummary } from '../src/memory-import.js';
import { TaskStore } from '../src/tasks.js';

let dir: string;
let baseUrl = '';
let server: { close(cb: () => void): void } | null = null;
let memory: TieredMemoryStore;
let sideChats: ChannelSideChatStore;
let mdb: ModuleDb;
let goals: GoalStore;
let fin: GoalFinishesStore;
const audits: Array<{ action: string }> = [];
const summarizer = vi.fn(async (prompt: string) => `Generated summary from mock summariser (${prompt.length} chars).`);

const BOT = 'bot-a';

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'memgoals-'));
  audits.length = 0;
  summarizer.mockClear();
  memory = new TieredMemoryStore(dir);
  sideChats = new ChannelSideChatStore(dir);
  mdb = new ModuleDb(join(dir, 'muse-modules.db'));
  goals = new GoalStore(mdb);
  fin = new GoalFinishesStore(mdb);
  const tasks = new TaskStore(dir);
  tasks.create({ title: 'File the taxes', dueAt: new Date(Date.now() + 3600_000).toISOString() });

  const app = express();
  app.use(express.json({ limit: '60mb' }));
  const handle = createMemoryGoalsRouter({
    dataDir: dir,
    memory,
    sideChats,
    searchMessages: (q) => (q.toLowerCase().includes('dentist')
      ? [{ messageId: 42, sessionId: 'sess-1', botId: BOT, role: 'user', ts: new Date().toISOString(), snippet: `booked the \u0001dentist\u0002 for Tuesday`, rank: -1 }]
      : []),
    audit: (action) => { audits.push({ action }); },
    summarizer,
    goalFinishes: fin,
    listTrackedItems: (opts) => listTrackedItems(mdb, {
      tasks: () => new TaskStore(dir).list(),
      kind: opts.kind as never, status: opts.status as never, goalId: opts.goalId,
    }),
  });
  app.use('/api/memory-goals', handle.router);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()) as never; });
  baseUrl = `http://127.0.0.1:${(server as unknown as { address(): AddressInfo }).address().port}/api/memory-goals`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  sideChats.close();
  mdb.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = (path: string) => fetch(`${baseUrl}${path}`);
const send = (method: string, path: string, body?: unknown) =>
  fetch(`${baseUrl}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

describe('MEM-4 merged search', () => {
  it('merges memory atoms, main-chat excerpts and side-chat excerpts in one result list', async () => {
    memory.storeAtom(BOT, { fact: 'The user sees a dentist named Dr Rao', entities: ['Dr Rao'], confidence: 0.9 }, 'turn-1');
    sideChats.mirrorMessage({
      providerId: 'whatsapp', externalChatId: '919999999999', providerMessageId: 'wamid.1',
      direction: 'in', kind: 'text', text: 'Reminder: dentist appointment moved to Friday', contactName: 'Asha Rao',
    });
    const res = await get(`/search?q=dentist&botId=${BOT}`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { results: Array<{ kind: string; excerpt: string }>; counts: Record<string, number> };
    expect(data.counts).toEqual({ memory: 1, chat: 1, sideChat: 1 });
    expect(data.results.map((r) => r.kind).sort()).toEqual(['chat', 'memory', 'side-chat']);
    const chat = data.results.find((r) => r.kind === 'chat')!;
    expect(chat.excerpt).not.toContain('\u0001');
    expect(chat.excerpt).toContain('dentist');
    expect(data.results.find((r) => r.kind === 'side-chat')!.excerpt).toContain('Friday');
  });

  it('rejects a too-short query', async () => {
    expect((await get('/search?q=d')).status).toBe(400);
  });
});

describe('MEM-5 memory explain', () => {
  it('explains provenance, confidence and the superseded-by chain', async () => {
    const oldId = memory.storeAtom(BOT, { fact: 'The user lives in Pune', entities: ['Pune'], confidence: 0.7 }, 'turn-old');
    const newId = memory.storeVerbatimQuote(BOT, {
      quote: 'I moved to Bengaluru last week',
      sourceText: 'I moved to Bengaluru last week and love it',
      sourceRef: 'msg-99', entities: ['Bengaluru'], confidence: 0.95,
      fact: 'The user lives in Bengaluru',
    })!;
    memory.createLink(BOT, newId, oldId, 'supersedes', 'system');

    const res = await get(`/memory/${BOT}/${oldId}/explain`);
    expect(res.status).toBe(200);
    const { explanation } = (await res.json()) as { explanation: Record<string, never> & {
      provenance: { sourceTurn: string };
      confidence: { value: number; label: string };
      supersededByChain: Array<{ id: string; fact: string }>;
      supersedesChain: unknown[];
    } };
    expect(explanation.provenance.sourceTurn).toBe('turn-old');
    expect(explanation.confidence).toEqual({ value: 0.7, label: 'medium' });
    expect(explanation.supersededByChain.map((a) => a.id)).toEqual([newId]);

    const res2 = await get(`/memory/${BOT}/${newId}/explain`);
    const exp2 = ((await res2.json()) as { explanation: { provenance: { quote: string; quoteSource: string; grounding: string }; supersedesChain: Array<{ id: string }> } }).explanation;
    expect(exp2.provenance.quote).toBe('I moved to Bengaluru last week');
    expect(exp2.provenance.quoteSource).toBe('msg-99');
    expect(exp2.provenance.grounding).toBe('verbatim-quote');
    expect(exp2.supersedesChain.map((a) => a.id)).toEqual([oldId]);
  });

  it('404s for an unknown atom', async () => {
    expect((await get(`/memory/${BOT}/nope/explain`)).status).toBe(404);
  });
});

describe('MEM-6 paste import', () => {
  it('parses bullets, confidence markers and plain lines; the prompt endpoint returns the guided prompt', async () => {
    expect(parseMemoryMarkdown('- Likes tea\n1. Lives in Pune (confidence: 0.6)\n# Heading\nPlain fact line here')).toEqual([
      { fact: 'Likes tea', confidence: 0.8 },
      { fact: 'Lives in Pune', confidence: 0.6 },
      { fact: 'Plain fact line here', confidence: 0.8 },
    ]);
    const promptRes = await get('/memory-import/prompt');
    const { prompt } = (await promptRes.json()) as { prompt: string };
    expect(prompt).toContain('markdown bullet list');

    const res = await send('POST', '/memory-import/paste', {
      botId: BOT,
      markdown: '- The user prefers tea over coffee\n- The user works on KriyaDot (confidence: 0.9)',
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as { parsed: number; storedAtomIds: string[] };
    expect(data.parsed).toBe(2);
    expect(data.storedAtomIds).toHaveLength(2);
    expect(memory.searchAtoms(BOT, 'tea').length).toBeGreaterThan(0);
    expect(audits.some((a) => a.action === 'memory.paste_import')).toBe(true);
  });
});

describe('MEM-7 ZIP chat-export intake', () => {
  it('parses ChatGPT and Claude export shapes', () => {
    const chatgpt = JSON.stringify([{
      title: 'Trip planning',
      mapping: {
        a: { message: { author: { role: 'user' }, content: { parts: ['Plan my Kyoto trip in April'] } } },
        b: { message: { author: { role: 'assistant' }, content: { parts: ['Here is an itinerary…'] } } },
      },
    }]);
    const convs = parseChatExportFile('conversations.json', chatgpt);
    expect(convs).toHaveLength(1);
    expect(convs[0]).toMatchObject({ format: 'chatgpt', title: 'Trip planning' });
    expect(convs[0]!.turns).toHaveLength(2);

    const claude = JSON.stringify([{ name: 'Work chat', chat_messages: [{ sender: 'human', text: 'Draft the launch email' }, { sender: 'assistant', text: 'Sure…' }] }]);
    expect(parseChatExportFile('conversations.json', claude)[0]).toMatchObject({ format: 'claude', title: 'Work chat' });
  });

  it('imports a ZIP via the file-intake path and summarises with the injected mock summariser', async () => {
    const zip = zipSync({
      'conversations.json': strToU8(JSON.stringify([{
        title: 'Kyoto trip',
        mapping: {
          a: { message: { author: { role: 'user' }, content: { parts: ['Plan my Kyoto trip in April, I love temples'] } } },
          b: { message: { author: { role: 'assistant' }, content: { parts: ['Itinerary…'] } } },
        },
      }])),
      'notes.txt': strToU8('User: I prefer window seats on flights\nAssistant: Noted'),
    });
    const res = await send('POST', '/memory-import/zip', { botId: BOT, data: Buffer.from(zip).toString('base64') });
    expect(res.status).toBe(201);
    const data = (await res.json()) as { conversations: number; storedAtomIds: string[]; summaries: Array<{ kind: string }> };
    expect(data.conversations).toBe(2);
    expect(data.storedAtomIds).toHaveLength(2);
    expect(data.summaries.every((s) => s.kind === 'generated')).toBe(true);
    expect(summarizer).toHaveBeenCalledTimes(2);
    expect(memory.getAtoms(BOT).some((a) => a.sourceTurn.startsWith('zip-import:'))).toBe(true);
  });

  it('falls back to a labeled extractive summary when no summariser is injected', async () => {
    const convs = parseChatExportFile('chat.txt', 'User: I am training for a marathon in December this year\nAssistant: Great');
    expect(convs[0]!.turns[0]!.text).toContain('marathon');
    const summary = extractiveConversationSummary(convs[0]!);
    expect(summary).toContain('Extractive summary');
    expect(summary).toContain('not model-generated');
    expect(summary).toContain('marathon');
  });

  it('rejects a non-zip payload', async () => {
    const res = await send('POST', '/memory-import/zip', { botId: BOT, data: Buffer.from('not a zip').toString('base64') });
    expect(res.status).toBe(400);
  });
});

describe('MEM-9 people pages', () => {
  it('builds closeness-ordered pages with facts + history, and keeps manual notes across refreshes', async () => {
    memory.storeAtom(BOT, { fact: 'Asha Rao is the user\'s sister', entities: ['Asha Rao'], confidence: 0.95 }, 't1');
    memory.storeAtom(BOT, { fact: 'Asha Rao lives in Pune', entities: ['Asha Rao'], confidence: 0.9 }, 't2');
    memory.storeAtom(BOT, { fact: 'The Design Team meets on Fridays', entities: ['Design Team'], confidence: 0.8 }, 't3');

    const refresh = await send('POST', '/people-pages/refresh', { botId: BOT });
    expect(refresh.status).toBe(200);
    const list = (await (await get('/people-pages')).json()) as { pages: Array<{ name: string; kind: string; closeness: number; facts: unknown[]; history: unknown[] }> };
    expect(list.pages.map((p) => p.name)).toEqual(['Asha Rao', 'Design Team']);
    expect(list.pages[0]).toMatchObject({ kind: 'person' });
    expect(list.pages[0]!.facts).toHaveLength(2);
    expect(list.pages[0]!.history).toHaveLength(2);
    expect(list.pages[1]).toMatchObject({ kind: 'group' });

    await send('POST', '/people-pages/Asha%20Rao/note', { text: 'Called on her birthday' });
    await send('POST', '/people-pages/refresh', { botId: BOT });
    const page = (await (await get('/people-pages/Asha%20Rao')).json()) as { page: { history: Array<{ kind: string; text: string }> } };
    expect(page.page.history.some((h) => h.kind === 'note' && h.text === 'Called on her birthday')).toBe(true);
    expect((await get('/people-pages/Nobody')).status).toBe(404);
  });
});

describe('Goal finishes over HTTP (G-2/G-3/G-5/G-6/G-7/G-8/G-10)', () => {
  it('runs the full goal lifecycle: edit, subgoal, workspace, briefing, tracked items, cascade delete', async () => {
    const g = goals.create({ title: 'HTTP Goal', description: 'via routes' });

    const edited = await send('PATCH', `/goals/${g.id}`, { title: 'HTTP Goal v2' });
    expect(edited.status).toBe(200);
    expect(((await edited.json()) as { goal: { title: string } }).goal.title).toBe('HTTP Goal v2');

    goals.updateProgress(g.id, 25, 'quarter');
    const entry = goals.history(g.id).at(-1)!;
    const fixed = await send('PATCH', `/goals/${g.id}/history/${entry.id}`, { note: 'quarter (corrected)' });
    expect(fixed.status).toBe(200);
    const deletedEntry = await send('DELETE', `/goals/${g.id}/history/${entry.id}`);
    expect(deletedEntry.status).toBe(200);
    expect(goals.get(g.id).progress).toBe(0);

    const sub = await send('POST', `/goals/${g.id}/subgoals`, { title: 'Sub one' });
    expect(sub.status).toBe(201);
    const tree = (await (await get('/goals/tree')).json()) as { goals: Array<{ subgoals: unknown[] }> };
    expect(tree.goals[0]!.subgoals).toHaveLength(1);

    expect((await send('POST', `/goals/${g.id}/files`, { path: 'plan.md', label: 'Plan' })).status).toBe(201);
    expect((await send('POST', `/goals/${g.id}/jobs`, { jobId: 'job-1', cron: '0 9 * * 1' })).status).toBe(201);
    const ws = (await (await get(`/goals/${g.id}/workspace`)).json()) as { workspace: { files: unknown[]; jobs: unknown[] } };
    expect(ws.workspace.files).toHaveLength(1);
    expect(ws.workspace.jobs).toHaveLength(1);

    expect((await send('POST', `/goals/${g.id}/briefings/schedule`, { cron: '0 7 * * *' })).status).toBe(201);
    const letter = await send('POST', `/goals/${g.id}/briefings`, {});
    expect(letter.status).toBe(201);
    expect(((await letter.json()) as { briefing: { letterMd: string } }).briefing.letterMd).toContain('HTTP Goal v2');
    const due = await send('POST', '/goals/briefings/generate-due');
    expect(((await due.json()) as { briefings: unknown[] }).briefings).toHaveLength(1);

    new ReminderStore(mdb).create({ title: 'Route reminder', when: Date.now() + 1000, channel: 'push' });
    new CommitmentStore(mdb).create({ title: 'Route commitment', goalId: g.id });
    const tracked = (await (await get('/tracked-items')).json()) as { items: Array<{ kind: string }>; summary: { total: number } };
    expect(tracked.summary.total).toBe(3); // reminder + commitment + task (beforeEach)
    expect(tracked.items.map((i) => i.kind).sort()).toEqual(['commitment', 'reminder', 'task']);
    const onlyGoal = (await (await get(`/tracked-items?goalId=${g.id}`)).json()) as { items: Array<{ title: string }> };
    expect(onlyGoal.items.map((i) => i.title)).toEqual(['Route commitment']);

    const preview = (await (await get(`/goals/${g.id}/delete-preview`)).json()) as { preview: { subgoals: number } };
    expect(preview.preview.subgoals).toBe(1);
    const refused = await send('DELETE', `/goals/${g.id}`, { confirmTitle: 'nope' });
    expect(refused.status).toBe(400);
    const gone = await send('DELETE', `/goals/${g.id}`, { confirmTitle: 'HTTP Goal v2' });
    expect(gone.status).toBe(200);
    expect(() => goals.get(g.id)).toThrow();
    expect(audits.some((a) => a.action === 'goals.delete_cascade')).toBe(true);
  });
});
