// SPDX-License-Identifier: Apache-2.0
// The shared chat markdown renderer (used by the file preview pane AND
// assistant message text): pin the constructs model answers actually
// use, and the escape-first safety contract.
import { describe, expect, it } from 'vitest';
import { renderMarkdownLite } from './markdown';

describe('renderMarkdownLite (shared chat markdown renderer)', () => {
  it('renders headings one level deeper (pane convention)', () => {
    expect(renderMarkdownLite('# Title')).toBe('<h2>Title</h2>');
    expect(renderMarkdownLite('### Snapshot')).toBe('<h4>Snapshot</h4>');
  });

  it('renders bold, italic and inline code', () => {
    expect(renderMarkdownLite('Some **bold** and *italic* and `code`')).toBe(
      '<p>Some <strong>bold</strong> and <em>italic</em> and <code>code</code></p>',
    );
  });

  it('renders bullet lists as <ul><li>', () => {
    expect(renderMarkdownLite('- one\n- two')).toBe('<ul>\n<li>one</li>\n<li>two</li>\n</ul>');
    expect(renderMarkdownLite('* **Web search** – fetch pages')).toBe(
      '<ul>\n<li><strong>Web search</strong> – fetch pages</li>\n</ul>',
    );
  });

  it('renders fenced code blocks escaped, in a .md-pre', () => {
    expect(renderMarkdownLite('```\nconst a = 1 < 2;\n```')).toBe(
      '<pre class="md-pre">const a = 1 &lt; 2;</pre>',
    );
  });

  it('renders links with safe attributes', () => {
    expect(renderMarkdownLite('See [docs](https://example.com/x)')).toBe(
      '<p>See <a href="https://example.com/x" target="_blank" rel="noreferrer">docs</a></p>',
    );
  });

  it('escapes raw HTML so model/file text cannot inject markup', () => {
    const html = renderMarkdownLite('Hi <script>alert(1)</script> **there**');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<strong>there</strong>');
  });

  it('keeps plain prose as paragraphs (no markers invented)', () => {
    expect(renderMarkdownLite('Just a sentence.')).toBe('<p>Just a sentence.</p>');
  });
});
