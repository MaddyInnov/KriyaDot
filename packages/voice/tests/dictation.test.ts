// SPDX-License-Identifier: Apache-2.0
// V-5 TS/web-side dictation tests: hotkey config, the Web Speech
// fallback engine (fake recognition object — no browser, no network),
// and the push-to-talk state machine. The Rust/native side is
// source-only and NOT covered here (no cargo toolchain on this VM).
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PTT_ACCELERATOR,
  parseAccelerator,
  formatAccelerator,
  normalizeHotkeyConfig,
  WebSpeechDictationEngine,
  PushToTalkController,
  routeDictationText,
  type DictationEngine,
  type SpeechRecognitionLike,
} from '../src/dictation.js';

describe('hotkey config (V-5)', () => {
  it('parses and canonicalizes accelerators', () => {
    const parsed = parseAccelerator('ctrl+shift+space');
    expect(parsed).toEqual({ modifiers: ['control', 'shift'], key: 'Space' });
    expect(formatAccelerator(parsed)).toBe('Control+Shift+Space');
    expect(parseAccelerator(DEFAULT_PTT_ACCELERATOR).key).toBe('Space');
    expect(parseAccelerator('Alt+F9')).toEqual({ modifiers: ['alt'], key: 'F9' });
  });

  it('rejects bare keys, modifier-only triggers, duplicates, and junk', () => {
    expect(() => parseAccelerator('Space')).toThrow(/at least one modifier/);
    expect(() => parseAccelerator('Control+Shift')).toThrow(/cannot be a modifier/);
    expect(() => parseAccelerator('Shift+Shift+A')).toThrow(/duplicate/);
    expect(() => parseAccelerator('Control+Banana+A')).toThrow(/not a known modifier/);
    expect(() => parseAccelerator('')).toThrow(/non-empty/);
  });

  it('normalizeHotkeyConfig fills defaults and validates the language tag', () => {
    expect(normalizeHotkeyConfig()).toEqual({
      accelerator: DEFAULT_PTT_ACCELERATOR,
      holdToTalk: true,
      language: 'en-US',
    });
    expect(normalizeHotkeyConfig({ accelerator: 'ctrl+alt+d', holdToTalk: false, language: 'en-IN' })).toEqual({
      accelerator: 'Control+Alt+D',
      holdToTalk: false,
      language: 'en-IN',
    });
    expect(() => normalizeHotkeyConfig({ language: 'not a locale!' })).toThrow(/BCP-47/);
  });
});

class FakeRecognition implements SpeechRecognitionLike {
  lang = '';
  interimResults = false;
  continuous = false;
  onresult: SpeechRecognitionLike['onresult'] = null;
  onerror: SpeechRecognitionLike['onerror'] = null;
  onend: SpeechRecognitionLike['onend'] = null;
  started = false;
  stopped = false;
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
    this.onend?.();
  }
  emitFinal(transcript: string) {
    const results = [{ isFinal: true, 0: { transcript } }] as unknown as SpeechRecognitionEventLike['results'];
    this.onresult?.({ resultIndex: 0, results });
  }
  emitInterim(transcript: string) {
    const results = [{ isFinal: false, 0: { transcript } }] as unknown as SpeechRecognitionEventLike['results'];
    this.onresult?.({ resultIndex: 0, results });
  }
}
type SpeechRecognitionEventLike = Parameters<NonNullable<SpeechRecognitionLike['onresult']>>[0];

describe('WebSpeechDictationEngine (web fallback)', () => {
  it('accumulates final results and delivers them on end; interim flows separately', () => {
    const fake = new FakeRecognition();
    const engine = new WebSpeechDictationEngine(() => fake, 'en-IN');
    expect(engine.supported).toBe(true);
    const finals: string[] = [];
    const interims: string[] = [];
    engine.start({ onFinal: (t) => finals.push(t), onInterim: (t) => interims.push(t) });
    expect(fake.started).toBe(true);
    expect(fake.lang).toBe('en-IN');
    expect(fake.interimResults).toBe(true);
    fake.emitInterim('hel');
    fake.emitFinal('hello world');
    engine.stop();
    expect(interims).toEqual(['hel']);
    expect(finals).toEqual(['hello world']);
  });

  it('reports unsupported honestly when no recognition exists', () => {
    const engine = new WebSpeechDictationEngine(() => null);
    expect(engine.supported).toBe(false);
    const errors: Error[] = [];
    engine.start({ onFinal: () => undefined, onError: (e) => errors.push(e) });
    expect(errors[0].message).toMatch(/not available/);
    const fromGlobal = WebSpeechDictationEngine.fromGlobal({});
    expect(fromGlobal.supported).toBe(false);
  });
});

describe('PushToTalkController', () => {
  function stubEngine() {
    const state = { starts: 0, stops: 0 };
    const engine: DictationEngine = {
      name: 'stub',
      supported: true,
      start(cb) {
        state.starts++;
        (engine as unknown as { cb: unknown }).cb = cb;
      },
      stop() {
        state.stops++;
        const cb = (engine as unknown as { cb: { onFinal: (t: string) => void } }).cb;
        cb.onFinal('stub transcript');
      },
    };
    return { engine, state };
  }

  it('hold-to-talk: press starts once (repeats ignored), release stops and delivers', () => {
    const { engine, state } = stubEngine();
    const delivered: string[] = [];
    const ptt = new PushToTalkController(engine, normalizeHotkeyConfig(), (t) => delivered.push(t));
    ptt.press();
    ptt.press(); // key auto-repeat
    expect(state.starts).toBe(1);
    expect(ptt.state).toBe('listening');
    ptt.release();
    expect(state.stops).toBe(1);
    expect(delivered).toEqual(['stub transcript']);
    expect(ptt.state).toBe('idle');
    ptt.release(); // release while idle: no-op
    expect(state.stops).toBe(1);
  });

  it('toggle mode: press starts, release does nothing, next press stops', () => {
    const { engine, state } = stubEngine();
    const ptt = new PushToTalkController(engine, normalizeHotkeyConfig({ holdToTalk: false }), () => undefined);
    ptt.pressToggle();
    expect(ptt.state).toBe('listening');
    ptt.release();
    expect(state.stops).toBe(0);
    ptt.pressToggle();
    expect(state.stops).toBe(1);
    expect(ptt.state).toBe('idle');
  });

  it('routeDictationText targets the focused app on desktop, composer on web; empty text rejected', () => {
    expect(routeDictationText('  hello there ', 'desktop')).toEqual({
      type: 'insert-text',
      text: 'hello there',
      target: 'focused-app',
    });
    expect(routeDictationText('hi', 'web').target).toBe('composer');
    expect(() => routeDictationText('   ', 'web')).toThrow(/empty transcript/);
  });
});
