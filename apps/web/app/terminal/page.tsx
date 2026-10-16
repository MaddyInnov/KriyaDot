'use client';

// Terminal AI+ — interactive shell sessions in the browser with an AI
// side-panel that suggests/explains commands. AI-suggested commands run
// only after a governance approval (fail-closed).

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState } from 'react';
import { authedFetch } from '../../lib/api';

const XTermTerminal = dynamic(() => import('@/components/terminal/xterm-terminal'), { ssr: false });

interface TerminalSession {
  id: string;
  name: string;
  status: 'open' | 'closed';
  backend: 'pty' | 'docker' | 'host';
  sandboxed: boolean;
  cwd: string;
  createdAt: number;
}

interface Suggestion {
  command: string;
  explanation: string;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await authedFetch(path, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers || {}) } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status}: ${text || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export default function TerminalPage() {
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [goal, setGoal] = useState('');
  const [suggesting, setSuggesting] = useState(false);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [running, setRunning] = useState(false);
  const [runNote, setRunNote] = useState<string | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const active = sessions.find((s) => s.id === activeId) ?? null;

  const load = useCallback(async () => {
    try {
      const res = await api<{ ok: boolean; sessions: TerminalSession[] }>('/api/terminal/sessions');
      setSessions(res.sessions);
      setActiveId((prev) => {
        if (prev && res.sessions.some((s) => s.id === prev)) return prev;
        return res.sessions.length > 0 ? res.sessions[res.sessions.length - 1].id : null;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    load();
    refreshTimer.current = setInterval(load, 10000);
    return () => {
      if (refreshTimer.current) clearInterval(refreshTimer.current);
    };
  }, [load]);

  const createSession = async () => {
    setError(null);
    try {
      const res = await api<{ ok: boolean; session: TerminalSession }>('/api/terminal/sessions', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      await load();
      setActiveId(res.session.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const closeSession = async (id: string) => {
    try {
      await api(`/api/terminal/sessions/${id}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const suggest = async () => {
    if (!goal.trim() || suggesting) return;
    setSuggesting(true);
    setSuggestion(null);
    setRunNote(null);
    setError(null);
    try {
      const res = await api<{ ok: boolean; command: string; explanation: string }>('/api/terminal/ai/suggest', {
        method: 'POST',
        body: JSON.stringify({ sessionId: activeId, goal: goal.trim() }),
      });
      setSuggestion({ command: res.command, explanation: res.explanation });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSuggesting(false);
    }
  };

  const runSuggestion = async () => {
    if (!suggestion || !activeId || running) return;
    setRunning(true);
    setRunNote('Waiting for approval in your inbox…');
    try {
      await api('/api/terminal/ai/run', {
        method: 'POST',
        body: JSON.stringify({ sessionId: activeId, command: suggestion.command }),
      });
      setRunNote('Approved — command sent to the terminal.');
      setSuggestion(null);
      setGoal('');
    } catch (e) {
      setRunNote(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="page terminal-page">
      <div className="page-head">
        <div>
          <h1>Terminal AI+</h1>
          <p className="muted">A persistent shell in your browser, with an AI copilot for commands.</p>
        </div>
        <button className="btn btn-primary" onClick={createSession}>+ New session</button>
      </div>
      {error && <div className="error">{error}</div>}

      <div className="terminal-layout">
        <div className="card terminal-main">
          {sessions.length > 0 && (
            <div className="terminal-tabs">
              {sessions.map((s) => (
                <button
                  key={s.id}
                  className={`tab${s.id === activeId ? ' active' : ''}${s.status === 'closed' ? ' closed' : ''}`}
                  onClick={() => setActiveId(s.id)}
                >
                  {s.name}
                  <span
                    className="tab-close"
                    title="Close session"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeSession(s.id);
                    }}
                  >
                    ×
                  </span>
                </button>
              ))}
            </div>
          )}
          {active && (
            <div className={`sandbox-banner${active.sandboxed ? '' : ' warn'}`}>
              {active.sandboxed
                ? `Sandboxed (${active.backend}) — commands run isolated from your machine.`
                : `Running on host (${active.backend}) — NOT sandboxed. Prefer docker for isolation.`}
            </div>
          )}
          <div className="terminal-body">
            {active && active.status === 'open' ? (
              <XTermTerminal key={active.id} sessionId={active.id} />
            ) : (
              <div className="terminal-empty">
                <p className="muted">No open session. Create one to get a shell.</p>
                <button className="btn btn-primary" onClick={createSession}>+ New session</button>
              </div>
            )}
          </div>
        </div>

        <aside className="card ai-panel">
          <h2>AI assist</h2>
          <p className="muted small">Describe what you want to do; the agent suggests a command. Nothing runs without your approval.</p>
          <textarea
            className="input"
            rows={3}
            placeholder="e.g. show the 10 largest files in this project"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') suggest();
            }}
          />
          <button className="btn btn-primary" onClick={suggest} disabled={suggesting || !goal.trim()}>
            {suggesting ? 'Thinking…' : 'Suggest command'}
          </button>
          {suggestion && (
            <div className="suggestion">
              <code className="suggestion-cmd">{suggestion.command}</code>
              <p className="muted small">{suggestion.explanation}</p>
              <div className="row">
                <button className="btn btn-primary btn-sm" onClick={runSuggestion} disabled={running || !active || active.status !== 'open'}>
                  {running ? 'Waiting…' : 'Run (needs approval)'}
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => navigator.clipboard?.writeText(suggestion.command).catch(() => undefined)}
                >
                  Copy
                </button>
              </div>
              {runNote && <p className="muted small">{runNote}</p>}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
