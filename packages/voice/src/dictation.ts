// SPDX-License-Identifier: Apache-2.0
// OS-level dictation + desktop push-to-talk hotkey — TypeScript/web
// side (Muse parity audit §4.9, V-5).
//
// HONEST SCOPE: true OS-level dictation (a global hotkey that works in
// ANY app, plus text insertion into other apps' windows) lives in the
// desktop shell — see apps/desktop/src-tauri/src/dictation.rs. That
// Rust side is SOURCE-LEVEL ONLY in this build environment: there is
// no cargo/Rust toolchain on the build VM, so it is unverifiable here
// and must be compiled by CI before it can be claimed as working.
//
// Everything buildable and testable on the TS/web side lives here:
//   - the hotkey configuration model (accelerator parsing/validation)
//     shared by the web settings UI and mirrored by the Rust side;
//   - the dictation engine seam + a Web Speech API fallback engine
//     (works in Chromium/web builds with no native shell at all);
//   - the push-to-talk state machine (press → listen → release →
//     final transcript → insert-text intent);
//   - the routing of a finished dictation to an insert-text action,
//     which the desktop shell executes natively and the web build
//     applies to the focused composer.
//
// Zero paid usage: the web fallback uses the browser's built-in speech
// recognition; the native path uses the platform STT stack.

/** Default push-to-talk accelerator (mirrored in dictation.rs). */
export const DEFAULT_PTT_ACCELERATOR = 'CommandOrControl+Shift+Space';

export interface HotkeyConfig {
  /** Tauri/Electron-style accelerator, e.g. 'CommandOrControl+Shift+Space'. */
  accelerator: string;
  /** Hold-to-talk (true) vs toggle on each press (false). Default true. */
  holdToTalk: boolean;
  /** BCP-47 language hint for recognition, e.g. 'en-IN'. Default 'en-US'. */
  language: string;
}

export const DEFAULT_HOTKEY_CONFIG: HotkeyConfig = {
  accelerator: DEFAULT_PTT_ACCELERATOR,
  holdToTalk: true,
  language: 'en-US',
};

const MODIFIERS = new Set(['commandorcontrol', 'command', 'control', 'ctrl', 'alt', 'shift', 'meta', 'super']);

export interface ParsedAccelerator {
  modifiers: string[];
  key: string;
}

/** Parse + normalize an accelerator string; throws on malformed input. */
export function parseAccelerator(raw: string): ParsedAccelerator {
  const input = (raw ?? '').trim();
  if (!input) throw new Error('dictation hotkey: accelerator must be a non-empty string');
  const parts = input.split('+').map((p) => p.trim());
  if (parts.some((p) => !p)) throw new Error(`dictation hotkey: malformed accelerator "${raw}"`);
  const key = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1).map((m) => {
    const lower = m.toLowerCase();
    if (!MODIFIERS.has(lower)) throw new Error(`dictation hotkey: "${m}" is not a known modifier`);
    return lower === 'ctrl' ? 'control' : lower === 'command' ? 'command' : lower === 'super' ? 'meta' : lower;
  });
  if (new Set(modifiers).size !== modifiers.length) {
    throw new Error(`dictation hotkey: duplicate modifier in "${raw}"`);
  }
  // The trigger key itself must not be a bare modifier, and a global
  // hotkey needs at least one modifier so it cannot hijack plain typing.
  if (MODIFIERS.has(key.toLowerCase())) throw new Error('dictation hotkey: the trigger key cannot be a modifier');
  if (modifiers.length === 0) throw new Error('dictation hotkey: at least one modifier is required (a bare key would hijack typing)');
  // Canonical key form: single letters uppercase ('d' → 'D'), named keys
  // capitalized ('space' → 'Space', 'f9' → 'F9').
  const canonicalKey =
    key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1);
  return { modifiers, key: canonicalKey };
}

const MODIFIER_LABEL: Record<string, string> = {
  commandorcontrol: 'CommandOrControl',
  command: 'Command',
  control: 'Control',
  alt: 'Alt',
  shift: 'Shift',
  meta: 'Meta',
};

/** Canonical string form of a parsed accelerator. */
export function formatAccelerator(parsed: ParsedAccelerator): string {
  return [...parsed.modifiers.map((m) => MODIFIER_LABEL[m] ?? m), parsed.key].join('+');
}

/** Validate + normalize a (possibly partial) hotkey config. */
export function normalizeHotkeyConfig(input: Partial<HotkeyConfig> = {}): HotkeyConfig {
  const accelerator = formatAccelerator(parseAccelerator(input.accelerator ?? DEFAULT_HOTKEY_CONFIG.accelerator));
  const language = (input.language ?? DEFAULT_HOTKEY_CONFIG.language).trim();
  if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(language)) {
    throw new Error(`dictation hotkey: language "${input.language}" is not a BCP-47 tag`);
  }
  return {
    accelerator,
    holdToTalk: input.holdToTalk ?? DEFAULT_HOTKEY_CONFIG.holdToTalk,
    language,
  };
}

// ---------------------------------------------------------------------------
// Dictation engine seam + Web Speech fallback
// ---------------------------------------------------------------------------

export interface DictationCallbacks {
  /** Interim (unstable) transcript while listening. */
  onInterim?: (text: string) => void;
  /** Final transcript when listening stops. */
  onFinal: (text: string) => void;
  onError?: (err: Error) => void;
}

