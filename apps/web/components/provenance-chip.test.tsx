// SPDX-License-Identifier: Apache-2.0
// Tests for the provenance chip components (P1 #13). Rendering is done via
// React.createElement (this repo's vitest setup doesn't transform JSX in
// test files); type-checking covers the component files themselves.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ProvenanceChip,
  PeerOriginSecurityNote,
  formatRelayChip,
  isUntrustedOrigin,
  type ProvenanceNoteDto,
} from './provenance-chip';

const note: ProvenanceNoteDto = {
  origin: 'bot',
  originBotId: 'scout',
  originBotName: 'Scout',
  relayPath: ['scout', 'coder'],
  relayNames: ['Scout', 'Coder'],
  timestamp: '2026-10-16T00:00:00.000Z',
};

describe('formatRelayChip', () => {
  it('renders "via Scout → Coder"', () => {
    expect(formatRelayChip(note)).toBe('via Scout → Coder');
  });
  it('falls back to ids', () => {
    expect(formatRelayChip({ ...note, relayNames: undefined })).toBe('via scout → coder');
  });
});

describe('isUntrustedOrigin', () => {
  it('marks non-user origins untrusted', () => {
    expect(isUntrustedOrigin(note)).toBe(true);
    expect(isUntrustedOrigin({ ...note, origin: 'user' })).toBe(false);
    expect(isUntrustedOrigin(undefined)).toBe(false);
    expect(isUntrustedOrigin(null)).toBe(false);
  });
});

describe('ProvenanceChip', () => {
  it('renders the relay path and untrusted badge', () => {
    const html = renderToStaticMarkup(React.createElement(ProvenanceChip, { note }));
    expect(html).toContain('via Scout → Coder');
    expect(html).toContain('untrusted origin');
  });
  it('renders nothing without a note', () => {
    expect(renderToStaticMarkup(React.createElement(ProvenanceChip, { note: undefined }))).toBe('');
  });
  it('shows a calm label for user origin', () => {
    const html = renderToStaticMarkup(
      React.createElement(ProvenanceChip, { note: { ...note, origin: 'user' } }),
    );
    expect(html).not.toContain('untrusted origin');
  });
});

describe('PeerOriginSecurityNote', () => {
  it('shows the origin chain and consent reminder', () => {
    const html = renderToStaticMarkup(React.createElement(PeerOriginSecurityNote, { note }));
    expect(html).toContain('Origin chain:');
    expect(html).toContain('via Scout → Coder');
    expect(html).toMatch(/never.*your approval/i);
  });
  it('renders nothing without a note', () => {
    expect(renderToStaticMarkup(React.createElement(PeerOriginSecurityNote, { note: undefined }))).toBe(
      '',
    );
  });
});
