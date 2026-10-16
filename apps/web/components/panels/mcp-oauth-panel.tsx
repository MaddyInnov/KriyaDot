// SPDX-License-Identifier: Apache-2.0
'use client';

// MCP OAuth connector sign-in: per-server OAuth status, "Sign in" flow,
// probe (does this server need OAuth?), manual code entry, and disconnect.
// Wired to GET /api/mcp/oauth/status, /start, /manual, /probe and
// DELETE /api/mcp/oauth/:server. Tokens never leave the backend.
// Shown in Pro mode only (advanced surface, next to MCP tool scopes).

import { useCallback, useEffect, useState } from 'react';
import { EmptyState, ErrorBox } from '../../app/modules/lib';
import {
  completeMcpOAuthManual,
  getMcpOAuthStatus,
  probeMcpOAuth,
  revokeMcpOAuth,
  startMcpOAuth,
  type McpOAuthProbe,
  type McpOAuthServerStatus,
} from '../../lib/kriyadot-api';

function statusBadge(s: McpOAuthServerStatus): { text: string; color: string } {
  if (s.connected) {
    const exp = s.expiresAt ? new Date(s.expiresAt).toLocaleString() : 'unknown expiry';
    return { text: `Connected · expires ${exp}`, color: 'var(--ok, #3d9a50)' };
  }
  if (s.oauth) return { text: 'Not connected', color: 'var(--warn, #b7791f)' };
  return { text: 'No OAuth configured', color: 'var(--muted, #888)' };
}

export function McpOAuthPanel() {
  const [servers, setServers] = useState<McpOAuthServerStatus[]>([]);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [probes, setProbes] = useState<Record<string, McpOAuthProbe>>({});
  const [manualFor, setManualFor] = useState('');
  const [manualCode, setManualCode] = useState('');
  const [manualState, setManualState] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await getMcpOAuthStatus();
      setServers(r.servers ?? []);
      setMissing(false);
      setError('');
    } catch (err) {
      setMissing(true);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const signIn = async (server: string) => {
    setBusy(`signin:${server}`);
    setError('');
    try {
      const r = await startMcpOAuth(server);
      // Open the provider consent screen; the loopback callback completes it.
      window.open(r.authUrl, '_blank', 'noopener');
      // Keep the state handy for manual code entry if the callback tab fails.
      setManualFor(server);
      setManualState(r.state);
      setManualCode('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const probe = async (server: string) => {
    setBusy(`probe:${server}`);
    setError('');
    try {
      const p = await probeMcpOAuth(server);
      setProbes((prev) => ({ ...prev, [server]: p }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const disconnect = async (server: string) => {
    setBusy(`revoke:${server}`);
    setError('');
    try {
      await revokeMcpOAuth(server);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const completeManual = async () => {
    if (!manualCode.trim() || !manualState.trim()) {
      setError('Enter the code and state from the sign-in flow.');
      return;
    }
    setBusy('manual');
    setError('');
    try {
      await completeMcpOAuthManual(manualCode.trim(), manualState.trim());
      setManualFor('');
      setManualCode('');
      setManualState('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  if (missing && servers.length === 0) {
    return <EmptyState text="MCP OAuth status unavailable — the API may not expose /api/mcp/oauth/status yet." />;
  }

  return (
    <div>
      <ErrorBox error={error} />
      {servers.length === 0 ? (
        <EmptyState text="No HTTP MCP servers configured. Add one in mcp.json to connect it here." />
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Server</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {servers.map((s) => {
                const badge = statusBadge(s);
                const p = probes[s.server];
                return (
                  <tr key={s.server}>
                    <td>
                      <strong>{s.server}</strong>
                      {s.url && (
                        <div style={{ fontSize: 12, opacity: 0.7, wordBreak: 'break-all' }}>{s.url}</div>
                      )}
                      {p && (
                        <div style={{ fontSize: 12, marginTop: 4, opacity: 0.85 }}>
                          Probe: {p.requiresOAuth ? 'requires OAuth' : 'no OAuth needed'} — {p.detail}
                        </div>
                      )}
                    </td>
                    <td>
                      <span style={{ color: badge.color, fontWeight: 600 }}>{badge.text}</span>
                      {!s.hasRefreshToken && s.connected && (
                        <div style={{ fontSize: 12, opacity: 0.7 }}>no refresh token — will need re-sign-in</div>
                      )}
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {!s.connected && (
                        <button
                          className="btn btn-sm"
                          disabled={busy !== ''}
                          onClick={() => void signIn(s.server)}
                        >
                          {busy === `signin:${s.server}` ? '…' : 'Sign in'}
                        </button>
                      )}
                      <button
                        className="btn btn-sm btn-ghost"
                        disabled={busy !== ''}
                        onClick={() => void probe(s.server)}
                        style={{ marginLeft: 6 }}
                      >
                        {busy === `probe:${s.server}` ? '…' : 'Probe'}
                      </button>
                      {s.connected && (
                        <button
                          className="btn btn-sm btn-ghost"
                          disabled={busy !== ''}
                          onClick={() => void disconnect(s.server)}
                          style={{ marginLeft: 6 }}
                        >
                          {busy === `revoke:${s.server}` ? '…' : 'Disconnect'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {manualFor && (
        <div className="card" style={{ marginTop: 12 }}>
          <h3 style={{ marginTop: 0 }}>Complete sign-in for {manualFor}</h3>
          <p style={{ fontSize: 13, opacity: 0.8 }}>
            If the consent tab completed but this page didn't update, paste the code (and state) here.
            The PKCE verifier never left this computer, so only this host can use the code.
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input
              className="input"
              placeholder="Authorization code"
              value={manualCode}
              onChange={(e) => setManualCode(e.target.value)}
              style={{ flex: '2 1 200px' }}
            />
            <input
              className="input"
              placeholder="State"
              value={manualState}
              onChange={(e) => setManualState(e.target.value)}
              style={{ flex: '1 1 140px' }}
            />
            <button className="btn btn-sm" disabled={busy !== ''} onClick={() => void completeManual()}>
              {busy === 'manual' ? '…' : 'Complete sign-in'}
            </button>
            <button className="btn btn-sm btn-ghost" onClick={() => setManualFor('')}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
