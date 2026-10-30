// SPDX-License-Identifier: Apache-2.0
// CA-28: terminal-native completion signals for the TUI.
// On turn completion / approval-needed the TUI can ring the terminal bell
// and/or post a desktop notification via OSC 9 (iTerm2/Windows Terminal)
// or OSC 777 (Ghostty/urxvt-style). Configurable: off | bell | osc | both.
// OSC mode emits both the OSC 9 and OSC 777 forms — terminals ignore the
// sequences they do not understand. (Same contract as the CLI's module;
// each package carries its own copy so neither depends on the other.)

export type NotifyMode = 'off' | 'bell' | 'osc' | 'both';
export type SignalKind = 'turn-complete' | 'approval-needed';

export const NOTIFY_MODES: readonly NotifyMode[] = ['off', 'bell', 'osc', 'both'];

export function isNotifyMode(v: unknown): v is NotifyMode {
  return typeof v === 'string' && (NOTIFY_MODES as readonly string[]).includes(v);
}

/** Resolve the mode: explicit value > KRIYADOT_NOTIFY env > 'bell'. */
export function resolveNotifyMode(explicit?: unknown): NotifyMode {
  if (isNotifyMode(explicit)) return explicit;
  const env = process.env.KRIYADOT_NOTIFY;
  if (isNotifyMode(env)) return env;
  return 'bell';
}

const MESSAGES: Record<SignalKind, { title: string; body: string }> = {
  'turn-complete': { title: 'KriyaDot', body: 'Turn complete' },
  'approval-needed': { title: 'KriyaDot', body: 'Approval needed' },
};

/** The exact byte sequence for a signal (empty string when mode is off). */
export function signalSequence(mode: NotifyMode, kind: SignalKind): string {
  if (mode === 'off') return '';
  const { title, body } = MESSAGES[kind];
  let out = '';
  if (mode === 'bell' || mode === 'both') out += '\x07';
  if (mode === 'osc' || mode === 'both') {
    out += `\x1b]9;${body}\x07`;
    out += `\x1b]777;notify;${title};${body}\x07`;
  }
  return out;
}

/** Emit a signal through `write` (defaults to stdout; captured in tests). */
export function emitTerminalSignal(
  mode: NotifyMode,
  kind: SignalKind,
  write: (s: string) => void = (s) => {
    process.stdout.write(s);
  },
): number {
  const seq = signalSequence(mode, kind);
  if (seq) write(seq);
  return seq.length;
}
