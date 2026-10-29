// SPDX-License-Identifier: Apache-2.0
// Tests for W3 public page publishing (apps/api/src/public-pages.ts +
// publish-tools.ts): slug unguessability/format, publish→serve round-trip
// over the real public route (no auth), 404s, stored-XSS sanitization for
// markdown and raw-HTML artifacts, the view counter, authenticated
// management routes (loopback auth rejects unauthenticated calls), and the
// agent tool + its governance policy rules. Temp data dirs only; no network.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolDefinition } from '@mvp/agent-runtime';
import { PageStore, registerPagesRoutes } from '../src/pages.js';
import {
  PagePublicationStore,
  generatePublicSlug,
  isValidPublicSlug,
  publicPathForSlug,
  registerPagePublicationRoutes,
  registerPublicPageServing,
  renderMarkdownToHtml,
  renderPublicDocument,
  sanitizeHtmlArtifact,
} from '../src/public-pages.js';
import { requireLoopbackAuth } from '../src/loopback-auth.js';
import { publishPagePolicyRules, registerPublishTools } from '../src/publish-tools.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'public-pages-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('slugs', () => {
  it('are ≥20 URL-safe chars, random, and unique', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const slug = generatePublicSlug();
      expect(slug.length).toBeGreaterThanOrEqual(20);
      expect(slug).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(isValidPublicSlug(slug)).toBe(true);
      seen.add(slug);
    }
    expect(seen.size).toBe(200);
  });

  it('are not derived from or close to the page id / sequential values', () => {
    const pages = new PageStore(dir);
    const pubs = new PagePublicationStore(dir);
    const a = pubs.publishPage(pages.create({ title: 'A' }));
    const b = pubs.publishPage(pages.create({ title: 'B' }));
    expect(a.slug).not.toBe(b.slug);
    expect(a.slug).not.toContain(a.pageId!.slice(0, 8));
    expect(publicPathForSlug(a.slug)).toBe(`/p/${a.slug}`);
  });

  it('rejects malformed slugs on lookup', () => {
    const pubs = new PagePublicationStore(dir);
    expect(pubs.getBySlug('../etc/passwd')).toBeUndefined();
    expect(pubs.getBySlug('short')).toBeUndefined();
    expect(pubs.getBySlug('a'.repeat(32))).toBeUndefined(); // well-formed but unknown
  });
});

describe('PagePublicationStore', () => {
  it('publishes, re-publishes (stable slug), unpublishes, and counts views', () => {
    const pages = new PageStore(dir);
    const pubs = new PagePublicationStore(dir);
    const page = pages.create({ title: 'Doc', content: '# hi' });

    expect(pubs.getForPage(page.id)).toBeUndefined();
    const pub = pubs.publishPage(page);
    expect(pub.views).toBe(0);
    expect(pub.publishedAt).toBeGreaterThan(0);

    const again = pubs.publishPage({ ...page, title: 'Doc v2' });
    expect(again.slug).toBe(pub.slug); // stable link across re-publish

    expect(pubs.incrementViews(pub.slug)).toBe(1);
    expect(pubs.incrementViews(pub.slug)).toBe(2);
    // Persistence across instances.
    expect(new PagePublicationStore(dir).getBySlug(pub.slug)?.views).toBe(2);

    expect(pubs.unpublishPage(page.id)).toBe(true);
    expect(pubs.getBySlug(pub.slug)).toBeUndefined();
    expect(pubs.unpublishPage(page.id)).toBe(false);
  });

  it('publishes standalone artifacts with snapshots and validates input', () => {
    const pubs = new PagePublicationStore(dir);
    const pub = pubs.publishArtifact({ title: 'Standalone', content: '<p>hi</p>', contentKind: 'html' });
    expect(pub.pageId).toBeNull();
    expect(pub.content).toBe('<p>hi</p>');
    expect(() => pubs.publishArtifact({ title: ' ', content: 'x', contentKind: 'markdown' })).toThrow(/title/);
    expect(() =>
      pubs.publishArtifact({ title: 't', content: 'x', contentKind: 'xml' as 'markdown' }),
    ).toThrow(/contentKind/);
    expect(pubs.unpublishBySlug(pub.slug)).toBe(true);
    expect(pubs.list()).toEqual([]);
  });
});

