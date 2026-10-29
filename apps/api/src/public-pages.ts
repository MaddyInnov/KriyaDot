// SPDX-License-Identifier: Apache-2.0
// Public page publishing (W3).
//
// Internal collaborative Pages (pages.ts) are authenticated-only. This module
// adds opt-in public publishing:
//
// - PagePublicationStore: publication records in the same `pages.db`.
//   A publication is either linked to a Page (content is read live from the
//   PageStore at serve time, so edits propagate and deleting the page
//   unpublishes it) or a standalone artifact with a content snapshot
//   (markdown or raw HTML). Slugs are cryptographically random
//   (24 bytes → 32 base64url chars), never sequential or derived from the
//   page id, so published URLs are unguessable and non-enumerable.
// - Public route: GET /p/<slug> — mounted OUTSIDE /api on the express app,
//   so it is exempt from loopback bearer auth (see loopback-auth.ts: every
//   non-/api path is exempt). Unknown or unpublished slugs → 404.
// - Authenticated management routes (mounted on the pages router, which sits
//   behind loopback auth): publish / unpublish / publication status, plus
//   standalone-artifact publishing.
//
// Sanitization discipline (stored-XSS): markdown goes through the SAME
// escape-first renderer the web app uses (components/panels/pages-panel.tsx
// and app/modules/lib.tsx — all source text is HTML-escaped before any
// markdown construct is expanded, and links are restricted to http(s)).
// Raw HTML artifacts go through sanitizeHtmlArtifact(), an allowlist
// sanitizer: dangerous elements are dropped with their contents, event
// handlers / style / javascript: URLs are stripped. The public document is
// served with a restrictive Content-Security-Policy (no scripts at all).

import { randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Express, Request, Response, Router } from 'express';
import { openDb as openSqliteDb } from '@mvp/agent-runtime';
import { PageStore } from './pages.js';
import { compileJsxToHtml } from './jsx-compile.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PublicationContentKind = 'markdown' | 'html';

export interface PagePublication {
  id: string;
  /** Linked page id, or null for a standalone artifact publication. */
  pageId: string | null;
  /** Unguessable URL slug (32 base64url chars). */
  slug: string;
  title: string;
  /** Snapshot content for standalone artifacts; null for page publications. */
  content: string | null;
  contentKind: PublicationContentKind;
  publishedAt: number;
  views: number;
}

/** Public URL path for a publication. */
export function publicPathForSlug(slug: string): string {
  return `/p/${slug}`;
}

export interface PublicationStatus {
  published: boolean;
  slug?: string;
  path?: string;
  publishedAt?: number;
  views?: number;
}

interface PublicationRow {
  id: string;
  page_id: string | null;
  slug: string;
  title: string;
  content: string | null;
  content_kind: string;
  published_at: number;
  views: number;
}

function rowToPublication(r: PublicationRow): PagePublication {
  return {
    id: r.id,
    pageId: r.page_id,
    slug: r.slug,
    title: r.title,
    content: r.content,
    contentKind: r.content_kind === 'html' ? 'html' : 'markdown',
    publishedAt: r.published_at,
    views: r.views,
  };
}

// ---------------------------------------------------------------------------
// Slugs
// ---------------------------------------------------------------------------

/** 24 random bytes → 32 URL-safe chars (~192 bits). Unguessable, non-enumerable. */
export function generatePublicSlug(): string {
  return randomBytes(24).toString('base64url');
}

const SLUG_RE = /^[A-Za-z0-9_-]{20,64}$/;

