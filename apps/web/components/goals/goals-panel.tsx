'use client';

// Group goals (OpenMausBot parity P1 #11): bounded multi-turn
// coordinator/worker goal runs with explicit completion decisions.
// Lives under Teams (no new top-level nav).

import { useCallback, useEffect, useRef, useState } from 'react';
import { authedFetch } from '../../lib/api';

interface Bot {
  id: string;
  name: string;
  description: string;
}

type GoalStatus = 'running' | 'needs-input' | 'blocked' | 'max-turns' | 'completed' | 'stopped' | 'failed';

interface Goal {
  id: string;
  title: string;
  description: string | null;
  coordinatorBotId: string;
  workerBotIds: string[];
  maxTurns: number;
  status: GoalStatus;
  groupId: string | null;
  routineId: string | null;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
}

interface GoalDelegation {
  botId: string;
  botName: string;
  task: string;
  summary?: string;
  done: boolean;
}

interface GoalTurn {
  id: string;
  goalId: string;
  turnNumber: number;
  decision: 'completed' | 'needs-input' | 'blocked' | 'continue';
  coordinatorText: string;
  nextStep: string | null;
  summary: string | null;
  delegations: GoalDelegation[];
  createdAt: string;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await authedFetch(path, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers || {}) } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status}: ${text || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

const DECISION_BADGE: Record<string, string> = {
  completed: '✅ completed',
  'needs-input': '🙋 needs input',
  blocked: '🚧 blocked',
  continue: '⏭ continue',
};

const STATUS_BADGE: Record<GoalStatus, string> = {
  running: '▶️ running',
  'needs-input': '🙋 needs input',
  blocked: '🚧 blocked',
  'max-turns': '⏸ turn limit',
  completed: '✅ completed',
  stopped: '⏹ stopped',
  failed: '❌ failed',
};

export default function GoalsPanel({ bots }: { bots: Bot[] }) {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [turns, setTurns] = useState<GoalTurn[]>([]);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [workers, setWorkers] = useState<string[]>([]);
  const [maxTurns, setMaxTurns] = useState('13');
  const [resumeInput, setResumeInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const streamRef = useRef<AbortController | null>(null);

  const botName = (id: string) => bots.find((b) => b.id === id)?.name ?? id;
  const active = goals.find((g) => g.id === activeId) ?? null;

  const loadGoals = useCallback(async () => {
    try {
      const res = await api<{ ok: boolean; goals: Goal[] }>('/api/group-goals');
      setGoals(res.goals);
      setActiveId((prev) => (prev && res.goals.some((g) => g.id === prev) ? prev : res.goals[0]?.id ?? null));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const loadDetail = useCallback(async (goalId: string) => {
    try {
      const res = await api<{ ok: boolean; goal: Goal; turns: GoalTurn[] }>(`/api/group-goals/${goalId}`);
      setTurns(res.turns);
      setGoals((prev) => prev.map((g) => (g.id === goalId ? res.goal : g)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    loadGoals();
    return () => streamRef.current?.abort();
  }, [loadGoals]);

  useEffect(() => {
    if (activeId) loadDetail(activeId);
  }, [activeId, loadDetail]);

  const stopStream = () => {
    streamRef.current?.abort();
    streamRef.current = null;
  };

  const watchGoal = useCallback(
    async (goalId: string) => {
      stopStream();
      const controller = new AbortController();
      streamRef.current = controller;
      const handleEvent = (evt: Record<string, unknown>) => {
        const type = evt.type as string;
        if (type === 'snapshot') {
          const g = evt.goal as Goal;
          setGoals((prev) => prev.map((x) => (x.id === goalId ? g : x)));
          setTurns(evt.turns as GoalTurn[]);
        } else if (type === 'turn_started' || type === 'turn_done' || type === 'delegation' || type === 'delegation_done') {
          loadDetail(goalId);
        } else if (type === 'paused' || type === 'done' || type === 'failed' || type === 'stopped') {
          loadDetail(goalId);
          loadGoals();
          if (type !== 'paused') controller.abort();
        }
      };
      try {
        const streamRes = await authedFetch(`/api/group-goals/${goalId}/stream`, { signal: controller.signal });
        if (!streamRes.ok || !streamRes.body) throw new Error(`Goal stream failed (${streamRes.status})`);
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
                  handleEvent(JSON.parse(line.slice(5).trim()) as Record<string, unknown>);
                } catch {
                  // ignore malformed frames
                }
              }
            }
          }
        }
      } catch (e) {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      }
    },
    [loadDetail, loadGoals],
  );

  const createGoal = async () => {
    if (!title.trim()) {
      setError('Give the goal a title.');
      return;
    }
    setError(null);
    try {
      const res = await api<{ ok: boolean; goal: Goal }>('/api/group-goals', {
        method: 'POST',
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || undefined,
          workerBotIds: workers,
          maxTurns: parseInt(maxTurns, 10) || 13,
        }),
      });
      setTitle('');
      setDescription('');
      setWorkers([]);
      await loadGoals();
      setActiveId(res.goal.id);
      watchGoal(res.goal.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const stopGoal = async (goalId: string) => {
    try {
      await api(`/api/group-goals/${goalId}/stop`, { method: 'POST' });
      stopStream();
      loadDetail(goalId);
      loadGoals();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const resumeGoal = async (goalId: string) => {
    try {
      await api(`/api/group-goals/${goalId}/resume`, {
        method: 'POST',
        body: JSON.stringify({ input: resumeInput.trim() || undefined }),
      });
      setResumeInput('');
      loadDetail(goalId);
      watchGoal(goalId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const toggleWorker = (id: string) =>
    setWorkers((prev) => (prev.includes(id) ? prev.filter((w) => w !== id) : [...prev, id]));

  const resumable = active && ['needs-input', 'blocked', 'max-turns'].includes(active.status);
  const live = active && active.status === 'running';

  return (
    <div className="two-col">
      <div className="card">
        <h2>Group goals</h2>
        <p className="muted small">
          A coordinator works the goal in bounded turns, delegating to workers, and ends each
          turn with an explicit decision: completed, needs input, blocked, or continue.
        </p>
        {goals.length === 0 && <p className="muted small">No goals yet — start one below.</p>}
        <ul className="list">
          {goals.map((g) => (
            <li key={g.id} className={g.id === activeId ? 'active' : ''}>
              <button
                className="linklike"
                onClick={() => {
                  stopStream();
                  setActiveId(g.id);
                  if (g.status === 'running') watchGoal(g.id);
                }}
              >
                <strong>{g.title}</strong>
              </button>
              <div className="muted small">
                {STATUS_BADGE[g.status]} · {botName(g.coordinatorBotId)} leads · {g.workerBotIds.length} worker(s)
                {g.routineId && ' · from routine'}
              </div>
            </li>
          ))}
        </ul>

        <h3>New goal</h3>
        <input className="input" placeholder="Goal title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <textarea
          className="input"
          placeholder="What does “done” look like? (optional)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
        />
        <label className="small muted">Workers (coordinator auto-selects, chief preferred)</label>
        <div className="checklist">
          {bots.map((b) => (
            <label key={b.id} className="check">
              <input type="checkbox" checked={workers.includes(b.id)} onChange={() => toggleWorker(b.id)} />
              {b.name} <span className="muted small">— {b.description}</span>
            </label>
          ))}
        </div>
        <label className="small muted">Max turns (1–30, default 13)</label>
        <input className="input" value={maxTurns} onChange={(e) => setMaxTurns(e.target.value)} inputMode="numeric" />
        <button className="btn btn-primary" onClick={createGoal}>
          Start goal
        </button>
      </div>

      <div className="card">
        {!active && <p className="muted">Select a goal to see its turns.</p>}
        {active && (
          <>
            <h2>{active.title}</h2>
            <div className="muted small">
              {STATUS_BADGE[active.status]} · coordinator {botName(active.coordinatorBotId)} · turn {turns.length}/
              {active.maxTurns}
              {active.groupId && ' · in room'}
            </div>
            {active.description && <p className="small">{active.description}</p>}
            {error && <div className="error">{error}</div>}

            <div className="goal-actions">
              {live && (
                <button className="btn btn-sm btn-danger" onClick={() => stopGoal(active.id)}>
                  Stop goal
                </button>
              )}
              {resumable && (
                <>
                  <input
                    className="input"
                    placeholder="Reply / new instructions for the coordinator…"
                    value={resumeInput}
                    onChange={(e) => setResumeInput(e.target.value)}
                  />
                  <button className="btn btn-sm btn-primary" onClick={() => resumeGoal(active.id)}>
                    Resume goal
                  </button>
                  <button className="btn btn-sm btn-danger" onClick={() => stopGoal(active.id)}>
                    Stop
                  </button>
                </>
              )}
            </div>

            {(active.status === 'completed' || active.status === 'failed' || active.status === 'stopped') && active.summary && (
              <div className="goal-summary">
                <h3>{active.status === 'completed' ? 'Final summary' : 'Outcome'}</h3>
                <p className="small">{active.summary}</p>
              </div>
            )}

            <h3>Turns</h3>
            {turns.length === 0 && <p className="muted small">No turns yet.</p>}
            <ul className="list goal-turns">
              {turns.map((t) => (
                <li key={t.id}>
                  <div>
                    <strong>Turn {t.turnNumber}</strong> <span className="badge">{DECISION_BADGE[t.decision]}</span>
                  </div>
                  {t.delegations.length > 0 && (
                    <div className="muted small">
                      Delegations:{' '}
                      {t.delegations.map((d, i) => (
                        <span key={i}>
                          {d.botName} ({d.done ? 'done' : 'pending'})
                          {i < t.delegations.length - 1 ? '; ' : ''}
                        </span>
                      ))}
                    </div>
                  )}
                  {t.nextStep && <div className="small">Next: {t.nextStep}</div>}
                  <details>
                    <summary className="small muted">Coordinator reply</summary>
                    <p className="small pre-wrap">{t.coordinatorText}</p>
                  </details>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
