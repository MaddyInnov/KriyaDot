// SPDX-License-Identifier: Apache-2.0
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  addPageComment,
  addPageMention,
  createPage,
  deletePage,
  deletePageComment,
  authedFetch,
  getBots,
  getPage,
  listPageVersions,
  listPages,
  resolvePageComment,
  restorePageVersion,
  updatePage,
  type BotConfig,
  type Page,
  type PageComment,
  type PageMention,
  type PageVersion,
} from '../../lib/api';

/** Minimal markdown preview — same tiny renderer as notes-panel (no new deps). */
function renderMarkdown(src: string): string {
  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
  return out.join('\n') || '<p class="muted">Nothing to preview yet.</p>';
}

function fmtTs(ts: number): string {
  return new Date(ts).toLocaleString();
}

type SideTab = 'comments' | 'mentions' | 'history';

export function PagesPanel() {
  const [pages, setPages] = useState<Page[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [version, setVersion] = useState(1);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState('');

  const [comments, setComments] = useState<PageComment[]>([]);
  const [mentions, setMentions] = useState<PageMention[]>([]);
  const [versions, setVersions] = useState<PageVersion[]>([]);
  const [sideTab, setSideTab] = useState<SideTab>('comments');
  const [previewVersion, setPreviewVersion] = useState<PageVersion | null>(null);

  const [commentAuthor, setCommentAuthor] = useState('');
  const [commentText, setCommentText] = useState('');
  const [mentionText, setMentionText] = useState('');
  const [mentionContext, setMentionContext] = useState('');
  const [mentionAuthor, setMentionAuthor] = useState('');
  const [mentionCandidates, setMentionCandidates] = useState<BotConfig[]>([]);
  const [bots, setBots] = useState<BotConfig[]>([]);
  const [mentionOpen, setMentionOpen] = useState(false);

  const [live, setLive] = useState(false);
  const [remoteBanner, setRemoteBanner] = useState<string | null>(null);

  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;
  const esRef = useRef<AbortController | null>(null);

  const refreshList = useCallback(async () => {
    try {
      setPages(await listPages());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refreshList();
    getBots().then(setBots).catch(() => undefined);
  }, [refreshList]);

  const openPage = useCallback(async (p: Page) => {
    setSelectedId(p.id);
    setTitle(p.title);
    setContent(p.content);
    setVersion(p.version);
    setDirty(false);
    setPreview(false);
    setPreviewVersion(null);
    setRemoteBanner(null);
    setError('');
    try {
      const detail = await getPage(p.id);
      setComments(detail.comments);
      setMentions(detail.mentions);
      setVersions(await listPageVersions(p.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Live updates for the open page. Fetch-based SSE: EventSource cannot
  // send the Authorization header, so the stream is read with a manual loop.
  useEffect(() => {
    esRef.current?.abort();
    esRef.current = null;
    setLive(false);
    if (!selectedId) return;
    const pageId = selectedId;
    const controller = new AbortController();
    esRef.current = controller;
    const handlePageEvent = (
      data:
        | { kind: 'page'; page: Page }
        | { kind: 'comment'; comment: PageComment }
        | { kind: 'mention'; mention: PageMention }
        | { kind: 'deleted'; pageId: string },
    ) => {
      try {
        if (data.kind === 'page') {
          if (dirtyRef.current) {
            setRemoteBanner(
              `This page was updated elsewhere (v${data.page.version}). Your unsaved edits are kept — save to overwrite, or reload to see theirs.`,
            );
          } else {
            setTitle(data.page.title);
            setContent(data.page.content);
            setVersion(data.page.version);
          }
          void refreshList();
        } else if (data.kind === 'comment') {
          setComments((prev) => {
            const i = prev.findIndex((c) => c.id === data.comment.id);
            if (i >= 0) {
              const next = [...prev];
              next[i] = data.comment;
              return next;
            }
            return [...prev, data.comment];
          });
        } else if (data.kind === 'mention') {
          setMentions((prev) => {
            const i = prev.findIndex((m) => m.id === data.mention.id);
            if (i >= 0) {
              const next = [...prev];
              next[i] = data.mention;
              return next;
            }
            return [data.mention, ...prev];
          });
        } else if (data.kind === 'deleted') {
          setPages((prev) => prev.filter((p) => p.id !== data.pageId));
          if (selectedRef.current === data.pageId) {
            setSelectedId(null);
            setTitle('');
            setContent('');
            setComments([]);
            setMentions([]);
            setVersions([]);
          }
        }
      } catch {
        // ignore malformed events
      }
    };
    (async () => {
      try {
        const streamRes = await authedFetch(`/api/pages/${encodeURIComponent(pageId)}/stream`, {
          signal: controller.signal,
        });
        if (!streamRes.ok || !streamRes.body) throw new Error(`page stream failed (${streamRes.status})`);
        setLive(true);
        const reader = streamRes.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const frames = buf.split('\n\n');
          buf = frames.pop() ?? '';
          for (const frame of frames) {
            for (const line of frame.split('\n')) {
              if (line.startsWith('data:')) {
                try {
                  handlePageEvent(JSON.parse(line.slice(5).trim()));
                } catch {
                  // ignore malformed events
                }
              }
            }
          }
        }
      } catch {
        if (!controller.signal.aborted) setLive(false);
      }
    })();
    return () => {
      controller.abort();
      esRef.current = null;
    };
  }, [selectedId, refreshList]);

  const newPage = () => {
    setSelectedId(null);
    setTitle('');
    setContent('');
    setVersion(1);
    setDirty(false);
    setPreview(false);
    setPreviewVersion(null);
    setComments([]);
    setMentions([]);
    setVersions([]);
    setRemoteBanner(null);
    setError('');
  };

  const save = async () => {
    if (!title.trim()) {
      setError('Title is required.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      if (selectedId) {
        const p = await updatePage(selectedId, { title: title.trim(), content });
        setVersion(p.version);
        setDirty(false);
        setRemoteBanner(null);
      } else {
        const p = await createPage({ title: title.trim(), content });
        setSelectedId(p.id);
        setVersion(p.version);
        setDirty(false);
        setVersions([]);
      }
      await refreshList();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!selectedId || !window.confirm('Delete this page? Version history is kept for audit.')) return;
    try {
      await deletePage(selectedId);
      newPage();
      await refreshList();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const reloadRemote = async () => {
    if (!selectedId) return;
    try {
      const detail = await getPage(selectedId);
      setTitle(detail.title);
      setContent(detail.content);
      setVersion(detail.version);
      setDirty(false);
      setRemoteBanner(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const submitComment = async () => {
    if (!selectedId || !commentText.trim()) return;
    try {
      const c = await addPageComment(selectedId, {
        author: commentAuthor.trim() || 'anonymous',
        text: commentText.trim(),
      });
      setComments((prev) => [...prev, c]);
      setCommentText('');
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const toggleResolve = async (c: PageComment) => {
    if (!selectedId) return;
    try {
      const updated = await resolvePageComment(selectedId, c.id, !c.resolved);
      setComments((prev) => prev.map((x) => (x.id === c.id ? updated : x)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const removeComment = async (c: PageComment) => {
    if (!selectedId) return;
    try {
      await deletePageComment(selectedId, c.id);
      setComments((prev) => prev.filter((x) => x.id !== c.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // @mention autocomplete: typing "@" filters the bot roster.
  const onMentionChange = (v: string) => {
    setMentionText(v);
    const m = /@([\w-]*)$/.exec(v);
    if (m) {
      const q = m[1].toLowerCase();
      setMentionCandidates(
        bots.filter((b) => b.name.toLowerCase().includes(q) || b.id.toLowerCase().includes(q)).slice(0, 6),
      );
      setMentionOpen(true);
    } else {
      setMentionOpen(false);
    }
  };

  const pickMention = (b: BotConfig) => {
    setMentionText(mentionText.replace(/@[\w-]*$/, `@${b.name} `));
    setMentionOpen(false);
  };

  const submitMention = async () => {
    if (!selectedId) return;
    const m = /@([\w-]+)/.exec(mentionText);
    const mentioned = m ? m[1] : mentionText.trim().replace(/^@/, '');
    if (!mentioned) {
      setError('Type @bot-name to mention someone.');
      return;
    }
    try {
      const rec = await addPageMention(selectedId, {
        mentioned,
        context: mentionContext.trim(),
        author: mentionAuthor.trim() || 'anonymous',
      });
      setMentions((prev) => [rec, ...prev]);
      setMentionText('');
      setMentionContext('');
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const restoreVersion = async (v: PageVersion) => {
    if (!selectedId || !window.confirm(`Restore v${v.version}? Current state is saved as a new version first.`)) return;
    try {
      const restored = await restorePageVersion(selectedId, v.id);
      setTitle(restored.title);
      setContent(restored.content);
      setVersion(restored.version);
      setDirty(false);
      setPreviewVersion(null);
      setVersions(await listPageVersions(selectedId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const selected = pages.find((p) => p.id === selectedId) ?? null;

  return (
    <div>
      <div className="row-between">
        <div>
          <h1 className="page-title">Pages</h1>
          <p className="page-sub">
            Collaborative documents — humans and agents co-edit live.{' '}
            {live && selectedId ? <span className="small" style={{ color: 'var(--green)' }}>● live</span> : null}
          </p>
        </div>
        <button className="btn btn-primary" onClick={newPage}>
          + New page
        </button>
      </div>

      {error ? <div className="error-box mt">{error}</div> : null}
      {remoteBanner ? (
        <div className="error-box mt" style={{ borderColor: 'var(--amber)', color: 'var(--amber)' }}>
          {remoteBanner}{' '}
          <button className="btn btn-sm" onClick={() => void reloadRemote()} style={{ marginLeft: 8 }}>
            Load theirs
          </button>
        </div>
      ) : null}

      <div className="mt" style={{ display: 'grid', gridTemplateColumns: '240px 1fr 320px', gap: 16, alignItems: 'start' }}>
        {/* Page list */}
        <div className="card" style={{ maxHeight: 560, overflowY: 'auto' }}>
          <div className="label" style={{ marginBottom: 8 }}>
            Pages ({pages.length})
          </div>
          {pages.length === 0 ? (
            <p className="small muted">No pages yet — create one to start collaborating.</p>
          ) : (
            pages.map((p) => (
              <button
                key={p.id}
                onClick={() => void openPage(p)}
                className="truncate"
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '8px 10px',
                  borderRadius: 10,
                  border: 'none',
                  cursor: 'pointer',
                  background: p.id === selectedId ? 'var(--accent-soft)' : 'transparent',
                  color: 'var(--text)',
                  marginBottom: 4,
                }}
              >
                <div style={{ fontWeight: 600 }}>{p.title}</div>
                <div className="small muted">
                  v{p.version} · {fmtTs(p.updatedAt)}
                </div>
              </button>
            ))
          )}
        </div>

        {/* Editor */}
        <div className="card">
          <div className="field">
            <label className="label" htmlFor="page-title">
              Title
            </label>
            <input
              id="page-title"
              className="input"
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                setDirty(true);
              }}
              placeholder="Untitled page"
            />
          </div>
          <div className="row-between mt">
            <span className="label">Content (markdown){dirty ? ' · unsaved' : ''}</span>
            <div>
              <button className="btn btn-sm" onClick={() => setPreview((v) => !v)}>
                {preview ? 'Edit' : 'Preview'}
              </button>
            </div>
          </div>
          {preview ? (
            <div
              className="mt"
              style={{
                border: '1px solid var(--border)',
                borderRadius: 12,
                padding: 16,
                minHeight: 240,
                background: 'var(--surface)',
              }}
              dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
            />
          ) : (
            <textarea
              className="textarea mono mt"
              style={{ minHeight: 320, width: '100%' }}
              value={content}
              onChange={(e) => {
                setContent(e.target.value);
                setDirty(true);
              }}
              placeholder="# Start writing… Mention a bot with @name in the Mentions tab."
            />
          )}
          <div className="row-between mt">
            <span className="small muted">
              {selectedId ? `v${version}` : 'new page'}
              {selected?.createdBy ? ` · by ${selected.createdBy}` : ''}
            </span>
            <div style={{ display: 'flex', gap: 8 }}>
              {selectedId ? (
                <button className="btn btn-sm" onClick={() => void remove()}>
                  Delete
                </button>
              ) : null}
              <button className="btn btn-primary btn-sm" onClick={() => void save()} disabled={saving}>
                {saving ? 'Saving…' : selectedId ? 'Save' : 'Create page'}
              </button>
            </div>
          </div>

          {previewVersion ? (
            <div className="mt" style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
              <div className="row-between">
                <strong>
                  Previewing v{previewVersion.version} <span className="small muted">({fmtTs(previewVersion.createdAt)})</span>
                </strong>
                <button className="btn btn-sm" onClick={() => setPreviewVersion(null)}>
                  Close
                </button>
              </div>
              <div
                className="mt"
                style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 16, background: 'var(--surface)' }}
                dangerouslySetInnerHTML={{ __html: renderMarkdown(previewVersion.content) }}
              />
            </div>
          ) : null}
        </div>

        {/* Side panel: comments / mentions / history */}
        <div className="card" style={{ maxHeight: 640, overflowY: 'auto' }}>
          <div style={{ display: 'flex', gap: 4, marginBottom: 12 }}>
            {(['comments', 'mentions', 'history'] as SideTab[]).map((t) => (
              <button
                key={t}
                onClick={() => setSideTab(t)}
                className="btn btn-sm"
                style={{
                  background: sideTab === t ? 'var(--accent-soft)' : 'transparent',
                  textTransform: 'capitalize',
                }}
              >
                {t}
                {t === 'comments' && comments.filter((c) => !c.resolved).length > 0
                  ? ` (${comments.filter((c) => !c.resolved).length})`
                  : ''}
              </button>
            ))}
          </div>

          {!selectedId ? (
            <p className="small muted">Open a page to see comments, mentions, and history.</p>
          ) : sideTab === 'comments' ? (
            <div>
              {comments.length === 0 ? (
                <p className="small muted">No comments yet.</p>
              ) : (
                comments.map((c) => (
                  <div
                    key={c.id}
                    style={{
                      border: '1px solid var(--border)',
                      borderRadius: 10,
                      padding: 10,
                      marginBottom: 8,
                      opacity: c.resolved ? 0.6 : 1,
                    }}
                  >
                    <div className="row-between">
                      <strong className="small">{c.author}</strong>
                      <span className="small muted">{fmtTs(c.createdAt)}</span>
                    </div>
                    <p className="small" style={{ margin: '6px 0' }}>
                      {c.text}
                    </p>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="btn btn-sm" onClick={() => void toggleResolve(c)}>
                        {c.resolved ? 'Reopen' : 'Resolve'}
                      </button>
                      <button className="btn btn-sm" onClick={() => void removeComment(c)}>
                        Delete
                      </button>
                    </div>
                  </div>
                ))
              )}
              <div className="field mt">
                <label className="label">Your name</label>
                <input
                  className="input"
                  value={commentAuthor}
                  onChange={(e) => setCommentAuthor(e.target.value)}
                  placeholder="anonymous"
                />
              </div>
              <div className="field mt">
                <label className="label">Add a comment</label>
                <textarea
                  className="textarea"
                  style={{ minHeight: 70 }}
                  value={commentText}
                  onChange={(e) => setCommentText(e.target.value)}
                  placeholder="Write a comment…"
                />
              </div>
              <button className="btn btn-primary btn-sm mt" onClick={() => void submitComment()}>
                Comment
              </button>
            </div>
          ) : sideTab === 'mentions' ? (
            <div>
              <p className="small muted" style={{ marginBottom: 8 }}>
                Mention a bot with <span className="mono">@name</span> — it reads the page and replies right here.
              </p>
              <div className="field" style={{ position: 'relative' }}>
                <label className="label">Mention</label>
                <input
                  className="input mono"
                  value={mentionText}
                  onChange={(e) => onMentionChange(e.target.value)}
                  placeholder="@coder review this section"
                />
                {mentionOpen && mentionCandidates.length > 0 ? (
                  <div
                    style={{
                      position: 'absolute',
                      zIndex: 10,
                      left: 0,
                      right: 0,
                      top: '100%',
                      background: 'var(--surface)',
                      border: '1px solid var(--border)',
                      borderRadius: 10,
                      marginTop: 4,
                      overflow: 'hidden',
                    }}
                  >
                    {mentionCandidates.map((b) => (
                      <button
                        key={b.id}
                        onClick={() => pickMention(b)}
                        style={{
                          display: 'block',
                          width: '100%',
                          textAlign: 'left',
                          padding: '8px 10px',
                          border: 'none',
                          background: 'transparent',
                          cursor: 'pointer',
                          color: 'var(--text)',
                        }}
                      >
                        <strong>@{b.name}</strong> <span className="small muted">{b.description}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              <div className="field mt">
                <label className="label">Context for the bot (optional)</label>
                <input
                  className="input"
                  value={mentionContext}
                  onChange={(e) => setMentionContext(e.target.value)}
                  placeholder="what should it look at?"
                />
              </div>
              <div className="field mt">
                <label className="label">Your name</label>
                <input
                  className="input"
                  value={mentionAuthor}
                  onChange={(e) => setMentionAuthor(e.target.value)}
                  placeholder="anonymous"
                />
              </div>
              <button className="btn btn-primary btn-sm mt" onClick={() => void submitMention()}>
                Mention
              </button>
              <div className="mt">
                {mentions.length === 0 ? (
                  <p className="small muted">No mentions yet.</p>
                ) : (
                  mentions.map((m) => (
                    <div
                      key={m.id}
                      style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 10, marginBottom: 8 }}
                    >
                      <div className="row-between">
                        <strong className="small">
                          @{m.mentioned}
                          {m.isBot ? <span className="small muted"> (bot)</span> : null}
                        </strong>
                        <span
                          className="small"
                          style={{
                            color:
                              m.status === 'done'
                                ? 'var(--green)'
                                : m.status === 'failed'
                                  ? 'var(--red)'
                                  : 'var(--amber)',
                          }}
                        >
                          {m.status}
                        </span>
                      </div>
                      {m.context ? (
                        <p className="small" style={{ margin: '6px 0' }}>
                          {m.context}
                        </p>
                      ) : null}
                      <p className="small muted" style={{ margin: 0 }}>
                        by {m.author || 'anonymous'} · {fmtTs(m.createdAt)}
                      </p>
                    </div>
                  ))
                )}
              </div>
            </div>
          ) : (
            <div>
              {versions.length === 0 ? (
                <p className="small muted">No earlier versions — edit and save to create one.</p>
              ) : (
                versions.map((v) => (
                  <div
                    key={v.id}
                    style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 10, marginBottom: 8 }}
                  >
                    <div className="row-between">
                      <strong className="small">v{v.version}</strong>
                      <span className="small muted">{fmtTs(v.createdAt)}</span>
                    </div>
                    <p className="small muted" style={{ margin: '4px 0' }}>
                      {v.title}
                      {v.createdBy ? ` · by ${v.createdBy}` : ''}
                    </p>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        className="btn btn-sm"
                        onClick={() => setPreviewVersion(previewVersion?.id === v.id ? null : v)}
                      >
                        {previewVersion?.id === v.id ? 'Hide' : 'Preview'}
                      </button>
                      <button className="btn btn-sm" onClick={() => void restoreVersion(v)}>
                        Restore
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
