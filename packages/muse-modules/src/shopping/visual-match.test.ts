// SPDX-License-Identifier: Apache-2.0
// M-3 photo→product visual matching tests. Mock catalog + mock matcher
// + fake fetch only: no network, no keys, no paid usage.
import { describe, it, expect } from 'vitest';
import { ValidationError } from '../errors.js';
import { MOCK_CATALOG } from './index.js';
import {
  MockVisualMatcher,
  HttpVisionMatcher,
  httpVisionMatcherFromEnv,
  resolveVisualMatcher,
  matchProductsFromPhoto,
  scoreProductsByTags,
  normalizeTags,
  type VisionFetch,
} from './visual-match.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const NOT_AN_IMAGE = new Uint8Array([...Buffer.from('definitely not an image')]);

describe('scoreProductsByTags (pure scoring)', () => {
  it('ranks the ceramic mug first for mug-like photo tags, with matched tags explained', () => {
    const matches = scoreProductsByTags(['mug', 'ceramic', 'white', 'kitchen'], MOCK_CATALOG);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].product.id).toBe('prod-003'); // Kiln Ceramic Mug
    expect(matches[0].matchedTags).toContain('mug');
    expect(matches[0].matchedTags).toContain('ceramic');
    expect(matches[0].score).toBeGreaterThan(0.5);
    // Scores are normalized and descending.
    for (let i = 1; i < matches.length; i++) expect(matches[i - 1].score).toBeGreaterThanOrEqual(matches[i].score);
    for (const m of matches) {
      expect(m.score).toBeGreaterThan(0);
      expect(m.score).toBeLessThanOrEqual(1);
    }
  });

  it('category words in the product name count double (keyboard photo)', () => {
    const matches = scoreProductsByTags(['keyboard', 'black', 'desk'], MOCK_CATALOG);
    expect(matches[0].product.id).toBe('prod-007');
    expect(matches[0].matchedTags).toEqual(expect.arrayContaining(['keyboard', 'black', 'desk']));
  });

  it('no overlapping tags → no matches (never fake hits); limit is honored and validated', () => {
    expect(scoreProductsByTags(['helicopter', 'purple'], MOCK_CATALOG)).toEqual([]);
    expect(scoreProductsByTags([], MOCK_CATALOG)).toEqual([]);
    expect(scoreProductsByTags(['fabric'], MOCK_CATALOG, { limit: 1 })).toHaveLength(1);
    expect(() => scoreProductsByTags(['mug'], MOCK_CATALOG, { limit: 0 })).toThrow(ValidationError);
  });

  it('normalizeTags lowercases, hyphenates, and dedupes', () => {
    expect(normalizeTags([' Desk Lamp ', 'desk  lamp', '', 'MUG'])).toEqual(['desk-lamp', 'mug']);
  });
});

describe('matchProductsFromPhoto (packaged flow, M-3)', () => {
  it('verifies bytes, describes via the matcher, and returns ranked matches', async () => {
    const matcher = new MockVisualMatcher(['backpack', 'bag', 'black', 'travel']);
    const result = await matchProductsFromPhoto(matcher, PNG);
    expect(result.verified.format).toBe('png');
    expect(result.description.matcher).toBe('mock-vision');
    expect(result.matches[0].product.id).toBe('prod-002'); // Nomad Backpack
  });

  it('rejects non-image bytes before the matcher ever runs', async () => {
    let called = false;
    const spy = {
      name: 'spy',
      describe: async () => {
        called = true;
        return { tags: ['mug'], matcher: 'spy' };
      },
    };
    await expect(matchProductsFromPhoto(spy, NOT_AN_IMAGE)).rejects.toThrow(ValidationError);
    expect(called).toBe(false);
  });

  it('the bare mock matcher (no injected tags) honestly matches nothing in the catalog', async () => {
    const result = await matchProductsFromPhoto(new MockVisualMatcher(), PNG);
    expect(result.description.tags).toEqual(['png']); // format only — it cannot see
    expect(result.matches).toEqual([]);
  });

  it('a spoofed declared type is rejected', async () => {
    await expect(
      matchProductsFromPhoto(new MockVisualMatcher(['mug']), PNG, { declaredMimeType: 'image/jpeg' }),
    ).rejects.toThrow(ValidationError);
  });
});

describe('HttpVisionMatcher (fake fetch)', () => {
  function fakeVisionFetch(content: string) {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetchFn: VisionFetch = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content } }] }),
        text: async () => '',
      };
    };
    return { fetchFn, calls };
  }

  it('sends the photo as a data URL and parses the JSON tag reply into matches', async () => {
    const { fetchFn, calls } = fakeVisionFetch('{"tags":["Mug","ceramic","white"],"caption":"A white ceramic mug"}');
    const matcher = new HttpVisionMatcher({ apiKey: 'vk', baseUrl: 'https://vis.example/v1/', fetchFn });
    const result = await matchProductsFromPhoto(matcher, PNG);
    expect(calls[0].url).toBe('https://vis.example/v1/chat/completions');
    const serialized = JSON.stringify(calls[0].body);
    expect(serialized).toContain('data:image/png;base64,');
    expect(result.description.tags).toEqual(['mug', 'ceramic', 'white']);
    expect(result.description.caption).toBe('A white ceramic mug');
    expect(result.matches[0].product.id).toBe('prod-003');
  });

  it('non-JSON or tagless replies are honest errors; env resolution is key-gated', async () => {
    const bad = new HttpVisionMatcher({ apiKey: 'k', fetchFn: fakeVisionFetch('I see a mug!').fetchFn });
    await expect(bad.describe(PNG, { format: 'png', mimeType: 'image/png', byteLength: PNG.length })).rejects.toThrow(/non-JSON/);
    const tagless = new HttpVisionMatcher({ apiKey: 'k', fetchFn: fakeVisionFetch('{"tags":[]}').fetchFn });
    await expect(tagless.describe(PNG, { format: 'png', mimeType: 'image/png', byteLength: PNG.length })).rejects.toThrow(/no tags/);
    expect(httpVisionMatcherFromEnv({})).toBeUndefined();
    expect(resolveVisualMatcher({}).name).toBe('mock-vision');
    expect(resolveVisualMatcher({ MEDIA_VISION_API_KEY: 'k' }).name).toBe('http-vision');
  });
});
