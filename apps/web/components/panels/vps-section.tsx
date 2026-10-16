// SPDX-License-Identifier: Apache-2.0
'use client';

// BYO VPS profile editor (OpenMausBot parity P1 #24). Rendered in the per-bot
// Computer tab below the "Works on" surface selector: host/port/user, auth
// method, one-time private-key paste (stored in the vault, never echoed
// back), TOFU fingerprint trust flow, status, and test/connect/disconnect.
//
// Security notes shown in the UI:
// - private keys are referenced by vault secret name, never stored in the profile
// - passwords are prompted per connect and never persisted
// - a changed host key is a hard stop (possible MITM)

import { useCallback, useEffect, useState } from 'react';
import { authedFetch } from '../../lib/api';

interface VpsProfile {
  host: string;
  port: number;
  user: string;
  authMethod: 'key' | 'password-prompt' | 'agent';
  privateKeyRef?: string;
  fingerprint?: string;
  display?: string;
  label?: string;
}

interface VpsState {
  profile: VpsProfile | null;
  hasDefault: boolean;
  effectiveFrom: 'bot' | 'default' | null;
  status: {
    status: 'disconnected' | 'connecting' | 'connected' | 'error';
    lastError?: string;
    fingerprint?: string;
  };
}

interface TestResult {
  ok: boolean;
  trustRequired?: boolean;
  fingerprint?: string;
  os?: { os: string; kernel: string; arch: string };
  desktopTools?: { xdotool: boolean; screenshot: boolean };
  newlyTrusted?: boolean;
  error?: string;
  detail?: string;
}

