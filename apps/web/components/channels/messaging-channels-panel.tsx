// SPDX-License-Identifier: Apache-2.0
'use client';

// Messaging channels settings surface (Muse parity CH-2/CH-3) + durable
// provider side chats (CH-1/CH-5).
//
// One surface for every messaging provider: connection status, the unified
// secure connect flow (begin → paste credential → complete; the credential
// goes straight to the API's encrypted store and is never shown again),
// and disconnect. Below it, the mirrored side chats: one durable,
// provider-titled transcript per provider conversation, kept separate
// from the main chat history.

import { useCallback, useEffect, useState } from 'react';
import { authedFetch } from '../../lib/api';

interface ConnectionEntry {
  providerId: string;
  displayName: string;
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  credentialRef: string;
  connectedAt?: string;
  settings: Record<string, string>;
  hasWebhookSecret: boolean;
  lastError?: string;
}

interface ConnectBegin {
  flowId: string;
  steps: string[];
  credentialFields: Array<{ key: string; label: string; secret: boolean; required: boolean }>;
  settingFields: Array<{ key: string; label: string; required: boolean }>;
}

interface SideChatEntry {
  id: string;
  providerId: string;
  externalChatId: string;
  title: string;
  messageCount: number;
  updatedAt: string;
}

interface SideChatMessage {
  id: string;
  direction: 'in' | 'out';
  kind: string;
  text?: string;
  quotedProviderMessageId?: string;
  reactions: Array<{ emoji: string; actor: string }>;
  createdAt: string;
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await authedFetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers || {}) },
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text().catch(() => res.statusText)}`);
  return res.json() as Promise<T>;
}

function statusChip(status: ConnectionEntry['status']) {
  if (status === 'connected') return <span className="chip">connected</span>;
  if (status === 'connecting') return <span className="chip amber">connecting…</span>;
  if (status === 'error') return <span className="chip amber">error</span>;
  return <span className="chip muted">disconnected</span>;
}

export function MessagingChannelsPanel() {
  const [connections, setConnections] = useState<ConnectionEntry[]>([]);
  const [sideChats, setSideChats] = useState<SideChatEntry[]>([]);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  // Connect-flow state for the provider currently being connected.
  const [flow, setFlow] = useState<{ providerId: string; begin: ConnectBegin } | null>(null);
  const [credValues, setCredValues] = useState<Record<string, string>>({});
  const [settingValues, setSettingValues] = useState<Record<string, string>>({});
  const [webhookSecret, setWebhookSecret] = useState('');
  // Side-chat viewer.
  const [openChat, setOpenChat] = useState<SideChatEntry | null>(null);
  const [messages, setMessages] = useState<SideChatMessage[]>([]);

  const load = useCallback(async () => {
    try {
      const [conn, chats] = await Promise.all([
        apiJson<{ ok: boolean; connections: ConnectionEntry[] }>('/api/messaging/connections'),
        apiJson<{ ok: boolean; sideChats: SideChatEntry[] }>('/api/messaging/side-chats'),
      ]);
      setConnections(conn.connections);
      setSideChats(chats.sideChats);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const beginConnect = async (providerId: string) => {
    setBusy(providerId);
    setWebhookSecret('');
    try {
      const begin = await apiJson<ConnectBegin & { ok: boolean }>(`/api/messaging/connections/${providerId}/connect/begin`, { method: 'POST', body: '{}' });
      setFlow({ providerId, begin });
      setCredValues({});
      setSettingValues({});
      await load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const completeConnect = async () => {
    if (!flow) return;
    setBusy(flow.providerId);
    try {
      const done = await apiJson<{ ok: boolean; webhookSecret: string }>(
        `/api/messaging/connections/${flow.providerId}/connect/complete`,
        { method: 'POST', body: JSON.stringify({ flowId: flow.begin.flowId, credentials: credValues, settings: settingValues }) },
      );
      setWebhookSecret(done.webhookSecret);
      setFlow(null);
      setCredValues({});
      setNotice('Connected. Copy the webhook secret now — register it with the provider; it is shown only once.');
      await load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const disconnect = async (providerId: string) => {
    setBusy(providerId);
    try {
      await apiJson(`/api/messaging/connections/${providerId}/disconnect`, { method: 'POST', body: '{}' });
      setNotice(`Disconnected ${providerId}. Its stored credential was removed.`);
      await load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const openSideChat = async (chat: SideChatEntry) => {
    setOpenChat(chat);
    try {
      const data = await apiJson<{ ok: boolean; messages: SideChatMessage[] }>(`/api/messaging/side-chats/${encodeURIComponent(chat.id)}/messages`);
      setMessages(data.messages);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h2>Messaging channels</h2>
      <p className="muted small">
        Connect a messaging app once, securely. Approvals on a channel are decided only by tapping the
        structured buttons on the approval card — a typed “yes” is never treated as a decision.
      </p>
      {notice && <p className="small muted">{notice}</p>}
      {webhookSecret && (
        <p className="small">
          Webhook secret (shown once): <code>{webhookSecret}</code>
        </p>
      )}
      {connections.map((c) => (
        <div key={c.providerId} style={{ borderTop: '1px solid var(--border, #ddd)', padding: '10px 0' }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <strong>{c.displayName}</strong>
            {statusChip(c.status)}
            {c.connectedAt && <span className="small muted">since {new Date(c.connectedAt).toLocaleString()}</span>}
            {Object.entries(c.settings).map(([k, v]) => (
              <span key={k} className="small muted">{k}: {v}</span>
            ))}
            <span style={{ flex: 1 }} />
            {c.status === 'connected' ? (
              <button type="button" className="btn btn-sm" disabled={busy === c.providerId} onClick={() => void disconnect(c.providerId)}>
                Disconnect
              </button>
            ) : (
              <button type="button" className="btn btn-sm btn-primary" disabled={busy === c.providerId} onClick={() => void beginConnect(c.providerId)}>
                Connect
              </button>
            )}
          </div>
          {c.lastError && <p className="small muted">Last error: {c.lastError}</p>}
          {flow?.providerId === c.providerId && (
            <div style={{ marginTop: 8 }}>
              <ol className="small muted" style={{ margin: '4px 0 8px 18px' }}>
                {flow.begin.steps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
              {flow.begin.credentialFields.map((f) => (
                <div key={f.key} style={{ marginBottom: 6 }}>
                  <label className="small muted">{f.label}</label>
                  <input
                    className="input"
                    style={{ width: '100%' }}
                    type={f.secret ? 'password' : 'text'}
                    autoComplete="off"
                    value={credValues[f.key] ?? ''}
                    onChange={(e) => setCredValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  />
                </div>
              ))}
              {flow.begin.settingFields.map((f) => (
                <div key={f.key} style={{ marginBottom: 6 }}>
                  <label className="small muted">{f.label}</label>
                  <input
                    className="input"
                    style={{ width: '100%' }}
                    value={settingValues[f.key] ?? ''}
                    onChange={(e) => setSettingValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  />
                </div>
              ))}
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" className="btn btn-sm btn-primary" disabled={busy === c.providerId} onClick={() => void completeConnect()}>
                  Complete connection
                </button>
                <button type="button" className="btn btn-sm" onClick={() => setFlow(null)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      ))}

      <h3 style={{ marginTop: 20 }}>Side chats</h3>
      <p className="muted small">
        One durable transcript per provider conversation, mirrored exactly once and kept separate from
        your main chat history.
      </p>
      {sideChats.length === 0 && <p className="small muted">No channel conversations yet.</p>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {sideChats.map((chat) => (
          <button
            key={chat.id}
            type="button"
            className={`btn btn-sm${openChat?.id === chat.id ? ' btn-primary' : ''}`}
            onClick={() => void openSideChat(chat)}
          >
            {chat.title} · {chat.messageCount}
          </button>
        ))}
      </div>
      {openChat && (
        <div style={{ marginTop: 12 }}>
          {messages.map((m) => (
            <div key={m.id} className="small" style={{ marginBottom: 6 }}>
              <span className="muted">{m.direction === 'in' ? '←' : '→'} {new Date(m.createdAt).toLocaleTimeString()} · {m.kind}</span>{' '}
              {m.quotedProviderMessageId && <span className="muted">(replying to a quoted message) </span>}
              <span>{m.text ?? ''}</span>{' '}
              {m.reactions.map((r) => (
                <span key={`${r.actor}-${r.emoji}`}>{r.emoji}</span>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
