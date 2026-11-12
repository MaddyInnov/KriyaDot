// SPDX-License-Identifier: Apache-2.0
'use client';

// Egress journal (A13) — Privacy section, next to product analytics.
// OPT-IN, OFF BY DEFAULT. When on, sandboxed run_command executions
// route through a per-run localhost proxy that journals each
// connection's host and port into Activity (Audit log, kind "egress").
//
// HONEST LABELLING (required): this is "Visible, not confined". It is a
// visibility feature, not a network confinement feature — traffic that
// bypasses the proxy is not covered, and the copy below says so.

import { useEffect, useState } from 'react';
import { kriyadotFetch } from '../../lib/kriyadot-api';

interface EgressJournalSettings {
  enabled: boolean;
}

interface EgressSettingsResponse {
  ok: boolean;
  settings: EgressJournalSettings;
  label: string;
  limits: string;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await kriyadotFetch(path, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers || {}) } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export function EgressJournalPanel() {
  const [data, setData] = useState<EgressSettingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = async () => {
    try {
      setData(await api<EgressSettingsResponse>('/api/egress-journal/settings'));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => { load(); }, []);

  const save = async (enabled: boolean) => {
    if (!data) return;
    setError(null);
    setSaved(false);
    try {
      const res = await api<EgressSettingsResponse>('/api/egress-journal/settings', {
        method: 'PUT',
        body: JSON.stringify({ enabled }),
      });
      setData(res);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (!data) {
    return <div className="muted small">Loading egress journal settings…</div>;
  }

  const enabled = data.settings.enabled;
  return (
    <div>
      {error && <div className="error">{error}</div>}
      {saved && <div className="muted small">Saved.</div>}

      <div className="privacy-row">
        <div>
          <strong>Network egress journal — {data.label}</strong>
          <p className="muted small">
            When on, sandboxed commands run through a per-run local proxy and every connection is
            journaled in Activity (Audit log) with its run, host and port, and byte counts.
            Only host and port are ever recorded — never paths, query strings, headers, or content.
            Off by default.
          </p>
          <p className="muted small">
            <strong>Not covered:</strong> {data.limits} The API server's own provider traffic is
            not journaled by this feature.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Network egress journal"
          onClick={() => save(!enabled)}
          className={`toggle ${enabled ? 'toggle-on' : ''}`}
        >
          <span className="toggle-knob" />
        </button>
      </div>
    </div>
  );
}
