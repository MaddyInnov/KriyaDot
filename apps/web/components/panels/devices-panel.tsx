// SPDX-License-Identifier: Apache-2.0
'use client';

// Companion devices (Phone → PC): pair this PC's KriyaDot instance with the
// user's Android phone so the phone becomes a remote control for KriyaDot.
// This is the reverse of the Phone tab ("Control your phone") — here the
// phone drives this machine, not the other way around.
//
// QR codes are rendered client-side with react-qr-code (pure SVG, no
// network calls, works offline). All companion endpoints are defensive:
// the server workstream is building them in parallel, so a 404 surfaces as
// a "companion service unavailable" state, never a crash.

import React, { useCallback, useEffect, useState } from 'react';
import QRCode from 'react-qr-code';
import {
  EndpointMissingError,
  approveCompanionPairing,
  getCompanionPending,
  getCompanionQr,
  listCompanionDevices,
  rejectCompanionPairing,
  requestCompanionCode,
  revokeCompanionDevice,
  type CompanionDevice,
  type CompanionPendingPairing,
} from '../../lib/kriyadot-api';
import { useCalmMotion, useUxMode } from '../../lib/ux-mode';

// ---- Pure helpers (unit-tested) --------------------------------------------------

/** Server timestamps may arrive in seconds or ms; normalise to ms. */
export function normalizeTs(ts: number): number {
  return ts < 1_000_000_000_000 ? ts * 1000 : ts;
}

