// SPDX-License-Identifier: Apache-2.0
'use client';

/**
 * Intent search (#166): "Find a specialist/capability by intent" inside
 * Chat. Calls POST /api/discovery/search and groups results by kind
 * (bots / skills / capabilities / mcp). Bots can be opened in this chat;
 * other kinds offer the actions the app already supports (open the
 * Marketplace, copy the id for a bot's skills/tools settings).
 */
import { useState } from 'react';
import { discoverySearch } from '../../lib/octomind-api';
import { groupDiscoveryResults, type DiscoveryKind } from '../../lib/octomind-web';

const GROUP_LABELS: Record<DiscoveryKind, string> = {
  bots: '🤖 Bots / specialists',
  skills: '🧩 Skills',
  capabilities: '🛠 Capabilities',
  mcp: '🔌 MCP servers',
  other: 'Other',
};

export function DiscoveryPanel({ onPickBot }: { onPickBot?: (botId: string) => void }) {
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [groups, setGroups] = useState<ReturnType<typeof groupDiscoveryResults> | null>(null);

  const search = async () => {
    const q = query.trim();
    if (!q) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const raw = await discoverySearch(q);
      setGroups(groupDiscoveryResults(raw));
    } catch (err) {
      setGroups(null);
      setError(
        `Intent search is not available yet (${err instanceof Error ? err.message : String(err)}). ` +
          'The discovery endpoint (POST /api/discovery/search) has not landed on this API.',
      );
    } finally {
      setBusy(false);
    }
  };

  const copyId = async (id: string) => {
    try {
      await navigator.clipboard.writeText(id);
      setNotice(`Copied id "${id}" — paste it in Bots → skills/tools, or the Marketplace.`);
    } catch {
      setNotice(`Id: ${id}`);
    }
  };

  const total = groups ? Object.values(groups).reduce((n, g) => n + g.length, 0) : 0;

  return (
    <div className="card" style={{ margin: '8px 0' }} aria-label="Find a specialist by intent">
      <strong>Find a specialist / capability by intent</strong>
      <p className="small muted" style={{ margin: '4px 0 8px' }}>
        Describe what you need in plain language — matching bots, skills, capabilities and MCP
        servers are ranked by intent, not just by name.
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input
          className="input"
          style={{ flex: '1 1 240px' }}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void search(); } }}
          placeholder="e.g. someone who can reconcile invoices and chase payments"
          aria-label="Intent search query"
        />
        <button type="button" className="btn btn-primary btn-sm" disabled={busy || !query.trim()} onClick={() => void search()}>
          {busy ? 'Searching…' : 'Search'}
        </button>
      </div>
      {error && <div className="error-box" style={{ marginTop: 8 }}>{error}</div>}
      {notice && <p className="small" style={{ marginTop: 8 }}>{notice}</p>}
      {groups && total === 0 && !error && <p className="small muted" style={{ marginTop: 8 }}>No matches for that intent.</p>}
      {groups &&
        (Object.keys(GROUP_LABELS) as DiscoveryKind[]).map((kind) =>
          groups[kind].length === 0 ? null : (
            <div key={kind} style={{ marginTop: 10 }}>
              <div className="small" style={{ fontWeight: 600 }}>{GROUP_LABELS[kind]}</div>
              {groups[kind].map((item) => (
                <div key={`${kind}-${item.id}`} className="row-between" style={{ gap: 8, padding: '4px 0' }}>
                  <span className="small">
                    <strong>{item.name}</strong>{' '}
                    <span className="muted mono">{item.id}</span>
                    {item.score !== null && <span className="muted"> · score {item.score.toFixed(2)}</span>}
                    {item.description && <span className="muted"> — {item.description}</span>}
                  </span>
                  {kind === 'bots' && onPickBot ? (
                    <button type="button" className="btn btn-sm" onClick={() => onPickBot(item.id)}>
                      Chat with this bot
                    </button>
                  ) : (
                    <span style={{ display: 'flex', gap: 6 }}>
                      <button type="button" className="btn btn-sm" onClick={() => void copyId(item.id)}>
                        Copy id
                      </button>
                      {(kind === 'skills' || kind === 'mcp') && (
                        <a className="btn btn-sm" href="/marketplace">Open in Marketplace</a>
                      )}
                    </span>
                  )}
                </div>
              ))}
            </div>
          ),
        )}
    </div>
  );
}
