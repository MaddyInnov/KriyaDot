// SPDX-License-Identifier: Apache-2.0
// Chief default watch routine: an idempotent boot-time bootstrap that
// gives the workspace's Chief bot ONE standing daily watch routine
// ("Chief daily watch") unless one already exists or the workspace has
// opted out.
//
// State lives in a small flag file (<dataDir>/chief-default-watch.json):
//   { optedOut?: boolean, bootstrappedAt?: number, routineId?: string }
// The bootstrapped marker matters: if the user later DELETES the routine,
// the bootstrap does not resurrect it on the next boot — deletion was a
// decision. Opting out is likewise sticky until the flag is flipped back.
//
// HOST WIRING (index.ts, after the chief overlay is applied):
//   ensureChiefDefaultWatch({
//     dataDir: config.dataDir,
//     getChiefBotId: () => chiefTeamsStore.getConfig().chiefBotId,
//     routines: routineStore,
//     audit: (a, f) => governance.audit(a, f),
//   });

import fs from 'node:fs';
import path from 'node:path';
import type { BotRoutine, RoutineStore } from './bot-routines.js';
import type { RoutineSchedule } from './routine-schedules.js';

export const CHIEF_WATCH_ROUTINE_NAME = 'Chief daily watch';
export const CHIEF_WATCH_FLAG_FILE = 'chief-default-watch.json';

export const CHIEF_WATCH_PROMPT =
  'Run your daily watch: review every team\'s recent activity, open approvals, failed runs and ' +
  'unanswered questions. Summarize what needs the user\'s attention today, flag anything blocked, ' +
  'and propose next steps. Keep it to a short brief — no filler.';

export const CHIEF_WATCH_SCHEDULE: RoutineSchedule = {
  kind: 'daily',
  time: '08:00',
  weekdays: [0, 1, 2, 3, 4, 5, 6],
  timezone: 'UTC',
  enabled: true,
  overlap: 'skip',
};

export interface ChiefWatchFlag {
  optedOut?: boolean;
  bootstrappedAt?: number;
  routineId?: string;
}

export function chiefWatchFlagPath(dataDir: string): string {
  return path.join(dataDir, CHIEF_WATCH_FLAG_FILE);
}

export function readChiefWatchFlag(dataDir: string): ChiefWatchFlag {
  try {
    const parsed = JSON.parse(fs.readFileSync(chiefWatchFlagPath(dataDir), 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as ChiefWatchFlag;
  } catch {
    // missing/corrupt → no flag recorded
  }
  return {};
}

export function writeChiefWatchFlag(dataDir: string, flag: ChiefWatchFlag): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = chiefWatchFlagPath(dataDir);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(flag, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/** Persist the workspace's opt-out choice (Settings toggle). */
export function setChiefWatchOptOut(dataDir: string, optedOut: boolean): ChiefWatchFlag {
  const flag = { ...readChiefWatchFlag(dataDir), optedOut };
  writeChiefWatchFlag(dataDir, flag);
  return flag;
}

export interface ChiefDefaultWatchDeps {
  dataDir: string;
  /** The workspace's Chief bot id, or null when no Chief is configured. */
  getChiefBotId: () => string | null;
  /** Routine store (only list + create are used). */
  routines: Pick<RoutineStore, 'list' | 'create'>;
  audit?: (action: string, fields: { actor?: string; detail?: unknown }) => void;
  /** Clock injection for tests. */
  now?: () => number;
}

export type ChiefDefaultWatchOutcome =
  | { created: true; routine: BotRoutine }
  | {
      created: false;
      reason: 'opted-out' | 'no-chief' | 'exists' | 'already-bootstrapped';
      routine?: BotRoutine;
    };

/**
 * Ensure the Chief's default watch routine exists. Safe to call on every
 * boot: it creates at most one routine, ever, per workspace.
 */
export function ensureChiefDefaultWatch(deps: ChiefDefaultWatchDeps): ChiefDefaultWatchOutcome {
  const flag = readChiefWatchFlag(deps.dataDir);
  if (flag.optedOut) return { created: false, reason: 'opted-out' };

  const chiefBotId = deps.getChiefBotId();
  if (!chiefBotId) return { created: false, reason: 'no-chief' };

  const existing = deps.routines
    .list()
    .find((r) => r.botId === chiefBotId && r.name === CHIEF_WATCH_ROUTINE_NAME);
  if (existing) {
    if (!flag.bootstrappedAt) {
      writeChiefWatchFlag(deps.dataDir, { ...flag, bootstrappedAt: (deps.now ?? Date.now)(), routineId: existing.id });
    }
    return { created: false, reason: 'exists', routine: existing };
  }
  if (flag.bootstrappedAt) {
    // We created it once and it's gone — the user deleted it. Respect that.
    return { created: false, reason: 'already-bootstrapped' };
  }

  const routine = deps.routines.create({
    name: CHIEF_WATCH_ROUTINE_NAME,
    botId: chiefBotId,
    promptTemplate: CHIEF_WATCH_PROMPT,
    schedule: CHIEF_WATCH_SCHEDULE,
  });
  writeChiefWatchFlag(deps.dataDir, {
    ...flag,
    bootstrappedAt: (deps.now ?? Date.now)(),
    routineId: routine.id,
  });
  deps.audit?.('chief.default_watch_created', {
    actor: 'system',
    detail: { routineId: routine.id, botId: chiefBotId },
  });
  return { created: true, routine };
}
