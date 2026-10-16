// SPDX-License-Identifier: Apache-2.0
'use client';

// Chat composer affordance: attach a note or page to the current thread
// (or bot-wide) so it lands in the bot's context on every turn.
// Backed by /api/note-attachments; the API injects attached content into
// the system prompt via an AgentRuntime context provider.

import { useCallback, useEffect, useRef, useState } from 'react';
import { authedFetch } from '../../lib/api';
import {
  attachNote,
  detachNote,
  listNoteAttachments,
  type AttachmentKind,
  type NoteAttachment,
} from '../../lib/kriyadot-api';

interface DocItem {
  id: string;
  title: string;
}

async function fetchDocs(kind: 'notes' | 'pages'): Promise<DocItem[]> {
  const res = await authedFetch(`/api/${kind}`);
  if (!res.ok) return [];
  const data = (await res.json()) as unknown;
  if (!Array.isArray(data)) return [];
  return (data as Array<{ id?: unknown; title?: unknown }>)
    .filter((d) => typeof d.id === 'string' && typeof d.title === 'string')
    .map((d) => ({ id: d.id as string, title: d.title as string }));
}

interface Props {
  botId: string;
  botName: string;
  /** Active conversation id (backend session id); '' when none yet. */
  sessionId: string;
  disabled?: boolean;
}

export function NoteAttachButton({ botId, botName, sessionId, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'notes' | 'pages'>('notes');
  const [query, setQuery] = useState('');
  const [docs, setDocs] = useState<DocItem[]>([]);
  const [attachments, setAttachments] = useState<NoteAttachment[]>([]);
  const [scope, setScope] = useState<'thread' | 'bot'>('thread');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const wrapRef = useRef<HTMLSpanElement>(null);

  const refresh = useCallback(async () => {
    if (!botId) return;
    try {
      const [d, a] = await Promise.all([
        fetchDocs(tab),
        listNoteAttachments({ botId, sessionId: sessionId || undefined }).catch(() => ({ ok: false as const, attachments: [] as NoteAttachment[] })),
      ]);
      setDocs(d);
      setAttachments(a.attachments);
    } catch {
      // never break the composer
    }
  }, [botId, sessionId, tab]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open ]);

  const doAttach = async (kind: AttachmentKind, refId: string) => {
    setBusy(refId);
    setError('');
    try {
      await attachNote({
        kind,
        refId,
        botId: scope === 'bot' ? botId : undefined,
        sessionId: scope === 'thread' ? sessionId || undefined : undefined,
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Attach failed');
    } finally {
      setBusy('');
    }
  };

  const doDetach = async (id: string) => {
    setBusy(id);
    setError('');
    try {
      await detachNote(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Detach failed');
    } finally {
      setBusy('');
    }
  };

  const q = query.trim().toLowerCase();
  const visible = q ? docs.filter((d) => d.title.toLowerCase().includes(q)) : docs;
  const attachedRefIds = new Set(attachments.map((a) => `${a.kind}:${a.refId}`));

  return (
    <span ref={wrapRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        className="icon-btn"
        disabled={disabled}
        title={disabled ? 'Select a bot first' : 'Attach a note or page to the bot\u2019s context'}
        aria-label="Attach a note or page"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        📎
      </button>
      {open && !disabled && (
        <div
          className="card"
          role="dialog"
          aria-label="Attach notes or pages"
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 8px)',
            left: 0,
            width: 340,
            maxHeight: 420,
            overflow: 'auto',
            zIndex: 60,
            margin: 0,
          }}
        >
          <div className="row-between" style={{ marginBottom: 8 }}>
            <strong className="small">Attach to context</strong>
            <button type="button" className="icon-btn xs" onClick={() => setOpen(false)} aria-label="Close">
              ✕
            </button>
          </div>

          <div className="small muted" style={{ marginBottom: 8 }}>
            Scope:{' '}
            <label style={{ marginRight: 8 }}>
              <input
                type="radio"
                checked={scope === 'thread'}
                disabled={!sessionId}
                onChange={() => setScope('thread')}
              />{' '}
              This chat
            </label>
            <label>
              <input type="radio" checked={scope === 'bot'} onChange={() => setScope('bot')} /> All chats
              with {botName}
            </label>
            {!sessionId && scope === 'thread' && (
              <div className="small">Start chatting first to attach to this thread.</div>
            )}
          </div>

          {attachments.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div className="small muted" style={{ marginBottom: 4 }}>
                Attached ({attachments.length})
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {attachments.map((a) => (
                  <span key={a.id} className="chip" title={`${a.kind}: ${a.sessionId ? 'this chat' : 'all chats'}`}>
                    {a.kind === 'note' ? '📝' : '📄'} {a.title}
                    <button
                      type="button"
                      className="icon-btn xs"
                      style={{ marginLeft: 4 }}
                      disabled={busy === a.id}
                      onClick={() => void doDetach(a.id)}
                      aria-label={`Detach ${a.title}`}
                    >
                      ✕
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
            {(['notes', 'pages'] as const).map((t) => (
              <button
                key={t}
                type="button"
                className={`btn btn-sm${tab === t ? ' btn-primary' : ''}`}
                onClick={() => setTab(t)}
              >
                {t === 'notes' ? 'Notes' : 'Pages'}
              </button>
            ))}
            <input
              className="input"
              style={{ flex: 1 }}
              placeholder={`Search ${tab}…`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label={`Search ${tab}`}
            />
          </div>

          {error && <div className="small" style={{ color: 'var(--danger, #c0392b)', marginBottom: 8 }}>{error}</div>}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {visible.length === 0 && <div className="small muted">No {tab} found.</div>}
            {visible.slice(0, 30).map((d) => {
              const key = `${tab === 'notes' ? 'note' : 'page'}:${d.id}`;
              const already = attachedRefIds.has(key);
              return (
                <div key={d.id} className="row-between" style={{ gap: 8 }}>
                  <span className="small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={d.title}>
                    {tab === 'notes' ? '📝' : '📄'} {d.title}
                  </span>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={already || busy === d.id || (scope === 'thread' && !sessionId)}
                    onClick={() => void doAttach(tab === 'notes' ? 'note' : 'page', d.id)}
                  >
                    {busy === d.id ? '…' : already ? 'Attached' : 'Attach'}
                  </button>
                </div>
              );
            })}
          </div>
          <div className="small muted" style={{ marginTop: 8 }}>
            Attached content is added to the bot&apos;s context on every turn.
          </div>
        </div>
      )}
    </span>
  );
}
