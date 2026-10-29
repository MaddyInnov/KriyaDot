// SPDX-License-Identifier: Apache-2.0
// Live step line state (W8a) — pure helpers shared by the chat page
// (step line under the streaming message) and the "Now" cards in the
// bot sidebar. No React here so the reducer can be unit-tested.

import type { CurrentTurnState, StreamEvent } from '../../lib/api';

export type StepEvent = Extract<StreamEvent, { type: 'step' }>;

/** The step-line view of one running turn. */
export interface StepLineState {
  botId: string;
  sessionId: string;
  step: string;
  stepIndex?: number;
  stepTotal?: number;
  startedAt: number;
  elapsedMs: number;
}

/** Fold a `step` stream event into the current step-line state. */
export function applyStepEvent(prev: StepLineState | undefined, event: StepEvent): StepLineState {
  return {
    botId: event.botId,
    sessionId: event.sessionId,
    step: event.step,
    stepIndex: event.stepIndex,
    stepTotal: event.stepTotal,
    startedAt: event.startedAt,
    elapsedMs: event.elapsedMs,
  };
}

/** "Step 2 of 8" suffix when the counts are known. */
export function stepCounter(state: Pick<StepLineState, 'stepIndex' | 'stepTotal'>): string | undefined {
  if (state.stepIndex === undefined) return undefined;
  return state.stepTotal !== undefined ? `step ${state.stepIndex} of ${state.stepTotal}` : `step ${state.stepIndex}`;
}

/** Format an elapsed duration like the server does ("12s", "2m 05s"). */
export function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m ${String(sec).padStart(2, '0')}s`;
}

/** One-line summary for a Now card: "Running read_file · step 2 of 8 · 41s". */
export function nowCardLine(turn: CurrentTurnState): string {
  const parts = [turn.step];
  const counter = stepCounter(turn);
  if (counter) parts.push(counter);
  parts.push(formatElapsed(turn.elapsedMs));
  return parts.join(' · ');
}
