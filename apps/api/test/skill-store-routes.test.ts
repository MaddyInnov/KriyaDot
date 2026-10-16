// SPDX-License-Identifier: Apache-2.0
// User skill lifecycle HTTP routes (OpenMausBot parity P1 #20): CRUD,
// enable/disable (disabled-by-default), proposal approve/confirm/discard,
// review-queue reconciliation against approval cards, per-bot attach/detach,
// and audit entries. Real HTTP against a real UserSkillStore; zero paid API
// usage.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UserSkillStore } from '@mvp/agent-runtime';
import type { BotConfig } from '@mvp/agent-runtime';
import { createSkillStoreRouter } from '../src/skill-store-routes.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'skill-routes-test-'));
}

let store: UserSkillStore;
let dataDir: string;
const audits: Array<{ action: string; fields: unknown }> = [];
const approvals = new Map<string, 'pending' | 'approved' | 'denied' | 'expired'>();
const decided: Array<{ id: string; decision: string }> = [];
const bots: BotConfig[] = [
  {
    id: 'bot-a',
    name: 'Bot A',
    description: 'd',
    systemPrompt: 'p',
    provider: 'groq',
    model: 'm',
    skills: [],
    tools: [],
    mcpServers: [],
  },
];
const botSkillsOverlay: Record<string, string[]> = {};

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/skills',
    createSkillStoreRouter({
      store,
      audit: (action, fields) => void audits.push({ action, fields }),
      getApprovalStatus: (id) => approvals.get(id),
      decideApproval: (id, decision) => void decided.push({ id, decision }),
      getBot: (id) => bots.find((b) => b.id === id),
      getBotSkills: (id) => botSkillsOverlay[id] ?? bots.find((b) => b.id === id)?.skills ?? [],
      setBotSkills: (id, skills) => {
        botSkillsOverlay[id] = [...skills];
        const b = bots.find((x) => x.id === id);
        if (b) b.skills = [...skills];
        return [...skills];
      },
      seedSkillNames: () => ['web-research'],
    }),
  );
  return app;
}

let server: { close(cb: () => void): void } | undefined;
let baseUrl = '';

beforeEach(async () => {
  audits.length = 0;
  approvals.clear();
  decided.length = 0;
  for (const k of Object.keys(botSkillsOverlay)) delete botSkillsOverlay[k];
  bots[0].skills = [];
  dataDir = tempDir();
  // Fake seed dir containing web-research so shadow-rejection is exercised.
  const seedDir = join(dataDir, 'seed-skills');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(join(seedDir, 'web-research'), { recursive: true });
  writeFileSync(join(seedDir, 'web-research', 'SKILL.md'), '---\nname: web-research\ndescription: seed\n---\nbody\n');
  store = new UserSkillStore(dataDir, join(dataDir, 'skills'), { seedSkillsDir: seedDir });
  const app = makeApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve()) as unknown as { close(cb: () => void): void };
  });
  const port = (server as unknown as { address(): { port: number } }).address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  store.close();
});

async function api(path: string, init?: RequestInit) {
  const res = await fetch(baseUrl + path, init);
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

const post = (path: string, data?: unknown) =>
  api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });

describe('skill CRUD', () => {
  it('creates a skill DISABLED and lists it', async () => {
    const created = await post('/api/skills', {
      name: 'route-made',
      description: 'made via route',
      instructions: 'do the thing',
    });
    expect(created.status).toBe(201);
    expect((created.body.skill as { status: string }).status).toBe('disabled');
    const list = await api('/api/skills');
    const names = ((list.body.skills as Array<{ name: string }>) ?? []).map((s) => s.name);
    expect(names).toContain('route-made');
    expect(list.body.seedSkills).toContain('web-research');
    expect(audits.map((a) => a.action)).toContain('skill.created');
  });

  it('rejects invalid names and duplicates', async () => {
    const bad = await post('/api/skills', { name: 'Bad Name!', description: 'd', instructions: 'i' });
    expect(bad.status).toBe(400);
    await post('/api/skills', { name: 'dup-one', description: 'd', instructions: 'i' });
    const dup = await post('/api/skills', { name: 'dup-one', description: 'd', instructions: 'i' });
    expect(dup.status).toBe(409);
  });

  it('rejects shadowing a seed skill', async () => {
    const res = await post('/api/skills', { name: 'web-research', description: 'd', instructions: 'i' });
    expect(res.status).toBe(409);
  });

  it('updates description and scope', async () => {
    await post('/api/skills', { name: 'upd-one', description: 'd', instructions: 'i' });
    const res = await api('/api/skills/upd-one', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'new desc', scope: ['bot-a'] }),
    });
    expect(res.status).toBe(200);
    expect((res.body.skill as { description: string }).description).toBe('new desc');
    expect((res.body.skill as { scope: { type: string } }).scope.type).toBe('bots');
  });

  it('detail includes file content', async () => {
    await post('/api/skills', { name: 'det-one', description: 'd', instructions: 'secret-sauce' });
    const res = await api('/api/skills/det-one');
    expect(res.status).toBe(200);
    expect((res.body.skill as { content: string }).content).toContain('secret-sauce');
  });

  it('404s unknown skills', async () => {
    expect((await api('/api/skills/nope')).status).toBe(404);
  });
});

