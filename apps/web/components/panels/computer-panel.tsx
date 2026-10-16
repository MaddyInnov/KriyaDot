// SPDX-License-Identifier: Apache-2.0
'use client';

// Per-bot computer view (Bots → per-bot "Computer" tab): watch + control one
// bot's sandboxed screen. Frames arrive over the WebSocket at
// /api/computer/ws?botId=<id> as JSON messages carrying base64 PNG frames
// (~3 fps, MJPEG-style fan-out). Clicking the stream maps display
// coordinates back to screen pixels and POSTs to /api/computer/input; the
// text box and key buttons send type/key input the same way.
//
// Security: the user's OWN input is sent straight through (no approval — it
// is their explicit action) and is audit-logged server-side as
// 'tool.computer_viewer_action'. The "agent driving" badge lights up when
// the bot used a computer_* tool in the last ~10s, so it is always obvious
// whose input is moving the cursor.
//
// Mount point (integrator adds this; this file is not a nav destination):
//   apps/web/app/bots/page.tsx — add { id: 'computer', label: 'Computer' }
//   to the tabs array in BotsPage and render
//   <ComputerPanel key={`computer-${selectedBot.id}`} botId={selectedBot.id} />
//   in the tab panel. Destinations stay at exactly six.

import { useCallback, useEffect, useRef, useState } from 'react';
import { authedFetch, getApiBase } from '../../lib/api';
import { useUxMode } from '../../lib/ux-mode';

const KEYS: Array<{ label: string; key: string }> = [
  { label: 'Enter', key: 'Enter' },
  { label: 'Tab', key: 'Tab' },
  { label: 'Esc', key: 'Escape' },
  { label: '⌫', key: 'Backspace' },
  { label: 'Space', key: 'Space' },
];

