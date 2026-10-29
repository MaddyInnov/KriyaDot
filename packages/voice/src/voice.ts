// SPDX-License-Identifier: Apache-2.0
// Voice providers: STTProvider / TTSProvider interfaces, mock
// implementations, and a voice-session helper.
//
// Mock-first by design (standing rule: zero paid usage in testing): the
// mocks return canned data and cost nothing. Real providers are selected via
// env (VOICE_STT_PROVIDER / VOICE_TTS_PROVIDER) — 'groq'/'openai' are wired
// for STT; TTS additionally has 'elevenlabs' (ELEVENLABS_API_KEY), 'fish'
// (FISH_API_KEY), 'chatterbox' (self-hosted, CHATTERBOX_BASE_URL), and
// 'system' (the OS speech binary); anything else throws a clear error.
// Real providers MUST read keys from env, never hardcoded.
//
// Default resolution: with no explicit VOICE_*_PROVIDER, the selector
// picks the first configured real provider (see TTS_AUTO_PRIORITY /
// STT_AUTO_PRIORITY) and falls back to 'mock' only when nothing is
// configured — a configured real provider is never shadowed by the mock.

import { randomUUID } from 'node:crypto';
import { ChatterboxTTSProvider } from './chatterbox.js';
import { ElevenLabsTTSProvider } from './elevenlabs.js';
import { FishTTSProvider } from './fish.js';
import { GroqSTTProvider, GroqTTSProvider } from './groq.js';
import { OpenAISTTProvider, OpenAITTSProvider } from './openai.js';
import { SystemTTSProvider } from './system-tts.js';

/**
 * Injectable fetch shape shared by the network providers. Compatible
 * with the global fetch for real use; tests pass a stub so no test
 * ever touches the network.
 */
export type VoiceFetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** Provider ids the platform recognises. 'mock' is the fallback; real providers are key/URL-gated. */
export type STTProviderId = 'mock' | 'groq' | 'openai';
export type TTSProviderId = 'mock' | 'groq' | 'openai' | 'elevenlabs' | 'fish' | 'chatterbox' | 'system';

export const STT_PROVIDER_IDS: readonly STTProviderId[] = ['mock', 'groq', 'openai'];
export const TTS_PROVIDER_IDS: readonly TTSProviderId[] = [
  'mock',
  'groq',
  'openai',
  'elevenlabs',
  'fish',
  'chatterbox',
  'system',
];

export interface STTResult {
  text: string;
  /** 0–1 confidence when the provider reports one. */
  confidence?: number;
  language?: string;
  /** Input audio length in ms, when known. */
  durationMs?: number;
}

export interface STTTranscribeOptions {
  language?: string;
  mimeType?: string;
}

export interface STTProvider {
  readonly name: STTProviderId | string;
  transcribe(audio: Uint8Array, opts?: STTTranscribeOptions): Promise<STTResult>;
}

export interface TTSResult {
  audio: Uint8Array;
  mimeType: string;
  /** Synthesized audio length in ms, when known. */
  durationMs?: number;
}

export interface TTSSynthesizeOptions {
  voice?: string;
  language?: string;
  format?: 'wav' | 'mp3';
}

export interface TTSProvider {
  readonly name: TTSProviderId | string;
  synthesize(text: string, opts?: TTSSynthesizeOptions): Promise<TTSResult>;
}

/**
 * Mock STT: returns canned transcription text derived deterministically
 * from the input bytes (so tests can assert stability without any audio
 * model). Zero cost, zero network.
 */
export class MockSTTProvider implements STTProvider {
  readonly name = 'mock' as const;
  private readonly canned: string;

  constructor(canned = 'hello from the mock microphone') {
    this.canned = canned;
  }

  async transcribe(audio: Uint8Array, opts: STTTranscribeOptions = {}): Promise<STTResult> {
    if (!(audio instanceof Uint8Array) || audio.length === 0) {
      throw new Error('mock STT: audio must be a non-empty Uint8Array');
    }
    // Deterministic: same bytes → same transcript (a cheap checksum suffix
    // makes round-trips through the mock observable in tests).
    let checksum = 0;
    for (const b of audio) checksum = (checksum * 31 + b) >>> 0;
    return {
      text: `${this.canned} [${audio.length} bytes, ck=${checksum.toString(16)}]`,
      confidence: 1,
      language: opts.language ?? 'en',
    };
  }
}

/** WAV container constants for the mock TTS output. */
const WAV_SAMPLE_RATE = 8000;
const WAV_BITS_PER_SAMPLE = 16;
const WAV_CHANNELS = 1;

/**
 * Build a minimal PCM WAV buffer: `durationMs` of a sine tone whose
 * frequency is derived from `seed` (deterministic per input text, so the
 * mock output is stable and recognizably non-empty).
 */
