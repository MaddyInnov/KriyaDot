// SPDX-License-Identifier: Apache-2.0
// ConnectedAppsHub (W4): the Connected Apps directory. Fetches the
// GET /api/connected-apps aggregate + bots on mount, shows ONE platform
// setup card when Composio is not configured, and renders Featured /
// Connected / per-category / On-this-computer sections of app cards whose
// primary action is honest about each entry's state (no fake connect for
// apps missing from the user's Composio workspace; local apps report their
// real detection state). Deep link: ?app=<slug> auto-opens that app's
// panel and scrolls to it (chat connection cards link here).

'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  FILTER_CHIPS,
  composioSlugFor,
  connectComposioPlatform,
  deleteComposioAccount,
  fetchConnectedApps,
  fetchMcpServers,
  fetchWebBots,
  filterApps,
  groupApps,
  isLocalApp,
  mergeMcpServers,
  setComposioAccountLabel,
  setComposioAppEnabledForBot,
  statusLabel,
  statusTone,
  storeChatPrefill,
  type AppFilter,
  type ConnectedAppEntry,
  type WebBot,
} from '../../lib/connected-apps';
import { ConnectFlow } from './connect-flow';
import { StartersSection } from './starters-section';
import './connected-apps.css';

function tryIt(router: { push: (href: string) => void }, prompt: string) {
  storeChatPrefill(prompt);
  router.push('/');
}

function manageHref(app: ConnectedAppEntry): string {
  if (app.source === 'mcp') return '/marketplace';
  if (app.source === 'phone' || app.category === 'messaging') return '/messaging';
  return '/accounts';
}

