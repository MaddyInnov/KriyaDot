// SPDX-License-Identifier: Apache-2.0
'use client';

/**
 * Memory explorer (OH-3/OH-4) — the Workspace surface for durable memory:
 * browse/search/filter a bot's atoms, forget one with an inline confirm,
 * ask memory a question (citations shown; extractive mode labelled
 * honestly as matching memories, not an AI answer), and manage the
 * per-source ingestion switches (files / rss / gmail / drive) with a
 * "Run now" pass. Every section collapses through the shared collapse
 * kit (lib/use-collapsed.ts + components/collapse.tsx).
 *
 * Contract notes (coded against the fixed OH contracts; see the W4 log):
 * - GET /api/memory/atoms predates the q/category params — the explorer
 *   sends them AND re-applies the same filter client-side, so the UI is
 *   correct against both the old and the contract server.
 * - Ingestion payloads are normalized from either an array of sources or
 *   a per-id map; RSS feeds accept `feeds[]`, `feedUrl`, or `url`.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  askMemory,
  deleteMemoryAtom,
  getBots,
  getMemoryAtoms,
  getMemoryIngestion,
  getMemoryStats,
  runMemoryIngestion,
  saveMemoryIngestion,
  type BotConfig,
  type MemoryAskResult,
  type MemoryAtomRecord,
  type MemoryIngestionSource,
  type MemoryStats,
} from '../../lib/api';
import { useCollapsed } from '../../lib/use-collapsed';
import { CollapseChevron } from '../collapse';
import { MemoryProposalsSection } from './memory-proposals';
import { MemoryDreamsSection } from './memory-dreams';

export const MEMORY_CATEGORIES = [
  'fact',
  'preference',
  'summary',
  'decision',
  'lesson',
  'procedure',
  'reflection',
] as const;

const KNOWN_SOURCES = ['files', 'rss', 'gmail', 'drive'] as const;

const SOURCE_LABELS: Record<string, string> = {
  files: 'Workspace files',
  rss: 'RSS feeds',
  gmail: 'Gmail',
  drive: 'Google Drive',
};

/** Client-side mirror of the server q/category filter (see header note). */
export function filterAtomsClient(
  atoms: MemoryAtomRecord[],
  q: string,
  category: string,
): MemoryAtomRecord[] {
  const needle = q.trim().toLowerCase();
  return atoms.filter((a) => {
    if (category && a.category !== category) return false;
    if (needle && !a.fact.toLowerCase().includes(needle)) return false;
    return true;
  });
}

/** RSS feed URLs of a source, across the feeds/feedUrl/url wire shapes. */
export function rssFeedsOf(source: MemoryIngestionSource): string[] {
  if (Array.isArray(source.feeds)) return source.feeds.filter((f) => typeof f === 'string');
  const single = source.feedUrl ?? (source as { url?: string }).url;
  return typeof single === 'string' && single ? [single] : [];
}

/** Normalize an ingestion payload (array or per-id map) to an ordered list. */
export function normalizeIngestionSources(raw: unknown): MemoryIngestionSource[] {
  const entries: MemoryIngestionSource[] = [];
  const push = (id: string, v: unknown) => {
    if (!v || typeof v !== 'object') return;
    const s = v as Record<string, unknown>;
    entries.push({
      id,
      enabled: s.enabled === true,
      available: s.available !== false,
      ...(typeof s.unavailableReason === 'string' ? { unavailableReason: s.unavailableReason } : {}),
      ...(Array.isArray(s.feeds) ? { feeds: s.feeds as string[] } : {}),
      ...(typeof s.feedUrl === 'string' ? { feedUrl: s.feedUrl } : {}),
      ...(typeof s.url === 'string' ? { feeds: [s.url as string] } : {}),
    });
  };
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string') {
        push((item as { id: string }).id, item);
      }
    }
  } else if (raw && typeof raw === 'object') {
    for (const [id, v] of Object.entries(raw as Record<string, unknown>)) push(id, v);
  }
  const order = (id: string) => {
    const i = (KNOWN_SOURCES as readonly string[]).indexOf(id);
    return i === -1 ? KNOWN_SOURCES.length : i;
  };
  return entries.sort((a, b) => order(a.id) - order(b.id));
}

function SectionHead({
  title,
  collapsed,
  onToggle,
  testId,
}: {
  title: string;
  collapsed: boolean;
  onToggle: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      className="store-section-head"
      aria-expanded={!collapsed}
      onClick={onToggle}
      data-testid={testId}
      style={{ marginBottom: 10 }}
    >
      <CollapseChevron collapsed={collapsed} />
      <strong>{title}</strong>
    </button>
  );
}

