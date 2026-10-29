// SPDX-License-Identifier: Apache-2.0
// Page draft preview (Pages depth): renders a page's CURRENT draft through
// the SAME pipeline as the public route — markdown via the escape-first
// renderer, HTML via sanitizeHtmlArtifact(), wrapped by
// renderPublicDocument() — but behind auth and never published.
//
// Mount (integrator, routes.ts — on the pages router, next to
// registerPagePublicationRoutes):
//
//   import { registerPagePreviewRoutes } from './page-preview.js';
//   registerPagePreviewRoutes(pagesRouter, { dataDir: config.dataDir });
//
// Route: GET /pages/:id/preview[?picker=1]
//
// Point-to-change: with ?picker=1 a small picker script is injected into
// the PREVIEW document only (published output never contains it — the
// public pipeline in public-pages.ts is untouched). The script outlines
// hovered elements and, on click, posts
//   { type: 'kriyadot:page-element', tag, text, path }
// to the parent window, where the preview pane turns it into a change
// request for the page's bot chat. Because the preview needs that inline
// script, its CSP relaxes script-src to 'unsafe-inline' FOR THE PREVIEW
// RESPONSE ONLY; content still passes the single sanitizer path first.

import type { Request, Response, Router } from 'express';
import { PageStore, type Page } from './pages.js';
import {
  renderMarkdownToHtml,
  renderPublicDocument,
  sanitizeHtmlArtifact,
} from './public-pages.js';

export interface PagePreviewDeps {
  dataDir: string;
  pageStore?: PageStore;
}

/** Render a page draft's body HTML through the single sanitizer path. */
export function renderPageDraftBody(page: Pick<Page, 'content' | 'format'>): string {
  return page.format === 'html'
    ? sanitizeHtmlArtifact(page.content)
    : renderMarkdownToHtml(page.content);
}

/**
 * Picker script injected ONLY into preview documents (?picker=1). Plain
 * string (no template placeholders) so it can be asserted in tests and
 * can never leak page content into the script itself.
 */
export const PAGE_PICKER_SCRIPT = [
  '<script>',
  '(function(){',
  "  var prev=null;",
  "  function pathOf(el){var parts=[];var n=el;while(n&&n.nodeType===1&&parts.length<6){",
  "    var s=n.tagName.toLowerCase();",
  "    if(n.id){s+='#'+n.id;parts.unshift(s);break;}",
  "    var p=n.parentElement;",
  "    if(p){var sib=Array.prototype.slice.call(p.children);var i=sib.indexOf(n);if(i>0)s+=':nth-child('+(i+1)+')';}",
  "    parts.unshift(s);n=p;}",
  "    return parts.join(' > ');}",
  "  document.addEventListener('mouseover',function(e){",
  "    if(prev)prev.style.outline='';",
  "    prev=e.target;",
  "    if(prev&&prev.style)prev.style.outline='2px solid #3b5bdb';",
  "  },true);",
  "  document.addEventListener('click',function(e){",
  "    e.preventDefault();e.stopPropagation();",
  "    var el=e.target;",
  "    var text=(el.innerText||el.textContent||'').trim().slice(0,200);",
  "    parent.postMessage({type:'kriyadot:page-element',tag:el.tagName.toLowerCase(),text:text,path:pathOf(el)},'*');",
  "  },true);",
  '})();',
  '</script>',
].join('\n');

/** CSP for preview documents (picker mode adds inline script allowance). */
export function previewCsp(picker: boolean): string {
  const base = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    'img-src https: data:',
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ];
  if (picker) base.push("script-src 'unsafe-inline'");
  return base.join('; ');
}

export function registerPagePreviewRoutes(router: Router, deps: PagePreviewDeps): void {
  const pages = deps.pageStore ?? new PageStore(deps.dataDir);

  router.get('/:id/preview', (req: Request, res: Response) => {
    const page = pages.get(req.params.id);
    if (!page) {
      res.status(404).json({ error: `unknown page: ${req.params.id}` });
      return;
    }
    const picker = req.query.picker === '1' || req.query.picker === 'true';
    let doc = renderPublicDocument({
      title: page.title,
      content: page.content,
      contentKind: page.format === 'html' ? 'html' : 'markdown',
    });
    if (picker) {
      doc = doc.replace('</body>', `${PAGE_PICKER_SCRIPT}\n</body>`);
    }
    res
      .status(200)
      .set({
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': previewCsp(picker),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      })
      .send(doc);
  });
}
