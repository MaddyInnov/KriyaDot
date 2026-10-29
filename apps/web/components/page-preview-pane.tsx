// SPDX-License-Identifier: Apache-2.0
'use client';

// Page preview pane with point-to-change.
//
// Sits beside the page editor/chat: shows the page's current draft in an
// iframe (fetched through authedFetch — the preview endpoint requires the
// API token header — and loaded as a blob URL). In point mode the preview
// document's injected picker script reports clicked elements via
// postMessage; the pane shows the selection and a change-description box.
// Submitting composes an instruction referencing the element + page id
// and sends it into the page's bot chat via POST /api/chat.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { authedFetch } from '../lib/api';

export interface PickedElement {
  tag: string;
  text: string;
  path: string;
}

/** Validate + normalize a picker postMessage payload (exported for tests). */
export function parsePickedElement(data: unknown): PickedElement | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const d = data as { type?: unknown; tag?: unknown; text?: unknown; path?: unknown };
  if (d.type !== 'kriyadot:page-element') return null;
  if (typeof d.tag !== 'string' || !d.tag) return null;
  return {
    tag: d.tag,
    text: typeof d.text === 'string' ? d.text.slice(0, 200) : '',
    path: typeof d.path === 'string' ? d.path : d.tag,
  };
}

/** Compose the chat instruction for a point-to-change request. */
export function composeChangeInstruction(opts: {
  pageId: string;
  pageTitle?: string;
  element: PickedElement;
  change: string;
}): string {
  return [
    `On the page "${opts.pageTitle ?? opts.pageId}" (page id: ${opts.pageId}), please change the element I selected in the preview.`,
    `Element: <${opts.element.tag}> at ${opts.element.path}`,
    `Current text: "${opts.element.text}"`,
    `Requested change: ${opts.change}`,
    'Edit the page content accordingly and keep everything else unchanged.',
  ].join('\n');
}

export interface PagePreviewPaneProps {
  pageId: string;
  pageTitle?: string;
  /** Bot whose chat receives the change request (POST /api/chat). */
  botId?: string;
  sessionId?: string;
  /** Override the send path (tests / custom hosts). */
  onSendChange?: (instruction: string) => Promise<void>;
}

export function PagePreviewPane({ pageId, pageTitle, botId, sessionId, onSendChange }: PagePreviewPaneProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [pointMode, setPointMode] = useState(false);
  const [picked, setPicked] = useState<PickedElement | null>(null);
  const [change, setChange] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async () => {
    try {
      const res = await authedFetch(
        `/api/pages/${encodeURIComponent(pageId)}/preview?picker=1`,
      );
      if (!res.ok) {
        setStatus(`Preview failed (HTTP ${res.status})`);
        return;
      }
      const blob = await res.blob();
      setBlobUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(blob);
      });
    } catch {
      setStatus('Preview unavailable — is the API running?');
    }
  }, [pageId]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  useEffect(() => {
    if (!pointMode) return;
    const onMessage = (e: MessageEvent) => {
      // The preview loads from a blob: URL (opaque origin), so validate
      // by source window identity + payload shape, not by origin.
      if (e.source !== iframeRef.current?.contentWindow) return;
      const el = parsePickedElement(e.data);
      if (el) setPicked(el);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [pointMode]);

  const submit = async () => {
    if (!picked || !change.trim()) return;
    const instruction = composeChangeInstruction({
      pageId,
      pageTitle,
      element: picked,
      change: change.trim(),
    });
    setStatus('Sending…');
    try {
      if (onSendChange) {
        await onSendChange(instruction);
      } else {
        if (!botId) {
          setStatus('No bot selected for this page chat.');
          return;
        }
        const res = await authedFetch('/api/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            botId,
            message: instruction,
            ...(sessionId ? { sessionId } : {}),
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // Drain the stream so the turn actually runs to completion.
        await res.text().catch(() => undefined);
      }
      setStatus('Change request sent to the page chat.');
      setChange('');
    } catch {
      setStatus('Failed to send the change request.');
    }
  };

  return (
    <div className="page-preview-pane" data-testid="page-preview-pane">
      <div className="page-preview-toolbar" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <strong>Preview</strong>
        <button
          type="button"
          className={`btn btn-sm${pointMode ? ' btn-primary' : ''}`}
          aria-pressed={pointMode}
          onClick={() => setPointMode((v) => !v)}
        >
          {pointMode ? 'Pointing… click an element' : 'Point to change'}
        </button>
        <button type="button" className="btn btn-sm" onClick={() => setReloadKey((k) => k + 1)}>
          Reload
        </button>
      </div>
      {blobUrl ? (
        <iframe
          ref={iframeRef}
          className="page-preview-frame"
          src={blobUrl}
          title={`Preview of ${pageTitle ?? pageId}`}
          sandbox="allow-scripts"
          style={{ width: '100%', minHeight: 420, border: '1px solid var(--border, #ddd)', borderRadius: 8 }}
        />
      ) : (
        <div className="small muted">Loading preview…</div>
      )}
      {pointMode && (
        <div className="page-preview-change">
          {picked ? (
            <div className="small">
              Selected: <span className="mono">&lt;{picked.tag}&gt;</span>{' '}
              <span className="muted">{picked.path}</span>
              {picked.text && <div className="muted">“{picked.text}”</div>}
            </div>
          ) : (
            <div className="small muted">Click an element in the preview to select it.</div>
          )}
          <textarea
            className="widget-textarea"
            rows={3}
            placeholder="Describe the change…"
            value={change}
            onChange={(e) => setChange(e.target.value)}
            aria-label="Change description"
          />
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void submit()}
            disabled={!picked || !change.trim()}
          >
            Send change to page chat
          </button>
        </div>
      )}
      {status && <div className="small muted">{status}</div>}
    </div>
  );
}
