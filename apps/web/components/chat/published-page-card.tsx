// SPDX-License-Identifier: Apache-2.0
'use client';

// Published-page card: rendered in chat when a bot's `publish_page` tool
// result lands. Shows the public link with a copy affordance. The path is a
// same-origin relative path (/p/<slug>) served by the user's own KriyaDot
// server — reachability depends on how that server is exposed.

import React, { useState } from 'react';

export interface PublishedPageData {
  title?: string;
  /** Public URL path, e.g. /p/<slug>. */
  path: string;
  views?: number;
}

/** Extract a PublishedPageData from a publish_page tool result, or null. */
export function publishedPageFromToolResult(toolName: string, result: unknown): PublishedPageData | null {
  if (toolName !== 'publish_page') return null;
  if (typeof result !== 'object' || result === null) return null;
  const r = result as { published?: unknown; path?: unknown; title?: unknown; views?: unknown };
  if (r.published !== true || typeof r.path !== 'string' || !r.path.startsWith('/p/')) return null;
  return {
    path: r.path,
    title: typeof r.title === 'string' ? r.title : undefined,
    views: typeof r.views === 'number' ? r.views : undefined,
  };
}

export function PublishedPageCard({ data }: { data: PublishedPageData }) {
  const [copied, setCopied] = useState(false);
  const fullUrl = typeof window !== 'undefined' ? `${window.location.origin}${data.path}` : data.path;

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(fullUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (permissions/insecure context): the link text
      // below is still selectable by hand.
    }
  };

  return (
    <div
      className="approval-card"
      style={{ borderLeft: '3px solid var(--green, #2f9e44)' }}
      data-testid="published-page-card"
    >
      <h4>🌐 Page published{data.title ? ` — ${data.title}` : ''}</h4>
      <p className="small muted" style={{ margin: '6px 0' }}>
        Anyone with this link can view the page (no sign-in).
        {typeof data.views === 'number' ? ` ${data.views} view${data.views === 1 ? '' : 's'} so far.` : ''}
      </p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <a href={data.path} target="_blank" rel="noreferrer" className="mono small">
          {fullUrl}
        </a>
        <button className="btn btn-sm" onClick={() => void copy()}>
          {copied ? 'Copied!' : 'Copy link'}
        </button>
      </div>
    </div>
  );
}