export function ConnectedAppsHub() {
  const router = useRouter();
  const [platformConfigured, setPlatformConfigured] = useState<boolean | null>(null);
  const [apps, setApps] = useState<ConnectedAppEntry[]>([]);
  const [bots, setBots] = useState<WebBot[]>([]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<AppFilter>('all');
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [highlightApp, setHighlightApp] = useState<string | null>(null);
  const [labelDrafts, setLabelDrafts] = useState<Record<string, string>>({});
  const keyInputRef = useRef<HTMLInputElement | null>(null);
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const deepLinkHandled = useRef(false);

  const refresh = useCallback(async () => {
    const [aggregate, botList] = await Promise.all([fetchConnectedApps(), fetchWebBots()]);
    let merged = aggregate.apps ?? [];
    // Merge MCP servers client-side only when the aggregate lacks them.
    if (!merged.some((a) => a.source === 'mcp')) {
      const servers = await fetchMcpServers().catch(() => [] as unknown[]);
      merged = mergeMcpServers(merged, servers);
    }
    setPlatformConfigured(Boolean(aggregate.platform?.configured));
    setApps(merged);
    setBots(botList);
    return merged;
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        setError(null);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [refresh]);

  // Deep link ?app=<slug>: open that app's panel and scroll to it.
  useEffect(() => {
    if (deepLinkHandled.current || apps.length === 0) return;
    let wanted: string | null = null;
    try {
      wanted = new URLSearchParams(window.location.search).get('app');
    } catch {
      wanted = null;
    }
    if (!wanted) {
      deepLinkHandled.current = true;
      return;
    }
    const match = apps.find(
      (a) => a.id === wanted || a.composioSlug === wanted || composioSlugFor(a) === wanted,
    );
    if (match) {
      deepLinkHandled.current = true;
      if (match.source === 'composio' && match.status === 'available') {
        setConnectingId(match.id);
      } else {
        setExpandedId(match.id);
      }
      requestAnimationFrame(() => {
        cardRefs.current[match.id]?.scrollIntoView?.({ block: 'start' });
      });
    }
  }, [apps]);

  const connectPlatform = async () => {
    const key = apiKey.trim();
    if (!key) {
      setError('Paste your Composio API key first.');
      return;
    }
    setBusy('platform');
    setError(null);
    setNotice('');
    try {
      await connectComposioPlatform(key);
      setApiKey('');
      setNotice('App platform connected — the directory below is live.');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const focusSetup = () => {
    keyInputRef.current?.scrollIntoView?.({ block: 'center' });
    keyInputRef.current?.focus();
  };

  const scrollToStarters = useCallback((slug: string) => {
    setHighlightApp(slug);
    document.getElementById('ca-starters')?.scrollIntoView?.({ block: 'start' });
  }, []);

  const toggleBot = async (app: ConnectedAppEntry, botId: string, enabled: boolean) => {
    setBusy(`${app.id}:${botId}`);
    setError(null);
    try {
      await setComposioAppEnabledForBot(composioSlugFor(app), botId, enabled);
      setApps((prev) =>
        prev.map((a) =>
          a.id === app.id
            ? {
                ...a,
                enabledBotIds: enabled
                  ? [...new Set([...(a.enabledBotIds ?? []), botId])]
                  : (a.enabledBotIds ?? []).filter((id) => id !== botId),
              }
            : a,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const saveLabel = async (app: ConnectedAppEntry, accountId: string) => {
    const next = (labelDrafts[accountId] ?? '').trim();
    if (!next) return;
    setBusy(accountId);
    setError(null);
    try {
      await setComposioAccountLabel(accountId, next);
      setApps((prev) =>
        prev.map((a) =>
          a.id === app.id
            ? {
                ...a,
                accounts: (a.accounts ?? []).map((acc) =>
                  acc.id === accountId ? { ...acc, label: next } : acc,
                ),
              }
            : a,
        ),
      );
      setLabelDrafts((prev) => {
        const copy = { ...prev };
        delete copy[accountId];
        return copy;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const disconnectAccount = async (accountId: string) => {
    if (typeof window !== 'undefined' && !window.confirm('Disconnect this account?')) return;
    setBusy(accountId);
    setError(null);
    try {
      await deleteComposioAccount(accountId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const filtered = useMemo(
    () => filterApps(apps, { query, category: filter }),
    [apps, query, filter],
  );

  // Sections in display order, de-duplicated so a card renders once.
  const sections = useMemo(() => {
    const grouped = groupApps(filtered);
    const seen = new Set<string>();
    const take = (list: ConnectedAppEntry[]) => {
      const out = list.filter((a) => !seen.has(a.id));
      out.forEach((a) => seen.add(a.id));
      return out;
    };
    const out: Array<{ title: string; apps: ConnectedAppEntry[] }> = [];
    const featured = take(grouped.featured);
    if (featured.length) out.push({ title: 'Featured', apps: featured });
    const connected = take(grouped.connected);
    if (connected.length) out.push({ title: 'Connected', apps: connected });
    for (const group of grouped.byCategory) {
      if (group.category === 'local') continue;
      const groupAppsList = take(group.apps);
      if (groupAppsList.length) out.push({ title: group.label, apps: groupAppsList });
    }
    const local = take(grouped.local);
    if (local.length) out.push({ title: 'On this computer', apps: local });
    return out;
  }, [filtered]);

  const renderManagePanel = (app: ConnectedAppEntry) => (
    <div className="ca-manage">
      {(app.accounts ?? []).length > 0 && (
        <div>
          <strong className="small">Accounts</strong>
          {(app.accounts ?? []).map((account) => (
            <div key={account.id} className="row-between" style={{ padding: '6px 0', flexWrap: 'wrap', gap: 6 }}>
              <span className="small">
                {account.label || account.id}{' '}
                <span className={`chip ${account.status === 'ACTIVE' || account.status === 'connected' ? 'green' : 'gray'}`}>
                  {account.status}
                </span>
              </span>
              <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                {labelDrafts[account.id] !== undefined ? (
                  <>
                    <input
                      className="input"
                      aria-label={`Label for account ${account.id}`}
                      value={labelDrafts[account.id]}
                      onChange={(e) =>
                        setLabelDrafts((prev) => ({ ...prev, [account.id]: e.target.value }))
                      }
                      style={{ maxWidth: 160 }}
                    />
                    <button
                      className="btn btn-sm btn-primary"
                      disabled={busy === account.id}
                      onClick={() => void saveLabel(app, account.id)}
                    >
                      Save label
                    </button>
                  </>
                ) : (
                  <button
                    className="btn btn-sm"
                    onClick={() =>
                      setLabelDrafts((prev) => ({ ...prev, [account.id]: account.label ?? '' }))
                    }
                  >
                    {account.label ? 'Rename' : 'Add label'}
                  </button>
                )}
                <button
                  className="btn btn-sm btn-danger"
                  disabled={busy === account.id}
                  onClick={() => void disconnectAccount(account.id)}
                >
                  Disconnect
                </button>
              </span>
            </div>
          ))}
        </div>
      )}

      {app.source === 'composio' && (
        <div>
          <strong className="small">Bots that may use {app.name}</strong>
          {bots.length === 0 && <p className="small muted">No bots yet.</p>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
            {bots.map((bot) => (
              <label key={bot.id} className="small" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  aria-label={`Enable ${app.name} for ${bot.name}`}
                  checked={(app.enabledBotIds ?? []).includes(bot.id)}
                  disabled={busy === `${app.id}:${bot.id}`}
                  onChange={(e) => void toggleBot(app, bot.id, e.target.checked)}
                />
                {bot.name}
              </label>
            ))}
          </div>
        </div>
      )}

      {(app.starterTasks ?? []).length > 0 && (
        <div>
          <strong className="small">Try it</strong>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
            {(app.starterTasks ?? []).map((task) => (
              <button
                key={task.label}
                className="btn btn-sm"
                onClick={() => tryIt(router, task.prompt)}
              >
                {task.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button className="btn btn-sm" onClick={() => scrollToStarters(composioSlugFor(app))}>
          Automate it
        </button>
        {app.source !== 'composio' && app.source !== 'local' && (
          <a className="btn btn-sm" href={manageHref(app)}>
            Open settings
          </a>
        )}
      </div>
    </div>
  );

  const renderCard = (app: ConnectedAppEntry) => {
    const slug = composioSlugFor(app);
    const isWhatsAppModes = Boolean(app.modes && app.modes.length > 0);
    const caps = app.capabilities ?? [];
    return (
      <div
        key={app.id}
        className="ca-card"
        data-testid={`app-card-${app.id}`}
        ref={(el) => {
          cardRefs.current[app.id] = el;
        }}
      >
        <div className="ca-card-head">
          {app.logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="ca-logo" src={app.logo} alt="" />
          ) : (
            <div className="ca-monogram" aria-hidden="true">
              {app.name.charAt(0).toUpperCase()}
            </div>
          )}
          <div style={{ minWidth: 0 }}>
            <strong>{app.name}</strong>
            <div className="small muted">{app.connectionType}</div>
          </div>
          <span className={`chip ${statusTone(app.status)}`} style={{ marginLeft: 'auto' }}>
            {statusLabel(app.status)}
          </span>
        </div>

        {app.description && (
          <p className="small muted" style={{ margin: 0 }}>
            {app.description}
          </p>
        )}

        {app.status === 'connected' && (app.accounts ?? []).length > 0 && (
          <p className="small" style={{ margin: 0 }}>
            {(app.accounts ?? []).map((a) => a.label || a.id).join(', ')}
          </p>
        )}

        {caps.length > 0 && (
          <div className="ca-caps">
            {caps.slice(0, 3).map((cap) => (
              <span key={cap} className="chip gray">
                {cap}
              </span>
            ))}
            {caps.length > 3 && <span className="chip gray">+{caps.length - 3} more</span>}
          </div>
        )}

        {isLocalApp(app) && app.local && (
          <p className="small" style={{ margin: 0 }}>
            {app.local.installed
              ? `Installed${app.local.version ? ` v${app.local.version}` : ''}${app.local.running ? ' · running now' : ''}`
              : 'Not detected on this computer'}
            {app.local.detectionNote ? (
              <span className="muted"> — {app.local.detectionNote}</span>
            ) : null}
          </p>
        )}

        {app.notes && (
          <p className="small muted" style={{ margin: 0 }}>
            {app.notes}
          </p>
        )}

        {isWhatsAppModes ? (
          <div>
            {(app.modes ?? []).map((mode) => (
              <div key={mode.id} className="ca-mode-row" data-testid={`mode-${mode.id}`}>
                <div style={{ minWidth: 0 }}>
                  <strong className="small">{mode.label}</strong>
                  <div className="small muted">{mode.detail}</div>
                </div>
                <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span className={`chip ${statusTone(mode.status)}`}>{statusLabel(mode.status)}</span>
                  {mode.status === 'connected' || mode.status === 'on_this_computer' ? (
                    <button
                      className="btn btn-sm"
                      onClick={() => setExpandedId(expandedId === app.id ? null : app.id)}
                    >
                      Manage
                    </button>
                  ) : mode.status === 'available' ? (
                    <button
                      className="btn btn-sm btn-primary"
                      onClick={() => setConnectingId(connectingId === app.id ? null : app.id)}
                    >
                      Connect
                    </button>
                  ) : mode.status === 'needs_platform_setup' ? (
                    <button className="btn btn-sm" onClick={focusSetup}>
                      Set up platform
                    </button>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 'auto' }}>
            {app.status === 'needs_platform_setup' && (
              <button className="btn btn-sm btn-primary" onClick={focusSetup}>
                Set up platform
              </button>
            )}
            {app.status === 'not_in_catalog' && (
              <button className="btn btn-sm" disabled>
                Not in your Composio workspace
              </button>
            )}
            {app.status === 'available' && app.source === 'composio' && (
              <button
                className="btn btn-sm btn-primary"
                onClick={() => setConnectingId(connectingId === app.id ? null : app.id)}
              >
                Connect
              </button>
            )}
            {(app.status === 'connected' ||
              app.status === 'on_this_computer' ||
              app.status === 'not_installed' ||
              (app.status === 'available' && app.source !== 'composio')) && (
              <button
                className="btn btn-sm"
                onClick={() => setExpandedId(expandedId === app.id ? null : app.id)}
              >
                {expandedId === app.id ? 'Close' : 'Manage'}
              </button>
            )}
            {isLocalApp(app) && app.local?.installed && (
              <button
                className="btn btn-sm btn-primary"
                onClick={() => tryIt(router, `Open ${app.name} on this computer`)}
              >
                Open {app.name}
              </button>
            )}
            {isLocalApp(app) && app.id.toLowerCase().includes('blender') && (
              <button
                className="btn btn-sm"
                onClick={() =>
                  tryIt(
                    router,
                    `Use the blender_run_script tool to run a Blender script from my workspace in ${app.name}. Ask me to name the script file if I have not already.`,
                  )
                }
              >
                Run a script…
              </button>
            )}
          </div>
        )}

        {connectingId === app.id && app.source === 'composio' && (
          <ConnectFlow
            app={app}
            bots={bots}
            onDone={() => {
              setConnectingId(null);
              void refresh().catch(() => undefined);
            }}
            onAutomate={(s) => scrollToStarters(s)}
          />
        )}
        {expandedId === app.id && renderManagePanel(app)}
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {error && (
        <p className="small" style={{ color: 'var(--red, #c0392b)' }}>
          {error}
        </p>
      )}
      {notice && <p className="small">{notice}</p>}

      {platformConfigured === false && (
        <div className="card ca-setup" id="ca-platform-setup">
          <h2 style={{ marginTop: 0 }}>Connect the app platform once</h2>
          <p className="small muted">
            One Composio key unlocks the whole app directory below — Gmail, Canva, GitHub and
            hundreds more — so you connect the platform once here, then connect each app with a
            normal sign-in. The key is stored encrypted on the server and never shown again.
          </p>
          <p className="small">
            <a href="https://dashboard.composio.dev" target="_blank" rel="noreferrer">
              Get a free API key
            </a>{' '}
            <span className="muted">(dashboard.composio.dev → Settings → API Keys)</span>
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input
              ref={keyInputRef}
              className="input mono"
              type="password"
              autoComplete="off"
              aria-label="Composio API key"
              placeholder="paste Composio API key (ak_…)"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              style={{ flex: 1, minWidth: 220 }}
            />
            <button
              className="btn btn-primary"
              disabled={busy === 'platform' || !apiKey.trim()}
              onClick={() => void connectPlatform()}
            >
              {busy === 'platform' ? 'Connecting…' : 'Connect'}
            </button>
          </div>
        </div>
      )}

      <div className="card">
        <div className="row-between" style={{ flexWrap: 'wrap', gap: 8 }}>
          <h2 style={{ margin: 0 }}>App directory</h2>
          <input
            className="input"
            aria-label="Search apps"
            placeholder="Search apps…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ maxWidth: 260 }}
          />
        </div>
        <div className="ca-chips" role="group" aria-label="Filter apps by category">
          {FILTER_CHIPS.map((chipDef) => (
            <button
              key={chipDef.id}
              className={`chip-btn${filter === chipDef.id ? ' ca-chip-active' : ''}`}
              aria-pressed={filter === chipDef.id}
              onClick={() => setFilter(chipDef.id)}
            >
              {chipDef.label}
            </button>
          ))}
        </div>

        {platformConfigured === null && apps.length === 0 && (
          <p className="small muted">Loading apps…</p>
        )}
        {apps.length > 0 && filtered.length === 0 && (
          <p className="small muted">No apps match your search or filter.</p>
        )}

        {sections.map((section) => (
          <div key={section.title}>
            <h3 style={{ marginBottom: 0 }}>{section.title}</h3>
            <div className="ca-grid">{section.apps.map(renderCard)}</div>
          </div>
        ))}
      </div>

      <div id="ca-starters-anchor">
        <StartersSection bots={bots} highlightApp={highlightApp} />
      </div>
    </div>
  );
}

export default ConnectedAppsHub;
