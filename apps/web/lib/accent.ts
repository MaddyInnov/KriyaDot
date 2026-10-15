// SPDX-License-Identifier: Apache-2.0
// KriyaDot brand accent system.
//
// THE KRIYADOT JEWELS — our signature palette (designed 2026-10-09):
//
//   Deep jewel tones, refined metallics, elegant duotones. Every accent is a
//   135° gradient duotone — the signature KriyaDot gradient identity — with
//   theme-appropriate luminance roles (light + dark sets) so each theme keeps
//   readable contrast without restyling the claymorphism/glassmorphism system.
//
//   Signature identity: "Amethyst Crown" — royal violet #6d3fc4 → luminous
//   lavender #b678e0 at 135°. It is the default accent and is baked into all
//   five themes, so a fresh install carries the brand with no stored choice.
//
//   Curated picker accents (name — duotone — character):
//     amethyst  "Amethyst Crown"  #6d3fc4 → #b678e0   royal violet → lavender
//     emerald   "Emerald Court"   #0b6e5d → #3ecf9a   deep emerald → jade
//     sapphire  "Sapphire Dusk"   #1d4fa8 → #5aa9e6   deep sapphire → glacier
//     garnet    "Garnet Ember"    #9c2233 → #e0722d   garnet → ember orange
//     topaz     "Gilded Topaz"    #96620f → #e8b44b   bronze → champagne metallic
//     copper    "Copper Rose"     #8f4426 → #e0956a   dark copper → rose metal
//     opal      "Opal Mist"       #52617a → #aebccf   slate → pearl metallic
//     peacock   "Peacock Plume"   #0b5c63 → #35c9b4   deep teal → aquamarine
//
// Choice persists in localStorage under `kriyadot:accent` (a plain accent id
// string). The root layout sets html[data-accent] before first paint so the
// accent never flashes. Unknown or missing values fall back to the default;
// the legacy `mvp:*` preference keys are untouched, so existing prefs keep
// working with no migration step.

'use client';

import { useCallback, useEffect, useState } from 'react';

export type AccentId =
  | 'amethyst'
  | 'emerald'
  | 'sapphire'
  | 'garnet'
  | 'topaz'
  | 'copper'
  | 'opal'
  | 'peacock';

/** Luminance-appropriate roles for one surface polarity. */
export interface AccentRoles {
  /** Gradient start (135°). Also the base solid accent color. */
  from: string;
  /** Gradient end (135°). */
  to: string;
  /** Base accent for text, borders, focus rings. */
  accent: string;
  /** Hover variant of the base accent. */
  hover: string;
  /** Pale wash for chips, toggle tracks, soft highlights. */
  soft: string;
  /** Text ink on solid accent fills. */
  ink: string;
}

export interface AccentDef {
  id: AccentId;
  name: string;
  blurb: string;
  /** [light.from, light.to] — gradient preview in the picker. */
  swatch: [string, string];
  light: AccentRoles;
  dark: AccentRoles;
}

