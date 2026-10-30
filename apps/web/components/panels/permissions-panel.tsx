// SPDX-License-Identifier: Apache-2.0
// Permissions & identity pane (Muse parity P-3..P-7, P-15/P-16, CN-10).
// A single consumer view over the governance enforcement that already
// exists: surface defaults + reset, per-connector action trees,
// revocable allowances, per-item overrides, and the (read-only) network
// protocol panel. All colors come from the shared theme CSS variables
// via the standard .card/.table/.btn classes — no hard-coded palette.

'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { authedFetch } from '../../lib/api';
import { useUxMode } from '../../lib/ux-mode';

export type PaneEffect = 'allow' | 'ask' | 'deny';

export interface SurfaceRow {
  id: string;
  label: string;
  description: string;
  defaultEffect: PaneEffect;
  currentEffect: PaneEffect;
  overridden: boolean;
  source: string;
  overridable: boolean;
}

export interface ConnectorRow {
  id: string;
  name: string;
  kind: 'composio' | 'channel';
  enabled: boolean;
  groups: Array<{ id: string; label: string; effect: PaneEffect }>;
  backgroundSync: { enabled: boolean; implemented: boolean };
}

export interface AllowanceRow {
  id: string;
  kind: 'website' | 'recipient' | 'task';
  target: string;
  actions: string[];
  scope: { botId?: string; sessionId?: string };
  createdAt: number;
  expiresAt?: number;
}

export interface ItemOverrideRow {
  key: string;
  itemKind: string;
  itemId: string;
  actions: Record<string, PaneEffect>;
  note?: string;
  updatedAt: number;
}

export interface ProtocolRow {
  id: string;
  label: string;
  defaultEffect: PaneEffect;
  policyKey: string;
  enforcement: string;
  writable: boolean;
  note: string;
}

export interface PermissionsOverviewData {
  surfaces: SurfaceRow[];
  counts: { pendingApprovals: number; allowances: number; itemOverrides: number; lastingAllows: number };
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
      // keep the status-line message
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

const EFFECT_LABEL: Record<PaneEffect, string> = { allow: 'Allow', ask: 'Ask', deny: 'Deny' };
const EFFECTS: PaneEffect[] = ['allow', 'ask', 'deny'];

function EffectSelect({
  value,
  disabled,
  onChange,
  label,
}: {
  value: PaneEffect;
  disabled?: boolean;
  onChange: (effect: PaneEffect) => void;
  label: string;
}) {
  return (
    <select
      className="input"
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as PaneEffect)}
    >
      {EFFECTS.map((effect) => (
        <option key={effect} value={effect}>
          {EFFECT_LABEL[effect]}
        </option>
      ))}
    </select>
  );
}

// ---------------------------------------------------------------------------
// Presentational sections (also covered directly by render tests)
// ---------------------------------------------------------------------------

