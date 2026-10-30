// SPDX-License-Identifier: Apache-2.0
// API-level tests (#83/#86 + #75/#80 host wiring):
// - memory-inspector endpoints: atoms list/show/delete, glob filter,
//   clear-all, journal, provenance fields;
// - verifier-gated merges at the upkeep tidy call site: an injected
//   vetoing verifier leaves near-duplicates untouched (mergesVetoed),
//   the built-in grounded verifier merges only grounded duplicates and
//   vetoes number-conflicting lookalikes;
// - watermark budgets surface on the tidy response + endpoint.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TieredMemoryStore } from '@mvp/agent-runtime';
import { buildGroundedMergeVerifier, createMemoryUpkeepRouter } from '../src/memory-upkeep-routes.js';

let dir: string;
let baseUrl: string;
let server: { close(cb: () => void): void } | null = null;
let store: TieredMemoryStore;
let mergeVerifier: ((k: never, d: never, s: number) => boolean) | undefined;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'meminsp-'));
  store = new TieredMemoryStore(dir);
  mergeVerifier = undefined;
  const app = express();
  app.use(express.json());
  app.use('/memory', createMemoryUpkeepRouter({
    dataDir: dir, tieredMemoryStore: store, getBots: () => [{ id: 'bot-a' }],
    ...(mergeVerifier ? { mergeVerifier: mergeVerifier as never } : {}),
  }));
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()) as never; });
  baseUrl = `http://127.0.0.1:${(server as unknown as { address(): AddressInfo }).address().port}/memory`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

async function remount(verifier?: (k: never, d: never, s: number) => boolean, budgets?: Record<string, number>) {
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  const app = express();
  app.use(express.json());
  app.use('/memory', createMemoryUpkeepRouter({
    dataDir: dir, tieredMemoryStore: store, getBots: () => [{ id: 'bot-a' }],
    ...(verifier ? { mergeVerifier: verifier as never } : {}),
    ...(budgets ? { watermarkBudgets: budgets } : {}),
  }));
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()) as never; });
  baseUrl = `http://127.0.0.1:${(server as unknown as { address(): AddressInfo }).address().port}/memory`;
}

const post = (path: string, body: unknown) => fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('memory inspector endpoints (#86)', () => {
  it('atoms list/show/delete with provenance, glob filter, journal, clear-all', async () => {
    const id1 = store.storeAtom('bot-a', { fact: 'User drinks green tea every morning', entities: ['Tea'], confidence: 0.9 }, 'turn-1');
    const id2 = store.storeAtom('bot-a', { fact: 'User works at a robotics lab', entities: ['Lab'], confidence: 0.8 }, 'turn-2');

    const list = await (await fetch(`${baseUrl}/atoms?botId=bot-a`)).json() as { atoms: Array<{ id: string; sourceTurn: string }> };
    expect(list.atoms.map((a) => a.id).sort()).toEqual([id1, id2].sort());
    expect(list.atoms.find((a) => a.id === id1)?.sourceTurn).toBe('turn-1'); // provenance

    const glob = await (await fetch(`${baseUrl}/atoms?botId=bot-a&pattern=*tea*`)).json() as { atoms: Array<{ id: string }> };
    expect(glob.atoms.map((a) => a.id)).toEqual([id1]);

    const show = await fetch(`${baseUrl}/atoms/${id2}?botId=bot-a`);
    expect(show.status).toBe(200);
    expect(((await show.json()) as { atom: { fact: string } }).atom.fact).toContain('robotics');
    expect((await fetch(`${baseUrl}/atoms/nope?botId=bot-a`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/atoms`)).status).toBe(400);

    const del = await fetch(`${baseUrl}/atoms/${id2}?botId=bot-a`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect((await fetch(`${baseUrl}/atoms/${id2}?botId=bot-a`)).status).toBe(404);

    const journal = await (await fetch(`${baseUrl}/upkeep/journal?botId=bot-a`)).json() as { entries: unknown[] };
    expect(Array.isArray(journal.entries)).toBe(true);

    const clear = await (await fetch(`${baseUrl}/atoms?botId=bot-a`, { method: 'DELETE' })).json() as { cleared: number };
    expect(clear.cleared).toBe(1);
    const after = await (await fetch(`${baseUrl}/atoms?botId=bot-a`)).json() as { atoms: unknown[] };
    expect(after.atoms).toHaveLength(0);
  });
});

describe('verifier-gated merges (#80)', () => {
  const factA = 'The user prefers green tea in the morning every single day';
  const factB = 'The user prefers green tea in the morning every day';

  it('a vetoing verifier leaves near-duplicates untouched', async () => {
    store.storeAtom('bot-a', { fact: factA, entities: ['Tea'], confidence: 0.9 }, 't1');
    store.storeAtom('bot-a', { fact: factB, entities: ['Tea'], confidence: 0.9 }, 't2');
    await remount(() => false);
    const tidy = await (await post('/upkeep/tidy', { botId: 'bot-a' })).json() as { nearDuplicatesFound: number; mergesVetoed: number };
    expect(tidy.nearDuplicatesFound).toBeGreaterThanOrEqual(1);
    expect(tidy.mergesVetoed).toBeGreaterThanOrEqual(1);
    expect(store.getAtoms('bot-a', 10)).toHaveLength(2);
  });

  it('the grounded verifier merges grounded duplicates but vetoes conflicting numbers', async () => {
    store.storeAtom('bot-a', { fact: factA, entities: ['Tea'], confidence: 0.9 }, 't1');
    store.storeAtom('bot-a', { fact: factB, entities: ['Tea'], confidence: 0.9 }, 't2');
    const tidy = await (await post('/upkeep/tidy', { botId: 'bot-a' })).json() as { duplicatesDeactivated: number };
    expect(tidy.duplicatesDeactivated).toBeGreaterThanOrEqual(1);
    expect(store.getAtoms('bot-a', 10)).toHaveLength(1);

    const verify = buildGroundedMergeVerifier();
    const mk = (fact: string, entities: string[]) => ({ fact, entities }) as never;
    expect(verify(mk('Budget for Tea is 500 rupees', ['Tea']), mk('Budget for Tea is 900 rupees', ['Tea']), 0.95)).toBe(false);
    expect(verify(mk('Prefers green Tea daily', ['Tea']), mk('Prefers green Tea every day', ['Tea']), 0.95)).toBe(true);
    expect(verify(mk('Likes Tea', ['Tea']), mk('Likes Coffee', ['Coffee']), 0.95)).toBe(false);
  });

  it('watermark budgets are surfaced and enforced via the endpoint', async () => {
    for (let i = 0; i < 4; i++) store.storeAtom('bot-a', { fact: `Distinct fact number ${i} about topic ${i}`, entities: [`E${i}`], confidence: 0.5 }, `t${i}`);
    await remount(undefined, { 'cloud-ok': 2 });
    const wm = await (await fetch(`${baseUrl}/upkeep/watermarks?botId=bot-a`)).json() as { budgets: Record<string, number>; counts: Record<string, number>; archived: number };
    expect(wm.budgets['cloud-ok']).toBe(2);
    expect(wm.archived).toBeGreaterThanOrEqual(2);
    expect(store.getAtoms('bot-a', 10).length).toBeLessThanOrEqual(2);
  });
});
