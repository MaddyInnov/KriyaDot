// SPDX-License-Identifier: Apache-2.0
// Media generation hooks (Muse parity).
//
// - MediaProvider: interface for image / video / audio generation. Real
//   providers are configured with API keys via environment variables (see
//   docs/founder-setup.d/workstream-e.md); no keys are hardcoded here.
// - MockMediaProvider: deterministic offline provider returning fixture
//   bytes/URLs. Used in tests and as the default until the founder supplies
//   provider credentials.
//
// Zero paid usage in testing: the mock makes no network calls.

import { randomUUID } from 'node:crypto';
import { ValidationError } from '../errors.js';

export type MediaKind = 'image' | 'video' | 'audio';

export interface MediaAsset {
  id: string;
  kind: MediaKind;
  prompt: string;
  /** Where the bytes live: mock://… for the mock provider, https://… for real ones. */
  url: string;
  mimeType: string;
  /** Byte length of the fixture payload (0 when the provider returns a URL only). */
  byteLength: number;
  provider: string;
}

export interface MediaProvider {
  readonly name: string;
  generate(kind: MediaKind, prompt: string): Promise<MediaAsset>;
}

/** 1×1 transparent PNG fixture bytes (base64). */
const FIXTURE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const MIME: Record<MediaKind, string> = {
  image: 'image/png',
  video: 'video/mp4',
  audio: 'audio/wav',
};

const EXT: Record<MediaKind, string> = {
  image: 'png',
  video: 'mp4',
  audio: 'wav',
};

/**
 * Deterministic mock provider: returns fixture bytes (a real 1×1 PNG for
 * images) addressed by mock:// URLs. No network, no cost.
 */
export class MockMediaProvider implements MediaProvider {
  readonly name = 'mock';

  async generate(kind: MediaKind, prompt: string): Promise<MediaAsset> {
    if (kind !== 'image' && kind !== 'video' && kind !== 'audio') {
      throw new ValidationError(`media kind must be one of: image, video, audio (got "${kind}")`);
    }
    const p = (prompt ?? '').trim();
    if (!p) throw new ValidationError('media "prompt" must be a non-empty string');
    if (p.length > 2000) throw new ValidationError('media "prompt" must be at most 2000 characters');
    const id = randomUUID();
    const byteLength = kind === 'image' ? Buffer.from(FIXTURE_PNG_BASE64, 'base64').length : 0;
    return {
      id,
      kind,
      prompt: p,
      url: `mock://media/${id}.${EXT[kind]}`,
      mimeType: MIME[kind],
      byteLength,
      provider: this.name,
    };
  }

  /** The raw fixture bytes behind mock image assets. */
  fixtureImageBytes(): Buffer {
    return Buffer.from(FIXTURE_PNG_BASE64, 'base64');
  }
}

export { OpenAIImagesProvider, openAIImagesProviderFromEnv } from './openai-images.js';
export type { MediaFetch, OpenAIImagesProviderOptions } from './openai-images.js';
export * from './video-provider.js';
export * from './image-edit.js';
export * from './assembly.js';

import { openAIImagesProviderFromEnv, type MediaFetch } from './openai-images.js';
import {
  CompositeMediaProvider,
  VideoBackedMediaProvider,
  httpVideoProviderFromEnv,
} from './video-provider.js';

/**
 * Resolve the configured media provider (closure C9). When the
 * OpenAI-compatible images key is configured (MEDIA_IMAGES_API_KEY, with
 * optional MEDIA_IMAGES_BASE_URL / MEDIA_IMAGES_MODEL) the real provider
 * is selected; otherwise this falls back to the mock so the MVP works
 * out of the box. Never throws for missing keys. Live verification of
 * the real provider is credential-gated: no key exists in tests/CI, so
 * the real path is proven there only against an injected fake fetch.
 *
 * M-4: when MEDIA_VIDEO_API_KEY is also configured, the result is a
 * CompositeMediaProvider whose 'video' kind is served by the real
 * async-job video provider (submit + poll) while images keep the
 * provider above and any unrouted kind keeps the honest fallback.
 */
export function resolveMediaProvider(
  env: Record<string, string | undefined> = process.env,
  fetchFn?: MediaFetch,
): MediaProvider {
  const base = openAIImagesProviderFromEnv(env, fetchFn) ?? new MockMediaProvider();
  const video = httpVideoProviderFromEnv(env, fetchFn);
  if (!video) return base;
  const pollMs = Number.parseInt(env['MEDIA_VIDEO_POLL_MS'] ?? '', 10);
  return new CompositeMediaProvider(
    {
      video: new VideoBackedMediaProvider(video, {
        pollIntervalMs: Number.isFinite(pollMs) && pollMs >= 0 ? pollMs : 2000,
      }),
    },
    base,
  );
}
