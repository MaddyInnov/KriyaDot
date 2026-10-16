// SPDX-License-Identifier: Apache-2.0
'use client';

// Opt-in product analytics — Privacy section.
// Both toggles default OFF. When off, nothing is collected, queued, or sent.
// "View collected data" shows the local event queue so users can inspect
// exactly what would be sent before enabling anything.

import { useEffect, useState } from 'react';
import { kriyadotFetch } from '../../lib/kriyadot-api';

interface AnalyticsSettings {
  enabled: boolean;
  crashReporting: boolean;
  endpoint: string;
}

interface AnalyticsEvent {
  event: string;
  properties: Record<string, string | number | boolean>;
  timestamp: number;
  sessionId: string;
}

interface CrashRecord {
  message: string;
  stack: string;
  timestamp: number;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await kriyadotFetch(path, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers || {}) } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`toggle ${checked ? 'toggle-on' : ''}`}
    >
      <span className="toggle-knob" />
    </button>
  );
}

export function AnalyticsPanel() {
  const [settings, setSettings] = useState<AnalyticsSettings | null>(null);
  const [endpoint, setEndpoint] = useState('');
  const [events, setEvents] = useState<AnalyticsEvent[] | null>(null);
  const [crashes, setCrashes] = useState<CrashRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = async () => {
    try {
      const s = await api<{ ok: boolean; settings: AnalyticsSettings }>('/api/analytics/settings');
      setSettings(s.settings);
      setEndpoint(s.settings.endpoint);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => { load(); }, []);

  const save = async (patch: Partial<AnalyticsSettings>, ep?: string) => {
    if (!settings) return;
    setError(null);
    setSaved(false);
    const next = { ...settings, ...patch, endpoint: ep ?? endpoint };
    try {
      const res = await api<{ ok: boolean; settings: AnalyticsSettings }>('/api/analytics/settings', {
        method: 'PUT',
        body: JSON.stringify(next),
      });
      setSettings(res.settings);
      setEndpoint(res.settings.endpoint);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const loadEvents = async () => {
    try {
      const r = await api<{ ok: boolean; events: AnalyticsEvent[] }>('/api/analytics/events');
      setEvents(r.events);
      const c = await api<{ ok: boolean; crashes: CrashRecord[] }>('/api/analytics/crashes');
      setCrashes(c.crashes);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const clearData = async () => {
    await api('/api/analytics/events/clear', { method: 'POST' });
    await api('/api/analytics/crashes/clear', { method: 'POST' });
    setEvents([]);
    setCrashes([]);
  };

  if (!settings) {
    return <div className="muted small">Loading privacy settings…</div>;
  }

  return (
    <div>
      {error && <div className="error">{error}</div>}
      {saved && <div className="muted small">Saved.</div>}

      <div className="privacy-row">
        <div>
          <strong>Product analytics</strong>
          <p className="muted small">
            Collect feature-use counts (e.g. bot created, workflow run, voice call started).
            Never message content, prompts, file contents, or anything you typed.
            Off by default.
          </p>
        </div>
        <Toggle checked={settings.enabled} onChange={(v) => save({ enabled: v })} label="Product analytics" />
      </div>

      <div className="privacy-row">
        <div>
          <strong>Crash reporting</strong>
          <p className="muted small">
            Capture redacted error reports (stack traces with file paths and secrets stripped).
            Off by default. Independent of product analytics.
          </p>
        </div>
        <Toggle checked={settings.crashReporting} onChange={(v) => save({ crashReporting: v })} label="Crash reporting" />
      </div>

      <div className="privacy-row">
        <div>
          <strong>Analytics endpoint</strong>
          <p className="muted small">
            Optional. Leave empty to keep everything local-only (you can still inspect it below).
            Must be an https:// URL.
          </p>
        </div>
      </div>
      <div className="privacy-endpoint">
        <input
          type="url"
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
          placeholder="https://…"
          aria-label="Analytics endpoint"
        />
        <button type="button" onClick={() => save({})}>Save endpoint</button>
      </div>

      <div className="privacy-row">
        <div>
          <strong>Collected data</strong>
          <p className="muted small">
            Inspect exactly what is stored locally before enabling anything.
          </p>
        </div>
        <div className="privacy-actions">
          <button type="button" onClick={loadEvents}>View collected data</button>
          <button type="button" onClick={clearData}>Clear</button>
        </div>
      </div>

      {events !== null && (
        <div className="privacy-data">
          <h4>Events ({events.length})</h4>
          {events.length === 0 ? (
            <p className="muted small">No events collected.</p>
          ) : (
            <pre className="privacy-json">{JSON.stringify(events.slice(-20), null, 2)}</pre>
          )}
          {crashes !== null && crashes.length > 0 && (
            <>
              <h4>Crash reports ({crashes.length})</h4>
              <pre className="privacy-json">{JSON.stringify(crashes.slice(-5), null, 2)}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
