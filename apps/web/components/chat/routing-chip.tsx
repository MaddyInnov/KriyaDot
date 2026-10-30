// SPDX-License-Identifier: Apache-2.0
// Routing chip for Universal Chat: a small pill on the assistant message
// header naming which bot handled the turn (and, for split turns, how many
// subtasks it was decomposed into). Pro mode adds the router's reason as a
// second, smaller line; Simple mode stays calm with just the headline.

'use client';

import React from 'react';
import type { UniversalRouting } from '../../lib/api';

/** Routing info as stored on an assistant chat block (routing frame + split count). */
export type RoutingChipData = Omit<UniversalRouting, 'sessionId'> & {
  sessionId?: string;
  subtaskCount?: number;
};

/**
 * Pure headline label for a routing decision:
 * - direct:     `✦ <bot>`
 * - specialist: `✦ Handled by <bot>`
 * - split:      `✦ Split into <n> subtasks · <bot>` (n known) or
 *               `✦ Split into subtasks · <bot>` (n unknown)
 * `mode` is accepted so callers pass their UX mode through; the headline
 * itself is identical in both modes — Pro mode's extra reason line is
 * rendered by the component, not baked into the label.
 */
export function routingChipLabel(
  routing: Pick<RoutingChipData, 'path' | 'botName' | 'subtaskCount'>,
  mode: 'simple' | 'pro',
  subtaskCount?: number,
): string {
  void mode;
  const botName = routing.botName || 'Universal';
  if (routing.path === 'specialist') return `✦ Handled by ${botName}`;
  if (routing.path === 'split') {
    const n = subtaskCount ?? routing.subtaskCount ?? 0;
    return n > 0 ? `✦ Split into ${n} subtasks · ${botName}` : `✦ Split into subtasks · ${botName}`;
  }
  return `✦ ${botName}`;
}

/**
 * The chip itself. Renders the headline pill; in Pro mode a non-empty
 * router reason appears beneath it in smaller, muted text.
 */
export function RoutingChip({
  routing,
  mode = 'simple',
  subtaskCount,
}: {
  routing: RoutingChipData;
  mode?: 'simple' | 'pro';
  subtaskCount?: number;
}) {
  const count = subtaskCount ?? routing.subtaskCount;
  const label = routingChipLabel(routing, mode, count);
  const showReason = mode === 'pro' && typeof routing.reason === 'string' && routing.reason.trim().length > 0;
  return (
    <span
      className="routing-chip"
      data-path={routing.path}
      title={`Routed ${routing.path} via ${routing.via || 'router'} · confidence ${routing.confidence}`}
    >
      <span className="routing-chip-label">{label}</span>
      {showReason ? <span className="routing-chip-reason">{routing.reason}</span> : null}
    </span>
  );
}
