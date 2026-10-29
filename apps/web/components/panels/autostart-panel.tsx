// SPDX-License-Identifier: Apache-2.0
'use client';

// Open-at-login panel (W12d) — Settings surface. The toggle calls the API,
// which writes/removes the OS autostart entry file for the current OS
// (Linux XDG .desktop, macOS LaunchAgent plist, Windows Startup .cmd).

import React, { useEffect, useState } from 'react';
import { kriyadotFetch } from '../../lib/kriyadot-api';

interface AutostartStatus {
  enabled: boolean;
  platform: string;
  entryPath: string;
  execPath: string;
  stale: boolean;
  supported: boolean;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await kriyadotFetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers || {}) },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error || `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export function AutostartPanel() {
  const [status, setStatus] = useState<AutostartStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<{ ok: boolean; status: AutostartStatus }>('/api/autostart')
      .then((res) => {
        if (!cancelled) setStatus(res.status);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'failed to load autostart state');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ ok: boolean; status: AutostartStatus }>('/api/autostart', {
        method: 'PUT',
        body: JSON.stringify({ enabled }),
      });
      setStatus(res.status);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to update autostart');
    } finally {
      setBusy(false);
    }
  };

  if (!status) {
    return <p className="muted small">{error ?? 'Loading login setting…'}</p>;
  }

  return (
    <div className="autostart-panel">
      <label className="small">
        <input
          type="checkbox"
          checked={status.enabled}
          disabled={busy || !status.supported}
          onChange={(e) => void toggle(e.target.checked)}
        />{' '}
        Open KriyaDot at login
      </label>
      <p className="muted small" style={{ marginTop: 8 }}>
        When on, your OS starts KriyaDot automatically when you log in — KriyaDot writes a small
        autostart entry for {status.platform} at <code>{status.entryPath}</code> pointing at{' '}
        <code>{status.execPath}</code>. Turning it off removes that entry. Nothing else is changed.
      </p>
      {status.stale && (
        <p className="error small">
          An autostart entry exists but points at a different program (KriyaDot may have moved).
          Toggle off and on again to rewrite it.
        </p>
      )}
      {!status.supported && (
        <p className="error small">Open at login is not supported on this platform ({status.platform}).</p>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}
