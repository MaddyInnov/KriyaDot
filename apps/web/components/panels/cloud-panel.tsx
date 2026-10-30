// SPDX-License-Identifier: Apache-2.0
'use client';

/**
 * Cloud panel (Lightning AI) — lives in the Workspace destination.
 * Why Workspace and not a new destination or Bots: the six top-level
 * destinations are fixed, and the cloud instance is the user's remote
 * *workspace runtime* (their KriyaDot, deployed and reachable from
 * anywhere), which sits naturally beside Files/Backup/Device control.
 *
 * Honesty rules baked in:
 *  - Free tier is "always reachable" (wake-on-traffic, ~4-hourly
 *    restarts) — never "always-on". See CLOUD_FREE_TIER_NOTE.
 *  - The Usage panel shows ONLY the facts the API returns (Studio
 *    status, machine, teamspace, disk). There is no Lightning balance
 *    API, so no credit numbers are rendered — billing deep-links out.
 *  - Upgrades render the tier descriptors the API returns and link to
 *    Lightning for current prices. No prices from local constants.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  cloudConnect,
  cloudDeploy,
  cloudDisconnect,
  cloudPlans,
  cloudStatus,
  cloudStudio,
  cloudUsage,
  isAbsent,
} from '../../lib/octomind-api';
import { CLOUD_FREE_TIER_NOTE, mapCloudStatus, type CloudStatusView } from '../../lib/octomind-web';
import { CommandResultCard } from '../chat/command-result-card';

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function fmtBytes(n: unknown): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

interface Plan { name: string; summary?: string; checkoutUrl?: string }

export function CloudPanel() {
  const [status, setStatus] = useState<CloudStatusView | null>(null);
  const [statusRaw, setStatusRaw] = useState<Record<string, unknown> | null>(null);
  const [endpointAbsent, setEndpointAbsent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  // Connect form (the API key is form state only — it goes to the vault
  // via the connect endpoint and is never rendered back).
  const [userId, setUserId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [deployResult, setDeployResult] = useState<Record<string, unknown> | null>(null);
  const [usage, setUsage] = useState<Record<string, unknown> | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [plansUrl, setPlansUrl] = useState('');

  const refresh = useCallback(async () => {
    try {
      const raw = await cloudStatus();
      setStatusRaw(raw);
      setStatus(mapCloudStatus(raw));
      setEndpointAbsent(false);
      setError('');
    } catch (err) {
      if (isAbsent(err)) {
        setEndpointAbsent(true);
        setStatus(null);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
    try {
      const raw = await cloudPlans();
      const list = Array.isArray(raw.plans) ? raw.plans : [];
      setPlans(
        list
          .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
          .map((p) => ({
            name: typeof p.name === 'string' ? p.name : String(p.id ?? 'Plan'),
            ...(typeof p.summary === 'string' ? { summary: p.summary } : {}),
            ...(typeof p.checkoutUrl === 'string' ? { checkoutUrl: p.checkoutUrl } : {}),
          })),
      );
      if (typeof raw.plansUrl === 'string') setPlansUrl(raw.plansUrl);
    } catch {
      setPlans([]);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError('');
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const connect = () =>
    run('connect', async () => {
      await cloudConnect(userId.trim(), apiKey.trim());
      setApiKey('');
    });

  const deploy = async () => {
    setBusy('deploy');
    setError('');
    setDeployResult(null);
    try {
      const res = await cloudDeploy(repoUrl.trim() ? { repoUrl: repoUrl.trim() } : {});
      setDeployResult(res);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const loadUsage = async () => {
    setBusy('usage');
    setError('');
    try {
      const raw = await cloudUsage();
      setUsage(asRecord(raw.usage) ?? raw);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const deploySteps = Array.isArray(asRecord(deployResult?.deploy)?.steps)
    ? (asRecord(deployResult?.deploy)!.steps as unknown[])
    : Array.isArray(deployResult?.steps)
      ? (deployResult!.steps as unknown[])
      : [];

  return (
    <div>
      <h3 style={{ marginTop: 0 }}>☁️ Cloud — Lightning AI Studio</h3>
      <p className="small muted">
        Run this KriyaDot on a Lightning AI Studio so it stays reachable when your machine is
        off. Connecting is one explicit step: sign in to Lightning yourself (a separate
        Lightning account — the same Google login works there), copy your user ID + API key
        from Lightning → Settings → Keys → Programmatic Login, and paste them here. The pair
        is stored only in your encrypted vault and is never shown again.
      </p>
      <div className="warn-box">{CLOUD_FREE_TIER_NOTE}</div>
      {endpointAbsent && (
        <div className="warn-box" style={{ marginTop: 8 }}>
          The cloud endpoints (/api/cloud/lightning/*) are not mounted on this API yet, so
          connect / deploy / usage are unavailable here. Nothing was sent anywhere.
        </div>
      )}
      {error && <div className="error-box" style={{ marginTop: 8 }}>{error}</div>}

      <div className="card" style={{ marginTop: 12 }}>
        <div className="row-between" style={{ flexWrap: 'wrap', gap: 8 }}>
          <strong>
            Status:{' '}
            <span className={`chip ${status?.state === 'running' ? 'green' : status?.state === 'disconnected' || !status ? 'gray' : 'amber'}`}>
              {status ? status.label : endpointAbsent ? 'unavailable' : 'loading…'}
            </span>
          </strong>
          <button type="button" className="btn btn-sm" onClick={() => void refresh()}>↻ Refresh</button>
        </div>
        {status?.reachabilityNote && <p className="small muted">{status.reachabilityNote}</p>}
        {status?.connected && (
          <p className="small">
            {status.studioName && <>Studio: <span className="mono">{status.studioName}</span>{' '}</>}
            {status.machine && <>· Machine: {status.machine}{' '}</>}
            {status.tier && <>· Tier: {status.tier}</>}
          </p>
        )}
        {status?.state === 'running' && status.publicUrl && (
          <p className="small">
            Public instance URL:{' '}
            <a href={status.publicUrl} target="_blank" rel="noreferrer">{status.publicUrl}</a>
          </p>
        )}
        {status?.state === 'running' && !status.publicUrl && (
          <p className="small muted">The Studio is running but reports no public URL yet.</p>
        )}
        {status?.connected && status.state !== 'running' && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
            <button type="button" className="btn btn-sm" disabled={busy === 'wake'} onClick={() => void run('wake', () => cloudStudio('start'))}>
              {busy === 'wake' ? 'Waking…' : 'Wake Studio'}
            </button>
            <button type="button" className="btn btn-danger btn-sm" disabled={busy === 'disconnect'} onClick={() => void run('disconnect', cloudDisconnect)}>
              Disconnect Lightning
            </button>
          </div>
        )}
        {status?.state === 'running' && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
            <button type="button" className="btn btn-sm" disabled={busy === 'stop'} onClick={() => void run('stop', () => cloudStudio('stop'))}>Stop Studio</button>
            <button type="button" className="btn btn-danger btn-sm" disabled={busy === 'disconnect'} onClick={() => void run('disconnect', cloudDisconnect)}>Disconnect Lightning</button>
          </div>
        )}
      </div>

      {status && !status.connected && !endpointAbsent && (
        <div className="card" style={{ marginTop: 12 }}>
          <strong>Connect Lightning</strong>
          <div className="grid-2" style={{ marginTop: 8 }}>
            <div className="field">
              <label className="label" htmlFor="cloud-user-id">Lightning user ID</label>
              <input id="cloud-user-id" className="input mono" value={userId} onChange={(e) => setUserId(e.target.value)} autoComplete="off" placeholder="from Lightning → Settings → Keys" />
            </div>
            <div className="field">
              <label className="label" htmlFor="cloud-api-key">Lightning API key</label>
              <input id="cloud-api-key" className="input mono" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" placeholder="paste key (stored in your vault only)" />
            </div>
          </div>
          <button type="button" className="btn btn-primary btn-sm" disabled={busy === 'connect' || !userId.trim() || !apiKey.trim()} onClick={() => void connect()}>
            {busy === 'connect' ? 'Verifying…' : 'Connect Lightning'}
          </button>
        </div>
      )}

      {status?.connected && (
        <div className="card" style={{ marginTop: 12 }}>
          <strong>Deploy to Studio</strong>
          <p className="small muted">Deploys KriyaDot into your Studio and (re)starts it there.</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input
              className="input mono"
              style={{ flex: '1 1 280px' }}
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="Repo URL (optional — server default when empty)"
              aria-label="Deploy repo URL"
            />
            <button type="button" className="btn btn-primary btn-sm" disabled={busy === 'deploy'} onClick={() => void deploy()}>
              {busy === 'deploy' ? 'Deploying…' : 'Deploy to Studio'}
            </button>
          </div>
          {busy === 'deploy' && <p className="small muted" style={{ marginTop: 8 }}><span className="spinner" /> Deploy in progress — this can take a few minutes…</p>}
          {deployResult && (
            <div style={{ marginTop: 8 }}>
              <p className="small">{deployResult.ok === false ? '⚠ Deploy reported a problem — steps:' : '✓ Deploy finished — steps:'}</p>
              {deploySteps.length > 0 ? (
                <ul className="brief-list">
                  {deploySteps.map((s, i) => {
                    const r = asRecord(s);
                    return (
                      <li key={i} className="brief-item small">
                        {r ? <>{String(r.name ?? r.step ?? `step ${i + 1}`)}: {r.ok === false ? 'failed' : 'ok'}{typeof r.detail === 'string' ? ` — ${r.detail}` : ''}</> : String(s)}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <CommandResultCard title="Deploy result" payload={deployResult} />
              )}
            </div>
          )}
        </div>
      )}

      {status?.connected && (
        <div className="card" style={{ marginTop: 12 }}>
          <div className="row-between" style={{ flexWrap: 'wrap', gap: 8 }}>
            <strong>Usage</strong>
            <button type="button" className="btn btn-sm" disabled={busy === 'usage'} onClick={() => void loadUsage()}>
              {busy === 'usage' ? 'Loading…' : 'Load usage'}
            </button>
          </div>
          <p className="small muted">
            Only the facts Lightning&apos;s API actually exposes are shown here. KriyaDot cannot
            read your Lightning credit balance — no such API exists.
          </p>
          {usage && (
            <div className="small" style={{ display: 'grid', gap: 4 }}>
              {typeof usage.studioStatus === 'string' && <div>Studio status: {usage.studioStatus}</div>}
              {typeof usage.machine === 'string' && <div>Machine: {usage.machine}</div>}
              {typeof usage.teamspace === 'string' && <div>Teamspace: {usage.teamspace}</div>}
              {usage.diskUsageBytes !== undefined && usage.diskUsageBytes !== null && <div>Disk usage: {fmtBytes(usage.diskUsageBytes)}</div>}
              {typeof usage.tier === 'string' && <div>Tier: {usage.tier}</div>}
              {typeof usage.balanceNote === 'string' && <div className="muted">{usage.balanceNote}</div>}
              {typeof usage.billingUrl === 'string' && (
                <div><a href={usage.billingUrl} target="_blank" rel="noreferrer">View billing on Lightning ↗</a></div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="card" style={{ marginTop: 12 }}>
        <strong>Upgrades</strong>
        <p className="small muted">See current plans on Lightning AI — prices change, so they are not quoted here.</p>
        {plans.length === 0 && <p className="small muted">Plan list unavailable from the API right now.</p>}
        {plans.map((p) => (
          <div key={p.name} className="row-between" style={{ gap: 8, padding: '4px 0' }}>
            <span className="small"><strong>{p.name}</strong>{p.summary ? <span className="muted"> — {p.summary}</span> : null}</span>
            {(p.checkoutUrl ?? plansUrl) && (
              <a className="btn btn-sm" href={p.checkoutUrl ?? plansUrl} target="_blank" rel="noreferrer">See current plans on Lightning AI ↗</a>
            )}
          </div>
        ))}
        {plansUrl && plans.length === 0 && (
          <a className="btn btn-sm" href={plansUrl} target="_blank" rel="noreferrer">See current plans on Lightning AI ↗</a>
        )}
      </div>
      {statusRaw && status?.connected && (
        <details style={{ marginTop: 12 }}>
          <summary className="small muted">Raw status (for debugging)</summary>
          <CommandResultCard title="Cloud status" payload={statusRaw} />
        </details>
      )}
    </div>
  );
}
