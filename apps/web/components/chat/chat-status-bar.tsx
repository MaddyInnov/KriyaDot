// SPDX-License-Identifier: Apache-2.0
'use client';

// Harness-style chat status bar (2026-10-31 minimal-UI redesign): one
// slim line under the composer —
//   N turns · M steps · X tok/s · Σ tokens · Cache hit Y% · Context Z%
// with a small gauge for context fill. Metrics the page cannot know
// (live rate outside a stream, cache fields the provider did not
// report, context length of an unknown model) arrive as null and
// render an honest "–" — never a fabricated number.

import React from 'react';

export interface ChatStatusBarProps {
  turns: number;
  steps: number;
  /** Rolling output rate while streaming; null when not measurable. */
  liveTokPerSec: number | null;
  totalTokens: number;
  /** cacheReadTokens / promptTokens across the session; null when no block reported cache fields. */
  cacheHitPct: number | null;
  /** Context-window fill (contextMeter pct); null when the model's context length is unknown. */
  contextPct: number | null;
}

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

function fmtPct(p: number | null): string {
  return p === null ? '–' : `${Math.round(p)}%`;
}

export function ChatStatusBar({
  turns,
  steps,
  liveTokPerSec,
  totalTokens,
  cacheHitPct,
  contextPct,
}: ChatStatusBarProps) {
  const gaugePct = contextPct === null ? 0 : Math.max(0, Math.min(100, contextPct));
  return (
    <div className="chat-status-bar" role="status" aria-label="Session status">
      <span data-metric="turns">{turns} turns</span>
      <span className="csb-sep" aria-hidden="true">·</span>
      <span data-metric="steps">{steps} steps</span>
      <span className="csb-sep" aria-hidden="true">·</span>
      <span data-metric="tokPerSec">
        {liveTokPerSec === null ? '– tok/s' : `${fmtInt(liveTokPerSec)} tok/s`}
      </span>
      <span className="csb-sep" aria-hidden="true">·</span>
      <span data-metric="totalTokens">Σ {fmtInt(totalTokens)} tokens</span>
      <span className="csb-sep" aria-hidden="true">·</span>
      <span data-metric="cacheHit">Cache hit {fmtPct(cacheHitPct)}</span>
      <span className="csb-sep" aria-hidden="true">·</span>
      <span data-metric="context">Context {fmtPct(contextPct)}</span>
      {contextPct !== null && (
        <span
          className={`csb-gauge${gaugePct >= 85 ? ' warn' : ''}`}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(gaugePct)}
          aria-label="Context window used"
        >
          <span className="csb-gauge-fill" style={{ width: `${gaugePct}%` }} />
        </span>
      )}
    </div>
  );
}
