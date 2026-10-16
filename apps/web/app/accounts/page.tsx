// SPDX-License-Identifier: Apache-2.0
'use client';

/**
 * Accounts page (Phase 4, Workstream C): connected OAuth accounts, the
 * encrypted per-user secret vault, and the (mock-only) wallet.
 *
 * Self-contained in this one file — the UI workstream wires the nav entry.
 * Talks to /api/vault, /api/wallet, /api/accounts/summary, and the existing
 * OAuth endpoints (apps/api/src/oauth.ts). Values from the vault are fetched
 * one at a time and never held in the list state.
 */

import { useCallback, useEffect, useState } from 'react';
import { authedFetch, getApiBase } from '../../lib/api';

const base = () => getApiBase();

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await authedFetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `Request failed (${res.status})`);
  return json;
}

interface OAuthStatus {
  id: string;
  name: string;
  connected: boolean;
  expiresAt?: number;
  hasRefreshToken: boolean;
}

interface SecretMeta {
  name: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
  kind?: 'secret' | 'login';
}

interface Secret extends SecretMeta {
  value: string;
}

interface LoginMeta {
  name: string;
  site: string;
  username: string;
  createdAt: number;
  updatedAt: number;
  kind: 'login';
}

interface PaymentMethod {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  holderName?: string;
}

interface WalletSummary {
  provider: string;
  mock: boolean;
  chargesEnabled: boolean;
  methods: PaymentMethod[];
}

interface AccountsSummary {
  oauth: OAuthStatus[];
  vault: { secretCount: number };
  wallet: { provider: string; mock: boolean; chargesEnabled: boolean; methodCount: number };
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="card">
      <h2>{title}</h2>
      {hint && <p className="small muted">{hint}</p>}
      {children}
    </div>
  );
}

function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p className="small" style={{ color: 'var(--danger, #c0392b)' }}>
      {error}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Connected accounts
// ---------------------------------------------------------------------------

