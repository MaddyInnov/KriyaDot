// SPDX-License-Identifier: Apache-2.0
'use client';

/**
 * Per-bot durable memory management (Engram + Atomic parity).
 *
 * Lists the bot's distilled memories (atoms) with search, pin/unpin,
 * and forget (delete). Pinned memories surface first in recall and are
 * never auto-pruned. Deleting removes the FTS index row too.
 *
 * Memory fabric (Atomic parity):
 * - New categories: lesson 🎓, procedure 🛠️, reflection 🪞.
 * - Typed links between memories (relates ↔, contradicts ⚠️, supersedes ⏩),
 *   shown as connected chips on each memory.
 * - Conflicts section: contradicting memories with "keep this one" voting.
 *   Resolution keeps the winner active and marks the loser inactive (kept
 *   for the audit trail; excluded from recall).
 * - Reflection: on-demand "Reflect now" button + opt-in auto-reflection
 *   every 50 turns, plus the live model distiller toggle.
 */

import { useCallback, useEffect, useState } from 'react';
import { kriyadotFetch } from '../../lib/kriyadot-api';

export interface MemoryAtom {
  id: string;
  botId: string;
  fact: string;
  entities: string[];
  confidence: number;
  sourceTurn: string;
  createdAt: number;
  tier: string;
  pinned: boolean;
  category: 'fact' | 'preference' | 'summary' | 'decision' | 'lesson' | 'procedure' | 'reflection';
  active: boolean;
}

export interface MemoryLink {
  id: string;
  botId: string;
  fromAtomId: string;
  toAtomId: string;
  kind: 'relates' | 'contradicts' | 'supersedes';
  createdAt: number;
  createdBy: string;
}

