// SPDX-License-Identifier: Apache-2.0
// Message reactions UI (Codync parity): emoji picker on hover, reaction
// chips under messages, click-to-toggle.

'use client';

import { useState } from 'react';
import { REACTION_EMOJIS, type MessageReaction } from '@/lib/api';

interface MessageReactionsProps {
  reactions: MessageReaction[];
  onToggle: (emoji: string) => void;
  disabled?: boolean;
}

/**
 * Reaction picker button + reaction chips for a chat message.
 * Shows a hover picker with common emojis; chips display existing
 * reactions grouped by emoji with counts; clicking a chip toggles
 * the current user's reaction.
 */
export function MessageReactions({
  reactions,
  onToggle,
  disabled,
}: MessageReactionsProps) {
  const [pickerOpen, setPickerOpen] = useState(false);

  const toggle = (emoji: string) => {
    if (disabled) return;
    setPickerOpen(false);
    onToggle(emoji);
  };

  // Group by emoji for chip display.
  const grouped = new Map<string, { count: number; mine: boolean }>();
  for (const r of reactions) {
    const g = grouped.get(r.emoji) ?? { count: 0, mine: false };
    g.count += 1;
    if (r.userId === 'user') g.mine = true;
    grouped.set(r.emoji, g);
  }

  return (
    <div className="msg-reactions">
      <div className="msg-reaction-picker-wrap">
        <button
          type="button"
          className="copy-btn msg-react-btn"
          title="Add reaction"
          aria-label="Add reaction"
          disabled={disabled}
          onClick={(e) => {
            e.stopPropagation();
            setPickerOpen((v) => !v);
          }}
        >
          😊
        </button>
        {pickerOpen && (
          <div className="msg-reaction-picker" onClick={(e) => e.stopPropagation()}>
            {REACTION_EMOJIS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                className="msg-reaction-option"
                onClick={() => toggle(emoji)}
                aria-label={`React with ${emoji}`}
              >
                {emoji}
              </button>
            ))}
          </div>
        )}
      </div>
      {grouped.size > 0 && (
        <div className="msg-reaction-chips">
          {[...grouped.entries()].map(([emoji, { count, mine }]) => (
            <button
              key={emoji}
              type="button"
              className={`msg-reaction-chip${mine ? ' mine' : ''}`}
              title={mine ? 'Click to remove your reaction' : 'Click to add your reaction'}
              disabled={disabled}
              onClick={(e) => {
                e.stopPropagation();
                toggle(emoji);
              }}
            >
              <span>{emoji}</span>
              {count > 1 && <span className="msg-reaction-count">{count}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
