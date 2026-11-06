// SPDX-License-Identifier: Apache-2.0
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Pet } from './Pet';
import {
  DEFAULT_PET_SETTINGS,
  PETS,
  getPetSettings,
  setPetSettings,
  type PetMood,
} from '../../lib/pet';

const MOODS: PetMood[] = [
  'idle',
  'thinking',
  'working',
  'happy',
  'error',
  'sleeping',
  'speaking',
  'celebrating',
];

describe('Pet render', () => {
  for (const p of PETS) {
    it(`renders ${p.id} as inline SVG with its art`, () => {
      const html = renderToStaticMarkup(<Pet pet={p.id} size={48} mood="idle" />);
      expect(html).toContain('<svg');
      expect(html).toContain('class="pet-svg"');
      expect(html).toContain('pet-mood-idle');
      expect(html).toContain(p.name);
    });
  }

  it('supports every mood without crashing', () => {
    for (const mood of MOODS) {
      const html = renderToStaticMarkup(<Pet pet="kriyadot" size={26} mood={mood} />);
      expect(html).toContain(`pet-mood-${mood}`);
      expect(html).toContain(`data-mood="${mood}"`);
    }
  });

  it('honours a custom accessible label', () => {
    const html = renderToStaticMarkup(<Pet pet="bolt" label="My bot buddy" />);
    expect(html).toContain('aria-label="My bot buddy"');
  });
});

describe('Pet speaking / celebrating moods (2D art)', () => {
  for (const p of PETS) {
    it(`${p.id} renders a talking mouth + sound arcs when speaking`, () => {
      const html = renderToStaticMarkup(<Pet pet={p.id} size={48} mood="speaking" variant="2d" />);
      expect(html).toContain('pet-mood-speaking');
      expect(html).toContain('data-mood="speaking"');
      expect(html).toContain('pet-talk-mouth');
      expect(html).toContain('fx-speaking');
      expect(html).toContain('pet-sound-arc');
    });

    it(`${p.id} renders the celebration face + confetti when celebrating`, () => {
      const html = renderToStaticMarkup(<Pet pet={p.id} size={48} mood="celebrating" variant="2d" />);
      expect(html).toContain('pet-mood-celebrating');
      expect(html).toContain('data-mood="celebrating"');
      expect(html).toContain('fx-celebrating');
    });
  }
});

describe('pet settings', () => {
  function stubStorage(initial: Record<string, string> = {}) {
    const store = new Map(Object.entries(initial));
    const fake = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    };
    vi.stubGlobal('localStorage', fake);
    const listeners = new Map<string, Set<() => void>>();
    vi.stubGlobal('window', {
      dispatchEvent: (e: Event) => {
        listeners.get(e.type)?.forEach((fn) => fn());
        return true;
      },
      addEventListener: (type: string, fn: () => void) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(fn);
      },
      removeEventListener: (type: string, fn: () => void) => {
        listeners.get(type)?.delete(fn);
      },
    });
    return store;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults all four settings (chatAvatar/speaking/celebration/overlay) to true', () => {
    stubStorage();
    expect(DEFAULT_PET_SETTINGS).toEqual({
      chatAvatar: true,
      speaking: true,
      celebration: true,
      overlay: true,
    });
    expect(getPetSettings()).toEqual(DEFAULT_PET_SETTINGS);
  });

  it('returns defaults without a DOM / storage', () => {
    expect(getPetSettings()).toEqual(DEFAULT_PET_SETTINGS);
    expect(() => setPetSettings({ overlay: false })).not.toThrow();
  });

  it('persists a partial update under mvp:pet:settings and keeps other keys', () => {
    const store = stubStorage();
    const next = setPetSettings({ speaking: false });
    expect(next).toEqual({ chatAvatar: true, speaking: false, celebration: true, overlay: true });
    expect(JSON.parse(store.get('mvp:pet:settings')!)).toEqual(next);
    expect(getPetSettings()).toEqual(next);

    const next2 = setPetSettings({ overlay: false, celebration: false });
    expect(next2).toEqual({ chatAvatar: true, speaking: false, celebration: false, overlay: false });
    expect(getPetSettings()).toEqual(next2);
  });

  it('ignores non-boolean values and falls back per-key for corrupt stored data', () => {
    stubStorage({
      'mvp:pet:settings': JSON.stringify({ chatAvatar: false, speaking: 'yes', overlay: 0 }),
    });
    expect(getPetSettings()).toEqual({
      chatAvatar: false,
      speaking: true,
      celebration: true,
      overlay: true,
    });
    stubStorage({ 'mvp:pet:settings': 'not-json' });
    expect(getPetSettings()).toEqual(DEFAULT_PET_SETTINGS);
  });
});
