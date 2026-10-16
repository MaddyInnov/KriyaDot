// SPDX-License-Identifier: Apache-2.0
// Terminal color palettes mapped from the web app's five themes
// (apps/web/app/globals.css + apps/web/lib/theme.ts swatches).
export const THEME_NAMES = ['light', 'dark', 'midnight', 'porcelain', 'ocean'] as const;
export type ThemeName = (typeof THEME_NAMES)[number];

export interface TuiPalette {
  /** primary text */
  text: string;
  /** secondary/dimmed text */
  dim: string;
  /** brand accent */
  accent: string;
  /** success */
  green: string;
  /** warning */
  amber: string;
  /** error */
  red: string;
  /** borders / rules */
  border: string;
  /** selection highlight background */
  select: string;
}

export const THEMES: Record<ThemeName, TuiPalette> = {
  light: {
    text: '#23211c',
    dim: '#6b655a',
    accent: '#6d3fc4',
    green: '#15803d',
    amber: '#b45309',
    red: '#b91c1c',
    border: '#e5dfd2',
    select: '#f0e9fb',
  },
  dark: {
    text: '#eef0f6',
    dim: '#8b91a3',
    accent: '#a179f2',
    green: '#4ade80',
    amber: '#fbbf24',
    red: '#f87171',
    border: '#2c3140',
    select: '#23263a',
  },
  midnight: {
    text: '#f1efff',
    dim: '#b3b0d8',
    accent: '#a78bfa',
    green: '#4ade80',
    amber: '#fbbf24',
    red: '#f87171',
    border: '#2b2f66',
    select: '#272159',
  },
  porcelain: {
    text: '#2b2118',
    dim: '#7a6a58',
    accent: '#7e46c4',
    green: '#15803d',
    amber: '#b45309',
    red: '#b91c1c',
    border: '#e9dfca',
    select: '#f5efe2',
  },
  ocean: {
    text: '#ecfeff',
    dim: '#7fb3c4',
    accent: '#9d72ef',
    green: '#4ade80',
    amber: '#fbbf24',
    red: '#f87171',
    border: '#14505f',
    select: '#0a3542',
  },
};

export function getPalette(name: ThemeName): TuiPalette {
  return THEMES[name] ?? THEMES.dark;
}

export function isThemeName(v: string): v is ThemeName {
  return (THEME_NAMES as readonly string[]).includes(v);
}