export function OverviewSection({
  overview,
  onSurfaceChange,
  onReset,
}: {
  overview: PermissionsOverviewData;
  onSurfaceChange: (surfaceId: string, effect: PaneEffect) => void;
  onReset: () => void;
}) {
  return (
    <section className="card">
      <h2>Overview</h2>
      <p className="muted small">
        What your agent may do by default on each surface. Purchases are always approved
        individually and cannot be changed. Reset puts every surface, allowance, and
        &ldquo;always allow&rdquo; choice on this page back to these defaults.
      </p>
      <p className="small">
        Waiting on you: <strong>{overview.counts.pendingApprovals}</strong> approval
        {overview.counts.pendingApprovals === 1 ? '' : 's'} · Allowances:{' '}
        <strong>{overview.counts.allowances}</strong> · Always-allow rules:{' '}
        <strong>{overview.counts.lastingAllows}</strong> · Per-item overrides:{' '}
        <strong>{overview.counts.itemOverrides}</strong>
      </p>
      <table className="table">
        <thead>
          <tr>
            <th>Surface</th>
            <th>Default</th>
            <th>Current</th>
            <th>Comes from</th>
          </tr>
        </thead>
        <tbody>
          {overview.surfaces.map((s) => (
            <tr key={s.id}>
              <td>
                <strong>{s.label}</strong>
                <div className="muted small">{s.description}</div>
              </td>
              <td>{EFFECT_LABEL[s.defaultEffect]}</td>
              <td>
                {s.overridable ? (
                  <EffectSelect
                    label={`${s.label} default`}
                    value={s.currentEffect}
                    onChange={(effect) => onSurfaceChange(s.id, effect)}
                  />
                ) : (
                  EFFECT_LABEL[s.currentEffect]
                )}
                {s.overridden ? <span className="muted small"> (changed)</span> : null}
              </td>
              <td className="muted small">{s.source}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="btn danger" onClick={onReset}>
        Reset approvals to defaults
      </button>
    </section>
  );
}

export function ConnectorsSection({
  connectors,
  botId,
  onGroupChange,
  onSyncToggle,
}: {
  connectors: ConnectorRow[];
  botId: string;
  onGroupChange: (connectorId: string, groupId: string, effect: PaneEffect) => void;
  onSyncToggle: (connectorId: string, enabled: boolean) => void;
}) {
  return (
    <section className="card">
      <h2>Connected apps &amp; channels</h2>
      <p className="muted small">
        For each connected app or channel, choose what its actions may do for bot{' '}
        <strong>{botId}</strong>. Turning an app on or off stays on the Bots page; this tree
        records how each kind of action is treated, plus whether the connector may sync in
        the background.
      </p>
      {connectors.length === 0 ? (
        <p className="muted">No connectors yet. Connect an app or channel and it will appear here.</p>
      ) : (
        connectors.map((c) => (
          <div key={c.id} style={{ marginBottom: 16 }}>
            <h3>
              {c.name}{' '}
              <span className="muted small">
                ({c.kind === 'composio' ? 'app' : 'channel'} · {c.enabled ? 'on' : 'off'})
              </span>
            </h3>
            <table className="table">
              <tbody>
                {c.groups.map((g) => (
                  <tr key={g.id}>
                    <td>{g.label}</td>
                    <td>
                      <EffectSelect
                        label={`${c.name} — ${g.label}`}
                        value={g.effect}
                        onChange={(effect) => onGroupChange(c.id, g.id, effect)}
                      />
                    </td>
                  </tr>
                ))}
                <tr>
                  <td>Background sync</td>
                  <td>
                    <label className="small">
                      <input
                        type="checkbox"
                        checked={c.backgroundSync.enabled}
                        onChange={(e) => onSyncToggle(c.id, e.target.checked)}
                      />{' '}
                      {c.backgroundSync.enabled ? 'On' : 'Off'}
                      {!c.backgroundSync.implemented && (
                        <span className="muted"> — saved; this connector has no sync engine yet</span>
                      )}
                    </label>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        ))
      )}
    </section>
  );
}

export function AllowancesSection({
  allowances,
  onRevoke,
  draft,
  onDraftChange,
  onCreate,
}: {
  allowances: AllowanceRow[];
  onRevoke: (id: string) => void;
  draft: { kind: AllowanceRow['kind']; target: string; actions: string };
  onDraftChange: (draft: { kind: AllowanceRow['kind']; target: string; actions: string }) => void;
  onCreate: () => void;
}) {
  return (
    <section className="card">
      <h2>Allowances</h2>
      <p className="muted small">
        An allowance lets one exact action skip the approval prompt for one exact target: a
        website, a recipient, or a task. It never overrides a policy denial, a hard safety
        floor, or a purchase — purchases always ask. Revoke any allowance at any time.
      </p>
      {allowances.length === 0 ? (
        <p className="muted">No allowances yet.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Kind</th>
              <th>Target</th>
              <th>Actions</th>
              <th>Scope</th>
              <th>Expires</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {allowances.map((a) => (
              <tr key={a.id}>
                <td>{a.kind}</td>
                <td>{a.target}</td>
                <td>
                  <code>{a.actions.join(', ')}</code>
                </td>
                <td className="muted small">
                  {a.scope.botId ? `bot ${a.scope.botId}` : 'all bots'}
                  {a.scope.sessionId ? ` · task ${a.scope.sessionId}` : ''}
                </td>
                <td className="muted small">
                  {a.expiresAt ? new Date(a.expiresAt).toLocaleString() : 'never'}
                </td>
                <td>
                  <button className="btn small danger" onClick={() => onRevoke(a.id)}>
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h3>Add an allowance</h3>
      <div className="row">
        <select
          className="input"
          aria-label="Allowance kind"
          value={draft.kind}
          onChange={(e) =>
            onDraftChange({ ...draft, kind: e.target.value as AllowanceRow['kind'] })
          }
        >
          <option value="website">Website</option>
          <option value="recipient">Recipient</option>
          <option value="task">Task</option>
        </select>
        <input
          className="input"
          aria-label="Allowance target"
          placeholder={
            draft.kind === 'website'
              ? 'example.com'
              : draft.kind === 'recipient'
                ? 'person or address'
                : 'task / session id'
          }
          value={draft.target}
          onChange={(e) => onDraftChange({ ...draft, target: e.target.value })}
        />
        <input
          className="input"
          aria-label="Allowance actions"
          placeholder="actions, comma separated (e.g. send)"
          value={draft.actions}
          onChange={(e) => onDraftChange({ ...draft, actions: e.target.value })}
        />
        <button className="btn primary" onClick={onCreate}>
          Add allowance
        </button>
      </div>
    </section>
  );
}

export function ItemEditorSection({
  items,
  onDelete,
}: {
  items: ItemOverrideRow[];
  onDelete: (item: ItemOverrideRow) => void;
}) {
  return (
    <section className="card">
      <h2>Per-item permissions</h2>
      <p className="muted small">
        Overrides for one specific item — an artifact, a task, or a bot — instead of a whole
        surface. Each row lists the per-action choices saved for that item.
      </p>
      {items.length === 0 ? (
        <p className="muted">No per-item overrides yet.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Item</th>
              <th>Per-action choices</th>
              <th>Updated</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.key}>
                <td>
                  <code>{item.key}</code>
                  {item.note ? <div className="muted small">{item.note}</div> : null}
                </td>
                <td>
                  {Object.entries(item.actions).map(([action, effect]) => (
                    <div key={action} className="small">
                      <code>{action}</code>: {EFFECT_LABEL[effect]}
                    </div>
                  ))}
                </td>
                <td className="muted small">{new Date(item.updatedAt).toLocaleString()}</td>
                <td>
                  <button className="btn small" onClick={() => onDelete(item)}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function ProtocolsSection({ protocols }: { protocols: ProtocolRow[] }) {
  return (
    <section className="card">
      <h2>Network protocols</h2>
      <p className="muted small">
        Direct network access is deny-by-default. These rows are read-only: each protocol is
        enforced by the existing policy, hard floor, or sandbox setting named in the last
        column — there is no separate per-protocol switch to flip.
      </p>
      <table className="table">
        <thead>
          <tr>
            <th>Protocol</th>
            <th>Default</th>
            <th>Enforced by</th>
          </tr>
        </thead>
        <tbody>
          {protocols.map((p) => (
            <tr key={p.id}>
              <td>
                <strong>{p.label}</strong>
                <div className="muted small">{p.note}</div>
              </td>
              <td>{EFFECT_LABEL[p.defaultEffect]}</td>
              <td className="muted small">
                {p.policyKey} <em>(enforced by {p.enforcement === 'sandbox' ? 'sandbox' : p.enforcement})</em>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Container: fetches the pane data and wires the actions
// ---------------------------------------------------------------------------

export default function PermissionsPanel() {
  const [mode] = useUxMode();
  const [overview, setOverview] = useState<PermissionsOverviewData | null>(null);
  const [connectors, setConnectors] = useState<ConnectorRow[]>([]);
  const [botId, setBotId] = useState('');
  const [allowances, setAllowances] = useState<AllowanceRow[]>([]);
  const [items, setItems] = useState<ItemOverrideRow[]>([]);
  const [protocols, setProtocols] = useState<ProtocolRow[]>([]);
  const [draft, setDraft] = useState<{ kind: AllowanceRow['kind']; target: string; actions: string }>({
    kind: 'recipient',
    target: '',
    actions: 'send',
  });
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [ov, conn, al, it, pr] = await Promise.all([
        api<{ ok: boolean } & PermissionsOverviewData>('/api/permissions/overview'),
        api<{ ok: boolean; botId: string; connectors: ConnectorRow[] }>('/api/permissions/connectors'),
        api<{ ok: boolean; allowances: AllowanceRow[] }>('/api/permissions/allowances'),
        api<{ ok: boolean; items: ItemOverrideRow[] }>('/api/permissions/items'),
        api<{ ok: boolean; protocols: ProtocolRow[] }>('/api/permissions/protocols'),
      ]);
      setOverview(ov);
      setBotId(conn.botId);
      setConnectors(conn.connectors);
      setAllowances(al.allowances);
      setItems(it.items);
      setProtocols(pr.protocols);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const surfaceChange = async (surfaceId: string, effect: PaneEffect) => {
    await api(`/api/permissions/surfaces/${surfaceId}`, {
      method: 'PUT',
      body: JSON.stringify({ effect }),
    });
    void load();
  };

  const reset = async () => {
    if (!window.confirm('Reset all approvals, allowances, and per-item overrides to defaults?')) return;
    await api('/api/permissions/reset', { method: 'POST', body: JSON.stringify({ confirm: true }) });
    void load();
  };

  const groupChange = async (connectorId: string, groupId: string, effect: PaneEffect) => {
    await api(`/api/permissions/connectors/${encodeURIComponent(connectorId)}`, {
      method: 'PUT',
      body: JSON.stringify({ botId, groups: { [groupId]: effect } }),
    });
    void load();
  };

  const syncToggle = async (connectorId: string, enabled: boolean) => {
    await api(`/api/permissions/connectors/${encodeURIComponent(connectorId)}`, {
      method: 'PUT',
      body: JSON.stringify({ botId, backgroundSync: enabled }),
    });
    void load();
  };

  const revoke = async (id: string) => {
    await api(`/api/permissions/allowances/${id}`, { method: 'DELETE' });
    void load();
  };

  const createAllowance = async () => {
    const actions = draft.actions
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean);
    if (!draft.target.trim() || actions.length === 0) {
      setError('An allowance needs a target and at least one action.');
      return;
    }
    try {
      await api('/api/permissions/allowances', {
        method: 'POST',
        body: JSON.stringify({ kind: draft.kind, target: draft.target.trim(), actions }),
      });
      setDraft({ kind: draft.kind, target: '', actions: draft.actions });
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const deleteItem = async (item: ItemOverrideRow) => {
    await api(
      `/api/permissions/items/${encodeURIComponent(item.itemKind)}/${encodeURIComponent(item.itemId)}`,
      { method: 'DELETE' },
    );
    void load();
  };

  if (!overview) {
    return (
      <div>
        {error && <div className="error">{error}</div>}
        <p className="muted">Loading permissions…</p>
      </div>
    );
  }

  return (
    <div>
      {error && <div className="error">{error}</div>}
      <OverviewSection overview={overview} onSurfaceChange={surfaceChange} onReset={reset} />
      <ConnectorsSection
        connectors={connectors}
        botId={botId}
        onGroupChange={groupChange}
        onSyncToggle={syncToggle}
      />
      <AllowancesSection
        allowances={allowances}
        onRevoke={revoke}
        draft={draft}
        onDraftChange={setDraft}
        onCreate={createAllowance}
      />
      <ItemEditorSection items={items} onDelete={deleteItem} />
      {mode === 'pro' && <ProtocolsSection protocols={protocols} />}
    </div>
  );
}
