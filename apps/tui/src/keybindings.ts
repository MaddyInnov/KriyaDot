// SPDX-License-Identifier: Apache-2.0
// CA-19: keybinding customization for the TUI.
// Overrides live in <configDir>/keybindings.json as { "<action>": "<chord>" },
// e.g. { "cancel": "ctrl+x", "approve": "a" }. Unknown actions, malformed
// chords, and chords already claimed by another action are ignored with a
// warning (surfaced in the load result, never thrown).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const KEY_ACTIONS = ['send', 'newline', 'cancel', 'switchView', 'approve', 'deny'] as const;
export type KeyAction = (typeof KEY_ACTIONS)[number];

export type KeyBindings = Record<KeyAction, string>;

export const DEFAULT_KEYBINDINGS: KeyBindings = {
  send: 'enter',
  newline: 'shift+enter',
  cancel: 'ctrl+t',
  switchView: 'escape',
  approve: 'y',
  deny: 'n',
};

const NAMED_KEYS = new Set([
  'enter', 'return', 'escape', 'esc', 'tab', 'space', 'backspace', 'delete',
  'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown',
]);

/** Normalize a chord string ("Ctrl+T", " shift + enter ") → "ctrl+t" / "shift+enter"; null when malformed. */
export function normalizeChord(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const parts = raw.toLowerCase().split('+').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const key = parts[parts.length - 1]!;
  const mods = parts.slice(0, -1);
  for (const m of mods) {
    if (m !== 'ctrl' && m !== 'shift' && m !== 'alt' && m !== 'meta') return null;
  }
  if (key.length === 1) {
    if (!/^[a-z0-9]$/.test(key)) return null;
  } else if (!NAMED_KEYS.has(key) && !/^f([1-9]|1[0-2])$/.test(key)) {
    return null;
  }
  const dedupMods = [...new Set(mods)].sort();
  return [...dedupMods, key === 'return' ? 'enter' : key === 'esc' ? 'escape' : key].join('+');
}

export interface KeybindingLoadResult {
  bindings: KeyBindings;
  warnings: string[];
}

/** Merge a parsed overrides object over the defaults, collecting warnings. */
export function mergeKeybindings(overrides: unknown): KeybindingLoadResult {
  const bindings: KeyBindings = { ...DEFAULT_KEYBINDINGS };
  const warnings: string[] = [];
  if (overrides === null || overrides === undefined) return { bindings, warnings };
  if (typeof overrides !== 'object' || Array.isArray(overrides)) {
    return { bindings, warnings: ['keybindings: expected a JSON object mapping action → chord; overrides ignored'] };
  }
  const claimed = new Map<string, KeyAction>();
  for (const [action, chord] of Object.entries(DEFAULT_KEYBINDINGS)) claimed.set(chord, action as KeyAction);
  for (const [action, raw] of Object.entries(overrides as Record<string, unknown>)) {
    if (!(KEY_ACTIONS as readonly string[]).includes(action)) {
      warnings.push(`keybindings: unknown action "${action}" ignored`);
      continue;
    }
    const chord = normalizeChord(raw);
    if (!chord) {
      warnings.push(`keybindings: invalid chord ${JSON.stringify(raw)} for action "${action}" ignored`);
      continue;
    }
    const owner = claimed.get(chord);
    if (owner && owner !== action) {
      warnings.push(`keybindings: chord "${chord}" already bound to "${owner}"; binding for "${action}" ignored`);
      continue;
    }
    // Free the action's previous chord, then claim the new one.
    claimed.delete(bindings[action as KeyAction]);
    bindings[action as KeyAction] = chord;
    claimed.set(chord, action as KeyAction);
  }
  return { bindings, warnings };
}

/** Load <configDir>/keybindings.json; a missing/corrupt file yields defaults (+ a warning for corrupt). */
export function loadKeybindings(dir: string): KeybindingLoadResult {
  const path = join(dir, 'keybindings.json');
  if (!existsSync(path)) return { bindings: { ...DEFAULT_KEYBINDINGS }, warnings: [] };
  try {
    return mergeKeybindings(JSON.parse(readFileSync(path, 'utf8')) as unknown);
  } catch (err) {
    return {
      bindings: { ...DEFAULT_KEYBINDINGS },
      warnings: [`keybindings: could not parse ${path} (${err instanceof Error ? err.message : String(err)}); defaults used`],
    };
  }
}

/** Ink key-event shape (structural subset). */
export interface KeyEventLike {
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
  return?: boolean;
  escape?: boolean;
  tab?: boolean;
  backspace?: boolean;
  delete?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
}

/** Map an Ink (input, key) pair to a normalized chord string. */
export function chordForEvent(input: string, key: KeyEventLike): string {
  if (key.return) return key.shift ? 'shift+enter' : 'enter';
  if (key.escape) return 'escape';
  if (key.tab) return key.shift ? 'shift+tab' : 'tab';
  const mods: string[] = [];
  if (key.ctrl) mods.push('ctrl');
  if (key.meta) mods.push('meta');
  if (key.shift && input.length === 1 && input === input.toLowerCase()) mods.push('shift');
  let base = input;
  if (key.backspace) base = 'backspace';
  else if (key.delete) base = 'delete';
  else if (key.upArrow) base = 'up';
  else if (key.downArrow) base = 'down';
  else if (key.leftArrow) base = 'left';
  else if (key.rightArrow) base = 'right';
  else base = input.toLowerCase();
  return [...mods.sort(), base].join('+');
}

/** Which action (if any) a key event triggers under `bindings`. */
export function actionForEvent(bindings: KeyBindings, input: string, key: KeyEventLike): KeyAction | null {
  const chord = chordForEvent(input, key);
  for (const action of KEY_ACTIONS) {
    if (bindings[action] === chord) return action;
  }
  return null;
}
