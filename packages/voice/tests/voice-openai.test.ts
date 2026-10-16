// SPDX-License-Identifier: Apache-2.0
//
// OpenAI voice provider tests. The HTTP layer is fully mocked — no test may
// ever reach api.openai.com (standing rule: zero paid API usage in tests).

import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_OPENAI_STT_MODEL,
  DEFAULT_OPENAI_TTS_MODEL,
  DEFAULT_OPENAI_TTS_VOICE,
  OPENAI_VOICE_BASE_URL,
  OpenAISTTProvider,
  OpenAITTSProvider,
} from '../src/openai.js';
import { selectSTTProvider, selectTTSProvider } from '../src/voice.js';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Captured {
  url: string;
  init?: RequestInit;
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response): Captured {
  const captured: Captured = { url: '' };
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    captured.url = String(url);
    captured.init = init;
    return handler(String(url), init);
  }) as typeof fetch;
  return captured;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function bytesResponse(bytes: Uint8Array, mime = 'audio/mpeg'): Response {
  return new Response(bytes as unknown as BodyInit, {
    status: 200,
    headers: { 'Content-Type': mime },
  });
}

const KEY_ENV = { OPENAI_API_KEY: 'sk-test-openai-key' };

describe('OpenAISTTProvider', () => {
  it('POSTs multipart audio to /audio/transcriptions and returns the text', async () => {
    stubFetch((url, init) => {
      expect(url).toBe(`${OPENAI_VOICE_BASE_URL}/audio/transcriptions`);
      expect(init?.method).toBe('POST');
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBe('Bearer sk-test-openai-key');
      const form = init?.body as FormData;
      expect(form.get('model')).toBe(DEFAULT_OPENAI_STT_MODEL);
      expect(form.get('response_format')).toBe('json');
      expect(form.get('file')).toBeInstanceOf(Blob);
      return jsonResponse({ text: 'hello from openai whisper' });
    });
    const stt = new OpenAISTTProvider({ env: KEY_ENV });
    const res = await stt.transcribe(new Uint8Array([1, 2, 3, 4]));
    expect(res.text).toBe('hello from openai whisper');
  });

  it('throws a clear error when OPENAI_API_KEY is missing', () => {
    expect(() => new OpenAISTTProvider({ env: {} })).toThrow(/OPENAI_API_KEY/);
  });

  it('rejects empty audio before any network call', async () => {
    let calls = 0;
    stubFetch(() => {
      calls++;
      return jsonResponse({ text: 'x' });
    });
    await expect(new OpenAISTTProvider({ env: KEY_ENV }).transcribe(new Uint8Array(0))).rejects.toThrow(
      /non-empty/,
    );
    expect(calls).toBe(0);
  });

  it('surfaces provider errors with status and body excerpt', async () => {
    stubFetch(() => jsonResponse({ error: { message: 'bad key' } }, 401));
    await expect(new OpenAISTTProvider({ env: KEY_ENV }).transcribe(new Uint8Array([1]))).rejects.toThrow(
      /401/,
    );
  });
});

describe('OpenAITTSProvider', () => {
  it('POSTs JSON to /audio/speech and returns mp3 audio by default', async () => {
    stubFetch((url, init) => {
      expect(url).toBe(`${OPENAI_VOICE_BASE_URL}/audio/speech`);
      expect(init?.method).toBe('POST');
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBe('Bearer sk-test-openai-key');
      expect(headers.get('Content-Type')).toContain('application/json');
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe(DEFAULT_OPENAI_TTS_MODEL);
      expect(body.input).toBe('Hello world');
      expect(body.voice).toBe(DEFAULT_OPENAI_TTS_VOICE);
      expect(body.response_format).toBe('mp3');
      return bytesResponse(new Uint8Array([10, 20, 30]));
    });
    const tts = new OpenAITTSProvider({ env: KEY_ENV });
    const res = await tts.synthesize('Hello world');
    expect(res.audio).toEqual(new Uint8Array([10, 20, 30]));
    expect(res.mimeType).toBe('audio/mpeg');
  });

  it('honours a per-call voice override', async () => {
    stubFetch((_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.voice).toBe('shimmer');
      return bytesResponse(new Uint8Array([1]));
    });
    const res = await new OpenAITTSProvider({ env: KEY_ENV }).synthesize('hi', { voice: 'shimmer' });
    expect(res.audio.length).toBe(1);
  });

  it('throws a clear error when OPENAI_API_KEY is missing', () => {
    expect(() => new OpenAITTSProvider({ env: {} })).toThrow(/OPENAI_API_KEY/);
  });

  it('rejects empty text before any network call', async () => {
    let calls = 0;
    stubFetch(() => {
      calls++;
      return bytesResponse(new Uint8Array([1]));
    });
    await expect(new OpenAITTSProvider({ env: KEY_ENV }).synthesize('   ')).rejects.toThrow(/non-empty/);
    expect(calls).toBe(0);
  });
});

describe('selectSTTProvider / selectTTSProvider with openai', () => {
  it('selects openai providers when the env ids are set', () => {
    expect(selectSTTProvider({ ...KEY_ENV, VOICE_STT_PROVIDER: 'openai' }).name).toBe('openai');
    expect(selectTTSProvider({ ...KEY_ENV, VOICE_TTS_PROVIDER: 'openai' }).name).toBe('openai');
  });

  it('still defaults to mock', () => {
    expect(selectSTTProvider({}).name).toBe('mock');
    expect(selectTTSProvider({}).name).toBe('mock');
  });
});
