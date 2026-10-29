// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PageStore } from '../src/pages.js';
import { registerPagePreviewRoutes, renderPageDraftBody } from '../src/page-preview.js';
import { PagePublicationStore, registerPublicPageServing } from '../src/public-pages.js';

describe('Pages JSX accept path + draft preview', () => {
  let dir: string;
  let store: PageStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'page-preview-'));
    store = new PageStore(dir);
  });

  it('creates a page from JSX: compiled to HTML, format recorded', () => {
    const page = store.create({
      title: 'JSX Doc',
      content: '<div className="hero"><h1>Hi</h1></div>',
      format: 'jsx',
    });
    expect(page.format).toBe('html');
    expect(page.content).toBe('<div class="hero"><h1>Hi</h1></div>');
  });

  it('rejects invalid JSX at write time', () => {
    expect(() =>
      store.create({ title: 'Bad', content: '<Widget />', format: 'jsx' }),
    ).toThrow(/JSX compile failed/);
  });

  it('renders drafts through the sanitizer (payloads stripped)', () => {
    const page = store.create({
      title: 'HTML Doc',
      content: '<p onclick="x()">hi</p><script>alert(1)</script>',
      format: 'html',
    });
    const body = renderPageDraftBody(page);
    expect(body).toContain('<p>hi</p>');
    expect(body).not.toContain('script');
    expect(body).not.toContain('onclick');
  });

  describe('HTTP preview route', () => {
    let base: string;
    let server: ReturnType<express.Express['listen']>;

    beforeEach(async () => {
      const app = express();
      app.use(express.json());
      const router = express.Router();
      registerPagePreviewRoutes(router, { dataDir: dir, pageStore: store });
      app.use('/api/pages', router);
      await new Promise<void>((resolve) => {
        server = app.listen(0, () => resolve());
      });
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('serves the draft preview; picker script only in picker mode, never by default', async () => {
      const page = store.create({ title: 'Draft', content: '# Hello' });
      const plain = await fetch(`${base}/api/pages/${page.id}/preview`);
      expect(plain.status).toBe(200);
      const plainHtml = await plain.text();
      expect(plainHtml).toContain('<h1>Hello</h1>');
      expect(plainHtml).not.toContain('kriyadot:page-element');
      expect(plain.headers.get('content-security-policy')).not.toContain('script-src');

      const picked = await fetch(`${base}/api/pages/${page.id}/preview?picker=1`);
      const pickedHtml = await picked.text();
      expect(pickedHtml).toContain('kriyadot:page-element');
      expect(picked.headers.get('content-security-policy')).toContain("script-src 'unsafe-inline'");
    });

    it('404s for unknown pages', async () => {
      expect((await fetch(`${base}/api/pages/nope/preview`)).status).toBe(404);
    });

    it('published output never contains the picker script', async () => {
      const page = store.create({ title: 'Pub', content: '# Public' });
      const pubs = new PagePublicationStore(dir);
      const pub = pubs.publishPage(page);
      const app = express();
      registerPublicPageServing(app, {
        dataDir: dir,
        publicationStore: pubs,
        pageStore: store,
      });
      const srv = app.listen(0);
      await new Promise<void>((r) => srv.on('listening', () => r()));
      const pubBase = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
      const res = await fetch(`${pubBase}/p/${pub.slug}`);
      const html = await res.text();
      expect(html).not.toContain('kriyadot:page-element');
      expect(html).not.toContain('<script');
      await new Promise<void>((r) => srv.close(() => r()));
    });
  });
});