const api = (path: string, init?: RequestInit): Promise<unknown> =>
  authedFetch(path, init).then(async (res) => {
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

import { ComputerRecordToggle } from './computer-record-toggle';

export default function ComputerPanel({ botId }: { botId: string }) {
  const [mode] = useUxMode();
  const [watching, setWatching] = useState(false);
  const [online, setOnline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const [frameInfo, setFrameInfo] = useState<{ w: number; h: number; ts: number } | null>(null);
  const [driving, setDriving] = useState(false);
  const [isMock, setIsMock] = useState(true);
  const [framesSeen, setFramesSeen] = useState(0);
  const [text, setText] = useState('');
  // Teach-by-recording: active recording id (null when not recording).
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const recordingRef = useRef<string | null>(null);
  recordingRef.current = recordingId;

  const wsRef = useRef<WebSocket | null>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const botRef = useRef(botId);
  botRef.current = botId;
  const reducedMotion = useRef(
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
  );

  const disconnect = useCallback(() => {
    try {
      wsRef.current?.close();
    } catch {
      // ignore
    }
    wsRef.current = null;
    setWatching(false);
    setOnline(false);
    setFrameSrc(null);
    setFrameInfo(null);
    setFramesSeen(0);
    setDriving(false);
  }, []);

  // Reconnect when the selected bot changes while watching.
  useEffect(() => () => disconnect(), [disconnect]);
  useEffect(() => {
    if (watching) disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId]);

  const connect = useCallback(() => {
    disconnect();
    setWatching(true);
    setError(null);
    try {
      const ws = new WebSocket(`${wsBase()}/api/computer/ws?botId=${encodeURIComponent(botId)}`);
      wsRef.current = ws;
      ws.onopen = () => ws.send(JSON.stringify({ t: 'watch', botId }));
      ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(String(ev.data)) as Record<string, unknown>;
          if (m.t === 'frame') {
            setFrameSrc(`data:image/png;base64,${m.png as string}`);
            setFrameInfo({ w: m.w as number, h: m.h as number, ts: m.ts as number });
            setDriving(m.driving === true);
            setIsMock(m.mock !== false);
            setOnline(true);
            setFramesSeen((n) => n + 1);
          } else if (m.t === 'ok') {
            setOnline(true);
            setIsMock(m.mock !== false);
            if (typeof m.w === 'number' && typeof m.h === 'number') {
              setFrameInfo((cur) => cur ?? { w: m.w as number, h: m.h as number, ts: Date.now() });
            }
          } else if (m.t === 'error') {
            setError(`Stream error: ${String(m.detail ?? 'unknown')}`);
          }
        } catch {
          // ignore malformed frames
        }
      };
      ws.onclose = () => {
        setOnline(false);
        setWatching(false);
      };
      ws.onerror = () => setError('WebSocket connection failed.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setWatching(false);
    }
  }, [botId, disconnect]);

  const sendInput = useCallback(
    async (payload: Record<string, unknown>) => {
      try {
        await api('/api/computer/input', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ botId, ...payload }),
        });
        setError(null);
        // Teach-by-recording: mirror the user's input as a recording event
        // while a recording is active (best-effort; never breaks input).
        const recId = recordingRef.current;
        if (recId) {
          const { action, ...rest } = payload;
          const type =
            action === 'click'
              ? 'computer_click'
              : action === 'type'
                ? 'computer_type'
                : action === 'key'
                  ? 'computer_key'
                  : null;
          if (type) {
            void api(`/api/computer/record/${recId}/events`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                events: [{ type, timestamp: Date.now(), ...rest }],
              }),
            }).catch(() => {
              /* recording is best-effort */
            });
          }
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [botId],
  );

  const onScreenClick = (e: React.MouseEvent) => {
    if (!watching || !online || !frameInfo) return;
    const el = screenRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const nx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const ny = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    void sendInput({
      action: 'click',
      x: Math.round(nx * frameInfo.w),
      y: Math.round(ny * frameInfo.h),
    });
  };

  const sendText = () => {
    const v = text.trim();
    if (!v) return;
    void sendInput({ action: 'type', text: v.slice(0, 2000) });
    setText('');
  };

  return (
    <div className="computer-panel">
      <div className="computer-toolbar">
        <div className="computer-badges">
          <span className={`computer-driving${driving ? ' on' : ''}`} title="Lit when the bot used a computer tool in the last ~10s">
            <span className="dot" />
            {driving ? 'AGENT DRIVING' : 'AGENT IDLE'}
          </span>
          {isMock && (
            <span className="computer-mock" title="No real OS access">
              mock layer
            </span>
          )}
        </div>
        <div className="computer-actions">
          {!watching ? (
            <button className="btn primary" onClick={() => void connect()}>
              Watch screen
            </button>
          ) : (
            <button className="btn" onClick={disconnect}>
              Stop watching
            </button>
          )}
          <ComputerRecordToggle botId={botId} onRecordingChange={setRecordingId} />
        </div>
      </div>

      {error && (
        <div className="computer-error" role="alert">
          {error}
        </div>
      )}

      <div className="computer-main">
        <div
          className={`computer-screen${online ? ' online' : ''}`}
          ref={screenRef}
          onClick={onScreenClick}
          role="img"
          aria-label={`Bot ${botId} screen`}
          style={{ cursor: watching && online ? 'crosshair' : 'default' }}
        >
          {frameSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={frameSrc} alt={`Bot ${botId} screen`} draggable={false} />
          ) : (
            <div className="computer-screen-empty">
              {!watching
                ? 'Tap “Watch screen” to start the live view.'
                : 'Waiting for first frame…'}
            </div>
          )}
          {watching && (
            <div className={`computer-status${reducedMotion.current ? ' no-anim' : ''}`}>
              <span className={`dot${online ? ' on' : ''}`} />
              {online ? 'LIVE' : 'OFFLINE'}
              {mode === 'pro' && framesSeen > 0 && <span className="muted"> · {framesSeen} frames</span>}
            </div>
          )}
        </div>

        <div className="computer-controls">
          <div className="computer-hint">
            Click the screen to click at that point · your input is sent immediately
            and audit-logged (no approval needed — it&apos;s your own input)
          </div>
          <div className="computer-keys" role="group" aria-label="Send a key">
            {KEYS.map((k) => (
              <button
                key={k.key}
                className="btn"
                onClick={() => void sendInput({ action: 'key', key: k.key })}
                disabled={!watching || !online}
              >
                {k.label}
              </button>
            ))}
          </div>
          <div className="computer-textrow">
            <input
              type="text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') sendText();
              }}
              placeholder="Type on the bot's screen…"
              maxLength={2000}
              disabled={!watching || !online}
              aria-label="Text to type on the bot's screen"
            />
            <button
              className="btn primary"
              onClick={sendText}
              disabled={!watching || !online || !text.trim()}
            >
              Send
            </button>
          </div>
          {mode === 'pro' && frameInfo && (
            <div className="muted computer-meta">
              {frameInfo.w}×{frameInfo.h} · frame {new Date(frameInfo.ts).toLocaleTimeString()}
            </div>
          )}
          {isMock && (
            <div className="muted computer-meta">
              Running on the <strong>mock layer</strong> — screenshots are fixtures and input is
              recorded, not executed. For real control, set{' '}
              <code className="mono">COMPUTER_USE_REAL=1</code> on the API host (see the
              module docs in apps/api/src/computer-view.ts).
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
