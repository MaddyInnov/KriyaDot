// SPDX-License-Identifier: Apache-2.0
//
// New TTS provider tests (ElevenLabs, Fish, Chatterbox, System) plus
// default-provider resolution. Every network call goes through an
// injected fetch stub and every OS call through an injected runner —
// no test may reach a real API or spawn a real speech binary.

import { describe, expect, it } from 'vitest';
import { ChatterboxTTSProvider } from '../src/chatterbox.js';
import {
  DEFAULT_ELEVENLABS_MODEL,
  DEFAULT_ELEVENLABS_VOICE,
  ELEVENLABS_BASE_URL,
  ElevenLabsTTSProvider,
} from '../src/elevenlabs.js';
import { FISH_BASE_URL, FishTTSProvider } from '../src/fish.js';
import {
  SystemTTSProvider,
  detectSystemTtsCommand,
  systemTtsInvocation,
} from '../src/system-tts.js';
import {
  isSTTProviderConfigured,
  isTTSProviderConfigured,
  resolveDefaultSTTProviderId,
  resolveDefaultTTSProviderId,
  selectSTTProvider,
  selectTTSProvider,
  type VoiceFetchFn,
} from '../src/voice.js';

interface CapturedCall {
  url: string;
  init?: RequestInit;
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response): { fetchFn: VoiceFetchFn; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchFn: VoiceFetchFn = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fetchFn, calls };
}

function bytesResponse(bytes: Uint8Array, mime = 'audio/mpeg', status = 200): Response {
  return new Response(bytes as unknown as BodyInit, { status, headers: { 'Content-Type': mime } });
}

function errorResponse(status: number, body = 'nope'): Response {
  return new Response(body, { status, statusText: status === 401 ? 'Unauthorized' : 'Error' });
}

// ---------------------------------------------------------------------------
// ElevenLabs
// ---------------------------------------------------------------------------

describe('ElevenLabsTTSProvider', () => {
  const KEY = { ELEVENLABS_API_KEY: 'xi-test-key' };

  it('POSTs to /text-to-speech/{voice} with xi-api-key and maps the audio', async () => {
    const { fetchFn, calls } = stubFetch((url, init) => {
      expect(url).toBe(
        `${ELEVENLABS_BASE_URL}/text-to-speech/${DEFAULT_ELEVENLABS_VOICE}?output_format=mp3_44100_128`,
      );
      const headers = new Headers(init?.headers);
      expect(headers.get('xi-api-key')).toBe('xi-test-key');
      const body = JSON.parse(String(init?.body));
      expect(body.text).toBe('Hello there');
      expect(body.model_id).toBe(DEFAULT_ELEVENLABS_MODEL);
      expect(body.voice_settings).toEqual({ stability: 0.5, similarity_boost: 0.75 });
      return bytesResponse(new Uint8Array([1, 2, 3]));
    });
    const res = await new ElevenLabsTTSProvider({ env: KEY, fetchFn }).synthesize('Hello there');
    expect(res.audio).toEqual(new Uint8Array([1, 2, 3]));
    expect(res.mimeType).toBe('audio/mpeg');
    expect(calls).toHaveLength(1);
  });

  it('honours per-call voice, model settings, and wav format', async () => {
    const { fetchFn } = stubFetch((url, init) => {
      expect(url).toContain('/text-to-speech/voice-42?output_format=wav_44100');
      const body = JSON.parse(String(init?.body));
      expect(body.model_id).toBe('eleven_turbo_v2_5');
      expect(body.voice_settings.stability).toBe(0.3);
      return bytesResponse(new Uint8Array([9]), 'audio/wav');
    });
    const tts = new ElevenLabsTTSProvider({
      env: KEY,
      fetchFn,
      modelId: 'eleven_turbo_v2_5',
      stability: 0.3,
      similarityBoost: 0.9,
    });
    const res = await tts.synthesize('hi', { voice: 'voice-42', format: 'wav' });
    expect(res.mimeType).toBe('audio/wav');
  });

  it('throws a clear error when ELEVENLABS_API_KEY is missing', () => {
    expect(() => new ElevenLabsTTSProvider({ env: {} })).toThrow(/ELEVENLABS_API_KEY/);
  });

  it('rejects empty text before any network call and surfaces HTTP errors', async () => {
    const { fetchFn, calls } = stubFetch(() => errorResponse(401, 'bad key'));
    const tts = new ElevenLabsTTSProvider({ env: KEY, fetchFn });
    await expect(tts.synthesize('   ')).rejects.toThrow(/non-empty/);
    expect(calls).toHaveLength(0);
    await expect(tts.synthesize('hello')).rejects.toThrow(/401/);
  });
});