export function isValidPublicSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const PUBLICATIONS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS page_publications (
    id TEXT PRIMARY KEY,
    page_id TEXT UNIQUE,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL DEFAULT '',
    content TEXT,
    content_kind TEXT NOT NULL DEFAULT 'markdown',
    published_at INTEGER NOT NULL,
    views INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_page_publications_slug ON page_publications(slug);
`;

function openPublicationsDb(dataDir: string): DatabaseSync {
  const { mkdirSync } = require('node:fs') as typeof import('node:fs');
  const { join } = require('node:path') as typeof import('node:path');
  mkdirSync(dataDir, { recursive: true });
  const db = openSqliteDb(join(dataDir, 'pages.db'));
  db.exec(PUBLICATIONS_SCHEMA);
  return db;
}

export class PagePublicationStore {
  protected readonly db: DatabaseSync;

  constructor(dataDir: string) {
    this.db = openPublicationsDb(dataDir);
  }

  /** Publish (or re-publish) a page. Re-publishing keeps the existing slug. */
  publishPage(page: { id: string; title: string }): PagePublication {
    const existing = this.getForPage(page.id);
    if (existing) {
      this.db
        .prepare('UPDATE page_publications SET title = ? WHERE id = ?')
        .run(page.title, existing.id);
      return { ...existing, title: page.title };
    }
    const pub: PagePublication = {
      id: randomUUID(),
      pageId: page.id,
      slug: this.freshSlug(),
      title: page.title,
      content: null,
      contentKind: 'markdown',
      publishedAt: Date.now(),
      views: 0,
    };
    this.insert(pub);
    return pub;
  }

  /** Publish a standalone markdown/HTML artifact (content snapshot). */
  publishArtifact(input: {
    title: string;
    content: string;
    contentKind: PublicationContentKind;
  }): PagePublication {
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (!title || title.length > 200) throw new Error('publication "title" must be a non-empty string (max 200 chars)');
    if (typeof input.content !== 'string') throw new Error('publication "content" must be a string');
    if (input.content.length > 200_000) throw new Error('publication "content" exceeds 200KB');
    if (input.contentKind !== 'markdown' && input.contentKind !== 'html') {
      throw new Error('publication "contentKind" must be "markdown" or "html"');
    }
    const pub: PagePublication = {
      id: randomUUID(),
      pageId: null,
      slug: this.freshSlug(),
      title,
      content: input.content,
      contentKind: input.contentKind,
      publishedAt: Date.now(),
      views: 0,
    };
    this.insert(pub);
    return pub;
  }

  /** Unpublish a page. Returns true when a publication was removed. */
  unpublishPage(pageId: string): boolean {
    const r = this.db.prepare('DELETE FROM page_publications WHERE page_id = ?').run(pageId);
    return r.changes > 0;
  }

  /** Unpublish any publication by slug. Returns true when one was removed. */
  unpublishBySlug(slug: string): boolean {
    const r = this.db.prepare('DELETE FROM page_publications WHERE slug = ?').run(slug);
    return r.changes > 0;
  }

  getForPage(pageId: string): PagePublication | undefined {
    const row = this.db
      .prepare('SELECT * FROM page_publications WHERE page_id = ?')
      .get(pageId) as unknown as PublicationRow | undefined;
    return row ? rowToPublication(row) : undefined;
  }

  getBySlug(slug: string): PagePublication | undefined {
    if (!isValidPublicSlug(slug)) return undefined;
    const row = this.db
      .prepare('SELECT * FROM page_publications WHERE slug = ?')
      .get(slug) as unknown as PublicationRow | undefined;
    return row ? rowToPublication(row) : undefined;
  }

  list(): PagePublication[] {
    const rows = this.db
      .prepare('SELECT * FROM page_publications ORDER BY published_at DESC')
      .all() as unknown as PublicationRow[];
    return rows.map(rowToPublication);
  }

  /** Best-effort view counter bump; returns the new count (or undefined). */
  incrementViews(slug: string): number | undefined {
    const r = this.db
      .prepare('UPDATE page_publications SET views = views + 1 WHERE slug = ?')
      .run(slug);
    if (r.changes === 0) return undefined;
    return this.getBySlug(slug)?.views;
  }

  private freshSlug(): string {
    // Collision is astronomically unlikely; loop anyway for correctness.
    for (let i = 0; i < 5; i++) {
      const slug = generatePublicSlug();
      if (!this.getBySlug(slug)) return slug;
    }
    throw new Error('could not mint a unique public slug');
  }

  private insert(pub: PagePublication): void {
    this.db
      .prepare(
        'INSERT INTO page_publications (id, page_id, slug, title, content, content_kind, published_at, views) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(pub.id, pub.pageId, pub.slug, pub.title, pub.content, pub.contentKind, pub.publishedAt, pub.views);
  }
}

export function publicationStatus(pub: PagePublication | undefined): PublicationStatus {
  if (!pub) return { published: false };
  return {
    published: true,
    slug: pub.slug,
    path: publicPathForSlug(pub.slug),
    publishedAt: pub.publishedAt,
    views: pub.views,
  };
}

// ---------------------------------------------------------------------------
// Markdown rendering — server port of the web app's escape-first renderer.
// Every character of source text is HTML-escaped BEFORE markdown constructs
// are expanded, and link targets are restricted to http(s)://, so stored
// markup in a page can never become live HTML/script on the public route.
// ---------------------------------------------------------------------------

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderMarkdownToHtml(src: string): string {
  const inline = (s: string): string =>
    escapeHtml(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|\W)\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>');
  const lines = src.split('\n');
  const out: string[] = [];
  let inList = false;
  let inCode = false;
  let codeBuf: string[] = [];
  for (const line of lines) {
    if (/^```/.test(line)) {
      if (inCode) {
        out.push(`<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`);
        codeBuf = [];
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      if (inList) {
        out.push('</ul>');
        inList = false;
      }
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
      continue;
    }
    const li = /^[-*]\s+(.*)$/.exec(line);
    if (li) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
    if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (inList) out.push('</ul>');
  if (inCode) out.push(`<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`);
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Raw-HTML artifact sanitizer (allowlist).
//
// Elements not on the allowlist are unwrapped (children kept), except
// DROP_WITH_CONTENTS elements (script/style/iframe/…) which vanish entirely.
// Attributes are allowlisted per element; every on* handler, style, and
// non-http(s)/data-image URL is stripped.
// ---------------------------------------------------------------------------

const ALLOWED_TAGS = new Set([
  'a', 'b', 'strong', 'i', 'em', 'u', 's', 'small', 'sub', 'sup', 'mark',
  'p', 'br', 'hr', 'div', 'span', 'section', 'article', 'header', 'footer', 'main',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  'img', 'figure', 'figcaption', 'details', 'summary',
]);

const DROP_WITH_CONTENTS = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button',
  'textarea', 'select', 'option', 'link', 'meta', 'base', 'title', 'head',
  'svg', 'math', 'template', 'noscript', 'frame', 'frameset', 'applet',
]);

