// SPDX-License-Identifier: Apache-2.0
'use client';

// Lazy MCP directory panel (OpenMausBot parity P1 #22): browse the curated
// directory, install (registers config only — the server spawns on first
// tool call), enable/disable, per-bot access, warm-up, uninstall.

import React, { useCallback, useEffect, useState } from 'react';
import { authedFetch, getBots } from '../../lib/api';

interface DirectoryEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  kind: 'stdio' | 'http';
  command?: string;
  args?: string[];
  needsEnv?: string[];
  permissions: string[];
  tools: Array<{ name: string; description: string }>;
  installed: boolean;
  serverId: string | null;
}

interface InstalledServer {
  id: string;
  directoryId: string | null;
  label: string;
  config: { kind: string; command?: string; url?: string };
  enabled: boolean;
  createdAt: string;
  health: { status: 'stopped' | 'starting' | 'running' | 'error'; lastError: string | null };
  botOverrides: Array<{ botId: string; enabled: boolean }>;
}

interface BotSummary {
  id: string;
  name: string;
}

const api = (path: string, init?: RequestInit): Promise<unknown> =>
  authedFetch(path, init).then(async (res) => {
    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new Error(`API ${res.status}: ${detail || res.statusText}`);
    }
    return res.json() as Promise<unknown>;
  });

export const HEALTH_DOT: Record<InstalledServer['health']['status'], string> = {
  stopped: 'gray',
  starting: 'amber',
  running: 'green',
  error: 'red',
};

export default function McpDirectoryPanel() {
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [servers, setServers] = useState<InstalledServer[]>([]);
  const [bots, setBots] = useState<BotSummary[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [category, setCategory] = useState('');

  const load = useCallback(async () => {
    try {
      const [dir, srv, botList] = await Promise.all([
        api('/api/mcp/directory') as Promise<DirectoryEntry[]>,
        api('/api/mcp/servers') as Promise<InstalledServer[]>,
        getBots(),
      ]);
      setEntries(dir);
      setServers(srv);
      setBots(botList.map((b) => ({ id: b.id, name: b.name })));
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (label: string, fn: () => Promise<unknown>) => {
      setBusy(label);
      setError('');
      try {
        await fn();
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy('');
      }
    },
    [load],
  );

  const categories = [...new Set(entries.map((e) => e.category))];
  const visible = category ? entries.filter((e) => e.category === category) : entries;

  return (
    <div>
      {error && <div className="error-box">{error}</div>}

      <h3 style={{ margin: '16px 0 8px' }}>Installed servers</h3>
      {servers.length === 0 ? (
        <p className="small muted">None yet — install one from the directory below.</p>
      ) : (
        <div className="card-grid">
          {servers.map((s) => (
            <div className="card" key={s.id}>
              <div className="row-between">
                <div>
                  <strong>{s.label}</strong>{' '}
                  <span className={`chip ${HEALTH_DOT[s.health.status]}`} title={s.health.lastError ?? s.health.status}>
                    {s.health.status}
                  </span>{' '}
                  {!s.enabled && <span className="chip gray">disabled</span>}
                </div>
                <span className="small muted mono">{s.config.kind}</span>
              </div>
              <p className="small muted">
                {s.config.kind === 'stdio' ? `${s.config.command ?? ''}` : s.config.url ?? ''}
                {s.health.lastError && <><br />Error: {s.health.lastError}</>}
              </p>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                {s.enabled ? (
                  <button className="btn btn-sm" disabled={busy === s.id} onClick={() => run(s.id, () => api(`/api/mcp/servers/${s.id}/disable`, { method: 'POST' }))}>
                    Disable
                  </button>
                ) : (
                  <button className="btn btn-sm btn-primary" disabled={busy === s.id} onClick={() => run(s.id, () => api(`/api/mcp/servers/${s.id}/enable`, { method: 'POST' }))}>
                    Enable
                  </button>
                )}
                <button className="btn btn-sm" disabled={busy === s.id || !s.enabled} title="Connect now instead of on first tool call"
                  onClick={() => run(s.id, () => api(`/api/mcp/servers/${s.id}/connect`, { method: 'POST' }))}>
                  Connect now
                </button>
                <button className="btn btn-sm btn-danger" disabled={busy === s.id}
                  onClick={() => { if (window.confirm(`Uninstall MCP server "${s.label}"?`)) void run(s.id, () => api(`/api/mcp/servers/${s.id}`, { method: 'DELETE' })); }}>
                  Uninstall
                </button>
              </div>
              <details style={{ marginTop: 8 }}>
                <summary className="small">Per-bot access</summary>
                {bots.map((b) => {
                  const override = s.botOverrides.find((o) => o.botId === b.id);
                  const allowed = override ? override.enabled : true;
                  return (
                    <label key={b.id} className="small" style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
                      <input
                        type="checkbox"
                        checked={allowed}
                        disabled={busy === `${s.id}:${b.id}`}
                        onChange={() => run(`${s.id}:${b.id}`, () =>
                          api(`/api/mcp/servers/${s.id}/bots/${encodeURIComponent(b.id)}`, {
                            method: 'PUT',
                            headers: { 'content-type': 'application/json' },
                            body: JSON.stringify({ enabled: !allowed }),
                          }),
                        )}
                      />
                      {b.name}
                    </label>
                  );
                })}
              </details>
            </div>
          ))}
        </div>
      )}

      <div className="row-between" style={{ margin: '24px 0 8px' }}>
        <h3 style={{ margin: 0 }}>Directory</h3>
        <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Filter by category">
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </div>
      <p className="small muted">
        Installing registers the server&apos;s config only — nothing downloads or runs until a bot
        actually calls one of its tools. Disabled servers never start.
      </p>
      <div className="card-grid">
        {visible.map((e) => (
          <div className="card" key={e.id}>
            <div className="row-between">
              <strong>{e.name}</strong>
              <span className="chip gray">{e.category}</span>
            </div>
            <p className="small muted">{e.description}</p>
            {e.permissions.length > 0 && (
              <p className="small">Permissions: {e.permissions.join(', ')}</p>
            )}
            {e.needsEnv && e.needsEnv.length > 0 && (
              <p className="small">Needs env: <span className="mono">{e.needsEnv.join(', ')}</span></p>
            )}
            <p className="small muted">Tools: {e.tools.map((t) => t.name).join(', ')}</p>
            {e.installed ? (
              <span className="chip green">installed</span>
            ) : (
              <button
                className="btn btn-sm btn-primary"
                disabled={busy === e.id}
                onClick={() => run(e.id, () => api('/api/mcp/servers', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ directoryId: e.id }),
                }))}
              >
                {busy === e.id ? 'Installing…' : 'Install'}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
