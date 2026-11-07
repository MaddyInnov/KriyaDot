// SPDX-License-Identifier: Apache-2.0
// Shared markdown renderer for chat + the file preview pane (ONE
// implementation — both consumers render through renderMarkdownLite).
//
// Full renderer (2026-11-07, Claude-chat parity pass): CommonMark + GFM
// via `marked` (tables with alignment, task lists, strikethrough,
// autolinks), syntax highlighting via highlight.js, LaTeX math via KaTeX
// (marked extension below), GFM footnotes via marked-footnote, and code
// blocks wrapped with a language label + Copy button (the click is
// handled by handleMarkdownCopyClick, delegated from the container).
//
// XSS is the hard gate (this codebase has a stored-XSS history in a
// markdown renderer — 2026-10-16 review). Three layers:
//  1. Custom renderers escape raw HTML tokens to inert text and only
//     emit links/images for an allowlist of protocols (http/https,
//     mailto, in-page anchors, relative paths). javascript:/data:/etc.
//     never reach an href/src.
//  2. KaTeX runs with throwOnError:false and its input is TeX, not HTML.
//  3. The final HTML passes through DOMPurify with its default
//     allowlist profile before any dangerouslySetInnerHTML. (Plain
//     `dompurify`, not the isomorphic build: isomorphic-dompurify drags
//     jsdom + native canvas binaries into the webpack client bundle and
//     breaks `next build`. Every consumer of this module is a client
//     component in a static export, so a window always exists when
//     messages actually render; the one server-side pass — static
//     prerender of the empty chat shell — never invokes the renderer
//     with content, and sanitizeHtml() also guards for that case.)
// Streaming-safe: marked never throws on partial input, unclosed
// fences/tables/math degrade to partial-but-sane HTML and settle when
// the stream completes; the whole render is additionally wrapped so an
// unexpected parser error falls back to escaped plain text.

import { Marked, type RendererObject, type Tokens } from 'marked';
import markedFootnote from 'marked-footnote';
import DOMPurify from 'dompurify';
import katex from 'katex';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import markdownLang from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import scss from 'highlight.js/lib/languages/scss';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

hljs.registerLanguage('bash', bash);
hljs.registerLanguage('c', c);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('csharp', csharp);
hljs.registerLanguage('css', css);
hljs.registerLanguage('diff', diff);
hljs.registerLanguage('go', go);
hljs.registerLanguage('java', java);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('kotlin', kotlin);
hljs.registerLanguage('markdown', markdownLang);
hljs.registerLanguage('php', php);
hljs.registerLanguage('python', python);
hljs.registerLanguage('ruby', ruby);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('scss', scss);
hljs.registerLanguage('shell', shell);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('swift', swift);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('yaml', yaml);
hljs.registerAliases(['js', 'jsx'], { languageName: 'javascript' });
hljs.registerAliases(['ts', 'tsx'], { languageName: 'typescript' });
hljs.registerAliases(['py'], { languageName: 'python' });
hljs.registerAliases(['sh', 'zsh'], { languageName: 'bash' });
hljs.registerAliases(['html'], { languageName: 'xml' });
hljs.registerAliases(['yml'], { languageName: 'yaml' });
hljs.registerAliases(['cs'], { languageName: 'csharp' });
hljs.registerAliases(['rb'], { languageName: 'ruby' });
hljs.registerAliases(['rs'], { languageName: 'rust' });
hljs.registerAliases(['md'], { languageName: 'markdown' });

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** href/src protocols a model answer may point at. Everything else renders inert. */
function isSafeUrl(href: string): boolean {
  const h = href.trim();
  if (!h) return false;
  if (/^(https?:|mailto:|#|\/|\.)/i.test(h)) return true;
  // Scheme-less relative reference (no colon before any /, ?, #).
  return !/^[a-z][a-z0-9+.-]*:/i.test(h);
}

function renderTex(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex, { displayMode, throwOnError: false, strict: false });
  } catch {
    // KaTeX with throwOnError:false should not throw; belt-and-braces so a
    // math edge case can never break a whole message render.
    return escapeHtml(displayMode ? `$$${tex}$$` : `$${tex}$`);
  }
}

const mathBlockExtension = {
  name: 'mathBlock',
  level: 'block' as const,
  start(src: string) {
    return src.indexOf('$$');
  },
  tokenizer(src: string) {
    const match = /^\$\$([\s\S]+?)\$\$/.exec(src);
    if (!match) return undefined;
    return { type: 'mathBlock', raw: match[0], text: match[1]!.trim() };
  },
  renderer(token: Tokens.Generic) {
    return `<div class="md-math-block">${renderTex(String(token.text ?? ''), true)}</div>\n`;
  },
};

const mathInlineExtension = {
  name: 'mathInline',
  level: 'inline' as const,
  start(src: string) {
    return src.indexOf('$');
  },
  tokenizer(src: string) {
    // $...$ with no space just inside the delimiters and no digit right
    // after the closer, so currency ("$5 and $10") stays plain text.
    const match = /^\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/.exec(src);
    if (!match) return undefined;
    return { type: 'mathInline', raw: match[0], text: match[1]! };
  },
  renderer(token: Tokens.Generic) {
    return `<span class="md-math">${renderTex(String(token.text ?? ''), false)}</span>`;
  },
};

