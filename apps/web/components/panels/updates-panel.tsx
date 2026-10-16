// SPDX-License-Identifier: Apache-2.0
'use client';

// Self-update panel (Atomic Agent parity) — Settings → Updates.
// Checks the official KriyaDot GitHub releases for newer versions.
// Download + install only happen on explicit user action; the update source
// is pinned to MaddyInnov/KriyaDot and cannot be changed.

import { useEffect, useState } from 'react';

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers || {}) } });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error || `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

type UpdateState = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'installing' | 'error';

interface ReleaseInfo {
  tag: string;
  name: string;
  body: string;
  publishedAt: string;
  prerelease: boolean;
  htmlUrl: string;
}

interface UpdateStatus {
  state: UpdateState;
  currentVersion: string;
  latest: ReleaseInfo | null;
  asset: { name: string; size: number } | null;
  downloadedBytes: number;
  totalBytes: number;
  progress: number;
  lastCheckedAt: number | null;
  lastError: string | null;
  previousInstaller: string | null;
  platform: string;
  arch: string;
}

interface UpdateSettings {
  autoCheck: boolean;
  checkIntervalHours: number;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtTime(ts: number | null): string {
  if (!ts) return 'never';
  return new Date(ts).toLocaleString();
}

const STATE_LABEL: Record<UpdateState, string> = {
  idle: 'Up to date',
  checking: 'Checking…',
  available: 'Update available',
  downloading: 'Downloading…',
  ready: 'Ready to install',
  installing: 'Installing…',
  error: 'Error',
};

export function UpdatesPanel() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [settings, setSettings] = useState<UpdateSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmInstall, setConfirmInstall] = useState(false);

  const load = async () => {
    try {
      const [s, st] = await Promise.all([
        api<{ ok: boolean; status: UpdateStatus }>('/api/updates/status'),
        api<{ ok: boolean; settings: UpdateSettings }>('/api/updates/settings'),
      ]);
      setStatus(s.status);
      setSettings(st.settings);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load update status');
    }
  };

  useEffect(() => {
    void load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);

  const run = async (label: string, path: string) => {
    setBusy(label);
    setError(null);
    try {
      const res = await api<{ ok: boolean; status: UpdateStatus }>(path, { method: 'POST' });
      setStatus(res.status);
    } catch (e) {
      setError(e instanceof Error ? e.message : `${label} failed`);
    } finally {
      setBusy(null);
    }
  };

  const saveSettings = async (next: Partial<UpdateSettings>) => {
    setError(null);
    try {
      const res = await api<{ ok: boolean; settings: UpdateSettings }>('/api/updates/settings', {
        method: 'PUT',
        body: JSON.stringify(next),
      });
      setSettings(res.settings);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to save settings');
    }
  };

  if (!status) {
    return <p className="muted small">{error ?? 'Loading update status…'}</p>;
  }

  const st = status.state;
  const showReleaseNotes = status.latest && (st === 'available' || st === 'downloading' || st === 'ready');

  return (
    <div className="updates-panel">
      <div className="row" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span className={`status-dot state-${st}`} aria-hidden="true" />
        <strong>{STATE_LABEL[st]}</strong>
        <span className="muted small">v{status.currentVersion}</span>
        {status.latest && <span className="muted small">→ {status.latest.tag}</span>}
        <span className="muted small">Last checked: {fmtTime(status.lastCheckedAt)}</span>
      </div>

      {error && <p className="error small">{error}</p>}
      {st === 'error' && status.lastError && <p className="error small">{status.lastError}</p>}

      {showReleaseNotes && status.latest && (
        <div className="release-notes">
          <h4>
            {status.latest.name}{' '}
            <a href={status.latest.htmlUrl} target="_blank" rel="noreferrer" className="muted small">
              view on GitHub
            </a>
          </h4>
          {status.asset && (
            <p className="muted small">
              Installer: {status.asset.name} ({fmtBytes(status.asset.size)}) · {status.platform}/{status.arch}
            </p>
          )}
          <pre className="release-body">{status.latest.body || 'No release notes.'}</pre>
        </div>
      )}

      {st === 'downloading' && (
        <div className="progress-wrap">
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${Math.round(status.progress * 100)}%` }} />
          </div>
          <span className="muted small">
            {fmtBytes(status.downloadedBytes)} / {fmtBytes(status.totalBytes)} ({Math.round(status.progress * 100)}%)
          </span>
        </div>
      )}

      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
        <button className="btn" disabled={!!busy || st === 'checking' || st === 'downloading' || st === 'installing'} onClick={() => run('check', '/api/updates/check')}>
          {busy === 'check' ? 'Checking…' : 'Check for updates'}
        </button>
        {st === 'available' && (
          <button className="btn btn-primary" disabled={!!busy} onClick={() => run('download', '/api/updates/download')}>
            {busy === 'download' ? 'Starting…' : 'Download update'}
          </button>
        )}
        {st === 'ready' &&
          (confirmInstall ? (
            <>
              <button className="btn btn-danger" disabled={!!busy} onClick={() => { setConfirmInstall(false); void run('install', '/api/updates/install'); }}>
                Confirm — install & restart
              </button>
              <button className="btn" onClick={() => setConfirmInstall(false)}>Cancel</button>
            </>
          ) : (
            <button className="btn btn-primary" onClick={() => setConfirmInstall(true)}>
              Install & restart
            </button>
          ))}
      </div>

      {st === 'ready' && (
        <p className="muted small" style={{ marginTop: 8 }}>
          The installer was verified (size check, plus SHA-256 when the release ships one).
          {status.platform === 'win32' || status.platform === 'darwin'
            ? ' Installing launches the installer and quits KriyaDot — the installer completes the upgrade.'
            : ' On Linux the package opens in your software handler, which guides the install.'}
        </p>
      )}

      {status.previousInstaller && (
        <p className="muted small" style={{ marginTop: 8 }}>
          Rollback is best-effort: the previous installer is kept at{' '}
          <code>{status.previousInstaller}</code> — re-run it manually if the new version misbehaves.
        </p>
      )}

      {settings && (
        <div className="row" style={{ gap: 16, flexWrap: 'wrap', marginTop: 16 }}>
          <label className="small">
            <input
              type="checkbox"
              checked={settings.autoCheck}
              onChange={(e) => saveSettings({ autoCheck: e.target.checked })}
            />{' '}
            Check automatically
          </label>
          <label className="small">
            Every{' '}
            <input
              type="number"
              min={1}
              max={720}
              value={settings.checkIntervalHours}
              onChange={(e) => saveSettings({ checkIntervalHours: Number(e.target.value) || 24 })}
              style={{ width: 64 }}
            />{' '}
            hours
          </label>
        </div>
      )}
      <p className="muted small" style={{ marginTop: 8 }}>
        Updates come only from the official <code>MaddyInnov/KriyaDot</code> GitHub releases.
        Nothing downloads or installs without your explicit action.
      </p>
    </div>
  );
}
