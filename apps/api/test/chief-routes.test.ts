// SPDX-License-Identifier: Apache-2.0
// Tests for the chief-of-staff routes (chief-routes.ts): chief set/unset
// with demotion, sections validation, proposal approve (create applies a
// new bot to the roster) / reject (roster unchanged), one-chief
// enforcement on approve, incident listing + resolution.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChiefTeamsStore } from '../src/chief-teams.js';
import { createChiefRouter } from '../src/chief-routes.js';
import type { BotConfig } from '@mvp/agent-runtime';

function bot(id: string, extra: Partial<BotConfig> = {}): BotConfig {
  return {
    id,
    name: `Bot ${id}`,
    description: 'd',
    systemPrompt: 'p',
    provider: 'groq',
    model: 'm',
    skills: [],
    tools: [],
    mcpServers: [],
    ...extra,
  };
}

let dir: string;
let baseUrl: string;
let server: { close(cb: () => void): void } | null = null;
let bots: BotConfig[];
let store: ChiefTeamsStore;
let audits: Array<{ action: string; fields: unknown }>;

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = (await res.json()) as { ok: boolean; error?: string; [k: string]: unknown };
  return { status: res.status, body };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'chief-routes-'));
  audits = [];
  bots = [bot('helper'), bot('coder')];
  store = new ChiefTeamsStore(dir);
  const app = express();
  app.use(express.json());
  app.use(
    '/api/teams',
    createChiefRouter({
      dataDir: dir,
      getBots: () => bots,
      store,
      retryDelegation: async (threadId) => ({ incidentId: `cin_${threadId}`, attempts: 1 }),
      audit: (action, fields) => {
        audits.push({ action, fields });
      },
    }),
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve()) as unknown as { close(cb: () => void): void };
  });
  const addr = (server as unknown as { address(): AddressInfo }).address();
  baseUrl = `http://127.0.0.1:${addr.port}/api/teams`;
});

afterEach(async () => {
  store.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = null;
  rmSync(dir, { recursive: true, force: true });
});

function seedProposal(kind = 'team-setup', operations: unknown[] = [{ action: 'update', botId: 'coder', fields: { description: 'new' } }]) {
  return store.createProposal({
    kind: kind as 'team-setup',
    createdByBotId: 'helper',
    reason: 'test',
    operations: operations as never,
  });
}

describe('chief assignment', () => {
  it('GET /chief starts empty', async () => {
    const { status, body } = await api('/chief');
    expect(status).toBe(200);
    expect(body.chiefBotId).toBeNull();
  });

  it('PUT /chief sets the chief and demotes the old one', async () => {
    let r = await api('/chief', { method: 'PUT', body: JSON.stringify({ botId: 'helper' }) });
    expect(r.status).toBe(200);
    expect(r.body.chiefBotId).toBe('helper');
    expect(bots[0].chiefOfStaff).toBe(true);
    expect(bots[0].tools).toContain('coordinate_bots');

    r = await api('/chief', { method: 'PUT', body: JSON.stringify({ botId: 'coder' }) });
    expect(r.status).toBe(200);
    expect(bots[0].chiefOfStaff).toBe(false);
    expect(bots[0].tools).not.toContain('coordinate_bots');
    expect(bots[1].chiefOfStaff).toBe(true);
    expect(audits.some((a) => a.action === 'chief.removed')).toBe(true);
    expect(audits.some((a) => a.action === 'chief.assigned')).toBe(true);
  });

  it('PUT /chief null removes the chief', async () => {
    await api('/chief', { method: 'PUT', body: JSON.stringify({ botId: 'helper' }) });
    const r = await api('/chief', { method: 'PUT', body: JSON.stringify({ botId: null }) });
    expect(r.status).toBe(200);
    expect(r.body.chiefBotId).toBeNull();
    expect(bots[0].chiefOfStaff).toBe(false);
  });

  it('rejects unknown bots and bad ids', async () => {
    const r1 = await api('/chief', { method: 'PUT', body: JSON.stringify({ botId: 'ghost' }) });
    expect(r1.status).toBe(404);
    const r2 = await api('/chief', { method: 'PUT', body: JSON.stringify({ botId: 'bad id!' }) });
    expect(r2.status).toBe(400);
  });
});

describe('sections', () => {
  it('PUT /sections validates length limits', async () => {
    const ok = await api('/sections', { method: 'PUT', body: JSON.stringify({ sections: ['support', 'sales'] }) });
    expect(ok.status).toBe(200);
    expect(ok.body.sections).toEqual(['support', 'sales']);

    const tooMany = await api('/sections', {
      method: 'PUT',
      body: JSON.stringify({ sections: Array.from({ length: 9 }, (_, i) => `s${i}`) }),
    });
    expect(tooMany.status).toBe(400);

    const tooLong = await api('/sections', {
      method: 'PUT',
      body: JSON.stringify({ sections: ['x'.repeat(61)] }),
    });
    expect(tooLong.status).toBe(400);
  });
});

