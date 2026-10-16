// SPDX-License-Identifier: Apache-2.0
'use client';

import { useEffect, useState } from 'react';
import { kriyadotFetch } from '../lib/kriyadot-api';

interface ActiveSession {
  sessionId: string;
  deviceId: string;
  deviceName: string;
  status: 'approved' | 'active';
  startedAt: number;
  frames: number;
  mock: boolean;
}

/**
 * "Screen sharing active" indicator. Polls GET /api/remote-screen/status and
 * shows a prominent banner while any phone is viewing this PC's screen, with
 * a Stop button (POST /api/remote-screen/stop-local). This is the PC owner's
 * always-visible consent signal for the Codync-parity remote screen feature.
 */
export default function RemoteScreenBanner() {
  const [active, setActive] = useState<ActiveSession[]>([]);
  const [stopping, setStopping] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await kriyadotFetch('/api/remote-screen/status', { cache: 'no-store' });
        if (!res.ok) return;
        const json = (await res.json()) as { active?: ActiveSession[] };
        if (!cancelled) setActive(Array.isArray(json.active) ? json.active : []);
      } catch {
        // API unreachable — banner stays hidden; nothing to stop.
      }
    };
    void poll();
    const timer = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (active.length === 0) return null;

  const stop = async (sessionId: string) => {
    setStopping(sessionId);
    try {
      await kriyadotFetch('/api/remote-screen/stop-local', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      setActive((prev) => prev.filter((s) => s.sessionId !== sessionId));
    } catch {
      // ignore — next poll refreshes
    } finally {
      setStopping(null);
    }
  };

  const ago = (ts: number) => {
    const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
    return mins < 1 ? 'just now' : `${mins}m ago`;
  };

  return (
    <div
      role="alert"
      aria-live="assertive"
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 60,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 16px',
        background: 'linear-gradient(90deg, #b91c1c, #7f1d1d)',
        color: '#fff',
        fontSize: 14,
      }}
    >
      <span aria-hidden style={{ fontSize: 18 }}>
        🔴
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <strong>Screen sharing active</strong>
        <span style={{ opacity: 0.9 }}>
          {' — '}
          {active.map((s) => s.deviceName).join(', ')} watching this PC
          {active[0] ? ` (started ${ago(active[0].startedAt)})` : ''}
          {active.some((s) => s.mock) ? ' — preview mode' : ''}
        </span>
      </div>
      {active.map((s) => (
        <button
          key={s.sessionId}
          type="button"
          onClick={() => void stop(s.sessionId)}
          disabled={stopping === s.sessionId}
          style={{
            background: '#fff',
            color: '#7f1d1d',
            border: 'none',
            borderRadius: 8,
            padding: '6px 14px',
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          {stopping === s.sessionId ? 'Stopping…' : 'Stop'}
        </button>
      ))}
    </div>
  );
}
