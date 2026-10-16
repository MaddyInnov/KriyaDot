// SPDX-License-Identifier: Apache-2.0
// C4: the tiny markdown renderer's link builder must not allow attribute
// breakout via `"` in the URL (esc() must escape `"` → `&quot;`).
import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from './lib';

function html(src: string): string {
  return renderToStaticMarkup(React.createElement(Markdown, { src }));
}

describe('Markdown link XSS (C4)', () => {
  it('escapes double quotes in link URLs so href cannot break out', () => {
    const out = html('[click](https://example.com/foo"bar)');
    expect(out).toContain('href="https://example.com/foo&quot;bar"');
    expect(out).not.toContain('foo"bar');
  });

  it('neutralizes an onmouseover breakout payload', () => {
    const out = html('[x](https://e.com/"onmouseover="alert(1))');
    expect(out).not.toContain('"onmouseover="');
    expect(out).toContain('&quot;onmouseover=&quot;');
  });

  it('still renders plain links normally', () => {
    const out = html('[docs](https://example.com/a?b=1)');
    expect(out).toContain('<a href="https://example.com/a?b=1" target="_blank" rel="noreferrer">docs</a>');
  });

  it('escapes quotes in link text too', () => {
    const out = html('[say "hi"](https://example.com/)');
    expect(out).toContain('say &quot;hi&quot;');
  });
});
