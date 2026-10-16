// SPDX-License-Identifier: Apache-2.0
// Keyboard chord parsing and hotkey presets for the computer_key tool.
//
// A "chord" is modifier(s) + one final key, e.g. "ctrl+c", "ctrl+shift+s",
// "alt+tab", "cmd+q". The tool layer parses the chord once (this module)
// and hands the structured { modifiers, key } to the OS layer, which
// presses modifiers down in order, taps the final key, and releases the
// modifiers in reverse — implemented per backend (robotjs keyToggle,
// Playwright keyboard.down/up, CDP Input.dispatchKeyEvent with a modifiers
// bitmask).
//
// Hotkey presets are convenience names ("copy", "paste", ...) resolved
// per-OS (Cmd on macOS, Ctrl elsewhere) so the model never has to
// remember platform-specific chords.

import type { LaunchPlatform } from './computer-apps.js';

/** Canonical modifier names used by the computer_key tool and OS layers. */
export type ChordModifier = 'ctrl' | 'shift' | 'alt' | 'meta';

/** A parsed keyboard chord: modifiers held down + one final key tap. */
export interface ParsedChord {
  /** Modifiers in press order (released in reverse). Never empty... unless a hotkey resolves to a bare key (e.g. PrintScreen). */
  modifiers: ChordModifier[];
  /** Canonical final key name (e.g. 'c', 'F4', 'Tab', 'PrintScreen'). */
  key: string;
}

/** Hard cap on the raw chord string — chords are short by nature. */
export const MAX_CHORD_LENGTH = 64;

/** Max parts: 4 distinct modifiers + 1 final key. */
const MAX_CHORD_PARTS = 5;

/** Modifier aliases (case-insensitive) → canonical ChordModifier. */
const MODIFIER_ALIASES: Record<string, ChordModifier> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  shift: 'shift',
  alt: 'alt',
  option: 'alt',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  win: 'meta',
  windows: 'meta',
  super: 'meta',
};

/**
 * Lowercase → canonical key name for the non-alphanumeric chord keys.
 * Letters a-z and digits 0-9 are handled structurally (see canonicalChordKey).
 */
const CANONICAL_CHORD_KEYS: Record<string, string> = {
  enter: 'Enter',
  tab: 'Tab',
  escape: 'Escape',
  esc: 'Escape',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  space: 'Space',
  arrowup: 'ArrowUp',
  up: 'ArrowUp',
  arrowdown: 'ArrowDown',
  down: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  left: 'ArrowLeft',
  arrowright: 'ArrowRight',
  right: 'ArrowRight',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pgup: 'PageUp',
  pagedown: 'PageDown',
  pgdn: 'PageDown',
  printscreen: 'PrintScreen',
  prtsc: 'PrintScreen',
  prtscr: 'PrintScreen',
  f1: 'F1',
  f2: 'F2',
  f3: 'F3',
  f4: 'F4',
  f5: 'F5',
  f6: 'F6',
  f7: 'F7',
  f8: 'F8',
  f9: 'F9',
  f10: 'F10',
  f11: 'F11',
  f12: 'F12',
};

/**
 * All canonical final-key names a chord may end with: the 14 single-key
 * allowlist entries (normalized), letters a-z, digits 0-9, F1-F12, and
 * PrintScreen.
 */
export const CHORD_KEY_ALLOWLIST: ReadonlySet<string> = new Set([
  'Enter',
  'Tab',
  'Escape',
  'Backspace',
  'Delete',
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'PrintScreen',
  'F1',
  'F2',
  'F3',
  'F4',
  'F5',
  'F6',
  'F7',
  'F8',
  'F9',
  'F10',
  'F11',
  'F12',
  ...'abcdefghijklmnopqrstuvwxyz'.split(''),
  ...'0123456789'.split(''),
]);

/** Normalize a raw final-key part to its canonical name, or null. */
function canonicalChordKey(part: string): string | null {
  const lower = part.toLowerCase();
  const named = CANONICAL_CHORD_KEYS[lower];
  if (named) return named;
  if (/^[a-z]$/.test(lower)) return lower; // letter → lowercase
  if (/^[0-9]$/.test(lower)) return lower; // digit
  return null;
}

/**
 * Parse "ctrl+c" / "ctrl+shift+s" / "alt+tab" into { modifiers, key }.
 * Throws a descriptive Error for anything malformed. At least one
 * modifier is required — a bare key is not a chord (the tool layer
 * handles single keys through the original allowlist path).
 */
