// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  classifyPress,
  DRAG_THRESHOLD_PX,
  gateMood,
  moodFromPayload,
} from './overlay-state';

describe('moodFromPayload', () => {
  it('accepts every valid mood from a pet-state payload', () => {
    for (const mood of ['idle', 'thinking', 'working', 'happy', 'error', 'sleeping', 'speaking', 'celebrating']) {
      expect(moodFromPayload({ ok: true, mood })).toBe(mood);
    }
  });

  it('rejects garbage without throwing', () => {
    expect(moodFromPayload(null)).toBeNull();
    expect(moodFromPayload('working')).toBeNull();
    expect(moodFromPayload({ mood: 'dancing' })).toBeNull();
    expect(moodFromPayload({})).toBeNull();
  });
});

describe('gateMood', () => {
  it('degrades disabled speaking/celebration moods', () => {
    expect(gateMood('speaking', { speaking: false, celebration: true })).toBe('idle');
    expect(gateMood('celebrating', { speaking: true, celebration: false })).toBe('happy');
  });

  it('passes moods through when enabled', () => {
    expect(gateMood('speaking', { speaking: true, celebration: true })).toBe('speaking');
    expect(gateMood('celebrating', { speaking: true, celebration: true })).toBe('celebrating');
    expect(gateMood('working', { speaking: false, celebration: false })).toBe('working');
  });
});

describe('classifyPress', () => {
  it('a stationary short press is a click', () => {
    expect(classifyPress({ dx: 1, dy: 2, durationMs: 120, dragStarted: false })).toBe('click');
  });

  it('travel beyond the threshold is a drag', () => {
    expect(
      classifyPress({ dx: DRAG_THRESHOLD_PX + 4, dy: 0, durationMs: 300, dragStarted: false }),
    ).toBe('drag');
  });

  it('a started native drag stays a drag even if the pointer ends near the start', () => {
    expect(classifyPress({ dx: 0, dy: 0, durationMs: 800, dragStarted: true })).toBe('drag');
  });
});
