// SPDX-License-Identifier: Apache-2.0
// Pure helpers for the floating pet overlay (apps/web/app/overlay).
// Kept free of DOM/Tauri so they unit-test in plain vitest.

import type { PetMood, PetSettings } from '../../lib/pet';

/** Wire shape of GET /api/pet-state (apps/api/src/pet-state.ts). */
export interface PetStatePayload {
  ok: boolean;
  mood: PetMood;
  activeTurns: number;
  workflowRunning: number;
  pendingApprovals: number;
  queued: number;
  speakingActive: boolean;
  lastCompletedAt: number | null;
  lastOutcome: string | null;
  updatedAt: number;
}

const VALID_MOODS: ReadonlySet<string> = new Set([
  'idle', 'thinking', 'working', 'happy', 'error', 'sleeping', 'speaking', 'celebrating',
]);

/** Parse an unknown JSON body into a mood, or null when it is unusable. */
export function moodFromPayload(body: unknown): PetMood | null {
  if (!body || typeof body !== 'object') return null;
  const mood = (body as { mood?: unknown }).mood;
  return typeof mood === 'string' && VALID_MOODS.has(mood) ? (mood as PetMood) : null;
}

/**
 * Apply the user's pet settings to a server mood: the speaking and
 * celebration moods are opt-out-able in Preferences, so a disabled mood
 * degrades to its nearest calm equivalent instead of animating anyway.
 */
export function gateMood(mood: PetMood, settings: Pick<PetSettings, 'speaking' | 'celebration'>): PetMood {
  if (mood === 'speaking' && !settings.speaking) return 'idle';
  if (mood === 'celebrating' && !settings.celebration) return 'happy';
  return mood;
}

/** Pointer travel (px) beyond which a press counts as a drag, not a click. */
export const DRAG_THRESHOLD_PX = 6;
/** Long-press duration (ms) that opens the overlay menu. */
export const LONG_PRESS_MS = 600;

export type PressOutcome = 'click' | 'drag' | 'pending';

/** Classify a press from its start/end geometry. */
export function classifyPress(input: {
  dx: number;
  dy: number;
  durationMs: number;
  dragStarted: boolean;
}): PressOutcome {
  if (input.dragStarted) return 'drag';
  if (Math.hypot(input.dx, input.dy) > DRAG_THRESHOLD_PX) return 'drag';
  return 'click';
}

/** Poll cadence for /api/pet-state (matches the API module's design). */
export const PET_STATE_POLL_MS = 1500;
/** How often the overlay re-reads pet settings as a storage-event fallback. */
export const SETTINGS_RECHECK_MS = 2000;
