// SPDX-License-Identifier: Apache-2.0
// Brokered identities (A12): Settings → Providers section where the USER
// connects a credential the app holds and brokers for bots (GitHub
// first). Bots ask the app to perform catalogue actions with it — they
// never see the credential value. Standing grants are made only here;
// a bot's first use in a run otherwise raises an approval card that
// grants that run only.
//
// Honest scope, stated on the panel itself: the broker protects the
// credential VALUE, not the usage. Every grant decision and brokered
// action is written to the journal (Activity) — the journal is the
// control for usage.

'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  addBrokerGrant,
  connectBrokerGitHub,
  disconnectBrokerGitHub,
  getBots,
  getBrokerGrants,
  getBrokerIdentities,
  revokeBrokerGrant,
  type BotConfig,
  type BrokerIdentityInfo,
  type BrokerStandingGrant,
} from '../../lib/api';

export default function BrokerIdentitiesPanel() {
  const [identities, setIdentities] = useState<BrokerIdentityInfo[]>([]);
  const [grants, setGrants] = useState<BrokerStandingGrant[]>([]);
  const [bots, setBots] = useState<BotConfig[]>([]);
  const [token, setToken] = useState('');
  const [scope, setScope] = useState<string>('all');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [i, g, b] = await Promise.all([getBrokerIdentities(), getBrokerGrants(), getBots()]);
      setIdentities(i);
      setGrants(g);
      setBots(b);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const botName = useCallback((id: string) => bots.find((b) => b.id === id)?.name ?? id, [bots]);
  const github = identities.find((i) => i.identity === 'github');

  const run = useCallback(
    async (fn: () => Promise<void>) => {
      setBusy(true);
      setError('');
      try {
        await fn();
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  return (
    <section className="card mt" data-testid="broker-identities-panel">
      <div className="row-between">
        <h3 className="mt0">Brokered identities</h3>
        <span className="small muted">the app holds the credential · bots get actions, never the token</span>
      </div>
      <p className="small muted">
        Connect a GitHub token here and it is stored encrypted in the vault. Bots can then ask the
        app to perform specific GitHub actions for them — list repositories, open an issue, comment
        on a pull request — and the app makes the call itself, so the token never appears in a
        conversation, a tool result, or a log. Calls only ever go to <code>api.github.com</code>.
      </p>
      <p className="small muted">
        <strong>What this protects — and what it doesn&apos;t:</strong> the broker protects the
        credential <em>value</em>, not how it is used. Every grant decision and every brokered
        action is written to the journal in Activity; that journal is your control over usage.
        The first action of a kind in a run asks you with an approval card (that run only) unless
        you add a standing grant below — bots can never create standing grants themselves.
      </p>

      {error && (
        <p className="small" role="alert" style={{ color: 'var(--danger, #c0392b)' }}>
          {error}
        </p>
      )}

      <h4 className="mb0 mt">GitHub</h4>
      {!loaded && <p className="small muted">Loading…</p>}
      {loaded && github?.connected && (
        <div className="row-between mt">
          <p className="small" style={{ margin: 0 }}>
            <span className="chip green">connected</span> Brokered calls go to{' '}
            <code>{github.host}</code> only.
          </p>
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={() => void run(() => disconnectBrokerGitHub())}
          >
            Disconnect
          </button>
        </div>
      )}
      {loaded && github && !github.connected && (
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <input
            type="password"
            className="input"
            placeholder="Paste a GitHub personal access token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            style={{ flex: 1 }}
            aria-label="GitHub personal access token"
            autoComplete="off"
          />
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={busy || !token.trim()}
            onClick={() =>
              void run(async () => {
                await connectBrokerGitHub(token.trim());
                setToken('');
              })
            }
          >
            Connect GitHub
          </button>
        </div>
      )}

      <div className="row-between mt">
        <strong className="small">Standing grants ({grants.length})</strong>
        <label className="small muted">
          For{' '}
          <select
            className="input"
            aria-label="Standing grant scope"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            style={{ width: 'auto', display: 'inline-block' }}
          >
            <option value="all">All bots</option>
            {bots.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name} only
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="small muted">
        A standing grant lets bots use GitHub without a per-run approval card. Revoking takes
        effect on the very next brokered call.
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy}
          onClick={() => void run(() => addBrokerGrant({ identity: 'github', actionClass: 'read', scope }).then(() => undefined))}
        >
          + Grant read actions
        </button>
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy}
          onClick={() => void run(() => addBrokerGrant({ identity: 'github', actionClass: 'write', scope }).then(() => undefined))}
        >
          + Grant write actions (issues &amp; comments)
        </button>
      </div>
      {loaded && grants.length === 0 && (
        <p className="small muted" style={{ marginTop: 8 }}>
          No standing grants yet. Bots will ask with an approval card the first time they need
          GitHub in a run.
        </p>
      )}
      {grants.map((g) => (
        <div key={g.id} className="card triage-item" style={{ marginTop: 8 }}>
          <div className="row-between">
            <div>
              <code>{g.identity}</code>{' '}
              <span className="chip" title="Action class">
                {g.actionClass} actions
              </span>{' '}
              <span className="chip" title="Who can use this grant">
                {g.scope === 'all' ? 'all bots' : `${botName(g.scope)} only`}
              </span>
              <div className="small muted">granted {new Date(g.createdAt).toLocaleString()} · via Settings</div>
            </div>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={() => void run(() => revokeBrokerGrant(g.id))}
            >
              Revoke
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}
