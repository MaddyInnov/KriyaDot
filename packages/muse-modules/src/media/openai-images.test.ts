// SPDX-License-Identifier: Apache-2.0
// OpenAI-compatible images provider (C9) — injected fake fetch ONLY.
// No network, no keys: live verification is credential-gated by design.
import { describe, it, expect } from 'vitest';
import { ValidationError } from '../errors.js';
import {
  OpenAIImagesProvider,
  openAIImagesProviderFromEnv,
  resolveMediaProvider,
  type MediaFetch,
} from './index.js';

function fakeFetch(payload: unknown, opts: { ok?: boolean; status?: number } = {}) {
  const calls: { url: string; init: { method: string; headers: Record<string, string>; body: string } }[] = [];
  const fetchFn: MediaFetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      json: async () => payload,
      text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
    };
  };
  return { fetchFn, calls };
}

describe('OpenAIImagesProvider', () => {
  it('POSTs the OpenAI images shape with the bearer key and returns the URL asset', async () => {
    const { fetchFn, calls } = fakeFetch({ data: [{ url: 'https://cdn.example/img.png' }] });
    const provider = new OpenAIImagesProvider({
      apiKey: 'sk-test-not-real',
      baseUrl: 'https://images.example/v1/',
      model: 'img-model-1',
      fetchFn,
    });
    const asset = await provider.generate('image', 'a lighthouse at dawn');
    expect(asset.provider).toBe('openai-images');
    expect(asset.kind).toBe('image');
    expect(asset.url).toBe('https://cdn.example/img.png');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://images.example/v1/images/generations');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers.authorization).toBe('Bearer sk-test-not-real');
    const body = JSON.parse(calls[0].init.body) as Record<string, unknown>;
    expect(body).toMatchObject({ model: 'img-model-1', prompt: 'a lighthouse at dawn', n: 1 });
  });

  it('handles b64_json responses with a data URL and real byteLength', async () => {
    const b64 = Buffer.from('fake-png-bytes').toString('base64');
    const { fetchFn } = fakeFetch({ data: [{ b64_json: b64 }] });
    const provider = new OpenAIImagesProvider({ apiKey: 'k', fetchFn });
    const asset = await provider.generate('image', 'x');
    expect(asset.url).toBe(`data:image/png;base64,${b64}`);
    expect(asset.byteLength).toBe(Buffer.from('fake-png-bytes').length);
  });

  it('rejects non-image kinds instead of faking them', async () => {
    const { fetchFn } = fakeFetch({ data: [{ url: 'https://x/y' }] });
    const provider = new OpenAIImagesProvider({ apiKey: 'k', fetchFn });
    await expect(provider.generate('video', 'x')).rejects.toThrow(ValidationError);
    await expect(provider.generate('audio', 'x')).rejects.toThrow(ValidationError);
  });

  it('surfaces HTTP errors without leaking the API key', async () => {
    const { fetchFn } = fakeFetch('upstream exploded', { ok: false, status: 429 });
    const provider = new OpenAIImagesProvider({ apiKey: 'sk-secret-value', fetchFn });
    const err = (await provider.generate('image', 'x').catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/429/);
    expect(err.message).not.toContain('sk-secret-value');
  });

  it('throws on an empty data array', async () => {
    const { fetchFn } = fakeFetch({ data: [] });
    const provider = new OpenAIImagesProvider({ apiKey: 'k', fetchFn });
    await expect(provider.generate('image', 'x')).rejects.toThrow(/no image/);
  });

  it('requires a key at construction', () => {
    expect(() => new OpenAIImagesProvider({ apiKey: '  ' })).toThrow(ValidationError);
  });
});

describe('resolver selection (C9)', () => {
  it('selects the real provider when MEDIA_IMAGES_API_KEY is configured', async () => {
    const { fetchFn } = fakeFetch({ data: [{ url: 'https://cdn.example/a.png' }] });
    const provider = resolveMediaProvider(
      { MEDIA_IMAGES_API_KEY: 'k', MEDIA_IMAGES_BASE_URL: 'https://images.example/v1' },
      fetchFn,
    );
    expect(provider.name).toBe('openai-images');
    const asset = await provider.generate('image', 'y');
    expect(asset.url).toBe('https://cdn.example/a.png');
  });

  it('falls back to the mock when no key is configured', async () => {
    const provider = resolveMediaProvider({}, undefined);
    expect(provider.name).toBe('mock');
    const asset = await provider.generate('image', 'y');
    expect(asset.url).toMatch(/^mock:\/\//);
  });

  it('openAIImagesProviderFromEnv returns undefined without a key', () => {
    expect(openAIImagesProviderFromEnv({})).toBeUndefined();
    expect(openAIImagesProviderFromEnv({ MEDIA_IMAGES_API_KEY: 'k' })?.name).toBe('openai-images');
  });
});
