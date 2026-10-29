// SPDX-License-Identifier: Apache-2.0
// Pinned messages banner (chat polish): shows the open thread's pinned
// messages; clicking one scrolls to it, ✕ unpins it.

'use client';

import React from 'react';
import type { PinnedChatMessage } from '../../lib/api';

export interface PinnedBannerProps {
  pins: PinnedChatMessage[];
  onJump: (pin: PinnedChatMessage) => void;
  onUnpin: (pin: PinnedChatMessage) => void;
}

export function PinnedBanner({ pins, onJump, onUnpin }: PinnedBannerProps) {
  if (pins.length === 0) return null;
  return (
    <div className="pinned-banner" aria-label="Pinned messages"
      style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 10px', borderBottom: '1px solid var(--border, #2a2a35)' }}>
      {pins.map((pin) => (
        <div key={pin.messageId} className="pinned-item" style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
          <span aria-hidden="true">📌</span>
          <button type="button" className="linklike pinned-text" onClick={() => onJump(pin)}
            title="Jump to pinned message" style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {(pin.text ?? pin.messageId).slice(0, 120)}
          </button>
          <button type="button" className="icon-btn xs" onClick={() => onUnpin(pin)} aria-label="Unpin message" title="Unpin">✕</button>
        </div>
      ))}
    </div>
  );
}
