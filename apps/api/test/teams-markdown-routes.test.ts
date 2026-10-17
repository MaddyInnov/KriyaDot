// SPDX-License-Identifier: Apache-2.0
// Tests for the markdown team import/export routes (BotMRR parity):
// - POST /import-markdown { markdown } creates the team
// - GET /:id/export-markdown round-trips back to markdown
// - import rejects docs referencing unknown bots

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerTeamRoutes } from '../src/teams-routes.js';
import { SAMPLE_TEAM_MARKDOWN } from '@mvp/agent-runtime';
import type { AgentRuntime, BotConfig } from '@mvp/agent-runtime';

const bots = [
  { id: 'scout', name: 'Scout', description: 'research', systemPrompt: 's', provider: 'p', model: 'm', skills: [], tools: [], mcpServers: [] },
  { id: 'writer', name: 'Writer', description: 'writes', systemPrompt: 's', provider: 'p', model: 'm', skills: [], tools: [], mcpServers: [] },
] as unknown as BotConfig[];

function fakeRuntime(): AgentRuntime {
  return { runTurn: vi.fn(async () => ({})) } as unknown as AgentRuntime;
}

describe('teams markdown import/export', () => {
  let dir: string;
  let baseUrl: string;
  let server: { close(cb: () => void): void } | null = null;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'teams-md-'));
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerTeamRoutes(router, { dataDir: dir, agentRuntime: fakeRuntime(), getBots: () => bots });
    app.use('/api/teams', router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve()) as unknown as { close(cb: () => void): void };
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}/api/teams`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  });

  it('imports a markdown doc and exports it back', async () => {
    const importRes = await fetch(`${baseUrl}/import-markdown`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ markdown: SAMPLE_TEAM_MARKDOWN }),
    });
    expect(importRes.status).toBe(201);
    const imported = (await importRes.json()) as { team: { id: string; name: string } };
    expect(imported.team.name).toBe('Research Squad');

    const exportRes = await fetch(`${baseUrl}/${imported.team.id}/export-markdown`);
    expect(exportRes.status).toBe(200);
    const exported = (await exportRes.json()) as { markdown: string };
    expect(exported.markdown).toContain('# Team: Research Squad');
    expect(exported.markdown).toContain('scout');
  });

  it('rejects docs referencing unknown bots', async () => {
    const res = await fetch(`${baseUrl}/import-markdown`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        markdown: '# Team: Ghosts\n\n## Members\n- **Casper** (role: member)\n  - bot: casper\n',
      }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects non-markdown bodies', async () => {
    const res = await fetch(`${baseUrl}/import-markdown`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ markdown: 42 }),
    });
    expect(res.status).toBe(400);
  });
});
