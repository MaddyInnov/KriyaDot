// SPDX-License-Identifier: Apache-2.0
// Session share links + export, background-run routes (Octomind parity).
// Small express app over the real registrars; a real AgentRuntime on an
// in-memory DB provides the sessions (mock governance, no network).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentRuntime, BackgroundRunRegistry } from '@mvp/agent-runtime';
import type { GovernanceGateway } from '@mvp/agent-runtime';
import {
  registerBackgroundRunRoutes,
  registerSessionShareRoutes,
  renderTranscriptMarkdown,
} from '../src/session-share.js';
import { registerPublicPageServing } from '../src/public-pages.js';

const allowGateway: GovernanceGateway = {
  classify: async () => 'allow',
  evaluate: async () => ({ decision: 'allow' }),
  awaitDecision: async () => 'approved',
  decide: () => {},
  audit: () => {},
  runPreHooks: async () => {},
  runPostHooks: async () => {},
};

let dir: string;
let base: string;
let runtime: AgentRuntime;
let server: Server;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'session-share-'));
  runtime = new AgentRuntime({
    dbPath: ':memory:',
    skillsDir: join(dir, 'no-skills'),
    governance: allowGateway,
    toolRegistry: new Map(),
    defaultProviderId: 'mock',
    backgroundRuns: new BackgroundRunRegistry(),
  });
  const app = express();
  app.use(express.json());
  const router = express.Router();
  registerSessionShareRoutes(router, { agentRuntime: runtime, dataDir: dir });
  registerBackgroundRunRoutes(router, { agentRuntime: runtime, dataDir: dir });
  app.use('/api', router);
  registerPublicPageServing(app, { dataDir: dir });
  server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Seed a session with messages through the runtime's store surface. */
function seedSession(): string {
  // listThreadMessages reads the store; create via the public runtime API:
  // runTurn is too heavy — use the store through a cast (test-only).
  const store = (runtime as unknown as { store: { createSession: (b: string) => string; appendMessage: (s: string, m: unknown) => void } }).store;
  const sid = store.createSession('bot-share');
  store.appendMessage(sid, { role: 'user', content: 'How do I bake sourdough?' });
  store.appendMessage(sid, { role: 'assistant', content: 'Start with a ripe starter…' });
  return sid;
}

describe('session share + export', () => {
  it('renders a transcript; unknown sessions render null', () => {
    const sid = seedSession();
    const rendered = renderTranscriptMarkdown(runtime, sid);
    expect(rendered?.count).toBe(2);
    expect(rendered?.markdown).toContain('**User:**');
    expect(rendered?.markdown).toContain('sourdough');
    expect(rendered?.title).toContain('bot-share');
    expect(renderTranscriptMarkdown(runtime, 'no-such-session')).toBeNull();
  });

  it('publishes a share link served by the public-pages route', async () => {
    const sid = seedSession();
    const res = await fetch(`${base}/api/sessions/${sid}/share`, { method: 'POST' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { slug: string; path: string; messages: number };
    expect(body.messages).toBe(2);
    expect(body.path).toBe(`/p/${body.slug}`);
    const page = await fetch(`${base}${body.path}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('sourdough');
    expect(page.headers.get('content-security-policy')).toBeTruthy();
  });

  it('404s sharing an empty session', async () => {
    const res = await fetch(`${base}/api/sessions/nope/share`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('exports markdown and JSON downloads', async () => {
    const sid = seedSession();
    const md = await fetch(`${base}/api/sessions/${sid}/export`);
    expect(md.status).toBe(200);
    expect(md.headers.get('content-disposition')).toContain('.md');
    expect(await md.text()).toContain('ripe starter');
    const json = await fetch(`${base}/api/sessions/${sid}/export?format=json`);
    const parsed = JSON.parse(await json.text()) as { sessionId: string; messages: unknown[] };
    expect(parsed.sessionId).toBe(sid);
    expect(parsed.messages).toHaveLength(2);
  });
});

describe('background-run routes', () => {
  it('lists runs and stops a running one', async () => {
    const { record } = runtime.backgroundRuns.start({
      botId: 'specialist',
      botName: 'Specialist',
      ephemeral: true,
      originBotId: 'bot-share',
      originSessionId: 'sess-1',
      task: 'do research',
    });
    const list = await fetch(`${base}/api/background-runs?sessionId=sess-1`);
    const listed = (await list.json()) as { runs: Array<{ id: string; status: string }> };
    expect(listed.runs.map((r) => r.id)).toContain(record.id);

    const stop = await fetch(`${base}/api/background-runs/${record.id}/stop`, { method: 'POST' });
    expect(stop.status).toBe(200);
    expect(runtime.backgroundRuns.get(record.id)?.status).toBe('stopped');

    const again = await fetch(`${base}/api/background-runs/${record.id}/stop`, { method: 'POST' });
    expect(again.status).toBe(404);
  });
});
