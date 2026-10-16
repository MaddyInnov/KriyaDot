// SPDX-License-Identifier: Apache-2.0
'use client';

// Marketplace: browse/install bots, skills, workflows, and MCP servers from
// the local registry. MCP installs are approval-gated: requesting an install
// creates a governance approval; the entry installs only after the approval
// is approved in the approvals inbox.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { authedFetch } from '../../lib/api';
import SkillsPanel from '../../components/skills/skills-panel';

interface MarketplaceEntry {
  id: string;
  kind: 'bot' | 'skill' | 'workflow' | 'mcp-server';
  name: string;
  version: string;
  creator: string;
  description: string;
  license: string;
  priceCents: number;
  tags: string[];
  untrusted: boolean;
}

interface CreatorSummary {
  creator: string;
  installs: number;
  usageTokens: number;
  balanceCents: number;
  salesCents: number;
}

const api = (path: string, init?: RequestInit): Promise<unknown> =>
  authedFetch(path, init).then(async (res) => {
    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new Error(`API ${res.status}: ${detail || res.statusText}`);
    }
    return res.json() as Promise<unknown>;
  });

const fmtMoney = (cents: number): string =>
  `$${(cents / 100).toFixed(2).replace(/\.00$/, '')}`;

type Tab = 'browse' | 'skills' | 'revenue';

