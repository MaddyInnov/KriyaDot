'use client';

import { useEffect, useState } from 'react';
import { PetPicker } from '../../components/pet/PetPicker';
import { AccentPicker } from '../../components/accent/AccentPicker';
import { McpScopesPanel } from '../../components/panels/mcp-scopes-panel';
import { McpOAuthPanel } from '../../components/panels/mcp-oauth-panel';
import { DetectedAgentsPanel } from '../../components/panels/detected-agents-panel';
import { AnalyticsPanel } from '../../components/panels/analytics-panel';
import { LocalLlmPanel } from '../../components/panels/local-llm-panel';
import { UpdatesPanel } from '../../components/panels/updates-panel';
import { AgentImportPanel } from '../../components/panels/agent-import-panel';
import { useUxMode } from '../../lib/ux-mode';

interface LearnedPreference {
  id: string;
  botId: string;
  toolName: string;
  preference: 'deny' | 'allow';
  observations: number;
  updatedAt: number;
}

interface Recording {
  id: string;
  name: string;
  status: 'recording' | 'stopped' | 'converted';
  events: Array<{ type: string; selector?: string; value?: string; url?: string; timestamp: number }>;
  createdAt: number;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers || {}) } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export default function PreferencesPage() {
  const [mode] = useUxMode();
  const [prefs, setPrefs] = useState<LearnedPreference[]>([]);
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [recName, setRecName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const [p, r] = await Promise.all([
        api<{ ok: boolean; preferences: LearnedPreference[] }>('/api/preferences'),
        api<{ ok: boolean; recordings: Recording[] }>('/api/recordings'),
      ]);
      setPrefs(p.preferences);
      setRecordings(r.recordings);
      setRecording(r.recordings.find((x) => x.status === 'recording') ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => { load(); }, []);

  const removePref = async (id: string) => {
    await api(`/api/preferences/${id}`, { method: 'DELETE' });
    load();
  };

  const startRecording = async () => {
    const res = await api<{ ok: boolean; recording: Recording }>('/api/recordings', {
      method: 'POST',
      body: JSON.stringify({ name: recName }),
    });
    setRecording(res.recording);
    setRecName('');
    load();
  };

  const stopRecording = async () => {
    if (!recording) return;
    await api(`/api/recordings/${recording.id}/stop`, { method: 'POST' });
    setRecording(null);
    load();
  };

  const convertRecording = async (id: string) => {
    const res = await api<{ ok: boolean; workflow: unknown }>(`/api/recordings/${id}/convert`, { method: 'POST' });
    alert('Workflow generated with ' + (res.workflow as { steps: unknown[] }).steps.length + ' steps. Save it from the Workflows page.');
    load();
  };

  return (
    <div className="page">
      <h1>Preferences & Recordings</h1>
      {error && <div className="error">{error}</div>}

      <section className="card">
        <h2>Brand accent</h2>
        <p className="muted small">
          Choose the jewel-tone accent that tints buttons, chat bubbles, nav highlights and
          your companion's glow. It applies instantly and works across every theme.
        </p>
        <AccentPicker />
      </section>

      <section className="card">
        <h2>Companion pet</h2>
        <p className="muted small">
          Pick a sidekick. It hangs out in the top bar and the chat empty state, and reacts
          while runs are working — thinking, typing away, celebrating when a run lands.
        </p>
        <PetPicker />
      </section>

      <section className="card">
        <h2>Learned preferences</h2>
        <p className="muted small">
          The platform learns from your approve/deny decisions. Deny a tool 3 times and it's auto-denied;
          approve it 5 times and it's auto-approved. Remove a preference to reset.
        </p>
        {prefs.length === 0 ? (
          <p className="muted">No learned preferences yet. Approve or deny tool requests and patterns will appear here.</p>
        ) : (
          <table className="table">
            <thead><tr><th>Bot</th><th>Tool</th><th>Learned</th><th>Decisions</th><th></th></tr></thead>
            <tbody>
              {prefs.map((p) => (
                <tr key={p.id}>
                  <td>{p.botId}</td>
                  <td><code>{p.toolName}</code></td>
                  <td>{p.preference === 'deny' ? '🚫 Auto-deny' : '✅ Auto-allow'}</td>
                  <td>{p.observations}</td>
                  <td><button className="btn small" onClick={() => removePref(p.id)}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {mode === 'pro' && (
        <section className="card">
          <h2>MCP tool scopes</h2>
          <p className="muted small">
            Per-tool capability gates. Turning off <em>Write</em> makes a tool read-only;
            turning off <em>Egress</em> blocks its network access. Changes apply immediately.
          </p>
          <McpScopesPanel />
        </section>
      )}

      {mode === 'pro' && (
        <section className="card">
          <h2>MCP connector sign-in</h2>
          <p className="muted small">
            OAuth-protected MCP servers need a one-time sign-in before bots can use them.
            Tokens stay encrypted on this computer and refresh automatically.
          </p>
          <McpOAuthPanel />
        </section>
      )}

      <section className="card">
        <h2>Detected coding agents</h2>
        <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 12 }}>
          Coding-agent CLIs found on this computer's PATH. Bots can use any installed agent as a backend.
        </p>
        <DetectedAgentsPanel />
      </section>

      <section className="card">
        <h2>Privacy & analytics</h2>
        <p className="muted small">
          Product analytics and crash reporting are <strong>off by default</strong>.
          When enabled, only feature-use counts are collected — never message content,
          prompts, or anything you typed.
        </p>
        <AnalyticsPanel />
      </section>

      <section className="card">
        <h2>Local LLM (llama.cpp)</h2>
        <p className="muted small">
          Run small models entirely on this machine — zero-config download of stock llama.cpp,
          GPU auto-detect, served on 127.0.0.1 only. No API key, no cloud, no cost.
        </p>
        <LocalLlmPanel />
      </section>

      <section className="card">
        <h2>Import from other agents</h2>
        <p className="muted small">
          Bring your skills, notes, sessions, and configs from Claude Code, Codex, OpenCode,
          OpenClaw, Pi, or Hermes into KriyaDot. Detection and preview are read-only; secrets
          are redacted; existing skills and bots are never overwritten.
        </p>
        <AgentImportPanel />
      </section>

      <section className="card">
        <h2>Updates</h2>
        <p className="muted small">
          Check the official KriyaDot releases for newer versions. Nothing downloads or
          installs without your explicit action — updates come only from
          MaddyInnov/KriyaDot on GitHub.
        </p>
        <UpdatesPanel />
      </section>

      <section className="card">
        <h2>Teach by recording</h2>
        <p className="muted small">
          Record your clicks and form fills, then convert the recording into a reusable workflow.
        </p>
        {recording ? (
          <div>
            <p>🔴 Recording: <strong>{recording.name}</strong> ({recording.events.length} events)</p>
            <button className="btn danger" onClick={stopRecording}>Stop recording</button>
          </div>
        ) : (
          <div className="row">
            <input
              className="input"
              placeholder="Recording name (e.g. Weekly report)"
              value={recName}
              onChange={(e) => setRecName(e.target.value)}
            />
            <button className="btn primary" onClick={startRecording}>Start recording</button>
          </div>
        )}
        {recordings.filter((r) => r.status !== 'recording').length > 0 && (
          <table className="table">
            <thead><tr><th>Name</th><th>Events</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {recordings.filter((r) => r.status !== 'recording').map((r) => (
                <tr key={r.id}>
                  <td>{r.name}</td>
                  <td>{r.events.length}</td>
                  <td>{r.status}</td>
                  <td>
                    {r.status === 'stopped' && (
                      <button className="btn small" onClick={() => convertRecording(r.id)}>Convert to workflow</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
