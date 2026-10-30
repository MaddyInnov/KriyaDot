// SPDX-License-Identifier: Apache-2.0
// Real-desktop computer-use setup (ADD-5): the first-run flow rendered in
// Settings → Permissions. Steps: (1) the plain-language explainer —
// including the foreground truth, stated up front; (2) the per-OS
// permission grant checks, reported honestly (a check this process
// cannot probe says so, and the self-test is the proof); (3) the
// self-test (screenshot + move + click) with recorded results;
// (4) enable/disable. Copy never implies background real-mouse control,
// and the approval note (setup grants no standing allow) stays visible.

'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { authedFetch } from '../../lib/api';

export interface ComputerUseCheck {
  id: string;
  label: string;
  requirement: 'grant-required' | 'not-required' | 'restricted';
  status: 'ok' | 'needs-grant' | 'unknown' | 'restricted';
  autoDetectable: boolean;
  instructions: string;
}

export interface ComputerUseSelfTest {
  ok: boolean;
  at: number;
  steps: Array<{ id: string; ok: boolean; detail: string }>;
}

export interface ComputerUseSetupData {
  status: 'not-started' | 'in-progress' | 'self-test-failed' | 'ready-to-enable' | 'enabled' | 'disabled';
  enabled: boolean;
  explainer: { headline: string; foregroundTruth: string; approvalNote: string; permissionNote: string };
  platform: { platform: string; displayServer?: string; checks: ComputerUseCheck[] };
  selfTest?: ComputerUseSelfTest;
  enabledAt?: number;
  adapter: { kind: string; real: boolean; reason: string };
  approvalNote: string;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await authedFetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers || {}) },
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // keep the status message
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

const STATUS_LABEL: Record<ComputerUseSetupData['status'], string> = {
  'not-started': 'Not set up',
  'in-progress': 'Setup in progress',
  'self-test-failed': 'Self-test failed — fix the item below and run it again',
  'ready-to-enable': 'Self-test passed — ready to enable',
  enabled: 'Enabled — the real foreground adapter is active',
  disabled: 'Disabled',
};

export default function ComputerUseSetupPanel() {
  const [data, setData] = useState<ComputerUseSetupData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const d = await api<ComputerUseSetupData & { ok: boolean }>('/api/computer-use-setup');
      setData(d);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = useCallback(
    async (path: string, body?: unknown) => {
      setBusy(true);
      try {
        const d = await api<ComputerUseSetupData & { ok: boolean }>(path, {
          method: 'POST',
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        setData(d);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  if (!data) {
    return (
      <div className="card" data-testid="computer-use-setup">
        <h2>Computer use (your real desktop)</h2>
        {error ? <p className="error">{error}</p> : <p className="muted">Loading setup state…</p>}
      </div>
    );
  }

  const started = data.status !== 'not-started';

  return (
    <div className="card" data-testid="computer-use-setup">
      <h2>Computer use (your real desktop)</h2>
      <p>
        <strong>Status: {STATUS_LABEL[data.status]}</strong>
      </p>

      {/* Step 1 — the explainer, foreground truth first. */}
      <h3>1. What this means</h3>
      <p>{data.explainer.foregroundTruth}</p>
      <p>{data.explainer.permissionNote}</p>
      <p className="muted">{data.approvalNote}</p>
      {!started && (
        <button className="btn" disabled={busy} onClick={() => void act('/api/computer-use-setup/begin')}>
          Start setup
        </button>
      )}

      {/* Step 2 — OS permission checks, reported honestly. */}
      {started && (
        <>
          <h3>2. Operating-system permissions ({data.platform.platform})</h3>
          <ul>
            {data.platform.checks.map((check) => (
              <li key={check.id}>
                <strong>{check.label}</strong> —{' '}
                {check.requirement === 'not-required'
                  ? 'nothing to grant'
                  : check.requirement === 'restricted'
                    ? 'blocked on this system'
                    : check.status === 'ok'
                      ? 'granted'
                      : 'grant required (this app cannot read the grant state — the self-test below is the proof)'}
                <br />
                <span className="muted">{check.instructions}</span>
              </li>
            ))}
          </ul>

          {/* Step 3 — the self-test, results recorded. */}
          <h3>3. Self-test</h3>
          <p className="muted">
            Takes a real screenshot, moves your cursor to the centre of the screen, and clicks once
            there. Watch your screen while it runs — you should see the cursor move.
          </p>
          <button className="btn" disabled={busy} onClick={() => void act('/api/computer-use-setup/self-test')}>
            Run the self-test
          </button>
          {data.selfTest && (
            <ul>
              {data.selfTest.steps.map((step) => (
                <li key={step.id}>
                  {step.ok ? '✓' : '✗'} <strong>{step.id}</strong>: {step.detail}
                </li>
              ))}
            </ul>
          )}

          {/* Step 4 — enable / disable. */}
          <h3>4. Turn it on</h3>
          {data.enabled ? (
            <>
              <p>
                Real control is on. Your bots will drive your actual screen — with your cursor, in
                the foreground — and every action still asks for approval first.
              </p>
              <button className="btn" disabled={busy} onClick={() => void act('/api/computer-use-setup/disable')}>
                Disable real control
              </button>
            </>
          ) : (
            <>
              <p className="muted">
                {data.selfTest?.ok
                  ? 'The self-test passed. Enabling makes the real adapter the default for this computer.'
                  : 'Run the self-test and make sure it passes before enabling.'}
              </p>
              <button
                className="btn"
                disabled={busy || !data.selfTest?.ok}
                onClick={() => void act('/api/computer-use-setup/enable', { confirm: true })}
              >
                Enable real control
              </button>
            </>
          )}
          <p className="muted">Adapter: {data.adapter.reason}</p>
        </>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