export function makeMockWav(seed: string, durationMs = 600): Uint8Array {
  const samples = Math.max(1, Math.floor((WAV_SAMPLE_RATE * durationMs) / 1000));
  let hash = 2166136261;
  for (const ch of seed) {
    hash ^= ch.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  const freq = 220 + (hash >>> 0) % 440; // 220–659 Hz
  const data = new Uint8Array(44 + samples * 2);
  const view = new DataView(data.buffer);
  const writeAscii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, WAV_CHANNELS, true);
  view.setUint32(24, WAV_SAMPLE_RATE, true);
  view.setUint32(28, WAV_SAMPLE_RATE * WAV_CHANNELS * (WAV_BITS_PER_SAMPLE / 8), true);
  view.setUint16(32, WAV_CHANNELS * (WAV_BITS_PER_SAMPLE / 8), true);
  view.setUint16(34, WAV_BITS_PER_SAMPLE, true);
  writeAscii(36, 'data');
  view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++) {
    const t = i / WAV_SAMPLE_RATE;
    // Fade in/out to avoid clicks; modest amplitude.
    const env = Math.min(1, i / 200, (samples - i) / 200);
    const sample = Math.round(12000 * env * Math.sin(2 * Math.PI * freq * t));
    view.setInt16(44 + i * 2, sample, true);
  }
  return data;
}

/**
 * Mock TTS: synthesizes deterministic mock audio (a short WAV tone, NOT
 * real speech) for any text. Zero cost, zero network. `format: 'mp3'` is
 * accepted but still returns WAV bytes with the honest mimeType — the mock
 * never pretends to encode MP3.
 */
export class MockTTSProvider implements TTSProvider {
  readonly name = 'mock' as const;

  async synthesize(text: string, opts: TTSSynthesizeOptions = {}): Promise<TTSResult> {
    const trimmed = text.trim();
    if (!trimmed) throw new Error('mock TTS: text must be non-empty');
    if (trimmed.length > 5000) throw new Error('mock TTS: text too long (max 5000 chars)');
    const format = opts.format ?? 'wav';
    if (format !== 'wav' && format !== 'mp3') throw new Error(`mock TTS: unsupported format "${format}"`);
    // ~40ms per char, clamped to 0.3–5s, keeps the fixture small.
    const durationMs = Math.min(5000, Math.max(300, trimmed.length * 40));
    return {
      audio: makeMockWav(trimmed, durationMs),
      mimeType: 'audio/wav',
      durationMs,
    };
  }
}

/**
 * Auto-default priority for TTS when VOICE_TTS_PROVIDER is unset:
 * dedicated voice services first (their key existing at all is a
 * strong voice-specific signal), then the self-hosted server, then
 * the general key-gated providers. 'system' is never auto-selected —
 * env alone cannot prove the OS binary exists.
 * Keep in sync with apps/api/src/bot-voice.ts (TTS_AUTO_PRIORITY).
 */
export const TTS_AUTO_PRIORITY: readonly TTSProviderId[] = ['elevenlabs', 'fish', 'chatterbox', 'groq', 'openai'];
/** Auto-default priority for STT when VOICE_STT_PROVIDER is unset. */
export const STT_AUTO_PRIORITY: readonly STTProviderId[] = ['groq', 'openai'];

function envHas(env: NodeJS.ProcessEnv, name: string): boolean {
  return typeof env[name] === 'string' && env[name]!.trim().length > 0;
}

/** Whether a TTS provider is usable from env alone (key/URL present). */
export function isTTSProviderConfigured(id: TTSProviderId | string, env: NodeJS.ProcessEnv = process.env): boolean {
  switch (id) {
    case 'mock':
      return true;
    case 'elevenlabs':
      return envHas(env, 'ELEVENLABS_API_KEY');
    case 'fish':
      return envHas(env, 'FISH_API_KEY');
    case 'chatterbox':
      return envHas(env, 'CHATTERBOX_BASE_URL');
    case 'groq':
      return envHas(env, 'GROQ_API_KEY');
    case 'openai':
      return envHas(env, 'OPENAI_API_KEY');
    default:
      // 'system' (binary presence is a runtime probe, not env) and
      // unknown ids are never reported as env-configured.
      return false;
  }
}

/** Whether an STT provider is usable from env alone (key present). */
export function isSTTProviderConfigured(id: STTProviderId | string, env: NodeJS.ProcessEnv = process.env): boolean {
  switch (id) {
    case 'mock':
      return true;
    case 'groq':
      return envHas(env, 'GROQ_API_KEY');
    case 'openai':
      return envHas(env, 'OPENAI_API_KEY');
    default:
      return false;
  }
}