export function MemoryExplorerPanel() {
  const [bots, setBots] = useState<BotConfig[]>([]);
  const [botId, setBotId] = useState('');
  const [atoms, setAtoms] = useState<MemoryAtomRecord[]>([]);
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [query, setQuery] = useState('');
  const [appliedQ, setAppliedQ] = useState('');
  const [category, setCategory] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [confirmForget, setConfirmForget] = useState<string | null>(null);

  const atomsCol = useCollapsed('memory-explorer-atoms', false);
  const askCol = useCollapsed('memory-explorer-ask', false);
  const ingestCol = useCollapsed('memory-explorer-ingestion', false);
  const proposalsCol = useCollapsed('memory-explorer-proposals', false);
  const dreamsCol = useCollapsed('memory-explorer-dreams', false);

  useEffect(() => {
    let live = true;
    getBots()
      .then((list) => {
        if (!live) return;
        setBots(list);
        if (list.length > 0) setBotId((cur) => cur || list[0]!.id);
      })
      .catch((err) => {
        if (live) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!botId) return;
    setLoading(true);
    setError('');
    try {
      const res = await getMemoryAtoms(botId, {
        ...(appliedQ ? { q: appliedQ } : {}),
        ...(category ? { category } : {}),
        limit: 200,
      });
      setAtoms(filterAtomsClient(res.atoms ?? [], appliedQ, category));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
    // Stats are additive chrome: an older server without the route must
    // not error the whole explorer, so failures here stay silent.
    try {
      setStats(await getMemoryStats(botId));
    } catch {
      setStats(null);
    }
  }, [botId, appliedQ, category]);

  useEffect(() => {
    setConfirmForget(null);
    void refresh();
  }, [refresh]);

  const forget = useCallback(
    async (id: string) => {
      setError('');
      try {
        await deleteMemoryAtom(botId, id);
        setAtoms((prev) => prev.filter((a) => a.id !== id));
        setConfirmForget(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [botId],
  );

  return (
    <div className="memory-explorer">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <label htmlFor="memory-explorer-bot" style={{ fontWeight: 600 }}>
          Bot
        </label>
        <select
          id="memory-explorer-bot"
          aria-label="Bot"
          value={botId}
          onChange={(e) => setBotId(e.target.value)}
        >
          {bots.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        {stats ? (
          <span className="muted" role="status">
            {stats.total} {stats.total === 1 ? 'memory' : 'memories'}
            {typeof stats.pinned === 'number' ? ` · ${stats.pinned} pinned` : ''}
          </span>
        ) : null}
      </div>

      {error ? (
        <p role="alert" style={{ color: 'var(--danger, #c00)' }}>
          {error}
        </p>
      ) : null}

      {/* ---- Atoms ---------------------------------------------------- */}
      <section className="card" aria-label="Memories" style={{ marginBottom: 12 }}>
        <SectionHead title="Memories" collapsed={atomsCol.collapsed} onToggle={atomsCol.toggle} />
        <div className={`kd-collapsible${atomsCol.collapsed ? ' closed' : ''}`}>
          <div className="kd-collapsible-inner">
            <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
              <input
                type="search"
                placeholder="Search memories…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') setAppliedQ(query.trim());
                }}
                style={{ flex: 1, minWidth: 180 }}
                aria-label="Search memories"
              />
              <button type="button" onClick={() => setAppliedQ(query.trim())} disabled={loading}>
                Search
              </button>
              {(query || appliedQ) && (
                <button
                  type="button"
                  onClick={() => {
                    setQuery('');
                    setAppliedQ('');
                  }}
                  disabled={loading}
                >
                  Clear
                </button>
              )}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }} role="group" aria-label="Category filter">
              <button
                type="button"
                className={`chip-btn${category === '' ? ' active' : ''}`}
                aria-pressed={category === ''}
                onClick={() => setCategory('')}
              >
                All
              </button>
              {MEMORY_CATEGORIES.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`chip-btn${category === c ? ' active' : ''}`}
                  aria-pressed={category === c}
                  onClick={() => setCategory(category === c ? '' : c)}
                >
                  {c}
                  {stats?.byCategory?.[c] ? ` (${stats.byCategory[c]})` : ''}
                </button>
              ))}
            </div>

            {loading && atoms.length === 0 ? (
              <p className="muted">Loading memories…</p>
            ) : atoms.length === 0 ? (
              <p className="muted">
                No memories yet for this bot. Memories are distilled automatically after
                conversations — or run an ingestion pass below.
              </p>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
                {atoms.map((atom) => (
                  <li
                    key={atom.id}
                    style={{
                      border: '1px solid var(--border, #ddd)',
                      borderRadius: 8,
                      padding: '10px 12px',
                      opacity: atom.active === false ? 0.55 : 1,
                    }}
                  >
                    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: atom.pinned ? 600 : 400, whiteSpace: 'pre-wrap' }}>
                          {atom.pinned ? `📌 ${atom.fact}` : atom.fact}
                        </div>
                        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                          {atom.category}
                          {atom.provenance?.quoteSource || atom.sourceTurn
                            ? ` · ${atom.provenance?.quoteSource ?? atom.sourceTurn}`
                            : ''}
                          {` · ${new Date(atom.createdAt).toLocaleDateString()}`}
                          {atom.archived ? ' · archived' : ''}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                        {confirmForget === atom.id ? (
                          <>
                            <button
                              type="button"
                              onClick={() => void forget(atom.id)}
                              style={{ color: 'var(--danger, #c00)' }}
                              aria-label={`Confirm forget: ${atom.fact}`}
                            >
                              Confirm
                            </button>
                            <button type="button" onClick={() => setConfirmForget(null)}>
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            title="Forget this memory"
                            aria-label={`Forget memory: ${atom.fact}`}
                            onClick={() => setConfirmForget(atom.id)}
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>

      {/* ---- Ask memory ------------------------------------------------ */}
      <section className="card" aria-label="Ask memory" style={{ marginBottom: 12 }}>
        <SectionHead title="Ask memory" collapsed={askCol.collapsed} onToggle={askCol.toggle} />
        <div className={`kd-collapsible${askCol.collapsed ? ' closed' : ''}`}>
          <div className="kd-collapsible-inner">
            <AskMemory botId={botId} />
          </div>
        </div>
      </section>

      {/* ---- Rule proposals (A10) -------------------------------------- */}
      <section className="card" aria-label="Rule proposals" style={{ marginBottom: 12 }}>
        <SectionHead
          title="Rule proposals"
          collapsed={proposalsCol.collapsed}
          onToggle={proposalsCol.toggle}
          testId="memory-proposals-head"
        />
        <div className={`kd-collapsible${proposalsCol.collapsed ? ' closed' : ''}`}>
          <div className="kd-collapsible-inner">
            {botId ? <MemoryProposalsSection key={botId} botId={botId} /> : <p className="muted">Pick a bot first.</p>}
          </div>
        </div>
      </section>

      {/* ---- Dreams (A11): overnight improvement leads, propose-only --- */}
      <section className="card" aria-label="Dreams" style={{ marginBottom: 12 }}>
        <SectionHead
          title="Dreams — improvement leads"
          collapsed={dreamsCol.collapsed}
          onToggle={dreamsCol.toggle}
          testId="memory-dreams-head"
        />
        <div className={`kd-collapsible${dreamsCol.collapsed ? ' closed' : ''}`}>
          <div className="kd-collapsible-inner">
            {botId ? <MemoryDreamsSection key={`dreams-${botId}`} botId={botId} /> : <p className="muted">Pick a bot first.</p>}
          </div>
        </div>
      </section>

      {/* ---- Ingestion ------------------------------------------------- */}
      <section className="card" aria-label="Ingestion">
        <SectionHead title="Ingestion" collapsed={ingestCol.collapsed} onToggle={ingestCol.toggle} />
        <div className={`kd-collapsible${ingestCol.collapsed ? ' closed' : ''}`}>
          <div className="kd-collapsible-inner">
            {botId ? <IngestionSection key={botId} botId={botId} /> : <p className="muted">Pick a bot first.</p>}
          </div>
        </div>
      </section>
    </div>
  );
}

function AskMemory({ botId }: { botId: string }) {
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [result, setResult] = useState<MemoryAskResult | null>(null);
  const [error, setError] = useState('');

  const ask = useCallback(async () => {
    const q = question.trim();
    if (!q || !botId) return;
    setAsking(true);
    setError('');
    try {
      setResult(await askMemory(botId, q));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAsking(false);
    }
  }, [botId, question]);

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <input
          type="text"
          placeholder="Ask what this bot remembers…"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void ask();
          }}
          style={{ flex: 1 }}
          aria-label="Ask memory a question"
        />
        <button type="button" onClick={() => void ask()} disabled={asking || !question.trim() || !botId}>
          {asking ? 'Asking…' : 'Ask'}
        </button>
      </div>
      {error ? (
        <p role="alert" style={{ color: 'var(--danger, #c00)' }}>
          {error}
        </p>
      ) : null}
      {result ? (
        <div>
          <p className="muted" style={{ fontSize: 12, marginBottom: 6 }} role="status">
            {result.mode === 'extractive'
              ? 'Showing matching memories — extractive match, not an AI-generated answer.'
              : 'Answer composed from this bot’s memories.'}
          </p>
          <div style={{ whiteSpace: 'pre-wrap', marginBottom: 8 }}>{result.answer}</div>
          {result.citations.length > 0 ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }} aria-label="Citations">
              {result.citations.map((c) => (
                <span key={c.atomId} className="chip-btn citation-chip" title={c.fact}>
                  📄 {c.fact.length > 60 ? `${c.fact.slice(0, 59)}…` : c.fact}
                  {c.category ? ` · ${c.category}` : ''}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function IngestionSection({ botId }: { botId: string }) {
  const [sources, setSources] = useState<MemoryIngestionSource[]>([]);
  const [rssDraft, setRssDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let live = true;
    setLoading(true);
    getMemoryIngestion(botId)
      .then((cfg) => {
        if (!live) return;
        const list = normalizeIngestionSources(
          (cfg as unknown as { sources?: unknown }).sources ?? cfg,
        );
        setSources(list);
        // RSS feeds live in settings.rssFeeds on the real API; the
        // per-source feeds/feedUrl shapes stay as fallbacks.
        const rss = list.find((s) => s.id === 'rss');
        const fromSettings = cfg.settings?.rssFeeds;
        setRssDraft(
          Array.isArray(fromSettings) && fromSettings.length > 0
            ? fromSettings.join('\n')
            : rss
              ? rssFeedsOf(rss).join('\n')
              : '',
        );
        setError('');
      })
      .catch((err) => {
        if (live) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [botId]);

  const toggleSource = (id: string, enabled: boolean) => {
    setSources((prev) => prev.map((s) => (s.id === id ? { ...s, enabled } : s)));
  };

  const save = useCallback(async () => {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      // PUT body is the settings shape: { sources: { id: enabled },
      // rssFeeds } — NOT the status array the GET returns.
      const feeds = rssDraft.split('\n').map((f) => f.trim()).filter(Boolean);
      const toggles: Partial<Record<string, boolean>> = {};
      for (const s of sources) toggles[s.id] = s.enabled;
      const cfg = await saveMemoryIngestion(botId, { sources: toggles, rssFeeds: feeds });
      const list = normalizeIngestionSources(
        (cfg as unknown as { sources?: unknown }).sources ?? cfg,
      );
      if (list.length > 0) setSources(list);
      setNotice('Ingestion settings saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [botId, sources, rssDraft]);

  const runNow = useCallback(async () => {
    setRunning(true);
    setError('');
    setNotice('');
    try {
      const r = await runMemoryIngestion(botId);
      setNotice(
        r.blocked
          ? `Ingestion run blocked — ${r.blocked}.`
          : `Ingestion run complete — added ${r.added ?? 0}, skipped ${r.skipped ?? 0}.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }, [botId]);

  if (loading) return <p className="muted">Loading ingestion settings…</p>;
  if (sources.length === 0 && !error) {
    return <p className="muted">No ingestion sources are configured on this instance.</p>;
  }

  return (
    <div>
      <p className="muted" style={{ marginBottom: 10 }}>
        Connected sources KriyaDot may read into this bot’s memory automatically. Unavailable
        sources need their account connected first.
      </p>
      {error ? (
        <p role="alert" style={{ color: 'var(--danger, #c00)' }}>
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" style={{ color: 'var(--success, #2a7)' }}>
          {notice}
        </p>
      ) : null}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
        {sources.map((s) => (
          <li
            key={s.id}
            style={{ border: '1px solid var(--border, #ddd)', borderRadius: 8, padding: '10px 12px' }}
          >
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={s.enabled}
                disabled={!s.available || saving}
                onChange={(e) => toggleSource(s.id, e.target.checked)}
                aria-label={`Ingest from ${SOURCE_LABELS[s.id] ?? s.id}`}
              />
              <strong>{SOURCE_LABELS[s.id] ?? s.id}</strong>
              {!s.available ? (
                <span className="muted" style={{ fontSize: 12 }}>
                  Unavailable{s.unavailableReason ? ` — ${s.unavailableReason}` : ''}
                </span>
              ) : null}
            </label>
            {s.id === 'rss' ? (
              <div style={{ marginTop: 8 }}>
                <label className="muted" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
                  Feed URLs (one per line)
                </label>
                <textarea
                  rows={3}
                  style={{ width: '100%' }}
                  value={rssDraft}
                  onChange={(e) => setRssDraft(e.target.value)}
                  placeholder="https://example.com/feed.xml"
                  aria-label="RSS feed URLs"
                  disabled={!s.available || saving}
                />
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button type="button" onClick={() => void save()} disabled={saving || running}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={() => void runNow()} disabled={saving || running}>
          {running ? 'Running…' : 'Run now'}
        </button>
      </div>
    </div>
  );
}