describe('proposals', () => {
  it('approve applies a create: the bot appears in getBots', async () => {
    const p = seedProposal('team-setup', [
      { action: 'create', key: 'writer', fields: { name: 'Writer', description: 'writes', systemPrompt: 'you write' } },
    ]);
    const r = await api(`/proposals/${p.id}/approve`, { method: 'POST' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const created = bots.find((b) => b.id === 'writer');
    expect(created).toBeDefined();
    expect(created?.provider).toBe('groq');
    expect((r.body.proposal as { status: string }).status).toBe('approved');
  });

  it('approve applies an update: fields change on the in-memory bot', async () => {
    const p = seedProposal();
    const r = await api(`/proposals/${p.id}/approve`, { method: 'POST' });
    expect(r.status).toBe(200);
    expect(bots.find((b) => b.id === 'coder')?.description).toBe('new');
  });

  it('reject leaves the roster unchanged', async () => {
    const p = seedProposal('team-setup', [
      { action: 'create', key: 'writer', fields: { name: 'Writer', description: 'w', systemPrompt: 'p' } },
    ]);
    const r = await api(`/proposals/${p.id}/reject`, {
      method: 'POST',
      body: JSON.stringify({ note: 'not now' }),
    });
    expect(r.status).toBe(200);
    expect(bots.some((b) => b.id === 'writer')).toBe(false);
    expect((r.body.proposal as { status: string }).status).toBe('rejected');
  });

  it('enforces one chief on approve', async () => {
    await api('/chief', { method: 'PUT', body: JSON.stringify({ botId: 'helper' }) });
    const p = seedProposal('team-setup', [
      { action: 'create', key: 'chief2', fields: { name: 'Chief 2', systemPrompt: 'p', chiefOfStaff: true } },
    ]);
    const r = await api(`/proposals/${p.id}/approve`, { method: 'POST' });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toContain('one chief');
  });

  it('refuses to approve a delete of the chief', async () => {
    await api('/chief', { method: 'PUT', body: JSON.stringify({ botId: 'helper' }) });
    const p = seedProposal('delete-bot', [{ action: 'delete', botId: 'helper' }]);
    const r = await api(`/proposals/${p.id}/approve`, { method: 'POST' });
    expect(r.status).toBe(400);
    expect(bots.some((b) => b.id === 'helper')).toBe(true);
  });

  it('approve applies a delete: seed bots are recorded in deleted_bot_ids', async () => {
    const p = seedProposal('delete-bot', [{ action: 'delete', botId: 'coder' }]);
    const r = await api(`/proposals/${p.id}/approve`, { method: 'POST' });
    expect(r.status).toBe(200);
    expect(bots.some((b) => b.id === 'coder')).toBe(false);
    expect(store.getDeletedBotIds()).toContain('coder');
  });

  it('rejects double-approve and unknown proposals', async () => {
    const p = seedProposal();
    await api(`/proposals/${p.id}/approve`, { method: 'POST' });
    const r = await api(`/proposals/${p.id}/approve`, { method: 'POST' });
    expect(r.status).toBe(400);
    const missing = await api('/proposals/cpr_nope/approve', { method: 'POST' });
    expect(missing.status).toBe(404);
  });
});

describe('incidents', () => {
  it('lists and resolves incidents', async () => {
    store.reportIncident({ kind: 'incident', chiefBotId: 'helper', summary: 'failed delegation', attempts: 3 });
    store.reportIncident({ kind: 'escalation', chiefBotId: 'helper', summary: 'needs approval' });

    let r = await api('/incidents?kind=incident');
    expect(r.status).toBe(200);
    expect((r.body.incidents as unknown[])).toHaveLength(1);

    const incident = (r.body.incidents as { id: string }[])[0];
    r = await api(`/incidents/${incident.id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ note: 'fixed' }),
    });
    expect(r.status).toBe(200);
    expect((r.body.incident as { status: string }).status).toBe('resolved');

    r = await api('/incidents?status=open');
    expect((r.body.incidents as unknown[])).toHaveLength(1); // the escalation
  });

  it('validates status/kind filters', async () => {
    const r = await api('/incidents?status=bogus');
    expect(r.status).toBe(400);
  });

  it('404s on unknown incident resolve', async () => {
    const r = await api('/incidents/cin_nope/resolve', { method: 'POST' });
    expect(r.status).toBe(404);
  });

  it('retries an incident through the retry_delegation path', async () => {
    const inc = store.reportIncident({
      kind: 'incident',
      chiefBotId: 'helper',
      summary: 'failed delegation',
      threadId: 't42',
      detail: JSON.stringify({ brief: 'do x' }),
      attempts: 2,
    });
    const r = await api(`/incidents/${inc.id}/retry`, { method: 'POST' });
    expect(r.status).toBe(200);
    expect((r.body as { attempts: number }).attempts).toBe(1);
    expect(audits.some((a) => a.action === 'chief.incident.retry')).toBe(true);
  });

  it('rejects retry when the incident has no thread id', async () => {
    const inc = store.reportIncident({ kind: 'incident', chiefBotId: 'helper', summary: 'x' });
    const r = await api(`/incidents/${inc.id}/retry`, { method: 'POST' });
    expect(r.status).toBe(400);
  });
});
