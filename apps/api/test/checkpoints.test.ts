// SPDX-License-Identifier: Apache-2.0
// CA-4 / CA-30: checkpoint retention, preview, session-diff aggregation,
// per-file restore and summarize-restore routes.

import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CheckpointStore,
  MAX_CHECKPOINTS_PER_SESSION,
  aggregateSessionDiff,
  diffLineCounts,
  previewCheckpoint,
  runCheckpointRetention,
} from '../src/checkpoints.js';
import { createCheckpointsRouter, extractiveSummary, buildSummaryMessage } from '../src/checkpoints-routes.js';

function freshStore(): { store: CheckpointStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'checkpoints-test-'));
  return { store: new CheckpointStore(dir), dir };
}

describe('CheckpointStore retention (CA-4)', () => {
  it('create() trims to the newest 100 per session', () => {
    const { store } = freshStore();
    for (let i = 0; i < MAX_CHECKPOINTS_PER_SESSION + 5; i++) {
      store.create({ sessionId: 's1', files: { '/a.ts': `v${i}` }, historyLength: i, label: `edit ${i}` });
    }
    expect(store.list('s1', 500)).toHaveLength(MAX_CHECKPOINTS_PER_SESSION);
  });

  it('runRetention drops >30-day-old rows and per-session overflow', () => {
    const { store } = freshStore();
    const now = Date.now();
    const old = store.create({ sessionId: 's1', files: { '/a.ts': 'old' }, historyLength: 0, label: 'old' });
    // Age the row past 30 days directly in the table via a second store view:
    // create() stamps Date.now(), so simulate age by sweeping with a future now.
    const fresh = store.create({ sessionId: 's1', files: { '/a.ts': 'new' }, historyLength: 1, label: 'new' });
    const result = runCheckpointRetention(store, now + 31 * 24 * 60 * 60 * 1000);
    expect(result.removedExpired).toBe(2); // both rows are >30d old at sweep time
    expect(store.get(old.id)).toBeUndefined();
    expect(store.get(fresh.id)).toBeUndefined();
    // A sweep at "now" removes nothing fresh.
    const { store: store2 } = freshStore();
    store2.create({ sessionId: 's2', files: { '/b.ts': 'x' }, historyLength: 0, label: 'x' });
    expect(runCheckpointRetention(store2, Date.now())).toEqual({ removedExpired: 0, removedOverflow: 0 });
    expect(store2.list('s2')).toHaveLength(1);
  });

  it('preview reports file sizes without contents; fileContent is per-file', () => {
    const { store } = freshStore();
    const cp = store.create({
      sessionId: 's1',
      files: { '/a.ts': 'hello', '/new.ts': null },
      historyLength: 3,
      label: 'before write_file /a.ts',
    });
    const preview = previewCheckpoint(cp);
    expect(preview.files).toEqual([
      { path: '/a.ts', size: 5, existed: true },
      { path: '/new.ts', size: 0, existed: false },
    ]);
    expect(preview.totalBytes).toBe(5);
    expect(store.preview(cp.id)?.historyLength).toBe(3);
    expect(store.fileContent(cp.id, '/a.ts')).toEqual({ found: true, content: 'hello' });
    expect(store.fileContent(cp.id, '/nope.ts').found).toBe(false);
  });
});

describe('diff aggregation (CA-30)', () => {
  it('diffLineCounts counts added/removed lines', () => {
    expect(diffLineCounts('a\nb\nc', 'a\nx\nc\nd')).toEqual({ added: 2, removed: 1 });
    expect(diffLineCounts(null, 'a\nb')).toEqual({ added: 2, removed: 0 });
    expect(diffLineCounts('a\nb', null)).toEqual({ added: 0, removed: 2 });
    expect(diffLineCounts('same', 'same')).toEqual({ added: 0, removed: 0 });
  });

  it('aggregateSessionDiff compares first snapshot vs current disk state', () => {
    const { store } = freshStore();
    store.create({ sessionId: 's1', files: { '/a.ts': 'one\ntwo' }, historyLength: 0, label: 'e1' });
    store.create({ sessionId: 's1', files: { '/a.ts': 'one\ntwo\nthree', '/b.ts': null }, historyLength: 1, label: 'e2' });
    const current = new Map<string, string | null>([
      ['/a.ts', 'one\nTWO\nthree\nfour'],
      ['/b.ts', 'brand new'],
    ]);
    const rows = aggregateSessionDiff(store.listChronological('s1'), (p) => current.get(p) ?? null);
    expect(rows).toEqual([
      { path: '/a.ts', status: 'modified', added: 3, removed: 1, touches: 2 },
      { path: '/b.ts', status: 'created', added: 1, removed: 0, touches: 1 },
    ]);
  });
});

