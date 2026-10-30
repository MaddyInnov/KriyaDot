// SPDX-License-Identifier: Apache-2.0
// Real video provider behind MediaProvider (Muse parity audit §4.9, M-4).
//
// Video generation APIs are asynchronous job APIs, unlike the one-shot
// images endpoint. This module models that honestly:
//
//   VideoProvider          submit a job (text-to-video or image-to-video),
//                          then poll getJob() until it completes or fails.
//   HttpVideoProvider      real HTTP adapter for the common async-job
//                          shape (submit → poll → output URL) used by
//                          OpenAI-style / Runway-style / Luma-style
//                          gateways. Env-gated: it is only selected when
//                          MEDIA_VIDEO_API_KEY is configured.
//   MockVideoProvider      deterministic offline provider; jobs complete
//                          immediately with mock:// URLs. Tests only /
//                          unconfigured fallback.
//   VideoBackedMediaProvider
//                          bridges a VideoProvider onto the existing
//                          MediaProvider interface: generate('video', …)
//                          submits a job and polls it to completion.
//   CompositeMediaProvider routes each MediaKind to its own provider so
//                          images, video, and audio can come from
//                          different backends behind one MediaProvider.
//
// Config (env only, no hardcoded keys):
//   MEDIA_VIDEO_API_KEY    (required to select the real provider)
//   MEDIA_VIDEO_BASE_URL   (default: https://api.openai.com/v1)
//   MEDIA_VIDEO_MODEL      (default: sora-2)
//   MEDIA_VIDEO_POLL_MS    (resolver default poll interval, default 2000)
//
// Zero paid usage in tests: every test injects a fake fetch; the real
// provider is never constructed with a real key in tests/CI.

import { randomUUID } from 'node:crypto';
import { ValidationError } from '../errors.js';
import type { MediaAsset, MediaKind, MediaProvider } from './index.js';
import type { MediaFetch } from './openai-images.js';

export const MEDIA_VIDEO_API_KEY_ENV = 'MEDIA_VIDEO_API_KEY';
export const MEDIA_VIDEO_BASE_URL_ENV = 'MEDIA_VIDEO_BASE_URL';
export const MEDIA_VIDEO_MODEL_ENV = 'MEDIA_VIDEO_MODEL';
export const DEFAULT_VIDEO_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_VIDEO_MODEL = 'sora-2';

export type VideoJobStatus = 'queued' | 'in_progress' | 'completed' | 'failed';

export interface VideoJob {
  id: string;
  status: VideoJobStatus;
  provider: string;
  /** Output video URL once status is 'completed'. */
  url?: string;
  mimeType?: string;
  /** Provider-supplied failure detail once status is 'failed'. */
  error?: string;
}

export interface TextToVideoOptions {
  /** Clip length target in seconds (provider-dependent, passed through). */
  durationSeconds?: number;
  /** e.g. '16:9', '9:16', '1:1' (passed through). */
  aspectRatio?: string;
  model?: string;
}

export interface ImageToVideoOptions extends TextToVideoOptions {
  /** Source image as an https:// URL … */
  imageUrl?: string;
  /** … or as a data: URL (e.g. a freshly generated image asset). */
  imageDataUrl?: string;
}

/** Asynchronous video generation provider: submit + poll. */
export interface VideoProvider {
  readonly name: string;
  textToVideo(prompt: string, opts?: TextToVideoOptions): Promise<VideoJob>;
  imageToVideo(prompt: string, opts: ImageToVideoOptions): Promise<VideoJob>;
  getJob(jobId: string): Promise<VideoJob>;
}

function validatePrompt(prompt: string): string {
  const p = (prompt ?? '').trim();
  if (!p) throw new ValidationError('video "prompt" must be a non-empty string');
  if (p.length > 2000) throw new ValidationError('video "prompt" must be at most 2000 characters');
  return p;
}