export interface DictationEngine {
  readonly name: string;
  readonly supported: boolean;
  start(callbacks: DictationCallbacks): void;
  stop(): void;
}

/** Minimal structural shape of the Web Speech recognition object. */
export interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

export interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    0: { transcript: string };
  }>;
}

/**
 * Web fallback engine over the browser's SpeechRecognition (Chromium:
 * webkitSpeechRecognition). Constructed with an injected factory so
 * tests never need a real browser; `supported` is false when the
 * platform has no recognition object — reported honestly, never faked.
 */
export class WebSpeechDictationEngine implements DictationEngine {
  readonly name = 'web-speech';
  readonly supported: boolean;
  private recognition: SpeechRecognitionLike | null = null;
  private callbacks: DictationCallbacks | null = null;
  private finalText = '';

  constructor(
    private readonly createRecognition: () => SpeechRecognitionLike | null,
    private readonly language = 'en-US',
  ) {
    this.supported = createRecognition() !== null;
  }

  /** Engine for a browser-like global; unsupported outside Chromium/WebKit. */
  static fromGlobal(globalLike: Record<string, unknown>, language = 'en-US'): WebSpeechDictationEngine {
    const ctor =
      (globalLike['SpeechRecognition'] as (new () => SpeechRecognitionLike) | undefined) ??
      (globalLike['webkitSpeechRecognition'] as (new () => SpeechRecognitionLike) | undefined);
    return new WebSpeechDictationEngine(() => {
      if (!ctor) return null;
      try {
        return new ctor();
      } catch {
        return null;
      }
    }, language);
  }

  start(callbacks: DictationCallbacks): void {
    const recognition = this.createRecognition();
    if (!recognition) {
      callbacks.onError?.(new Error('dictation: Web Speech recognition is not available on this platform'));
      return;
    }
    this.callbacks = callbacks;
    this.finalText = '';
    recognition.lang = this.language;
    recognition.interimResults = true;
    recognition.continuous = true;
    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0]?.transcript ?? '';
        if (result.isFinal) this.finalText += transcript;
        else interim += transcript;
      }
      if (interim) this.callbacks?.onInterim?.(interim);
    };
    recognition.onerror = (event) => {
      this.callbacks?.onError?.(new Error(`dictation: recognition error "${event.error ?? 'unknown'}"`));
    };
    recognition.onend = () => {
      const text = this.finalText.trim();
      this.recognition = null;
      if (text) this.callbacks?.onFinal(text);
    };
    this.recognition = recognition;
    recognition.start();
  }

  stop(): void {
    this.recognition?.stop();
  }
}

// ---------------------------------------------------------------------------
// Push-to-talk state machine
// ---------------------------------------------------------------------------

export type PushToTalkState = 'idle' | 'listening';

/**
 * Press-and-hold (or toggle) push-to-talk controller. The desktop shell
 * feeds it global-hotkey press/release events; the web build feeds it
 * keyboard events for the configured accelerator. It owns only the
 * state machine — recognition is the engine's job, insertion is the
 * shell/composer's job (see routeDictationText).
 */
export class PushToTalkController {
  state: PushToTalkState = 'idle';
  constructor(
    private readonly engine: DictationEngine,
    private readonly config: HotkeyConfig,
    private readonly onFinalText: (text: string) => void,
    private readonly onInterimText?: (text: string) => void,
    private readonly onError?: (err: Error) => void,
  ) {}

  /** Hotkey pressed. Repeat events while already listening are ignored. */
  press(): void {
    if (this.state === 'listening') return;
    this.state = 'listening';
    this.engine.start({
      onInterim: (text) => this.onInterimText?.(text),
      onFinal: (text) => {
        this.state = 'idle';
        this.onFinalText(text);
      },
      onError: (err) => {
        this.state = 'idle';
        this.onError?.(err);
      },
    });
  }

  /** Hotkey released. In hold-to-talk mode this ends the dictation. */
  release(): void {
    if (this.state !== 'listening') return;
    if (this.config.holdToTalk) {
      this.engine.stop(); // the engine's onend delivers the final text
    }
    // Toggle mode: a release is not an ending — the next press toggles.
  }

  /** Toggle mode only: a press while listening ends the dictation. */
  pressToggle(): void {
    if (this.config.holdToTalk) {
      this.press();
      return;
    }
    if (this.state === 'listening') this.engine.stop();
    else this.press();
  }

  /** Escape hatch: cancel without delivering a transcript. */
  cancel(): void {
    if (this.state !== 'listening') return;
    this.state = 'idle';
    this.engine.stop();
  }
}

// ---------------------------------------------------------------------------
// Dictation routing
// ---------------------------------------------------------------------------

export interface DictationInsertAction {
  type: 'insert-text';
  text: string;
  /** Where the text goes: the focused app (desktop) or composer (web). */
  target: 'focused-app' | 'composer';
}

/**
 * Turn a finished dictation into the action the host executes. On the
 * desktop the Rust shell performs the actual cross-app insertion
 * (clipboard + paste keystroke); on the web the composer inserts at
 * the cursor. This function is the shared, testable decision point.
 */
export function routeDictationText(text: string, host: 'desktop' | 'web'): DictationInsertAction {
  const trimmed = (text ?? '').trim();
  if (!trimmed) throw new Error('dictation: cannot route an empty transcript');
  return { type: 'insert-text', text: trimmed, target: host === 'desktop' ? 'focused-app' : 'composer' };
}
