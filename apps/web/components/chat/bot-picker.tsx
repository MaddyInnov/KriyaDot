// SPDX-License-Identifier: Apache-2.0
// Header bot picker (chrome simplification, 2026-10-31): the current
// interlocutor as one quiet button; clicking it opens a popover listing
// Universal + every bot (name, one-line description, workspace DISPLAY
// NAME — never a raw filesystem path) with the current one checkmarked.
// Replaces the always-visible roster list as the primary way to switch
// bots; the roster keeps its collapsible list as a secondary surface.

'use client';

import { useEffect, useRef, useState } from 'react';
import type { BotConfig } from '../../lib/api';
import { workspaceDisplayName } from '../../lib/sessions-history';

interface BotPickerProps {
  bots: BotConfig[];
  universalMode: boolean;
  /** The selected bot (null while bots load or in Universal with no anchor). */
  selectedBot: BotConfig | null;
  /** Anchor line for Universal, e.g. "Scout · Chief of Staff". */
  universalAnchor?: string;
  onPickUniversal: () => void;
  onPickBot: (bot: BotConfig) => void;
}

export function BotPicker({
  bots,
  universalMode,
  selectedBot,
  universalAnchor,
  onPickUniversal,
  onPickBot,
}: BotPickerProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open ]);

  const currentName = universalMode ? 'Universal' : (selectedBot?.name ?? 'Select bot');

  return (
    <div className="bot-picker" ref={wrapRef}>
      <button
        type="button"
        className="bot-picker-btn"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
        title="Switch bot — Universal routes automatically, or pick a bot directly"
      >
        {universalMode ? (
          <span className="bot-picker-glyph" aria-hidden="true">✦</span>
        ) : selectedBot?.avatarUrl ? (
          <img src={selectedBot.avatarUrl} alt="" width={24} height={24} className="bot-picker-avatar" />
        ) : (
          <span className="bot-picker-glyph" aria-hidden="true">{currentName.charAt(0).toUpperCase()}</span>
        )}
        <span className="bot-picker-name">{currentName}</span>
        <span className="bot-picker-chevron" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="bot-picker-pop" role="listbox" aria-label="Choose a bot">
          <button
            type="button"
            role="option"
            aria-selected={universalMode}
            className={`bot-picker-row${universalMode ? ' current' : ''}`}
            onClick={() => {
              setOpen(false);
              onPickUniversal();
            }}
          >
            <span className="bot-picker-glyph" aria-hidden="true">✦</span>
            <span className="bot-picker-row-main">
              <span className="bot-picker-row-name">Universal</span>
              <span className="bot-picker-row-desc">
                Ask anything — routed automatically
                {universalAnchor ? ` · ${universalAnchor}` : ''}
              </span>
            </span>
            {universalMode && <span className="bot-picker-check" aria-hidden="true">✓</span>}
          </button>
          <div className="bot-picker-sep" role="separator" />
          {bots.map((b) => {
            const current = !universalMode && b.id === selectedBot?.id;
            return (
              <button
                key={b.id}
                type="button"
                role="option"
                aria-selected={current}
                className={`bot-picker-row${current ? ' current' : ''}`}
                onClick={() => {
                  setOpen(false);
                  onPickBot(b);
                }}
              >
                {b.avatarUrl ? (
                  <img src={b.avatarUrl} alt="" width={24} height={24} className="bot-picker-avatar" />
                ) : (
                  <span className="bot-picker-glyph" aria-hidden="true">{b.name.charAt(0).toUpperCase()}</span>
                )}
                <span className="bot-picker-row-main">
                  <span className="bot-picker-row-name">{b.name}</span>
                  {b.description && <span className="bot-picker-row-desc">{b.description}</span>}
                  <span className="bot-picker-row-ws">
                    📁 {b.workspace ? workspaceDisplayName(b.workspace) : 'Shared workspace'}
                  </span>
                </span>
                {current && <span className="bot-picker-check" aria-hidden="true">✓</span>}
              </button>
            );
          })}
          {bots.length === 0 && <div className="bot-picker-empty">Loading bots…</div>}
        </div>
      )}
    </div>
  );
}
