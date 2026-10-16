// SPDX-License-Identifier: Apache-2.0
// Tests for the MCP directory panel (OpenMausBot parity P1 #22): health
// dot mapping and the lazy-install explainer. Rendering is done via
// React.createElement (this repo's vitest setup doesn't transform JSX in
// test files); type-checking covers the component files themselves.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import McpDirectoryPanel, { HEALTH_DOT } from './mcp-directory-panel';

describe('HEALTH_DOT', () => {
  it('maps every health status to a distinct chip color', () => {
    expect(HEALTH_DOT).toEqual({
      stopped: 'gray',
      starting: 'amber',
      running: 'green',
      error: 'red',
    });
  });
});

describe('McpDirectoryPanel', () => {
  it('renders the lazy-install explainer before data loads', () => {
    const html = renderToStaticMarkup(React.createElement(McpDirectoryPanel));
    expect(html).toContain('Installing registers the server');
    expect(html).toContain('nothing downloads or runs until a bot');
    expect(html).toContain('Disabled servers never start');
    expect(html).toContain('Installed servers');
    expect(html).toContain('Directory');
  });
});
