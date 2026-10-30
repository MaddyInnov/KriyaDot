// SPDX-License-Identifier: Apache-2.0
'use client';

/**
 * Unified chat history (Front Door spec Part 4): merges GET
 * /api/sync/history into the history view. Cloud-origin sessions carry
 * a "Cloud" badge and open READ-ONLY — sync is for history/visibility,
 * never live co-execution: the composer is replaced by a notice plus a
 * "Continue in cloud" button opening the user's instance URL (from
 * GET /api/sync/status). Local sessions render unchanged.
 */

import React, { useCallback, useEffect, useState } from 'react';
import type { ChatThreadMessage } from '../../lib/api';
import {
  getSyncHistory,
  getSyncSessionMessages,
  getSyncStatus,
  type SyncHistorySession,
} from '../../lib/frontdoor';

export function CloudBadge() {
  return (
    <span className="cloud-badge" title="This chat lives in your cloud">
      ☁️ Cloud
    </span>
  );
}

export function CloudSessionReadOnly({
  session,
  instanceUrl,
}: {
  session: SyncHistorySession;
  instanceUrl?: string;
}) {
  const [messages, setMessages] = useState<ChatThreadMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getSyncSessionMessages(session.sessionId)
      .then((res) => {
        if (!cancelled) setMessages(res.messages ?? []);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session.sessionId]);

  return (
    <div className="cloud-session-view" data-testid="cloud-session-view">
      <div className="cloud-session-head">
        <CloudBadge />
        <span className="small muted">
          {session.messageCount} message{session.messageCount === 1 ? '' : 's'} · last activity{' '}
          {session.lastMessageTs ? new Date(session.lastMessageTs).toLocaleString() : '—'}
        </span>
      </div>
      {loading && <p className="small muted">Loading history…</p>}
      {error && <div className="error-box">{error}</div>}
      <div className="cloud-session-messages">
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role === 'user' ? 'user' : 'assistant'}`}>
            <div className="msg-text">{m.content}</div>
          </div>
        ))}
        {!loading && !error && messages.length === 0 && (
          <p className="small muted">No messages stored for this session yet.</p>
        )}
      </div>
      {/* Read-only: the composer is replaced by this notice. */}
      <div className="cloud-readonly-notice" role="note">
        <p className="small" style={{ margin: '0 0 8px' }}>
          This chat lives in your cloud — history is read-only here
        </p>
        {instanceUrl ? (
          <a className="btn btn-primary btn-sm" href={instanceUrl} target="_blank" rel="noreferrer">
            Continue in cloud ↗
          </a>
        ) : (
          <p className="small muted" style={{ margin: 0 }}>
            Connect your cloud to continue this chat on your instance.
          </p>
        )}
      </div>
    </div>
  );
}

export function CloudSessionsPanel() {
  const [sessions, setSessions] = useState<SyncHistorySession[]>([]);
  const [instanceUrl, setInstanceUrl] = useState<string | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [history, status] = await Promise.all([getSyncHistory(), getSyncStatus()]);
      setSessions(history.sessions ?? []);
      setInstanceUrl(status.instanceUrl);
      setUnavailable(false);
    } catch {
      // Sync hub not configured/reachable on this instance yet — the
      // local history below it is unaffected.
      setSessions([]);
      setUnavailable(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const cloudSessions = sessions.filter((s) => s.origin === 'cloud');
  const selected = cloudSessions.find((s) => s.sessionId === selectedId) ?? null;

  return (
    <section className="panel cloud-sessions-panel" aria-label="Cloud chat history" style={{ marginTop: 16 }}>
      <div className="panel-head">
        <h3>☁️ Chats from your cloud</h3>
        <button type="button" className="btn-ghost small" onClick={() => void refresh()} disabled={loading}>
          Refresh
        </button>
      </div>
      {loading && <p className="muted small">Loading…</p>}
      {!loading && unavailable && (
        <p className="muted small">
          Cloud history is unavailable — connect your cloud in Settings → Cloud sync &amp; website
          and cloud chats will appear here, read-only.
        </p>
      )}
      {!loading && !unavailable && cloudSessions.length === 0 && (
        <p className="muted small">No cloud chats yet. Chats that run on your cloud instance appear here.</p>
      )}
      {cloudSessions.map((s) => (
        <button
          key={s.sessionId}
          type="button"
          className={`bot-item${selectedId === s.sessionId ? ' selected' : ''}`}
          onClick={() => setSelectedId(s.sessionId)}
          aria-pressed={selectedId === s.sessionId}
          style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 8, textAlign: 'left' }}
        >
          <span style={{ flex: 1, minWidth: 0 }}>
            <span className="bot-name">{s.botId}</span>
            <span className="bot-desc">
              {s.messageCount} message{s.messageCount === 1 ? '' : 's'}
              {s.lastMessageTs ? ` · ${new Date(s.lastMessageTs).toLocaleString()}` : ''}
            </span>
          </span>
          <CloudBadge />
        </button>
      ))}
      {selected && <CloudSessionReadOnly session={selected} instanceUrl={instanceUrl} />}
    </section>
  );
}
