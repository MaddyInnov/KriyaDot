// SPDX-License-Identifier: Apache-2.0
// Tests for the message search components (P1 #16): snippet highlight
// rendering. Rendering is done via React.createElement (this repo's vitest
// setup doesn't transform JSX in test files); type-checking covers the
// component files themselves.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { HighlightedSnippet } from './message-search';

describe('HighlightedSnippet', () => {
  it('wraps marked terms in <mark>', () => {
    const html = renderToStaticMarkup(
      React.createElement(HighlightedSnippet, { snippet: 'how do I \x01train\x02 a parrot' }),
    );
    expect(html).toContain('<mark class="search-mark">train</mark>');
    expect(html).toContain('how do I ');
    expect(html).toContain(' a parrot');
    // No raw marker bytes leak into the output.
    expect(html).not.toContain('\x01');
    expect(html).not.toContain('\x02');
  });

  it('handles multiple matches', () => {
    const html = renderToStaticMarkup(
      React.createElement(HighlightedSnippet, { snippet: '\x01parrot\x02 training for \x01parrot\x02s' }),
    );
    expect((html.match(/<mark/g) ?? []).length).toBe(2);
  });

  it('renders plain text unchanged when there are no markers', () => {
    const html = renderToStaticMarkup(
      React.createElement(HighlightedSnippet, { snippet: 'plain snippet, no match info' }),
    );
    expect(html).toContain('plain snippet, no match info');
    expect(html).not.toContain('<mark');
  });

  it('escapes HTML in snippets (no injection via match text)', () => {
    const html = renderToStaticMarkup(
      React.createElement(HighlightedSnippet, { snippet: 'a <script>alert(1)</script> \x01x\x02' }),
    );
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<mark class="search-mark">x</mark>');
  });
});
