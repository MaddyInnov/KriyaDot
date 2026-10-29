// SPDX-License-Identifier: Apache-2.0
// Token & cost chip per chat (chat polish): totals from the session
// usage/cost state the chat page already tracks (done-event usage).

'use client';

import React from 'react';
import { COST_ESTIMATE_TOOLTIP, formatTokens, formatUsd } from '../../lib/usage';
import type { TokenUsage } from '../../lib/api';

export function TokenCostChip({ usage, costUsd }: { usage?: TokenUsage; costUsd?: number }) {
  if (!usage) return <span className="muted token-cost-chip">No usage yet</span>;
  return (
    <span className="mono token-cost-chip" title={`In ${usage.promptTokens} · Out ${usage.completionTokens}`}>
      Σ {formatTokens(usage.totalTokens)} tok
      {costUsd !== undefined && <span title={COST_ESTIMATE_TOOLTIP}> · ≈{formatUsd(costUsd)}</span>}
    </span>
  );
}
