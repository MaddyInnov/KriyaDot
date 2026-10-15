// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PET_ID,
  PETS,
  getStoredPet,
  petDef,
  petDisplayName,
  setStoredPet,
  type PetId,
} from './pet';

describe('pet registry', () => {
  it('has exactly 6 distinct styles', () => {
    expect(PETS).toHaveLength(6);
    const ids = PETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(6);
  });

  it('every pet has a name, tagline and blurb', () => {
    for (const p of PETS) {
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.tagline.length).toBeGreaterThan(0);
      expect(p.blurb.length).toBeGreaterThan(0);
    }
  });

  it('defaults to kriyadot', () => {
    expect(DEFAULT_PET_ID).toBe('kriyadot');
    expect(petDef('kriyadot').name).toBe('KriyaDot');
  });

  it('falls back to the first pet for unknown ids', () => {
    expect(petDef('nope' as PetId).id).toBe(PETS[0].id);
  });
});

describe('pet display name', () => {
  it('prefers the custom name', () => {
    expect(petDisplayName({ id: 'bolt', name: 'Sparky' })).toBe('Sparky');
  });

  it('falls back to the pet default name when blank', () => {
    expect(petDisplayName({ id: 'bolt', name: '   ' })).toBe('Bolt');
    expect(petDisplayName({ id: 'wisp', name: '' })).toBe('Wisp');
  });
});

describe('pet storage (no-DOM fallback)', () => {
  it('returns the default when localStorage is unavailable', () => {
    // Node test env has no localStorage; helpers must fail soft.
    expect(getStoredPet()).toEqual({ id: DEFAULT_PET_ID, name: '' });
  });

  it('setStoredPet does not throw without a DOM', () => {
    expect(() => setStoredPet('nubi', 'Noob')).not.toThrow();
  });
});

describe('pet migration: tentio -> kriyadot', () => {
  function stubStorage(initial: Record<string, string>) {
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
    return store;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rewrites a stored tentio id to kriyadot', () => {
    const store = stubStorage({ 'mvp:pet': JSON.stringify({ id: 'tentio', name: '' }) });
    expect(getStoredPet()).toEqual({ id: 'kriyadot', name: '' });
    // The stored value is rewritten so the migration runs once.
    expect(JSON.parse(store.get('mvp:pet')!)).toEqual({ id: 'kriyadot', name: '' });
  });

  it('preserves a custom name across the migration', () => {
    stubStorage({ 'mvp:pet': JSON.stringify({ id: 'tentio', name: 'Tentacruel' }) });
    expect(getStoredPet()).toEqual({ id: 'kriyadot', name: 'Tentacruel' });
    expect(petDisplayName(getStoredPet())).toBe('Tentacruel');
  });

  it('leaves other pet ids untouched', () => {
    stubStorage({ 'mvp:pet': JSON.stringify({ id: 'ocky', name: '' }) });
    expect(getStoredPet()).toEqual({ id: 'ocky', name: '' });
  });
});
