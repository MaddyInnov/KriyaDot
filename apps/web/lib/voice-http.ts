// SPDX-License-Identifier: Apache-2.0
// Browser adapters for the @mvp/voice provider interfaces.
//
// The web console is a static export served to browsers, so it cannot import
// the @mvp/voice runtime (voice.ts pulls in node:crypto). These adapters
// implement the exact STTProvider / TTSProvider interfaces over the API's
// /api/voice/* HTTP routes (apps/api/src/voice.ts), which are backed by the
// real @mvp/voice providers server-side — mock by default, zero paid usage.
//
// Type-only imports: erased at compile time, nothing ships to the bundle.
// UI code depends on the interfaces, never on a concrete provider.

'use client';

import type {
  STTProvider,
  STTResult,
  STTTranscribeOptions,
  TTSProvider,
  TTSResult,
  TTSSynthesizeOptions,
} from '@mvp/voice';
import { authedFetch } from './api';

/** Uint8Array → base64 (chunked to avoid call-stack blowups on large audio). */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let out = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

/** base64 → Uint8Array. */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await authedFetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: string }).error ?? '';
    } catch {
      // ignore
    }
    throw new Error(`voice API ${res.status}: ${detail || res.statusText}`);
  }
  return (await res.json()) as T;
}

/**
 * STTProvider over POST /api/voice/stt. Server default is the mock
 * provider (deterministic canned text, zero cost).
 */
export class HttpSTTProvider implements STTProvider {
  readonly name = 'http';
  private readonly language?: string;

  constructor(opts: { language?: string } = {}) {
    this.language = opts.language;
  }

  async transcribe(audio: Uint8Array, opts: STTTranscribeOptions = {}): Promise<STTResult> {
    if (!(audio instanceof Uint8Array) || audio.length === 0) {
      throw new Error('http STT: audio must be a non-empty Uint8Array');
    }
    const { text, confidence, language } = await postJson<{
      text: string;
      confidence?: number;
      language?: string;
    }>('/api/voice/stt', {
      audioBase64: bytesToBase64(audio),
      mimeType: opts.mimeType,
      language: opts.language ?? this.language,
    });
    return { text, confidence, language, durationMs: undefined };
  }
}

/**
 * TTSProvider over POST /api/voice/tts. Server default is the mock
 * provider (deterministic WAV tone, zero cost — NOT real speech).
 */
export class HttpTTSProvider implements TTSProvider {
  readonly name = 'http';
  private readonly voice?: string;

  constructor(opts: { voice?: string } = {}) {
    this.voice = opts.voice;
  }

  async synthesize(text: string, opts: TTSSynthesizeOptions = {}): Promise<TTSResult> {
    const trimmed = text.trim();
    if (!trimmed) throw new Error('http TTS: text must be non-empty');
    const { audioBase64, mimeType, durationMs } = await postJson<{
      audioBase64: string;
      mimeType: string;
      durationMs?: number;
    }>('/api/voice/tts', {
      text: trimmed,
      voice: opts.voice ?? this.voice,
      format: opts.format ?? 'wav',
    });
    return { audio: base64ToBytes(audioBase64), mimeType, durationMs };
  }
}

let sttSingleton: HttpSTTProvider | null = null;
let ttsSingleton: HttpTTSProvider | null = null;

/** Shared browser-side providers for the MVP (mock-backed on the server). */
export function getWebSTTProvider(): STTProvider {
  if (!sttSingleton) sttSingleton = new HttpSTTProvider();
  return sttSingleton;
}

/** Shared browser-side providers for the MVP (mock-backed on the server). */
export function getWebTTSProvider(): TTSProvider {
  if (!ttsSingleton) ttsSingleton = new HttpTTSProvider();
  return ttsSingleton;
}