describe('sanitization', () => {
  it('markdown renderer escapes raw HTML and script injection', () => {
    const html = renderMarkdownToHtml('# Hi <script>alert(1)</script>\n\n<img src=x onerror=alert(2)>\n\n[click](javascript:alert(3))');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    // The javascript: URL survives only as inert escaped text (exactly like
    // the web app's renderer) — never as a live href.
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toMatch(/<a[^>]*javascript:/);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<h1>');
  });

  it('HTML sanitizer strips scripts, handlers, and dangerous URLs but keeps safe markup', () => {
    const dirty = [
      '<p onclick="alert(1)">hello</p>',
      '<script>alert(2)</script>',
      '<a href="javascript:alert(3)">bad</a>',
      '<a href="https://example.com/?a=1&b=2">good</a>',
      '<img src="https://example.com/x.png" onerror="alert(4)" alt="pic">',
      '<img src="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">',
      '<iframe src="https://evil.example"></iframe>',
      '<div style="background:url(javascript:alert(5))"><strong>bold</strong></div>',
      '<form action="https://evil.example"><input type="text"></form>after',
      '<svg onload="alert(6)"><circle/></svg>tail',
    ].join('\n');
    const clean = sanitizeHtmlArtifact(dirty);
    expect(clean).not.toContain('<script');
    expect(clean).not.toContain('onclick');
    expect(clean).not.toContain('onerror');
    expect(clean).not.toContain('javascript:');
    expect(clean).not.toContain('<iframe');
    expect(clean).not.toContain('<form');
    expect(clean).not.toContain('<svg');
    expect(clean).not.toContain('data:text/html');
    expect(clean).toContain('<p>hello</p>');
    expect(clean).toContain('<strong>bold</strong>');
    expect(clean).toContain('href="https://example.com/?a=1&amp;b=2"');
    expect(clean).toContain('src="https://example.com/x.png"');
    expect(clean).toContain('after');
    expect(clean).toContain('tail');
  });

  it('public document has no scripts, no app links, and an escaped title', () => {
    const doc = renderPublicDocument({
      title: 'T <script>alert(1)</script>',
      content: '# body',
      contentKind: 'markdown',
    });
    expect(doc).not.toContain('<script');
    expect(doc).not.toContain('href="/api');
    expect(doc).not.toContain('href="/"');
    expect(doc).toContain('&lt;script&gt;');
    expect(doc).toContain('<h1>');
  });
});

// ---------------------------------------------------------------------------
// HTTP round-trip: management router behind loopback auth + public serving
// ---------------------------------------------------------------------------

