// SPDX-License-Identifier: Apache-2.0
// Apply-on-receive for the sync hub (front-door Parts 4+5).
//
// The sync store alone is a *record*: definitions that arrive from the
// user's other side sit in sync_bots / sync_routines without joining the
// live roster or the scheduler. This module is the bridge that makes the
// record executable — under strict rules:
//
//   - A received routine is imported into the live RoutineStore (same id)
//     ONLY when this server's role is its designated executor
//     (shouldExecuteForRole). Anything else would double-fire schedules.
//   - Routines this server AUTHORED are never overwritten by their own
//     echo: imports are tracked (sync meta), and only tracked imports are
//     refreshed or disabled by later syncs.
//   - When a tracked import stops being this side's job (anchor flipped
//     back), it is disabled in place — the definition stays visible, it
//     just never fires here.
//   - Bots join the live roster only on an authoritative push that names
//     this side as executor (executorHere), persisted through the roster
//     imports file so they survive restarts; they are removed again when
//     a later push hands execution back. Pull echoes never touch the
//     roster (their executor flags are written from the sender's side).
//
// Known limit: while a routine is sync-imported, the authoring side owns
// its definition — edits made on the executing side are overwritten by
// the next sync from the authoring side.

import type { BotConfig } from '@mvp/agent-runtime';
import type { BotRoutine, RoutineStore } from './bot-routines.js';
import type { SyncBotInput, SyncHubStore, SyncRoutineInput } from './sync-hub.js';
import { shouldExecuteForRole, type InstanceRole, type RoutineAnchor } from './placement.js';
import {
  appendRosterImport,
  removeRosterImport,
  updateRosterImport,
} from './bot-roster-routes.js';

export interface SyncApplyDeps {
  dataDir: string;
  store: SyncHubStore;
  routineStore: Pick<RoutineStore, 'get' | 'importRoutine' | 'update'>;
  /** Live bot roster (seed.bots) — mutated in place. */
  bots: BotConfig[];
  role: InstanceRole;
}

export interface SyncApplyResult {
  routinesImported: number;
  routinesDisabled: number;
  botsImported: number;
  botsRemoved: number;
}

const META_IMPORTED_ROUTINES = 'syncImportedRoutineIds';
const META_IMPORTED_BOTS = 'syncImportedBotIds';

function readIdSet(store: SyncHubStore, key: string): Set<string> {
  try {
    const raw = store.getMeta(key);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeIdSet(store: SyncHubStore, key: string, ids: Set<string>): void {
  store.setMeta(key, JSON.stringify([...ids]));
}

function asRoutine(def: unknown): BotRoutine | null {
  if (typeof def !== 'object' || def === null) return null;
  const r = def as Partial<BotRoutine>;
  if (typeof r.id !== 'string' || typeof r.botId !== 'string') return null;
  if (typeof r.name !== 'string' || typeof r.promptTemplate !== 'string') return null;
  return r as BotRoutine;
}

function asBotConfig(entry: SyncBotInput): BotConfig | null {
  const cfg = (typeof entry.config === 'object' && entry.config !== null ? entry.config : entry) as Partial<BotConfig>;
  const id = typeof entry.botId === 'string' ? entry.botId : typeof cfg.id === 'string' ? cfg.id : undefined;
  if (!id || typeof cfg !== 'object' || cfg === null) return null;
  return { ...(cfg as BotConfig), id };
}

export function createSyncApply(deps: SyncApplyDeps) {
  const { store, routineStore, bots, role, dataDir } = deps;

  function applyRoutines(routines: SyncRoutineInput[] | undefined): Pick<SyncApplyResult, 'routinesImported' | 'routinesDisabled'> {
    let routinesImported = 0;
    let routinesDisabled = 0;
    if (!routines || routines.length === 0) return { routinesImported, routinesDisabled };
    const imported = readIdSet(store, META_IMPORTED_ROUTINES);
    let dirty = false;
    for (const entry of routines) {
      const def = asRoutine(entry.def);
      if (!def) continue;
      const anchor: RoutineAnchor | undefined =
        entry.anchor === 'local' || entry.anchor === 'cloud' ? entry.anchor : def.anchor;
      const mine = shouldExecuteForRole(anchor, role);
      const existing = routineStore.get(def.id);
      if (mine) {
        if (existing && !imported.has(def.id)) continue; // authored here — echo, own copy wins
        routineStore.importRoutine({ ...def, anchor });
        if (!imported.has(def.id)) {
          imported.add(def.id);
          dirty = true;
        }
        routinesImported++;
      } else if (existing && imported.has(def.id) && existing.enabled !== false) {
        routineStore.update(def.id, { enabled: false });
        routinesDisabled++;
      }
    }
    if (dirty) writeIdSet(store, META_IMPORTED_ROUTINES, imported);
    return { routinesImported, routinesDisabled };
  }

  function applyBots(list: SyncBotInput[] | undefined): Pick<SyncApplyResult, 'botsImported' | 'botsRemoved'> {
    let botsImported = 0;
    let botsRemoved = 0;
    if (!list || list.length === 0) return { botsImported, botsRemoved };
    const imported = readIdSet(store, META_IMPORTED_BOTS);
    let dirty = false;
    for (const entry of list) {
      const cfg = asBotConfig(entry);
      if (!cfg) continue;
      if (entry.executorHere === true) {
        const idx = bots.findIndex((b) => b.id === cfg.id);
        if (idx === -1) {
          bots.push(cfg);
          appendRosterImport(cfg, dataDir);
          imported.add(cfg.id);
          dirty = true;
          botsImported++;
        } else if (imported.has(cfg.id)) {
          bots[idx] = cfg;
          updateRosterImport(cfg, dataDir);
          botsImported++;
        }
        // A bot that exists as a seed/local bot is left untouched.
      } else if (entry.executorHere === false && imported.has(cfg.id)) {
        const idx = bots.findIndex((b) => b.id === cfg.id);
        if (idx !== -1) bots.splice(idx, 1);
        removeRosterImport(cfg.id, dataDir);
        imported.delete(cfg.id);
        dirty = true;
        botsRemoved++;
      }
    }
    if (dirty) writeIdSet(store, META_IMPORTED_BOTS, imported);
    return { botsImported, botsRemoved };
  }

  return {
    /** Push-receive: the sender addressed this server directly — bots and routines apply. */
    applyPush(payload: { bots?: SyncBotInput[]; routines?: SyncRoutineInput[] }): SyncApplyResult {
      const r = applyRoutines(payload.routines);
      const b = applyBots(payload.bots);
      return { ...r, ...b };
    },
    /** Pull: definitions are absolute (anchors), but bot executor flags are sender-relative — routines only. */
    applyPull(payload: { routines?: SyncRoutineInput[] }): SyncApplyResult {
      const r = applyRoutines(payload.routines);
      return { ...r, botsImported: 0, botsRemoved: 0 };
    },
  };
}

export type SyncApply = ReturnType<typeof createSyncApply>;
