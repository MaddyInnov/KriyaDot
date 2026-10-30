// SPDX-License-Identifier: Apache-2.0
// Apply-on-receive (front-door Parts 4+5): synced definitions become live
// on a server only where it is their designated executor — cloud-anchored
// routines import into the scheduler's store with their identity intact,
// echoes of locally authored routines never overwrite the original, a
// flipped-back anchor disables the import, and pushed bots join/leave the
// roster only on authoritative executor pushes.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BotConfig } from '@mvp/agent-runtime';
import { RoutineStore, type BotRoutine } from '../src/bot-routines.js';
import { SyncHubStore } from '../src/sync-hub.js';
import { createSyncApply } from '../src/sync-apply.js';
import { botRosterImportsPath } from '../src/bot-roster-routes.js';

let dir: string;
let store: SyncHubStore;
let routineStore: RoutineStore;
let bots: BotConfig[];

function routineDef(over: Partial<BotRoutine> = {}): BotRoutine {
  return {
    id: 'routine-fixed-id-1',
    name: 'Nightly summary',
    botId: 'scout',
    promptTemplate: 'Summarize the day.',
    schedule: { kind: 'daily', time: '07:00', weekdays: [0, 1, 2, 3, 4, 5, 6], timezone: 'UTC', enabled: true, overlap: 'skip' },
    anchor: 'cloud',
    enabled: true,
    createdAt: 1_730_000_000_000,
    ...over,
  } as BotRoutine;
}

function botConfig(id: string): BotConfig {
  return { id, name: `Bot ${id}` } as BotConfig;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sync-apply-'));
  store = new SyncHubStore(dir);
  routineStore = new RoutineStore(dir);
  bots = [botConfig('scout')];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('routine apply', () => {
  it('imports a cloud-anchored routine on the cloud role, preserving id + fields', () => {
    const apply = createSyncApply({ dataDir: dir, store, routineStore, bots, role: 'cloud' });
    const def = routineDef();
    const res = apply.applyPush({ routines: [{ routineId: def.id, def, anchor: 'cloud' }] });
    expect(res.routinesImported).toBe(1);
    const got = routineStore.get(def.id);
    expect(got).toBeDefined();
    expect(got?.name).toBe('Nightly summary');
    expect(got?.anchor).toBe('cloud');
    expect(got?.enabled).toBe(true);
    expect(got?.schedule?.kind).toBe('daily');
  });

  it('does not import a cloud-anchored routine on the local role', () => {
    const apply = createSyncApply({ dataDir: dir, store, routineStore, bots, role: 'local' });
    const def = routineDef();
    const res = apply.applyPush({ routines: [{ routineId: def.id, def, anchor: 'cloud' }] });
    expect(res.routinesImported).toBe(0);
    expect(routineStore.get(def.id)).toBeUndefined();
  });

  it('does not import a local-anchored routine on the cloud role', () => {
    const apply = createSyncApply({ dataDir: dir, store, routineStore, bots, role: 'cloud' });
    const def = routineDef({ anchor: 'local' });
    const res = apply.applyPush({ routines: [{ routineId: def.id, def, anchor: 'local' }] });
    expect(res.routinesImported).toBe(0);
    expect(routineStore.get(def.id)).toBeUndefined();
  });

  it('refresh of an import updates fields but never the fired watermark', () => {
    const apply = createSyncApply({ dataDir: dir, store, routineStore, bots, role: 'cloud' });
    const def = routineDef();
    apply.applyPush({ routines: [{ routineId: def.id, def, anchor: 'cloud' }] });
    const res = apply.applyPush({
      routines: [{ routineId: def.id, def: routineDef({ name: 'Renamed', promptTemplate: 'New prompt.' }), anchor: 'cloud' }],
    });
    expect(res.routinesImported).toBe(1);
    expect(routineStore.get(def.id)?.name).toBe('Renamed');
    expect(routineStore.get(def.id)?.promptTemplate).toBe('New prompt.');
  });

  it('disables a tracked import when the anchor flips back to local', () => {
    const apply = createSyncApply({ dataDir: dir, store, routineStore, bots, role: 'cloud' });
    const def = routineDef();
    apply.applyPush({ routines: [{ routineId: def.id, def, anchor: 'cloud' }] });
    expect(routineStore.get(def.id)?.enabled).toBe(true);
    const res = apply.applyPush({ routines: [{ routineId: def.id, def: routineDef({ anchor: 'local' }), anchor: 'local' }] });
    expect(res.routinesDisabled).toBe(1);
    expect(routineStore.get(def.id)?.enabled).toBe(false);
  });

  it('never overwrites a locally authored routine with its own echo', () => {
    const authored = routineStore.create({
      name: 'Authored here',
      botId: 'scout',
      promptTemplate: 'Original prompt.',
      anchor: 'local',
    });
    const apply = createSyncApply({ dataDir: dir, store, routineStore, bots, role: 'local' });
    // The same routine comes back via pull with anchor 'local' (this side's
    // job) but a mutated definition — the authored copy must win.
    const echo = { ...authored, name: 'Mutated echo', promptTemplate: 'Echo prompt.' };
    const res = apply.applyPull({ routines: [{ routineId: authored.id, def: echo, anchor: 'local' }] });
    expect(res.routinesImported).toBe(0);
    expect(routineStore.get(authored.id)?.name).toBe('Authored here');
    expect(routineStore.get(authored.id)?.promptTemplate).toBe('Original prompt.');
  });
});

describe('bot apply', () => {
  it('joins the roster on an executor push and persists via roster imports', () => {
    const apply = createSyncApply({ dataDir: dir, store, routineStore, bots, role: 'cloud' });
    const cfg = botConfig('cloud-bot');
    const res = apply.applyPush({ bots: [{ botId: 'cloud-bot', config: cfg, executorHere: true }] });
    expect(res.botsImported).toBe(1);
    expect(bots.some((b) => b.id === 'cloud-bot')).toBe(true);
    const persisted = JSON.parse(readFileSync(botRosterImportsPath(dir), 'utf8')) as Array<{ id: string }>;
    expect(persisted.some((b) => b.id === 'cloud-bot')).toBe(true);
  });

  it('removes a sync-imported bot when execution is handed back', () => {
    const apply = createSyncApply({ dataDir: dir, store, routineStore, bots, role: 'cloud' });
    const cfg = botConfig('cloud-bot');
    apply.applyPush({ bots: [{ botId: 'cloud-bot', config: cfg, executorHere: true }] });
    const res = apply.applyPush({ bots: [{ botId: 'cloud-bot', config: cfg, executorHere: false }] });
    expect(res.botsRemoved).toBe(1);
    expect(bots.some((b) => b.id === 'cloud-bot')).toBe(false);
  });

  it('pull never touches the roster, even with executor flags present', () => {
    const apply = createSyncApply({ dataDir: dir, store, routineStore, bots, role: 'local' });
    const cfg = botConfig('cloud-bot');
    const res = apply.applyPull({ routines: [] });
    expect(res.botsImported).toBe(0);
    expect(bots.some((b) => b.id === 'cloud-bot')).toBe(false);
    expect(cfg.id).toBe('cloud-bot');
  });

  it('never removes a seed bot on a hand-back push', () => {
    const apply = createSyncApply({ dataDir: dir, store, routineStore, bots, role: 'cloud' });
    const res = apply.applyPush({ bots: [{ botId: 'scout', config: botConfig('scout'), executorHere: false }] });
    expect(res.botsRemoved).toBe(0);
    expect(bots.some((b) => b.id === 'scout')).toBe(true);
  });
});
