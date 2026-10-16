// SPDX-License-Identifier: Apache-2.0
// Zero-network tests: fetch is stubbed, so no API server is needed.
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { HttpSTTProvider, HttpTTSProvider, bytesToBase64, base64ToBytes } from './voice-http';
import { resetApiBootstrap } from './api';

function stubFetch(handler: (url: string, init: RequestInit) => unknown) {
  // Fresh bootstrap per test so fetch call counts stay deterministic.
  resetApiBootstrap();
  (globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async (url: string, init: RequestInit) => {
    // Auth bootstrap: every authed request awaits this first.
    const payload = String(url).includes('/api/auth/bootstrap') ? { token: 'test-token' } : handler(url, init);
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => payload,
    };
  });
  return globalThis.fetch as ReturnType<typeof vi.fn>;
}

describe('base64 helpers', () => {
  it('round-trips bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });
});

describe('HttpSTTProvider', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('POSTs base64 audio to /api/voice/stt and returns the transcript', async () => {
    const fetchMock = stubFetch((url, init) => {
      expect(url).toContain('/api/voice/stt');
      const body = JSON.parse(String((init.body as string) ?? '{}'));
      expect(base64ToBytes(body.audioBase64)).toEqual(new Uint8Array([9, 8, 7]));
      return { text: 'hello world', confidence: 0.9, language: 'en' };
    });
    const stt = new HttpSTTProvider();
    const res = await stt.transcribe(new Uint8Array([9, 8, 7]), { language: 'en' });
    expect(res.text).toBe('hello world');
    expect(res.confidence).toBe(0.9);
    expect(fetchMock).toHaveBeenCalledTimes(2); // bootstrap + API call
  });

  it('rejects empty audio without touching the network', async () => {
    const fetchMock = stubFetch(() => ({}));
    await expect(new HttpSTTProvider().transcribe(new Uint8Array([]))).rejects.toThrow(
      /non-empty/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces API errors', async () => {
    resetApiBootstrap();
    (globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async (url: string) => {
      if (String(url).includes('/api/auth/bootstrap')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => ({ token: 'test-token' }) };
      }
      return {
        ok: false,
        status: 500,
        statusText: 'boom',
        json: async () => ({ error: 'stt exploded' }),
      };
    });
    await expect(new HttpSTTProvider().transcribe(new Uint8Array([1]))).rejects.toThrow(
      /stt exploded/,
    );
  });
});

describe('HttpTTSProvider', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('POSTs text to /api/voice/tts and decodes the audio', async () => {
    const wav = new Uint8Array([82, 73, 70, 70]); // 'RIFF'
    const fetchMock = stubFetch((url, init) => {
      expect(url).toContain('/api/voice/tts');
      const body = JSON.parse(String((init.body as string) ?? '{}'));
      expect(body.text).toBe('say this');
      return { audioBase64: bytesToBase64(wav), mimeType: 'audio/wav', durationMs: 600 };
    });
    const tts = new HttpTTSProvider();
    const res = await tts.synthesize('  say this  ');
    expect(res.audio).toEqual(wav);
    expect(res.mimeType).toBe('audio/wav');
    expect(fetchMock).toHaveBeenCalledTimes(2); // bootstrap + API call
  });

  it('rejects blank text without touching the network', async () => {
    const fetchMock = stubFetch(() => ({}));
    await expect(new HttpTTSProvider().synthesize('   ')).rejects.toThrow(/non-empty/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