function normalizeStatus(raw: unknown): VideoJobStatus {
  const s = typeof raw === 'string' ? raw.toLowerCase() : '';
  if (s === 'completed' || s === 'complete' || s === 'succeeded' || s === 'success') return 'completed';
  if (s === 'failed' || s === 'error' || s === 'cancelled' || s === 'canceled') return 'failed';
  if (s === 'in_progress' || s === 'processing' || s === 'running' || s === 'generating') return 'in_progress';
  return 'queued';
}

interface VideoJobPayload {
  id?: unknown;
  status?: unknown;
  url?: unknown;
  video_url?: unknown;
  output?: { url?: unknown } | unknown;
  error?: { message?: unknown } | unknown;
}

function payloadToJob(payload: VideoJobPayload | null, providerName: string, fallbackId?: string): VideoJob {
  const id = typeof payload?.id === 'string' && payload.id ? payload.id : fallbackId;
  if (!id) throw new Error('video provider returned a job with no id');
  const status = normalizeStatus(payload?.status);
  const outputUrl =
    (typeof (payload?.output as { url?: unknown } | undefined)?.url === 'string'
      ? ((payload!.output as { url: string }).url as string)
      : undefined) ??
    (typeof payload?.video_url === 'string' ? payload.video_url : undefined) ??
    (typeof payload?.url === 'string' ? payload.url : undefined);
  const errRaw = payload?.error;
  const error =
    typeof (errRaw as { message?: unknown } | undefined)?.message === 'string'
      ? ((errRaw as { message: string }).message as string)
      : typeof errRaw === 'string'
        ? errRaw
        : undefined;
  return {
    id,
    status,
    provider: providerName,
    ...(status === 'completed' && outputUrl ? { url: outputUrl, mimeType: 'video/mp4' } : {}),
    ...(status === 'failed' && error ? { error } : {}),
  };
}

export interface HttpVideoProviderOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  /** Injectable fetch for tests. Default: the global fetch. */
  fetchFn?: MediaFetch;
  /** Provider label on returned jobs. Default "http-video". */
  name?: string;
}

/**
 * Real video provider over the common async-job HTTP shape:
 *
 *   POST {baseUrl}/video/generations
 *   Authorization: Bearer <apiKey>
 *   { "model", "prompt", "image_url"?, "duration_seconds"?, "aspect_ratio"? }
 *     → { "id": "…", "status": "queued" }
 *   GET {baseUrl}/video/generations/{id}
 *     → { "id", "status": "completed", "output": { "url": "https://…" } }
 *
 * Gateways that name the output field differently (`video_url`, `url`)
 * are also understood. The API key is never included in error messages.
 */
export class HttpVideoProvider implements VideoProvider {
  readonly name: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchFn: MediaFetch;

  constructor(opts: HttpVideoProviderOptions) {
    if (!opts.apiKey || !opts.apiKey.trim()) {
      throw new ValidationError('HttpVideoProvider requires a non-empty apiKey');
    }
    this.apiKey = opts.apiKey.trim();
    this.baseUrl = (opts.baseUrl ?? DEFAULT_VIDEO_BASE_URL).replace(/\/+$/, '');
    this.model = opts.model ?? DEFAULT_VIDEO_MODEL;
    this.name = opts.name ?? 'http-video';
    this.fetchFn =
      opts.fetchFn ??
      ((async (url: string, init: Parameters<MediaFetch>[1]) => {
        const res = await fetch(url, init);
        return {
          ok: res.ok,
          status: res.status,
          json: () => res.json() as Promise<unknown>,
          text: () => res.text(),
        };
      }) as MediaFetch);
  }

