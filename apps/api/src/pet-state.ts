// SPDX-License-Identifier: Apache-2.0
// Floating-overlay pet state: GET /api/pet-state.
//
// Why this endpoint exists (Worker 4, Avatar Presence): the desktop pet
// overlay window must stay live while the main window is hidden, so it
// cannot read the main window's React state. No single existing endpoint
// yields an aggregate mood:
//   - GET /api/chat/now        → live chat turns only (no workflows/approvals)
//   - GET /api/workflows/runs  → workflow runs only
//   - GET /api/approvals       → pending approvals only
//   - GET /api/observability/runs → span-run history only (needs spanStore)
// This module aggregates those same stores into ONE tiny read-only
// payload the overlay polls (~1.5s). The aggregation itself is a pure
// function (computePetMood) so it is unit-testable without the router.
//
// Speaking: no RouteDeps source currently exposes "TTS is playing right
// now" (the realtime voice service tracks speaking internally but is not
// wired into RouteDeps), so `speakingActive` is always false today. The
// field + mood branch exist so wiring a real source later is a one-line
// change in collectPetStateInputs().

import express from 'express';
import type { WorkflowRunner } from '@mvp/workflows';

export type PetMoodName =
  | 'idle'
  | 'thinking'
  | 'working'
  | 'happy'
  | 'error'
  | 'sleeping'
  | 'speaking'
  | 'celebrating';

export interface PetStateInputs {
  /** Epoch ms "now" (injected for deterministic tests). */
  now: number;
  /** Live chat turns (agentRuntime.turnStates.list() shape). */
  activeTurns: Array<{ step?: string }>;
  /** Workflow runs currently in 'running' status. */
  workflowRunning: number;
  /** Workflow runs currently in 'paused' status (waiting on approval etc.). */
  workflowPaused: number;
  /** Approvals awaiting a user decision. */
  pendingApprovals: number;
  /** Chat messages queued behind an in-flight turn. */
  queued: number;
  /** True while TTS audio is actively playing (not yet exposed; see header). */
  speakingActive: boolean;
  /** Epoch ms the most recent run/turn finished, or null if none known. */
  lastCompletedAt: number | null;
  /** Outcome of that most recent finished run/turn. */
  lastOutcome: 'success' | 'failed' | 'cancelled' | 'needs-input' | null;
  /** Epoch ms of the most recent observed activity of any kind. */
  lastActivityAt: number | null;
}

/** How long a terminal outcome colours the mood before falling back. */
export const PET_RECENT_WINDOW_MS = 45_000;
/** Within the recent window, a fresh success celebrates (then just happy). */
export const PET_CELEBRATE_WINDOW_MS = 15_000;
/** No activity for this long → sleeping. */
export const PET_SLEEP_AFTER_MS = 5 * 60_000;

/**
 * Pure mood aggregation. Priority:
 *   speaking > active work (thinking step → thinking, else working)
 *   > workflow running > waiting (approvals/paused/queued → thinking)
 *   > recent terminal outcome (failed → error, success → celebrating/happy,
 *     needs-input → thinking) > sleeping after inactivity > idle.
 */
export function computePetMood(input: PetStateInputs): PetMoodName {
  if (input.speakingActive) return 'speaking';

  if (input.activeTurns.length > 0) {
    const thinking = input.activeTurns.some((t) =>
      (t.step ?? '').toLowerCase().includes('think'),
    );
    return thinking ? 'thinking' : 'working';
  }
  if (input.workflowRunning > 0) return 'working';

  if (input.pendingApprovals > 0 || input.workflowPaused > 0 || input.queued > 0) {
    return 'thinking'; // waiting on the user / on a boundary
  }

  if (input.lastCompletedAt != null && input.now - input.lastCompletedAt < PET_RECENT_WINDOW_MS) {
    if (input.lastOutcome === 'failed') return 'error';
    if (input.lastOutcome === 'needs-input') return 'thinking';
    if (input.lastOutcome === 'success') {
      return input.now - input.lastCompletedAt < PET_CELEBRATE_WINDOW_MS
        ? 'celebrating'
        : 'happy';
    }
  }

  if (input.lastActivityAt != null && input.now - input.lastActivityAt > PET_SLEEP_AFTER_MS) {
    return 'sleeping';
  }
  return 'idle';
}

