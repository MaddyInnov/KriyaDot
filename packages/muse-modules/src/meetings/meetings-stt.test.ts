// SPDX-License-Identifier: Apache-2.0
// M-6: meetings pipeline STT resolution — real STT by default, mock
// only when unconfigured or explicitly selected (tests). Fake fetch
// only: no network, no keys, no paid usage.
import { describe, it, expect } from 'vitest';
import { ValidationError } from '../errors.js';
import {
  MockMeetingSTTProvider,
  WhisperMeetingSTTProvider,
  resolveMeetingSTTProvider,
  resolveMeetingSTTProviderId,
  transcribeMeetingAudio,
  type MeetingSTTFetch,
} from './index.js';

describe('resolveMeetingSTTProviderId (M-6 real-by-default policy)', () => {
  it('prefers Groq, then OpenAI, when keys are configured', () => {
    expect(resolveMeetingSTTProviderId({ GROQ_API_KEY: 'g', OPENAI_API_KEY: 'o' })).toBe('groq');
    expect(resolveMeetingSTTProviderId({ OPENAI_API_KEY: 'o' })).toBe('openai');
    expect(resolveMeetingSTTProviderId({ GROQ_API_KEY: 'g' })).toBe('groq');
  });

  it('falls back to mock only when nothing is configured', () => {
    expect(resolveMeetingSTTProviderId({})).toBe('mock');
    expect(resolveMeetingSTTProviderId({ GROQ_API_KEY: '  ' })).toBe('mock');
  });

  it('explicit provider wins, including an explicit mock (tests)', () => {
    expect(resolveMeetingSTTProviderId({ VOICE_STT_PROVIDER: 'openai', GROQ_API_KEY: 'g', OPENAI_API_KEY: 'o' })).toBe('openai');
    expect(resolveMeetingSTTProviderId({ VOICE_STT_PROVIDER: 'mock', GROQ_API_KEY: 'g' })).toBe('mock');
    expect(resolveMeetingSTTProviderId({ MEETING_STT_PROVIDER: 'groq', VOICE_STT_PROVIDER: 'mock' })).toBe('groq');
  });
});

function fakeSTTFetch(payload: unknown, opts: { ok?: boolean; status?: number } = {}) {
  const calls: { url: string; form: FormData }[] = [];
  const fetchFn: MeetingSTTFetch = async (url, init) => {
    calls.push({ url, form: init.body });
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      json: async () => payload,
      text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
    };
  };
  return { fetchFn, calls };
}

describe('resolveMeetingSTTProvider + WhisperMeetingSTTProvider (M-6)', () => {
  it('resolves a real Groq provider when GROQ_API_KEY is set and transcribes via multipart Whisper shape', async () => {
    const { fetchFn, calls } = fakeSTTFetch({ text: 'we shipped the thing' });
    const stt = resolveMeetingSTTProvider({ GROQ_API_KEY: 'gk-test' }, fetchFn);
    expect(stt.name).toBe('groq');
    const { text } = await transcribeMeetingAudio(stt, new Uint8Array([1, 2, 3]), 'standup.mp3');
    expect(text).toBe('we shipped the thing');
    expect(calls[0].url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    expect(calls[0].form.get('model')).toBe('whisper-large-v3-turbo');
    expect(calls[0].form.get('file')).toBeTruthy();
  });

  it('resolves OpenAI Whisper when only OPENAI_API_KEY is set', async () => {
    const { fetchFn, calls } = fakeSTTFetch({ text: 'hello' });
    const stt = resolveMeetingSTTProvider({ OPENAI_API_KEY: 'ok-test' }, fetchFn);
    expect(stt.name).toBe('openai');
    await stt.transcribe(new Uint8Array([9]), { mimeType: 'audio/wav' });
    expect(calls[0].url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(calls[0].form.get('model')).toBe('whisper-1');
  });

  it('unconfigured resolution is the deterministic mock (no network seam touched)', async () => {
    const stt = resolveMeetingSTTProvider({});
    expect(stt).toBeInstanceOf(MockMeetingSTTProvider);
    const a = await stt.transcribe(new Uint8Array([1, 2, 3]));
    const b = await stt.transcribe(new Uint8Array([1, 2, 3]));
    expect(a.text).toBe(b.text);
  });

  it('explicit provider without its key is a clear error, not a silent mock', () => {
    expect(() => resolveMeetingSTTProvider({ VOICE_STT_PROVIDER: 'groq' })).toThrow(ValidationError);
    expect(() => resolveMeetingSTTProvider({ VOICE_STT_PROVIDER: 'bogus' })).toThrow(ValidationError);
  });

  it('HTTP failure surfaces status without leaking the key; empty transcript is an error', async () => {
    const { fetchFn } = fakeSTTFetch('down', { ok: false, status: 500 });
    const stt = new WhisperMeetingSTTProvider({ provider: 'groq', apiKey: 'gk-secret', fetchFn });
    const err = (await stt.transcribe(new Uint8Array([1])).catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/500/);
    expect(err.message).not.toContain('gk-secret');
    const empty = new WhisperMeetingSTTProvider({ provider: 'openai', apiKey: 'k', fetchFn: fakeSTTFetch({ text: ' ' }).fetchFn });
    await expect(empty.transcribe(new Uint8Array([1]))).rejects.toThrow(/no transcript/);
  });
});
