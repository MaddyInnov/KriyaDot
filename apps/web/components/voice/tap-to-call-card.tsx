// SPDX-License-Identifier: Apache-2.0
// Tap-to-call card (Muse parity §4.10 CT-6): the packaged "call from my
// number" affordance. The card carries the server-built payload
// (POST /api/calls/../phone-sms tap-to-call-card, see phone-sms.ts):
// a tel: deep link for clients that can dial natively, and the phone-agent
// dispatch the button performs. Tapping the button does NOT dial directly
// — it invokes onDial, whose handler raises the governance approval for
// `call_from_my_number` first (the card's note says so, in plain words).

'use client';

import React from 'react';

export interface TapToCallCardData {
  kind: 'tap-to-call';
  title: string;
  counterpartyName?: string;
  number: string;
  telUri: string;
  dispatch: { action: 'call'; params: { number: string; contact?: string } };
  note: string;
}

export interface TapToCallCardProps {
  card: TapToCallCardData;
  /** Called when the user taps the dial button (approval flow starts there). */
  onDial?: (card: TapToCallCardData) => void;
}

export default function TapToCallCard({ card, onDial }: TapToCallCardProps) {
  return (
    <section aria-label="Tap to call" className="tap-to-call-card">
      <h3>{card.title}</h3>
      <p className="tap-to-call-number">{card.number}</p>
      <p className="tap-to-call-note">{card.note}</p>
      <div className="tap-to-call-actions">
        <button type="button" onClick={() => onDial?.(card)}>
          📞 Call from my number
        </button>
        <a href={card.telUri}>Open in phone dialer</a>
      </div>
    </section>
  );
}
