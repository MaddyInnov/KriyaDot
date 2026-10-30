// SPDX-License-Identifier: Apache-2.0
// M-4 video provider tests — injected fake fetch ONLY. No network, no
// keys, no paid usage; the real provider path is proven against fakes.
import { describe, it, expect } from 'vitest';
import { ValidationError } from '../errors.js';
import type { MediaFetch } from './openai-images.js';
import {
  HttpVideoProvider,
  MockVideoProvider,
  VideoBackedMediaProvider,
  CompositeMediaProvider,
  httpVideoProviderFromEnv,
  resolveVideoProvider,
  pollVideoJob,
  type VideoJob,
  type VideoProvider,
} from './video-provider.js';
import { MockMediaProvider } from './index.js';

type Call = { url: string; init: { method: string; headers: Record<string, string>; body: string } };

/** Fake fetch playing a scripted sequence of JSON payloads. */
function scriptedFetch(payloads: unknown[]) {
  const calls: Call[] = [];
  let i = 0;
  const fetchFn: MediaFetch = async (url, init) => {
    calls.push({ url, init });
    const payload = payloads[Math.min(i++, payloads.length - 1)];
    return {
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  };
  return { fetchFn, calls };
}

describe('HttpVideoProvider (M-4)', () => {
  it('text-to-video: POSTs the job shape with the bearer key, then polls to completion', async () => {
    const { fetchFn, calls } = scriptedFetch([
      { id: 'job-1', status: 'queued' },
      { id: 'job-1', status: 'in_progress' },
      { id: 'job-1', status: 'completed', output: { url: 'https://cdn.example/out.mp4' } },
    ]);
    const provider = new HttpVideoProvider({ apiKey: 'vk-test', baseUrl: 'https://vid.example/v1/', fetchFn });
    const job = await provider.textToVideo('a drone shot of a lighthouse', { durationSeconds: 6, aspectRatio: '16:9' });
    expect(job.status).toBe('queued');
    expect(calls[0].url).toBe('https://vid.example/v1/video/generations');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers.authorization).toBe('Bearer vk-test');
    const body = JSON.parse(calls[0].init.body) as Record<string, unknown>;
    expect(body).toMatchObject({ prompt: 'a drone shot of a lighthouse', duration_seconds: 6, aspect_ratio: '16:9' });
    expect(body.image_url).toBeUndefined();

    const done = await pollVideoJob(provider, job, { pollIntervalMs: 0 });
    expect(done.status).toBe('completed');
    expect(done.url).toBe('https://cdn.example/out.mp4');
    expect(calls[1].init.method).toBe('GET');
    expect(calls[1].url).toBe('https://vid.example/v1/video/generations/job-1');
  });

  it('image-to-video: sends image_url and understands video_url output naming', async () => {
    const { fetchFn, calls } = scriptedFetch([
      { id: 'job-2', status: 'processing' },
      { id: 'job-2', status: 'succeeded', video_url: 'https://cdn.example/anim.mp4' },
    ]);
    const provider = new HttpVideoProvider({ apiKey: 'k', fetchFn });
    const job = await provider.imageToVideo('make the waves move', { imageUrl: 'https://img.example/sea.png' });
    const body = JSON.parse(calls[0].init.body) as Record<string, unknown>;
    expect(body.image_url).toBe('https://img.example/sea.png');
    const done = await pollVideoJob(provider, job, { pollIntervalMs: 0 });
    expect(done.url).toBe('https://cdn.example/anim.mp4');
  });

  it('image-to-video rejects a missing/invalid image reference', async () => {
    const { fetchFn } = scriptedFetch([{ id: 'x', status: 'queued' }]);
    const provider = new HttpVideoProvider({ apiKey: 'k', fetchFn });
    await expect(provider.imageToVideo('p', {})).rejects.toThrow(ValidationError);
    await expect(provider.imageToVideo('p', { imageUrl: 'ftp://x/y.png' })).rejects.toThrow(ValidationError);
  });

  it('accepts a data:image/ reference for image-to-video', async () => {
    const { fetchFn, calls } = scriptedFetch([{ id: 'j', status: 'queued' }]);
    const provider = new HttpVideoProvider({ apiKey: 'k', fetchFn });
    await provider.imageToVideo('p', { imageDataUrl: 'data:image/png;base64,AAAA' });
    expect((JSON.parse(calls[0].init.body) as Record<string, unknown>).image_url).toMatch(/^data:image\//);
  });

  it('surfaces a failed job with the provider error and never leaks the key', async () => {
    const { fetchFn } = scriptedFetch([
      { id: 'job-3', status: 'queued' },
      { id: 'job-3', status: 'failed', error: { message: 'content rejected' } },
    ]);
    const provider = new HttpVideoProvider({ apiKey: 'vk-secret-123', fetchFn });
    const job = await provider.textToVideo('anything');
    const err = (await pollVideoJob(provider, job, { pollIntervalMs: 0 }).catch((e: unknown) => e)) as Error;
    expect(err.message).toContain('content rejected');
    expect(err.message).not.toContain('vk-secret-123');
  });

  it('HTTP errors surface status without the key; empty poll budget errors honestly', async () => {
    const failing: MediaFetch = async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
      text: async () => 'upstream down',
    });
    const provider = new HttpVideoProvider({ apiKey: 'vk-secret-123', fetchFn: failing });
    const err = (await provider.textToVideo('x').catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/503/);
    expect(err.message).not.toContain('vk-secret-123');

    const stuck: VideoProvider = {
      name: 'stuck',
      textToVideo: async (): Promise<VideoJob> => ({ id: 's1', status: 'queued', provider: 'stuck' }),
      imageToVideo: async (): Promise<VideoJob> => ({ id: 's1', status: 'queued', provider: 'stuck' }),
      getJob: async (): Promise<VideoJob> => ({ id: 's1', status: 'in_progress', provider: 'stuck' }),
    };
    const job = await stuck.textToVideo('x');
    await expect(pollVideoJob(stuck, job, { pollIntervalMs: 0, maxPolls: 3 })).rejects.toThrow(/did not complete/);
  });

  it('requires a key at construction and validates prompts', async () => {
    expect(() => new HttpVideoProvider({ apiKey: ' ' })).toThrow(ValidationError);
    const { fetchFn } = scriptedFetch([{ id: 'j', status: 'queued' }]);
    const provider = new HttpVideoProvider({ apiKey: 'k', fetchFn });
    await expect(provider.textToVideo('   ')).rejects.toThrow(ValidationError);
  });
});

