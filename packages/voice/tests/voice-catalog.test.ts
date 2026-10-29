// SPDX-License-Identifier: Apache-2.0
//
// Voice catalog tests (ElevenLabs voices + shared library, Fish model
// search, Chatterbox voices, and the cross-provider dispatcher). All
// HTTP goes through injected fetch stubs — zero real network.

import { describe, expect, it } from 'vitest';
import { searchVoiceCatalog } from '../src/catalog.js';
import { listChatterboxVoices } from '../src/chatterbox.js';
import { ELEVENLABS_BASE_URL, listElevenLabsVoices, searchElevenLabsSharedVoices } from '../src/elevenlabs.js';
import { FISH_BASE_URL, searchFishModels } from '../src/fish.js';
import type { VoiceFetchFn } from '../src/voice.js';

function jsonFetch(body: unknown, status = 200): { fetchFn: VoiceFetchFn; urls: string[] } {
  const urls: string[] = [];
  const fetchFn: VoiceFetchFn = async (url) => {
    urls.push(url);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return { fetchFn, urls };
}

const EL_KEY = { ELEVENLABS_API_KEY: 'xi-test' };
const FISH_KEY = { FISH_API_KEY: 'fish-test' };

describe('listElevenLabsVoices', () => {
  it('GETs /v1/voices with xi-api-key and maps entries', async () => {
    const { fetchFn, urls } = jsonFetch({
      voices: [
        {
          voice_id: 'v1',
          name: 'Rachel',
          category: 'premade',
          description: 'Warm narrator',
          preview_url: 'https://cdn.example.com/v1.mp3',
          labels: { accent: 'american', age: 'young' },
        },
        { voice_id: 'v2', name: 'Adam', category: 'cloned', labels: {} },
        { name: 'missing id — dropped' },
      ],
    });
    const entries = await listElevenLabsVoices({ env: EL_KEY, fetchFn });
    expect(urls).toEqual([`${ELEVENLABS_BASE_URL}/voices`]);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      id: 'v1',
      name: 'Rachel',
      provider: 'elevenlabs',
      description: 'Warm narrator',
      previewUrl: 'https://cdn.example.com/v1.mp3',
      category: 'premade',
      labels: { accent: 'american', age: 'young' },
    });
    expect(entries[1]?.labels).toBeUndefined();
  });

  it('throws without a key and on a malformed response', async () => {
    const { fetchFn } = jsonFetch({ nope: true });
    await expect(listElevenLabsVoices({ env: {}, fetchFn })).rejects.toThrow(/ELEVENLABS_API_KEY/);
    await expect(listElevenLabsVoices({ env: EL_KEY, fetchFn })).rejects.toThrow(/unexpected response shape/);
  });
});

describe('searchElevenLabsSharedVoices', () => {
  it('GETs /v1/shared-voices with search + page_size and maps library fields', async () => {
    const { fetchFn, urls } = jsonFetch({
      voices: [
        {
          voice_id: 's1',
          name: 'Storyteller',
          accent: 'british',
          age: 'middle_aged',
          gender: 'male',
          language: 'en',
          use_case: 'narration',
          preview_url: 'https://cdn.example.com/s1.mp3',
        },
      ],
      has_more: false,
      total_count: 1,
    });
    const entries = await searchElevenLabsSharedVoices({ env: EL_KEY, fetchFn }, { query: 'story', pageSize: 10 });
    expect(urls[0]).toContain(`${ELEVENLABS_BASE_URL}/shared-voices?`);
    expect(urls[0]).toContain('search=story');
    expect(urls[0]).toContain('page_size=10');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: 's1',
      name: 'Storyteller',
      provider: 'elevenlabs',
      language: 'en',
      labels: { accent: 'british', age: 'middle_aged', gender: 'male', useCase: 'narration' },
    });
  });
});

describe('searchFishModels', () => {
  it('GETs /model with title + paging and maps entries', async () => {
    const { fetchFn, urls } = jsonFetch({
      total: 2,
      items: [
        { _id: 'm1', title: 'Friendly Host', description: 'Podcast voice', cover_image: 'https://img.example.com/m1.png', tags: ['en', 'warm'], type: 'tts' },
        { _id: 'm2', title: 'Narrator', tags: 'not-an-array' },
        { title: 'missing id — dropped' },
      ],
    });
    const entries = await searchFishModels({ env: FISH_KEY, fetchFn }, { query: 'host', pageSize: 5 });
    expect(urls[0]).toContain(`${FISH_BASE_URL}/model?`);
    expect(urls[0]).toContain('title=host');
    expect(urls[0]).toContain('page_size=5');
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      id: 'm1',
      name: 'Friendly Host',
      provider: 'fish',
      description: 'Podcast voice',
      imageUrl: 'https://img.example.com/m1.png',
      category: 'tts',
      labels: { tags: 'en, warm' },
    });
    expect(entries[1]?.labels).toBeUndefined();
  });

  it('omits the title param for an empty query (default listing)', async () => {
    const { fetchFn, urls } = jsonFetch({ total: 0, items: [] });
    await searchFishModels({ env: FISH_KEY, fetchFn }, {});
    expect(urls[0]).not.toContain('title=');
  });
});