export interface PetStateDeps {
  /** Live turn registry view (agentRuntime.turnStates). */
  turnStates: { list(): Array<{ step?: string; startedAt?: number; updatedAt?: number }> };
  workflowRunner: Pick<WorkflowRunner, 'listRuns'>;
  /** Pending-approval count source (governance gateway). */
  listApprovals: (status?: string) => Array<unknown>;
  /** Queued chat messages (chatQueueStore). */
  chatQueue: { list(sessionId?: string): Array<unknown> };
  /** Optional span-run history (observability store) for recent outcomes. */
  spanStore?: {
    listRuns(opts: { limit: number }): Array<{
      startedAt: number;
      endedAt: number | null;
      outcome: string | null;
    }>;
  };
  /** Clock override for tests. */
  now?: () => number;
}

/** Gather the aggregation inputs from the live stores. Never throws. */
export function collectPetStateInputs(deps: PetStateDeps): PetStateInputs {
  const now = (deps.now ?? Date.now)();
  let activeTurns: PetStateInputs['activeTurns'] = [];
  let lastActivityAt: number | null = null;
  try {
    const turns = deps.turnStates.list();
    activeTurns = turns;
    for (const t of turns) {
      const ts = Math.max(t.startedAt ?? 0, t.updatedAt ?? 0);
      if (ts > 0) lastActivityAt = Math.max(lastActivityAt ?? 0, ts);
    }
  } catch { /* a broken source degrades to idle, never a 500 */ }

  let workflowRunning = 0;
  let workflowPaused = 0;
  let lastCompletedAt: number | null = null;
  let lastOutcome: PetStateInputs['lastOutcome'] = null;
  try {
    const runs = deps.workflowRunner.listRuns();
    for (const run of runs) {
      if (run.status === 'running') workflowRunning += 1;
      else if (run.status === 'paused') workflowPaused += 1;
      else if (run.status === 'succeeded' || run.status === 'failed') {
        const ended = run.updatedAt ?? run.createdAt ?? 0;
        if (ended > 0 && (lastCompletedAt == null || ended > lastCompletedAt)) {
          lastCompletedAt = ended;
          lastOutcome = run.status === 'succeeded' ? 'success' : 'failed';
        }
      }
      const seen = run.updatedAt ?? run.createdAt ?? 0;
      if (seen > 0) lastActivityAt = Math.max(lastActivityAt ?? 0, seen);
    }
  } catch { /* ignore */ }

  try {
    if (deps.spanStore) {
      for (const run of deps.spanStore.listRuns({ limit: 20 })) {
        if (run.endedAt != null && run.outcome) {
          if (lastCompletedAt == null || run.endedAt > lastCompletedAt) {
            lastCompletedAt = run.endedAt;
            lastOutcome =
              run.outcome === 'success' ? 'success'
              : run.outcome === 'failed' ? 'failed'
              : run.outcome === 'needs-input' ? 'needs-input'
              : 'cancelled';
          }
          lastActivityAt = Math.max(lastActivityAt ?? 0, run.endedAt);
        } else if (run.startedAt > 0) {
          lastActivityAt = Math.max(lastActivityAt ?? 0, run.startedAt);
        }
      }
    }
  } catch { /* ignore */ }

  let pendingApprovals = 0;
  try {
    pendingApprovals = deps.listApprovals('pending').length;
  } catch { /* ignore */ }

  let queued = 0;
  try {
    queued = deps.chatQueue.list().length;
  } catch { /* ignore */ }

  return {
    now,
    activeTurns,
    workflowRunning,
    workflowPaused,
    pendingApprovals,
    queued,
    // Not exposed by any RouteDeps source yet — see module header.
    speakingActive: false,
    lastCompletedAt,
    lastOutcome,
    lastActivityAt,
  };
}

/** Register GET /pet-state (mounted under /api by the host router). */
export function registerPetStateRoutes(router: express.Router, deps: PetStateDeps): void {
  router.get('/pet-state', (_req, res) => {
    const inputs = collectPetStateInputs(deps);
    res.json({
      ok: true,
      mood: computePetMood(inputs),
      activeTurns: inputs.activeTurns.length,
      workflowRunning: inputs.workflowRunning,
      pendingApprovals: inputs.pendingApprovals,
      queued: inputs.queued,
      speakingActive: inputs.speakingActive,
      lastCompletedAt: inputs.lastCompletedAt,
      lastOutcome: inputs.lastOutcome,
      updatedAt: inputs.now,
    });
  });
}