// ---------------------------------------------------------------------------
// Fish Audio
// ---------------------------------------------------------------------------

describe('FishTTSProvider', () => {
  const KEY = { FISH_API_KEY: 'fish-test-key' };

  it('POSTs to /v1/tts with a Bearer key and reference_id from the voice', async () => {
    const { fetchFn } = stubFetch((url, init) => {
      expect(url).toBe(`${FISH_BASE_URL}/v1/tts`);
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBe('Bearer fish-test-key');
      const body = JSON.parse(String(init?.body));
      expect(body.text).toBe('Speak this');
      expect(body.reference_id).toBe('model-abc');
      expect(body.format).toBe('mp3');
      expect(body.normalize).toBe(true);
      return bytesResponse(new Uint8Array([7, 8]), 'audio/mpeg');
    });
    const res = await new FishTTSProvider({ env: KEY, fetchFn }).synthesize('Speak this', { voice: 'model-abc' });
    expect(res.audio).toEqual(new Uint8Array([7, 8]));
    expect(res.mimeType).toBe('audio/mpeg');
  });

  it('omits reference_id when no voice is configured', async () => {
    const { fetchFn } = stubFetch((_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect('reference_id' in body).toBe(false);
      return bytesResponse(new Uint8Array([1]), 'audio/wav');
    });
    const res = await new FishTTSProvider({ env: KEY, fetchFn }).synthesize('hi', { format: 'wav' });
    expect(res.mimeType).toBe('audio/wav');
  });

  it('uses the provider-level referenceId as the default voice', async () => {
    const { fetchFn } = stubFetch((_url, init) => {
      expect(JSON.parse(String(init?.body)).reference_id).toBe('default-model');
      return bytesResponse(new Uint8Array([1]));
    });
    await new FishTTSProvider({ env: KEY, fetchFn, referenceId: 'default-model' }).synthesize('hi');
  });

  it('throws a clear error when FISH_API_KEY is missing and surfaces HTTP errors', async () => {
    expect(() => new FishTTSProvider({ env: {} })).toThrow(/FISH_API_KEY/);
    const { fetchFn } = stubFetch(() => errorResponse(429, 'slow down'));
    await expect(new FishTTSProvider({ env: KEY, fetchFn }).synthesize('hi')).rejects.toThrow(/429/);
  });
});

// ---------------------------------------------------------------------------
// Chatterbox (self-hosted)
// ---------------------------------------------------------------------------

