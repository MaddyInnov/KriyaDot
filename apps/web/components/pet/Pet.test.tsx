// SPDX-License-Identifier: Apache-2.0
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Pet } from './Pet';
import { BrandPet } from './BrandPet';
import { BrandMark } from './BrandMark';
import { PetPicker } from './PetPicker';
import {
  BRAND_MARK_SRC,
  DEFAULT_PET_SETTINGS,
  PETS,
  getPetSettings,
  imagePetDef,
  isImagePet,
  setPetSettings,
  setStoredPet,
  type PetId,
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

const SVG_PETS = PETS.filter((p) => !isImagePet(p.id));
const IMAGE_PETS = PETS.filter((p) => isImagePet(p.id));

describe('roster', () => {
  it('has 8 companions: 3 image pets + 5 drawn pets', () => {
    expect(PETS).toHaveLength(8);
    expect(IMAGE_PETS.map((p) => p.id).sort()).toEqual(['droplet', 'kriyadot', 'voxel']);
    expect(SVG_PETS.map((p) => p.id).sort()).toEqual(['bolt', 'nubi', 'ocky', 'plip', 'wisp']);
  });
});

describe('Pet render (drawn pets)', () => {
  for (const p of SVG_PETS) {
    it(`renders ${p.id} as inline SVG with its art`, () => {
      const html = renderToStaticMarkup(<Pet pet={p.id} size={48} mood="idle" />);
      expect(html).toContain('<svg');
      expect(html).toContain('class="pet-svg"');
      expect(html).toContain('pet-mood-idle');
      expect(html).toContain(p.name);
    });
  }

  it('honours a custom accessible label', () => {
    const html = renderToStaticMarkup(<Pet pet="bolt" label="My bot buddy" />);
    expect(html).toContain('aria-label="My bot buddy"');
  });
});

describe('Pet render (image pets)', () => {
  for (const p of IMAGE_PETS) {
    const def = imagePetDef(p.id)!;

    it(`renders ${p.id} as an <img> with its brand src and mood class, never SVG`, () => {
      const html = renderToStaticMarkup(<Pet pet={p.id} size={48} mood="idle" />);
      expect(html).toContain('<img');
      expect(html).toContain(`src="${def.srcSmall}"`);
      expect(html).toContain('pet-image');
      expect(html).toContain('pet-mood-idle');
      expect(html).toContain(`data-pet="${p.id}"`);
      expect(html).toContain(p.name);
      expect(html).not.toContain('<svg');
      expect(html).not.toContain('pet-svg');
    });

    it(`renders ${p.id} with the ${def.frame} frame treatment`, () => {
      const html = renderToStaticMarkup(<Pet pet={p.id} size={48} mood="idle" />);
      expect(html).toContain(`pet-frame-${def.frame}`);
    });

    it(`renders ${p.id} from the full-size src at hero/overlay sizes, even with variant="3d"`, () => {
      const html = renderToStaticMarkup(<Pet pet={p.id} size={140} mood="idle" variant="3d" />);
      expect(html).toContain('<img');
      expect(html).toContain(`src="${def.src}"`);
      expect(html).not.toContain('<canvas');
    });
  }

  it('voxel uses a rounded-square frame; kriyadot and droplet use a circle', () => {
    expect(imagePetDef('voxel')!.frame).toBe('rounded');
    expect(imagePetDef('kriyadot')!.frame).toBe('circle');
    expect(imagePetDef('droplet')!.frame).toBe('circle');
    const html = renderToStaticMarkup(<Pet pet="voxel" size={48} mood="idle" />);
    expect(html).toContain('pet-frame-rounded');
    expect(html).not.toContain('pet-frame-circle');
  });

  it('supports every mood without crashing', () => {
    for (const mood of MOODS) {
      const html = renderToStaticMarkup(<Pet pet="kriyadot" size={26} mood={mood} />);
      expect(html).toContain(`pet-mood-${mood}`);
      expect(html).toContain(`data-mood="${mood}"`);
    }
  });

  it('image pets carry the mood class for voxel and droplet too', () => {
    for (const id of ['voxel', 'droplet'] as PetId[]) {
      const html = renderToStaticMarkup(<Pet pet={id} size={52} mood="working" variant="2d" />);
      expect(html).toContain('pet-mood-working');
      expect(html).toContain(`src="${imagePetDef(id)!.srcSmall}"`);
    }
  });
});

describe('Pet speaking / celebrating moods (2D art)', () => {
  for (const p of SVG_PETS) {
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

  for (const p of IMAGE_PETS) {
    it(`${p.id} expresses speaking/celebrating via mood class + image only (no fake mouth)`, () => {
      const speaking = renderToStaticMarkup(<Pet pet={p.id} size={48} mood="speaking" variant="2d" />);
      expect(speaking).toContain('pet-mood-speaking');
      expect(speaking).toContain('<img');
      expect(speaking).not.toContain('pet-talk-mouth');
      expect(speaking).not.toContain('pet-sound-arc');
      const celebrating = renderToStaticMarkup(<Pet pet={p.id} size={48} mood="celebrating" variant="2d" />);
      expect(celebrating).toContain('pet-mood-celebrating');
      expect(celebrating).toContain('<img');
      expect(celebrating).not.toContain('fx-celebrating');
    });
  }
});

describe('BrandPet / BrandMark (brand is always the Hologram)', () => {
  function stubChoice(id: PetId) {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    });
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
    setStoredPet(id);
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('BrandMark renders the hologram brand src at 26px, circular', () => {
    const html = renderToStaticMarkup(<BrandMark size={26} />);
    expect(html).toContain(`src="${BRAND_MARK_SRC}"`);
    expect(BRAND_MARK_SRC).toBe('/brand/hologram-avatar-256.png');
    expect(html).toContain('brand-mark-img');
    expect(html).toContain('width="26"');
  });

  it('BrandPet renders the hologram regardless of the stored pet choice', () => {
    for (const id of ['ocky', 'voxel', 'droplet', 'wisp'] as PetId[]) {
      stubChoice(id);
      const html = renderToStaticMarkup(<BrandPet />);
      expect(html, `stored choice ${id}`).toContain(`src="${BRAND_MARK_SRC}"`);
      expect(html).not.toContain('voxel-avatar');
      expect(html).not.toContain('droplet-avatar');
      vi.unstubAllGlobals();
    }
  });
});

describe('PetPicker', () => {
  it('renders all 8 companions as options with live previews', () => {
    const html = renderToStaticMarkup(<PetPicker />);
    expect(html.split('role="radio"').length - 1).toBe(8);
    for (const p of PETS) expect(html).toContain(p.name);
    // Image pets preview from their portrait assets at picker size (76px → small src).
    expect(html).toContain('src="/brand/hologram-avatar-256.png"');
    expect(html).toContain('src="/brand/voxel-avatar-256.png"');
    expect(html).toContain('src="/brand/droplet-avatar-256.png"');
  });
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
