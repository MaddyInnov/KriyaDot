// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { SPACE_HEADER, SPACE_STORAGE_KEY, spaceHeaders } from './kriyadot-api';

describe('space header helpers', () => {
  it('exposes the stable storage key and header name', () => {
    expect(SPACE_STORAGE_KEY).toBe('kriyadot:space');
    expect(SPACE_HEADER).toBe('X-KriyaDot-Space');
  });

  it('adds X-KriyaDot-Space only when a space id is set', () => {
    expect(spaceHeaders('work')).toEqual({ 'X-KriyaDot-Space': 'work' });
    expect(spaceHeaders(null)).toEqual({});
    expect(spaceHeaders('')).toEqual({});
  });

  it('merges extra headers without clobbering them', () => {
    expect(spaceHeaders('work', { 'Content-Type': 'application/json' })).toEqual({
      'X-KriyaDot-Space': 'work',
      'Content-Type': 'application/json',
    });
  });
});
