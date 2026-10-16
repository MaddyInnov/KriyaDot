// SPDX-License-Identifier: Apache-2.0
'use client';

// Import from other AI agents (Atomic parity) — Preferences section.
// Flow: detect installed tools → pick a source → preview items with
// checkboxes → choose a target bot → confirm → summary report.
//
// Safety notes shown in the UI: detection/preview never write to the other
// tool's directories; secrets are redacted before storage; existing
// KriyaDot skills/bots are never overwritten (collisions are skipped).

import { useEffect, useState } from 'react';

interface SourceCounts {
  skills: number;
  sessions: number;
  memoryFiles: number;
  configs: number;
}

interface AgentSource {
  id: string;
  name: string;
  description: string;
  present: boolean;
  counts: SourceCounts;
  note?: string;
}

interface PreviewItem {
  id: string;
  kind: 'skill' | 'memory' | 'session' | 'bot';
  title: string;
  detail: string;
  excerpt: string;
  lossy?: string;
}

interface BotConfigLite {
  id: string;
  name: string;
}

interface ImportReport {
  imported: { skills: string[]; memories: number; sessions: string[]; bot?: string };
  skipped: Array<{ id: string; reason: string }>;
  errors: Array<{ id: string; reason: string }>;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers || {}) } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${body || res.statusText}`.slice(0, 300));
  }
  return res.json() as Promise<T>;
}

const KIND_ICON: Record<PreviewItem['kind'], string> = {
  skill: '🧩',
  memory: '🧠',
  session: '💬',
  bot: '🤖',
};

export function AgentImportPanel() {
  const [sources, setSources] = useState<AgentSource[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [items, setItems] = useState<PreviewItem[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [bots, setBots] = useState<BotConfigLite[]>([]);
  const [targetBotId, setTargetBotId] = useState('');
  const [createBot, setCreateBot] = useState(false);
  const [botName, setBotName] = useState('');
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);

  useEffect(() => {
    api<{ sources: AgentSource[] }>('/api/agent-import/sources')
      .then((r) => setSources(r.sources))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    api<BotConfigLite[]>('/api/bots')
      .then((b) => {
        setBots(b);
        if (b.length > 0) setTargetBotId(b[0].id);
      })
      .catch(() => undefined);
  }, []);

  const selectSource = async (id: string) => {
    setSelectedSource(id);
    setItems(null);
    setReport(null);
    setError(null);
    try {
      const preview = await api<{ items: PreviewItem[] }>('/api/agent-import/preview', {
        method: 'POST',
        body: JSON.stringify({ sourceId: id }),
      });
      setItems(preview.items);
      setChecked(new Set(preview.items.map((i) => i.id)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const toggleItem = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const runImport = async () => {
    if (!selectedSource || !targetBotId || checked.size === 0) return;
    setRunning(true);
    setReport(null);
    setError(null);
    try {
      const result = await api<ImportReport>('/api/agent-import/run', {
        method: 'POST',
        body: JSON.stringify({
          sourceId: selectedSource,
          targetBotId,
          itemIds: [...checked],
          createBot: createBot || undefined,
          botName: botName.trim() || undefined,
        }),
      });
      setReport(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  if (error && !sources) return <p className="muted small">Import detection failed: {error}</p>;
  if (!sources) return <p className="muted small">Detecting installed agent tools…</p>;

  const present = sources.filter((s) => s.present);
  const botItemSelected = items?.some((i) => i.kind === 'bot' && checked.has(i.id)) ?? false;

  return (
    <div className="agent-import-panel">
      {present.length === 0 && (
        <p className="muted small">
          No other agent tools detected on this machine. We look for Claude Code, Codex,
          OpenCode, OpenClaw, Pi, and Hermes in their standard config locations.
        </p>
      )}
      {present.length > 0 && !selectedSource && (
        <div>
          <p className="muted small">Detected on this machine:</p>
          <div className="import-source-list">
            {present.map((s) => (
              <button key={s.id} type="button" className="import-source-card" onClick={() => selectSource(s.id)}>
                <strong>{s.name}</strong>
                <span className="muted small">
                  {s.counts.skills} skills · {s.counts.sessions} sessions · {s.counts.memoryFiles} memory files
                  {s.counts.configs > 0 ? ` · ${s.counts.configs} configs` : ''}
                </span>
                <span className="muted small">{s.description}</span>
                {s.note && <span className="muted small">Note: {s.note}</span>}
              </button>
            ))}
          </div>
        </div>
      )}
      {selectedSource && (
        <div>
          <button type="button" className="linklike" onClick={() => { setSelectedSource(null); setItems(null); setReport(null); }}>
            ← Back to detected tools
          </button>
          {!items && <p className="muted small">Loading preview…</p>}
          {items && (
            <>
              <p className="muted small">
                Select what to import from {sources.find((s) => s.id === selectedSource)?.name}.
                Secrets are redacted before anything is stored; existing skills and bots are never overwritten.
              </p>
              <div className="import-item-list">
                {items.map((item) => (
                  <label key={item.id} className="import-item">
                    <input
                      type="checkbox"
                      checked={checked.has(item.id)}
                      onChange={() => toggleItem(item.id)}
                    />
                    <span className="import-item-body">
                      <span>
                        {KIND_ICON[item.kind]} <strong>{item.title}</strong>{' '}
                        <span className="muted small">({item.kind})</span>
                      </span>
                      <span className="muted small">{item.detail}</span>
                      {item.excerpt && <pre className="import-excerpt">{item.excerpt}</pre>}
                      {item.lossy && <span className="import-lossy">⚠️ {item.lossy}</span>}
                    </span>
                  </label>
                ))}
              </div>
              {items.length === 0 && <p className="muted small">Nothing importable found for this source.</p>}
              {items.length > 0 && (
                <div className="import-run-controls">
                  <label>
                    Import into bot:{' '}
                    <select value={targetBotId} onChange={(e) => setTargetBotId(e.target.value)}>
                      {bots.map((b) => (
                        <option key={b.id} value={b.id}>{b.name}</option>
                      ))}
                    </select>
                  </label>
                  {botItemSelected && (
                    <label className="import-bot-opts">
                      <input type="checkbox" checked={createBot} onChange={(e) => setCreateBot(e.target.checked)} />
                      Create the proposed bot too
                      <input
                        type="text"
                        placeholder="Bot id (optional)"
                        value={botName}
                        onChange={(e) => setBotName(e.target.value)}
                        aria-label="Proposed bot id"
                      />
                    </label>
                  )}
                  <button
                    type="button"
                    className="primary"
                    disabled={running || checked.size === 0 || !targetBotId}
                    onClick={runImport}
                  >
                    {running ? 'Importing…' : `Import ${checked.size} item${checked.size === 1 ? '' : 's'}`}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
      {error && <p className="import-error">Error: {error}</p>}
      {report && (
        <div className="import-report">
          <h4>Import complete</h4>
          <ul>
            <li>Skills imported: {report.imported.skills.length}{report.imported.skills.length > 0 && ` (${report.imported.skills.join(', ')})`}</li>
            <li>Memory entries imported: {report.imported.memories}</li>
            <li>Sessions archived: {report.imported.sessions.length}</li>
            {report.imported.bot && <li>Bot created: {report.imported.bot}</li>}
          </ul>
          {report.skipped.length > 0 && (
            <>
              <h4>Skipped (nothing overwritten)</h4>
              <ul>{report.skipped.map((s) => <li key={s.id}>{s.id} — {s.reason}</li>)}</ul>
            </>
          )}
          {report.errors.length > 0 && (
            <>
              <h4>Errors</h4>
              <ul>{report.errors.map((s) => <li key={s.id}>{s.id} — {s.reason}</li>)}</ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
