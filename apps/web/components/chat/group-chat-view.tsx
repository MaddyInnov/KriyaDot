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
import { GroupRoomControls } from './group-room-controls';
import { ProvenanceChip } from '../provenance-chip';
import {
  applyMention,
  currentMentionQuery,
  listPeople,
  mentionCandidates,
  type MentionCandidate,
  type Person,
} from '../../lib/people';

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
  const [notice, setNotice] = useState<string | null>(null);
  const [liveReply, setLiveReply] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const memberNames = group.memberBotIds.map((id) => botNames.get(id) ?? id);
  // W7 mention picker: people alongside bots. Bots picked in the room
  // reply; people picked get a team-inbox ping (only that person).
  const [people, setPeople] = useState<Person[]>([]);
  const [pickerIdx, setPickerIdx] = useState(0);
  useEffect(() => {
    void listPeople().then(setPeople).catch(() => setPeople([]));
  }, []);
  const mentionQuery = currentMentionQuery(draft);
  const pickerCandidates: MentionCandidate[] =
    mentionQuery !== null
      ? mentionCandidates(
          group.memberBotIds.map((id) => ({ id, name: botNames.get(id) ?? id })),
          people,
          mentionQuery,
        )
      : [];
  useEffect(() => setPickerIdx(0), [mentionQuery]);

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
    if (!text) return;
    if (sending) {
      // A room turn is in flight: queue behind it (?queue=1) instead of
      // cancelling it. The server runs it when the current turn finishes.
      setDraft('');
      setError(null);
      try {
        const r = await sendGroupMessage(group.id, text, { queue: true });
        setMessages(await listGroupMessages(group.id));
        setNotice(
          r.queued
            ? `Queued #${r.position} — runs when the current turn finishes.`
            : 'Sent.',
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to queue.');
        setDraft(text);
      }
      return;
    }
    setSending(true);
    setError(null);
    setNotice(null);
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
      if (result.timedOut) {
        setError('Room turn timed out — stopping to protect your token budget.');
      } else if (result.breakerTripped) {
        setError(`Anti-spam breaker tripped: ${result.breakerTripped.detail}`);
      } else if (result.stoppedEarly) {
        setError('Room turn was stopped early.');
      }
      if (result.failures && result.failures.length > 0) {
        setNotice(
          `${result.failures.length} member turn${result.failures.length > 1 ? 's' : ''} failed — retry from the room controls below.`,
        );
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
            m.authorType === 'user'
              ? 'You'
              : m.authorType === 'system'
                ? '🛡 Room'
                : (botNames.get(m.authorBotId ?? '') ?? 'Bot');
          return (
            <div key={m.id} className={`msg-row${m.authorType === 'user' ? ' mine' : ''}`}>
              <div className="msg-head">
                <span className="msg-author">{authorLabel}</span>
                {m.authorType === 'bot' && <ProvenanceChip note={m.provenance} compact />}
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
                <MessageBody
                  text={m.text}
                  memberNames={[...memberNames, ...people.map((p) => p.name)]}
                />
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
      {notice && !error && (
        <div className="small muted" role="status">
          {notice}
        </div>
      )}

      <GroupRoomControls key={group.id} groupId={group.id} onTranscriptChanged={load} />

      <div className="chat-input-wrap">
        {pickerCandidates.length > 0 && (
          <div className="card" role="listbox" aria-label="Mention picker" style={{ marginBottom: 6, padding: 4 }}>
            {pickerCandidates.map((c, i) => (
              <button
                key={`${c.kind}:${c.id}`}
                type="button"
                role="option"
                aria-selected={i === pickerIdx}
                className={`btn btn-sm${i === pickerIdx ? ' btn-primary' : ' btn-ghost'}`}
                style={{ display: 'flex', width: '100%', justifyContent: 'space-between', marginBottom: 2 }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setDraft((d) => applyMention(d, c));
                }}
              >
                <span>{c.kind === 'person' ? '👤' : '🤖'} {c.label} <span className="mono small">{c.token}</span></span>
                <span className="small muted">{c.detail}</span>
              </button>
            ))}
          </div>
        )}
        <div className="chat-input">
          <input
            className="input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (pickerCandidates.length > 0 && e.key === 'Tab') {
                e.preventDefault();
                const c = pickerCandidates[Math.min(pickerIdx, pickerCandidates.length - 1)]!;
                setDraft((d) => applyMention(d, c));
                return;
              }
              if (pickerCandidates.length > 0 && e.key === 'ArrowDown') {
                e.preventDefault();
                setPickerIdx((i) => Math.min(i + 1, pickerCandidates.length - 1));
                return;
              }
              if (pickerCandidates.length > 0 && e.key === 'ArrowUp') {
                e.preventDefault();
                setPickerIdx((i) => Math.max(i - 1, 0));
                return;
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={
              sending
                ? `Room is replying — Enter queues behind the turn`
                : `Message ${group.name} — @name to pick who replies`
            }
            aria-label={`Message ${group.name}`}
          />
          {sending && (
            <button className="btn btn-ghost" onClick={stop} title="Stop the room turn">
              ⏹ Stop
            </button>
          )}
          <button className="btn btn-primary" onClick={send} disabled={!draft.trim()}>
            {sending ? 'Queue' : 'Send'}
          </button>
        </div>
        <div className="small muted hint">
          Tip: <code>@all</code> or no mentions → every bot replies, up to 3 rounds. Mention a
          <strong> person</strong> (👤 in the picker) to ping only them in their team inbox. While
          the room is replying, sending queues your message behind the turn.
        </div>
      </div>
    </div>
  );
}

/** Re-export for tests. */
export type { RoomTurnReply };
