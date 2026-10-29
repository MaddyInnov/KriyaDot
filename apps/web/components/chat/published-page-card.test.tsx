// SPDX-License-Identifier: Apache-2.0
import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PublishedPageCard, publishedPageFromToolResult } from './published-page-card';

describe('publishedPageFromToolResult', () => {
  it('extracts publish_page results with a /p/ path', () => {
    const data = publishedPageFromToolResult('publish_page', {
      published: true,
      pageId: 'p1',
      title: 'Doc',
      slug: 'abc',
      path: '/p/abc',
      views: 3,
    });
    expect(data).toEqual({ path: '/p/abc', title: 'Doc', views: 3 });
  });

  it('ignores other tools, unpublished results, and malformed results', () => {
    expect(publishedPageFromToolResult('notes_save', { published: true, path: '/p/abc' })).toBeNull();
    expect(publishedPageFromToolResult('publish_page', { published: false, path: '/p/abc' })).toBeNull();
    expect(publishedPageFromToolResult('publish_page', { published: true, path: '/api/pages' })).toBeNull();
    expect(publishedPageFromToolResult('publish_page', null)).toBeNull();
    expect(publishedPageFromToolResult('publish_page', 'nope')).toBeNull();
  });
});

describe('PublishedPageCard', () => {
  it('renders the link with a copy button and the public-view notice', () => {
    const html = renderToStaticMarkup(
      React.createElement(PublishedPageCard, { data: { path: '/p/xyz', title: 'Doc', views: 2 } }),
    );
    expect(html).toContain('/p/xyz');
    expect(html).toContain('Copy link');
    expect(html).toContain('Anyone with this link can view');
    expect(html).toContain('Doc');
    expect(html).toContain('2 views');
  });
});
