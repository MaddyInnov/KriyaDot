// SPDX-License-Identifier: Apache-2.0
// Static render tests for the Wave-4 call UI pieces: the pre-call script
// sheet (CT-3) and the tap-to-call card (CT-6). Same react-dom/server
// pattern as voice-ui.test.tsx — no jsdom needed.
import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import PreCallScriptSheet, { scriptSheetSummary, type ScriptSheetData } from './pre-call-script-sheet';
import TapToCallCard, { type TapToCallCardData } from './tap-to-call-card';

const sheet: ScriptSheetData = {
  counterpartyName: 'Acme Dental',
  purpose: 'reschedule the cleaning appointment',
  openingLine: 'Hello, this is Scout, an AI assistant calling on behalf of my user.',
  talkingPoints: ['Ask for a morning slot next week', 'Confirm the address'],
  guardrails: ['Never claim to be a human being.'],
  closingLine: 'Thank you for your time. Goodbye.',
  voiceId: 'voice-9',
  callerType: 'ai',
};

describe('PreCallScriptSheet (CT-3)', () => {
  it('renders voice, opening, points, guardrails and closing', () => {
    const html = renderToStaticMarkup(React.createElement(PreCallScriptSheet, { sheet }));
    expect(html).toContain('aria-label="Pre-call script sheet"');
    expect(html).toContain('Acme Dental');
    expect(html).toContain('voice-9');
    expect(html).toContain('AI assistant calling on behalf');
    expect(html).toContain('Ask for a morning slot next week');
    expect(html).toContain('Never claim to be a human being.');
    expect(html).toContain('Thank you for your time. Goodbye.');
  });

  it('renders a voice picker when editable with voices', () => {
    const html = renderToStaticMarkup(
      React.createElement(PreCallScriptSheet, {
        sheet,
        voices: [{ id: 'voice-9', label: 'Warm (voice-9)' }, { id: 'voice-2', label: 'Crisp' }],
        onPatch: () => {},
      }),
    );
    expect(html).toContain('aria-label="Call voice"');
    expect(html).toContain('Warm (voice-9)');
    expect(html).toContain('aria-label="Opening line"');
  });

  it('summarizes the sheet in one line', () => {
    expect(scriptSheetSummary(sheet)).toContain('2 talking points');
    expect(scriptSheetSummary(sheet)).toContain('voice voice-9');
  });
});

describe('TapToCallCard (CT-6)', () => {
  const card: TapToCallCardData = {
    kind: 'tap-to-call',
    title: 'Call Acme Dental',
    counterpartyName: 'Acme Dental',
    number: '+15550102233',
    telUri: 'tel:+15550102233',
    dispatch: { action: 'call', params: { number: '+15550102233', contact: 'Acme Dental' } },
    note: 'Dials from your own number via your paired phone. Tapping raises an approval first.',
  };

  it('renders the title, number, approval note, dial button and tel: link', () => {
    const html = renderToStaticMarkup(React.createElement(TapToCallCard, { card }));
    expect(html).toContain('aria-label="Tap to call"');
    expect(html).toContain('Call Acme Dental');
    expect(html).toContain('+15550102233');
    expect(html).toContain('raises an approval first');
    expect(html).toContain('Call from my number');
    expect(html).toContain('href="tel:+15550102233"');
  });
});
