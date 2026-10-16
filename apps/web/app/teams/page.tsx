'use client';

// AgentTeams — a coordinator bot schedules multiple expert member bots on
// multi-step work. Create a team, run a task, watch each step land live.

import { useCallback, useEffect, useRef, useState } from 'react';
import { authedFetch } from '../../lib/api';
import { normalizeBots } from '../../lib/teams';
import GoalsPanel from '../../components/goals/goals-panel';
import AcpPanel from '../../components/acp/acp-panel';

interface Bot {
  id: string;
  name: string;
  description: string;
}

interface Team {
  id: string;
  name: string;
  coordinatorBotId: string;
  memberBotIds: string[];
  createdAt: number;
}

interface TeamStep {
  memberBotId: string;
  memberName: string;
  task: string;
  done: boolean;
  summary?: string;
}

interface TeamRun {
  id: string;
  teamId: string;
  task: string;
  status: 'running' | 'done' | 'failed';
  steps: TeamStep[];
  result?: string;
  error?: string;
  createdAt: number;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await authedFetch(path, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers || {}) } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status}: ${text || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export default function TeamsPage() {
  const [bots, setBots] = useState<Bot[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [coordinator, setCoordinator] = useState('');
  const [members, setMembers] = useState<string[]>([]);
  const [task, setTask] = useState('');
  const [runs, setRuns] = useState<TeamRun[]>([]);
  const [liveRun, setLiveRun] = useState<TeamRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const esRef = useRef<AbortController | null>(null);
  const importFileRef = useRef<HTMLInputElement>(null);
  // Group goals tab (OpenMausBot parity P1 #11): bounded multi-turn
  // coordinator/worker goal runs. No new top-level nav — lives under Teams.
  // ACP tab (OpenMausBot parity P1 #26): external Agent Client Protocol
  // sessions. Same rule — no new top-level nav.
  const [tab, setTab] = useState<'teams' | 'goals' | 'acp'>('teams');

  const active = teams.find((t) => t.id === activeId) ?? null;
  const botName = (id: string) => bots.find((b) => b.id === id)?.name ?? id;

  const load = useCallback(async () => {
    try {
      const [bRaw, t] = await Promise.all([
        api<Bot[] | { bots: Bot[] }>('/api/bots'),
        api<{ ok: boolean; teams: Team[] }>('/api/teams'),
      ]);
      const b = normalizeBots(bRaw);
      setBots(b);
      setTeams(t.teams);
      setCoordinator((c) => c || b[0]?.id || '');
      setActiveId((prev) => (prev && t.teams.some((x) => x.id === prev) ? prev : t.teams[0]?.id ?? null));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const loadRuns = useCallback(
    async (teamId: string) => {
      try {
        const res = await api<{ ok: boolean; runs: TeamRun[] }>(`/api/teams/${teamId}/runs`);
        setRuns(res.runs);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [],
  );

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (activeId) loadRuns(activeId);
    return () => {
      esRef.current?.abort();
      esRef.current = null;
    };
  }, [activeId, loadRuns]);

  const toggleMember = (id: string) => {
    setMembers((m) => (m.includes(id) ? m.filter((x) => x !== id) : [...m, id]));
  };

  const createTeam = async () => {
    setError(null);
    try {
      const res = await api<{ ok: boolean; team: Team }>('/api/teams', {
        method: 'POST',
        body: JSON.stringify({ name, coordinatorBotId: coordinator, memberBotIds: members }),
      });
      setName('');
      setMembers([]);
      await load();
      setActiveId(res.team.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const deleteTeam = async (id: string) => {
    if (!confirm('Delete this team and its run history?')) return;
    try {
      await api(`/api/teams/${id}`, { method: 'DELETE' });
      setLiveRun(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // Team-sharing manifest (OpenMausBot parity P1 #18): export a portable
  // `kriyadot.team.json` (team + embedded bot configs + coordination rules
  // + checksum) and import one back. Import never overwrites: a name
  // collision asks for confirmation first.
  const exportTeam = async (id: string) => {
    setError(null);
    try {
      const res = await authedFetch('/api/teams/export', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ teamId: id }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`${res.status}: ${text || res.statusText}`);
      }
      const blob = await res.blob();
      const cd = res.headers.get('content-disposition') || '';
      const m = cd.match(/filename="([^"]+)"/);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = m?.[1] ?? `kriyadot.team.${id}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setNotice('Team manifest downloaded — share it, version-control it, or hand-edit it.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const importTeamManifest = async (file: File, confirmCollision = false): Promise<void> => {
    setError(null);
    try {
      const manifest = JSON.parse(await file.text());
      const res = await authedFetch('/api/teams/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ manifest, confirm: confirmCollision }),
      });
      const json = (await res.json()) as {
        ok: boolean;
        error?: string;
        conflict?: { name: string };
        team?: Team;
        importedBots?: string[];
      };
      if (res.status === 409 && json.conflict && !confirmCollision) {
        if (
          confirm(
            `A team named "${json.conflict.name}" already exists. Import anyway as a separate team?`,
          )
        ) {
          await importTeamManifest(file, true);
        }
        return;
      }
      if (!res.ok || !json.team) throw new Error(json.error || `Import failed (${res.status})`);
      setNotice(
        `Imported team "${json.team.name}"` +
          (json.importedBots && json.importedBots.length > 0
            ? ` (+${json.importedBots.length} bot${json.importedBots.length === 1 ? '' : 's'}: ${json.importedBots.join(', ')})`
            : ''),
      );
      await load();
      setActiveId(json.team.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const runTask = async () => {
    if (!active || !task.trim()) return;
    setError(null);
    setLiveRun(null);
    esRef.current?.abort();
    try {
      const res = await api<{ ok: boolean; run: TeamRun }>(`/api/teams/${active.id}/run`, {
        method: 'POST',
        body: JSON.stringify({ task: task.trim() }),
      });
      const run = res.run;
      setLiveRun(run);
      setTask('');
      // Fetch-based SSE: EventSource cannot send the Authorization header,
      // so the stream is read with authedFetch + a manual reader loop.
      const controller = new AbortController();
      esRef.current = controller;
      const handleTeamEvent = (
        evt:
          | { kind: 'step_start'; index: number; step: TeamStep }
          | { kind: 'step_done'; index: number; step: TeamStep }
          | { kind: 'done'; result: string }
          | { kind: 'failed'; error: string },
      ) => {
        setLiveRun((prev) => {
          if (!prev) return prev;
          if (evt.kind === 'step_start') {
            return { ...prev, steps: [...prev.steps, evt.step] };
          }
          if (evt.kind === 'step_done') {
            const steps = prev.steps.map((s, i) => (i === evt.index ? evt.step : s));
            return { ...prev, steps };
          }
          if (evt.kind === 'done') {
            controller.abort();
            loadRuns(active.id);
            return { ...prev, status: 'done', result: evt.result };
          }
          controller.abort();
          loadRuns(active.id);
          return { ...prev, status: 'failed', error: evt.error };
        });
      };
      try {
        const streamRes = await authedFetch(`/api/teams/${active.id}/runs/${run.id}/stream`, {
          signal: controller.signal,
        });
        if (!streamRes.ok || !streamRes.body) throw new Error(`Run stream failed (${streamRes.status})`);
        const reader = streamRes.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const chunks = buf.split('\n\n');
          buf = chunks.pop() ?? '';
          for (const chunk of chunks) {
            for (const line of chunk.split('\n')) {
              if (line.startsWith('data:')) {
                try {
                  handleTeamEvent(JSON.parse(line.slice(5).trim()));
                } catch {
                  // ignore malformed frames
                }
              }
            }
          }
        }
      } catch (e) {
        // Stream ends on done/failed; abnormal drops just stop updates.
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Agent Teams</h1>
          <p className="muted">A coordinator breaks work into steps and assigns each to the best-fit expert bot.</p>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      <div className="tabs">
        <button className={tab === 'teams' ? 'tab active' : 'tab'} onClick={() => setTab('teams')}>
          Teams
        </button>
        <button className={tab === 'goals' ? 'tab active' : 'tab'} onClick={() => setTab('goals')}>
          🎯 Group goals
        </button>
        <button className={tab === 'acp' ? 'tab active' : 'tab'} onClick={() => setTab('acp')}>
          🔌 ACP agents
        </button>
      </div>

      {tab === 'goals' && <GoalsPanel bots={bots} />}

      {tab === 'acp' && <AcpPanel />}

      {tab === 'teams' && (
      <div className="two-col">
        <div className="card">
          <h2>Teams</h2>
          {teams.length === 0 && <p className="muted small">No teams yet — create one below.</p>}
          <ul className="list">
            {teams.map((t) => (
              <li key={t.id} className={t.id === activeId ? 'active' : ''}>
                <button className="linklike" onClick={() => { setLiveRun(null); setActiveId(t.id); }}>
                  <strong>{t.name}</strong>
                </button>
                <div className="muted small">
                  {botName(t.coordinatorBotId)} leads · {t.memberBotIds.map(botName).join(', ')}
                </div>
                <button className="btn btn-sm btn-danger" onClick={() => deleteTeam(t.id)}>Delete</button>
                <button className="btn btn-sm" onClick={() => exportTeam(t.id)}>Export</button>
              </li>
            ))}
          </ul>

          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn btn-sm" onClick={() => importFileRef.current?.click()}>
              Import team manifest…
            </button>
            <input
              ref={importFileRef}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void importTeamManifest(f);
              }}
            />
          </div>
          <p className="muted small">Import a <code>kriyadot.team.json</code> manifest — validated by checksum, never overwrites.</p>

          <h3>New team</h3>
          <input className="input" placeholder="Team name" value={name} onChange={(e) => setName(e.target.value)} />
          <label className="small muted">Coordinator</label>
          <select className="select" value={coordinator} onChange={(e) => setCoordinator(e.target.value)}>
            {bots.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
          <label className="small muted">Members</label>
          <div className="checklist">
            {bots.filter((b) => b.id !== coordinator).map((b) => (
              <label key={b.id} className="check">
                <input type="checkbox" checked={members.includes(b.id)} onChange={() => toggleMember(b.id)} />
                {b.name} <span className="muted small">— {b.description}</span>
              </label>
            ))}
          </div>
          <button className="btn btn-primary" onClick={createTeam} disabled={!coordinator || members.length === 0}>
            Create team
          </button>
        </div>

        <div className="card">
          {!active ? (
            <p className="muted">Select or create a team to run tasks.</p>
          ) : (
            <>
              <h2>{active.name}</h2>
              <p className="muted small">
                Coordinator: <strong>{botName(active.coordinatorBotId)}</strong> · Members:{' '}
                {active.memberBotIds.map(botName).join(', ')}
              </p>
              <textarea
                className="input"
                rows={3}
                placeholder="Describe the multi-step task for the team…"
                value={task}
                onChange={(e) => setTask(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') runTask();
                }}
              />
              <button className="btn btn-primary" onClick={runTask} disabled={!task.trim()}>
                Run task
              </button>

              {liveRun && (
                <div className="run-live">
                  <h3>Live run</h3>
                  <ol className="steps">
                    {liveRun.steps.map((s, i) => (
                      <li key={i} className={s.done ? 'done' : 'active'}>
                        <strong>{s.memberName}</strong>: {s.task.slice(0, 140)}
                        {s.done && s.summary && <div className="muted small">→ {s.summary.slice(0, 200)}</div>}
                        {!s.done && <span className="spinner" aria-label="working" />}
                      </li>
                    ))}
                  </ol>
                  {liveRun.status === 'running' && liveRun.steps.length === 0 && (
                    <p className="muted small">Coordinator is breaking down the task…</p>
                  )}
                  {liveRun.status === 'done' && liveRun.result && (
                    <div className="result"><h4>Final answer</h4><p>{liveRun.result}</p></div>
                  )}
                  {liveRun.status === 'failed' && <div className="error">Run failed: {liveRun.error}</div>}
                </div>
              )}

              <h3>Run history</h3>
              {runs.length === 0 ? (
                <p className="muted small">No runs yet.</p>
              ) : (
                <ul className="list">
                  {runs.map((r) => (
                    <li key={r.id}>
                      <div><strong>{r.task.slice(0, 120)}</strong></div>
                      <div className="muted small">
                        {r.status} · {r.steps.length} step{r.steps.length === 1 ? '' : 's'} ·{' '}
                        {new Date(r.createdAt).toLocaleString()}
                      </div>
                      {r.result && <details><summary>Result</summary><p>{r.result}</p></details>}
                      {r.error && <div className="error small">{r.error}</div>}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </div>
      )}
    </div>
  );
}
