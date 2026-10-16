// SPDX-License-Identifier: Apache-2.0
'use client';

import { useEffect, useState } from 'react';
import { fetchAllAgents, rescanAgents, type AgentListEntryDto } from '../../lib/api';

/**
 * Detected coding agents panel (Codync parity: Agents section).
 * Shows installed CLIs with versions, plus not-installed agents with
 * install hints. Rescan re-reads PATH.
 */
export function DetectedAgentsPanel() {
  const [agents, setAgents] = useState<AgentListEntryDto[]>([]);
  const [scannedAt, setScannedAt] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [rescanning, setRescanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const load = async () => {
    try {
      setError(null);
      const data = await fetchAllAgents();
      setAgents(data.agents);
      setScannedAt(data.scannedAt);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const doRescan = async () => {
    setRescanning(true);
    try {
      const data = await rescanAgents();
      setAgents((await fetchAllAgents()).agents);
      setScannedAt(data.scannedAt);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRescanning(false);
    }
  };

  const installed = agents.filter((a) => a.installed);
  const notInstalled = agents.filter((a) => !a.installed);
  const visible = showAll ? agents : [...installed, ...notInstalled.slice(0, 5)];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <span style={{ fontSize: 13, opacity: 0.7 }}>
          {installed.length} installed
          {scannedAt > 0 && ` · scanned ${new Date(scannedAt).toLocaleTimeString()}`}
        </span>
        <button
          className="btn btn-ghost"
          onClick={doRescan}
          disabled={rescanning}
          style={{ marginLeft: 'auto' }}
        >
          {rescanning ? 'Scanning…' : '↻ Rescan'}
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      {loading && <div style={{ opacity: 0.6 }}>Scanning for coding agents…</div>}
      {!loading && installed.length === 0 && (
        <div style={{ opacity: 0.7, fontSize: 14 }}>
          No coding-agent CLIs found on PATH. Install one below to use it as a bot backend.
        </div>
      )}
      <div style={{ display: 'grid', gap: 8 }}>
        {visible.map((a) => (
          <div
            key={a.id}
            className="card"
            style={{ padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 10 }}
          >
            <span
              style={{
                width: 10, height: 10, borderRadius: '50%',
                background: a.installed ? '#22c55e' : '#6b7280',
                flexShrink: 0,
              }}
              title={a.installed ? 'Installed' : 'Not installed'}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>
                {a.name}
                {a.installed && a.version && (
                  <span style={{ fontWeight: 400, opacity: 0.6, marginLeft: 8, fontSize: 12 }}>
                    {a.version}
                  </span>
                )}
                {a.acpCompatible && (
                  <span
                    style={{ fontSize: 11, opacity: 0.6, marginLeft: 8, border: '1px solid currentColor', borderRadius: 4, padding: '1px 5px' }}
                    title="Speaks the Agent Client Protocol"
                  >
                    ACP
                  </span>
                )}
              </div>
              {!a.installed && a.installHint && (
                <code style={{ fontSize: 12, opacity: 0.75, display: 'block', marginTop: 4, wordBreak: 'break-all' }}>
                  {a.installHint}
                </code>
              )}
              {a.installed && (a as { path?: string }).path && (
                <div style={{ fontSize: 12, opacity: 0.55, wordBreak: 'break-all' }}>
                  {(a as { path: string }).path}
                </div>
              )}
            </div>
            <a
              href={a.homepage}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: 12, opacity: 0.6, flexShrink: 0 }}
            >
              ↗
            </a>
          </div>
        ))}
      </div>
      {!showAll && notInstalled.length > 5 && (
        <button className="btn btn-ghost" onClick={() => setShowAll(true)} style={{ marginTop: 8 }}>
          Show all {notInstalled.length} available agents
        </button>
      )}
    </div>
  );
}

/**
 * Dropdown selector of installed agents for use as a bot backend.
 * Calls onSelect(agentId) when the user picks one.
 */
export function AgentBackendSelector({
  value,
  onSelect,
}: {
  value?: string;
  onSelect: (agentId: string) => void;
}) {
  const [agents, setAgents] = useState<AgentListEntryDto[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchAllAgents()
      .then((d) => setAgents(d.agents.filter((a) => a.installed)))
      .catch(() => setAgents([]))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div style={{ opacity: 0.6, fontSize: 13 }}>Loading agents…</div>;
  if (agents.length === 0)
    return <div style={{ opacity: 0.6, fontSize: 13 }}>No coding agents detected. Install one in Settings → Detected coding agents.</div>;

  return (
    <select
      className="input"
      value={value ?? ''}
      onChange={(e) => onSelect(e.target.value)}
      aria-label="Agent backend"
    >
      <option value="">Select a coding agent…</option>
      {agents.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}{a.version ? ` (${a.version})` : ''}
        </option>
      ))}
    </select>
  );
}