describe('ChatterboxTTSProvider', () => {
  const ENV = { CHATTERBOX_BASE_URL: 'http://127.0.0.1:8000/' };

  it('POSTs to {base}/tts (trailing slash trimmed) and returns raw audio', async () => {
    const { fetchFn } = stubFetch((url, init) => {
      expect(url).toBe('http://127.0.0.1:8000/tts');
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ text: 'local hello', format: 'wav', voice: 'narrator' });
      return bytesResponse(new Uint8Array([82, 73, 70, 70]), 'audio/wav');
    });
    const res = await new ChatterboxTTSProvider({ env: ENV, fetchFn }).synthesize('local hello', { voice: 'narrator' });
    expect(res.mimeType).toBe('audio/wav');
    expect(res.audio.length).toBe(4);
  });

  it('accepts a JSON-wrapped base64 audio response', async () => {
    const { fetchFn } = stubFetch(
      () =>
        new Response(
          JSON.stringify({ audio_base64: Buffer.from([5, 6, 7]).toString('base64'), mime_type: 'audio/wav' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    const res = await new ChatterboxTTSProvider({ env: ENV, fetchFn }).synthesize('wrapped');
    expect(res.audio).toEqual(new Uint8Array([5, 6, 7]));
    expect(res.mimeType).toBe('audio/wav');
  });

  it('throws a clear error when CHATTERBOX_BASE_URL is missing', () => {
    expect(() => new ChatterboxTTSProvider({ env: {} })).toThrow(/CHATTERBOX_BASE_URL/);
  });

  it('rejects empty text before any network call', async () => {
    const { fetchFn, calls } = stubFetch(() => bytesResponse(new Uint8Array([1])));
    await expect(new ChatterboxTTSProvider({ env: ENV, fetchFn }).synthesize(' ')).rejects.toThrow(/non-empty/);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// System TTS
// ---------------------------------------------------------------------------

describe('systemTtsInvocation / detectSystemTtsCommand', () => {
  it('maps platforms to their speech binaries', () => {
    expect(detectSystemTtsCommand('darwin')).toBe('say');
    expect(detectSystemTtsCommand('linux')).toBe('espeak-ng');
    expect(detectSystemTtsCommand('win32')).toBe('powershell');
    expect(detectSystemTtsCommand('aix')).toBeNull();
  });

  it('builds say / espeak invocations with the text last', () => {
    expect(systemTtsInvocation('darwin', 'hello', { voice: 'Alex' })).toEqual({
      command: 'say',
      args: ['-v', 'Alex', 'hello'],
      mimeType: 'audio/aiff',
    });
    expect(systemTtsInvocation('linux', 'hello')).toEqual({
      command: 'espeak-ng',
      args: ['hello'],
      mimeType: 'audio/wav',
    });
  });

  it('builds a PowerShell SAPI script with an {output} placeholder and escaped quotes', () => {
    const inv = systemTtsInvocation('win32', "it's me");
    expect(inv.command).toBe('powershell');
    expect(inv.args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
    expect(inv.args[3]).toContain("SetOutputToWaveFile('{output}')");
    expect(inv.args[3]).toContain("Speak('it''s me')");
    expect(inv.mimeType).toBe('audio/wav');
  });

  it('throws for a platform with no known binary', () => {
    expect(() => systemTtsInvocation('aix', 'hi')).toThrow(/no speech binary/);
  });
});

describe('SystemTTSProvider', () => {
  it('synthesizes through the injected runner and reports the platform mime', async () => {
    const seen: string[] = [];
    const tts = new SystemTTSProvider({
      platform: 'linux',
      probe: async () => true,
      runner: async (inv) => {
        seen.push(inv.command, ...inv.args);
        return new Uint8Array([1, 2, 3, 4]);
      },
    });
    const res = await tts.synthesize('offline hello', { voice: 'en+f2' });
    expect(res.audio).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(res.mimeType).toBe('audio/wav');
    expect(seen).toEqual(['espeak-ng', '-v', 'en+f2', 'offline hello']);
    expect(await tts.available()).toBe(true);
  });

  it('trusts an injected runner when no probe is injected', async () => {
    const tts = new SystemTTSProvider({ platform: 'darwin', runner: async () => new Uint8Array([9]) });
    expect(await tts.available()).toBe(true);
    const res = await tts.synthesize('hi');
    expect(res.mimeType).toBe('audio/aiff');
  });

  it('degrades cleanly when the binary is absent: available() false, clear error, no runner call', async () => {
    let ran = 0;
    const tts = new SystemTTSProvider({
      platform: 'linux',
      probe: async () => false,
      runner: async () => {
        ran++;
        return new Uint8Array([1]);
      },
    });
    expect(await tts.available()).toBe(false);
    await expect(tts.synthesize('hi')).rejects.toThrow(/espeak-ng.*not found/);
    expect(ran).toBe(0);
  });

  it('degrades cleanly on an unsupported platform', async () => {
    const tts = new SystemTTSProvider({ platform: 'aix', runner: async () => new Uint8Array([1]) });
    expect(tts.command).toBeNull();
    expect(await tts.available()).toBe(false);
    await expect(tts.synthesize('hi')).rejects.toThrow(/no speech binary/);
  });

  it('rejects empty runner output and empty text', async () => {
    const tts = new SystemTTSProvider({ platform: 'linux', runner: async () => new Uint8Array(0) });
    await expect(tts.synthesize('hi')).rejects.toThrow(/produced no audio/);
    await expect(tts.synthesize('  ')).rejects.toThrow(/non-empty/);
  });
});

// ---------------------------------------------------------------------------
// Default resolution + selectors
// ---------------------------------------------------------------------------

describe('default provider resolution', () => {
  it('mock is the default only when nothing is configured', () => {
    expect(resolveDefaultTTSProviderId({})).toBe('mock');
    expect(resolveDefaultSTTProviderId({})).toBe('mock');
    expect(selectTTSProvider({}).name).toBe('mock');
    expect(selectSTTProvider({}).name).toBe('mock');
  });

  it('a configured real TTS provider becomes the default', () => {
    expect(resolveDefaultTTSProviderId({ FISH_API_KEY: 'f' })).toBe('fish');
    expect(resolveDefaultTTSProviderId({ CHATTERBOX_BASE_URL: 'http://x' })).toBe('chatterbox');
    expect(resolveDefaultTTSProviderId({ GROQ_API_KEY: 'g' })).toBe('groq');
    expect(selectTTSProvider({ ELEVENLABS_API_KEY: 'e' }).name).toBe('elevenlabs');
    expect(selectTTSProvider({ FISH_API_KEY: 'f' }).name).toBe('fish');
    expect(selectTTSProvider({ CHATTERBOX_BASE_URL: 'http://127.0.0.1:8000' }).name).toBe('chatterbox');
    expect(selectTTSProvider({ GROQ_API_KEY: 'g' }).name).toBe('groq');
  });

  it('dedicated voice keys win over general keys (documented priority)', () => {
    expect(resolveDefaultTTSProviderId({ GROQ_API_KEY: 'g', OPENAI_API_KEY: 'o', ELEVENLABS_API_KEY: 'e' })).toBe(
      'elevenlabs',
    );
    expect(resolveDefaultTTSProviderId({ GROQ_API_KEY: 'g', FISH_API_KEY: 'f' })).toBe('fish');
  });

  it('an explicit VOICE_TTS_PROVIDER always wins, including explicit mock', () => {
    expect(resolveDefaultTTSProviderId({ VOICE_TTS_PROVIDER: 'mock', ELEVENLABS_API_KEY: 'e' })).toBe('mock');
    expect(resolveDefaultTTSProviderId({ VOICE_TTS_PROVIDER: 'system', ELEVENLABS_API_KEY: 'e' })).toBe('system');
    expect(selectTTSProvider({ VOICE_TTS_PROVIDER: 'system' }).name).toBe('system');
    expect(selectTTSProvider({ VOICE_TTS_PROVIDER: 'mock', FISH_API_KEY: 'f' }).name).toBe('mock');
  });

  it('explicit new providers without their key/URL throw the key error, not "unknown"', () => {
    expect(() => selectTTSProvider({ VOICE_TTS_PROVIDER: 'elevenlabs' })).toThrow(/ELEVENLABS_API_KEY/);
    expect(() => selectTTSProvider({ VOICE_TTS_PROVIDER: 'fish' })).toThrow(/FISH_API_KEY/);
    expect(() => selectTTSProvider({ VOICE_TTS_PROVIDER: 'chatterbox' })).toThrow(/CHATTERBOX_BASE_URL/);
  });

  it('STT defaults follow the same rule with the STT-capable providers', () => {
    expect(resolveDefaultSTTProviderId({ OPENAI_API_KEY: 'o' })).toBe('openai');
    expect(resolveDefaultSTTProviderId({ GROQ_API_KEY: 'g', OPENAI_API_KEY: 'o' })).toBe('groq');
    expect(resolveDefaultSTTProviderId({ VOICE_STT_PROVIDER: 'openai', GROQ_API_KEY: 'g' })).toBe('openai');
    expect(selectSTTProvider({ GROQ_API_KEY: 'g' }).name).toBe('groq');
    // TTS-only keys never leak into STT resolution.
    expect(resolveDefaultSTTProviderId({ ELEVENLABS_API_KEY: 'e', FISH_API_KEY: 'f' })).toBe('mock');
  });

  it('configuration probes reflect env presence', () => {
    expect(isTTSProviderConfigured('mock', {})).toBe(true);
    expect(isTTSProviderConfigured('elevenlabs', { ELEVENLABS_API_KEY: 'e' })).toBe(true);
    expect(isTTSProviderConfigured('elevenlabs', {})).toBe(false);
    expect(isTTSProviderConfigured('system', {})).toBe(false);
    expect(isSTTProviderConfigured('groq', { GROQ_API_KEY: 'g' })).toBe(true);
    expect(isSTTProviderConfigured('groq', {})).toBe(false);
  });
});
