// SPDX-License-Identifier: Apache-2.0
'use client';

// Fleet panel (Activity → Fleet tab, A15): the multi-machine fleet on
// the existing federation identity. Data comes from GET /api/fleet —
// the local fleet registry, fed only by signature-verified peer
// advertisements. The panel renders exactly what peers advertised
// (name, platform, liveness, active counts, capability chips); it never
// invents telemetry for a machine that has gone quiet — a silent
// machine degrades online → stale → offline and stays listed.

import React, { useCallback, useEffect, useState } from 'react';
import { authedFetch } from '../../lib/api';

export interface FleetMachine {
  instanceId: string;
  displayName: string;
  platform: string;
  version: string;
  capabilities: {
    bridges: string[];
    sandboxBackend: string | null;
    gitAvailable: boolean;
  };
  heartbeatAt: number;
  activeMissions: number;
  activeRuns: number;
  liveness: 'online' | 'stale' | 'offline';
  isSelf: boolean;
  lastSeenAt: number;
}

export interface FleetResponse {
  ok: boolean;
  machines: FleetMachine[];
  thresholds: { staleAfterMs: number; offlineAfterMs: number };
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await authedFetch(path, init);
  if (!res.ok) throw new Error(`${res.status}: ${await res.text().catch(() => res.statusText)}`);
  return res.json() as Promise<T>;
}

const LIVENESS_LABEL: Record<FleetMachine['liveness'], string> = {
  online: '● online',
  stale: '● stale — no recent heartbeat',
  offline: '○ offline',
};

export function FleetPanel() {
  const [fleet, setFleet] = useState<FleetResponse | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setFleet(await apiJson<FleetResponse>('/api/fleet'));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const advertise = useCallback(async () => {
    setBusy(true);
    try {
      await apiJson('/api/fleet/advertise', { method: 'POST', body: '{}' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [load]);

  return (
    <section aria-label="Fleet">
      <h2>Fleet — your machines</h2>
      <p>
        Every KriyaDot instance linked by federation advertises itself here, signed with its federation
        identity. Missions can be dispatched to a machine at mission start; the machine that runs the work
        decides landing with its own approval gate. A machine that stops heartbeating shows as stale, then
        offline — it is never silently removed.
      </p>
      {error && <p role="alert">Could not load the fleet: {error}</p>}
      <button type="button" onClick={() => void advertise()} disabled={busy}>
        {busy ? 'Advertising…' : 'Advertise this machine now'}
      </button>
      {!fleet && !error && <p>Loading fleet…</p>}
      {fleet && fleet.machines.length === 0 && <p>No machines yet. Link another instance in Federation to form a fleet.</p>}
      {fleet && fleet.machines.length > 0 && (
        <ul>
          {fleet.machines.map((m) => (
            <li key={m.instanceId} data-testid={`fleet-machine-${m.instanceId}`}>
              <strong>{m.displayName}</strong>
              {m.isSelf ? ' (this machine)' : ''} — {LIVENESS_LABEL[m.liveness]}
              <div>
                {m.platform} · KriyaDot {m.version} · {m.activeMissions} active mission(s) · {m.activeRuns} run(s)
              </div>
              <div>
                {m.capabilities.gitAvailable && <span>git </span>}
                {m.capabilities.sandboxBackend && <span>sandbox: {m.capabilities.sandboxBackend} </span>}
                {m.capabilities.bridges.map((b) => (
                  <span key={b}>{b} </span>
                ))}
                {!m.capabilities.gitAvailable && <span>no git</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
