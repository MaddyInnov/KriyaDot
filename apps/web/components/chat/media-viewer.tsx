// SPDX-License-Identifier: Apache-2.0
// In-chat media viewer with save/download (Muse parity §4.5 C-10).
//
// A lightbox for image / video / audio attachments and generated media:
// renders the right element for the mime family, and always offers a
// Save/Download action (an <a download> for direct URLs; mock:// assets
// are honestly labelled as having no bytes to save yet).

'use client';

import React from 'react';

export interface ViewableMedia {
  url: string;
  mimeType?: string;
  title?: string;
}

export type MediaFamily = 'image' | 'video' | 'audio' | 'other';

export function mediaFamilyOf(m: Pick<ViewableMedia, 'mimeType' | 'url'>): MediaFamily {
  const mt = (m.mimeType ?? '').toLowerCase();
  if (mt.startsWith('image/')) return 'image';
  if (mt.startsWith('video/')) return 'video';
  if (mt.startsWith('audio/')) return 'audio';
  if (/\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(m.url)) return 'image';
  if (/\.(mp4|webm|mov)(\?|$)/i.test(m.url)) return 'video';
  if (/\.(mp3|wav|ogg|m4a)(\?|$)/i.test(m.url)) return 'audio';
  return 'other';
}

/** mock:// assets come from the offline provider: no bytes exist to save. */
export function isSavable(m: Pick<ViewableMedia, 'url'>): boolean {
  return !m.url.startsWith('mock://');
}

export function downloadFileName(m: ViewableMedia): string {
  const fromUrl = m.url.split('/').pop()?.split('?')[0] ?? '';
  if (fromUrl && fromUrl.includes('.')) return fromUrl;
  const ext = (m.mimeType ?? '').split('/')[1] ?? 'bin';
  const slug = (m.title ?? 'media').replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-+|-+$/g, '').slice(0, 40) || 'media';
  return `${slug}.${ext}`;
}

export function MediaViewer({ media, onClose }: { media: ViewableMedia; onClose?: () => void }) {
  const family = mediaFamilyOf(media);
  const savable = isSavable(media);
  return (
    <div className="media-viewer" role="dialog" aria-label={media.title ?? 'Media viewer'} data-family={family}>
      <div className="media-viewer-head row-between">
        <span className="small">{media.title ?? 'Media'}</span>
        <span className="row">
          {savable ? (
            <a className="btn btn-sm" href={media.url} download={downloadFileName(media)} data-action="save">
              Save / Download
            </a>
          ) : (
            <span className="small muted" data-action="unsavable">Mock asset — no bytes to save yet</span>
          )}
          {onClose ? (
            <button className="btn btn-sm" onClick={onClose} aria-label="Close viewer">Close</button>
          ) : null}
        </span>
      </div>
      <div className="media-viewer-body mt">
        {family === 'image' ? (
          <img src={media.url} alt={media.title ?? 'Shared image'} style={{ maxWidth: '100%', borderRadius: 12 }} />
        ) : family === 'video' ? (
          <video controls src={media.url} style={{ maxWidth: '100%', borderRadius: 12 }} />
        ) : family === 'audio' ? (
          <audio controls src={media.url} style={{ width: '100%' }} />
        ) : (
          <p className="small muted">Preview not available for this file type — use Save / Download.</p>
        )}
      </div>
    </div>
  );
}