const VOID_TAGS = new Set(['br', 'hr', 'img']);

/** Dropped elements that never have a closing tag (must not open a drop region). */
const DROP_VOID_TAGS = new Set(['input', 'meta', 'link', 'base', 'embed', 'frame']);

function isSafeUrl(raw: string, kind: 'link' | 'image'): boolean {
  // Strip whitespace/control chars browsers would ignore inside a scheme.
  const v = raw.replace(/[\u0000-\u0020]+/g, '');
  if (kind === 'image' && /^data:image\/(png|gif|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(v)) return true;
  if (v.startsWith('#')) return kind === 'link';
  return /^https?:\/\//i.test(v) || (kind === 'link' && /^mailto:/i.test(v));
}

function sanitizeAttributes(tag: string, attrSource: string): string {
  const out: string[] = [];
  const attrRe = /([a-zA-Z][a-zA-Z0-9-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(attrSource)) !== null) {
    const name = m[1].toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    if (name.startsWith('on') || name === 'style' || name === 'id') continue;
    if (tag === 'a' && name === 'href') {
      if (isSafeUrl(value, 'link')) out.push(`href="${escapeHtml(value)}"`);
    } else if (tag === 'img' && name === 'src') {
      if (isSafeUrl(value, 'image')) out.push(`src="${escapeHtml(value)}"`);
    } else if (tag === 'img' && (name === 'alt' || name === 'title')) {
      out.push(`${name}="${escapeHtml(value)}"`);
    } else if ((tag === 'td' || tag === 'th') && (name === 'colspan' || name === 'rowspan')) {
      if (/^\d{1,2}$/.test(value)) out.push(`${name}="${value}"`);
    } else if (name === 'title' && tag !== 'img') {
      out.push(`title="${escapeHtml(value)}"`);
    }
  }
  if (tag === 'a' && out.some((a) => a.startsWith('href='))) {
    out.push('target="_blank"', 'rel="noreferrer noopener"');
  }
  return out.length ? ` ${out.join(' ')}` : '';
}

export function sanitizeHtmlArtifact(html: string): string {
  const out: string[] = [];
  // Stack of currently-dropped elements (DROP_WITH_CONTENTS nesting).
  let dropDepth = 0;
  const tokenRe = /<!--[\s\S]*?-->|<!doctype[^>]*>|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)|(<)/gi;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(html)) !== null) {
    const [, closingSlash, tagRaw, attrSource, selfClose, text, loneLt] = m;
    if (m[0].startsWith('<!--') || /^<!doctype/i.test(m[0])) continue; // comments/doctype dropped
    if (text !== undefined) {
      if (dropDepth === 0) out.push(text);
      continue;
    }
    if (loneLt !== undefined) {
      if (dropDepth === 0) out.push('&lt;');
      continue;
    }
    const tag = (tagRaw ?? '').toLowerCase();
    const isClosing = closingSlash === '/';
    if (DROP_WITH_CONTENTS.has(tag)) {
      if (isClosing) {
        if (dropDepth > 0) dropDepth--;
      } else if (selfClose !== '/' && !DROP_VOID_TAGS.has(tag)) {
        dropDepth++;
      }
      continue;
    }
    if (dropDepth > 0) continue;
    if (!ALLOWED_TAGS.has(tag)) continue; // unwrap: drop the tag, keep children
    if (isClosing) {
      if (!VOID_TAGS.has(tag)) out.push(`</${tag}>`);
      continue;
    }
    out.push(`<${tag}${sanitizeAttributes(tag, attrSource ?? '')}>`);
    if (selfClose === '/' && !VOID_TAGS.has(tag)) out.push(`</${tag}>`);
  }
  return out.join('');
}