export const ACCENTS: AccentDef[] = [
  {
    id: 'amethyst',
    name: 'Amethyst Crown',
    blurb: 'The signature KriyaDot identity — royal violet melting into luminous lavender.',
    swatch: ['#6d3fc4', '#b678e0'],
    light: { from: '#6d3fc4', to: '#b678e0', accent: '#6d3fc4', hover: '#5a30ae', soft: '#f0e9fb', ink: '#ffffff' },
    dark: { from: '#a179f2', to: '#d4aef8', accent: '#a179f2', hover: '#bb93f7', soft: '#221d3d', ink: '#161130' },
  },
  {
    id: 'emerald',
    name: 'Emerald Court',
    blurb: 'Deep emerald melting into bright jade — calm, confident, expensive.',
    swatch: ['#0b6e5d', '#3ecf9a'],
    light: { from: '#0b6e5d', to: '#3ecf9a', accent: '#0b6e5d', hover: '#0a5c4d', soft: '#e3f7ee', ink: '#ffffff' },
    dark: { from: '#3dd9a4', to: '#8cf0c8', accent: '#3dd9a4', hover: '#63e4b5', soft: '#12362a', ink: '#06231a' },
  },
  {
    id: 'sapphire',
    name: 'Sapphire Dusk',
    blurb: 'Deep sapphire cooling into glacier blue — trust with a night-sky edge.',
    swatch: ['#1d4fa8', '#5aa9e6'],
    light: { from: '#1d4fa8', to: '#5aa9e6', accent: '#1d4fa8', hover: '#1a448f', soft: '#e7f1fc', ink: '#ffffff' },
    dark: { from: '#5aa0f0', to: '#9ccdf8', accent: '#5aa0f0', hover: '#7db4f5', soft: '#16294a', ink: '#0c1a33' },
  },
  {
    id: 'garnet',
    name: 'Garnet Ember',
    blurb: 'Dark garnet flaring into ember orange — dramatic, warm, unmistakable.',
    swatch: ['#9c2233', '#e0722d'],
    light: { from: '#9c2233', to: '#e0722d', accent: '#9c2233', hover: '#851d2c', soft: '#faeae6', ink: '#ffffff' },
    dark: { from: '#e5645f', to: '#f2a35c', accent: '#e5645f', hover: '#ec837f', soft: '#3a1b1c', ink: '#2c100f' },
  },
  {
    id: 'topaz',
    name: 'Gilded Topaz',
    blurb: 'Antique bronze into champagne — the quiet-luxury metallic.',
    swatch: ['#96620f', '#e8b44b'],
    light: { from: '#96620f', to: '#e8b44b', accent: '#96620f', hover: '#7f5310', soft: '#faf0da', ink: '#ffffff' },
    dark: { from: '#e3ae4a', to: '#f6d58a', accent: '#e3ae4a', hover: '#e9be68', soft: '#3a2c12', ink: '#261c0a' },
  },
  {
    id: 'copper',
    name: 'Copper Rose',
    blurb: 'Oxidised copper into rose metal — artisanal, warm, handcrafted.',
    swatch: ['#8f4426', '#e0956a'],
    light: { from: '#8f4426', to: '#e0956a', accent: '#8f4426', hover: '#7c3a20', soft: '#faece2', ink: '#ffffff' },
    dark: { from: '#e08b5e', to: '#f4b896', accent: '#e08b5e', hover: '#e7a27c', soft: '#382015', ink: '#2a150c' },
  },
  {
    id: 'opal',
    name: 'Opal Mist',
    blurb: 'Slate into pearl — monochrome elegance for a calmer console.',
    swatch: ['#52617a', '#aebccf'],
    light: { from: '#52617a', to: '#aebccf', accent: '#52617a', hover: '#455469', soft: '#edf0f4', ink: '#ffffff' },
    dark: { from: '#a9b7cc', to: '#dde5f0', accent: '#a9b7cc', hover: '#bcc7da', soft: '#232c3b', ink: '#161c27' },
  },
  {
    id: 'peacock',
    name: 'Peacock Plume',
    blurb: 'Deep teal into aquamarine — vivid jewel water, unmistakably KriyaDot.',
    swatch: ['#0b5c63', '#35c9b4'],
    light: { from: '#0b5c63', to: '#35c9b4', accent: '#0b5c63', hover: '#0a4d53', soft: '#e2f7f1', ink: '#ffffff' },
    dark: { from: '#3ad6bd', to: '#8ef0d8', accent: '#3ad6bd', hover: '#5de0c8', soft: '#0f3229', ink: '#06231c' },
  },
];

export const DEFAULT_ACCENT_ID: AccentId = 'amethyst';

const KEY = 'kriyadot:accent';
const CHANGE_EVENT = 'kriyadot:accent-change';
const VALID: AccentId[] = ACCENTS.map((a) => a.id);

export function accentDef(id: AccentId): AccentDef {
  return ACCENTS.find((a) => a.id === id) ?? ACCENTS[0];
}

/** Read the stored choice (safe on server / private mode). Unknown values
 *  fall back to the default — no migration step needed. */
export function getStoredAccent(): AccentId {
  try {
    const v = localStorage.getItem(KEY);
    return (VALID as string[]).includes(v ?? '') ? (v as AccentId) : DEFAULT_ACCENT_ID;
  } catch {
    return DEFAULT_ACCENT_ID;
  }
}

/** Persist a choice and apply it to the document; notifies mounted hooks. */
export function applyAccentChoice(id: AccentId): void {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* private mode etc. — in-memory only */
  }
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.accent = id;
  }
  try {
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    /* ignore */
  }
}

/** Reactive hook over the stored accent choice. SSR-safe (hydrates from default). */
export function useAccent(): [AccentId, (id: AccentId) => void, AccentDef] {
  const [id, setIdState] = useState<AccentId>(DEFAULT_ACCENT_ID);

  useEffect(() => {
    const cur = getStoredAccent();
    setIdState(cur);
    applyAccentChoice(cur);
    const onChange = () => setIdState(getStoredAccent());
    window.addEventListener(CHANGE_EVENT, onChange);
    window.addEventListener('storage', onChange);
    return () => {
      window.removeEventListener(CHANGE_EVENT, onChange);
      window.removeEventListener('storage', onChange);
    };
  }, []);

  const setAccent = useCallback((next: AccentId) => {
    applyAccentChoice(next);
    setIdState(next);
  }, []);

  return [id, setAccent, accentDef(id)];
}
