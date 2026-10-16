// SPDX-License-Identifier: Apache-2.0
// Interactive widget HTTP routes (OpenMausBot parity P1 #15): answer flow
// (200/404/409), listing with filters, expiry sweep, and broker-style
// waiter settle. Real HTTP against a real WidgetStore + WidgetCoordinator;
// zero network beyond localhost, zero paid API usage.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WidgetCoordinator, WidgetStore } from '@mvp/agent-runtime';
import { createWidgetRouter } from '../src/widget-routes.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'widget-routes-test-'));
}

let store: WidgetStore;
let coordinator: WidgetCoordinator;
const audits: Array<{ action: string; fields: unknown }> = [];

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(
    createWidgetRouter({
      store,
      coordinator,
      audit: (action, fields) => void audits.push({ action, fields }),
    }),
  );
  return app;
}

let server: { close(cb: () => void): void } | undefined;
let baseUrl = '';

beforeEach(async () => {
  audits.length = 0;
  store = new WidgetStore(tempDir());
  coordinator = new WidgetCoordinator(store);
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

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

async function raise(sessionId = 's1') {
  return coordinator.raise({
    sessionId,
    botId: 'scout',
    kind: 'buttons',
    payload: {
      kind: 'buttons',
      title: 'Question for you',
      question: 'Deploy?',
      options: [
        { id: 'o1', label: 'Yes' },
        { id: 'o2', label: 'No' },
      ],
    },
    title: 'Question for you',
    interactive: true,
  });
}

describe('POST /widgets/:id/answer', () => {
  it('answers a pending widget: 200, settles the waiter, audits', async () => {
    const w = await raise();
    const waiting = coordinator.awaitAnswer(w.id, 5000);
    const res = await api(`/widgets/${w.id}/answer`, json({ value: { selected: ['o1'] } }));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const widget = res.body.widget as { status: string; value: unknown };
    expect(widget.status).toBe('answered');
    expect(widget.value).toEqual({ selected: ['o1'] });
    // In-flight waiter resolved with the answer.
    const ans = await waiting;
    expect(ans).toMatchObject({ answered: true, value: { selected: ['o1'] } });
    expect(audits.some((a) => a.action === 'widget.answered')).toBe(true);
  });

  it('double-answer → 409; unknown widget → 404', async () => {
    const w = await raise();
    const ok = await api(`/widgets/${w.id}/answer`, json({ value: 'x' }));
    expect(ok.status).toBe(200);
    const again = await api(`/widgets/${w.id}/answer`, json({ value: 'y' }));
    expect(again.status).toBe(409);
    const missing = await api('/widgets/nope/answer', json({ value: 'y' }));
    expect(missing.status).toBe(404);
  });
});

describe('GET /widgets', () => {
  it('lists widgets, filterable by sessionId and status; 400 on bad status', async () => {
    await raise('s1');
    await raise('s2');
    const w3 = await raise('s1');
    coordinator.settle(w3.id, { answered: true, value: null });

    const all = await api('/widgets');
    expect(all.status).toBe(200);
    expect((all.body.widgets as unknown[])).toHaveLength(3);
    const s2 = await api('/widgets?sessionId=s2');
    expect((s2.body.widgets as unknown[])).toHaveLength(1);
    const pending = await api('/widgets?status=pending');
    expect((pending.body.widgets as unknown[])).toHaveLength(2);
    const answered = await api('/widgets?status=answered');
    expect((answered.body.widgets as unknown[])).toHaveLength(1);
    const both = await api('/widgets?sessionId=s1&status=pending');
    expect((both.body.widgets as unknown[])).toHaveLength(1);
    const bad = await api('/widgets?status=bogus');
    expect(bad.status).toBe(400);
  });

  it('sweeps expired widgets on list and fails their waiters closed', async () => {
    const dir = tempDir();
    const shortStore = new WidgetStore(dir, { ttlMs: 30 });
    const shortCoord = new WidgetCoordinator(shortStore);
    const app = express();
    app.use(express.json());
    app.use(createWidgetRouter({ store: shortStore, coordinator: shortCoord, audit: () => {} }));
    const srv = await new Promise<{ close(cb: () => void): void; port: number }>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () =>
        resolve({ close: (cb) => s.close(cb), port: (s.address() as { port: number }).port }),
      );
    });
    try {
      const w = await shortCoord.raise({
        sessionId: 's1',
        botId: 'b',
        kind: 'progress',
        payload: { kind: 'progress', percent: 5 },
        interactive: false,
      });
      const waiting = shortCoord.awaitAnswer(w.id, 5000);
      // Let the TTL pass, then list: the sweep expires it.
      await new Promise((r) => setTimeout(r, 80));
      const res = await fetch(`http://127.0.0.1:${srv.port}/widgets?status=expired`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { widgets: Array<{ id: string; status: string }> };
      expect(body.widgets.some((x) => x.id === w.id && x.status === 'expired')).toBe(true);
      expect(await waiting).toMatchObject({ answered: false, expired: true });
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
      shortStore.close();
    }
  });
});
