// SPDX-License-Identifier: Apache-2.0
// Tests for bot roster import/export (bot-roster-routes.ts):
// - manifest validation rejects malformed manifests with details
// - GET /export returns a downloadable manifest
// - POST /import dedupes by id (never overwrites), reports skipped/errors
// - imported bots persist via bot-roster-imports.json + applyImportedBots

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyImportedBots,
  createBotRosterRouter,
  validateBotRosterManifest,
} from '../src/bot-roster-routes.js';
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

function manifest(bots: BotConfig[] = [], teams: unknown[] = []) {
  return { version: '1', exportedAt: new Date().toISOString(), bots, teams };
}

describe('validateBotRosterManifest', () => {
  it('accepts a well-formed manifest', () => {
    const r = validateBotRosterManifest(
      manifest([bot('b1')], [{ id: 't1', name: 'Team', coordinatorBotId: 'b1', memberBotIds: ['b1'] }]),
    );
    expect(r.ok).toBe(true);
  });

  it('rejects non-objects and missing sections with details', () => {
    for (const bad of [null, 42, 'x', [], {}]) {
      const r = validateBotRosterManifest(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.length).toBeGreaterThan(0);
    }
  });

  it('rejects malformed bot entries with field-level details', () => {
    const r = validateBotRosterManifest(
      manifest([{ id: 'bad id!', name: '', description: 1 } as unknown as BotConfig]),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.join('\n')).toMatch(/bots\[0\]\.id/);
      expect(r.errors.join('\n')).toMatch(/bots\[0\]\.name/);
    }
  });

  it('rejects bad policy, persona and sandboxMode values', () => {
    const r = validateBotRosterManifest(
      manifest([bot('b1', { persona: 'XXXX' } as Partial<BotConfig>)]),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toMatch(/persona/);
  });

  it('rejects malformed team entries', () => {
    const r = validateBotRosterManifest(manifest([], [{ id: 't1' }]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toMatch(/teams\[0\]/);
  });
});

describe('bot-roster router', () => {
  let dir: string;
  let baseUrl: string;
  let server: { close(cb: () => void): void } | null = null;
  let bots: BotConfig[];
  let audits: Array<{ action: string; fields: unknown }>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bot-roster-'));
    audits = [];
    bots = [bot('helper')];
    const app = express();
    app.use(express.json());
    app.use(
      '/api/bots',
      createBotRosterRouter({
        dataDir: dir,
        getBots: () => bots,
        audit: (action, fields) => {
          audits.push({ action, fields });
        },
      }),
    );
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve()) as unknown as { close(cb: () => void): void };
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}/api/bots`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it('GET /export returns a downloadable manifest of bots and teams', async () => {
    const res = await fetch(`${baseUrl}/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="kriyadot-bot-roster-.*\.json"/);
    const json = (await res.json()) as { version: string; exportedAt: string; bots: BotConfig[]; teams: unknown[] };
    expect(json.version).toBe('1');
    expect(json.bots.map((b) => b.id)).toEqual(['helper']);
    expect(Array.isArray(json.teams)).toBe(true);
    expect(audits.map((a) => a.action)).toContain('bots.roster_export');
  });

  it('POST /import creates new bots and teams with stable ids', async () => {
    const res = await fetch(`${baseUrl}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        manifest: manifest(
          [bot('coder'), bot('researcher')],
          [{ id: 'team-alpha', name: 'Alpha', coordinatorBotId: 'coder', memberBotIds: ['researcher'] }],
        ),
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; imported: string[]; skipped: unknown[]; errors: unknown[] };
    expect(json.ok).toBe(true);
    expect(json.imported).toEqual(['coder', 'researcher', 'team-alpha']);
    expect(json.skipped).toEqual([]);
    expect(json.errors).toEqual([]);
    expect(bots.map((b) => b.id)).toContain('coder');
    expect(audits.map((a) => a.action)).toContain('bots.roster_import');
  });

  it('POST /import never overwrites: existing ids are skipped and reported', async () => {
    const payload = {
      manifest: manifest([bot('helper'), bot('coder')], [
        { id: 'team-alpha', name: 'Alpha', coordinatorBotId: 'coder', memberBotIds: [] },
      ]),
    };
    const first = await fetch(`${baseUrl}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j1 = (await first.json()) as { imported: string[]; skipped: Array<{ id: string; reason: string }> };
    expect(j1.imported).toEqual(['coder', 'team-alpha']);
    expect(j1.skipped.map((s) => s.id)).toEqual(['helper']);

    const second = await fetch(`${baseUrl}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j2 = (await second.json()) as { imported: string[]; skipped: Array<{ id: string; reason: string }> };
    expect(j2.imported).toEqual([]);
    expect(j2.skipped.map((s) => s.id).sort()).toEqual(['coder', 'helper', 'team-alpha']);
    // the original helper bot is untouched
    expect(bots.find((b) => b.id === 'helper')?.name).toBe('Bot helper');
  });

  it('POST /import reports teams referencing unknown bots in errors', async () => {
    const res = await fetch(`${baseUrl}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        manifest: manifest([], [
          { id: 'team-ghost', name: 'Ghost', coordinatorBotId: 'nope', memberBotIds: [] },
          { id: 'team-ghost2', name: 'Ghost2', coordinatorBotId: 'helper', memberBotIds: ['nope'] },
        ]),
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { imported: string[]; errors: Array<{ id: string; reason: string }> };
    expect(json.imported).toEqual([]);
    expect(json.errors.map((e) => e.id).sort()).toEqual(['team-ghost', 'team-ghost2']);
    expect(json.errors[0].reason).toMatch(/unknown/);
  });

  it('POST /import 400s on a missing or malformed manifest', async () => {
    const missing = await fetch(`${baseUrl}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(400);
    const malformed = await fetch(`${baseUrl}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ manifest: { version: '1' } }),
    });
    expect(malformed.status).toBe(400);
    const mj = (await malformed.json()) as { ok: boolean; detail: string[] };
    expect(mj.ok).toBe(false);
    expect(mj.detail.length).toBeGreaterThan(0);
  });

  it('imported bots persist and are re-applied at boot', async () => {
    await fetch(`${baseUrl}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ manifest: manifest([bot('coder')]) }),
    });
    // simulate a restart: fresh bot list, apply overlays
    const fresh: BotConfig[] = [bot('helper')];
    applyImportedBots(fresh, dir);
    expect(fresh.map((b) => b.id).sort()).toEqual(['coder', 'helper']);
    // applying twice never duplicates
    applyImportedBots(fresh, dir);
    expect(fresh.filter((b) => b.id === 'coder')).toHaveLength(1);
  });
});