describe('enable / disable (disabled-by-default)', () => {
  it('enable moves disabled → active; disable moves back; audit each', async () => {
    await post('/api/skills', { name: 'tog-one', description: 'd', instructions: 'i' });
    const enabled = await post('/api/skills/tog-one/enable');
    expect(enabled.status).toBe(200);
    expect((enabled.body.skill as { status: string }).status).toBe('active');
    // Double-enable is a 400 (invalid transition).
    expect((await post('/api/skills/tog-one/enable')).status).toBe(400);
    const disabled = await post('/api/skills/tog-one/disable');
    expect((disabled.body.skill as { status: string }).status).toBe('disabled');
    const actions = audits.map((a) => a.action);
    expect(actions).toContain('skill.enabled');
    expect(actions).toContain('skill.disabled');
  });

  it('delete requires disabled first', async () => {
    await post('/api/skills', { name: 'del-one', description: 'd', instructions: 'i' });
    await post('/api/skills/del-one/enable');
    expect((await api('/api/skills/del-one', { method: 'DELETE' })).status).toBe(400);
    await post('/api/skills/del-one/disable');
    expect((await api('/api/skills/del-one', { method: 'DELETE' })).status).toBe(200);
    expect((await api('/api/skills/del-one')).status).toBe(404);
  });
});

describe('learning proposals', () => {
  it('approve materializes a disabled skill and resolves the approval card', async () => {
    // Seed a draft directly through the store (the learn_skill tool path is
    // covered in the runtime tests).
    store.createProposal({ name: 'prop-one', description: 'd', instructions: 'i', source: 'learned' });
    store.attachApproval('prop-one', 'appr-9');
    const res = await post('/api/skills/proposals/prop-one/approve');
    expect(res.status).toBe(200);
    expect((res.body.skill as { status: string }).status).toBe('disabled');
    expect(decided).toContainEqual({ id: 'appr-9', decision: 'approved' });
    expect(audits.map((a) => a.action)).toContain('skill.proposal_approved');
  });

  it('confirm follows an approved approval card', async () => {
    store.createProposal({ name: 'prop-two', description: 'd', instructions: 'i', source: 'learned' });
    store.attachApproval('prop-two', 'appr-10');
    approvals.set('appr-10', 'approved');
    const res = await post('/api/skills/proposals/prop-two/confirm');
    expect(res.status).toBe(200);
    expect((res.body.skill as { status: string }).status).toBe('disabled');
  });

  it('confirm rejects on a denied card and 409s on pending', async () => {
    store.createProposal({ name: 'prop-den', description: 'd', instructions: 'i', source: 'learned' });
    store.attachApproval('prop-den', 'appr-11');
    approvals.set('appr-11', 'denied');
    expect((await post('/api/skills/proposals/prop-den/confirm')).status).toBe(403);
    expect(store.get('prop-den')!.status).toBe('rejected');

    store.createProposal({ name: 'prop-pen', description: 'd', instructions: 'i', source: 'learned' });
    store.attachApproval('prop-pen', 'appr-12');
    approvals.set('appr-12', 'pending');
    expect((await post('/api/skills/proposals/prop-pen/confirm')).status).toBe(409);
  });

  it('discard rejects the draft and denies the card', async () => {
    store.createProposal({ name: 'prop-dis', description: 'd', instructions: 'i', source: 'learned' });
    store.attachApproval('prop-dis', 'appr-13');
    const res = await post('/api/skills/proposals/prop-dis/discard');
    expect(res.status).toBe(200);
    expect((res.body.skill as { status: string }).status).toBe('rejected');
    expect(decided).toContainEqual({ id: 'appr-13', decision: 'denied' });
  });

  it('review queue reconciles approval cards on read', async () => {
    store.createProposal({ name: 'prop-rec', description: 'd', instructions: 'i', source: 'learned' });
    store.attachApproval('prop-rec', 'appr-14');
    approvals.set('appr-14', 'approved');
    const queue = await api('/api/skills/review/queue');
    expect(queue.status).toBe(200);
    const names = ((queue.body.proposals as Array<{ name: string }>) ?? []).map((p) => p.name);
    expect(names).not.toContain('prop-rec'); // auto-materialized
    expect(store.get('prop-rec')!.status).toBe('disabled');
    expect((queue.body.reconciled as { materialized: string[] }).materialized).toContain('prop-rec');
  });
});

describe('per-bot attach / detach', () => {
  it('attaches and detaches a skill on a bot', async () => {
    await post('/api/skills', { name: 'att-one', description: 'd', instructions: 'i' });
    const attached = await post('/api/skills/att-one/attach', { botId: 'bot-a' });
    expect(attached.status).toBe(200);
    expect((attached.body as { skills: string[] }).skills).toContain('att-one');
    expect(audits.map((a) => a.action)).toContain('skill.attached');
    const detached = await api('/api/skills/att-one/attach/bot-a', { method: 'DELETE' });
    expect((detached.body as { skills: string[] }).skills).not.toContain('att-one');
  });

  it('refuses to attach draft proposals and unknown bots', async () => {
    store.createProposal({ name: 'att-draft', description: 'd', instructions: 'i', source: 'learned' });
    expect((await post('/api/skills/att-draft/attach', { botId: 'bot-a' })).status).toBe(400);
    await post('/api/skills', { name: 'att-two', description: 'd', instructions: 'i' });
    expect((await post('/api/skills/att-two/attach', { botId: 'ghost' })).status).toBe(404);
  });
});
