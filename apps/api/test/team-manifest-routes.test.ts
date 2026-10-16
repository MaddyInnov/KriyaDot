// SPDX-License-Identifier: Apache-2.0
// Tests for the team-sharing manifest routes (POST /export, POST /import
// in teams-routes.ts): manifest shape + checksum, tamper rejection,
// name-collision dedupe with confirm, and embedded-bot import.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildTeamManifest,
  computeTeamManifestChecksum,
  validateTeamManifest,
  type AgentRuntime,
  type BotConfig,
  type TeamManifest,
} from '@mvp/agent-runtime';
import { registerTeamRoutes } from '../src/teams-routes.js';

/** Rename an exported manifest and recompute its checksum (simulates hand-editing). */
function buildRenamed(m: TeamManifest, name: string): TeamManifest {
  const renamed = JSON.parse(JSON.stringify(m)) as TeamManifest;
  renamed.team.name = name;
  const { checksum: _drop, ...unsigned } = renamed;
  return { ...unsigned, checksum: computeTeamManifestChecksum(unsigned) };
}

function bot(id: string, name?: string): BotConfig {
  return {
    id,
    name: name ?? `Bot ${id}`,
    description: `${id} description`,
    systemPrompt: 'You are helpful.',
    provider: 'groq',
    model: 'llama-3.3-70b',
    skills: [],
    tools: ['web_search'],
    mcpServers: [],
  } as BotConfig;
}

describe('team manifest routes', () => {
  let dir: string;
  let baseUrl: string;
  let server: { close(cb: () => void): void } | null = null;
  let bots: BotConfig[];
  let audits: Array<{ action: string; fields: unknown }>;
  let teamId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'team-manifest-'));
    audits = [];
    bots = [bot('scout'), bot('coder'), bot('writer')];

    const app = express();
    app.use(express.json());
    const teamsRouter = express.Router();
    const store = registerTeamRoutes(teamsRouter, {
      dataDir: dir,
      agentRuntime: {} as AgentRuntime,
      getBots: () => bots,
      audit: (action, fields) => {
        audits.push({ action, fields });
      },
    });
    app.use('/api/teams', teamsRouter);

    // Seed one team through the public create endpoint.
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve()) as unknown as {
        close(cb: () => void): void;
      };
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}/api/teams`;

    const created = await post('', {
      name: 'Research Squad',
      coordinatorBotId: 'scout',
      memberBotIds: ['coder', 'writer'],
    });
    teamId = (created.json as { team: { id: string } }).team.id;
    expect(store.getTeam(teamId)?.name).toBe('Research Squad');
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    rmSync(dir, { recursive: true, force: true });
  });

  async function post(path: string, body: unknown) {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const headers = res.headers;
    let json: unknown = null;
    const text = await res.text();
    try {
      json = JSON.parse(text);
    } catch {
      // non-JSON (shouldn't happen here)
    }
    return { status: res.status, json, contentDisposition: headers.get('content-disposition') };
  }

  it('exports a downloadable, checksum-valid manifest', async () => {
    const { status, json, contentDisposition } = await post('/export', { teamId });
    expect(status).toBe(200);
    expect(contentDisposition).toMatch(/attachment; filename="kriyadot\.team\..*\.json"/);
    const v = validateTeamManifest(json);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.manifest.team.name).toBe('Research Squad');
      expect(v.manifest.team.coordinator.id).toBe('scout');
      expect(v.manifest.team.members.map((m) => m.id)).toEqual(['coder', 'writer']);
      expect(v.manifest.team.rosterPrompt).toContain('{{task}}');
    }
    expect(audits.some((a) => a.action === 'teams.manifest_export')).toBe(true);
  });

  it('export 404s for an unknown team and 400s without a teamId', async () => {
    expect((await post('/export', { teamId: 'nope' })).status).toBe(404);
    expect((await post('/export', {})).status).toBe(400);
  });

  it('import round-trips: validates, creates the team, restores rules', async () => {
    const exported = (await post('/export', { teamId })).json as TeamManifest;
    // Import into a fresh state: drop all bots + teams from this dataDir.
    const dir2 = mkdtempSync(join(tmpdir(), 'team-manifest-import-'));
    const bots2: BotConfig[] = [];
    const app = express();
    app.use(express.json());
    const r2 = express.Router();
    registerTeamRoutes(r2, {
      dataDir: dir2,
      agentRuntime: {} as AgentRuntime,
      getBots: () => bots2,
      audit: () => undefined,
    });
    app.use('/api/teams', r2);
    const srv = await new Promise<{ close(cb: () => void): void; port: number }>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => {
        resolve({ close: (cb) => s.close(cb), port: (s.address() as AddressInfo).port });
      });
    });
    try {
      const res = await fetch(`http://127.0.0.1:${srv.port}/api/teams/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ manifest: exported }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        ok: boolean;
        team: { id: string; name: string };
        importedBots: string[];
      };
      expect(body.ok).toBe(true);
      expect(body.team.name).toBe('Research Squad');
      // The embedded bots were imported so the team is self-contained.
      expect(body.importedBots.sort()).toEqual(['coder', 'scout', 'writer']);
      expect(bots2.map((b) => b.id).sort()).toEqual(['coder', 'scout', 'writer']);
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it('import rejects a tampered manifest (checksum mismatch)', async () => {
    const exported = (await post('/export', { teamId })).json as TeamManifest;
    const tampered = JSON.parse(JSON.stringify(exported)) as TeamManifest;
    tampered.team.name = 'Tampered Squad';
    const { status, json } = await post('/import', { manifest: tampered });
    expect(status).toBe(400);
    expect(JSON.stringify(json)).toMatch(/checksum/i);
  });

  it('import dedupes by name: 409 on collision, 201 with confirm', async () => {
    const exported = (await post('/export', { teamId })).json as TeamManifest;
    // Delete the original team but keep the name taken via a fresh create.
    const del = await fetch(`${baseUrl}/${teamId}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    const recreated = await post('', {
      name: 'Research Squad',
      coordinatorBotId: 'scout',
      memberBotIds: ['coder'],
    });
    expect(recreated.status).toBe(200);

    const first = await post('/import', { manifest: exported });
    expect(first.status).toBe(409);
    expect((first.json as { conflict: { name: string } }).conflict.name).toBe('Research Squad');

    const confirmed = await post('/import', { manifest: exported, confirm: true });
    expect(confirmed.status).toBe(201);
    const body = confirmed.json as { team: { id: string; name: string } };
    expect(body.team.name).toBe('Research Squad');
    expect(body.team.id).not.toBe((recreated.json as { team: { id: string } }).team.id);
  });

  it('import accepts the raw manifest as the body (and still checks the checksum)', async () => {
    const exported = (await post('/export', { teamId })).json as TeamManifest;
    const renamed = buildRenamed(exported, 'Raw Body Squad');
    const { status } = await post('/import', renamed);
    expect(status).toBe(201);

    // Tampering the name through the raw body breaks the checksum → 400.
    const tampered = JSON.parse(JSON.stringify(exported)) as TeamManifest;
    tampered.team.name = 'Sneaky Squad';
    expect((await post('/import', tampered)).status).toBe(400);
  });

  it('buildTeamManifest is the export source of truth', () => {
    const m = buildTeamManifest({
      team: {
        id: 't',
        name: 'X',
        coordinatorBotId: 'scout',
        memberBotIds: ['coder'],
        createdAt: 1,
      },
      coordinator: bot('scout'),
      members: [bot('coder')],
    });
    expect(validateTeamManifest(m).ok).toBe(true);
  });
});
