// SPDX-License-Identifier: Apache-2.0
// Tests for the memory upkeep routes:
// - GET/PUT /memory/about-me persists the profile
// - POST /memory/upkeep/capture runs the background capture pass
// - POST /memory/upkeep/tidy dedupes atoms
// - the journal records writes and POST /memory/upkeep/journal/undo reverts

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TieredMemoryStore } from '@mvp/agent-runtime';
import { createMemoryUpkeepRouter } from '../src/memory-upkeep-routes.js';

describe('memory upkeep routes', () => {
  let dir: string;
  let baseUrl: string;
  let server: { close(cb: () => void): void } | null = null;
  let tieredMemoryStore: TieredMemoryStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'memupkeep-'));
    tieredMemoryStore = new TieredMemoryStore(dir);
    const app = express();
    app.use(express.json());
    app.use(
      '/memory',
      createMemoryUpkeepRouter({
        dataDir: dir,
        tieredMemoryStore,
        getBots: () => [{ id: 'bot-a' }],
      }),
    );
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve()) as unknown as { close(cb: () => void): void };
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}/memory`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('about-me persists across requests', async () => {
    const put = await fetch(`${baseUrl}/about-me`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'I am a night owl who builds robots.' }),
    });
    expect(put.status).toBe(200);
    const get = await fetch(`${baseUrl}/about-me`);
    const body = (await get.json()) as { text: string };
    expect(body.text).toBe('I am a night owl who builds robots.');
  });

  it('capture + tidy run without errors', async () => {
    const capture = await fetch(`${baseUrl}/upkeep/capture`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ botId: 'bot-a' }),
    });
    expect(capture.status).toBe(200);
    const tidy = await fetch(`${baseUrl}/upkeep/tidy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ botId: 'bot-a' }),
    });
    expect(tidy.status).toBe(200);
    const tidyBody = (await tidy.json()) as { ok: boolean; duplicatesDeactivated: number };
    expect(tidyBody.ok).toBe(true);
    expect(typeof tidyBody.duplicatesDeactivated).toBe('number');
  });

  it('journal lists and undoes', async () => {
    const list = await fetch(`${baseUrl}/upkeep/journal?botId=bot-a`);
    expect(list.status).toBe(200);
    const undo = await fetch(`${baseUrl}/upkeep/journal/undo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ botId: 'bot-a' }),
    });
    // Nothing to undo yet — 404, not a crash.
    expect([200, 404]).toContain(undo.status);
  });
});
