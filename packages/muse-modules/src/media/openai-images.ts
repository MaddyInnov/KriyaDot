// SPDX-License-Identifier: Apache-2.0
// Real media provider: OpenAI-compatible image generation (closure C9).
//
// Implements the existing MediaProvider interface against the de-facto
// standard images API shape used by OpenAI and compatible gateways:
//
//   POST {baseUrl}/images/generations
//   Authorization: Bearer <apiKey>
//   { "model": <model>, "prompt": <prompt>, "n": 1, "size": <size> }
//     → { "data": [ { "url": "https://…" } | { "b64_json": "…" } ] }
//
// Config comes from env/config only — no keys are hardcoded:
//   MEDIA_IMAGES_API_KEY   (required to select this provider)
//   MEDIA_IMAGES_BASE_URL  (default: https://api.openai.com/v1)
//   MEDIA_IMAGES_MODEL     (default: gpt-image-1)
// `resolveMediaProvider()` in ./index.ts selects this provider when the
// key is configured and falls back to the mock otherwise.
//
// Scope, honestly: this provider generates IMAGES. Video/audio kinds
// throw a ValidationError rather than silently returning a mock asset —
// a real provider must not fake kinds it cannot produce.
// Tests inject a fake fetch: no network, no keys, no paid usage.

import { randomUUID } from 'node:crypto';
import { ValidationError } from '../errors.js';
import type { MediaAsset, MediaKind, MediaProvider } from './index.js';

export const MEDIA_IMAGES_API_KEY_ENV = 'MEDIA_IMAGES_API_KEY';
export const MEDIA_IMAGES_BASE_URL_ENV = 'MEDIA_IMAGES_BASE_URL';
export const MEDIA_IMAGES_MODEL_ENV = 'MEDIA_IMAGES_MODEL';
export const DEFAULT_IMAGES_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_IMAGES_MODEL = 'gpt-image-1';

/** Minimal fetch shape (the global fetch satisfies this). */
export type MediaFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

export interface OpenAIImagesProviderOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  /** Image size passed through to the provider. Default "1024x1024". */
  size?: string;
  /** Injectable fetch for tests. Default: the global fetch. */
  fetchFn?: MediaFetch;
  /** Provider label on returned assets. Default "openai-images". */
  name?: string;
}

interface ImagesResponseItem {
  url?: unknown;
  b64_json?: unknown;
}

export class OpenAIImagesProvider implements MediaProvider {
  readonly name: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly size: string;
  private readonly fetchFn: MediaFetch;

  constructor(opts: OpenAIImagesProviderOptions) {
    if (!opts.apiKey || !opts.apiKey.trim()) {
      throw new ValidationError('OpenAIImagesProvider requires a non-empty apiKey');
    }
    this.apiKey = opts.apiKey.trim();
    this.baseUrl = (opts.baseUrl ?? DEFAULT_IMAGES_BASE_URL).replace(/\/+$/, '');
    this.model = opts.model ?? DEFAULT_IMAGES_MODEL;
    this.size = opts.size ?? '1024x1024';
    this.name = opts.name ?? 'openai-images';
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

  async generate(kind: MediaKind, prompt: string): Promise<MediaAsset> {
    if (kind !== 'image') {
      throw new ValidationError(
        `provider "${this.name}" generates images only (got "${kind}"); configure another provider for ${kind}`,
      );
    }
    const p = (prompt ?? '').trim();
    if (!p) throw new ValidationError('media "prompt" must be a non-empty string');
    if (p.length > 2000) throw new ValidationError('media "prompt" must be at most 2000 characters');

    let res: Awaited<ReturnType<MediaFetch>>;
    try {
      res = await this.fetchFn(`${this.baseUrl}/images/generations`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.model, prompt: p, n: 1, size: this.size }),
      });
    } catch (err) {
      throw new Error(`media image generation request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      // Never include the API key in errors; the provider's body is enough.
      throw new Error(`media image generation failed with HTTP ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
    }
    const payload = (await res.json()) as { data?: ImagesResponseItem[] } | null;
    const item = payload?.data?.[0];
    const id = randomUUID();
    if (item && typeof item.url === 'string' && item.url) {
      return { id, kind, prompt: p, url: item.url, mimeType: 'image/png', byteLength: 0, provider: this.name };
    }
    if (item && typeof item.b64_json === 'string' && item.b64_json) {
      return {
        id,
        kind,
        prompt: p,
        // Inline payload addressed as a data: URL; byteLength is real.
        url: `data:image/png;base64,${item.b64_json}`,
        mimeType: 'image/png',
        byteLength: Buffer.from(item.b64_json, 'base64').length,
        provider: this.name,
      };
    }
    throw new Error('media image generation returned no image (empty data array)');
  }
}

/**
 * Build the OpenAI-compatible images provider from an env map, or return
 * undefined when its key is not configured (the resolver then falls back
 * to the mock). Never throws for missing keys.
 */
export function openAIImagesProviderFromEnv(
  env: Record<string, string | undefined>,
  fetchFn?: MediaFetch,
): OpenAIImagesProvider | undefined {
  const apiKey = env[MEDIA_IMAGES_API_KEY_ENV];
  if (!apiKey || !apiKey.trim()) return undefined;
  return new OpenAIImagesProvider({
    apiKey,
    ...(env[MEDIA_IMAGES_BASE_URL_ENV] ? { baseUrl: env[MEDIA_IMAGES_BASE_URL_ENV] } : {}),
    ...(env[MEDIA_IMAGES_MODEL_ENV] ? { model: env[MEDIA_IMAGES_MODEL_ENV] } : {}),
    ...(fetchFn ? { fetchFn } : {}),
  });
}