const renderer: RendererObject = {
  // Pane convention kept from the lite renderer: a source h1 renders as
  // h2 so embedded content never out-shouts the surrounding UI.
  heading({ tokens, depth }: Tokens.Heading) {
    const level = Math.min(depth + 1, 6);
    return `<h${level}>${this.parser.parseInline(tokens)}</h${level}>\n`;
  },
  code({ text, lang }: Tokens.Code) {
    const language = (lang ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    let inner: string;
    let label = language || 'text';
    if (language && hljs.getLanguage(language)) {
      inner = hljs.highlight(text, { language }).value;
    } else {
      inner = escapeHtml(text);
      if (!language) label = 'text';
    }
    return (
      `<div class="md-codeblock"><div class="md-codeblock-head">` +
      `<span class="md-codeblock-lang">${escapeHtml(label)}</span>` +
      `<button type="button" class="md-codeblock-copy" data-md-copy aria-label="Copy code">Copy</button>` +
      `</div><pre class="md-pre"><code class="hljs language-${escapeHtml(language || 'plaintext')}">${inner}</code></pre></div>\n`
    );
  },
  link({ href, title, tokens }: Tokens.Link): string {
    const text = this.parser.parseInline(tokens);
    if (!isSafeUrl(href ?? '')) return text;
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
    const external = /^https?:/i.test(href) ? ' target="_blank" rel="noreferrer"' : '';
    return `<a href="${escapeHtml(href)}"${titleAttr}${external}>${text}</a>`;
  },
  image({ href, title, text }: Tokens.Image) {
    if (!isSafeUrl(href ?? '')) return escapeHtml(text ?? '');
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
    return `<img src="${escapeHtml(href)}" alt="${escapeHtml(text ?? '')}"${titleAttr} loading="lazy">`;
  },
  table(token: Tokens.Table) {
    const cellHtml = (cell: Tokens.TableCell) => this.parser.parseInline(cell.tokens);
    const alignAttr = (align: Tokens.TableCell['align']) => (align ? ` align="${align}"` : '');
    let html = '<div class="md-table-wrap"><table>\n<thead>\n<tr>\n';
    for (const cell of token.header) html += `<th${alignAttr(cell.align)}>${cellHtml(cell)}</th>\n`;
    html += '</tr>\n</thead>\n';
    if (token.rows.length > 0) {
      html += '<tbody>';
      for (const row of token.rows) {
        html += '\n<tr>\n';
        for (const cell of row) html += `<td${alignAttr(cell.align)}>${cellHtml(cell)}</td>\n`;
        html += '</tr>';
      }
      html += '\n</tbody>';
    }
    return html + '\n</table></div>\n';
  },
  // Raw HTML in model/file text renders as inert text, never markup.
  html({ text }: Tokens.HTML | Tokens.Tag) {
    return escapeHtml(text);
  },
};

const marked = new Marked({ gfm: true, breaks: true });
marked.use({ renderer });
marked.use({ extensions: [mathBlockExtension, mathInlineExtension] });
marked.use(markedFootnote());

// Rendered messages re-render on every state change; cache by exact
// source so settled messages are parsed once (streaming tails miss the
// cache, as they must, but history no longer re-parses per keystroke).
const renderCache = new Map<string, string>();
const RENDER_CACHE_MAX = 300;

function sanitizeHtml(raw: string): string {
  // In a browser/jsdom, DOMPurify is a ready instance. During the static
  // prerender (Node, no window) it exposes no sanitize — the renderer's
  // own escaping layers above still apply, and no user content is ever
  // rendered in that pass (chat history loads client-side).
  const dp = DOMPurify as unknown as { sanitize?: (html: string, cfg?: object) => string };
  return typeof dp.sanitize === 'function' ? dp.sanitize(raw, { ADD_ATTR: ['target', 'data-md-copy'] }) : raw;
}

/** Shared markdown → sanitized HTML for chat messages and file previews. */
export function renderMarkdownLite(src: string): string {
  const cached = renderCache.get(src);
  if (cached !== undefined) return cached;
  let html: string;
  try {
    html = sanitizeHtml(marked.parse(src, { async: false }));
  } catch {
    html = `<p>${escapeHtml(src)}</p>`;
  }
  if (renderCache.size >= RENDER_CACHE_MAX) renderCache.clear();
  renderCache.set(src, html);
  return html;
}

/**
 * Delegated click handler for code-block Copy buttons (the rendered HTML
 * is inert, so the button carries only a data attribute; the owning
 * container wires this handler). Copies the sibling <code> text and
 * flips the button label briefly. Safe to attach at .msg-md / pane level.
 */
export function handleMarkdownCopyClick(e: { target: EventTarget | null }): void {
  const el = e.target as HTMLElement | null;
  const btn = el?.closest?.('[data-md-copy]') as HTMLElement | null;
  if (!btn) return;
  const code = btn.closest('.md-codeblock')?.querySelector('code');
  if (!code) return;
  const text = code.textContent ?? '';
  const done = () => {
    const old = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => {
      btn.textContent = old;
    }, 1200);
  };
  const fallback = () => {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    } catch {
      /* clipboard unavailable — the code stays selectable by hand */
    }
    done();
  };
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(fallback);
  } else {
    fallback();
  }
}