/** mm:ss countdown, e.g. 4:59. */
export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** "just now" / "12m ago" / "3h ago" / "5d ago" / date. */
export function formatLastSeen(ts: number, now: number): string {
  const t = normalizeTs(ts);
  const mins = Math.floor(Math.max(0, now - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(t).toLocaleDateString();
}

/** "123456" → "123 456" for comfortable reading. */
export function groupOtt(ott: string): string {
  const digits = ott.replace(/\D/g, '');
  return digits.length === 6 ? `${digits.slice(0, 3)} ${digits.slice(3)}` : ott;
}

// ---- Component ---------------------------------------------------------------------

interface PairingState {
  qrPayload: string;
  ott?: string;
  expiresAt?: number;
  mode?: 'lan' | 'hosted';
  serverLabel?: string;
}

/** "QR encodes: WiFi (192.168.1.5:4000)" / "QR encodes: internet (https://…)". */
export function pairingModeLabel(mode: 'lan' | 'hosted' | undefined, serverLabel?: string): string {
  const where = serverLabel ? ` (${serverLabel})` : '';
  return mode === 'hosted' ? `QR encodes: internet${where}` : `QR encodes: WiFi LAN${where}`;
}

const POLL_MS = 15000;

export default function DevicesPanel() {
  const [mode] = useUxMode();
  const calm = useCalmMotion();
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<CompanionDevice[]>([]);
  const [pending, setPending] = useState<CompanionPendingPairing[]>([]);
  const [pairing, setPairing] = useState<PairingState | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const loadDevices = useCallback(async () => {
    try {
      const r = await listCompanionDevices();
      setDevices(Array.isArray(r.devices) ? r.devices : []);
      setError(null);
    } catch (e) {
      if (e instanceof EndpointMissingError) setUnavailable(true);
      else setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const loadPending = useCallback(async () => {
    try {
      const r = await getCompanionPending();
      setPending(r && Array.isArray(r.pending) ? r.pending : []);
    } catch {
      // Pending approvals are optional; the server may not expose them yet.
      setPending([]);
    }
  }, []);

  const loadPairing = useCallback(async () => {
    try {
      const r = await getCompanionQr();
      setPairing({ qrPayload: r.qrPayload, mode: r.mode ?? 'lan', serverLabel: r.serverLabel });
      setUnavailable(false);
      setError(null);
    } catch (e) {
      if (e instanceof EndpointMissingError) setUnavailable(true);
      else setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // Initial load: pairing payload first; devices only make sense once the
  // companion service is confirmed reachable.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      await loadPairing();
      if (cancelled) return;
      await Promise.all([loadDevices(), loadPending()]);
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadPairing, loadDevices, loadPending]);

  // Countdown tick (1s) + device/pending refresh (15s).
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(() => {
      if (!unavailable) {
        void loadDevices();
        void loadPending();
      }
    }, POLL_MS);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [unavailable, loadDevices, loadPending]);

  const requestCode = useCallback(async () => {
    setBusy(true);
    try {
      const r = await requestCompanionCode();
      setPairing({
        qrPayload: r.qrPayload,
        ott: r.ott,
        expiresAt: normalizeTs(r.expiresAt),
        mode: r.mode ?? 'lan',
        serverLabel: r.serverLabel,
      });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const revoke = useCallback(
    async (d: CompanionDevice) => {
      if (!window.confirm(`Revoke "${d.name}"? It will lose remote-control access immediately.`)) return;
      try {
        await revokeCompanionDevice(d.id);
        void loadDevices();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [loadDevices],
  );

  const decide = useCallback(
    async (token: string, approve: boolean) => {
      try {
        if (approve) await approveCompanionPairing(token);
        else await rejectCompanionPairing(token);
        await Promise.all([loadDevices(), loadPending()]);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [loadDevices, loadPending],
  );

  if (loading) return <div className="panel-empty">Loading companion devices…</div>;

  const onlineCount = devices.filter((d) => d.online).length;
  const codeExpired =
    pairing?.expiresAt !== undefined && normalizeTs(pairing.expiresAt) - now <= 0;

  return (
    <div className="devices-panel">
      <div className="phone-toolbar">
        <div>
          <span className="chip" title="Pair your phone so it can drive this PC">
            Control KriyaDot from your phone
          </span>
          <p className="muted" style={{ margin: '8px 0 0' }}>
            Pair your Android phone with this PC — the phone becomes a remote
            control for KriyaDot. (The <strong>Phone</strong> tab is the reverse:
            controlling your phone from here.)
          </p>
        </div>
        <div className="phone-actions">
          <button
            className="btn"
            onClick={() => {
              setLoading(true);
              void (async () => {
                await loadPairing();
                await Promise.all([loadDevices(), loadPending()]);
                setLoading(false);
              })();
            }}
          >
            Refresh
          </button>
        </div>
      </div>

      {unavailable ? (
        <div className="panel-empty">
          <p>
            <strong>Companion service unavailable.</strong>
          </p>
          <p>
            The phone→PC remote-control service isn&apos;t running on this
            KriyaDot instance yet. Start the companion server (or check that it
            exposes <code className="mono">/api/companion/…</code>), then tap
            Refresh.
          </p>
        </div>
      ) : (
        <>
          <div
            className="devices-status"
            role="status"
            style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0 12px' }}
          >
            <span
              aria-hidden
              className={calm ? 'no-anim' : undefined}
              style={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                background: onlineCount > 0 ? '#3fd08a' : '#e0526e',
                display: 'inline-block',
              }}
            />
            <span>
              {onlineCount > 0
                ? `${onlineCount} of ${devices.length} device${devices.length === 1 ? '' : 's'} online — remote control ready`
                : devices.length > 0
                  ? 'Service reachable — no devices online right now'
                  : 'Service reachable — no phones paired yet'}
            </span>
          </div>

          {error && (
            <div className="phone-error" role="alert" style={{ marginBottom: 12 }}>
              {error}
            </div>
          )}

          <section className="card" aria-labelledby="pair-phone-heading" style={{ marginBottom: 16 }}>
            <h2 id="pair-phone-heading" style={{ marginTop: 0 }}>
              Pair a phone
            </h2>
            {pairing && (
              <p className="muted" style={{ margin: '0 0 12px' }}>
                <span className="chip" title="Which network this QR code pairs over">
                  {pairingModeLabel(pairing.mode, pairing.serverLabel)}
                </span>{' '}
                {pairing.mode === 'hosted' ? (
                  <>Phones can pair over the internet — no WiFi needed.</>
                ) : (
                  <>
                    Phones pair over your local WiFi. To pair over the internet
                    instead, set <code className="mono">KRIYADOT_PUBLIC_URL</code>{' '}
                    (e.g. <code className="mono">https://kriyadot.example.com</code>) on
                    the server and tap Refresh.
                  </>
                )}
              </p>
            )}
            {pairing ? (
              <div className="phone-pairing">
                <div
                  style={{
                    background: '#ffffff',
                    padding: 12,
                    borderRadius: 12,
                    lineHeight: 0,
                    flexShrink: 0,
                  }}
                  title="Scan with the KriyaDot companion app"
                >
                  <QRCode
                    value={pairing.qrPayload}
                    size={200}
                    bgColor="#ffffff"
                    fgColor="#000000"
                    level="M"
                    title="KriyaDot pairing QR code"
                  />
                </div>
                <div className="pair-meta">
                  <ol style={{ margin: '0 0 12px', paddingLeft: 20 }}>
                    <li>Install the KriyaDot companion app on your Android phone.</li>
                    <li>
                      In the app, tap <strong>Scan QR</strong> and scan this code —
                      or tap <strong>Enter code</strong> and type the 6-digit code below.
                    </li>
                    <li>
                      Approve the pairing on this screen when it appears. Remote
                      control starts after your approval.
                    </li>
                  </ol>
                  {pairing.ott ? (
                    <div>
                      <div className="pair-code">{groupOtt(pairing.ott)}</div>
                      <div style={{ margin: '8px 0' }}>
                        {codeExpired ? (
                          <span style={{ color: '#c04a63' }}>
                            Code expired — generate a new one.
                          </span>
                        ) : (
                          <>Expires in {formatCountdown(normalizeTs(pairing.expiresAt ?? 0) - now)}</>
                        )}{' '}
                        The code is single-use.
                      </div>
                    </div>
                  ) : (
                    <p className="muted">
                      Prefer typing? Generate a 6-digit pairing code instead of scanning.
                    </p>
                  )}
                  <button className="btn" onClick={() => void requestCode()} disabled={busy}>
                    {busy ? 'Generating…' : pairing.ott ? 'Generate new code' : 'Generate pairing code'}
                  </button>
                  {mode === 'pro' && (
                    <p className="muted" style={{ marginTop: 10, wordBreak: 'break-all' }}>
                      <code className="mono" style={{ fontSize: 11 }}>{pairing.qrPayload}</code>
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <div className="panel-empty">
                <p>Pairing payload not available right now — tap Refresh to retry.</p>
              </div>
            )}
          </section>

          {pending.length > 0 && (
            <section className="card" aria-labelledby="pending-heading" style={{ marginBottom: 16 }}>
              <h2 id="pending-heading" style={{ marginTop: 0 }}>
                Waiting for approval
              </h2>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
                {pending.map((p) => (
                  <li
                    key={p.token}
                    style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}
                  >
                    <span>
                      <strong>{p.deviceName ?? 'Unknown phone'}</strong>
                      {p.platform && <span className="chip" style={{ marginLeft: 8 }}>{p.platform}</span>}
                    </span>
                    <span className="muted" style={{ flex: 1 }}>
                      wants to pair
                      {p.requestedAt ? ` · requested ${formatLastSeen(p.requestedAt, now)}` : ''}
                    </span>
                    <button className="btn primary" onClick={() => void decide(p.token, true)}>
                      Approve
                    </button>
                    <button className="btn" onClick={() => void decide(p.token, false)}>
                      Reject
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="card" aria-labelledby="devices-heading">
            <h2 id="devices-heading" style={{ marginTop: 0 }}>
              Paired devices
            </h2>
            {devices.length === 0 ? (
              <div className="panel-empty">
                <p>No phones paired yet.</p>
                <p>
                  Scan the QR code above with the KriyaDot companion app (or use
                  the pairing code), then approve on this screen.
                </p>
              </div>
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 10 }}>
                {devices.map((d) => (
                  <li
                    key={d.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      flexWrap: 'wrap',
                      padding: '10px 12px',
                      borderRadius: 10,
                      background: 'var(--glass-bg, rgba(255,255,255,0.6))',
                      border: '1px solid var(--glass-border, rgba(0,0,0,0.08))',
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: '50%',
                        background: d.online ? '#3fd08a' : '#c9c9c9',
                        flexShrink: 0,
                      }}
                    />
                    <div style={{ flex: 1, minWidth: 180 }}>
                      <div>
                        <strong>{d.name}</strong>
                        <span className="chip" style={{ marginLeft: 8 }}>
                          {d.online ? 'online' : 'offline'}
                        </span>
                        {d.platform && <span className="muted"> · {d.platform}</span>}
                      </div>
                      <div className="muted" style={{ fontSize: 12 }}>
                        Last seen {formatLastSeen(d.lastSeen, now)}
                        {mode === 'pro' && (
                          <>
                            {' '}· paired {new Date(normalizeTs(d.pairedAt)).toLocaleString()}
                            {' '}· <code className="mono">{d.id}</code>
                          </>
                        )}
                      </div>
                    </div>
                    <button className="btn danger" onClick={() => void revoke(d)}>
                      Revoke
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