describe('listChatterboxVoices', () => {
  const ENV = { CHATTERBOX_BASE_URL: 'http://127.0.0.1:8000' };

  it('maps array and {voices} shapes, including bare string ids', async () => {
    const a = jsonFetch([{ id: 'n1', name: 'Narrator' }, 'plain-voice', { nope: true }]);
    expect(await listChatterboxVoices({ env: ENV, fetchFn: a.fetchFn })).toEqual([
      { id: 'n1', name: 'Narrator', provider: 'chatterbox' },
      { id: 'plain-voice', name: 'plain-voice', provider: 'chatterbox' },
    ]);
    const b = jsonFetch({ voices: [{ voice_id: 'w1', name: 'Wrapped' }] });
    expect(await listChatterboxVoices({ env: ENV, fetchFn: b.fetchFn })).toEqual([
      { id: 'w1', name: 'Wrapped', provider: 'chatterbox' },
    ]);
  });

  it('returns [] when the server has no /voices endpoint (404)', async () => {
    const { fetchFn } = jsonFetch({ error: 'not found' }, 404);
    expect(await listChatterboxVoices({ env: ENV, fetchFn })).toEqual([]);
  });
});

describe('searchVoiceCatalog dispatcher', () => {
  it('elevenlabs without a query lists account voices; with a query searches the library', async () => {
    const own = jsonFetch({ voices: [{ voice_id: 'own1', name: 'Mine' }] });
    const a = await searchVoiceCatalog('elevenlabs', {}, { env: EL_KEY, fetchFn: own.fetchFn });
    expect(own.urls[0]).toContain('/voices');
    expect(a[0]?.id).toBe('own1');

    const lib = jsonFetch({ voices: [{ voice_id: 'lib1', name: 'Library Voice', language: 'en' }] });
    const b = await searchVoiceCatalog('elevenlabs', { query: 'lib' }, { env: EL_KEY, fetchFn: lib.fetchFn });
    expect(lib.urls[0]).toContain('/shared-voices');
    expect(b[0]?.id).toBe('lib1');
  });

  it('fish delegates to model search', async () => {
    const { fetchFn, urls } = jsonFetch({ total: 1, items: [{ _id: 'f1', title: 'Fish Voice' }] });
    const entries = await searchVoiceCatalog('fish', { query: 'fish' }, { env: FISH_KEY, fetchFn });
    expect(urls[0]).toContain('/model?');
    expect(entries[0]).toMatchObject({ id: 'f1', provider: 'fish' });
  });

  it('openai is served statically with zero network; query filters locally', async () => {
    const fetchFn: VoiceFetchFn = async () => {
      throw new Error('network must not be called for the static catalog');
    };
    const all = await searchVoiceCatalog('openai', {}, { env: {}, fetchFn });
    expect(all.length).toBeGreaterThanOrEqual(6);
    expect(all.every((e) => e.provider === 'openai')).toBe(true);
    const filtered = await searchVoiceCatalog('openai', { query: 'nova' }, { env: {}, fetchFn });
    expect(filtered).toEqual([{ id: 'nova', name: 'nova', provider: 'openai', category: 'built-in' }]);
  });

  it('mock/system have empty catalogs; unknown providers throw', async () => {
    expect(await searchVoiceCatalog('mock')).toEqual([]);
    expect(await searchVoiceCatalog('system')).toEqual([]);
    await expect(searchVoiceCatalog('deepgram')).rejects.toThrow(/unknown voice catalog provider/);
  });

  it('chatterbox results are filtered by the query locally', async () => {
    const { fetchFn } = jsonFetch([
      { id: 'alpha', name: 'Alpha' },
      { id: 'beta', name: 'Beta' },
    ]);
    const entries = await searchVoiceCatalog(
      'chatterbox',
      { query: 'alph' },
      { env: { CHATTERBOX_BASE_URL: 'http://127.0.0.1:8000' }, fetchFn },
    );
    expect(entries.map((e) => e.id)).toEqual(['alpha']);
  });
});
