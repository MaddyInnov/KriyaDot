// SPDX-License-Identifier: Apache-2.0
// XSS battery for the shared markdown renderer. This codebase has a
// stored-XSS history in a markdown renderer (2026-10-16 review), so
// every construct that can carry a payload gets a case: raw HTML,
// links, images, table cells, headings, code, math, footnotes.
// Contract, checked on the PARSED DOM (substring checks cannot tell a
// live attribute from escaped text): no script-capable elements, no
// on* handler attributes, no javascript:/vbscript:/data: URLs in any
// href/src. Payloads may survive as inert visible text — that is the
// renderer's documented behaviour for raw HTML.
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderMarkdownLite } from './markdown';

const DANGEROUS_TAGS = new Set(['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'BASE', 'LINK', 'META']);

function expectInert(html: string) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const el of doc.querySelectorAll('*')) {
    expect(DANGEROUS_TAGS.has(el.tagName)).toBe(false);
    for (const attr of el.attributes) {
      expect(attr.name.toLowerCase().startsWith('on')).toBe(false);
      if (attr.name === 'href' || attr.name === 'src' || attr.name === 'xlink:href') {
        expect(/^\s*(javascript|vbscript|data)\s*:/i.test(attr.value)).toBe(false);
      }
    }
  }
  return doc;
}

describe('renderMarkdownLite — XSS battery', () => {
  it('escapes raw HTML in prose', () => {
    const html = renderMarkdownLite('Hi <script>alert(1)</script> **there**');
    expectInert(html);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<strong>there</strong>');
  });

  it('neutralizes javascript: and vbscript: link targets', () => {
    expectInert(renderMarkdownLite('[click](javascript:alert(1))'));
    expectInert(renderMarkdownLite('[click](vbscript:msgbox)'));
    expect(renderMarkdownLite('[click](javascript:alert(1))')).toContain('click');
  });

  it('neutralizes dangerous image sources', () => {
    expectInert(renderMarkdownLite('![x](data:text/html;base64,PHNjcmlwdD4=)'));
    expectInert(renderMarkdownLite('![x](javascript:alert(1))'));
    const doc = expectInert(renderMarkdownLite('<img src=x onerror=alert(1)>'));
    // Raw HTML renders as text: no <img> element exists at all.
    expect(doc.querySelector('img')).toBeNull();
  });

  it('escapes HTML inside table cells but keeps formatting', () => {
    const html = renderMarkdownLite('| H |\n| --- |\n| <img src=x onerror=alert(1)> and **ok** |');
    const doc = expectInert(html);
    expect(doc.querySelector('td img')).toBeNull();
    expect(html).toContain('&lt;img');
    expect(html).toContain('<strong>ok</strong>');
  });

  it('escapes HTML in headings, list items and blockquotes', () => {
    expectInert(renderMarkdownLite('# <script>alert(1)</script>'));
    expectInert(renderMarkdownLite('- <iframe src="https://evil.example"></iframe>'));
    expectInert(renderMarkdownLite('> <svg onload=alert(1)>'));
  });

  it('keeps code fences inert even for HTML payloads', () => {
    const html = renderMarkdownLite('```html\n<iframe src="https://evil.example"></iframe>\n```');
    const doc = expectInert(html);
    expect(doc.querySelector('iframe')).toBeNull();
    expect(html).toContain('&lt;');
  });

  it('strips event handlers and style-based payloads from any construct', () => {
    expectInert(renderMarkdownLite('[a](https://ok.example "t" ) <b onclick="x()">y</b>'));
    expectInert(renderMarkdownLite('<a href="https://ok.example" onclick="steal()">link</a>'));
    expectInert(renderMarkdownLite('<div style="xss:expression(alert(1))">z</div>'));
  });

  it('math input cannot inject markup', () => {
    expectInert(renderMarkdownLite('$<script>alert(1)</script>$'));
  });

  it('footnote bodies cannot inject markup', () => {
    expectInert(renderMarkdownLite('Ref[^1]\n\n[^1]: <script>alert(1)</script>'));
  });

  it('link titles cannot break out of the attribute', () => {
    const doc = expectInert(renderMarkdownLite('[a](https://ok.example "x\\" onclick=\\"evil")'));
    const a = doc.querySelector('a');
    expect(a?.getAttribute('href')).toBe('https://ok.example');
    expect(a?.getAttribute('onclick')).toBeNull();
  });
});