export function parseKeyChord(raw: unknown): ParsedChord {
  if (typeof raw !== 'string') {
    throw new Error('chord must be a string like "ctrl+c"');
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('chord must be a non-empty string like "ctrl+c"');
  }
  if (trimmed.length > MAX_CHORD_LENGTH) {
    throw new Error(`chord too long (max ${MAX_CHORD_LENGTH} chars)`);
  }
  const parts = trimmed.split('+').map((p) => p.trim());
  if (parts.length < 2) {
    throw new Error(`"${raw}" is not a chord — use "modifier+key", e.g. "ctrl+c"`);
  }
  if (parts.length > MAX_CHORD_PARTS) {
    throw new Error(`chord has too many parts (max ${MAX_CHORD_PARTS - 1} modifiers + 1 key)`);
  }
  if (parts.some((p) => p.length === 0)) {
    throw new Error(`empty part in chord "${raw}" — check for stray "+" characters`);
  }
  const modifiers: ChordModifier[] = [];
  for (const part of parts.slice(0, -1)) {
    const m = MODIFIER_ALIASES[part.toLowerCase()];
    if (!m) {
      throw new Error(`"${part}" is not a modifier — use ctrl, shift, alt, or meta (cmd)`);
    }
    if (modifiers.includes(m)) {
      throw new Error(`duplicate modifier "${part}" in chord "${raw}"`);
    }
    modifiers.push(m);
  }
  const key = canonicalChordKey(parts[parts.length - 1]);
  if (!key) {
    throw new Error(
      `"${parts[parts.length - 1]}" is not a supported chord key ` +
        `(letters, digits, F1-F12, or ${['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Space', 'arrows', 'Home', 'End', 'PageUp', 'PageDown', 'PrintScreen'].join(', ')})`,
    );
  }
  return { modifiers, key };
}

/** Render a parsed chord back to its canonical string form ("ctrl+shift+s"). */
export function formatChord(chord: ParsedChord): string {
  return [...chord.modifiers, chord.key].join('+');
}

/** Named hotkeys the model can use without remembering platform chords. */
export type HotkeyName =
  | 'copy'
  | 'paste'
  | 'cut'
  | 'undo'
  | 'redo'
  | 'save'
  | 'select_all'
  | 'find'
  | 'close_window'
  | 'switch_app'
  | 'screenshot';

/** All hotkey preset names (for help text and validation messages). */
export const HOTKEY_NAMES: ReadonlyArray<HotkeyName> = [
  'copy',
  'paste',
  'cut',
  'undo',
  'redo',
  'save',
  'select_all',
  'find',
  'close_window',
  'switch_app',
  'screenshot',
];

const HOTKEY_TABLE: Record<HotkeyName, { darwin: ParsedChord; other: ParsedChord }> = {
  copy: {
    darwin: { modifiers: ['meta'], key: 'c' },
    other: { modifiers: ['ctrl'], key: 'c' },
  },
  paste: {
    darwin: { modifiers: ['meta'], key: 'v' },
    other: { modifiers: ['ctrl'], key: 'v' },
  },
  cut: {
    darwin: { modifiers: ['meta'], key: 'x' },
    other: { modifiers: ['ctrl'], key: 'x' },
  },
  undo: {
    darwin: { modifiers: ['meta'], key: 'z' },
    other: { modifiers: ['ctrl'], key: 'z' },
  },
  redo: {
    darwin: { modifiers: ['meta', 'shift'], key: 'z' },
    other: { modifiers: ['ctrl'], key: 'y' },
  },
  save: {
    darwin: { modifiers: ['meta'], key: 's' },
    other: { modifiers: ['ctrl'], key: 's' },
  },
  select_all: {
    darwin: { modifiers: ['meta'], key: 'a' },
    other: { modifiers: ['ctrl'], key: 'a' },
  },
  find: {
    darwin: { modifiers: ['meta'], key: 'f' },
    other: { modifiers: ['ctrl'], key: 'f' },
  },
  close_window: {
    darwin: { modifiers: ['meta'], key: 'q' },
    other: { modifiers: ['alt'], key: 'F4' },
  },
  switch_app: {
    darwin: { modifiers: ['meta'], key: 'Tab' },
    other: { modifiers: ['alt'], key: 'Tab' },
  },
  // macOS: the system screenshot shortcut. Windows/Linux: the PrintScreen
  // key (a bare key tap — modifiers is empty, which every backend handles
  // as a plain key press).
  screenshot: {
    darwin: { modifiers: ['meta', 'shift'], key: '3' },
    other: { modifiers: [], key: 'PrintScreen' },
  },
};

/**
 * Resolve a hotkey preset name (case-insensitive) to a chord for the
 * given platform. Returns null when the name is not a hotkey.
 */
export function resolveHotkey(name: string, platform: LaunchPlatform): ParsedChord | null {
  const n = name.toLowerCase().trim() as HotkeyName;
  const entry = HOTKEY_TABLE[n];
  if (!entry) return null;
  const chord = platform === 'darwin' ? entry.darwin : entry.other;
  // Return copies so callers can never mutate the table.
  return { modifiers: [...chord.modifiers], key: chord.key };
}
