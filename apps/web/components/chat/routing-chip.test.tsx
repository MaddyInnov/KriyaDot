// SPDX-License-Identifier: Apache-2.0
// Routing chip tests: pure label helper + static rendering, following the
// provenance-chip.test.tsx style (React.createElement + renderToStaticMarkup,
// since this repo's vitest setup doesn't transform JSX in test files).

import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RoutingChip, routingChipLabel, type RoutingChipData } from './routing-chip';

const base: RoutingChipData = {
  path: 'direct',
  botId: 'anchor',
  botName: 'Scout',
  reason: 'General question — the anchor can answer directly.',
  confidence: 0.92,
  via: 'heuristic',
  sessionId: 'universal-1',
};

describe('routingChipLabel', () => {
  it('direct → sparkle + bot name', () => {
    expect(routingChipLabel(base, 'simple')).toBe('✦ Scout');
    expect(routingChipLabel(base, 'pro')).toBe('✦ Scout');
  });
  it('specialist → "Handled by" + bot name', () => {
    expect(routingChipLabel({ ...base, path: 'specialist', botName: 'Coder' }, 'simple')).toBe(
      '✦ Handled by Coder',
    );
  });
  it('split → subtask count when known (arg or routing field)', () => {
    const split = { ...base, path: 'split' as const };
    expect(routingChipLabel(split, 'simple', 3)).toBe('✦ Split into 3 subtasks · Scout');
    expect(routingChipLabel({ ...split, subtaskCount: 5 }, 'pro')).toBe('✦ Split into 5 subtasks · Scout');
    // An explicit argument wins over the count stored on the routing object.
    expect(routingChipLabel({ ...split, subtaskCount: 5 }, 'pro', 2)).toBe('✦ Split into 2 subtasks · Scout');
  });
  it('split → no count wording when the count is unknown', () => {
    expect(routingChipLabel({ ...base, path: 'split' }, 'simple')).toBe('✦ Split into subtasks · Scout');
    expect(routingChipLabel({ ...base, path: 'split' }, 'simple', 0)).toBe('✦ Split into subtasks · Scout');
  });
  it('falls back to "Universal" when the bot name is empty', () => {
    expect(routingChipLabel({ ...base, botName: '' }, 'simple')).toBe('✦ Universal');
  });
});

describe('RoutingChip', () => {
  it('renders the headline label and path marker', () => {
    const html = renderToStaticMarkup(React.createElement(RoutingChip, { routing: base }));
    expect(html).toContain('✦ Scout');
    expect(html).toContain('routing-chip');
    expect(html).toContain('data-path="direct"');
  });
  it('simple mode hides the router reason', () => {
    const html = renderToStaticMarkup(
      React.createElement(RoutingChip, { routing: base, mode: 'simple' as const }),
    );
    expect(html).not.toContain('routing-chip-reason');
    expect(html).not.toContain('anchor can answer directly');
  });
  it('pro mode appends the reason as a second, smaller line', () => {
    const html = renderToStaticMarkup(
      React.createElement(RoutingChip, { routing: base, mode: 'pro' as const }),
    );
    expect(html).toContain('routing-chip-reason');
    expect(html).toContain('anchor can answer directly');
  });
  it('pro mode omits the reason line when the reason is blank', () => {
    const html = renderToStaticMarkup(
      React.createElement(RoutingChip, { routing: { ...base, reason: '  ' }, mode: 'pro' as const }),
    );
    expect(html).not.toContain('routing-chip-reason');
  });
  it('split chip uses the subtask count stored on the routing data', () => {
    const html = renderToStaticMarkup(
      React.createElement(RoutingChip, {
        routing: { ...base, path: 'split' as const, subtaskCount: 4 },
      }),
    );
    expect(html).toContain('✦ Split into 4 subtasks · Scout');
  });
  it('an explicit subtaskCount prop wins over the stored count', () => {
    const html = renderToStaticMarkup(
      React.createElement(RoutingChip, {
        routing: { ...base, path: 'split' as const, subtaskCount: 4 },
        subtaskCount: 2,
      }),
    );
    expect(html).toContain('✦ Split into 2 subtasks · Scout');
  });
});