describe('MockVideoProvider + env resolution (M-4)', () => {
  it('mock completes immediately for both modes and round-trips getJob', async () => {
    const mock = new MockVideoProvider();
    const a = await mock.textToVideo('a lighthouse');
    expect(a.status).toBe('completed');
    expect(a.url).toMatch(/^mock:\/\/media\/video\/.+\.mp4$/);
    const b = await mock.imageToVideo('animate', { imageUrl: 'https://img.example/x.png' });
    expect(b.status).toBe('completed');
    expect(await mock.getJob(a.id)).toEqual(a);
    await expect(mock.getJob('nope')).rejects.toThrow(ValidationError);
    await expect(mock.imageToVideo('p', {})).rejects.toThrow(ValidationError);
  });

  it('resolveVideoProvider: real when keyed, mock otherwise; fromEnv undefined without key', () => {
    expect(resolveVideoProvider({}).name).toBe('mock-video');
    expect(httpVideoProviderFromEnv({})).toBeUndefined();
    const { fetchFn } = scriptedFetch([{ id: 'j', status: 'queued' }]);
    const real = resolveVideoProvider({ MEDIA_VIDEO_API_KEY: 'k', MEDIA_VIDEO_BASE_URL: 'https://v.example/v9' }, fetchFn);
    expect(real.name).toBe('http-video');
  });
});

describe('VideoBackedMediaProvider + CompositeMediaProvider (M-4)', () => {
  it('generate("video") submits and polls through the MediaProvider interface', async () => {
    const { fetchFn } = scriptedFetch([
      { id: 'job-9', status: 'queued' },
      { id: 'job-9', status: 'completed', output: { url: 'https://cdn.example/final.mp4' } },
    ]);
    const media = new VideoBackedMediaProvider(new HttpVideoProvider({ apiKey: 'k', fetchFn }), { pollIntervalMs: 0 });
    const asset = await media.generate('video', 'waves at dawn');
    expect(asset.kind).toBe('video');
    expect(asset.url).toBe('https://cdn.example/final.mp4');
    expect(asset.mimeType).toBe('video/mp4');
    expect(asset.provider).toBe('http-video');
    await expect(media.generate('image', 'x')).rejects.toThrow(ValidationError);
  });

  it('composite routes video to the video provider and everything else to the fallback', async () => {
    const composite = new CompositeMediaProvider(
      { video: new VideoBackedMediaProvider(new MockVideoProvider(), { pollIntervalMs: 0 }) },
      new MockMediaProvider(),
    );
    expect(composite.providerFor('video')).toBe('mock-video');
    expect(composite.providerFor('image')).toBe('mock');
    const video = await composite.generate('video', 'a lighthouse');
    expect(video.provider).toBe('mock-video');
    const image = await composite.generate('image', 'a lighthouse');
    expect(image.provider).toBe('mock');
    expect(image.mimeType).toBe('image/png');
  });
});
