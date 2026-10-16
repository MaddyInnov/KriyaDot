// SPDX-License-Identifier: Apache-2.0
// Group chat room view: transcript with author labels, @mention highlighting,
// composer, and per-message thread entry points (reuses the thread panel).

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  listGroupMessages,
  renderWithMentions,
  sendGroupMessage,
  stopGroupTurn,
  type GroupChat,
  type GroupMessage,
  type RoomTurnReply,
} from '../../lib/group-chats';

interface Props {
  group: GroupChat;
  /** botId → display name, for author labels. */
  botNames: Map<string, string>;
  /** Open the thread panel for a group message (reuses message-threads UI). */
  onOpenThread?: (groupId: string, messageId: string, existingThreadId: string | null) => void;
  onDeleted?: () => void;
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function MessageBody({ text, memberNames }: { text: string; memberNames: string[] }) {
  const parts = renderWithMentions(text, memberNames);
  return (
    <>
      {parts.map((p, i) =>
        p.isMention ? (
          <span key={i} className="mention">
            {p.text}
          </span>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

export function GroupChatView({ group, botNames, onOpenThread }: Props) {
  const [messages, setMessages] = useState<GroupMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveReply, setLiveReply] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const memberNames = group.memberBotIds.map((id) => botNames.get(id) ?? id);

  const load = useCallback(async () => {
    try {
      setMessages(await listGroupMessages(group.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load messages.');
    }
  }, [group.id]);

  useEffect(() => {
    setMessages([]);
    setError(null);
    setDraft('');
    load();
  }, [group.id, load]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, liveReply]);

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    setDraft('');
    // Optimistic user message.
    const optimistic: GroupMessage = {
      id: `local-${Date.now()}`,
      groupId: group.id,
      authorType: 'user',
      authorBotId: null,
      text,
      threadId: null,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimistic]);
    setLiveReply('Waiting for the room…');
    try {
      const result = await sendGroupMessage(group.id, text);
      // Replace optimistic + append authoritative transcript.
      const fresh = await listGroupMessages(group.id);
      setMessages(fresh);
      if (result.stoppedEarly) {
        setError('Room turn was stopped early.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to send.');
      // Roll back the optimistic message on failure.
      setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
      setDraft(text);
    } finally {
      setSending(false);
      setLiveReply(null);
    }
  };

  const stop = async () => {
    try {
      await stopGroupTurn(group.id);
    } catch {
      // Best effort; the turn ends on its own.
    }
  };

  return (
    <div className="group-chat">
      <div className="group-chat-header">
        <div>
          <h2 className="group-name">{group.name}</h2>
          {group.description && <div className="small muted">{group.description}</div>}
          <div className="small muted group-members-line">
            👥 {memberNames.join(', ')}
          </div>
        </div>
      </div>

      <div className="msg-list" role="log" aria-label={`${group.name} messages`}>
        {messages.map((m) => {
          const authorLabel =
            m.authorType === 'user' ? 'You' : (botNames.get(m.authorBotId ?? '') ?? 'Bot');
          return (
            <div key={m.id} className={`msg-row${m.authorType === 'user' ? ' mine' : ''}`}>
              <div className="msg-head">
                <span className="msg-author">{authorLabel}</span>
                <span className="msg-time">{fmtTime(m.createdAt)}</span>
                {onOpenThread && (
                  <button
                    className="icon-btn xs msg-thread-btn"
                    title="Reply in thread"
                    aria-label={`Reply in thread to message from ${authorLabel}`}
                    onClick={() => onOpenThread(group.id, m.id, m.threadId)}
                  >
                    🧵
                  </button>
                )}
              </div>
              <div className="msg-text">
                <MessageBody text={m.text} memberNames={memberNames} />
              </div>
              {m.threadId && <div className="small muted">🧵 thread</div>}
            </div>
          );
        })}
        {liveReply && (
          <div className="msg-row">
            <div className="msg-text muted typing">{liveReply}</div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {error && (
        <div className="error small" role="alert">
          {error}
        </div>
      )}

      <div className="chat-input-wrap">
        <div className="chat-input">
          <input
            className="input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={`Message ${group.name} — @name to pick who replies`}
            disabled={sending}
            aria-label={`Message ${group.name}`}
          />
          {sending ? (
            <button className="btn btn-ghost" onClick={stop} title="Stop the room turn">
              ⏹ Stop
            </button>
          ) : (
            <button className="btn btn-primary" onClick={send} disabled={!draft.trim()}>
              Send
            </button>
          )}
        </div>
        <div className="small muted hint">
          Tip: <code>@all</code> or no mentions → everyone replies, up to 3 rounds.
        </div>
      </div>
    </div>
  );
}

/** Re-export for tests. */
export type { RoomTurnReply };
