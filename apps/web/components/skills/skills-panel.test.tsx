// SPDX-License-Identifier: Apache-2.0
// Tests for the skills panel (OpenMausBot parity P1 #20): status badges and
// scope labels. Rendering is done via React.createElement (this repo's
// vitest setup doesn't transform JSX in test files); type-checking covers
// the component files themselves.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { StatusBadge, scopeLabel } from './skills-panel';

describe('scopeLabel', () => {
  it('labels global scope', () => {
    expect(scopeLabel({ type: 'global' })).toBe('Global');
  });
  it('labels bot-scoped lists', () => {
    expect(scopeLabel({ type: 'bots', botIds: ['scout', 'coder'] })).toBe('Bots: scout, coder');
  });
  it('handles empty bot lists', () => {
    expect(scopeLabel({ type: 'bots', botIds: [] })).toBe('Bots: (none)');
  });
});

describe('StatusBadge', () => {
  it('renders the disabled-by-default states distinctly', () => {
    const draft = renderToStaticMarkup(React.createElement(StatusBadge, { status: 'draft' }));
    expect(draft).toContain('Draft proposal');
    const disabled = renderToStaticMarkup(React.createElement(StatusBadge, { status: 'disabled' }));
    expect(disabled).toContain('Disabled');
    const active = renderToStaticMarkup(React.createElement(StatusBadge, { status: 'active' }));
    expect(active).toContain('Active');
    const rejected = renderToStaticMarkup(React.createElement(StatusBadge, { status: 'rejected' }));
    expect(rejected).toContain('Rejected');
  });
});