async function api(path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const res = await authedFetch(path, init);
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

function statusDot(status: VpsState['status']['status']): string {
  switch (status) {
    case 'connected':
      return '🟢';
    case 'connecting':
      return '🟡';
    case 'error':
      return '🔴';
    default:
      return '⚪';
  }
}

export default function VpsSection({ botId }: { botId: string }) {
  const [state, setState] = useState<VpsState | null>(null);
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [user, setUser] = useState('');
  const [authMethod, setAuthMethod] = useState<VpsProfile['authMethod']>('key');
  const [privateKeyRef, setPrivateKeyRef] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [display, setDisplay] = useState(':0');
  const [label, setLabel] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [pendingTrust, setPendingTrust] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { status, body } = await api(`/api/bots/${encodeURIComponent(botId)}/vps`);
      if (status !== 200) throw new Error(`API ${status}`);
      const s = body as VpsState;
      setState(s);
      const p = s.profile;
      if (p) {
        setHost(p.host);
        setPort(String(p.port));
        setUser(p.user);
        setAuthMethod(p.authMethod);
        setPrivateKeyRef(p.privateKeyRef ?? '');
        setDisplay(p.display ?? ':0');
        setLabel(p.label ?? '');
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [botId]);

  useEffect(() => {
    setState(null);
    setTestResult(null);
    setPendingTrust(null);
    setPassword('');
    setPrivateKey('');
    void refresh();
  }, [botId, refresh]);

  const save = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const { status, body } = await api(`/api/bots/${encodeURIComponent(botId)}/vps`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: host.trim(),
          port: Number(port) || 22,
          user: user.trim(),
          authMethod,
          ...(privateKeyRef.trim() ? { privateKeyRef: privateKeyRef.trim() } : {}),
          ...(privateKey.trim() ? { privateKey: privateKey.trim() } : {}),
          display: display.trim() || ':0',
          ...(label.trim() ? { label: label.trim() } : {}),
        }),
      });
      if (status !== 200) {
        const b = body as { error?: string; detail?: string };
        throw new Error(b.detail || b.error || `API ${status}`);
      }
      setPrivateKey('');
      setNotice('VPS profile saved. Private keys live in the vault — never in the profile.');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!window.confirm('Delete this bot\u2019s VPS profile and disconnect?')) return;
    setSaving(true);
    try {
      await api(`/api/bots/${encodeURIComponent(botId)}/vps`, { method: 'DELETE' });
      setHost('');
      setPort('22');
      setUser('');
      setPrivateKeyRef('');
      setDisplay(':0');
      setLabel('');
      setNotice('VPS profile deleted.');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const runTest = async (trustFingerprint = false) => {
    setSaving(true);
    setError(null);
    setTestResult(null);
    try {
      const { status, body } = await api(`/api/bots/${encodeURIComponent(botId)}/vps/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(password ? { password } : {}),
          ...(trustFingerprint ? { trustFingerprint: true } : {}),
        }),
      });
      const b = body as TestResult & { hint?: string };
      if (status === 409 && b.trustRequired && b.fingerprint) {
        setPendingTrust(b.fingerprint);
        setTestResult(b);
        return;
      }
      if (status !== 200 || !b.ok) {
        throw new Error(b.detail || b.error || `API ${status}`);
      }
      setPendingTrust(null);
      setTestResult(b);
      setPassword('');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const connect = async (trustFingerprint = false) => {
    setSaving(true);
    setError(null);
    try {
      const { status, body } = await api(`/api/bots/${encodeURIComponent(botId)}/vps/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(password ? { password } : {}),
          ...(trustFingerprint ? { trustFingerprint: true } : {}),
        }),
      });
      const b = body as TestResult;
      if (status === 409 && b.trustRequired && b.fingerprint) {
        setPendingTrust(b.fingerprint);
        setTestResult(b);
        return;
      }
      if (status !== 200) {
        throw new Error(b.detail || b.error || `API ${status}`);
      }
      setPendingTrust(null);
      setPassword('');
      setNotice('Connected to the VPS.');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const disconnect = async () => {
    setSaving(true);
    try {
      await api(`/api/bots/${encodeURIComponent(botId)}/vps/disconnect`, { method: 'POST' });
      setNotice('Disconnected.');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const st = state?.status;
  const isPasswordAuth = authMethod === 'password-prompt';

  return (
    <section className="vps-section" aria-label="BYO VPS">
      <h3>Your VPS (bring your own server)</h3>
      <div className="muted">
        Run this bot&apos;s commands and desktop on your own server over SSH.
        Keys live in the vault — the profile only holds a reference.
      </div>

      <div className="vps-grid">
        <label>
          Host
          <input
            type="text"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="vps.example.com or 203.0.113.10"
            autoComplete="off"
          />
        </label>
        <label>
          Port
          <input
            type="number"
            value={port}
            onChange={(e) => setPort(e.target.value)}
            min={1}
            max={65535}
          />
        </label>
        <label>
          User
          <input
            type="text"
            value={user}
            onChange={(e) => setUser(e.target.value)}
            placeholder="ubuntu"
            autoComplete="off"
          />
        </label>
        <label>
          Auth method
          <select value={authMethod} onChange={(e) => setAuthMethod(e.target.value as VpsProfile['authMethod'])}>
            <option value="key">SSH key (from vault)</option>
            <option value="agent">SSH agent (SSH_AUTH_SOCK)</option>
            <option value="password-prompt">Password (prompted each connect)</option>
          </select>
        </label>
        <label>
          Display
          <input
            type="text"
            value={display}
            onChange={(e) => setDisplay(e.target.value)}
            placeholder=":0"
          />
        </label>
        <label>
          Label (optional)
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Hetzner VPS"
          />
        </label>
      </div>

      {authMethod === 'key' && (
        <>
          <label>
            Vault secret name holding the private key
            <input
              type="text"
              value={privateKeyRef}
              onChange={(e) => setPrivateKeyRef(e.target.value)}
              placeholder="vps-ssh-key-scout"
              autoComplete="off"
            />
          </label>
          <label>
            …or paste a private key once (stored in the vault, never shown again)
            <textarea
              value={privateKey}
              onChange={(e) => setPrivateKey(e.target.value)}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              rows={3}
              spellCheck={false}
              autoComplete="off"
            />
          </label>
        </>
      )}

      {isPasswordAuth && (
        <label>
          Password (sent once for this connect/test — never stored)
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
        </label>
      )}

      {state?.profile?.fingerprint && (
        <div className="vps-fingerprint">
          <strong>Pinned host key:</strong>{' '}
          <code className="mono">{state.profile.fingerprint}</code>
        </div>
      )}
      {state && !state.profile && state.hasDefault && (
        <div className="muted">No per-bot profile — the global default VPS profile applies.</div>
      )}

      <div className="vps-status">
        {statusDot(st?.status ?? 'disconnected')} {st?.status ?? 'disconnected'}
        {st?.lastError && <span className="vps-error-detail"> — {st.lastError}</span>}
      </div>

      {pendingTrust && (
        <div className="vps-trust" role="alert">
          <strong>Untrusted host key.</strong> The VPS presents{' '}
          <code className="mono">{pendingTrust}</code>. Verify this fingerprint
          out-of-band (your provider&apos;s console), then trust it explicitly.
          <div className="vps-row">
            <button className="btn primary" disabled={saving} onClick={() => void runTest(true)}>
              Trust &amp; test
            </button>
            <button className="btn" disabled={saving} onClick={() => void connect(true)}>
              Trust &amp; connect
            </button>
            <button className="btn" disabled={saving} onClick={() => setPendingTrust(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {testResult && !testResult.trustRequired && (
        <div className="vps-test-result">
          {testResult.ok ? (
            <>
              ✅ {testResult.os?.os} {testResult.os?.kernel} ({testResult.os?.arch})
              {' · '}desktop tools: xdotool {testResult.desktopTools?.xdotool ? '✅' : '❌'},
              screenshot {testResult.desktopTools?.screenshot ? '✅' : '❌'}
              {testResult.newlyTrusted && ' · host key newly trusted & pinned'}
            </>
          ) : (
            <>❌ {testResult.error}</>
          )}
        </div>
      )}

      <div className="vps-row">
        <button className="btn primary" disabled={saving} onClick={() => void save()}>
          Save profile
        </button>
        <button className="btn" disabled={saving} onClick={() => void runTest()}>
          Test connection
        </button>
        <button className="btn" disabled={saving} onClick={() => void connect()}>
          Connect
        </button>
        <button className="btn" disabled={saving} onClick={() => void disconnect()}>
          Disconnect
        </button>
        <button className="btn danger" disabled={saving} onClick={() => void remove()}>
          Delete
        </button>
      </div>

      {notice && <div className="vps-notice">{notice}</div>}
      {error && (
        <div className="computer-error" role="alert">
          {error}
        </div>
      )}

      <div className="muted">
        Desktop control needs <code className="mono">xdotool</code> and ImageMagick
        (<code className="mono">import</code>) or <code className="mono">scrot</code> on the
        VPS. A changed host key is a hard stop (possible man-in-the-middle) —
        re-trust it explicitly if you rotated the key.
      </div>
    </section>
  );
}