export default function MarketplacePage() {
  const [tab, setTab] = useState<Tab>('browse');
  const [entries, setEntries] = useState<MarketplaceEntry[]>([]);
  const [kind, setKind] = useState<string>('');
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [installing, setInstalling] = useState('');
  const [notice, setNotice] = useState('');
  const [creators, setCreators] = useState<CreatorSummary[]>([]);
  const [platformCents, setPlatformCents] = useState(0);

  const loadEntries = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (kind) params.set('kind', kind);
      if (query.trim()) params.set('q', query.trim());
      const q = params.toString();
      const list = (await api(`/api/marketplace${q ? `?${q}` : ''}`)) as MarketplaceEntry[];
      setEntries(list);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [kind, query]);

  const loadRevenue = useCallback(async () => {
    try {
      const data = (await api('/api/marketplace/revenue/creators')) as {
        creators: CreatorSummary[];
        platformEarningsCents: number;
      };
      setCreators(data.creators);
      setPlatformCents(data.platformEarningsCents);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (tab === 'browse') void loadEntries();
    else if (tab === 'revenue') void loadRevenue();
  }, [tab, loadEntries, loadRevenue]);

  const install = async (entry: MarketplaceEntry) => {
    setInstalling(entry.id);
    setNotice('');
    setError('');
    try {
      if (entry.kind === 'mcp-server') {
        const res = (await api(`/api/marketplace/${entry.id}/install`, { method: 'POST' })) as {
          approvalId: string;
          message: string;
        };
        setNotice(
          `Approval requested for "${entry.name}" (approval ${res.approvalId}). ` +
            'Approve it in the approvals inbox, then confirm the install below.',
        );
        sessionStorage.setItem(`mcp-approval-${entry.id}`, res.approvalId);
      } else {
        await api(`/api/marketplace/${entry.id}/install`, { method: 'POST' });
        setNotice(`Installed "${entry.name}" v${entry.version}.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling('');
    }
  };

  const confirmMcp = async (entry: MarketplaceEntry) => {
    const approvalId = sessionStorage.getItem(`mcp-approval-${entry.id}`);
    if (!approvalId) {
      setError('No pending approval for this entry — request an install first.');
      return;
    }
    setInstalling(entry.id);
    setError('');
    try {
      await api(`/api/marketplace/${entry.id}/install/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvalId }),
      });
      setNotice(`Installed MCP server "${entry.name}".`);
      sessionStorage.removeItem(`mcp-approval-${entry.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling('');
    }
  };

  return (
    <div>
      <h1 className="page-title">Marketplace</h1>
      <p className="page-sub">
        Browse and install bots, skills, workflows, and MCP servers from the local registry.
        MCP servers are never installed without your approval.
      </p>

      <div className="row-between" style={{ marginBottom: 16 }}>
        <div>
          <button className={`btn btn-sm${tab === 'browse' ? ' btn-primary' : ''}`} onClick={() => setTab('browse')}>
            Browse
          </button>{' '}
          <button className={`btn btn-sm${tab === 'skills' ? ' btn-primary' : ''}`} onClick={() => setTab('skills')}>
            Skills
          </button>{' '}
          <button className={`btn btn-sm${tab === 'revenue' ? ' btn-primary' : ''}`} onClick={() => setTab('revenue')}>
            Creator revenue
          </button>
        </div>
        <Link href="/approvals" className="small" style={{ color: 'var(--accent)' }}>
          Open approvals inbox →
        </Link>
      </div>

      {error && <div className="error-box">{error}</div>}
      {notice && <div className="warn-box">{notice}</div>}

      {tab === 'browse' && (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="grid-2">
              <div className="field">
                <label className="label" htmlFor="mkt-q">Search</label>
                <input
                  id="mkt-q"
                  className="input"
                  placeholder="name, creator, tag…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <div className="field">
                <label className="label" htmlFor="mkt-kind">Kind</label>
                <select
                  id="mkt-kind"
                  className="input"
                  value={kind}
                  onChange={(e) => setKind(e.target.value)}
                >
                  <option value="">All kinds</option>
                  <option value="bot">Bots</option>
                  <option value="skill">Skills</option>
                  <option value="workflow">Workflows</option>
                  <option value="mcp-server">MCP servers</option>
                </select>
              </div>
            </div>
            <button className="btn btn-sm" onClick={() => void loadEntries()}>
              Search
            </button>
          </div>

          <div className="grid-2">
            {entries.map((e) => (
              <div key={`${e.kind}:${e.id}`} className="card">
                <div className="row-between">
                  <strong>{e.name}</strong>
                  <span className={`chip ${e.kind === 'mcp-server' ? 'amber' : 'gray'}`}>{e.kind}</span>
                </div>
                <p className="small muted">{e.description}</p>
                <p className="small muted">
                  <span className="mono">{e.creator}</span> · v{e.version} · {e.license} ·{' '}
                  {e.priceCents === 0 ? 'Free' : fmtMoney(e.priceCents)}
                  {e.untrusted && <span className="chip amber" style={{ marginLeft: 8 }}>third-party</span>}
                </p>
                {e.tags.length > 0 && (
                  <p className="small">
                    {e.tags.map((t) => (
                      <span key={t} className="chip gray" style={{ marginRight: 4 }}>{t}</span>
                    ))}
                  </p>
                )}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={installing === e.id}
                    onClick={() => void install(e)}
                  >
                    {installing === e.id ? 'Working…' : e.kind === 'mcp-server' ? 'Request install (approval)' : 'Install'}
                  </button>
                  {e.kind === 'mcp-server' && (
                    <button
                      className="btn btn-sm"
                      disabled={installing === e.id}
                      onClick={() => void confirmMcp(e)}
                      title="Complete the install after approving it in the approvals inbox"
                    >
                      Confirm install
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
          {entries.length === 0 && <p className="muted">No marketplace entries match.</p>}
        </>
      )}

      {tab === 'skills' && <SkillsPanel />}

      {tab === 'revenue' && (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="row-between">
              <strong>Platform earnings</strong>
              <span className="chip green">{fmtMoney(platformCents)}</span>
            </div>
            <p className="small muted">
              Creators keep the configured share of each sale (default 70%). Balances below are net of payouts.
            </p>
          </div>
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Creator</th>
                  <th>Installs</th>
                  <th>Usage tokens</th>
                  <th>Sales</th>
                  <th>Balance</th>
                </tr>
              </thead>
              <tbody>
                {creators.map((c) => (
                  <tr key={c.creator}>
                    <td className="mono">{c.creator}</td>
                    <td>{c.installs}</td>
                    <td>{c.usageTokens.toLocaleString()}</td>
                    <td>{fmtMoney(c.salesCents)}</td>
                    <td>{fmtMoney(c.balanceCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {creators.length === 0 && <p className="muted">No creator activity recorded yet.</p>}
        </>
      )}
    </div>
  );
}
