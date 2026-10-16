// SPDX-License-Identifier: Apache-2.0
// Bot-to-bot notice rows + conversation sheet (Codync parity).
//
// When a bot calls ask_bot / message_bot, the tool block renders as a compact
// centered row — "→ Messaged Coder" / "✓ Asked Scout → got reply" — instead of
// the generic tool details. One tap opens the read-only pair conversation
// sheet (author-labelled bubbles, time separators, pending/failed states).

'use client';

import { useCallback, useEffect, useState } from 'react';
import { fetchBotConversation, type BotExchangeDto } from '../../lib/api';
import { ProvenanceChip } from '../provenance-chip';

export interface BotNoticeData {
  type: 'ask' | 'message';
  sourceBotId: string;
  targetBotId: string;
  text: string;
  reply?: string;
  status: 'pending' | 'completed' | 'failed';
}

function botName(bots: Array<{ id: string; name: string }>, id: string): string {
  return bots.find((b) => b.id === id)?.name ?? id;
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function preview(text: string, n = 90): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** Compact centered notice row for an ask_bot / message_bot tool call. */
export function BotNoticeRow({
  notice,
  bots,
  onOpenSheet,
}: {
  notice: BotNoticeData;
  bots: Array<{ id: string; name: string }>;
  onOpenSheet: (peerId: string) => void;
}) {
  const target = botName(bots, notice.targetBotId);
  const failed = notice.status === 'failed';
  const label =
    notice.type === 'ask' ? `Asked ${target}` : `Messaged ${target}`;
  return (
    <button
      type="button"
      className={`bot-notice${failed ? ' failed' : ''}`}
      onClick={() => onOpenSheet(notice.targetBotId)}
      title={failed ? 'Failed — tap for details' : 'Tap to open conversation'}
    >
      <span className="bot-notice-icon" aria-hidden="true">
        {notice.type === 'ask' ? '❓' : '💬'}
      </span>
      <span className="bot-notice-label">
        {failed && <span aria-hidden="true">⚠️ </span>}
        {label}
      </span>
      <span className="bot-notice-preview">{preview(notice.text)}</span>
      {notice.type === 'ask' && notice.reply && (
        <span className="bot-notice-reply">→ {preview(notice.reply, 60)}</span>
      )}
    </button>
  );
}

/** Read-only pair conversation sheet: the two bots' whole exchange history. */
export function BotConversationSheet({
  botId,
  peerId,
  peerName,
  onClose,
}: {
  botId: string;
  peerId: string;
  peerName: string;
  onClose: () => void;
}) {
  const [exchanges, setExchanges] = useState<BotExchangeDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    fetchBotConversation(botId, peerId)
      .then(setExchanges)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [botId, peerId]);

  useEffect(() => {
    load();
  }, [load]);

  let lastDay = '';
  return (
    <div className="sheet-backdrop" onClick={onClose} role="presentation">
      <div
        className="sheet bot-conv-sheet"
        role="dialog"
        aria-label={`Conversation with ${peerName}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-head">
          <h3>
            {botId} ⇄ {peerName}
          </h3>
          <button type="button" className="btn btn-sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="sheet-body">
          {error && <p className="error">{error}</p>}
          {exchanges === null && !error && <p className="muted">Loading…</p>}
          {exchanges !== null && exchanges.length === 0 && (
            <p className="muted">No exchanges yet.</p>
          )}
          {exchanges?.map((ex) => {
            const day = new Date(ex.createdAt).toDateString();
            const showDay = day !== lastDay;
            lastDay = day;
            const outgoing = ex.sourceBotId === botId;
            return (
              <div key={ex.id}>
                {showDay && <div className="day-sep">{fmtTime(ex.createdAt).split(',')[0]}</div>}
                <div className={`conv-bubble${outgoing ? ' out' : ' in'}`}>
                  <div className="conv-author">
                    {outgoing ? '→' : '←'} {ex.sourceBotId}
                    <span className="conv-kind">{ex.type === 'ask' ? 'asked' : 'messaged'}</span>
                    <ProvenanceChip note={ex.provenance} compact />
                  </div>
                  <div className="conv-text">{ex.text}</div>
                  {ex.reply && <div className="conv-reply">↳ {ex.reply}</div>}
                  {ex.status === 'pending' && (
                    <div className="conv-status pending">Waiting for {ex.targetBotId}…</div>
                  )}
                  {ex.status === 'failed' && (
                    <div className="conv-status failed">⚠️ {ex.detail ?? 'Failed'}</div>
                  )}
                  <div className="conv-time">{fmtTime(ex.createdAt)}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
