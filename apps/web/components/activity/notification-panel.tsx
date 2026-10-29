// SPDX-License-Identifier: Apache-2.0
'use client';

// Notification triage settings (W14b) — Activity tab.
//
// Phone notifications are triaged server-side: muted apps batch silently,
// quiet hours batch, allow-listed apps and urgent keywords surface as
// "needs you" items with a push, and the rest accumulate into the daily
// brief's Phone notifications digest. This panel edits those persisted
// settings and shows the current needs-you inbox. Notification bodies are
// never sent to or shown by the server — titles + app names only.

import { useCallback, useEffect, useState } from 'react';
import { kriyadotFetch } from '../../lib/kriyadot-api';

interface NotificationSettings {
  mutedApps: string[];
  allowedApps: string[];
  urgentKeywords: string[];
  quietStart: string | null;
  quietEnd: string | null;
}

interface InboxItem {
  id: string;
  appPackage: string;
  appName?: string;
  title: string;
  ts: number;
  reason: string;
}

function splitList(v: string): string[] {
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

export function NotificationPanel() {
  const [settings, setSettings] = useState<NotificationSettings | null>(null);
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [muted, setMuted] = useState('');
  const [allowed, setAllowed] = useState('');
  const [keywords, setKeywords] = useState('');
  const [quietStart, setQuietStart] = useState('');
  const [quietEnd, setQuietEnd] = useState('');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [sRes, iRes] = await Promise.all([
        kriyadotFetch('/api/notifications/settings', { cache: 'no-store' }),
        kriyadotFetch('/api/notifications/inbox', { cache: 'no-store' }),
      ]);
      if (sRes.ok) {
        const json = (await sRes.json()) as { settings: NotificationSettings };
        setSettings(json.settings);
        setMuted(json.settings.mutedApps.join(', '));
        setAllowed(json.settings.allowedApps.join(', '));
        setKeywords(json.settings.urgentKeywords.join(', '));
        setQuietStart(json.settings.quietStart ?? '');
        setQuietEnd(json.settings.quietEnd ?? '');
      }
      if (iRes.ok) {
        const json = (await iRes.json()) as { items: InboxItem[] };
        setInbox(Array.isArray(json.items) ? json.items : []);
      }
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    try {
      const next: NotificationSettings = {
        mutedApps: splitList(muted),
        allowedApps: splitList(allowed),
        urgentKeywords: splitList(keywords),
        quietStart: quietStart || null,
        quietEnd: quietEnd || null,
      };
      const res = await kriyadotFetch('/api/notifications/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: next }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      const json = (await res.json()) as { settings: NotificationSettings };
      setSettings(json.settings);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (error) return <p className="small" style={{ color: 'var(--red, #b3261e)' }}>{error}</p>;
  if (!settings) return <p className="muted small">Loading notification settings…</p>;

  return (
    <div>
      <h3 className="mt0">Phone notifications</h3>
      <p className="small muted">
        Notifications from your paired phone are triaged: urgent ones surface below with a push;
        everything else is batched into the daily briefing. Only app names and titles are used —
        notification bodies never leave the phone pipeline.
      </p>
      <div className="card">
        <label className="small">
          Muted apps (package names, comma-separated — batched silently)
          <input value={muted} onChange={(e) => setMuted(e.target.value)} placeholder="com.example.social, com.example.news" style={{ display: 'block', width: '100%' }} />
        </label>
        <label className="small">
          Allowed apps (package names, comma-separated — always surface)
          <input value={allowed} onChange={(e) => setAllowed(e.target.value)} placeholder="com.example.bank" style={{ display: 'block', width: '100%' }} />
        </label>
        <label className="small">
          Extra urgent keywords (comma-separated, matched in titles)
          <input value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="appointment, flight, rent" style={{ display: 'block', width: '100%' }} />
        </label>
        <div className="small">
          Quiet hours:{' '}
          <input type="time" value={quietStart} onChange={(e) => setQuietStart(e.target.value)} aria-label="Quiet hours start" />
          {' → '}
          <input type="time" value={quietEnd} onChange={(e) => setQuietEnd(e.target.value)} aria-label="Quiet hours end" />
          <span className="muted"> (leave empty for none; everything batches during quiet hours)</span>
        </div>
        <button type="button" onClick={() => void save()} style={{ marginTop: 8 }}>
          Save settings
        </button>
        {saved && <span className="small muted" style={{ marginLeft: 8 }}>Saved.</span>}
      </div>
      <div className="card">
        <h4>Needs you — phone notifications <span className="chip">{inbox.length}</span></h4>
        {inbox.length === 0 ? (
          <p className="muted small">Nothing urgent right now.</p>
        ) : (
          <ul className="brief-list">
            {inbox.map((it) => (
              <li key={it.id} className="brief-item">
                <div className="brief-item-title">{it.title || '(notification)'}</div>
                <div className="brief-item-detail small muted">
                  {it.appName ?? it.appPackage} · {new Date(it.ts).toLocaleString()} · {it.reason}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
