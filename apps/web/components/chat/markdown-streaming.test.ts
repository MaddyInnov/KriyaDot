// SPDX-License-Identifier: Apache-2.0
// Streaming-partial battery: chat re-renders the message on every token,
// so renderMarkdownLite sees every prefix of an answer. Contract: no
// prefix ever throws, output is always a string of sane HTML, and the
// complete input renders the full construct.
// @vitest-environment jsdom (DOMPurify binds to the window, as in the app)
import { describe, expect, it } from 'vitest';
import { renderMarkdownLite } from './markdown';

const FULL = [
  '## Report',
  '',
  'Intro with **bold** and $x^2$ inline.',
  '',
  '| Col | Val |',
  '| :--- | ---: |',
  '| a | 1 |',
  '| b | 2 |',
  '',
  '```ts',
  'const total = 3;',
  '```',
  '',
  '$$\nE = mc^2\n$$',
  '',
  '- [x] done',
].join('\n');

describe('renderMarkdownLite — streaming partials', () => {
  it('never throws on any prefix of a dense answer', () => {
    for (let i = 0; i <= FULL.length; i++) {
      const out = renderMarkdownLite(FULL.slice(0, i));
      expect(typeof out).toBe('string');
    }
  });

  it('renders the complete answer with every construct', () => {
    const html = renderMarkdownLite(FULL);
    expect(html).toContain('<table>');
    expect(html).toContain('md-codeblock');
    expect(html).toContain('class="katex"');
    expect(html).toContain('type="checkbox"');
  });

  it('renders an unclosed fence as a partial code block', () => {
    const html = renderMarkdownLite('```py\nprint(1');
    expect(html).toContain('md-codeblock');
    expect(html).toContain('print');
  });

  it('renders a header-only table without a body', () => {
    const html = renderMarkdownLite('| A | B |\n| --- | --- |');
    expect(html).toContain('<table>');
    expect(html).toContain('<th>A</th>');
    expect(html).not.toContain('<td>');
  });

  it('keeps a half-arrived table row out until it lands, then includes it', () => {
    const before = renderMarkdownLite('| A |\n| --- |\n| par');
    expect(before).toContain('<table>');
    const after = renderMarkdownLite('| A |\n| --- |\n| partial |');
    expect(after).toContain('<td>partial</td>');
  });

  it('leaves unterminated math as literal text (no half-rendered KaTeX)', () => {
    const html = renderMarkdownLite('Value $x^2');
    expect(html).not.toContain('class="katex"');
    expect(html).toContain('Value $x^2');
  });

  it('handles empty and whitespace-only input', () => {
    expect(renderMarkdownLite('')).toBe('');
    expect(typeof renderMarkdownLite('  \n\n')).toBe('string');
  });
});