/**
 * The TTS provider id that applies when nothing overrides it: the
 * explicit VOICE_TTS_PROVIDER when set, else the first configured real
 * provider (TTS_AUTO_PRIORITY), else 'mock'.
 */
export function resolveDefaultTTSProviderId(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['VOICE_TTS_PROVIDER']?.trim().toLowerCase();
  if (explicit) return explicit;
  for (const id of TTS_AUTO_PRIORITY) {
    if (isTTSProviderConfigured(id, env)) return id;
  }
  return 'mock';
}

/** STT twin of resolveDefaultTTSProviderId (VOICE_STT_PROVIDER wins). */
export function resolveDefaultSTTProviderId(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['VOICE_STT_PROVIDER']?.trim().toLowerCase();
  if (explicit) return explicit;
  for (const id of STT_AUTO_PRIORITY) {
    if (isSTTProviderConfigured(id, env)) return id;
  }
  return 'mock';
}

/** Env-driven provider selection; default resolution per resolveDefaultSTTProviderId. */
export function selectSTTProvider(env: NodeJS.ProcessEnv = process.env): STTProvider {
  const id = resolveDefaultSTTProviderId(env);
  if (id === 'mock') return new MockSTTProvider();
  if (id === 'groq') return new GroqSTTProvider({ env });
  if (id === 'openai') return new OpenAISTTProvider({ env });
  throw new Error(
    `unknown STT provider "${id}" (VOICE_STT_PROVIDER). Available: ${STT_PROVIDER_IDS.map((p) => `"${p}"`).join(', ')}.`,
  );
}

/** Env-driven provider selection; default resolution per resolveDefaultTTSProviderId. */
export function selectTTSProvider(env: NodeJS.ProcessEnv = process.env): TTSProvider {
  const id = resolveDefaultTTSProviderId(env);
  if (id === 'mock') return new MockTTSProvider();
  if (id === 'groq') return new GroqTTSProvider({ env });
  if (id === 'openai') return new OpenAITTSProvider({ env });
  if (id === 'elevenlabs') return new ElevenLabsTTSProvider({ env });
  if (id === 'fish') return new FishTTSProvider({ env });
  if (id === 'chatterbox') return new ChatterboxTTSProvider({ env });
  if (id === 'system') return new SystemTTSProvider();
  throw new Error(
    `unknown TTS provider "${id}" (VOICE_TTS_PROVIDER). Available: ${TTS_PROVIDER_IDS.map((p) => `"${p}"`).join(', ')}.`,
  );
}

export interface VoiceTurn {
  id: string;
  at: number;
  transcript: string;
  replyText?: string;
  replyAudioBytes?: number;
}

/**
 * Voice session helper: runs the push-to-talk loop (transcribe inbound
 * audio → hand transcript to the caller → synthesize the reply) while
 * tracking turn history. The caller supplies the "brain" (LLM reply);
 * this helper owns only the voice edges.
 */
export class VoiceSession {
  readonly id: string;
  readonly createdAt: number;
  private readonly turns: VoiceTurn[] = [];

  constructor(
    private readonly stt: STTProvider,
    private readonly tts: TTSProvider,
  ) {
    this.id = `voice_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    this.createdAt = Date.now();
  }

  turnsList(): VoiceTurn[] {
    return this.turns.map((t) => ({ ...t }));
  }

  /** Transcribe one inbound audio chunk. */
  async listen(audio: Uint8Array, opts?: STTTranscribeOptions): Promise<STTResult> {
    return this.stt.transcribe(audio, opts);
  }

  /** Synthesize one reply utterance. */
  async speak(text: string, opts?: TTSSynthesizeOptions): Promise<TTSResult> {
    return this.tts.synthesize(text, opts);
  }

  /**
   * Full turn: transcribe `audio`, call `respond(transcript)` for the reply
   * text, synthesize it, record the turn, and return everything the UI
   * needs to render + play the exchange.
   */
  async turn(
    audio: Uint8Array,
    respond: (transcript: string) => Promise<string> | string,
    opts?: { stt?: STTTranscribeOptions; tts?: TTSSynthesizeOptions },
  ): Promise<{ transcript: string; replyText: string; replyAudio: TTSResult }> {
    const { text: transcript } = await this.listen(audio, opts?.stt);
    const replyText = await respond(transcript);
    const replyAudio = await this.speak(replyText, opts?.tts);
    this.turns.push({
      id: `turn_${randomUUID().replace(/-/g, '').slice(0, 8)}`,
      at: Date.now(),
      transcript,
      replyText,
      replyAudioBytes: replyAudio.audio.length,
    });
    return { transcript, replyText, replyAudio };
  }
}