describe('public serving + management routes', () => {
  const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';
  let base = '';
  let server: ReturnType<typeof import('node:http').createServer> | null = null;

  beforeEach(async () => {
    const app = express();
    app.use(requireLoopbackAuth(TOKEN));
    app.use(express.json());
    const pagesRouter = express.Router();
    registerPagesRoutes(pagesRouter, { dataDir: dir });
    registerPagePublicationRoutes(pagesRouter, { dataDir: dir });
    app.use('/api/pages', pagesRouter);
    registerPublicPageServing(app, { dataDir: dir });
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) =>
      (server as unknown as { close(cb: () => void): void }).close(() => resolve()),
    );
    server = null;
  });

  const authed = (init: RequestInit = {}): RequestInit => ({
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
  });

  async function createAndPublish(content: string): Promise<{ pageId: string; slug: string; path: string }> {
    const created = await fetch(`${base}/api/pages`, authed({ method: 'POST', body: JSON.stringify({ title: 'Shared Doc', content }) }));
    expect(created.status).toBe(201);
    const page = (await created.json()) as { id: string };
    const published = await fetch(`${base}/api/pages/${page.id}/publish`, authed({ method: 'POST' }));
    expect(published.status).toBe(201);
    const pub = (await published.json()) as { slug: string; path: string };
    return { pageId: page.id, slug: pub.slug, path: pub.path };
  }

  it('publish → serve round-trip: 200 + rendered HTML with NO auth', async () => {
    const { path } = await createAndPublish('# Hello\n\nsome **bold** text');
    const res = await fetch(`${base}${path}`); // deliberately unauthenticated
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    const html = await res.text();
    expect(html).toContain('<h1>Shared Doc</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).not.toContain('/api/pages'); // no links back into the app
  });

  it('increments the view counter on serve', async () => {
    const { pageId, path } = await createAndPublish('body');
    await fetch(`${base}${path}`);
    await fetch(`${base}${path}`);
    const status = await fetch(`${base}/api/pages/${pageId}/publication`, authed());
    expect(((await status.json()) as { views: number }).views).toBe(2);
  });

  it('unpublished and unknown slugs → 404; unpublish takes the page down', async () => {
    const { pageId, path } = await createAndPublish('body');
    expect((await fetch(`${base}/p/${'z'.repeat(32)}`)).status).toBe(404);
    expect((await fetch(`${base}${path}`)).status).toBe(200);
    const un = await fetch(`${base}/api/pages/${pageId}/publish`, authed({ method: 'DELETE' }));
    expect(un.status).toBe(200);
    expect((await fetch(`${base}${path}`)).status).toBe(404);
    const status = await fetch(`${base}/api/pages/${pageId}/publication`, authed());
    expect(((await status.json()) as { published: boolean }).published).toBe(false);
  });

  it('serves sanitized content: injected script/handlers never reach the public page', async () => {
    const { path } = await createAndPublish('# x <script>alert(1)</script>\n\n<img src=x onerror=alert(2)>');
    const html = await (await fetch(`${base}${path}`)).text();
    expect(html).not.toContain('<script>alert(1)</script>');
    // The img survives only as escaped text — no live tag carrying a handler.
    expect(html).not.toMatch(/<img[^>]*onerror/);
    expect(html).toContain('&lt;img src=x onerror=alert(2)&gt;');
  });

  it('publishes and serves a standalone HTML artifact, sanitized', async () => {
    const res = await fetch(
      `${base}/api/pages/publish-artifact`,
      authed({
        method: 'POST',
        body: JSON.stringify({
          title: 'Artifact',
          content: '<p onclick="x()">hi</p><script>alert(1)</script>',
          contentKind: 'html',
        }),
      }),
    );
    expect(res.status).toBe(201);
    const pub = (await res.json()) as { path: string; slug: string };
    const html = await (await fetch(`${base}${pub.path}`)).text();
    expect(html).toContain('<p>hi</p>');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('<script');
    const un = await fetch(`${base}/api/pages/publish-artifact/${pub.slug}`, authed({ method: 'DELETE' }));
    expect(un.status).toBe(200);
    expect((await fetch(`${base}${pub.path}`)).status).toBe(404);
  });

  it('management endpoints reject unauthenticated calls', async () => {
    const created = await fetch(`${base}/api/pages`, authed({ method: 'POST', body: JSON.stringify({ title: 'Doc' }) }));
    const page = (await created.json()) as { id: string };
    expect((await fetch(`${base}/api/pages/${page.id}/publish`, { method: 'POST' })).status).toBe(401);
    expect((await fetch(`${base}/api/pages/${page.id}/publish`, { method: 'DELETE' })).status).toBe(401);
    expect((await fetch(`${base}/api/pages/${page.id}/publication`)).status).toBe(401);
    expect(
      (await fetch(`${base}/api/pages/publish-artifact`, { method: 'POST', body: '{}' })).status,
    ).toBe(401);
  });

  it('deleted pages stop being served', async () => {
    const { pageId, path } = await createAndPublish('body');
    await fetch(`${base}/api/pages/${pageId}`, authed({ method: 'DELETE' }));
    expect((await fetch(`${base}${path}`)).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Agent tools
// ---------------------------------------------------------------------------

describe('publish agent tools', () => {
  function registered(): Map<string, ToolDefinition> {
    const registry = new Map<string, ToolDefinition>();
    registerPublishTools({ registry, dataDir: dir });
    return registry;
  }
  const ctx = { sessionId: 's', botId: 'b' };

  it('registers all three tools without clobbering', () => {
    const registry = new Map<string, ToolDefinition>();
    const existing: ToolDefinition = { name: 'publish_page', description: 'mine', parameters: {}, handler: async () => ({}) };
    registry.set('publish_page', existing);
    registerPublishTools({ registry, dataDir: dir });
    expect(registry.get('publish_page')).toBe(existing);
    expect(registry.has('unpublish_page')).toBe(true);
    expect(registry.has('page_publication_status')).toBe(true);
  });

  it('publish_page publishes by id and by title and returns the public path', async () => {
    const pages = new PageStore(dir);
    const page = pages.create({ title: 'Bot Doc', content: '# from bot' });
    const registry = registered();
    const byTitle = (await registry.get('publish_page')!.handler({ page: 'Bot Doc' }, ctx)) as {
      published: boolean; path: string; slug: string; pageId: string;
    };
    expect(byTitle.published).toBe(true);
    expect(byTitle.pageId).toBe(page.id);
    expect(byTitle.path).toBe(`/p/${byTitle.slug}`);
    expect(isValidPublicSlug(byTitle.slug)).toBe(true);

    const status = (await registry.get('page_publication_status')!.handler({ page: page.id }, ctx)) as {
      published: boolean; path: string;
    };
    expect(status.published).toBe(true);
    expect(status.path).toBe(byTitle.path);

    const un = (await registry.get('unpublish_page')!.handler({ page: page.id }, ctx)) as { published: boolean };
    expect(un.published).toBe(false);
    const after = (await registry.get('page_publication_status')!.handler({ page: page.id }, ctx)) as { published: boolean };
    expect(after.published).toBe(false);
  });

  it('rejects unknown pages', async () => {
    const registry = registered();
    await expect(registry.get('publish_page')!.handler({ page: 'nope' }, ctx)).rejects.toThrow(/unknown page/);
    await expect(registry.get('publish_page')!.handler({}, ctx)).rejects.toThrow(/required/);
  });

  it('policy rules: status allows, publish/unpublish require approval', () => {
    const rules = publishPagePolicyRules();
    const find = (name: string) => rules.find((r) => new RegExp(r.toolPattern).test(name))!;
    expect(find('page_publication_status').effect).toBe('allow');
    expect(find('publish_page').effect).toBe('require-approval');
    expect(find('unpublish_page').effect).toBe('require-approval');
    for (const r of rules) {
      expect(r.id).toBeTruthy();
      expect(r.reason).toBeTruthy();
    }
  });
});
