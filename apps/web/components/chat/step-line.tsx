// SPDX-License-Identifier: Apache-2.0
// Live step line + "Now" cards (W8a).
//
// StepLine renders under the streaming assistant message: the turn's
// current step ("Running read_file"), the step counter when known,
// and a ticking elapsed clock. NowCards renders the same live state
// per busy bot for the bot list/sidebar, fed by GET /api/chat/now.

'use client';

import React, { useEffect, useState } from 'react';
import type { CurrentTurnState } from '../../lib/api';
import { foldFinishedSteps, formatElapsed, nowCardLine, stepCounter, type StepLineState } from './step-state';

/** Slim live step line shown under a streaming message. */
export function StepLine({ state }: { state: StepLineState }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const elapsed = Math.max(state.elapsedMs, now - state.startedAt);
  const counter = stepCounter(state);
  return (
    <div className="step-line" role="status" aria-live="polite" style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, opacity: 0.75, marginTop: 4 }}>
      <span className="step-line-dot" aria-hidden="true">●</span>
      <span>{state.step}</span>
      {counter && <span className="muted">· {counter}</span>}
      <span className="muted">· {formatElapsed(elapsed)}</span>
    </div>
  );
}

/**
 * "Now" cards: one per busy bot, showing what it is doing right now.
 * Renders nothing when no bot is busy.
 */
export function NowCards({ turns }: { turns: CurrentTurnState[] }) {
  if (turns.length === 0) return null;
  return (
    <div className="now-cards" aria-label="Bots working now">
      {turns.map((turn) => (
        <div
          key={turn.sessionId}
          className="now-card"
          style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, padding: '4px 8px' }}
        >
          <span aria-hidden="true">●</span>
          <strong>{turn.botName ?? turn.botId}</strong>
          <span className="muted">{nowCardLine(turn)}</span>
        </div>
      ))}
    </div>
  );
}

/** Finished steps folded into one expandable summary line (chat polish). */
export function FinishedSteps({ steps }: { steps: string[] }) {
  const summary = foldFinishedSteps(steps);
  if (!summary) return null;
  return (
    <details className="finished-steps" style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>
      <summary style={{ cursor: 'pointer' }}>{summary.label}</summary>
      <ol style={{ margin: '4px 0 0 18px', padding: 0 }}>
        {summary.steps.map((s, i) => (<li key={i}>{s}</li>))}
      </ol>
    </details>
  );
}