describe('checkpoints router', () => {
  let dir: string;
  let baseUrl: string;
  let server: ReturnType<import('node:http').Server> | null = null;
  let store: CheckpointStore;
  let messages: Array<{ role: string; content: string }>;
  let appended: Array<{ role: string; content: string }>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'checkpoints-routes-'));
    store = new CheckpointStore(dir);
    messages = [
      { role: 'user', content: 'start' },
      { role: 'assistant', content: 'working' },
      { role: 'user', content: 'more' },
      { role: 'assistant', content: 'done more' },
    ];
    appended = [];
    const app = express();
    app.use(express.json());
    app.use(
      '/api',
      createCheckpointsRouter({
        checkpointStore: store,
        rewindSession: (_sid, keep) => {
          const removed = messages.length - keep;
          messages = messages.slice(0, keep);
          return removed;
        },
        listMessages: () => messages,
        appendMessage: (_sid, msg) => {
          appended.push(msg);
          messages.push(msg);
        },
        summarize: async (msgs) => `SUMMARY(${msgs.length})`,
      }),
    );
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}/api`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => (server as unknown as { close(cb: () => void): void }).close(() => resolve()));
    server = null;
  });

  async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  it('GET /sessions/:id/diff aggregates against disk', async () => {
    const target = join(dir, 'a.ts');
    writeFileSync(target, 'one\nTWO', 'utf8');
    store.create({ sessionId: 's1', files: { [target]: 'one\ntwo' }, historyLength: 0, label: 'edit' });
    const r = await api('GET', '/sessions/s1/diff');
    expect(r.status).toBe(200);
    expect(r.json.files).toEqual([{ path: target, status: 'modified', added: 1, removed: 1, touches: 1 }]);
    expect(r.json.totals).toEqual({ added: 1, removed: 1 });
  });

  it('POST restore-file restores exactly one file', async () => {
    const a = join(dir, 'a.ts');
    const b = join(dir, 'b.ts');
    writeFileSync(a, 'A-now', 'utf8');
    writeFileSync(b, 'B-now', 'utf8');
    const cp = store.create({ sessionId: 's1', files: { [a]: 'A-before', [b]: 'B-before' }, historyLength: 0, label: 'edit' });
    const r = await api('POST', `/checkpoints/${cp.id}/restore-file`, { path: a });
    expect(r.status).toBe(200);
    expect(readFileSync(a, 'utf8')).toBe('A-before');
    expect(readFileSync(b, 'utf8')).toBe('B-now'); // untouched
    expect((await api('POST', `/checkpoints/${cp.id}/restore-file`, { path: '/nope' })).status).toBe(404);
    expect((await api('POST', '/checkpoints/nope/restore-file', { path: a })).status).toBe(404);
  });

  it('POST restore-summarized rewinds and appends one summary message', async () => {
    const cp = store.create({ sessionId: 's1', files: {}, historyLength: 2, label: 'edit' });
    const r = await api('POST', `/checkpoints/${cp.id}/restore-summarized`, { mode: 'conversation' });
    expect(r.status).toBe(200);
    expect(r.json.summary).toBe('SUMMARY(2)');
    expect(r.json.messagesRemoved).toBe(2);
    expect(r.json.appended).toBe(true);
    expect(messages).toHaveLength(3); // 2 kept + 1 summary
    expect(appended[0]?.content).toContain('SUMMARY(2)');
    expect(existsSync(join(dir, 'checkpoints.db'))).toBe(true);
  });

  it('POST restore-summarized with mode both also restores code', async () => {
    const a = join(dir, 'a.ts');
    writeFileSync(a, 'now', 'utf8');
    const cp = store.create({ sessionId: 's1', files: { [a]: 'before' }, historyLength: 4, label: 'edit' });
    const r = await api('POST', `/checkpoints/${cp.id}/restore-summarized`, { mode: 'both' });
    expect(r.json.messagesRemoved).toBe(0);
    expect(readFileSync(a, 'utf8')).toBe('before');
  });

  it('POST retention/run sweeps and reports counts', async () => {
    store.create({ sessionId: 's1', files: {}, historyLength: 0, label: 'x' });
    const r = await api('POST', '/checkpoints/retention/run');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, removedExpired: 0, removedOverflow: 0 });
  });

  it('404s unknown checkpoints on every route', async () => {
    expect((await api('POST', '/checkpoints/nope/restore-summarized', {})).status).toBe(404);
    expect((await api('GET', '/checkpoints/nope/preview')).status).toBe(404);
  });
});

describe('summary helpers', () => {
  it('extractiveSummary + buildSummaryMessage are honest and bounded', () => {
    const s = extractiveSummary([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ]);
    expect(s).toContain('2 message(s)');
    expect(buildSummaryMessage('S', 3)).toContain('3 message(s)');
    expect(buildSummaryMessage('S', 3)).toContain('S');
  });
});
