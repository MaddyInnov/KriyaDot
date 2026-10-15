// SPDX-License-Identifier: Apache-2.0
import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Pet } from './Pet';
import { PETS, type PetMood } from '../../lib/pet';

const MOODS: PetMood[] = ['idle', 'thinking', 'working', 'happy', 'error', 'sleeping'];

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
    }
  });

  it('honours a custom accessible label', () => {
    const html = renderToStaticMarkup(<Pet pet="bolt" label="My bot buddy" />);
    expect(html).toContain('aria-label="My bot buddy"');
  });
});
