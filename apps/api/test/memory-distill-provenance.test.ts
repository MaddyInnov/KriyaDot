// SPDX-License-Identifier: Apache-2.0
// #77 explicit distill trigger + #86 outcome provenance (memory-upkeep-routes).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { atomProvenance, createMemoryUpkeepRouter } from '../src/memory-upkeep-routes.js';

function fakeAtom(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'a1',
    botId: 'bot-a',
    fact: 'User prefers tea',
    entities: ['tea'],
    confidence: 0.9,
    sourceTurn: 'turn-1',
    createdAt: 1,
    tier: 'cloud-ok',
    pinned: false,
    category: 'preference',
    active: true,
    ...over,
  };
}

describe('#86 atomProvenance', () => {
  it('derives outcome from useCredit / archived, and carries grounding fields', () => {
    const unused = atomProvenance(fakeAtom() as never);
    expect(unused.outcome).toBe('stored-unused');
    expect(unused.sourceTurn).toBe('turn-1');
    expect(unused.grounding).toBeNull();

    const used = atomProvenance(fakeAtom({ useCredit: 3, grounding: 'verbatim-quote', quote: 'I prefer tea', quoteSource: 'msg-9', evidenceLinks: ['session://s1#m2'] }) as never);
    expect(used.outcome).toBe('used-in-recall');
    expect(used.quote).toBe('I prefer tea');
    expect(used.evidenceLinks).toEqual(['session://s1#m2']);

    expect(atomProvenance(fakeAtom({ archived: true, useCredit: 5 }) as never).outcome).toBe('archived-cold');
  });
});

describe('#77 POST /upkeep/distill + inspector provenance over HTTP', () => {
  let dir: string;
  let baseUrl: string;
  let server: { close(cb: () => void): void } | null = null;
  const runDistillPipeline = vi.fn(async (botId: string, sessionId: string) => ({
    botId,
    sessionId,
    turns: 2,
    stored: 1,
    rejected: 0,
    atomIds: ['a1'],
    reflection: null,
  }));
  const store = {
    droppedUngroundedQuotes: 0,
    getAtoms: () => [fakeAtom({ useCredit: 2 })],
    getAtom: () => fakeAtom({ useCredit: 2 }),
    deleteAtom: () => true,
    runDistillPipeline,
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'distill-test-'));
    const app = express();
    app.use(express.json());
    app.use('/memory', createMemoryUpkeepRouter({ dataDir: dir, tieredMemoryStore: store as never, getBots: () => [{ id: 'bot-a' }] }));
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve()) as unknown as { close(cb: () => void): void };
    });
    baseUrl = `http://127.0.0.1:${(server as unknown as { address(): AddressInfo }).address().port}/memory`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    rmSync(dir, { recursive: true, force: true });
    runDistillPipeline.mockClear();
  });

  it('runs the pipeline for bot+session and returns its result', async () => {
    const res = await fetch(`${baseUrl}/upkeep/distill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botId: 'bot-a', sessionId: 'sess-1' }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; stored: number; turns: number };
    expect(json).toMatchObject({ ok: true, stored: 1, turns: 2 });
    expect(runDistillPipeline).toHaveBeenCalledWith('bot-a', 'sess-1');
  });

  it('rejects a missing sessionId and an unknown bot', async () => {
    const noSession = await fetch(`${baseUrl}/upkeep/distill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botId: 'bot-a' }),
    });
    expect(noSession.status).toBe(400);
    const badBot = await fetch(`${baseUrl}/upkeep/distill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botId: 'nope', sessionId: 's1' }),
    });
    expect(badBot.status).toBe(400);
  });

  it('the atoms inspector carries the provenance block incl. outcome', async () => {
    const res = await fetch(`${baseUrl}/atoms?botId=bot-a`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { atoms: Array<{ provenance: { outcome: string; useCredit: number } }> };
    expect(json.atoms[0]!.provenance).toMatchObject({ outcome: 'used-in-recall', useCredit: 2 });
  });
});
