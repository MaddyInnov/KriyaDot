// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { getPalette, isThemeName, THEME_NAMES, THEMES } from '../src/themes.js';

describe('themes', () => {
  it('exposes exactly the five web-app themes', () => {
    expect([...THEME_NAMES]).toEqual(['light', 'dark', 'midnight', 'porcelain', 'ocean']);
    expect(Object.keys(THEMES)).toHaveLength(5);
  });

  it('every palette has valid hex colors for every slot', () => {
    const hex = /^#[0-9a-fA-F]{6}$/;
    for (const name of THEME_NAMES) {
      const p = THEMES[name];
      for (const slot of ['text', 'dim', 'accent', 'green', 'amber', 'red', 'border', 'select'] as const) {
        expect(p[slot], `${name}.${slot}`).toMatch(hex);
      }
    }
  });

  it('dark themes differ from light themes', () => {
    expect(THEMES.dark.text).not.toBe(THEMES.light.text);
    expect(THEMES.midnight.accent).not.toBe(THEMES.porcelain.accent);
  });

  it('getPalette falls back to dark for unknown names', () => {
    expect(getPalette('nope' as never)).toEqual(THEMES.dark);
    expect(getPalette('ocean')).toEqual(THEMES.ocean);
  });

  it('isThemeName validates', () => {
    expect(isThemeName('midnight')).toBe(true);
    expect(isThemeName('MIDNIGHT')).toBe(false);
    expect(isThemeName('')).toBe(false);
  });
});
