// SPDX-License-Identifier: Apache-2.0
'use client';

import { useCallback, useState } from 'react';
import { MODULES_BASE, api, fmtTs, PageHeader, ErrorBox, EmptyState, useModuleData } from '../lib';
import GoalFinishesPanel from '../../../components/goals/goal-finishes-panel';

interface Goal {
  id: string;
  title: string;
  description: string;
  status: 'active' | 'completed';
  progress: number;
  createdAt: number;
  updatedAt: number;
}

interface GoalProgressEntry {
  id: string;
  goalId: string;
  pct: number;
  note: string;
  createdAt: number;
}

export default function GoalsPage() {
  const [filter, setFilter] = useState<'active' | 'completed' | ''>('');
  const loadGoals = useCallback(
    () => api(`${MODULES_BASE}/goals${filter ? `?status=${filter}` : ''}`) as Promise<Goal[]>,
    [filter],
  );
  const { data: goals, error, refresh } = useModuleData(loadGoals);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Goal | null>(null);
  const [history, setHistory] = useState<GoalProgressEntry[]>([]);
  const [pct, setPct] = useState(50);
  const [note, setNote] = useState('');

  const create = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      await api(`${MODULES_BASE}/goals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), description: description.trim() }),
      });
      setTitle('');
      setDescription('');
      refresh();
    } finally {
      setBusy(false);
    }
  };

  const openGoal = async (g: Goal) => {
    setSelected(g);
    try {
      const h = (await api(`${MODULES_BASE}/goals/${g.id}/history`)) as GoalProgressEntry[];
      setHistory(h);
    } catch {
      setHistory([]);
    }
  };

  const updateProgress = async () => {
    if (!selected) return;
    await api(`${MODULES_BASE}/goals/${selected.id}/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pct, note }),
    });
    setNote('');
    const g = (await api(`${MODULES_BASE}/goals/${selected.id}`)) as Goal;
    setSelected(g);
    refresh();
    void openGoal(g);
  };

  const complete = async (id: string) => {
    await api(`${MODULES_BASE}/goals/${id}/complete`, { method: 'POST' });
    setSelected(null);
    refresh();
  };

  return (
    <div>
      <PageHeader title="Goals" sub="Track what matters. Log progress, complete when done." onRefresh={refresh} />
      <ErrorBox error={error} />

      <div className="card">
        <strong>New goal</strong>
        <div className="grid-2 mt">
          <input
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Goal title"
          />
          <input
            className="input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description (optional)"
          />
        </div>
        <div className="mt">
          <button className="btn btn-sm" disabled={busy || !title.trim()} onClick={() => void create()}>
            Create goal
          </button>
        </div>
      </div>

      <div className="row-between mt">
        <div className="tabs" role="tablist">
          {(['', 'active', 'completed'] as const).map((s) => (
            <button
              key={s}
              role="tab"
              aria-selected={filter === s}
              className={`tab${filter === s ? ' active' : ''}`}
              onClick={() => setFilter(s)}
            >
              {s === '' ? 'All' : s}
            </button>
          ))}
        </div>
        <span className="small muted">{(goals ?? []).length} goals</span>
      </div>

      <div className="grid-2 mt">
        {(goals ?? []).map((g) => (
          <div className="card" key={g.id}>
            <div className="row-between">
              <strong>{g.title}</strong>
              <span className={`chip${g.status === 'completed' ? ' green' : ' gray'}`}>{g.status}</span>
            </div>
            {g.description && <p className="small muted mt">{g.description}</p>}
            <div className="progress mt" aria-label={`${g.progress}%`}>
              <div className="progress-bar" style={{ width: `${g.progress}%` }} />
            </div>
            <p className="small muted mt">{g.progress}% · updated {fmtTs(g.updatedAt)}</p>
            <div className="row-between mt">
              <button className="btn btn-sm" onClick={() => void openGoal(g)}>
                Details
              </button>
              {g.status === 'active' && (
                <button className="btn btn-sm" onClick={() => void complete(g.id)}>
                  Complete
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      {(goals ?? []).length === 0 && <EmptyState text="No goals yet. Create one above." />}

      <GoalFinishesPanel />

      {selected && (
        <div className="card mt">
          <div className="row-between">
            <strong>{selected.title}</strong>
            <button className="btn btn-sm" onClick={() => setSelected(null)}>
              Close
            </button>
          </div>
          <p className="small muted mt">Created {fmtTs(selected.createdAt)}</p>
          <div className="mt">
            <label className="small">
              Progress: {pct}%
              <input
                type="range"
                min={0}
                max={100}
                value={pct}
                onChange={(e) => setPct(Number(e.target.value))}
                className="mt"
              />
            </label>
          </div>
          <input
            className="input mt"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Progress note (optional)"
          />
          <div className="mt">
            <button className="btn btn-sm" onClick={() => void updateProgress()}>
              Log progress
            </button>
          </div>
          {history.length > 0 && (
            <div className="mt">
              <strong className="small">History</strong>
              {history.map((h) => (
                <div key={h.id} className="small muted mt">
                  {fmtTs(h.createdAt)} — {h.pct}%{h.note ? ` — ${h.note}` : ''}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
