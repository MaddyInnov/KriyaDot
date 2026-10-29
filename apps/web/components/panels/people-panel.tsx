// SPDX-License-Identifier: Apache-2.0
'use client';

// Multiplayer layer (W7) — Teams area of Bots:
// - People directory: CRUD for the humans on the team (name, email,
//   per-gateway messaging handles, avatar color), with the local user
//   auto-seeded as "You" (cannot be deleted).
// - Org view: one column per person with their bots. Drag a bot card
//   onto another person's column — or use the click-to-move select —
//   to reassign its owner (persisted + audited by the API).
// - Per-person Chief: each person can designate one bot as their Chief;
//   their needs-you inbox items then also notify that chief bot.
// TeamInboxPanel (below) is the shared inbox surface: it also renders in
// the approvals view under Activity.

import React, { useCallback, useEffect, useState } from 'react';
import type { BotConfig } from '../../lib/api';
import {
  createPerson,
  deletePerson,
  getTeamInbox,
  groupBotsByPerson,
  listPeople,
  moveBotOwner,
  reassignBotOwner,
  replyToInboxItem,
  setInboxItemState,
  setPersonChief,
  updatePerson,
  type Person,
  type TeamInboxItem,
  type TeamInboxResponse,
} from '../../lib/people';

function handlesToText(person: Person): string {
  return Object.entries(person.channels.handles)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
}

function textToHandles(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^([^:]+):\s*(.+)$/.exec(line.trim());
    if (m) out[m[1]!.trim().toLowerCase()] = m[2]!.trim();
  }
  return out;
}

