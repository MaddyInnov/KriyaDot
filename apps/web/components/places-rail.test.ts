// SPDX-License-Identifier: Apache-2.0
// Places rail persistence tests (pure functions).

import { describe, expect, it } from 'vitest';
import { DEFAULT_PLACES, isPinnableExternalUrl, parsePlacePins } from './places-rail';

describe('parsePlacePins', () => {
  it('falls back to the six default destinations on missing/corrupt data', () => {
    expect(parsePlacePins(null)).toEqual(DEFAULT_PLACES);
    expect(parsePlacePins('{broken')).toEqual(DEFAULT_PLACES);
    expect(parsePlacePins('[]')).toEqual(DEFAULT_PLACES);
    expect(DEFAULT_PLACES).toHaveLength(6);
  });
  it('keeps valid pins (incl. external) and drops malformed entries', () => {
    const raw = JSON.stringify([
      { id: 'x', label: 'Docs', href: 'https://example.com', external: true },
      { id: 'bad' },
      { id: 'y', label: 'Bots', href: '/bots' },
    ]);
    const pins = parsePlacePins(raw);
    expect(pins).toHaveLength(2);
    expect(pins[0]).toMatchObject({ label: 'Docs', external: true });
  });
});

describe('isPinnableExternalUrl', () => {
  it('accepts http(s) only', () => {
    expect(isPinnableExternalUrl('https://example.com')).toBe(true);
    expect(isPinnableExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isPinnableExternalUrl('/bots')).toBe(false);
  });
});
