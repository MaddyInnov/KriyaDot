// SPDX-License-Identifier: Apache-2.0
'use client';

// Federation / bridge panel (Octop parity §2.8): link this KriyaDot
// instance to another KriyaDot instance.
//
//   - shows this instance's identity,
//   - creates invite payloads (with the bots WE expose to the invitee),
//   - accepts a remote invite (a trust action — the API audit-logs it),
//   - lists linked peers with per-peer tunnel-policy toggles (which local
//     bots are exposed as "experts", chat / workspace-read capabilities),
//   - lists each peer's exposed experts and can unlink a peer.
//
// Self-contained: mount anywhere in the app shell, e.g.
//   import { FederationPanel } from './components/federation-panel';
//   <FederationPanel />
// All calls go through kriyadotFetch (loopback-token authenticated).

import { useCallback, useEffect, useState } from 'react';
import { kriyadotFetch } from '../lib/kriyadot-api';

interface Identity {
  instanceId: string;
  name: string;
  publicKey: string;
  url: string;
}

interface TunnelPolicy {
  exposedBotIds: string[];
  capabilities: string[];
  rateCapPerMinute: number;
}

interface Peer {
  peerId: string;
  name: string;
  url: string;
  status: string;
  policy: TunnelPolicy;
}

interface BotSummary {
  id: string;
  name: string;
}

interface Expert {
  id: string;
  name: string;
  description: string;
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await kriyadotFetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `API ${res.status}`);
  return body;
}

const box: React.CSSProperties = {
  border: '1px solid var(--border, #ccc)',
  borderRadius: 12,
  padding: 16,
  display: 'grid',
  gap: 16,
  maxWidth: 760,
};

const btn: React.CSSProperties = {
  padding: '5px 12px',
  borderRadius: 999,
  border: '1px solid var(--border, #ccc)',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  fontSize: 13,
};