// ---------------------------------------------------------------------------
// Standalone public document
// ---------------------------------------------------------------------------

const PUBLIC_CSS = `
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; color: #1a1a2e; background: #fff; }
  main { max-width: 760px; margin: 0 auto; padding: 40px 20px 64px; line-height: 1.65; }
  h1 { font-size: 2rem; line-height: 1.25; margin: 0 0 24px; }
  pre { background: #f4f4f8; padding: 14px; border-radius: 8px; overflow-x: auto; }
  code { background: #f4f4f8; padding: 1px 5px; border-radius: 4px; font-size: 0.92em; }
  pre code { background: none; padding: 0; }
  img { max-width: 100%; }
  a { color: #3b5bdb; }
  footer { max-width: 760px; margin: 0 auto; padding: 0 20px 32px; color: #8a8a9e; font-size: 0.8rem; }
`;

/**
 * Render the full standalone HTML document for a publication. No app chrome,
 * no navigation, no scripts, no links back into authenticated areas.
 */
export function renderPublicDocument(input: {
  title: string;
  content: string;
  contentKind: PublicationContentKind;
}): string {
  const body =
    input.contentKind === 'html' ? sanitizeHtmlArtifact(input.content) : renderMarkdownToHtml(input.content);
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex">',
    `<title>${escapeHtml(input.title)}</title>`,
    `<style>${PUBLIC_CSS}</style>`,
    '</head>',
    '<body>',
    '<main>',
    `<h1>${escapeHtml(input.title)}</h1>`,
    body,
    '</main>',
    '<footer>Published with KriyaDot</footer>',
    '</body>',
    '</html>',
  ].join('\n');
}

/**
 * Restrictive CSP for public pages: no scripts anywhere, no framing, no
 * base-uri hijack, no form posts. Inline <style> is needed for the document
 * shell; images may come from https:/data: (already URL-filtered above).
 */
export const PUBLIC_PAGE_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  'img-src https: data:',
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

// ---------------------------------------------------------------------------
// Public serving route (NO auth — mount on the express app, outside /api)
// ---------------------------------------------------------------------------

