// SPDX-License-Identifier: Apache-2.0
// OH-4: opt-in account ingestion — settings round-trip, files + RSS
// sources with hash dedupe, and the pause / privacy / local-only guards.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TieredMemoryStore, type BotConfig } from '@mvp/agent-runtime';
import {
  MemoryIngestionEngine,
  getIngestionSettings,
  parseFeedItems,
  saveIngestionSettings,
  startMemoryIngestionScheduler,
  type MemoryIngestionDeps,
} from '../src/memory-ingestion.js';
import { createMemoryIngestionRouter } from '../src/memory-ingestion-routes.js';

const BOT = {
  id: 'bot1', name: 'Bot One', description: 'd', systemPrompt: 'p',
  provider: 'ovh-anonymous', model: 'gpt-oss-120b', tools: [], skills: [],
} as BotConfig;

let dir: string;
let wsDir: string;
let store: TieredMemoryStore;
let savedGoogleEnv: Record<string, string | undefined>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oh4-ingest-'));
  wsDir = join(dir, 'ws');
  mkdirSync(wsDir, { recursive: true });
  store = new TieredMemoryStore(join(dir, 'mem'));
  savedGoogleEnv = {
    GOOGLE_OAUTH_CLIENT_ID: process.env.GOOGLE_OAUTH_CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  };
  delete process.env.GOOGLE_OAUTH_CLIENT_ID;
  delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedGoogleEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

function engineDeps(extra: Partial<MemoryIngestionDeps> = {}): MemoryIngestionDeps {
  return {
    dataDir: dir,
    tieredMemoryStore: store,
    getBot: (id) => (id === BOT.id ? BOT : undefined),
    workspaceDirForBot: () => wsDir,
    ...extra,
  };
}

describe('parseFeedItems', () => {
  it('parses RSS items and Atom entries', () => {
    const rss = `<?xml version="1.0"?><rss><channel>
      <item><title>First Post</title><link>https://example.com/1</link><pubDate>Mon, 02 Nov 2026 00:00:00 GMT</pubDate><description>About &amp; things</description></item>
      <item><title>Second</title><link>https://example.com/2</link><description><![CDATA[Body <b>two</b>]]></description></item>
    </channel></rss>`;
    const items = parseFeedItems(rss);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ title: 'First Post', link: 'https://example.com/1', summary: 'About & things' });
    expect(items[1]!.summary).toContain('Body');
    const atom = `<feed><entry><title>Entry One</title><link href="https://example.com/e1"/><summary>Sum</summary></entry></feed>`;
    expect(parseFeedItems(atom)[0]).toMatchObject({ title: 'Entry One', link: 'https://example.com/e1' });
  });
});

describe('files source', () => {
  it('adds atoms once; the second run adds 0 (hash dedupe)', async () => {
    writeFileSync(join(wsDir, 'notes.md'), '# Notes\nThe alpha project ships on Friday.');
    writeFileSync(join(wsDir, 'todo.txt'), 'Buy milk and call the plumber.');
    saveIngestionSettings(dir, BOT.id, { sources: { files: true } });
    const engine = new MemoryIngestionEngine(engineDeps());
    const first = await engine.run(BOT.id);
    expect(first.added).toBe(2);
    expect(first.perSource.files).toMatchObject({ added: 2, skipped: 0 });
    const atoms = store.getAtoms(BOT.id, 10);
    expect(atoms).toHaveLength(2);
    expect(atoms.every((a) => a.category === 'summary')).toBe(true);
    expect(atoms.map((a) => a.sourceTurn).sort()).toEqual(['ingest:files:notes.md', 'ingest:files:todo.txt']);
    expect(atoms.find((a) => a.sourceTurn === 'ingest:files:notes.md')!.fact).toContain('notes.md');

    const second = await engine.run(BOT.id);
    expect(second.added).toBe(0);
    expect(second.perSource.files).toMatchObject({ added: 0, skipped: 2 });
    expect(store.getAtoms(BOT.id, 10)).toHaveLength(2);
  });

  it('ingestion is OFF by default: no enabled sources, nothing added', async () => {
    writeFileSync(join(wsDir, 'notes.md'), 'content here');
    const engine = new MemoryIngestionEngine(engineDeps());
    const result = await engine.run(BOT.id);
    expect(result.added).toBe(0);
    expect(store.getAtoms(BOT.id, 10)).toHaveLength(0);
  });
});

