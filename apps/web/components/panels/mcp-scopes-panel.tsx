// SPDX-License-Identifier: Apache-2.0
'use client';

// MCP tool scopes: per-tool Read / Write / Egress toggles wired to
// GET /api/mcp/tools and PATCH /api/mcp/tools/:id/scopes.
// When the backend is missing the panel renders an empty state (never an
// error). Advanced surface — shown in Pro mode only.

import { useCallback, useEffect, useState } from 'react';
import { EmptyState, ErrorBox } from '../../app/modules/lib';
import { getMcpTools, patchMcpToolScopes } from '../../lib/kriyadot-api';
import type { McpTool, McpToolScopes } from '../../lib/kriyadot-api';

const SCOPE_KEYS: Array<{ key: keyof McpToolScopes; label: string; hint: string }> = [
  { key: 'read', label: 'Read', hint: 'Allow the tool to read data' },
  { key: 'write', label: 'Write', hint: 'Allow the tool to create, modify, or delete' },
  { key: 'egress', label: 'Egress', hint: 'Allow the tool to reach the network' },
];

export function McpScopesPanel() {
  const [tools, setTools] = useState<McpTool[]>([]);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState<string>('');

  const load = useCallback(async () => {
    try {
      const t = await getMcpTools();
      setMissing(t === null);
      setTools(t ?? []);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (tool: McpTool, key: keyof McpToolScopes) => {
    const next: McpToolScopes = { ...tool.scopes, [key]: !tool.scopes[key] };
    setSaving(`${tool.id}:${key}`);
    setError('');
    // Optimistic update; roll back on failure.
    setTools((prev) => prev.map((t) => (t.id === tool.id ? { ...t, scopes: next } : t)));
    try {
      await patchMcpToolScopes(tool.id, next);
    } catch (err) {
      setTools((prev) => prev.map((t) => (t.id === tool.id ? { ...t, scopes: tool.scopes } : t)));
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving('');
    }
  };

  if (error && tools.length === 0) return <ErrorBox error={error} />;
  if (missing) {
    return (
      <EmptyState text="No MCP tools registered yet — tool scope toggles will appear here once the MCP registry service is available." />
    );
  }

  return (
    <div>
      <ErrorBox error={error} />
      {tools.length === 0 ? (
        <EmptyState text="No MCP tools registered." />
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Tool</th>
                {SCOPE_KEYS.map((s) => (
                  <th key={s.key} title={s.hint}>
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tools.map((t) => (
                <tr key={t.id}>
                  <td>
                    <span className="mono">{t.name}</span>
                    <div className="small muted">{t.id}</div>
                  </td>
                  {SCOPE_KEYS.map((s) => {
                    const busy = saving === `${t.id}:${s.key}`;
                    const on = t.scopes[s.key];
                    return (
                      <td key={s.key}>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={on}
                          aria-label={`${t.name} ${s.label} scope`}
                          title={s.hint}
                          disabled={busy}
                          className="clay-toggle"
                          onClick={() => void toggle(t, s.key)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              void toggle(t, s.key);
                            }
                          }}
                        >
                          <span className="track" aria-hidden="true">
                            <span className="knob" aria-hidden="true" />
                          </span>
                          <span className="tlabel">{on ? 'On' : 'Off'}</span>
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
