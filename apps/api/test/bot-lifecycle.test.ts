// SPDX-License-Identifier: Apache-2.0
// Bot lifecycle: direct POST /bots create + DELETE /bots/:id in
// bot-roster-routes.ts — validation/defaults, duplicate 409, unknown 404,
// audit entries, imports-file persistence, chief guard.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyImportedBots, createBotRosterRouter } from '../src/bot-roster-routes.js';
import type { BotConfig } from '@mvp/agent-runtime';

function bot(id: string, extra: Partial<BotConfig> = {}): BotConfig {
  return {
    id, name: `Bot ${id}`, description: 'd', systemPrompt: 'p', provider: 'groq', model: 'm',
    skills: [], tools: [], mcpServers: [], ...extra,
  };
}

describe('bot lifecycle (direct create/delete)', () => {
  let dir: string;
  let bots: BotConfig[];
  let audits: Array<{ action: string; detail?: unknown }>;
  let deletedRecords: string[];
  let server: ReturnType<typeof express.application.listen> | undefined;
  let base: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bot-lifecycle-'));
    bots = [bot('seed-1')];
    audits = [];
    deletedRecords = [];
    const app = express();
    app.use(express.json());
    app.use('/api/bots', createBotRosterRouter({
      dataDir: dir,
      getBots: () => bots,
      audit: (action, fields) => audits.push({ action, detail: fields.detail }),
      recordDeletedBotId: (id) => deletedRecords.push(id),
    }));
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/bots`;
  });
  afterEach(() => server?.close());

  const post = (body: unknown) => fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('creates a bot with setup-style defaults and persists it', async () => {
    const res = await post({ id: 'new-bot', name: 'New Bot' });
    expect(res.status).toBe(201);
    const body = await res.json() as { ok: boolean; bot: BotConfig };
    expect(body.bot.provider).toBe('groq'); // inherited from seed bot
    expect(body.bot.model).toBe('m');
    expect(body.bot.skills).toEqual([]);
    expect(bots.map((b) => b.id)).toContain('new-bot');
    expect(audits.some((a) => a.action === 'bots.created')).toBe(true);
    // Persists via the roster imports file.
    const reloaded: BotConfig[] = [bot('seed-1')];
    applyImportedBots(reloaded, dir);
    expect(reloaded.map((b) => b.id)).toContain('new-bot');
  });

  it('rejects invalid configs with 400 and duplicates with 409', async () => {
    expect((await post({ id: 'bad id!', name: 'X' })).status).toBe(400);
    expect((await post({ id: 'seed-1', name: 'Dupe' })).status).toBe(409);
    expect(bots).toHaveLength(1);
  });

  it('deletes a created bot (imports file cleaned, audit logged)', async () => {
    await post({ id: 'temp-bot', name: 'Temp' });
    const res = await fetch(`${base}/temp-bot`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(bots.map((b) => b.id)).not.toContain('temp-bot');
    expect(audits.some((a) => a.action === 'bots.deleted')).toBe(true);
    const reloaded: BotConfig[] = [bot('seed-1')];
    applyImportedBots(reloaded, dir);
    expect(reloaded.map((b) => b.id)).not.toContain('temp-bot');
    expect(deletedRecords).toEqual([]); // imports-file bot: no seed deletion record needed
  });

  it('deleting a seed bot records the deletion for the host', async () => {
    const res = await fetch(`${base}/seed-1`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(deletedRecords).toEqual(['seed-1']);
  });

  it('DELETE of an unknown id is 404', async () => {
    const res = await fetch(`${base}/nope`, { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  it('refuses to delete the chief of staff', async () => {
    bots.push(bot('chief-1', { chiefOfStaff: true }));
    const res = await fetch(`${base}/chief-1`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect(bots.map((b) => b.id)).toContain('chief-1');
  });
});