export interface MemoryConflict {
  id: string;
  botId: string;
  atomAId: string;
  atomBId: string;
  status: 'open' | 'resolved';
  votes: Array<{ by: string; winnerId: string; ts: number }>;
  winnerId: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

export interface BotMemorySettings {
  memoryReflection: boolean;
  memoryLiveDistill: boolean;
}

const CATEGORY_META: Record<MemoryAtom['category'], { label: string; icon: string }> = {
  fact: { label: 'Fact', icon: '📝' },
  preference: { label: 'Preference', icon: '💜' },
  summary: { label: 'Summary', icon: '📋' },
  decision: { label: 'Decision', icon: '✅' },
  lesson: { label: 'Lesson', icon: '🎓' },
  procedure: { label: 'Procedure', icon: '🛠️' },
  reflection: { label: 'Reflection', icon: '🪞' },
};

const LINK_META: Record<MemoryLink['kind'], { label: string; icon: string }> = {
  relates: { label: 'relates to', icon: '↔️' },
  contradicts: { label: 'contradicts', icon: '⚠️' },
  supersedes: { label: 'supersedes', icon: '⏩' },
};

async function apiJson(path: string, init?: RequestInit) {
  const res = await kriyadotFetch(path, init);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function MemoryPanel({ botId }: { botId: string }) {
  const [atoms, setAtoms] = useState<MemoryAtom[]>([]);
  const [links, setLinks] = useState<MemoryLink[]>([]);
  const [conflicts, setConflicts] = useState<MemoryConflict[]>([]);
  const [settings, setSettings] = useState<BotMemorySettings>({ memoryReflection: false, memoryLiveDistill: false });
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [reflecting, setReflecting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmForget, setConfirmForget] = useState<string | null>(null);
  // Link composer state: which atom is being linked, and the chosen target + kind.
  const [linkingFrom, setLinkingFrom] = useState<string | null>(null);
  const [linkTarget, setLinkTarget] = useState('');
  const [linkKind, setLinkKind] = useState<MemoryLink['kind']>('relates');

  const refresh = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const [atomsData, linksData, conflictsData, settingsData] = await Promise.all([
        apiJson(`/api/memory/atoms?botId=${encodeURIComponent(botId)}`),
        apiJson(`/api/memory/links?botId=${encodeURIComponent(botId)}`),
        apiJson(`/api/memory/conflicts?botId=${encodeURIComponent(botId)}`),
        apiJson(`/api/bots/${encodeURIComponent(botId)}/memory-settings`),
      ]);
      setAtoms(atomsData.atoms ?? []);
      setLinks(linksData.links ?? []);
      setConflicts(conflictsData.conflicts ?? []);
      setSettings({
        memoryReflection: settingsData.settings?.memoryReflection === true,
        memoryLiveDistill: settingsData.settings?.memoryLiveDistill === true,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [botId]);

  useEffect(() => {
    setQuery('');
    setConfirmForget(null);
    setLinkingFrom(null);
    setNotice('');
    void refresh();
  }, [botId, refresh]);

  const atomById = useCallback((id: string) => atoms.find((a) => a.id === id), [atoms]);

  const linksForAtom = useCallback(
    (atomId: string) => links.filter((l) => l.fromAtomId === atomId || l.toAtomId === atomId),
    [links],
  );

  const search = useCallback(async () => {
    const q = query.trim();
    if (!q) {
      void refresh();
      return;
    }
    setBusy(true);
    setError('');
    try {
      const data = await apiJson(
        `/api/memory/search?botId=${encodeURIComponent(botId)}&q=${encodeURIComponent(q)}`,
      );
      setAtoms(data.results ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [botId, query, refresh]);

  const togglePin = useCallback(
    async (atom: MemoryAtom) => {
      setError('');
      try {
        const action = atom.pinned ? 'unpin' : 'pin';
        await apiJson(
          `/api/memory/atoms/${encodeURIComponent(atom.id)}/${action}?botId=${encodeURIComponent(botId)}`,
          { method: 'POST' },
        );
        setAtoms((prev) => prev.map((a) => (a.id === atom.id ? { ...a, pinned: !a.pinned } : a)));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [botId],
  );

  const forget = useCallback(
    async (id: string) => {
      setError('');
      try {
        await apiJson(`/api/memory/atoms/${encodeURIComponent(id)}?botId=${encodeURIComponent(botId)}`, {
          method: 'DELETE',
        });
        setAtoms((prev) => prev.filter((a) => a.id !== id));
        setLinks((prev) => prev.filter((l) => l.fromAtomId !== id && l.toAtomId !== id));
        setConfirmForget(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [botId],
  );

  const createLink = useCallback(async () => {
    if (!linkingFrom || !linkTarget) return;
    setError('');
    try {
      const data = await apiJson('/api/memory/links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botId, fromAtomId: linkingFrom, toAtomId: linkTarget, kind: linkKind }),
      });
      setNotice(
        linkKind === 'contradicts'
          ? 'Contradiction flagged — it now appears in Conflicts for voting.'
          : 'Link created.',
      );
      setLinkingFrom(null);
      setLinkTarget('');
      setLinkKind('relates');
      void refresh();
      void data;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [botId, linkingFrom, linkTarget, linkKind, refresh]);

  const deleteLink = useCallback(
    async (linkId: string) => {
      setError('');
      try {
        await apiJson(`/api/memory/links/${encodeURIComponent(linkId)}?botId=${encodeURIComponent(botId)}`, {
          method: 'DELETE',
        });
        setLinks((prev) => prev.filter((l) => l.id !== linkId));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [botId],
  );

  const resolveConflict = useCallback(
    async (conflict: MemoryConflict, winnerId: string) => {
      setError('');
      try {
        await apiJson(`/api/memory/conflicts/${encodeURIComponent(conflict.id)}/resolve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ botId, winnerId }),
        });
        setNotice('Conflict resolved — the losing memory is kept but no longer recalled.');
        void refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [botId, refresh],
  );

  const reflectNow = useCallback(async () => {
    setReflecting(true);
    setError('');
    setNotice('');
    try {
      const data = await apiJson('/api/memory/reflect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botId }),
      });
      if (data.skipped) {
        setNotice(`Reflection skipped: ${data.reason ?? 'not enough to review'}.`);
      } else {
        setNotice(
          `Reflection done: ${data.lessonsCreated ?? 0} lesson(s), ${data.proceduresCreated ?? 0} procedure(s), ${data.conflictsOpened ?? 0} contradiction(s) flagged.`,
        );
      }
      void refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReflecting(false);
    }
  }, [botId, refresh]);

  const saveSettings = useCallback(
    async (next: BotMemorySettings) => {
      setError('');
      try {
        await apiJson(`/api/bots/${encodeURIComponent(botId)}/memory-settings`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(next),
        });
        setSettings(next);
        setNotice('Memory settings saved.');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [botId],
  );

  const linkCandidates = (excludeId: string) => atoms.filter((a) => a.id !== excludeId);

  return (
    <div className="memory-panel">
      <p className="muted" style={{ marginBottom: 12 }}>
        Durable memories this bot has learned about you. Pinned memories always come first when the
        bot recalls context. Forgetting removes a memory permanently.
      </p>

      {/* Conflicts (Atomic parity: voting/consensus) */}
      {conflicts.length > 0 && (
        <section aria-label="Memory conflicts" style={{ marginBottom: 16 }}>
          <h4 style={{ margin: '0 0 8px' }}>⚖️ Conflicts ({conflicts.length})</h4>
          <p className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            These memories contradict each other. Vote for the one that is current — the loser is
            kept for the record but no longer recalled.
          </p>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
            {conflicts.map((c) => {
              const a = atomById(c.atomAId);
              const b = atomById(c.atomBId);
              const votesA = c.votes.filter((v) => v.winnerId === c.atomAId).length;
              const votesB = c.votes.filter((v) => v.winnerId === c.atomBId).length;
              return (
                <li
                  key={c.id}
                  style={{
                    border: '1px solid var(--warning, #e6a23c)',
                    borderRadius: 8,
                    padding: '10px 12px',
                  }}
                >
                  <div style={{ display: 'grid', gap: 8 }}>
                    {[
                      { atom: a, id: c.atomAId, votes: votesA },
                      { atom: b, id: c.atomBId, votes: votesB },
                    ].map(({ atom, id, votes }, i) => (
                      <div key={id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                        <div style={{ flex: 1, fontSize: 13 }}>
                          <strong>{i === 0 ? 'A' : 'B'}</strong> · {atom ? atom.fact : <em>(forgotten memory)</em>}
                          {votes > 0 && <span className="muted"> · {votes} vote(s)</span>}
                        </div>
                        <button
                          type="button"
                          disabled={!atom}
                          onClick={() => void resolveConflict(c, id)}
                          aria-label={`Keep memory ${i === 0 ? 'A' : 'B'}: ${atom?.fact ?? ''}`}
                        >
                          Keep this one
                        </button>
                      </div>
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* Reflection controls */}
      <section
        aria-label="Memory reflection"
        style={{
          border: '1px solid var(--border, #ddd)',
          borderRadius: 8,
          padding: '10px 12px',
          marginBottom: 12,
        }}
      >
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <strong>🪞 Reflection</strong>
          <button type="button" onClick={() => void reflectNow()} disabled={reflecting || busy}>
            {reflecting ? 'Reflecting…' : 'Reflect now'}
          </button>
        </div>
        <div style={{ display: 'grid', gap: 6, marginTop: 8, fontSize: 13 }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={settings.memoryReflection}
              onChange={(e) => void saveSettings({ ...settings, memoryReflection: e.target.checked })}
            />
            Auto-reflect every 50 turns (background; proposes lessons, procedures, flags contradictions)
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={settings.memoryLiveDistill}
              onChange={(e) => void saveSettings({ ...settings, memoryLiveDistill: e.target.checked })}
            />
            Live model distillation (the bot's own model extracts memories — uses tokens; otherwise the free heuristic is used)
          </label>
        </div>
      </section>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <input
          type="search"
          placeholder="Search memories…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void search();
          }}
          style={{ flex: 1 }}
          aria-label="Search memories"
        />
        <button type="button" onClick={() => void search()} disabled={busy}>
          Search
        </button>
        {query && (
          <button
            type="button"
            onClick={() => {
              setQuery('');
              void refresh();
            }}
            disabled={busy}
          >
            Clear
          </button>
        )}
      </div>

      {notice && (
        <p role="status" style={{ color: 'var(--success, #2a7)' }}>
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" style={{ color: 'var(--danger, #c00)' }}>
          {error}
        </p>
      )}

      {busy && atoms.length === 0 ? (
        <p className="muted">Loading memories…</p>
      ) : atoms.length === 0 ? (
        <p className="muted">
          No memories yet. The keeper saves durable facts automatically after conversations — or
          teach the bot with "remember that…".
        </p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
          {atoms.map((atom) => {
            const meta = CATEGORY_META[atom.category] ?? CATEGORY_META.fact;
            const atomLinks = linksForAtom(atom.id);
            return (
              <li
                key={atom.id}
                style={{
                  border: '1px solid var(--border, #ddd)',
                  borderRadius: 8,
                  padding: '10px 12px',
                  opacity: atom.active ? 1 : 0.55,
                }}
              >
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: atom.pinned ? 600 : 400, whiteSpace: 'pre-wrap' }}>{atom.fact}</div>
                    <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                      {meta.icon} {meta.label}
                      {atom.entities.length > 0 && ` · ${atom.entities.join(', ')}`}
                      {` · ${new Date(atom.createdAt).toLocaleDateString()}`}
                      {atom.pinned && ' · 📌 Pinned'}
                      {!atom.active && ' · 🗄️ Superseded'}
                    </div>
                    {atomLinks.length > 0 && (
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
                        {atomLinks.map((l) => {
                          const otherId = l.fromAtomId === atom.id ? l.toAtomId : l.fromAtomId;
                          const other = atomById(otherId);
                          const lm = LINK_META[l.kind];
                          const direction = l.fromAtomId === atom.id ? '→' : '←';
                          return (
                            <span
                              key={l.id}
                              title={other ? other.fact : '(forgotten memory)'}
                              style={{
                                fontSize: 11,
                                border: '1px solid var(--border, #ddd)',
                                borderRadius: 12,
                                padding: '2px 8px',
                                display: 'inline-flex',
                                gap: 4,
                                alignItems: 'center',
                              }}
                            >
                              {lm.icon} {direction} {lm.label} ·{' '}
                              {(other ? other.fact : '(forgotten)').slice(0, 40)}
                              <button
                                type="button"
                                onClick={() => void deleteLink(l.id)}
                                aria-label={`Remove link: ${lm.label}`}
                                style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0 }}
                              >
                                ✕
                              </button>
                            </span>
                          );
                        })}
                      </div>
                    )}
                    {linkingFrom === atom.id ? (
                      <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                        <select
                          value={linkTarget}
                          onChange={(e) => setLinkTarget(e.target.value)}
                          aria-label="Link target memory"
                          style={{ maxWidth: 260 }}
                        >
                          <option value="">Choose memory…</option>
                          {linkCandidates(atom.id).map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.fact.slice(0, 60)}
                            </option>
                          ))}
                        </select>
                        <select
                          value={linkKind}
                          onChange={(e) => setLinkKind(e.target.value as MemoryLink['kind'])}
                          aria-label="Link kind"
                        >
                          <option value="relates">relates to</option>
                          <option value="contradicts">contradicts</option>
                          <option value="supersedes">supersedes</option>
                        </select>
                        <button type="button" onClick={() => void createLink()} disabled={!linkTarget}>
                          Add link
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setLinkingFrom(null);
                            setLinkTarget('');
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <div style={{ marginTop: 6 }}>
                        <button
                          type="button"
                          onClick={() => {
                            setLinkingFrom(atom.id);
                            setLinkTarget('');
                            setLinkKind('relates');
                          }}
                          style={{ fontSize: 12 }}
                        >
                          🔗 Link…
                        </button>
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                    <button
                      type="button"
                      title={atom.pinned ? 'Unpin' : 'Pin'}
                      onClick={() => void togglePin(atom)}
                      aria-label={atom.pinned ? `Unpin memory: ${atom.fact}` : `Pin memory: ${atom.fact}`}
                    >
                      {atom.pinned ? '📌' : '📍'}
                    </button>
                    {confirmForget === atom.id ? (
                      <>
                        <button type="button" onClick={() => void forget(atom.id)} style={{ color: 'var(--danger, #c00)' }}>
                          Confirm
                        </button>
                        <button type="button" onClick={() => setConfirmForget(null)}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button type="button" title="Forget this memory" onClick={() => setConfirmForget(atom.id)}>
                        🗑️
                      </button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <MemoryUpkeepSection botId={botId} />
    </div>
  );
}

/** Memory upkeep (OpenMausBot parity): about-me, capture/tidy, undoable journal. */
function MemoryUpkeepSection({ botId }: { botId: string }) {
  const [aboutMe, setAboutMe] = useState('');
  const [aboutMeDraft, setAboutMeDraft] = useState('');
  const [journal, setJournal] = useState<Array<{ id: string; ts: number; action: string; note?: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    try {
      const [me, j] = await Promise.all([
        apiJson(`/api/memory/about-me`),
        apiJson(`/api/memory/upkeep/journal?botId=${encodeURIComponent(botId)}&limit=10`),
      ]);
      setAboutMe(me.text ?? '');
      setAboutMeDraft(me.text ?? '');
      setJournal(j.entries ?? []);
    } catch {
      // upkeep endpoints are optional; the atoms UI still works
    }
  }, [botId]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveAboutMe = async () => {
    setBusy(true);
    try {
      await apiJson('/api/memory/about-me', {
        method: 'PUT',
        body: JSON.stringify({ text: aboutMeDraft }),
      });
      setAboutMe(aboutMeDraft);
      setNotice('About-me saved — the bot reads it into context.');
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const runCapture = async () => {
    setBusy(true);
    try {
      const r = await apiJson('/api/memory/upkeep/capture', {
        method: 'POST',
        body: JSON.stringify({ botId }),
      });
      setNotice(`Capture: scanned ${r.eventsScanned ?? 0} events, stored ${r.atomsStored ?? 0} facts.`);
      await load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const runTidy = async () => {
    setBusy(true);
    try {
      const r = await apiJson('/api/memory/upkeep/tidy', {
        method: 'POST',
        body: JSON.stringify({ botId }),
      });
      setNotice(
        `Tidy: examined ${r.examined ?? 0}, deduped ${r.duplicatesDeactivated ?? 0}, ` +
          `contradictions opened ${r.contradictionsOpened ?? 0}.`,
      );
      await load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const undoLast = async () => {
    setBusy(true);
    try {
      const r = await apiJson('/api/memory/upkeep/journal/undo', {
        method: 'POST',
        body: JSON.stringify({ botId }),
      });
      setNotice(`Undid: ${r.undone?.action ?? 'last change'}.`);
      await load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3>Memory upkeep</h3>
      {notice && <p className="small muted">{notice}</p>}

      <h4>About me</h4>
      <p className="small muted">
        A short profile the bot reads into context on every turn. Edit freely — it is yours.
      </p>
      <textarea
        rows={3}
        style={{ width: '100%' }}
        value={aboutMeDraft}
        onChange={(e) => setAboutMeDraft(e.target.value)}
        placeholder="e.g. Night owl. Building robots. Prefers terse answers."
      />
      <div style={{ marginTop: 6, display: 'flex', gap: 8 }}>
        <button type="button" className="btn btn-sm" disabled={busy || aboutMeDraft === aboutMe} onClick={() => void saveAboutMe()}>
          Save about-me
        </button>
      </div>

      <h4 style={{ marginTop: 12 }}>Background passes</h4>
      <p className="small muted">
        Capture extracts durable facts from recent turns on idle; tidy dedupes atoms and flags
        contradictions. Both also run automatically (idle capture every 15 min, tidy nightly).
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void runCapture()}>
          Run capture now
        </button>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void runTidy()}>
          Run tidy now
        </button>
        <button type="button" className="btn btn-sm" disabled={busy || journal.length === 0} onClick={() => void undoLast()}>
          Undo last memory change
        </button>
      </div>

      {journal.length > 0 && (
        <>
          <h4 style={{ marginTop: 12 }}>Recent changes (undoable)</h4>
          <ul className="list small">
            {journal.map((e) => (
              <li key={e.id}>
                <span className="muted">{new Date(e.ts).toLocaleString()}</span> — {e.action}
                {e.note ? ` — ${e.note}` : ''}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
