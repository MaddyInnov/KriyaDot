// SPDX-License-Identifier: Apache-2.0
// Places rail (chat polish): a slim rail in the app shell listing
// pinned panels — internal destinations and external URLs. External
// places render in a sandboxed iframe panel beside the chat. This is
// a rail, NOT a seventh top-level destination. Pins persist in
// localStorage. Pure (de)serialization is exported for tests.

'use client';

import React, { useEffect, useState } from 'react';

export interface PlacePin { id: string; label: string; href: string; external?: boolean }

export const PLACES_STORAGE_KEY = 'mvp:places-rail:v1';

/** Default pins mirror the six top-level destinations (they stay the only destinations). */
export const DEFAULT_PLACES: PlacePin[] = [
  { id: 'chat', label: 'Chat', href: '/' },
  { id: 'bots', label: 'Bots', href: '/bots' },
  { id: 'workflows', label: 'Workflows', href: '/workflows' },
  { id: 'marketplace', label: 'Marketplace', href: '/marketplace' },
  { id: 'workspace', label: 'Workspace', href: '/workspace' },
  { id: 'activity', label: 'Activity', href: '/activity' },
];

export function parsePlacePins(raw: string | null): PlacePin[] {
  if (!raw) return [...DEFAULT_PLACES];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [...DEFAULT_PLACES];
    const pins = parsed.filter(
      (p): p is PlacePin => !!p && typeof p === 'object'
        && typeof (p as PlacePin).id === 'string' && typeof (p as PlacePin).label === 'string'
        && typeof (p as PlacePin).href === 'string',
    );
    return pins.length > 0 ? pins : [...DEFAULT_PLACES];
  } catch { return [...DEFAULT_PLACES]; }
}

export function loadPlacePins(): PlacePin[] {
  try { return parsePlacePins(localStorage.getItem(PLACES_STORAGE_KEY)); } catch { return [...DEFAULT_PLACES]; }
}
export function savePlacePins(pins: PlacePin[]): void {
  try { localStorage.setItem(PLACES_STORAGE_KEY, JSON.stringify(pins)); } catch { /* ignore */ }
}

/** Only http(s) URLs may be pinned as external places (iframe safety). */
export function isPinnableExternalUrl(href: string): boolean {
  try { const u = new URL(href); return u.protocol === 'https:' || u.protocol === 'http:'; } catch { return false; }
}

export function PlacesRail() {
  const [pins, setPins] = useState<PlacePin[]>(DEFAULT_PLACES);
  const [openExternal, setOpenExternal] = useState<PlacePin | null>(null);
  const [draft, setDraft] = useState({ label: '', href: '' });
  const [adding, setAdding] = useState(false);

  useEffect(() => { setPins(loadPlacePins()); }, []);
  const update = (next: PlacePin[]) => { setPins(next); savePlacePins(next); };

  return (
    <>
      <nav className="places-rail" aria-label="Pinned places"
        style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 4px', borderRight: '1px solid var(--border, #2a2a35)', width: 52, alignItems: 'center' }}>
        {pins.map((pin) => (
          <span key={pin.id} style={{ position: 'relative', display: 'flex' }}>
            {pin.external ? (
              <button type="button" className="icon-btn" title={`${pin.label} (external panel)`} aria-label={`Open ${pin.label} panel`}
                onClick={() => setOpenExternal((cur) => (cur?.id === pin.id ? null : pin))}>
                🌐
              </button>
            ) : (
              <a className="icon-btn" href={pin.href} title={pin.label} aria-label={pin.label} style={{ textDecoration: 'none' }}>
                {pin.label.charAt(0).toUpperCase()}
              </a>
            )}
            <button type="button" className="icon-btn xs" aria-label={`Remove ${pin.label} pin`} title="Remove pin"
              style={{ position: 'absolute', top: -4, right: -6, fontSize: 9 }}
              onClick={() => update(pins.filter((p) => p.id !== pin.id))}>✕</button>
          </span>
        ))}
        <button type="button" className="icon-btn" aria-label="Add a place pin" title="Pin a destination or URL"
          onClick={() => setAdding((v) => !v)}>＋</button>
        {adding && (
          <form style={{ position: 'absolute', zIndex: 70, marginLeft: 56, width: 240, padding: 10, background: 'var(--bg, #14141c)', border: '1px solid var(--border, #2a2a35)', borderRadius: 10 }}
            onSubmit={(e) => {
              e.preventDefault();
              const href = draft.href.trim(); const label = draft.label.trim();
              if (!label || !href) return;
              const external = isPinnableExternalUrl(href);
              if (!external && !href.startsWith('/')) return;
              update([...pins, { id: `place_${Date.now()}`, label, href, ...(external ? { external: true } : {}) }]);
              setDraft({ label: '', href: '' }); setAdding(false);
            }}>
            <input className="input" placeholder="Label" value={draft.label} onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))} aria-label="Place label" />
            <input className="input" placeholder="/internal or https://…" value={draft.href} onChange={(e) => setDraft((d) => ({ ...d, href: e.target.value }))} aria-label="Place URL" style={{ marginTop: 6 }} />
            <button type="submit" className="btn btn-primary btn-sm" style={{ marginTop: 6 }}>Pin place</button>
          </form>
        )}
      </nav>
      {openExternal && (
        <aside className="places-panel" aria-label={`${openExternal.label} panel`}
          style={{ width: 420, maxWidth: '44vw', borderRight: '1px solid var(--border, #2a2a35)', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 10px' }}>
            <strong style={{ fontSize: 13 }}>{openExternal.label}</strong>
            <button type="button" className="icon-btn xs" onClick={() => setOpenExternal(null)} aria-label="Close panel">✕</button>
          </div>
          <iframe title={openExternal.label} src={openExternal.href} sandbox="allow-scripts allow-same-origin allow-popups"
            referrerPolicy="no-referrer" style={{ flex: 1, border: 0, width: '100%' }} />
        </aside>
      )}
    </>
  );
}
