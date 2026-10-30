// SPDX-License-Identifier: Apache-2.0
// C-10 media viewer tests: static rendering style (no JSX transform in
// this repo's vitest setup — React.createElement + renderToStaticMarkup).

import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MediaViewer, downloadFileName, isSavable, mediaFamilyOf } from './media-viewer';

describe('media viewer helpers', () => {
  it('classifies families by mime, falling back to extension', () => {
    expect(mediaFamilyOf({ mimeType: 'image/png', url: 'x' })).toBe('image');
    expect(mediaFamilyOf({ url: 'https://a/clip.mp4' })).toBe('video');
    expect(mediaFamilyOf({ mimeType: 'audio/wav', url: 'x' })).toBe('audio');
    expect(mediaFamilyOf({ mimeType: 'application/pdf', url: 'x.pdf' })).toBe('other');
  });
  it('mock assets are not savable; real URLs are', () => {
    expect(isSavable({ url: 'mock://media/1.png' })).toBe(false);
    expect(isSavable({ url: 'https://a/1.png' })).toBe(true);
  });
  it('download name prefers the URL filename, else a slugged title', () => {
    expect(downloadFileName({ url: 'https://a/photo.jpg', title: 'x' })).toBe('photo.jpg');
    expect(downloadFileName({ url: 'https://a/asset', mimeType: 'image/png', title: 'My Cat!' })).toBe('my-cat.png');
  });
});

describe('MediaViewer', () => {
  it('renders an image with a download anchor', () => {
    const html = renderToStaticMarkup(React.createElement(MediaViewer, { media: { url: 'https://a/pic.png', mimeType: 'image/png', title: 'Pic' } }));
    expect(html).toContain('<img');
    expect(html).toContain('data-action="save"');
    expect(html).toContain('download="pic.png"');
  });
  it('renders video controls; mock assets show the honest unsavable note', () => {
    const v = renderToStaticMarkup(React.createElement(MediaViewer, { media: { url: 'https://a/c.mp4', mimeType: 'video/mp4' } }));
    expect(v).toContain('<video');
    const mock = renderToStaticMarkup(React.createElement(MediaViewer, { media: { url: 'mock://media/1.png', mimeType: 'image/png' } }));
    expect(mock).toContain('data-action="unsavable"');
    expect(mock).not.toContain('data-action="save"');
  });
});
