// SPDX-License-Identifier: Apache-2.0
// Conformance battery for the shared markdown renderer (chat messages +
// file preview pane): one test per construct a model answer can contain,
// at Claude-chat parity — full CommonMark + GFM via marked, highlight.js
// code blocks, KaTeX math, GFM footnotes, DOMPurify-sanitized output.
// Safety cases live in markdown-security.test.ts, table cases in
// markdown-tables.test.ts, streaming partials in markdown-streaming.test.ts.
// @vitest-environment jsdom (DOMPurify binds to the window, as in the app)
import { describe, expect, it } from 'vitest';
import { renderMarkdownLite } from './markdown';

describe('renderMarkdownLite — structure', () => {
  it('renders headings one level deeper (pane convention)', () => {
    expect(renderMarkdownLite('# Title').trim()).toBe('<h2>Title</h2>');
    expect(renderMarkdownLite('### Snapshot').trim()).toBe('<h4>Snapshot</h4>');
  });

  it('renders bold, italic, strikethrough and inline code', () => {
    expect(renderMarkdownLite('Some **bold** and *italic* and `code`').trim()).toBe(
      '<p>Some <strong>bold</strong> and <em>italic</em> and <code>code</code></p>',
    );
    expect(renderMarkdownLite('~~gone~~').trim()).toBe('<p><del>gone</del></p>');
  });

  it('renders bullet and ordered lists, including nesting', () => {
    expect(renderMarkdownLite('- one\n- two').trim()).toBe('<ul>\n<li>one</li>\n<li>two</li>\n</ul>');
    expect(renderMarkdownLite('1. first\n2. second').trim()).toBe('<ol>\n<li>first</li>\n<li>second</li>\n</ol>');
    const nested = renderMarkdownLite('- a\n  - b\n    - c');
    expect(nested.match(/<ul>/g)).toHaveLength(3);
    expect(nested).toContain('<li>c</li>');
  });

  it('renders GFM task lists as disabled checkboxes', () => {
    const html = renderMarkdownLite('- [ ] todo\n- [x] done');
    expect(html).toContain('<input disabled="" type="checkbox">');
    expect(html).toContain('<input checked="" disabled="" type="checkbox">');
  });

  it('renders blockquotes, including nested ones', () => {
    const html = renderMarkdownLite('> quoted\n> > nested');
    expect(html.match(/<blockquote>/g)).toHaveLength(2);
    expect(html).toContain('<p>nested</p>');
  });

  it('renders horizontal rules and hard line breaks', () => {
    expect(renderMarkdownLite('above\n\n---\n\nbelow')).toContain('<hr>');
    expect(renderMarkdownLite('line one\nline two').trim()).toBe('<p>line one<br>line two</p>');
  });

  it('keeps plain prose as paragraphs (no markers invented)', () => {
    expect(renderMarkdownLite('Just a sentence.').trim()).toBe('<p>Just a sentence.</p>');
  });
});

describe('renderMarkdownLite — links and images', () => {
  it('renders links with safe attributes', () => {
    expect(renderMarkdownLite('See [docs](https://example.com/x)').trim()).toBe(
      '<p>See <a href="https://example.com/x" target="_blank" rel="noreferrer">docs</a></p>',
    );
  });

  it('autolinks bare URLs', () => {
    const html = renderMarkdownLite('visit https://example.com now');
    expect(html).toContain('<a href="https://example.com" target="_blank" rel="noreferrer">https://example.com</a>');
  });

  it('renders images constrained and lazy, with alt text', () => {
    const html = renderMarkdownLite('![alt text](https://example.com/i.png)');
    expect(html).toContain('<img src="https://example.com/i.png" alt="alt text" loading="lazy">');
  });
});

describe('renderMarkdownLite — code blocks', () => {
  it('wraps fences in a code block with language label and Copy button', () => {
    const html = renderMarkdownLite('```ts\nconst x: number = 1;\n```');
    expect(html).toContain('<div class="md-codeblock">');
    expect(html).toContain('<span class="md-codeblock-lang">ts</span>');
    expect(html).toContain('data-md-copy');
    expect(html).toContain('>Copy</button>');
    expect(html).toContain('<pre class="md-pre"><code class="hljs language-ts">');
  });

  it('syntax-highlights known languages and escapes unknown ones', () => {
    const ts = renderMarkdownLite('```ts\nconst x = 1;\n```');
    expect(ts).toContain('<span class="hljs-keyword">const</span>');
    const plain = renderMarkdownLite('```\nconst a = 1 < 2;\n```');
    expect(plain).toContain('<span class="md-codeblock-lang">text</span>');
    expect(plain).toContain('const a = 1 &lt; 2;');
    expect(plain).not.toContain('<script');
  });

  it('does not execute HTML inside a fence', () => {
    const html = renderMarkdownLite('```html\n<script>alert(1)</script>\n```');
    // Highlighted as syntax: the payload is escaped text inside hljs
    // spans, never a live element.
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;');
    expect(html).toContain('hljs-name');
  });
});

describe('renderMarkdownLite — math (KaTeX)', () => {
  it('renders inline math', () => {
    const html = renderMarkdownLite('Energy is $E = mc^2$ here');
    expect(html).toContain('<span class="md-math">');
    expect(html).toContain('class="katex"');
    expect(html).not.toContain('$E = mc^2$');
  });

  it('renders block math', () => {
    const html = renderMarkdownLite('$$\n\\frac{a}{b}\n$$');
    expect(html).toContain('<div class="md-math-block">');
    expect(html).toContain('class="katex"');
  });

  it('leaves currency amounts as plain text', () => {
    expect(renderMarkdownLite('It costs $5 and $10 total').trim()).toBe('<p>It costs $5 and $10 total</p>');
  });

  it('degrades invalid TeX to a visible error span instead of throwing', () => {
    const html = renderMarkdownLite('$\\frac{1$');
    expect(html).toContain('katex-error');
  });
});

describe('renderMarkdownLite — footnotes', () => {
  it('renders GFM footnotes with back-references', () => {
    const html = renderMarkdownLite('Text[^1]\n\n[^1]: The note');
    expect(html).toContain('data-footnote-ref');
    expect(html).toContain('<section class="footnotes"');
    expect(html).toContain('The note');
  });
});