export function FederationPanel() {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [bots, setBots] = useState<BotSummary[]>([]);
  const [experts, setExperts] = useState<Record<string, Expert[]>>({});
  const [inviteExpose, setInviteExpose] = useState<string[]>([]);
  const [invitePayload, setInvitePayload] = useState('');
  const [acceptPayload, setAcceptPayload] = useState('');
  const [acceptExpose, setAcceptExpose] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [idRes, peerRes, botRes] = await Promise.all([
        apiJson<{ identity: Identity }>('/api/federation/identity'),
        apiJson<{ peers: Peer[] }>('/api/federation/peers'),
        kriyadotFetch('/api/bots').then((r) => (r.ok ? r.json() : [])).catch(() => []),
      ]);
      setIdentity(idRes.identity);
      setPeers(peerRes.peers);
      const botList = (Array.isArray(botRes) ? botRes : []) as Array<{ id: string; name: string }>;
      setBots(botList.map((b) => ({ id: b.id, name: b.name })));
    } catch {
      // API unreachable / federation not wired yet — panel renders empty.
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (fn: () => Promise<void>, okText: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      setMessage(okText);
      await refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleIn = (list: string[], id: string, set: (v: string[]) => void) => {
    set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  };

  const createInvite = () =>
    run(async () => {
      const res = await apiJson<{ payload: string }>('/api/federation/invites', {
        method: 'POST',
        body: JSON.stringify({ policyForPeer: { exposedBotIds: inviteExpose, capabilities: ['chat'] } }),
      });
      setInvitePayload(res.payload);
    }, 'Invite created — share the payload with the other instance.');

  const acceptInvite = () =>
    run(async () => {
      await apiJson('/api/federation/accept', {
        method: 'POST',
        body: JSON.stringify({ payload: acceptPayload.trim(), policy: { exposedBotIds: acceptExpose, capabilities: ['chat'] } }),
      });
      setAcceptPayload('');
    }, 'Linked. The peer now appears below.');

  const updatePolicy = (peer: Peer, policy: TunnelPolicy) =>
    run(async () => {
      await apiJson(`/api/federation/peers/${encodeURIComponent(peer.peerId)}/policy`, {
        method: 'PUT',
        body: JSON.stringify(policy),
      });
    }, 'Tunnel policy updated.');

  const unlink = (peer: Peer) =>
    run(async () => {
      await apiJson(`/api/federation/peers/${encodeURIComponent(peer.peerId)}`, { method: 'DELETE' });
    }, `Unlinked ${peer.name}.`);

  const loadExperts = async (peer: Peer) => {
    try {
      const res = await apiJson<{ experts: Expert[] }>(`/api/federation/peers/${encodeURIComponent(peer.peerId)}/experts`);
      setExperts((prev) => ({ ...prev, [peer.peerId]: res.experts }));
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };

  const botCheckboxes = (selected: string[], onToggle: (id: string) => void) => (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
      {bots.length === 0 ? <span style={{ fontSize: 13, opacity: 0.7 }}>No bots loaded.</span> : null}
      {bots.map((b) => (
        <label key={b.id} style={{ fontSize: 13, display: 'inline-flex', gap: 5, alignItems: 'center' }}>
          <input type="checkbox" checked={selected.includes(b.id)} onChange={() => onToggle(b.id)} />
          {b.name} ({b.id})
        </label>
      ))}
    </div>
  );

  return (
    <section style={box} aria-label="Federation">
      <header>
        <h2 style={{ margin: 0, fontSize: 17 }}>Federation — linked KriyaDot instances</h2>
        {identity ? (
          <p style={{ margin: '6px 0 0', fontSize: 13, opacity: 0.85 }}>
            This instance: <strong>{identity.name}</strong> · <code>{identity.instanceId}</code>
            {identity.url ? (
              <>
                {' '}· <code>{identity.url}</code>
              </>
            ) : (
              <> · no public federation URL configured</>
            )}
          </p>
        ) : (
          <p style={{ margin: '6px 0 0', fontSize: 13, opacity: 0.85 }}>Loading identity…</p>
        )}
        <p style={{ margin: '6px 0 0', fontSize: 12.5, opacity: 0.75 }}>
          Turns run on the home instance; this side keeps only a session reference. Peer turns can never approve
          tools locally — approval-requiring tools are denied and reported.
        </p>
      </header>

      {message ? (
        <div role="status" style={{ fontSize: 13, border: '1px solid var(--border, #ccc)', borderRadius: 8, padding: '8px 10px' }}>
          {message}
        </div>
      ) : null}

      <div>
        <h3 style={{ margin: '0 0 6px', fontSize: 14 }}>Invite another instance</h3>
        <p style={{ margin: '0 0 6px', fontSize: 12.5, opacity: 0.75 }}>Bots you expose to the invitee:</p>
        {botCheckboxes(inviteExpose, (id) => toggleIn(inviteExpose, id, setInviteExpose))}
        <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
          <button type="button" style={btn} disabled={busy} onClick={() => void createInvite()}>
            Create invite
          </button>
        </div>
        {invitePayload ? (
          <textarea
            readOnly
            value={invitePayload}
            rows={4}
            style={{ width: '100%', marginTop: 8, fontSize: 12 }}
            aria-label="Invite payload"
            onFocus={(e) => e.target.select()}
          />
        ) : null}
      </div>

      <div>
        <h3 style={{ margin: '0 0 6px', fontSize: 14 }}>Accept an invite</h3>
        <textarea
          value={acceptPayload}
          onChange={(e) => setAcceptPayload(e.target.value)}
          rows={4}
          placeholder="Paste the other instance's invite payload…"
          style={{ width: '100%', fontSize: 12 }}
          aria-label="Invite payload to accept"
        />
        <p style={{ margin: '6px 0', fontSize: 12.5, opacity: 0.75 }}>Bots you expose back to them:</p>
        {botCheckboxes(acceptExpose, (id) => toggleIn(acceptExpose, id, setAcceptExpose))}
        <div style={{ marginTop: 8 }}>
          <button type="button" style={btn} disabled={busy || !acceptPayload.trim()} onClick={() => void acceptInvite()}>
            Accept invite &amp; link
          </button>
        </div>
      </div>

      <div>
        <h3 style={{ margin: '0 0 8px', fontSize: 14 }}>Linked peers ({peers.length})</h3>
        {peers.length === 0 ? <p style={{ fontSize: 13, opacity: 0.7 }}>No peers linked yet.</p> : null}
        <div style={{ display: 'grid', gap: 12 }}>
          {peers.map((peer) => (
            <article key={peer.peerId} style={{ border: '1px solid var(--border, #ddd)', borderRadius: 10, padding: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                <strong style={{ fontSize: 14 }}>
                  {peer.name} <span style={{ opacity: 0.7, fontWeight: 400 }}>({peer.status})</span>
                </strong>
                <span style={{ display: 'inline-flex', gap: 6 }}>
                  <button type="button" style={btn} disabled={busy} onClick={() => void loadExperts(peer)}>
                    Their experts
                  </button>
                  <button type="button" style={btn} disabled={busy} onClick={() => void unlink(peer)}>
                    Unlink
                  </button>
                </span>
              </div>
              <div style={{ fontSize: 12.5, opacity: 0.8 }}>
                <code>{peer.peerId}</code> · <code>{peer.url}</code> · rate cap {peer.policy.rateCapPerMinute}/min
              </div>
              <p style={{ margin: '8px 0 4px', fontSize: 12.5, opacity: 0.75 }}>Bots exposed to this peer:</p>
              {botCheckboxes(peer.policy.exposedBotIds, (id) =>
                void updatePolicy(peer, {
                  ...peer.policy,
                  exposedBotIds: peer.policy.exposedBotIds.includes(id)
                    ? peer.policy.exposedBotIds.filter((x) => x !== id)
                    : [...peer.policy.exposedBotIds, id],
                }),
              )}
              <label style={{ fontSize: 13, display: 'inline-flex', gap: 5, alignItems: 'center', marginTop: 6 }}>
                <input
                  type="checkbox"
                  checked={peer.policy.capabilities.includes('workspace-read')}
                  onChange={(e) =>
                    void updatePolicy(peer, {
                      ...peer.policy,
                      capabilities: e.target.checked
                        ? [...new Set([...peer.policy.capabilities, 'workspace-read'])]
                        : peer.policy.capabilities.filter((c) => c !== 'workspace-read'),
                    })
                  }
                />
                Allow workspace-read (chat is always the base capability)
              </label>
              {experts[peer.peerId] ? (
                <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 13 }}>
                  {experts[peer.peerId]!.map((e) => (
                    <li key={e.id}>
                      <strong>{e.name}</strong> ({e.id}) — {e.description}
                    </li>
                  ))}
                  {experts[peer.peerId]!.length === 0 ? <li>No experts exposed to us.</li> : null}
                </ul>
              ) : null}
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

export default FederationPanel;