  private async submit(prompt: string, opts: (TextToVideoOptions & { image?: string }) | undefined): Promise<VideoJob> {
    const p = validatePrompt(prompt);
    const body: Record<string, unknown> = { model: opts?.model ?? this.model, prompt: p };
    if (opts?.image) body.image_url = opts.image;
    if (opts?.durationSeconds !== undefined) body.duration_seconds = opts.durationSeconds;
    if (opts?.aspectRatio) body.aspect_ratio = opts.aspectRatio;
    let res: Awaited<ReturnType<MediaFetch>>;
    try {
      res = await this.fetchFn(`${this.baseUrl}/video/generations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(`video generation request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`video generation failed with HTTP ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
    }
    const job = payloadToJob((await res.json()) as VideoJobPayload | null, this.name);
    if (job.status === 'completed' && !job.url) {
      throw new Error('video provider reported completion without an output URL');
    }
    return job;
  }

  async textToVideo(prompt: string, opts?: TextToVideoOptions): Promise<VideoJob> {
    return this.submit(prompt, opts);
  }

  async imageToVideo(prompt: string, opts: ImageToVideoOptions): Promise<VideoJob> {
    const image = opts?.imageUrl ?? opts?.imageDataUrl;
    if (!image || !(image.startsWith('https://') || image.startsWith('http://') || image.startsWith('data:image/'))) {
      throw new ValidationError('imageToVideo requires an imageUrl (http/https) or imageDataUrl (data:image/…)');
    }
    return this.submit(prompt, { ...opts, image });
  }

  async getJob(jobId: string): Promise<VideoJob> {
    const id = (jobId ?? '').trim();
    if (!id) throw new ValidationError('video "jobId" must be a non-empty string');
    let res: Awaited<ReturnType<MediaFetch>>;
    try {
      res = await this.fetchFn(`${this.baseUrl}/video/generations/${encodeURIComponent(id)}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${this.apiKey}` },
        body: '',
      });
    } catch (err) {
      throw new Error(`video job lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`video job lookup failed with HTTP ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
    }
    const job = payloadToJob((await res.json()) as VideoJobPayload | null, this.name, id);
    if (job.status === 'completed' && !job.url) {
      throw new Error('video provider reported completion without an output URL');
    }
    return job;
  }
}

/** Deterministic offline video provider: jobs complete on submission. */
export class MockVideoProvider implements VideoProvider {
  readonly name = 'mock-video';
  private readonly jobs = new Map<string, VideoJob>();

  async textToVideo(prompt: string): Promise<VideoJob> {
    return this.complete(validatePrompt(prompt));
  }

  async imageToVideo(prompt: string, opts: ImageToVideoOptions): Promise<VideoJob> {
    const p = validatePrompt(prompt);
    if (!opts?.imageUrl && !opts?.imageDataUrl) {
      throw new ValidationError('imageToVideo requires an imageUrl or imageDataUrl');
    }
    return this.complete(p);
  }

  private complete(prompt: string): VideoJob {
    void prompt;
    const id = randomUUID();
    const job: VideoJob = {
      id,
      status: 'completed',
      provider: this.name,
      url: `mock://media/video/${id}.mp4`,
      mimeType: 'video/mp4',
    };
    this.jobs.set(id, job);
    return job;
  }

  async getJob(jobId: string): Promise<VideoJob> {
    const job = this.jobs.get((jobId ?? '').trim());
    if (!job) throw new ValidationError(`unknown mock video job: ${jobId}`);
    return job;
  }
}

/**
 * Build the HTTP video provider from an env map, or return undefined
 * when its key is not configured. Never throws for missing keys.
 */
export function httpVideoProviderFromEnv(
  env: Record<string, string | undefined>,
  fetchFn?: MediaFetch,
): HttpVideoProvider | undefined {
  const apiKey = env[MEDIA_VIDEO_API_KEY_ENV];
  if (!apiKey || !apiKey.trim()) return undefined;
  return new HttpVideoProvider({
    apiKey,
    ...(env[MEDIA_VIDEO_BASE_URL_ENV] ? { baseUrl: env[MEDIA_VIDEO_BASE_URL_ENV] } : {}),
    ...(env[MEDIA_VIDEO_MODEL_ENV] ? { model: env[MEDIA_VIDEO_MODEL_ENV] } : {}),
    ...(fetchFn ? { fetchFn } : {}),
  });
}

/** Real video provider when MEDIA_VIDEO_API_KEY is set, else the mock. */
export function resolveVideoProvider(
  env: Record<string, string | undefined> = process.env,
  fetchFn?: MediaFetch,
): VideoProvider {
  return httpVideoProviderFromEnv(env, fetchFn) ?? new MockVideoProvider();
}

export interface VideoMediaOptions {
  /** Starting image asset/URL for image-to-video generate() calls. */
  imageUrl?: string;
  durationSeconds?: number;
  aspectRatio?: string;
  /** Poll interval for in-progress jobs. Default 2000ms (0 in tests). */
  pollIntervalMs?: number;
  /** Give up after this many polls. Default 90 (≈3 min at 2s). */
  maxPolls?: number;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Bridge a VideoProvider onto the MediaProvider interface. Only the
 * 'video' kind is served; other kinds throw so a misconfigured route
 * fails honestly instead of returning a fake asset.
 */
export class VideoBackedMediaProvider implements MediaProvider {
  readonly name: string;
  constructor(
    private readonly video: VideoProvider,
    private readonly opts: VideoMediaOptions = {},
  ) {
    this.name = video.name;
  }

