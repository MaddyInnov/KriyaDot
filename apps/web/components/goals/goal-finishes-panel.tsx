// SPDX-License-Identifier: Apache-2.0
'use client';

/**
 * Goal finishes panel (Muse parity audit §4.4: G-2/G-3/G-5/G-6/G-7/G-8/G-10).
 *
 * Rendered into the Goals view (modules/goals page). Talks to the
 * memory-goals finishes router (mounted at /api/memory-goals — see the
 * Wave-5 wiring note) for: goal title/description editing, progress-entry
 * edit/delete, one-level subgoals, the per-goal workspace (files +
 * scheduled jobs), per-goal briefing letters, confirm-gated deletion
 * (type the goal title), and the unified tracked-items list.
 * Progress history itself is read from the base modules API.
 */

import { useCallback, useEffect, useState } from 'react';
import { authedFetch } from '../../lib/api';

const BASE = '/api/memory-goals';
const MODULES = '/api/modules';

interface Goal {
  id: string;
  title: string;
  description: string;
  status: string;
  progress: number;
}
interface GoalTreeNode extends Goal {
  subgoals: Goal[];
}
interface HistoryEntry {
  id: string;
  goalId: string;
  pct: number;
  note: string;
  createdAt: number;
}
interface FileBinding { id: string; path: string; label: string }
interface JobBinding { id: string; jobId: string; kind: string; label: string; cron: string | null; enabled: boolean }
interface Briefing { id: string; title: string; letterMd: string; kind: string; createdAt: number }
interface TrackedItem {
  id: string; kind: string; title: string; status: string;
  dueAt: number | null; overdue: boolean; detail: string;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await authedFetch(path, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers || {}) } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status}: ${text || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export default function GoalFinishesPanel() {
  const [tree, setTree] = useState<GoalTreeNode[]>([]);
  const [tracked, setTracked] = useState<TrackedItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [files, setFiles] = useState<FileBinding[]>([]);
  const [jobs, setJobs] = useState<JobBinding[]>([]);
  const [briefings, setBriefings] = useState<Briefing[]>([]);
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [subgoalTitle, setSubgoalTitle] = useState('');
  const [filePath, setFilePath] = useState('');
  const [jobId, setJobId] = useState('');
  const [cron, setCron] = useState('0 7 * * *');
  const [confirmTitle, setConfirmTitle] = useState('');
  const [error, setError] = useState<string | null>(null);

  const selected = tree.flatMap((g) => [g, ...g.subgoals]).find((g) => g.id === selectedId) ?? null;

  const loadTree = useCallback(async () => {
    try {
      const res = await api<{ goals: GoalTreeNode[] }>(`${BASE}/goals/tree`);
      setTree(res.goals);
      setSelectedId((prev) => prev ?? res.goals[0]?.id ?? null);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);

  const loadTracked = useCallback(async () => {
    try {
      const res = await api<{ items: TrackedItem[] }>(`${BASE}/tracked-items`);
      setTracked(res.items);
    } catch { /* tracked-items provider may not be wired yet */ }
  }, []);

  const loadDetail = useCallback(async (goalId: string) => {
    try {
      const [h, w, b] = await Promise.all([
        api<HistoryEntry[]>(`${MODULES}/goals/${goalId}/history`).catch(() => [] as HistoryEntry[]),
        api<{ workspace: { files: FileBinding[]; jobs: JobBinding[] } }>(`${BASE}/goals/${goalId}/workspace`),
        api<{ briefings: Briefing[] }>(`${BASE}/goals/${goalId}/briefings`),
      ]);
      setHistory(h);
      setFiles(w.workspace.files);
      setJobs(w.workspace.jobs);
      setBriefings(b.briefings);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);

  useEffect(() => { void loadTree(); void loadTracked(); }, [loadTree, loadTracked]);
  useEffect(() => {
    if (!selectedId) return;
    const g = tree.flatMap((x) => [x, ...x.subgoals]).find((x) => x.id === selectedId);
    if (g) { setEditTitle(g.title); setEditDescription(g.description); }
    void loadDetail(selectedId);
  }, [selectedId, tree, loadDetail]);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try { await fn(); await loadTree(); if (selectedId) await loadDetail(selectedId); await loadTracked(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <div className="card mt">
      <h3>Goal workspace, briefings &amp; tracked items</h3>
      {error && <div className="error">{error}</div>}

      <label className="small muted">Goal (subgoals are indented, one level deep)</label>
      <select className="input" value={selectedId ?? ''} onChange={(e) => setSelectedId(e.target.value)}>
        {tree.map((g) => (
          <optgroup key={g.id} label={`${g.title} — ${g.progress}%`}>
            <option value={g.id}>{g.title} — {g.progress}%</option>
            {g.subgoals.map((s) => (
              <option key={s.id} value={s.id}>↳ {s.title} — {s.progress}%</option>
            ))}
          </optgroup>
        ))}
      </select>

      {selected && (
        <>
          <h4>Edit goal (G-2)</h4>
          <input className="input" value={editTitle} onChange={(e) => setEditTitle(e.target.value)} placeholder="Goal title" />
          <input className="input" value={editDescription} onChange={(e) => setEditDescription(e.target.value)} placeholder="Description" />
          <button className="btn btn-sm" onClick={() => void run(() => api(`${BASE}/goals/${selected.id}`, { method: 'PATCH', body: JSON.stringify({ title: editTitle, description: editDescription }) }))}>
            Save changes
          </button>

          <h4>Progress history (G-3 — fix or delete a wrong entry)</h4>
          {history.map((h) => (
            <div key={h.id} className="row-between mt">
              <span className="small">{h.pct}% — {h.note || '(no note)'}</span>
              <span>
                <button className="btn btn-sm" onClick={() => void run(() => api(`${BASE}/goals/${selected.id}/history/${h.id}`, { method: 'PATCH', body: JSON.stringify({ note: `${h.note} (corrected)` }) }))}>Correct note</button>{' '}
                <button className="btn btn-sm" onClick={() => void run(() => api(`${BASE}/goals/${selected.id}/history/${h.id}`, { method: 'DELETE' }))}>Delete entry</button>
              </span>
            </div>
          ))}

          <h4>Subgoals (G-6)</h4>
          <div className="row-between">
            <input className="input" value={subgoalTitle} onChange={(e) => setSubgoalTitle(e.target.value)} placeholder="Subgoal title" />
            <button className="btn btn-sm" disabled={!subgoalTitle.trim()} onClick={() => void run(async () => { await api(`${BASE}/goals/${selected.id}/subgoals`, { method: 'POST', body: JSON.stringify({ title: subgoalTitle.trim() }) }); setSubgoalTitle(''); })}>
              Add subgoal
            </button>
          </div>

          <h4>Workspace files &amp; jobs (G-7)</h4>
          {files.map((f) => <div key={f.id} className="small">📄 {f.path}{f.label ? ` — ${f.label}` : ''}</div>)}
          {jobs.map((j) => <div key={j.id} className="small">⏰ {j.label || j.jobId}{j.cron ? ` (${j.cron})` : ''}{j.enabled ? '' : ' — paused'}</div>)}
          <div className="row-between mt">
            <input className="input" value={filePath} onChange={(e) => setFilePath(e.target.value)} placeholder="Bind a workspace file path" />
            <button className="btn btn-sm" disabled={!filePath.trim()} onClick={() => void run(async () => { await api(`${BASE}/goals/${selected.id}/files`, { method: 'POST', body: JSON.stringify({ path: filePath.trim() }) }); setFilePath(''); })}>Bind file</button>
          </div>
          <div className="row-between mt">
            <input className="input" value={jobId} onChange={(e) => setJobId(e.target.value)} placeholder="Bind a scheduled job id" />
            <button className="btn btn-sm" disabled={!jobId.trim()} onClick={() => void run(async () => { await api(`${BASE}/goals/${selected.id}/jobs`, { method: 'POST', body: JSON.stringify({ jobId: jobId.trim() }) }); setJobId(''); })}>Bind job</button>
          </div>

          <h4>Briefing letters (G-8)</h4>
          <div className="row-between">
            <input className="input" value={cron} onChange={(e) => setCron(e.target.value)} placeholder="Briefing cron" aria-label="Briefing cron" />
            <button className="btn btn-sm" onClick={() => void run(() => api(`${BASE}/goals/${selected.id}/briefings/schedule`, { method: 'POST', body: JSON.stringify({ cron }) }))}>Set schedule</button>
            <button className="btn btn-sm" onClick={() => void run(() => api(`${BASE}/goals/${selected.id}/briefings`, { method: 'POST', body: JSON.stringify({}) }))}>Generate letter now</button>
          </div>
          {briefings.map((b) => (
            <details key={b.id}>
              <summary className="small">{b.title} ({b.kind})</summary>
              <pre className="small pre-wrap">{b.letterMd}</pre>
            </details>
          ))}

          <h4>Delete goal (G-5 — cascades to subgoals, history, briefings &amp; jobs)</h4>
          <div className="row-between">
            <input className="input" value={confirmTitle} onChange={(e) => setConfirmTitle(e.target.value)} placeholder={`Type the goal title to confirm: ${selected.title}`} />
            <button className="btn btn-sm btn-danger" disabled={confirmTitle !== selected.title} onClick={() => void run(async () => { await api(`${BASE}/goals/${selected.id}`, { method: 'DELETE', body: JSON.stringify({ confirmTitle }) }); setConfirmTitle(''); setSelectedId(null); })}>
              Delete with cascade
            </button>
          </div>
        </>
      )}

      <h4>Tracked items (G-10 — reminders + commitments + tasks)</h4>
      {tracked.length === 0 && <p className="muted small">Nothing tracked yet.</p>}
      {tracked.map((t) => (
        <div key={`${t.kind}-${t.id}`} className="small mt">
          {t.overdue ? '🔴' : '•'} [{t.kind}] {t.title} — {t.status}
          {t.dueAt ? ` — due ${new Date(t.dueAt).toLocaleString()}` : ''}
          {t.detail ? ` — ${t.detail}` : ''}
        </div>
      ))}
    </div>
  );
}
