// SPDX-License-Identifier: Apache-2.0
'use client';

// Shared helpers for the per-module pages under app/modules/.
import React, { useCallback, useEffect, useState } from 'react';
import { authedFetch } from '../../lib/api';

export const MODULES_BASE = '/api/modules';

export const api = (path: string, init?: RequestInit): Promise<unknown> =>
  authedFetch(path, init).then(async (res) => {
    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new Error(`API ${res.status}: ${detail || res.statusText}`);
    }
    const text = await res.text();
    return text ? (JSON.parse(text) as unknown) : null;
  });

export function fmtTs(ts: number): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

export function fmtMoney(cents: number, currency: string): string {
  return `${currency} ${(cents / 100).toFixed(2)}`;
}

/** Tiny markdown renderer (headings, lists, code, bold, italic, links). */
export function Markdown({ src }: { src: string }): React.ReactElement {
  const esc = (s: string): string =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  const inline = (s: string): string =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code class="mono">$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|\W)\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  const lines = src.split('\n');
  const out: string[] = [];
  let inList = false;
  let inCode = false;
  let codeBuf: string[] = [];
  for (const line of lines) {
    if (/^```/.test(line)) {
      if (inCode) {
        out.push(`<pre class="mono"><code>${esc(codeBuf.join('\n'))}</code></pre>`);
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
      out.push(`<h${h[1].length} class="md-h">${inline(h[2])}</h${h[1].length}>`);
      continue;
    }
    const li = /^[-*]\s+(.*)$/.exec(line);
    if (li) {
      if (!inList) {
        out.push('<ul class="md-ul">');
        inList = true;
      }
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
    if (line.trim()) out.push(`<p class="md-p">${inline(line)}</p>`);
  }
  if (inList) out.push('</ul>');
  if (inCode) out.push(`<pre class="mono"><code>${esc(codeBuf.join('\n'))}</code></pre>`);
  return <div dangerouslySetInnerHTML={{ __html: out.join('\n') }} />;
}

export function PageHeader({
  title,
  sub,
  onRefresh,
}: {
  title: string;
  sub: string;
  onRefresh?: () => void;
}): React.ReactElement {
  return (
    <div className="row-between">
      <div>
        <h1 className="page-title">{title}</h1>
        <p className="page-sub">{sub}</p>
      </div>
      {onRefresh && (
        <button className="btn" onClick={onRefresh}>
          Refresh
        </button>
      )}
    </div>
  );
}

export function ErrorBox({ error }: { error: string }): React.ReactElement | null {
  if (!error) return null;
  return <div className="error-box">{error}</div>;
}

export function EmptyState({ text }: { text: string }): React.ReactElement {
  return <div className="card muted small">{text}</div>;
}

/** Generic list-page hook: loads data, exposes refresh + error. */
export function useModuleData<T>(loader: () => Promise<T>): {
  data: T | null;
  error: string;
  refresh: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const refresh = useCallback(() => {
    loader()
      .then((d) => {
        setData(d);
        setError('');
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [loader]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  return { data, error, refresh };
}