describe('rss source (injected fetch)', () => {
  it('ingests feed items once with ingest:rss sourceTurns', async () => {
    const xml = `<rss><channel>
      <item><title>Release 2.0</title><link>https://example.com/r2</link><description>Big release notes</description></item>
      <item><title>Release 2.1</title><link>https://example.com/r21</link><description>Small fixes</description></item>
    </channel></rss>`;
    const fetchFn = async () =>
      ({ ok: true, status: 200, text: async () => xml }) as unknown as Response;
    saveIngestionSettings(dir, BOT.id, {
      sources: { rss: true },
      rssFeeds: ['https://example.com/feed.xml'],
    });
    const engine = new MemoryIngestionEngine(engineDeps({ fetchFn }));
    const first = await engine.run(BOT.id);
    expect(first.added).toBe(2);
    const atoms = store.getAtoms(BOT.id, 10);
    expect(atoms.every((a) => a.sourceTurn === 'ingest:rss:https://example.com/feed.xml')).toBe(true);
    const second = await engine.run(BOT.id);
    expect(second.added).toBe(0);
  });
});

describe('guards', () => {
  beforeEach(() => {
    writeFileSync(join(wsDir, 'notes.md'), 'guarded content');
    saveIngestionSettings(dir, BOT.id, { sources: { files: true } });
  });

  it('system pause blocks the run', async () => {
    const engine = new MemoryIngestionEngine(engineDeps({ isPaused: () => true }));
    const r = await engine.run(BOT.id);
    expect(r.blocked).toBe('system paused');
    expect(r.added).toBe(0);
  });

  it('privacy mode blocks the run', async () => {
    const engine = new MemoryIngestionEngine(engineDeps({ isPrivacyMode: () => true }));
    const r = await engine.run(BOT.id);
    expect(r.blocked).toBe('privacy mode enabled');
    expect(r.added).toBe(0);
  });

  it('local-only bot blocks the run', async () => {
    const engine = new MemoryIngestionEngine(engineDeps({ isLocalOnly: () => true }));
    const r = await engine.run(BOT.id);
    expect(r.blocked).toBe('bot is local-only');
    expect(r.added).toBe(0);
  });
});

describe('HTTP routes: settings round-trip + source statuses + run', () => {
  async function listen(app: express.Express) {
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.on('listening', resolve));
    return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  }

  function app() {
    const a = express();
    a.use(express.json());
    a.use(
      '/api/memory-ingestion',
      createMemoryIngestionRouter({ ...engineDeps(), getBots: () => [BOT] }),
    );
    return a;
  }

  it('PUT then GET returns the same settings; gmail/drive honestly unavailable unconfigured', async () => {
    const { server, base } = await listen(app());
    try {
      const put = await fetch(`${base}/api/memory-ingestion/bot1`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sources: { files: true, rss: true }, rssFeeds: ['https://example.com/f.xml'] }),
      });
      expect(put.status).toBe(200);
      const got = await (await fetch(`${base}/api/memory-ingestion/bot1`)).json();
      expect(got.settings.sources).toMatchObject({ files: true, rss: true });
      expect(got.settings.rssFeeds).toEqual(['https://example.com/f.xml']);
      expect(getIngestionSettings(dir, BOT.id).sources.files).toBe(true);
      const byId = new Map(got.sources.map((s: { id: string }) => [s.id, s]));
      expect(byId.get('files')).toMatchObject({ enabled: true, available: true, lastAdded: 0 });
      expect(byId.get('gmail')).toMatchObject({ available: false, unavailableReason: 'google workspace not configured' });
      expect(byId.get('drive')).toMatchObject({ available: false, unavailableReason: 'google workspace not configured' });
    } finally {
      server.close();
    }
  });

  it('POST run executes enabled sources and reports perSource counts', async () => {
    writeFileSync(join(wsDir, 'a.md'), 'alpha content for the run endpoint');
    const { server, base } = await listen(app());
    try {
      await fetch(`${base}/api/memory-ingestion/bot1`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sources: { files: true } }),
      });
      const res = await fetch(`${base}/api/memory-ingestion/bot1/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = await res.json();
      expect(body).toMatchObject({ ok: true, botId: 'bot1', added: 1, skipped: 0 });
      expect(body.perSource.files).toMatchObject({ added: 1 });
      const bad = await fetch(`${base}/api/memory-ingestion/bot1/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'nope' }),
      });
      expect(bad.status).toBe(400);
    } finally {
      server.close();
    }
  });
});

describe('scheduler', () => {
  it('runOnce only touches bots with an enabled source and never throws', async () => {
    writeFileSync(join(wsDir, 's.md'), 'scheduled ingestion content');
    saveIngestionSettings(dir, BOT.id, { sources: { files: true } });
    const scheduler = startMemoryIngestionScheduler(
      { ...engineDeps(), getBotIds: () => [BOT.id, 'ghost'] },
      { intervalMs: 60_000 },
    );
    try {
      await scheduler.runOnce();
      expect(store.getAtoms(BOT.id, 10)).toHaveLength(1);
    } finally {
      scheduler.stop();
    }
  });
});
