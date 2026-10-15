// SPDX-License-Identifier: Apache-2.0
'use client';

// Remote-phone control (Workspace → Phone tab): view + control the user's OWN
// paired Android phone, or an ADB-attached device as a dev fallback.
// Frames arrive over the live WebSocket at /api/phone/ws (MJPEG v1 relay);
// ADB devices are polled as PNG screencaps. Click = tap, drag = swipe
// (pro mode), text field = type, plus Back/Home/Wake keys.
//
// Security note shown in the UI: input only ever goes to the watched,
// authenticated device; pairing requires explicit on-phone acceptance.

import { useCallback, useEffect, useRef, useState } from 'react';
import { getApiBase } from '../../lib/api';
import { useUxMode } from '../../lib/ux-mode';

interface PhoneDevice {
  id: string;
  kind: 'paired' | 'adb';
  name: string;
  platform: string;
  pairedAt: number;
  lastSeen: number;
  online: boolean;
}

const api = (path: string, init?: RequestInit): Promise<unknown> =>
  fetch(`${getApiBase()}${path}`, init).then(async (res) => {
    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new Error(`API ${res.status}: ${detail || res.statusText}`);
    }
    return res.json() as Promise<unknown>;
  });

function wsBase(): string {
  const base = getApiBase();
  if (typeof window !== 'undefined') {
    const w = window as unknown as { __TAURI__?: unknown };
    if (w.__TAURI__) return 'ws://127.0.0.1:4567';
  }
  if (base.startsWith('http')) return base.replace(/^http/, 'ws');
  if (typeof window !== 'undefined') {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}`;
  }
  return '';
}

function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

interface PairingState {
  code: string;
  expiresAt: number;
}

export default function PhonePanel() {
  const [mode] = useUxMode();
  const [devices, setDevices] = useState<PhoneDevice[]>([]);
  const [adbAvailable, setAdbAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pairing, setPairing] = useState<PairingState | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Live view state
  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const [frameInfo, setFrameInfo] = useState<{ w: number; h: number; ts: number } | null>(null);
  const [watching, setWatching] = useState(false);
  const [watchOnline, setWatchOnline] = useState(false);
  const [framesSeen, setFramesSeen] = useState(0);
  const [text, setText] = useState('');
  const [adbSessionId, setAdbSessionId] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const adbTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reducedMotion = useRef(
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
  );

  const selected = devices.find((d) => d.id === selectedId) ?? null;
  const isAdb = selected?.kind === 'adb';
  const adbSerial = isAdb && selectedId ? selectedId.slice('adb:'.length) : null;

  const loadDevices = useCallback(async () => {
    try {
      const r = (await api('/api/phone/devices')) as {
        ok: boolean;
        devices: PhoneDevice[];
        adbAvailable: boolean;
      };
      setDevices(r.devices);
      setAdbAvailable(r.adbAvailable);
      setError(null);
      if (!selectedId && r.devices.length > 0) {
        const onlineFirst = [...r.devices].sort((a, b) => Number(b.online) - Number(a.online));
        setSelectedId(onlineFirst[0].id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  useEffect(() => {
    void loadDevices();
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [loadDevices]);

  // ---- Pairing -----------------------------------------------------------

  const requestPairing = useCallback(async () => {
    try {
      const r = (await api('/api/phone/pair/request', { method: 'POST' })) as {
        pairingCode: string;
        expiresAt: number;
      };
      setPairing({ code: r.pairingCode, expiresAt: r.expiresAt });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const cancelPairing = useCallback(() => setPairing(null), []);

  // ---- Live session -------------------------------------------------------

  const disconnect = useCallback(() => {
    try {
      wsRef.current?.close();
    } catch {
      // ignore
    }
    wsRef.current = null;
    if (adbTimerRef.current) {
      clearInterval(adbTimerRef.current);
      adbTimerRef.current = null;
    }
    if (adbSessionId) {
      api('/api/phone/adb/watch/end', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: adbSessionId }),
      }).catch(() => undefined);
      setAdbSessionId(null);
    }
    setWatching(false);
    setWatchOnline(false);
    setFrameSrc(null);
    setFrameInfo(null);
    setFramesSeen(0);
  }, [adbSessionId]);

  const unpair = useCallback(
    async (id: string) => {
      if (!window.confirm('Unpair this phone? It will be disconnected immediately.')) return;
      try {
        await api(`/api/phone/devices/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (selectedId === id) {
          disconnect();
          setSelectedId(null);
        }
        void loadDevices();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [selectedId, loadDevices, disconnect],
  );

  useEffect(() => () => disconnect(), [disconnect]);

  const sendWs = useCallback((msg: unknown) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  const connect = useCallback(async () => {
    if (!selected) return;
    disconnect();
    setWatching(true);
    setError(null);
    if (isAdb && adbSerial) {
      // ADB fallback: audited watch session + PNG screencap polling (~2s).
      try {
        const r = (await api('/api/phone/adb/watch/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ serial: adbSerial }),
        })) as { sessionId: string };
        setAdbSessionId(r.sessionId);
        setWatchOnline(true);
        const grab = async () => {
          try {
            const f = (await api(`/api/phone/adb/${encodeURIComponent(adbSerial)}/frame`)) as {
              png: string;
              w: number;
              h: number;
              ts: number;
            };
            setFrameSrc(`data:image/png;base64,${f.png}`);
            setFrameInfo({ w: f.w, h: f.h, ts: f.ts });
            setFramesSeen((n) => n + 1);
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setWatchOnline(false);
          }
        };
        await grab();
        adbTimerRef.current = setInterval(() => void grab(), 2000);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setWatching(false);
      }
      return;
    }
    // Phone-app path: live WS session, MJPEG frames relayed by the hub.
    try {
      const ws = new WebSocket(`${wsBase()}/api/phone/ws`);
      wsRef.current = ws;
      ws.onopen = () => ws.send(JSON.stringify({ t: 'watch', deviceId: selected.id }));
      ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(String(ev.data)) as Record<string, unknown>;
          if (m.t === 'frame') {
            setFrameSrc(`data:image/jpeg;base64,${m.jpg as string}`);
            setFrameInfo({ w: m.w as number, h: m.h as number, ts: m.ts as number });
            setFramesSeen((n) => n + 1);
          } else if (m.t === 'ok') {
            if (typeof m.online === 'boolean') setWatchOnline(m.online);
            const latest = m.latest as { jpg: string; w: number; h: number; ts: number } | null;
            if (latest) {
              setFrameSrc(`data:image/jpeg;base64,${latest.jpg}`);
              setFrameInfo({ w: latest.w, h: latest.h, ts: latest.ts });
            }
          } else if (m.t === 'error') {
            setError(`Stream error: ${String(m.detail ?? 'unknown')}`);
          }
        } catch {
          // ignore malformed relay
        }
      };
      ws.onclose = () => {
        setWatchOnline(false);
        setWatching(false);
      };
      ws.onerror = () => setError('WebSocket connection failed.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setWatching(false);
    }
  }, [selected, isAdb, adbSerial, disconnect]);

  // ---- Input ---------------------------------------------------------------

  const sendInput = useCallback(
    async (msg: unknown) => {
      if (!selected) return;
      if (isAdb && adbSerial) {
        try {
          await api(`/api/phone/adb/${encodeURIComponent(adbSerial)}/input`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(msg),
          });
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
        return;
      }
      sendWs(msg);
    },
    [selected, isAdb, adbSerial, sendWs],
  );

  const norm = useCallback((clientX: number, clientY: number) => {
    const el = screenRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (clientY - r.top) / r.height));
    return { x, y };
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    if (!watching || !watchOnline) return;
    const p = norm(e.clientX, e.clientY);
    if (p) dragRef.current = p;
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!watching || !watchOnline) return;
    const start = dragRef.current;
    dragRef.current = null;
    const end = norm(e.clientX, e.clientY);
    if (!start || !end) return;
    const dx = Math.abs(end.x - start.x);
    const dy = Math.abs(end.y - start.y);
    if (dx < 0.02 && dy < 0.02) {
      void sendInput({ t: 'tap', x: end.x, y: end.y });
    } else if (mode === 'pro') {
      // Drag = swipe (pro mode; in simple mode only taps are offered).
      const dist = Math.hypot(dx, dy);
      void sendInput({ t: 'swipe', x1: start.x, y1: start.y, x2: end.x, y2: end.y, ms: Math.round(200 + dist * 800) });
    }
  };

  const sendText = () => {
    const v = text.trim();
    if (!v) return;
    void sendInput({ t: 'text', text: v.slice(0, 1024) });
    setText('');
  };

  // ---- Render ----------------------------------------------------------------

  if (loading) return <div className="panel-empty">Loading phones…</div>;

  return (
    <div className="phone-panel">
      <div className="phone-toolbar">
        <div className="phone-devices">
          <label htmlFor="phone-device">Device</label>
          <select
            id="phone-device"
            value={selectedId ?? ''}
            onChange={(e) => {
              disconnect();
              setSelectedId(e.target.value || null);
            }}
          >
            {devices.length === 0 && <option value="">No devices</option>}
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} {d.kind === 'adb' ? '(ADB)' : d.online ? '●' : '○'}
              </option>
            ))}
          </select>
          <button className="btn" onClick={() => void loadDevices()}>
            Refresh
          </button>
        </div>
        <div className="phone-actions">
          {!watching ? (
            <button className="btn primary" onClick={() => void connect()} disabled={!selected}>
              Connect
            </button>
          ) : (
            <button className="btn" onClick={disconnect}>
              Disconnect
            </button>
          )}
          {!pairing ? (
            <button className="btn" onClick={() => void requestPairing()}>
              Pair new phone
            </button>
          ) : (
            <button className="btn" onClick={cancelPairing}>
              Cancel pairing
            </button>
          )}
          {selected && selected.kind === 'paired' && (
            <button className="btn danger" onClick={() => void unpair(selected.id)}>
              Unpair
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="phone-error" role="alert">
          {error}
        </div>
      )}

      {pairing && (
        <div className="phone-pairing" role="dialog" aria-label="Pair a phone">
          <div className="pair-code">{pairing.code}</div>
          <div className="pair-meta">
            Expires in {fmtCountdown(pairing.expiresAt - now)} — enter this code in the
            KriyaDot Phone Agent app on your phone and tap <strong>Accept</strong> there.
            Pairing only completes with on-phone acceptance; the code is single-use.
          </div>
        </div>
      )}

      {devices.length === 0 && !pairing && (
        <div className="panel-empty">
          <p>No phones paired yet.</p>
          <p>
            Tap <strong>Pair new phone</strong>, then enter the 6-digit code in the
            KriyaDot Phone Agent app and accept on the phone.
          </p>
          {!adbAvailable ? (
            <p className="muted">
              No ADB devices detected either — install the phone app, or connect a
              phone over USB/Wi-Fi with <code className="mono">adb</code> on PATH for
              the dev fallback.
            </p>
          ) : (
            <p className="muted">
              No app-paired phones, but ADB devices are available above (ADB-only mode).
            </p>
          )}
        </div>
      )}

      {selected && (
        <div className="phone-main">
          <div
            className={`phone-screen${watchOnline ? ' online' : ''}`}
            ref={screenRef}
            onPointerDown={onPointerDown}
            onPointerUp={onPointerUp}
            role="img"
            aria-label={selected.name}
            style={{ cursor: watching && watchOnline ? 'crosshair' : 'default' }}
          >
            {frameSrc ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={frameSrc} alt={`${selected.name} screen`} draggable={false} />
            ) : (
              <div className="phone-screen-empty">
                {!watching
                  ? 'Tap Connect to start a live session.'
                  : watchOnline
                    ? 'Waiting for first frame…'
                    : 'Phone offline — the KriyaDot Phone Agent app must be running on the phone.'}
              </div>
            )}
            {watching && (
              <div className={`phone-status${reducedMotion.current ? ' no-anim' : ''}`}>
                <span className={`dot${watchOnline ? ' on' : ''}`} />
                {watchOnline ? 'LIVE' : 'OFFLINE'}
                {mode === 'pro' && framesSeen > 0 && <span className="muted"> · {framesSeen} frames</span>}
              </div>
            )}
          </div>

          <div className="phone-controls">
            <div className="phone-hint">
              {mode === 'pro'
                ? 'Click = tap · drag = swipe'
                : 'Click the screen to tap'}
              {' · '}input goes only to this device
            </div>
            <div className="phone-keys">
              <button className="btn" onClick={() => void sendInput({ t: 'key', key: 'back' })} disabled={!watching || !watchOnline}>
                Back
              </button>
              <button className="btn" onClick={() => void sendInput({ t: 'key', key: 'home' })} disabled={!watching || !watchOnline}>
                Home
              </button>
              <button className="btn" onClick={() => void sendInput({ t: 'key', key: 'wake' })} disabled={!watching || !watchOnline}>
                Wake
              </button>
            </div>
            <div className="phone-textrow">
              <input
                type="text"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') sendText();
                }}
                placeholder="Type on the phone…"
                maxLength={1024}
                disabled={!watching || !watchOnline}
                aria-label="Text to type on the phone"
              />
              <button className="btn primary" onClick={sendText} disabled={!watching || !watchOnline || !text.trim()}>
                Send
              </button>
            </div>
            {mode === 'pro' && frameInfo && (
              <div className="muted phone-meta">
                {frameInfo.w}×{frameInfo.h} · frame {new Date(frameInfo.ts).toLocaleTimeString()}
                {isAdb && ' · ADB (PNG poll ~2s)'}
              </div>
            )}
            {isAdb && (
              <div className="muted phone-meta">
                ADB-only mode: screen via <code className="mono">screencap</code>, input via{' '}
                <code className="mono">adb shell input</code>. Slower than the phone app.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