function ConnectedAccounts() {
  const [statuses, setStatuses] = useState<OAuthStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState('');

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const summary = await api<AccountsSummary>('GET', '/api/accounts/summary');
      setStatuses(summary.oauth ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const connect = (id: string) => {
    window.location.assign(`${base()}/api/oauth/${id}/start`);
  };

  const disconnect = async (id: string) => {
    setBusy(id);
    try {
      await api('DELETE', `/api/oauth/${id}`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  return (
    <Section title="Connected accounts" hint="OAuth connections (tokens stay encrypted server-side and are never shown).">
      <ErrorLine error={error} />
      {statuses.map((s) => (
        <div key={s.id} className="row-between" style={{ padding: '8px 0' }}>
          <div>
            <strong>{s.name}</strong>{' '}
            <span className={`chip ${s.connected ? 'green' : 'gray'}`}>
              {s.connected ? 'connected' : 'not connected'}
            </span>
            {s.connected && s.hasRefreshToken && <span className="chip green">auto-refresh</span>}
          </div>
          {s.connected ? (
            <button className="btn btn-sm" disabled={busy === s.id} onClick={() => void disconnect(s.id)}>
              Disconnect
            </button>
          ) : (
            <button className="btn btn-sm btn-primary" onClick={() => connect(s.id)}>
              Connect
            </button>
          )}
        </div>
      ))}
      {statuses.length === 0 && <p className="small muted">Loading…</p>}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Composio connector (Workstream E)
// ---------------------------------------------------------------------------

interface ComposioAppEntry {
  appId: string;
  name: string;
  description?: string;
  logo?: string;
  enabled?: boolean;
}

interface ComposioStatus {
  connected: boolean;
}

interface ComposioAppsResponse {
  connected: boolean;
  apps: ComposioAppEntry[];
  error?: string;
}

interface WebBot {
  id: string;
  name: string;
}

async function fetchBots(): Promise<WebBot[]> {
  const res = await authedFetch('/api/bots');
  if (!res.ok) throw new Error(`Failed to load bots (${res.status})`);
  return (await res.json()) as WebBot[];
}

function ComposioPanel() {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [apps, setApps] = useState<ComposioAppEntry[]>([]);
  const [bots, setBots] = useState<WebBot[]>([]);
  const [botId, setBotId] = useState('');
  const [filter, setFilter] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [loaded, setLoaded] = useState(false);

  const refreshStatus = useCallback(async () => {
    const status = await api<ComposioStatus>('GET', '/api/composio/status');
    setConnected(status.connected);
    return status.connected;
  }, []);

  const refreshApps = useCallback(
    async (forBotId: string) => {
      if (!forBotId) {
        setApps([]);
        return;
      }
      const data = await api<ComposioAppsResponse>(
        'GET',
        `/api/composio/apps?botId=${encodeURIComponent(forBotId)}`,
      );
      if (data.error) throw new Error(data.error);
      setApps(data.apps ?? []);
    },
    [],
  );

  const boot = useCallback(async () => {
    setError(null);
    try {
      const [isConnected, botList] = await Promise.all([refreshStatus(), fetchBots()]);
      setBots(botList);
      const nextBotId = botId || botList[0]?.id || '';
      setBotId(nextBotId);
      setLoaded(true);
      if (isConnected && nextBotId) await refreshApps(nextBotId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshStatus, refreshApps]);

  useEffect(() => {
    void boot();
  }, [boot]);

  const changeBot = async (next: string) => {
    setBotId(next);
    setError(null);
    try {
      await refreshApps(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const connect = async () => {
    const key = apiKey.trim();
    if (!key) {
      setError('Paste your Composio API key first.');
      return;
    }
    setBusy('connect');
    setError(null);
    setNotice('');
    try {
      await api('POST', '/api/composio/connect', { apiKey: key });
      setApiKey('');
      setNotice('Composio connected. The key is stored encrypted server-side.');
      const isConnected = await refreshStatus();
      if (isConnected && botId) await refreshApps(botId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const disconnect = async () => {
    setBusy('disconnect');
    setError(null);
    setNotice('');
    try {
      await api('DELETE', '/api/composio/connect');
      setConnected(false);
      setApps([]);
      setNotice('Composio disconnected — the API key was deleted.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const toggle = async (appId: string, enabled: boolean) => {
    if (!botId) return;
    setBusy(appId);
    setError(null);
    try {
      await api('POST', `/api/composio/apps/${encodeURIComponent(appId)}`, { botId, enabled });
      setApps((prev) => prev.map((a) => (a.appId === appId ? { ...a, enabled } : a)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const q = filter.trim().toLowerCase();
  const shown = q
    ? apps.filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          a.appId.toLowerCase().includes(q) ||
          (a.description ?? '').toLowerCase().includes(q),
      )
    : apps;

  return (
    <Section
      title="Composio"
      hint="Let bots act inside 1,000+ external apps (Gmail, Slack, GitHub, …) through one Composio API key. App access is enabled per bot."
    >
      <ErrorLine error={error} />
      {notice && (
        <div className="card" style={{ borderColor: '#bbf7d0', background: '#f0fdf4' }}>
          {notice}
        </div>
      )}
      {!loaded && <p className="small muted">Loading…</p>}
      {loaded && connected === false && (
        <div>
          <div
            className="card"
            style={{ borderStyle: 'dashed', textAlign: 'center', padding: 24 }}
          >
            <p style={{ fontSize: 32, margin: '0 0 8px' }} aria-hidden="true">
              🔌
            </p>
            <p>
              <strong>Composio is not connected.</strong>
            </p>
            <p className="small muted">
              Connect a Composio API key to give your bots access to 1,000+ external
              apps. The key is stored in the encrypted vault and is never shown
              again.
            </p>
            <p className="small">
              <a href="https://dashboard.composio.dev" target="_blank" rel="noreferrer">
                Get a free API key
              </a>{' '}
              <span className="muted">(dashboard.composio.dev → Settings → API Keys, PLATFORM mode)</span>
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <input
              className="input mono"
              type="password"
              autoComplete="off"
              placeholder="paste Composio API key (ak_…)"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              style={{ flex: 1 }}
            />
            <button
              className="btn btn-primary"
              disabled={busy === 'connect' || !apiKey.trim()}
              onClick={() => void connect()}
            >
              {busy === 'connect' ? 'Connecting…' : 'Connect'}
            </button>
          </div>
        </div>
      )}
      {loaded && connected === true && (
        <div>
          <div className="row-between">
            <div>
              <span className="chip green">connected</span>{' '}
              <span className="small muted">key stored in the vault (never shown)</span>
            </div>
            <button
              className="btn btn-sm btn-danger"
              disabled={busy === 'disconnect'}
              onClick={() => void disconnect()}
            >
              {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
            </button>
          </div>
          <div className="row-between" style={{ marginTop: 12, gap: 8, flexWrap: 'wrap' }}>
            <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <strong>Bot</strong>
              <select
                className="input"
                value={botId}
                onChange={(e) => void changeBot(e.target.value)}
                disabled={bots.length === 0}
              >
                {bots.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
            <input
              className="input"
              placeholder="filter apps…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              style={{ maxWidth: 220 }}
            />
          </div>
          {bots.length === 0 && <p className="small muted">No bots yet — create one on the Bots page.</p>}
          {bots.length > 0 && shown.length === 0 && (
            <p className="small muted" style={{ marginTop: 8 }}>
              {apps.length === 0 ? 'No apps returned by Composio.' : 'No apps match the filter.'}
            </p>
          )}
          <div style={{ marginTop: 8 }}>
            {shown.map((a) => (
              <div key={a.appId} className="row-between" style={{ padding: '8px 0' }}>
                <div>
                  <strong>{a.name}</strong>{' '}
                  <span className={`chip ${a.enabled ? 'green' : 'gray'}`}>
                    {a.enabled ? 'enabled' : 'off'}
                  </span>
                  {a.description && <div className="small muted">{a.description}</div>}
                </div>
                <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={a.enabled ?? false}
                    disabled={busy === a.appId}
                    onChange={(e) => void toggle(a.appId, e.target.checked)}
                    aria-label={`Enable ${a.name} for this bot`}
                  />
                  Enable
                </label>
              </div>
            ))}
          </div>
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Composio connected accounts (OpenMausBot parity): OAuth connect links,
// account list with labels, per-account tool browser, disconnect.
// ---------------------------------------------------------------------------

interface ComposioAccount {
  id: string;
  toolkitSlug: string;
  toolkitName?: string;
  status: string;
  label?: string;
  connectedAt?: string;
}

interface ComposioPendingLink {
  toolkitSlug: string;
  label?: string;
  requestedAt: number;
}

interface ComposioAccountsResponse {
  connected: boolean;
  accounts: ComposioAccount[];
  pending: ComposioPendingLink[];
  error?: string;
}

interface ComposioAccountTool {
  slug: string;
  name: string;
  description?: string;
}

function ComposioAccountsPanel() {
  const [accounts, setAccounts] = useState<ComposioAccount[]>([]);
  const [pending, setPending] = useState<ComposioPendingLink[]>([]);
  const [catalog, setCatalog] = useState<ComposioAppEntry[]>([]);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [toolkitSlug, setToolkitSlug] = useState('');
  const [label, setLabel] = useState('');
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [waitingSlug, setWaitingSlug] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, ComposioAccountTool[]>>({});
  const [editingLabel, setEditingLabel] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');

  const refresh = useCallback(async () => {
    const data = await api<ComposioAccountsResponse>('GET', '/api/composio/accounts');
    if (data.error) throw new Error(data.error);
    setConnected(data.connected);
    setAccounts(data.accounts ?? []);
    setPending(data.pending ?? []);
    return data;
  }, []);

  const boot = useCallback(async () => {
    setError(null);
    try {
      const [data, appsData] = await Promise.all([
        refresh(),
        api<ComposioAppsResponse>('GET', '/api/composio/apps'),
      ]);
      setCatalog(appsData.apps ?? []);
      if (data.connected && appsData.apps?.length && !toolkitSlug) {
        setToolkitSlug(appsData.apps[0].appId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh]);

  useEffect(() => {
    void boot();
  }, [boot]);

  // While a connect flow is in flight, poll until the pending entry is
  // consumed (the account appeared) or it expires.
  useEffect(() => {
    if (!waitingSlug) return;
    let cancelled = false;
    const before = new Set(accounts.map((a) => a.id));
    const timer = setInterval(() => {
      void (async () => {
        try {
          const data = await refresh();
          if (cancelled) return;
          const stillWaiting = data.pending.some((p) => p.toolkitSlug === waitingSlug);
          const appeared = data.accounts.some((a) => !before.has(a.id));
          if (!stillWaiting || appeared) {
            setWaitingSlug(null);
            setAuthUrl(null);
            setNotice(
              appeared
                ? 'Account connected — enable its app per bot in the Composio section above.'
                : 'The pending connection finished. Refresh the list if the account is missing.',
            );
          }
        } catch {
          // Poll failures are non-fatal; the next tick retries.
        }
      })();
    }, 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingSlug, refresh]);

  const startLink = async () => {
    if (!toolkitSlug) return;
    setBusy('link');
    setError(null);
    setNotice('');
    try {
      const data = await api<{ redirectUrl: string }>('POST', '/api/composio/accounts/link', {
        toolkitSlug,
        label: label.trim() || undefined,
      });
      setAuthUrl(data.redirectUrl);
      setWaitingSlug(toolkitSlug);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const cancelWait = () => {
    setWaitingSlug(null);
    setAuthUrl(null);
  };

  const saveLabel = async (id: string) => {
    const next = (editingLabel[id] ?? '').trim();
    if (!next) return;
    setBusy(id);
    setError(null);
    try {
      await api('POST', `/api/composio/accounts/${encodeURIComponent(id)}/label`, { label: next });
      setEditingLabel((prev) => {
        const copy = { ...prev };
        delete copy[id];
        return copy;
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const toggleTools = async (id: string) => {
    if (expanded[id]) {
      setExpanded((prev) => {
        const copy = { ...prev };
        delete copy[id];
        return copy;
      });
      return;
    }
    setBusy(id);
    setError(null);
    try {
      const data = await api<{ tools: ComposioAccountTool[] }>(
        'GET',
        `/api/composio/accounts/${encodeURIComponent(id)}/tools`,
      );
      setExpanded((prev) => ({ ...prev, [id]: data.tools ?? [] }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const disconnect = async (id: string) => {
    if (!window.confirm('Disconnect this account? The provider grant is revoked.')) return;
    setBusy(id);
    setError(null);
    try {
      await api('DELETE', `/api/composio/accounts/${encodeURIComponent(id)}`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  return (
    <Section
      title="Connected app accounts"
      hint="OAuth connections bots act through (Gmail, Slack, GitHub, …). Tokens stay at Composio and are never shown."
    >
      <ErrorLine error={error} />
      {notice && (
        <div className="card" style={{ borderColor: '#bbf7d0', background: '#f0fdf4' }}>
          {notice}
        </div>
      )}
      {connected === false && (
        <p className="small muted">Connect a Composio API key in the Composio section above first.</p>
      )}
      {connected === true && (
        <div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end', marginBottom: 12 }}>
            <label className="small" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <strong>App</strong>
              <select
                className="input"
                value={toolkitSlug}
                onChange={(e) => setToolkitSlug(e.target.value)}
                disabled={catalog.length === 0 || waitingSlug !== null}
              >
                {catalog.map((a) => (
                  <option key={a.appId} value={a.appId}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="small" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <strong>Label (optional)</strong>
              <input
                className="input"
                placeholder='e.g. "work Gmail"'
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                disabled={waitingSlug !== null}
                style={{ minWidth: 160 }}
              />
            </label>
            <button
              className="btn btn-primary"
              disabled={busy === 'link' || !toolkitSlug || waitingSlug !== null}
              onClick={() => void startLink()}
            >
              {busy === 'link' ? 'Creating link…' : 'Connect account'}
            </button>
          </div>

          {authUrl && waitingSlug && (
            <div className="card" style={{ borderStyle: 'dashed', marginBottom: 12 }}>
              <p>
                <strong>Waiting for connection…</strong>
              </p>
              <p className="small muted">
                Open the sign-in page, authorize at the provider, then come back — this list
                refreshes automatically.
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <a className="btn btn-primary btn-sm" href={authUrl} target="_blank" rel="noreferrer">
                  Open sign-in page
                </a>
                <button className="btn btn-sm" onClick={cancelWait}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {accounts.length === 0 && !waitingSlug && (
            <p className="small muted">No connected accounts yet.</p>
          )}
          {accounts.map((a) => (
            <div key={a.id} className="card" style={{ marginBottom: 8, padding: 12 }}>
              <div className="row-between">
                <div>
                  <strong>{a.label || a.toolkitName || a.toolkitSlug}</strong>{' '}
                  <span className={`chip ${a.status === 'ACTIVE' ? 'green' : 'amber'}`}>{a.status}</span>
                  {a.label && <span className="small muted"> · {a.toolkitName || a.toolkitSlug}</span>}
                  <div className="small muted mono">{a.id}</div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-sm" disabled={busy === a.id} onClick={() => void toggleTools(a.id)}>
                    {expanded[a.id] ? 'Hide tools' : 'Browse tools'}
                  </button>
                  <button className="btn btn-sm btn-danger" disabled={busy === a.id} onClick={() => void disconnect(a.id)}>
                    Disconnect
                  </button>
                </div>
              </div>
              <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
                {editingLabel[a.id] !== undefined ? (
                  <>
                    <input
                      className="input"
                      value={editingLabel[a.id]}
                      onChange={(e) =>
                        setEditingLabel((prev) => ({ ...prev, [a.id]: e.target.value }))
                      }
                      placeholder="account label"
                      style={{ maxWidth: 220 }}
                    />
                    <button className="btn btn-sm btn-primary" disabled={busy === a.id} onClick={() => void saveLabel(a.id)}>
                      Save
                    </button>
                    <button
                      className="btn btn-sm"
                      onClick={() =>
                        setEditingLabel((prev) => {
                          const copy = { ...prev };
                          delete copy[a.id];
                          return copy;
                        })
                      }
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    className="btn btn-sm"
                    onClick={() => setEditingLabel((prev) => ({ ...prev, [a.id]: a.label ?? '' }))}
                  >
                    {a.label ? 'Rename' : 'Add label'}
                  </button>
                )}
              </div>
              {expanded[a.id] && (
                <div style={{ marginTop: 8 }}>
                  {expanded[a.id].length === 0 && <p className="small muted">No actions found.</p>}
                  {expanded[a.id].map((t) => (
                    <div key={t.slug} style={{ padding: '6px 0', borderTop: '1px solid var(--border, #eee)' }}>
                      <code className="small">{t.slug}</code>
                      <div className="small">
                        <strong>{t.name}</strong>
                      </div>
                      {t.description && <div className="small muted">{t.description}</div>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------

function VaultPanel() {
  const [secrets, setSecrets] = useState<SecretMeta[]>([]);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [description, setDescription] = useState('');
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState('');

  const refresh = useCallback(async () => {
    try {
      setError(null);
      // Login-kind records live in the Saved logins panel, not here —
      // their values are {site,username,password} JSON and must never be
      // revealed as plain secrets.
      const all = (await api<SecretMeta[]>('GET', '/api/vault')) ?? [];
      setSecrets(all.filter((s) => s.kind !== 'login'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const add = async () => {
    setBusy('add');
    try {
      await api('POST', '/api/vault', { name, value, description: description || undefined });
      setName('');
      setValue('');
      setDescription('');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const reveal = async (secretName: string) => {
    if (!window.confirm(`Reveal the value of "${secretName}"? It will be visible on screen.`)) return;
    setBusy(secretName);
    try {
      const secret = await api<Secret>('GET', `/api/vault/${encodeURIComponent(secretName)}`);
      setRevealed((prev) => ({ ...prev, [secretName]: secret.value }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const hide = (secretName: string) => {
    setRevealed((prev) => {
      const next = { ...prev };
      delete next[secretName];
      return next;
    });
  };

  const remove = async (secretName: string) => {
    if (!window.confirm(`Delete secret "${secretName}"?`)) return;
    setBusy(secretName);
    try {
      await api('DELETE', `/api/vault/${encodeURIComponent(secretName)}`);
      hide(secretName);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  return (
    <Section
      title="Secret vault"
      hint="AES-256-GCM encrypted at rest. Names are listed; values are fetched one at a time and never logged."
    >
      <ErrorLine error={error} />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <input
          className="input"
          placeholder="name (e.g. openai-key)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className="input"
          type="password"
          placeholder="secret value"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <input
          className="input"
          placeholder="description (optional)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <button className="btn btn-primary" disabled={busy === 'add' || !name || !value} onClick={() => void add()}>
          Add secret
        </button>
      </div>
      {secrets.map((s) => (
        <div key={s.name} className="row-between" style={{ padding: '8px 0' }}>
          <div>
            <strong>{s.name}</strong>
            {s.description && <span className="small muted"> — {s.description}</span>}
            {revealed[s.name] !== undefined && (
              <code style={{ marginLeft: 8, wordBreak: 'break-all' }}>{revealed[s.name]}</code>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {revealed[s.name] === undefined ? (
              <button className="btn btn-sm" disabled={busy === s.name} onClick={() => void reveal(s.name)}>
                Reveal
              </button>
            ) : (
              <button className="btn btn-sm" onClick={() => hide(s.name)}>
                Hide
              </button>
            )}
            <button className="btn btn-sm btn-danger" disabled={busy === s.name} onClick={() => void remove(s.name)}>
              Delete
            </button>
          </div>
        </div>
      ))}
      {secrets.length === 0 && <p className="small muted">No secrets stored.</p>}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Saved logins (for the type_login tool)
// ---------------------------------------------------------------------------

function LoginsPanel() {
  const [logins, setLogins] = useState<LoginMeta[]>([]);
  const [name, setName] = useState('');
  const [site, setSite] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState('');

  const refresh = useCallback(async () => {
    try {
      setError(null);
      setLogins((await api<LoginMeta[]>('GET', '/api/vault/logins')) ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const add = async () => {
    setBusy('add');
    try {
      await api('POST', '/api/vault/logins', { name, site, username, password });
      setName('');
      setSite('');
      setUsername('');
      setPassword('');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const remove = async (loginName: string) => {
    if (!window.confirm(`Delete login "${loginName}"?`)) return;
    setBusy(loginName);
    try {
      await api('DELETE', `/api/vault/${encodeURIComponent(loginName)}`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  return (
    <Section
      title="Saved logins"
      hint="Site logins for the type_login tool. Passwords are encrypted at rest and never displayed — bots type them without ever seeing the value."
    >
      <ErrorLine error={error} />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <input
          className="input"
          placeholder="name (e.g. github-personal)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className="input"
          placeholder="site (e.g. github.com)"
          value={site}
          onChange={(e) => setSite(e.target.value)}
        />
        <input
          className="input"
          placeholder="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <input
          className="input"
          type="password"
          placeholder="password (never shown again)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button
          className="btn btn-primary"
          disabled={busy === 'add' || !name || !site || !username || !password}
          onClick={() => void add()}
        >
          Add login
        </button>
      </div>
      {logins.map((l) => (
        <div key={l.name} className="row-between" style={{ padding: '8px 0' }}>
          <div>
            <strong>{l.name}</strong>
            <span className="small muted"> — {l.site} · {l.username} · password ••••</span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-sm btn-danger" disabled={busy === l.name} onClick={() => void remove(l.name)}>
              Delete
            </button>
          </div>
        </div>
      ))}
      {logins.length === 0 && <p className="small muted">No logins saved.</p>}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Wallet (mock only)
// ---------------------------------------------------------------------------

function WalletPanel() {
  const [wallet, setWallet] = useState<WalletSummary | null>(null);
  const [cardNumber, setCardNumber] = useState('');
  const [expMonth, setExpMonth] = useState('');
  const [expYear, setExpYear] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState('');

  const refresh = useCallback(async () => {
    try {
      setError(null);
      setWallet(await api<WalletSummary>('GET', '/api/wallet'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const add = async () => {
    setBusy('add');
    try {
      await api('POST', '/api/wallet/methods', {
        cardNumber,
        expMonth: Number(expMonth),
        expYear: Number(expYear),
      });
      setCardNumber('');
      setExpMonth('');
      setExpYear('');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const remove = async (id: string) => {
    setBusy(id);
    try {
      await api('DELETE', `/api/wallet/methods/${encodeURIComponent(id)}`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  return (
    <Section
      title="Wallet"
      hint="MOCK wallet — payment methods store only brand + last 4 digits, and charging is disabled. No real money moves."
    >
      <ErrorLine error={error} />
      <p>
        <span className="chip amber">mock only</span>{' '}
        <span className="small muted">charges disabled</span>
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <input
          className="input"
          inputMode="numeric"
          placeholder="card number (mock)"
          value={cardNumber}
          onChange={(e) => setCardNumber(e.target.value)}
        />
        <input
          className="input"
          inputMode="numeric"
          placeholder="MM"
          value={expMonth}
          onChange={(e) => setExpMonth(e.target.value)}
          style={{ width: 64 }}
        />
        <input
          className="input"
          inputMode="numeric"
          placeholder="YYYY"
          value={expYear}
          onChange={(e) => setExpYear(e.target.value)}
          style={{ width: 80 }}
        />
        <button
          className="btn btn-primary"
          disabled={busy === 'add' || !cardNumber || !expMonth || !expYear}
          onClick={() => void add()}
        >
          Add method
        </button>
      </div>
      {(wallet?.methods ?? []).map((m) => (
        <div key={m.id} className="row-between" style={{ padding: '8px 0' }}>
          <div>
            <strong>{m.brand}</strong> <span className="small muted">•••• {m.last4}</span>{' '}
            <span className="small muted">
              {String(m.expMonth).padStart(2, '0')}/{m.expYear}
            </span>
          </div>
          <button className="btn btn-sm btn-danger" disabled={busy === m.id} onClick={() => void remove(m.id)}>
            Remove
          </button>
        </div>
      ))}
      {(wallet?.methods ?? []).length === 0 && <p className="small muted">No payment methods.</p>}
    </Section>
  );
}

export default function AccountsPage() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <h1>Accounts</h1>
      <ConnectedAccounts />
      <ComposioPanel />
      <ComposioAccountsPanel />
      <VaultPanel />
      <LoginsPanel />
      <WalletPanel />
    </div>
  );
}
