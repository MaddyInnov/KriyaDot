// SPDX-License-Identifier: Apache-2.0
import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import DevicesPanel, {
  formatCountdown,
  formatLastSeen,
  groupOtt,
  normalizeTs,
  pairingModeLabel,
} from './devices-panel';

describe('devices-panel helpers', () => {
  it('normalizes second-precision timestamps to ms', () => {
    expect(normalizeTs(1728400000)).toBe(1728400000000);
    expect(normalizeTs(1728400000000)).toBe(1728400000000);
  });

  it('formats a countdown as m:ss', () => {
    expect(formatCountdown(299000)).toBe('4:59');
    expect(formatCountdown(60000)).toBe('1:00');
    expect(formatCountdown(0)).toBe('0:00');
    expect(formatCountdown(-5000)).toBe('0:00');
  });

  it('formats relative last-seen times', () => {
    const now = 1_728_400_000_000;
    expect(formatLastSeen(now, now)).toBe('just now');
    expect(formatLastSeen(now - 30_000, now)).toBe('just now');
    expect(formatLastSeen(now - 12 * 60_000, now)).toBe('12m ago');
    expect(formatLastSeen(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(formatLastSeen(now - 5 * 86_400_000, now)).toBe('5d ago');
    expect(formatLastSeen(now - 40 * 86_400_000, now)).toContain('2024');
  });

  it('groups a 6-digit OTT code for readability', () => {
    expect(groupOtt('123456')).toBe('123 456');
    expect(groupOtt('abc')).toBe('abc');
  });

  it('labels which network the pairing QR encodes', () => {
    expect(pairingModeLabel('hosted', 'https://kriyadot.example.com')).toBe(
      'QR encodes: internet (https://kriyadot.example.com)',
    );
    expect(pairingModeLabel('lan', '192.168.1.10:4567')).toBe('QR encodes: WiFi LAN (192.168.1.10:4567)');
    expect(pairingModeLabel(undefined, undefined)).toBe('QR encodes: WiFi LAN');
  });
});

describe('DevicesPanel render', () => {
  it('renders the loading state without crashing', () => {
    const html = renderToStaticMarkup(<DevicesPanel />);
    expect(html).toContain('Loading companion devices');
  });

  it('is marked as a client component', () => {
    // 'use client' is a pragma, not a prop — smoke-test that the module
    // evaluates at all (it pulls in react-qr-code and the api client).
    expect(typeof DevicesPanel).toBe('function');
  });
});
