// SPDX-License-Identifier: Apache-2.0
'use client';

// File preview pane (2026-10-31 minimal-UI redesign): previews a
// workspace file the agent produced, beside the chat column. Content
// comes from the same endpoint the Workspace files panel uses —
// GET /api/files/content?path=… (workspace-confined, text only; binary
// files are refused server-side with 422).
//
//   - Markdown → formatted text (small local renderer in the spirit of
//     the notes panel's preview; the chat has no shared md renderer).
//   - Code / text → the shared CodeBlock (syntax highlight by path).
//   - Anything the endpoint can't serve (images and other binaries —
//     the API exposes no raw-bytes URL) → metadata + a link out to the
//     Workspace files view instead of a broken preview.

import { useEffect, useState } from 'react';
import { authedFetch } from '../../lib/api';
import { CodeBlock } from '../code/CodeBlock';
import { PaneCollapseButton } from '../collapse';

const MARKDOWN_EXTS = new Set(['md', 'markdown', 'mdx']);
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']);

function extOf(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot >= 0 ? path.slice(dot + 1).toLowerCase() : '';
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inlineMd(s: string): string {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<![*\w])\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

/** Minimal, safe markdown → HTML (headings, lists, quotes, code fences, paragraphs). */
export function renderMarkdownLite(src: string): string {
  const out: string[] = [];
  let inCode = false;
  let codeBuf: string[] = [];
  let listOpen = false;
  const closeList = () => {
    if (listOpen) {
      out.push('</ul>');
      listOpen = false;
    }
  };
  for (const line of src.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      if (inCode) {
        out.push(`<pre class="md-pre">${escapeHtml(codeBuf.join('\n'))}</pre>`);
        codeBuf = [];
        inCode = false;
      } else {
        closeList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1]!.length + 1; // h1 in a pane → start at h2
      out.push(`<h${level}>${inlineMd(heading[2]!)}</h${level}>`);
      continue;
    }
    const item = /^\s*[-*]\s+(.*)$/.exec(line);
    if (item) {
      if (!listOpen) {
        out.push('<ul>');
        listOpen = true;
      }
      out.push(`<li>${inlineMd(item[1]!)}</li>`);
      continue;
    }
    closeList();
    if (!line.trim()) continue;
    if (line.trimStart().startsWith('> ')) {
      out.push(`<blockquote>${inlineMd(line.trimStart().slice(2))}</blockquote>`);
      continue;
    }
    out.push(`<p>${inlineMd(line)}</p>`);
  }
  if (inCode) out.push(`<pre class="md-pre">${escapeHtml(codeBuf.join('\n'))}</pre>`);
  closeList();
  return out.join('\n');
}

interface FileContent {
  content: string;
  truncated: boolean;
  size: number;
}

export function FilePreviewPane({
  path,
  onClose,
  onCollapse,
}: {
  path: string;
  onClose: () => void;
  /** Collapse the pane to its slim re-open strip (shared collapse pattern). */
  onCollapse?: () => void;
}) {
  const [state, setState] = useState<
    | { phase: 'loading' }
    | { phase: 'ready'; file: FileContent }
    | { phase: 'unavailable'; error: string }
  >({ phase: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ phase: 'loading' });
    authedFetch(`/api/files/content?path=${encodeURIComponent(path)}`)
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as
          | { ok?: boolean; content?: unknown; truncated?: boolean; size?: number; detail?: string; error?: string }
          | null;
        if (cancelled) return;
        if (res.ok && body?.ok && typeof body.content === 'string') {
          setState({
            phase: 'ready',
            file: { content: body.content, truncated: !!body.truncated, size: body.size ?? body.content.length },
          });
        } else {
          setState({
            phase: 'unavailable',
            error: body?.detail ?? body?.error ?? `${res.status} ${res.statusText}`,
          });
        }
      })
      .catch((e) => {
        if (!cancelled) setState({ phase: 'unavailable', error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  const ext = extOf(path);
  const isMarkdown = MARKDOWN_EXTS.has(ext);
  const isImage = IMAGE_EXTS.has(ext);

  return (
    <aside className="file-preview-pane glass" aria-label={`Preview of ${path}`}>
      <div className="fpp-head">
        <span className="fpp-path mono" title={path}>
          📄 {path}
        </span>
        <span className="fpp-actions">
          {onCollapse && <PaneCollapseButton label="file preview" side="right" onCollapse={onCollapse} />}
          <a className="copy-btn" href="/workspace" title="Open the Workspace files view">
            Workspace ↗
          </a>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close file preview" title="Close">
            ✕
          </button>
        </span>
      </div>
      <div className="fpp-body">
        {state.phase === 'loading' && <div className="muted small">Loading preview…</div>}
        {state.phase === 'ready' && (
          <>
            {isMarkdown ? (
              <div
                className="fpp-markdown"
                // renderMarkdownLite escapes all source HTML first.
                dangerouslySetInnerHTML={{ __html: renderMarkdownLite(state.file.content) }}
              />
            ) : (
              <CodeBlock code={state.file.content} path={path} maxHeight={640} />
            )}
            {state.file.truncated && (
              <div className="muted small" style={{ marginTop: 6 }}>
                Truncated preview — the file is {state.file.size.toLocaleString()} bytes.
              </div>
            )}
          </>
        )}
        {state.phase === 'unavailable' && (
          <div className="fpp-fallback">
            <p className="small">
              {isImage
                ? 'Image preview is not available: the files API serves text content only and exposes no raw image URL.'
                : 'This file could not be previewed.'}
            </p>
            <table className="insp-rows">
              <tbody>
                <tr>
                  <th scope="row">Path</th>
                  <td className="mono">{path}</td>
                </tr>
                <tr>
                  <th scope="row">Type</th>
                  <td className="mono">{ext || '(none)'}</td>
                </tr>
                <tr>
                  <th scope="row">Reader said</th>
                  <td className="mono">{state.error}</td>
                </tr>
              </tbody>
            </table>
            <p className="small">
              <a href="/workspace">Open it in the Workspace files view ↗</a>
            </p>
          </div>
        )}
      </div>
    </aside>
  );
}
