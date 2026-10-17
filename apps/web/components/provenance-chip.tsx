// SPDX-License-Identifier: Apache-2.0
// Provenance chips (OpenMausBot parity P1 #13): show where a cross-bot
// message came from — a small "via Scout → Coder" chip plus an origin
// badge. Anything not from the human user gets an untrusted-origin badge.

'use client';

import React from 'react';

/** Mirrors ProvenanceNote in @mvp/agent-runtime (JSON round-trip shape). */
export interface ProvenanceNoteDto {
  origin: 'user' | 'bot' | 'external' | 'webhook' | 'routine';
  originBotId?: string;
  originBotName?: string;
  relayPath: string[];
  relayNames?: string[];
  timestamp: string;
  /** Guarded external messages: relayed from an external source. */
  relayed?: boolean;
}

const ORIGIN_META: Record<string, { icon: string; label: string }> = {
  user: { icon: '👤', label: 'you' },
  bot: { icon: '🤖', label: 'bot' },
  external: { icon: '🌐', label: 'external agent' },
  webhook: { icon: '🪝', label: 'webhook' },
  routine: { icon: '🔁', label: 'routine' },
};

export function formatRelayChip(note: ProvenanceNoteDto): string {
  const parts =
    note.relayNames && note.relayNames.length === note.relayPath.length
      ? note.relayNames
      : note.relayPath;
  if (parts.length === 0) return 'via unknown';
  return `via ${parts.join(' → ')}`;
}

export function isUntrustedOrigin(note: ProvenanceNoteDto | undefined | null): boolean {
  return !!note && note.origin !== 'user';
}

/**
 * Small provenance chip: "via Scout → Coder" + origin badge. Renders
 * nothing when there is no provenance note.
 */
export function ProvenanceChip({ note, compact }: { note?: ProvenanceNoteDto | null; compact?: boolean }) {
  if (!note) return null;
  const meta = ORIGIN_META[note.origin] ?? { icon: '❓', label: note.origin };
  const untrusted = isUntrustedOrigin(note);
  return (
    <span className="prov-chip" title={`Origin: ${meta.label} · ${formatRelayChip(note)} · ${note.timestamp}`}>
      <span aria-hidden="true">{meta.icon}</span>{' '}
      <span className="prov-relay">{formatRelayChip(note)}</span>
      {note.relayed === true && (
        <span className="prov-relayed" title="Relayed from an external source — can never satisfy an approval">
          📨 relayed
        </span>
      )}
      {!compact && (
        <span className={`prov-origin${untrusted ? ' untrusted' : ''}`}>
          {untrusted ? '⚠️ untrusted origin' : meta.label}
        </span>
      )}
    </span>
  );
}

/**
 * Security note for peer-approval cards: shows the origin chain of the
 * content that led the sender bot to make this request, plus the consent
 * rule reminder.
 */
export function PeerOriginSecurityNote({ note }: { note?: ProvenanceNoteDto | null }) {
  if (!note) return null;
  return (
    <div className="prov-security-note small" role="note">
      <span aria-hidden="true">🔒</span>{' '}
      <strong>Origin chain:</strong> {formatRelayChip(note)} ({ORIGIN_META[note.origin]?.label ?? note.origin}).
      {' '}A bot&apos;s message is <strong>never</strong> your approval — decide this yourself.
    </div>
  );
}