export interface PublicPagesDeps {
  dataDir: string;
  publicationStore?: PagePublicationStore;
  pageStore?: PageStore;
}

export function registerPublicPageServing(app: Express, deps: PublicPagesDeps): void {
  const publications = deps.publicationStore ?? new PagePublicationStore(deps.dataDir);
  const pages = deps.pageStore ?? new PageStore(deps.dataDir);

  app.get('/p/:slug', (req: Request, res: Response) => {
    const pub = publications.getBySlug(req.params.slug);
    if (!pub) {
      res.status(404).type('text').send('Not found');
      return;
    }
    let title = pub.title;
    let content: string;
    let contentKind: PublicationContentKind;
    if (pub.pageId) {
      // Live page content; a deleted page is unpublished by definition.
      const page = pages.get(pub.pageId);
      if (!page) {
        res.status(404).type('text').send('Not found');
        return;
      }
      title = page.title;
      content = page.content;
      contentKind = page.format === 'html' ? 'html' : 'markdown';
    } else {
      content = pub.content ?? '';
      contentKind = pub.contentKind;
    }
    // Best-effort view counter — a counter failure must never break serving.
    try {
      publications.incrementViews(pub.slug);
    } catch {
      // ignore
    }
    res
      .status(200)
      .set({
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': PUBLIC_PAGE_CSP,
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'no-cache',
      })
      .send(renderPublicDocument({ title, content, contentKind }));
  });
}

// ---------------------------------------------------------------------------
// Authenticated management routes (mount on the pages router, under /api/pages)
// ---------------------------------------------------------------------------

export function registerPagePublicationRoutes(router: Router, deps: PublicPagesDeps): void {
  const publications = deps.publicationStore ?? new PagePublicationStore(deps.dataDir);
  const pages = deps.pageStore ?? new PageStore(deps.dataDir);

  router.post('/:id/publish', (req: Request, res: Response) => {
    const page = pages.get(req.params.id);
    if (!page) {
      res.status(404).json({ error: `unknown page: ${req.params.id}` });
      return;
    }
    const pub = publications.publishPage(page);
    res.status(201).json({ ...publicationStatus(pub), title: page.title });
  });

  router.delete('/:id/publish', (req: Request, res: Response) => {
    const page = pages.get(req.params.id);
    if (!page) {
      res.status(404).json({ error: `unknown page: ${req.params.id}` });
      return;
    }
    publications.unpublishPage(page.id);
    res.json({ published: false });
  });

  router.get('/:id/publication', (req: Request, res: Response) => {
    const page = pages.get(req.params.id);
    if (!page) {
      res.status(404).json({ error: `unknown page: ${req.params.id}` });
      return;
    }
    res.json(publicationStatus(publications.getForPage(page.id)));
  });

  // Standalone artifact publishing (single-segment paths so they can never
  // be swallowed by the /:id routes registered before these).
  // format: 'jsx' compiles the constrained JSX subset to HTML and runs it
  // through the sanitizer before it is stored (single sanitizer path).
  router.post('/publish-artifact', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as {
        title?: unknown;
        content?: unknown;
        contentKind?: unknown;
        format?: unknown;
      };
      let content = body.content as string;
      let contentKind = (body.contentKind === 'html' ? 'html' : 'markdown') as PublicationContentKind;
      if (body.format === 'jsx') {
        content = sanitizeHtmlArtifact(compileJsxToHtml(content));
        contentKind = 'html';
      } else if (body.format !== undefined && body.format !== 'markdown' && body.format !== 'html') {
        res.status(400).json({ error: '"format" must be one of "markdown" | "html" | "jsx"' });
        return;
      }
      const pub = publications.publishArtifact({
        title: body.title as string,
        content,
        contentKind,
      });
      res.status(201).json({ ...publicationStatus(pub), title: pub.title });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'failed to publish artifact' });
    }
  });

  router.delete('/publish-artifact/:slug', (req: Request, res: Response) => {
    const removed = publications.unpublishBySlug(req.params.slug);
    if (!removed) {
      res.status(404).json({ error: 'unknown publication' });
      return;
    }
    res.json({ published: false });
  });
}
