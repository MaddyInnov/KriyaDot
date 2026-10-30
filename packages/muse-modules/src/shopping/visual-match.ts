// SPDX-License-Identifier: Apache-2.0
// Photo → product visual matching (Muse parity audit §4.9, M-3).
//
// The packaged shopping flow Muse has and KriyaDot lacked:
//   photo bytes → verified as a real image → a vision matcher extracts
//   visual tags → the catalog is scored by tag overlap → ranked product
//   matches the user can drop straight into the existing cart/checkout.
//
// Layers, mirroring the rest of the media stack:
//   VisualMatcher        seam: image → { tags, caption? }
//   HttpVisionMatcher    real adapter: OpenAI-compatible chat-completions
//                        vision shape (image as data URL, JSON-only
//                        reply). Env-gated by MEDIA_VISION_API_KEY
//                        (MEDIA_VISION_BASE_URL / MEDIA_VISION_MODEL).
//   MockVisualMatcher    deterministic offline matcher for tests and
//                        the unconfigured fallback. It does NOT pretend
//                        to see: with no canned tags injected it derives
//                        only a format tag — matching then honestly
//                        returns few/no results rather than fake hits.
//   matchProductsFromPhoto
//                        the packaged flow: verify → describe → score →
//                        rank. Scoring is pure and exported for tests.
//
// Zero paid usage in tests: fake fetch + mock matcher only.

import { ValidationError } from '../errors.js';
import { verifyImageBytes, type VerifiedImage } from '../media/image-edit.js';
import { MOCK_CATALOG, type Product } from './index.js';

export interface VisualDescription {
  /** Lowercase visual tags: category, material, color, form… */
  tags: string[];
  caption?: string;
  matcher: string;
}

export interface VisualMatcher {
  readonly name: string;
  describe(image: Uint8Array, verified: VerifiedImage): Promise<VisualDescription>;
}

export interface ProductMatch {
  product: Product;
  /** 0–1 normalized score: matched-tag weight over the photo's tag weight. */
  score: number;
  matchedTags: string[];
}

export interface PhotoMatchResult {
  description: VisualDescription;
  verified: VerifiedImage;
  matches: ProductMatch[];
}

// ---------------------------------------------------------------------------
// Scoring (pure)
// ---------------------------------------------------------------------------

function normalizeTag(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '-');
}

/** Dedupe + normalize a tag list, dropping empties. */
export function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  for (const t of tags) {
    const n = normalizeTag(t ?? '');
    if (n) seen.add(n);
  }
  return [...seen];
}

/**
 * Score catalog products against photo tags. A product's own visualTags
 * are the primary signal; a tag that also appears in the product name
 * counts double (category words like "mug" are the strongest signal).
 * Products with no matched tags are excluded. Ranking: score desc,
 * then matched-tag count desc, then catalog order (stable).
 */
export function scoreProductsByTags(
  tags: string[],
  catalog: Product[] = MOCK_CATALOG,
  opts: { limit?: number; minScore?: number } = {},
): ProductMatch[] {
  const photoTags = normalizeTags(tags);
  if (photoTags.length === 0) return [];
  const limit = opts.limit ?? 5;
  const minScore = opts.minScore ?? 0.01;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new ValidationError('visual match "limit" must be an integer 1..50');
  }
  const matches: ProductMatch[] = [];
  catalog.forEach((product, index) => {
    const productTags = new Set(normalizeTags(product.visualTags ?? []));
    const nameWords = new Set(normalizeTags(product.name.split(/[^A-Za-z0-9]+/)));
    const matchedTags: string[] = [];
    let weight = 0;
    for (const tag of photoTags) {
      if (productTags.has(tag)) {
        matchedTags.push(tag);
        weight += nameWords.has(tag) ? 2 : 1;
      }
    }
    if (matchedTags.length === 0) return;
    const maxWeight = photoTags.reduce((s, t) => s + (nameWords.has(t) ? 2 : 1), 0);
    const score = maxWeight > 0 ? weight / maxWeight : 0;
    if (score >= minScore) matches.push({ product, score, matchedTags, _index: index } as ProductMatch & { _index: number });
  });
  matches.sort((a, b) => {
    const ai = (a as ProductMatch & { _index: number })._index;
    const bi = (b as ProductMatch & { _index: number })._index;
    return b.score - a.score || b.matchedTags.length - a.matchedTags.length || ai - bi;
  });
  return matches.slice(0, limit).map(({ product, score, matchedTags }) => ({ product, score, matchedTags }));
}

// ---------------------------------------------------------------------------
// Mock matcher (tests / unconfigured fallback)
// ---------------------------------------------------------------------------

/**
 * Deterministic mock matcher. Tests inject the tags a real vision model
 * would return for their fixture photo (`cannedTags`); without them it
 * reports only the image format — honest about seeing nothing.
 */
export class MockVisualMatcher implements VisualMatcher {
  readonly name = 'mock-vision';
  constructor(private readonly cannedTags: string[] = []) {}
  async describe(_image: Uint8Array, verified: VerifiedImage): Promise<VisualDescription> {
    const tags = normalizeTags([...this.cannedTags]);
    return {
      tags: tags.length ? tags : [verified.format],
      ...(this.cannedTags.length ? { caption: 'mock visual description (injected tags)' } : {}),
      matcher: this.name,
    };
  }
}

// ---------------------------------------------------------------------------
// Real HTTP vision matcher (env-gated)
// ---------------------------------------------------------------------------

