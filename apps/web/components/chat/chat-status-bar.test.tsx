// SPDX-License-Identifier: Apache-2.0
// Chat status bar tests, following routing-chip.test.tsx style
// (React.createElement + renderToStaticMarkup — this repo's vitest
// setup doesn't transform JSX in test files).

import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatStatusBar } from './chat-status-bar';

const full = {
  turns: 3,
  steps: 12,
  liveTokPerSec: 42.4,
  totalTokens: 123456,
  cacheHitPct: 37.5,
  contextPct: 62.3,
};

describe('ChatStatusBar', () => {
  it('renders the full harness line with all metrics', () => {
    const html = renderToStaticMarkup(React.createElement(ChatStatusBar, full));
    expect(html).toContain('chat-status-bar');
    expect(html).toContain('3 turns');
    expect(html).toContain('12 steps');
    expect(html).toContain('42 tok/s');
    expect(html).toContain('Σ 123,456 tokens');
    expect(html).toContain('Cache hit 38%');
    expect(html).toContain('Context 62%');
  });

  it('renders the context gauge with the clamped fill width', () => {
    const html = renderToStaticMarkup(React.createElement(ChatStatusBar, full));
    expect(html).toContain('csb-gauge');
    expect(html).toContain('width:62.3%');
    expect(html).toContain('aria-valuenow="62"');
  });

  it('null metrics render an honest dash, never a fabricated number', () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatStatusBar, {
        turns: 0,
        steps: 0,
        liveTokPerSec: null,
        totalTokens: 0,
        cacheHitPct: null,
        contextPct: null,
      }),
    );
    expect(html).toContain('0 turns');
    expect(html).toContain('– tok/s');
    expect(html).toContain('Cache hit –');
    expect(html).toContain('Context –');
    expect(html).not.toContain('csb-gauge');
    expect(html).not.toContain('NaN');
  });

  it('context over 100% is clamped in the gauge but shown honestly in text', () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatStatusBar, { ...full, contextPct: 140 }),
    );
    expect(html).toContain('Context 140%');
    expect(html).toContain('width:100%');
    expect(html).toContain('csb-gauge warn');
  });

  it('fractional tok/s rounds to a whole rate', () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatStatusBar, { ...full, liveTokPerSec: 7.6 }),
    );
    expect(html).toContain('8 tok/s');
  });
});
