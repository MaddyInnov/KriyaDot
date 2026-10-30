// SPDX-License-Identifier: Apache-2.0
// Pre-call script sheet (Muse parity §4.10 CT-3): what the user reviews
// BEFORE approving an outbound call — the voice pick, the AI-disclosure
// opening line, the talking points the agent must cover, the guardrails it
// must not cross, and the closing line. Pure presentational component:
// edits are reported through onPatch and applied server-side
// (PATCH /api/calls/briefs/:id/script-sheet); nothing here dials.

'use client';

import React from 'react';

export interface ScriptSheetData {
  counterpartyName: string;
  purpose: string;
  openingLine: string;
  talkingPoints: string[];
  guardrails: string[];
  closingLine: string;
  voiceId?: string;
  callerType: 'ai';
}

export interface ScriptSheetVoiceOption {
  id: string;
  label: string;
}

export interface PreCallScriptSheetProps {
  sheet: ScriptSheetData;
  voices?: ScriptSheetVoiceOption[];
  /** When set, fields are editable and report changes upward. */
  onPatch?: (patch: Partial<Pick<ScriptSheetData, 'voiceId' | 'openingLine' | 'closingLine' | 'talkingPoints'>>) => void;
}

/** One-line summary used in approval cards / brief lists. */
export function scriptSheetSummary(sheet: ScriptSheetData): string {
  return `Call to ${sheet.counterpartyName} about ${sheet.purpose} — ${sheet.talkingPoints.length} talking point${sheet.talkingPoints.length === 1 ? '' : 's'}${sheet.voiceId ? `, voice ${sheet.voiceId}` : ''}.`;
}

export default function PreCallScriptSheet({ sheet, voices = [], onPatch }: PreCallScriptSheetProps) {
  const editable = Boolean(onPatch);
  return (
    <section aria-label="Pre-call script sheet" className="script-sheet">
      <header>
        <h3>Before this call</h3>
        <p>
          AI caller → {sheet.counterpartyName}. Purpose: {sheet.purpose}
        </p>
      </header>

      <label>
        Voice
        {editable && voices.length > 0 ? (
          <select
            aria-label="Call voice"
            value={sheet.voiceId ?? ''}
            onChange={(e) => onPatch?.({ voiceId: e.target.value || undefined })}
          >
            <option value="">Default voice</option>
            {voices.map((v) => (
              <option key={v.id} value={v.id}>{v.label}</option>
            ))}
          </select>
        ) : (
          <span>{sheet.voiceId ?? 'Default voice'}</span>
        )}
      </label>

      <div>
        <h4>Opening line (includes the AI disclosure)</h4>
        {editable ? (
          <textarea
            aria-label="Opening line"
            value={sheet.openingLine}
            onChange={(e) => onPatch?.({ openingLine: e.target.value })}
          />
        ) : (
          <p>{sheet.openingLine}</p>
        )}
      </div>

      <div>
        <h4>Talking points</h4>
        <ol>
          {sheet.talkingPoints.map((point, i) => (
            <li key={i}>{point}</li>
          ))}
        </ol>
      </div>

      <div>
        <h4>Guardrails</h4>
        <ul>
          {sheet.guardrails.map((g, i) => (
            <li key={i}>{g}</li>
          ))}
        </ul>
      </div>

      <div>
        <h4>Closing line</h4>
        {editable ? (
          <textarea
            aria-label="Closing line"
            value={sheet.closingLine}
            onChange={(e) => onPatch?.({ closingLine: e.target.value })}
          />
        ) : (
          <p>{sheet.closingLine}</p>
        )}
      </div>
    </section>
  );
}
