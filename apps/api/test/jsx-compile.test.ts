// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { JsxCompileError, compileJsxToHtml } from '../src/jsx-compile.js';
import { sanitizeHtmlArtifact } from '../src/public-pages.js';

describe('compileJsxToHtml', () => {
  it('compiles nested elements, text, and fragments', () => {
    const html = compileJsxToHtml(
      '<><div><h1>Hello</h1><p>World <strong>bold</strong></p></div></>',
    );
    expect(html).toBe('<div><h1>Hello</h1><p>World <strong>bold</strong></p></div>');
  });

  it('maps className/htmlFor and compiles string + expression attributes', () => {
    const html = compileJsxToHtml(
      `<label className="lbl" htmlFor="email" data-count={42} hidden={true}>Email</label>`,
    );
    expect(html).toBe('<label class="lbl" for="email" data-count="42" hidden>Email</label>');
  });

  it('compiles style objects to inline styles with kebab-case keys', () => {
    const html = compileJsxToHtml(
      `<p style={{ color: 'red', fontSize: '14px', marginTop: 4 }}>x</p>`,
    );
    expect(html).toBe('<p style="color: red; font-size: 14px; margin-top: 4">x</p>');
  });

  it('supports self-closing tags, literal expressions, and ternaries over literals', () => {
    expect(compileJsxToHtml('<div><br /><hr /></div>')).toBe('<div><br><hr></div>');
    expect(compileJsxToHtml(`<p>{'count: '}{7}</p>`)).toBe('<p>count: 7</p>');
    expect(compileJsxToHtml(`<p>{true ? 'yes' : 'no'}</p>`)).toBe('<p>yes</p>');
    expect(compileJsxToHtml(`<p>{'' ? 'yes' : 'no'}</p>`)).toBe('<p>no</p>');
  });

  it('strips comments and escapes text/attribute values', () => {
    expect(compileJsxToHtml('<div>{/* note */}a &lt; b</div>')).toBe('<div>a &lt; b</div>');
    const html = compileJsxToHtml('<p title={"a<b"}>{"<script>"}</p>');
    expect(html).toBe('<p title="a&lt;b">&lt;script&gt;</p>');
  });

  it('rejects components, scripts, handlers, spreads, and arbitrary expressions', () => {
    expect(() => compileJsxToHtml('<Widget />')).toThrow(JsxCompileError);
    expect(() => compileJsxToHtml('<Widget />')).toThrow(/component/);
    expect(() => compileJsxToHtml('<script>alert(1)</script>')).toThrow(/not allowed/);
    expect(() => compileJsxToHtml('<button onClick="x()">b</button>')).toThrow(/event-handler/);
    expect(() => compileJsxToHtml('<div {...props}></div>')).toThrow(/spread/);
    expect(() => compileJsxToHtml('<p>{user.name}</p>')).toThrow(/empty scope/);
    expect(() => compileJsxToHtml('<p>{1 + 2}</p>')).toThrow(/expected "}"/);
    expect(() => compileJsxToHtml('<div><p></div>')).toThrow(/mismatched/);
    expect(() => compileJsxToHtml('<div>')).toThrow(/unclosed/);
  });

  it('sanitizer still strips payloads smuggled via JSX attrs/text', () => {
    const compiled = compileJsxToHtml(
      `<div><a href="javascript:alert(1)">x</a><img src="https://e.example/a.png" /></div>`,
    );
    const clean = sanitizeHtmlArtifact(compiled);
    expect(clean).not.toContain('javascript:');
    expect(clean).toContain('https://e.example/a.png');
    // A payload assembled from literal concatenation pieces stays inert text.
    const textPayload = sanitizeHtmlArtifact(compileJsxToHtml(`<p>{'<img src=x onerror=alert(1)>'}</p>`));
    expect(textPayload).not.toContain('<img');
  });
});
