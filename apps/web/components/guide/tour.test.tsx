// SPDX-License-Identifier: Apache-2.0
// GuideTour (ADD-3): show-once behavior + step navigation.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  GuideTour,
  TOUR_STORAGE_KEY,
  TOUR_STEPS,
  markTourSeen,
  shouldShowTour,
  type StorageLike,
} from './tour';

afterEach(() => cleanup());
beforeEach(() => localStorage.clear());

function fakeStorage(initial: Record<string, string> = {}): StorageLike & { map: Map<string, string> } {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
  };
}

describe('tour show-once helpers', () => {
  it('shows for a fresh install and not after it was seen', () => {
    const storage = fakeStorage();
    expect(shouldShowTour(storage)).toBe(true);
    markTourSeen(storage);
    expect(storage.map.get(TOUR_STORAGE_KEY)).toBe('1');
    expect(shouldShowTour(storage)).toBe(false);
  });

  it('fails soft with no storage (SSR / private mode)', () => {
    expect(shouldShowTour(null)).toBe(false);
    expect(() => markTourSeen(null)).not.toThrow();
  });

  it('walks all six destinations plus the guide', () => {
    const hrefs = TOUR_STEPS.map((s) => s.href);
    for (const dest of ['/', '/bots', '/workflows', '/marketplace', '/workspace', '/activity', '/more/guide']) {
      expect(hrefs).toContain(dest);
    }
  });
});

describe('GuideTour component', () => {
  it('auto-shows once on a fresh install, then never again after Done', () => {
    const first = render(<GuideTour />);
    expect(screen.getByTestId('guide-tour')).toBeInTheDocument();
    expect(screen.getByText('Welcome to KriyaDot')).toBeInTheDocument();
    first.unmount();

    // Step through to the end and finish: the flag is written.
    render(<GuideTour />);
    for (let i = 0; i < TOUR_STEPS.length - 1; i++) fireEvent.click(screen.getByText('Next'));
    expect(screen.getByText('The User Guide — help that stays')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Done'));
    expect(screen.queryByTestId('guide-tour')).not.toBeInTheDocument();
    expect(localStorage.getItem(TOUR_STORAGE_KEY)).toBe('1');
  });

  it('does not auto-show when the flag is already set', () => {
    localStorage.setItem(TOUR_STORAGE_KEY, '1');
    render(<GuideTour />);
    expect(screen.queryByTestId('guide-tour')).not.toBeInTheDocument();
  });

  it('forceOpen re-opens the tour even after it was seen', () => {
    localStorage.setItem(TOUR_STORAGE_KEY, '1');
    render(<GuideTour forceOpen />);
    expect(screen.getByTestId('guide-tour')).toBeInTheDocument();
  });

  it('Skip also marks the tour seen', () => {
    render(<GuideTour />);
    fireEvent.click(screen.getByText('Skip tour'));
    expect(localStorage.getItem(TOUR_STORAGE_KEY)).toBe('1');
    expect(screen.queryByTestId('guide-tour')).not.toBeInTheDocument();
  });
});