  async generate(kind: MediaKind, prompt: string): Promise<MediaAsset> {
    if (kind !== 'video') {
      throw new ValidationError(`provider "${this.name}" generates video only (got "${kind}")`);
    }
    const job =
      this.opts.imageUrl !== undefined
        ? await this.video.imageToVideo(prompt, {
            imageUrl: this.opts.imageUrl,
            durationSeconds: this.opts.durationSeconds,
            aspectRatio: this.opts.aspectRatio,
          })
        : await this.video.textToVideo(prompt, {
            durationSeconds: this.opts.durationSeconds,
            aspectRatio: this.opts.aspectRatio,
          });
    const done = await pollVideoJob(this.video, job, this.opts);
    return {
      id: done.id,
      kind,
      prompt: (prompt ?? '').trim(),
      url: done.url!,
      mimeType: done.mimeType ?? 'video/mp4',
      byteLength: 0,
      provider: this.name,
    };
  }
}

/** Poll a submitted job to completion, failure, or the poll budget. */
export async function pollVideoJob(
  provider: VideoProvider,
  job: VideoJob,
  opts: Pick<VideoMediaOptions, 'pollIntervalMs' | 'maxPolls' | 'sleep'> = {},
): Promise<VideoJob> {
  const interval = opts.pollIntervalMs ?? 2000;
  const maxPolls = opts.maxPolls ?? 90;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let current = job;
  for (let i = 0; current.status !== 'completed' && current.status !== 'failed' && i < maxPolls; i++) {
    if (interval > 0) await sleep(interval);
    current = await provider.getJob(current.id);
  }
  if (current.status === 'failed') {
    throw new Error(`video generation failed${current.error ? `: ${current.error}` : ''}`);
  }
  if (current.status !== 'completed') {
    throw new Error(`video generation did not complete after ${maxPolls} polls (last status: ${current.status})`);
  }
  if (!current.url) throw new Error('video generation completed without an output URL');
  return current;
}

/**
 * Route each MediaKind to its own provider behind one MediaProvider.
 * Kinds without a dedicated provider delegate to `fallback` — the asset
 * keeps the fallback's own provider label, so provenance stays honest.
 */
export class CompositeMediaProvider implements MediaProvider {
  readonly name = 'composite';
  constructor(
    private readonly routes: Partial<Record<MediaKind, MediaProvider>>,
    private readonly fallback: MediaProvider,
  ) {}

  async generate(kind: MediaKind, prompt: string): Promise<MediaAsset> {
    const provider = this.routes[kind] ?? this.fallback;
    return provider.generate(kind, prompt);
  }

  /** Which provider will serve a kind (for diagnostics/UI labels). */
  providerFor(kind: MediaKind): string {
    return (this.routes[kind] ?? this.fallback).name;
  }
}