export const MEDIA_VISION_API_KEY_ENV = 'MEDIA_VISION_API_KEY';
export const MEDIA_VISION_BASE_URL_ENV = 'MEDIA_VISION_BASE_URL';
export const MEDIA_VISION_MODEL_ENV = 'MEDIA_VISION_MODEL';
export const DEFAULT_VISION_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_VISION_MODEL = 'gpt-4o-mini';

/** JSON fetch seam (the chat-completions shape is plain JSON). */
export type VisionFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;

export interface HttpVisionMatcherOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetchFn?: VisionFetch;
  name?: string;
}

const VISION_INSTRUCTION =
  'Look at this product photo. Reply with ONLY a JSON object: ' +
  '{"tags": ["..."], "caption": "..."} where tags are 4-10 lowercase visual attributes ' +
  '(product category, material, color family, form factor) and caption is one short sentence.';

/**
 * Real matcher over the OpenAI-compatible vision chat shape:
 *   POST {base}/chat/completions { model, messages: [ { role: 'user',
 *   content: [ {type:'text',…}, {type:'image_url', image_url:{url:
 *   'data:image/…;base64,…'}} ] } ] } → choices[0].message.content (JSON)
 */
export class HttpVisionMatcher implements VisualMatcher {
  readonly name: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchFn: VisionFetch;

  constructor(opts: HttpVisionMatcherOptions) {
    if (!opts.apiKey || !opts.apiKey.trim()) {
      throw new ValidationError('HttpVisionMatcher requires a non-empty apiKey');
    }
    this.apiKey = opts.apiKey.trim();
    this.baseUrl = (opts.baseUrl ?? DEFAULT_VISION_BASE_URL).replace(/\/+$/, '');
    this.model = opts.model ?? DEFAULT_VISION_MODEL;
    this.name = opts.name ?? 'http-vision';
    this.fetchFn =
      opts.fetchFn ??
      ((async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
        const res = await fetch(url, init);
        return { ok: res.ok, status: res.status, json: () => res.json() as Promise<unknown>, text: () => res.text() };
      }) as VisionFetch);
  }

  async describe(image: Uint8Array, verified: VerifiedImage): Promise<VisualDescription> {
    const dataUrl = `data:${verified.mimeType};base64,${Buffer.from(image).toString('base64')}`;
    let res: Awaited<ReturnType<VisionFetch>>;
    try {
      res = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: VISION_INSTRUCTION },
                { type: 'image_url', image_url: { url: dataUrl } },
              ],
            },
          ],
        }),
      });
    } catch (err) {
      throw new Error(`visual matching request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`visual matching failed with HTTP ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
    }
    const payload = (await res.json()) as { choices?: { message?: { content?: unknown } }[] } | null;
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error('visual matching returned no description');
    }
    let parsed: { tags?: unknown; caption?: unknown };
    try {
      parsed = JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')) as typeof parsed;
    } catch {
      throw new Error('visual matching returned a non-JSON description');
    }
    const tags = normalizeTags(Array.isArray(parsed.tags) ? parsed.tags.map(String) : []);
    if (tags.length === 0) throw new Error('visual matching returned no tags');
    return {
      tags,
      ...(typeof parsed.caption === 'string' && parsed.caption.trim() ? { caption: parsed.caption.trim() } : {}),
      matcher: this.name,
    };
  }
}

/** Real matcher when MEDIA_VISION_API_KEY is set, else undefined. */
export function httpVisionMatcherFromEnv(
  env: Record<string, string | undefined>,
  fetchFn?: VisionFetch,
): HttpVisionMatcher | undefined {
  const apiKey = env[MEDIA_VISION_API_KEY_ENV];
  if (!apiKey || !apiKey.trim()) return undefined;
  return new HttpVisionMatcher({
    apiKey,
    ...(env[MEDIA_VISION_BASE_URL_ENV] ? { baseUrl: env[MEDIA_VISION_BASE_URL_ENV] } : {}),
    ...(env[MEDIA_VISION_MODEL_ENV] ? { model: env[MEDIA_VISION_MODEL_ENV] } : {}),
    ...(fetchFn ? { fetchFn } : {}),
  });
}

/** Real matcher when keyed, else the honest mock matcher. */
export function resolveVisualMatcher(
  env: Record<string, string | undefined> = process.env,
  fetchFn?: VisionFetch,
): VisualMatcher {
  return httpVisionMatcherFromEnv(env, fetchFn) ?? new MockVisualMatcher();
}

// ---------------------------------------------------------------------------
// Packaged flow
// ---------------------------------------------------------------------------

/**
 * Photo → product matches, end to end:
 *   1. verify the photo bytes really are an image (never trust a name);
 *   2. describe them with the configured matcher;
 *   3. score + rank the catalog.
 * Matches feed the existing ShoppingStore cart/checkout unchanged.
 */
export async function matchProductsFromPhoto(
  matcher: VisualMatcher,
  image: Uint8Array,
  opts: { catalog?: Product[]; limit?: number; minScore?: number; declaredMimeType?: string } = {},
): Promise<PhotoMatchResult> {
  const verified = verifyImageBytes(image, { declaredMimeType: opts.declaredMimeType, label: 'product photo' });
  const description = await matcher.describe(image, verified);
  const matches = scoreProductsByTags(description.tags, opts.catalog ?? MOCK_CATALOG, {
    limit: opts.limit,
    minScore: opts.minScore,
  });
  return { description, verified, matches };
}