export default function PeoplePanel({
  bots,
  onRosterChanged,
}: {
  bots: BotConfig[];
  onRosterChanged: () => void;
}) {
  const [people, setPeople] = useState<Person[]>([]);
  const [localBots, setLocalBots] = useState<BotConfig[]>(bots);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  // New-person form
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newHandles, setNewHandles] = useState('');
  // Edit state for one person at a time
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editHandles, setEditHandles] = useState('');
  // Click-to-move fallback: selected bot + target person
  const [moveBotId, setMoveBotId] = useState('');
  const [dragBotId, setDragBotId] = useState<string | null>(null);
  const [dropPersonId, setDropPersonId] = useState<string | null>(null);

  useEffect(() => setLocalBots(bots), [bots]);

  const load = useCallback(async () => {
    try {
      setPeople(await listPeople());
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const withBusy = async (key: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    setError('');
    setNotice('');
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const addPerson = () =>
    withBusy('add', async () => {
      if (!newName.trim()) throw new Error('Name is required.');
      await createPerson({
        name: newName.trim(),
        ...(newEmail.trim() ? { email: newEmail.trim() } : {}),
        channels: { handles: textToHandles(newHandles) },
      });
      setNewName('');
      setNewEmail('');
      setNewHandles('');
      setNotice('Person added.');
    });

  const startEdit = (p: Person) => {
    setEditId(p.id);
    setEditName(p.name);
    setEditEmail(p.email ?? '');
    setEditHandles(handlesToText(p));
  };

  const saveEdit = (p: Person) =>
    withBusy(`edit-${p.id}`, async () => {
      await updatePerson(p.id, {
        name: editName.trim() || p.name,
        email: editEmail.trim() || undefined,
        channels: { handles: textToHandles(editHandles), ...(editEmail.trim() ? { email: editEmail.trim() } : {}) },
      });
      setEditId(null);
      setNotice(`Saved ${editName.trim() || p.name}.`);
    });

  const removePerson = (p: Person) =>
    withBusy(`del-${p.id}`, async () => {
      await deletePerson(p.id);
      setNotice(`Removed ${p.name}. Their bots now belong to You.`);
      onRosterChanged();
    });

  const changeChief = (p: Person, botId: string) =>
    withBusy(`chief-${p.id}`, async () => {
      await setPersonChief(p.id, botId || null);
      setNotice(botId ? `${p.name}'s chief set.` : `${p.name}'s chief cleared.`);
    });

  const reassign = async (botId: string, personId: string) => {
    const botName = localBots.find((b) => b.id === botId)?.name ?? botId;
    const personName = people.find((p) => p.id === personId)?.name ?? personId;
    // Optimistic state transition (same helper the tests exercise).
    setLocalBots((prev) => moveBotOwner(prev, botId, personId));
    try {
      await reassignBotOwner(botId, personId);
      setNotice(`${botName} now belongs to ${personName}.`);
      onRosterChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLocalBots(bots); // roll back to the server roster
    }
  };

  const columns = groupBotsByPerson(people, localBots);

  return (
    <div style={{ marginTop: 16 }}>
      {error && <div className="error-box">{error}</div>}
      {notice && <div className="small muted" role="status">{notice}</div>}

      {/* ---- People directory ---- */}
      <div className="card">
        <div className="row-between">
          <strong>👥 People</strong>
          <span className="small muted">the humans your bots work for</span>
        </div>
        <p className="small muted">
          Every bot belongs to a person. A bot&apos;s approvals, questions and results are
          addressed to its owner and land in that person&apos;s team inbox.
        </p>
        {people.map((p) => (
          <div key={p.id} className="card" style={{ marginTop: 8 }}>
            <div className="row-between">
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {p.pictureUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={p.pictureUrl} alt="" width={28} height={28} style={{ borderRadius: '50%' }} />
                ) : (
                  <span
                    aria-hidden="true"
                    style={{
                      width: 28, height: 28, borderRadius: '50%', display: 'inline-flex',
                      alignItems: 'center', justifyContent: 'center', color: '#fff',
                      background: p.avatarColor, fontWeight: 700,
                    }}
                  >
                    {p.name.slice(0, 1).toUpperCase()}
                  </span>
                )}
                <strong>{p.name}</strong>
                {p.isDefaultUser && <span className="chip small">you</span>}
                {p.chiefBotId && <span className="chip small">👑 chief: {p.chiefBotId}</span>}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button type="button" className="btn btn-sm" disabled={busy !== ''} onClick={() => startEdit(p)}>
                  Edit
                </button>
                {!p.isDefaultUser && (
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    disabled={busy !== ''}
                    onClick={() => void removePerson(p)}
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
            <div className="small muted">
              {p.email ? <span>{p.email} · </span> : null}
              {Object.entries(p.channels.handles).map(([gw, h]) => (
                <span key={gw}>{gw}: {h} · </span>
              ))}
              <span>id <span className="mono">{p.id}</span></span>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
              <label className="small muted" htmlFor={`chief-${p.id}`}>Chief bot</label>
              <select
                id={`chief-${p.id}`}
                className="input"
                value={p.chiefBotId ?? ''}
                disabled={busy !== ''}
                onChange={(e) => void changeChief(p, e.target.value)}
              >
                <option value="">None</option>
                {localBots.map((b) => (
                  <option key={b.id} value={b.id}>{b.name} ({b.id})</option>
                ))}
              </select>
              {p.isDefaultUser && (
                <span className="small muted">the default user keeps the global Chief of Staff behaviour</span>
              )}
            </div>
            {editId === p.id && (
              <div style={{ marginTop: 8 }}>
                <div className="field">
                  <label className="label">Name</label>
                  <input className="input" value={editName} onChange={(e) => setEditName(e.target.value)} />
                </div>
                <div className="field">
                  <label className="label">Email</label>
                  <input className="input" value={editEmail} onChange={(e) => setEditEmail(e.target.value)} placeholder="name@example.com" />
                </div>
                <div className="field">
                  <label className="label">Messaging handles (one per line: gateway: handle)</label>
                  <textarea className="input" rows={3} value={editHandles} onChange={(e) => setEditHandles(e.target.value)} placeholder={'telegram: 123456\nslack: U0123'} />
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button type="button" className="btn btn-sm btn-primary" disabled={busy !== ''} onClick={() => void saveEdit(p)}>
                    Save
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => setEditId(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}

        <div className="card" style={{ marginTop: 8 }}>
          <strong className="small">Add a person</strong>
          <div className="field">
            <label className="label">Name</label>
            <input className="input" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Ana Rao" />
          </div>
          <div className="field">
            <label className="label">Email (optional)</label>
            <input className="input" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="ana@example.com" />
          </div>
          <div className="field">
            <label className="label">Messaging handles (optional, one per line: gateway: handle)</label>
            <textarea className="input" rows={2} value={newHandles} onChange={(e) => setNewHandles(e.target.value)} placeholder={'telegram: 123456'} />
          </div>
          <button type="button" className="btn btn-sm btn-primary" disabled={busy !== '' || !newName.trim()} onClick={() => void addPerson()}>
            Add person
          </button>
        </div>
      </div>

      {/* ---- Org view ---- */}
      <div className="card" style={{ marginTop: 12 }}>
        <div className="row-between">
          <strong>🗂️ Team map — who owns what</strong>
          <span className="small muted">drag a bot onto a person, or use the move controls</span>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0', flexWrap: 'wrap' }}>
          <select className="input" value={moveBotId} onChange={(e) => setMoveBotId(e.target.value)} aria-label="Bot to move">
            <option value="">Choose a bot to move…</option>
            {localBots.map((b) => (
              <option key={b.id} value={b.id}>{b.name} ({b.id})</option>
            ))}
          </select>
          <span className="small muted">→ move to:</span>
          {people.map((p) => (
            <button
              key={p.id}
              type="button"
              className="btn btn-sm"
              disabled={!moveBotId || busy !== ''}
              onClick={() => moveBotId && void reassign(moveBotId, p.id)}
            >
              {p.name}
            </button>
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
          {columns.map((col) => (
            <div
              key={col.person.id}
              data-testid={`org-column-${col.person.id}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDropPersonId(col.person.id);
              }}
              onDragLeave={() => setDropPersonId((cur) => (cur === col.person.id ? null : cur))}
              onDrop={(e) => {
                e.preventDefault();
                const botId = e.dataTransfer.getData('text/plain') || dragBotId;
                setDropPersonId(null);
                setDragBotId(null);
                if (botId) void reassign(botId, col.person.id);
              }}
              style={{
                border: dropPersonId === col.person.id ? '2px solid var(--accent, #7c6cf0)' : '1px solid var(--border, #ddd)',
                borderRadius: 8, padding: 8, minHeight: 90,
              }}
            >
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span
                  aria-hidden="true"
                  style={{
                    width: 20, height: 20, borderRadius: '50%', display: 'inline-flex',
                    alignItems: 'center', justifyContent: 'center', color: '#fff',
                    background: col.person.avatarColor, fontSize: 11, fontWeight: 700,
                  }}
                >
                  {col.person.name.slice(0, 1).toUpperCase()}
                </span>
                <strong className="small">{col.person.name}</strong>
                <span className="small muted">({col.bots.length})</span>
              </div>
              {col.bots.length === 0 && <p className="small muted">No bots yet — drop one here.</p>}
              {col.bots.map((b) => (
                <div
                  key={b.id}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData('text/plain', b.id);
                    setDragBotId(b.id);
                  }}
                  onDragEnd={() => setDragBotId(null)}
                  className="card"
                  style={{ marginTop: 6, padding: '6px 8px', cursor: 'grab' }}
                  title={`Drag to reassign ${b.name}`}
                >
                  🤖 {b.name} <span className="small muted mono">{b.id}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* ---- Team inbox for the selected people ---- */}
      <TeamInboxPanel people={people} />
    </div>
  );
}

const KIND_ICON: Record<TeamInboxItem['kind'], string> = {
  approval: '✅',
  question: '❓',
  relay: '📨',
  mention: '💬',
  fyi: 'ℹ️',
  'run-result': '🏁',
};

export function TeamInboxPanel({ people: peopleProp }: { people?: Person[] }) {
  const [people, setPeople] = useState<Person[]>(peopleProp ?? []);
  const [personId, setPersonId] = useState('you');
  const [inbox, setInbox] = useState<TeamInboxResponse | null>(null);
  const [error, setError] = useState('');
  const [replyText, setReplyText] = useState<Record<string, string>>({});
  const [acting, setActing] = useState('');

  useEffect(() => {
    if (peopleProp) setPeople(peopleProp);
  }, [peopleProp]);

  useEffect(() => {
    if (peopleProp) return;
    void listPeople().then(setPeople).catch(() => {});
  }, [peopleProp]);

  const load = useCallback(async () => {
    try {
      setInbox(await getTeamInbox(personId));
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [personId]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);

  const reply = async (item: TeamInboxItem) => {
    const text = (replyText[item.id] ?? '').trim();
    if (!text) return;
    setActing(item.id);
    try {
      await replyToInboxItem(item.id, text);
      setReplyText((prev) => ({ ...prev, [item.id]: '' }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActing('');
    }
  };

  const markDone = async (item: TeamInboxItem) => {
    setActing(item.id);
    try {
      await setInboxItemState(item.id, 'done');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActing('');
    }
  };

  const renderItem = (item: TeamInboxItem) => (
    <div key={item.id} className="card" style={{ marginTop: 6 }}>
      <div className="row-between">
        <div>
          <span className="chip small">{KIND_ICON[item.kind]} {item.kind}</span>{' '}
          <strong className="small">{item.title}</strong>
        </div>
        <span className="small muted">{new Date(item.createdAt).toLocaleString()}</span>
      </div>
      <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{item.summary}</div>
      {item.replyText && (
        <div className="small muted mt">↩ Reply: {item.replyText}</div>
      )}
      {item.state === 'needs-you' && item.kind === 'relay' && (
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          <input
            className="input"
            placeholder="Reply — it returns to the bot's chat as external content"
            value={replyText[item.id] ?? ''}
            onChange={(e) => setReplyText((prev) => ({ ...prev, [item.id]: e.target.value }))}
            style={{ flex: 1 }}
          />
          <button type="button" className="btn btn-sm btn-primary" disabled={acting === item.id} onClick={() => void reply(item)}>
            Reply
          </button>
        </div>
      )}
      {item.state === 'needs-you' && !item.id.includes(':') && item.kind !== 'relay' && (
        <div className="approval-actions">
          <button type="button" className="btn btn-sm" disabled={acting === item.id} onClick={() => void markDone(item)}>
            Mark done
          </button>
        </div>
      )}
      {item.state === 'needs-you' && item.kind === 'approval' && (
        <div className="small muted">Decide this in the approvals list above — it is the same card.</div>
      )}
    </div>
  );

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="row-between">
        <strong>📥 Team inbox</strong>
        <select
          className="input"
          value={personId}
          onChange={(e) => setPersonId(e.target.value)}
          aria-label="Inbox person filter"
        >
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}{p.isDefaultUser ? ' (you)' : ''}
            </option>
          ))}
        </select>
      </div>
      {error && <div className="error-box">{error}</div>}
      {!inbox && <p className="muted">Loading…</p>}
      {inbox && (
        <>
          <h4 className="mt">Needs you ({inbox.counts.needsYou})</h4>
          {inbox.needsYou.length === 0 && <p className="muted">Nothing waiting.</p>}
          {inbox.needsYou.map(renderItem)}
          <h4 className="mt">FYI ({inbox.counts.fyi})</h4>
          {inbox.fyi.length === 0 && <p className="muted">No FYIs.</p>}
          {inbox.fyi.map(renderItem)}
          <h4 className="mt">Done ({inbox.counts.done})</h4>
          {inbox.done.slice(0, 10).map(renderItem)}
        </>
      )}
    </div>
  );
}
