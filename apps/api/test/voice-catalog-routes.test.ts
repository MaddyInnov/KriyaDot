// SPDX-License-Identifier: Apache-2.0
//
// Voice catalog route tests. Mounted exactly as the parent is asked to
// wire it (app.use('/api', router) → GET /api/voice/catalog). Provider
// HTTP is stubbed through the router's injectable fetch — zero network.

import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createVoiceCatalogRouter, voiceCatalogErrorStatus } from '../src/voice-catalog-routes.js';

describe('voice catalog routes', () => {
  let server: Server | null = null;
  let baseUrl = '';

  async function mount(router: express.Router): Promise<void> {
    const app = express();
    app.use(express.json());
    app.use('/api', router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}/api`;
  }

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  });

  async function get(path: string): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${baseUrl}${path}`);
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  describe('with an injected search function', () => {
    beforeEach(async () => {
      await mount(
        createVoiceCatalogRouter({
          searchCatalog: async (provider, search) => {
            if (provider === 'boom') throw new Error('elevenlabs catalog failed: 500 Internal — kaput');
            return [
              {
                id: `${provider}-voice-1`,
                name: `Voice for ${search.query ?? ''}`.trim(),
                provider,
                language: search.language,
              },
            ];
          },
        }),
      );
    });

    it('requires the provider param', async () => {
      const { status, json } = await get('/voice/catalog');
      expect(status).toBe(400);
      expect(String(json.error)).toContain('provider');
    });

    it('returns normalized voices with provider/query/count', async () => {
      const { status, json } = await get('/voice/catalog?provider=Fish&q=narrator&language=en');
      expect(status).toBe(200);
      expect(json.provider).toBe('fish');
      expect(json.query).toBe('narrator');
      expect(json.count).toBe(1);
      const voices = json.voices as Array<Record<string, unknown>>;
      expect(voices[0]).toMatchObject({ id: 'fish-voice-1', name: 'Voice for narrator', provider: 'fish', language: 'en' });
    });

    it('maps upstream failures to 502', async () => {
      const { status, json } = await get('/voice/catalog?provider=boom');
      expect(status).toBe(502);
      expect(String(json.detail)).toContain('500');
    });
  });

  describe('with the real @mvp/voice dispatch (fetch stubbed)', () => {
    it('elevenlabs without a key is a 400 naming the missing key', async () => {
      await mount(createVoiceCatalogRouter({ env: {} }));
      const { status, json } = await get('/voice/catalog?provider=elevenlabs');
      expect(status).toBe(400);
      expect(String(json.detail)).toContain('ELEVENLABS_API_KEY');
    });

    it('unknown providers are a 400', async () => {
      await mount(createVoiceCatalogRouter({ env: {} }));
      const { status, json } = await get('/voice/catalog?provider=deepgram');
      expect(status).toBe(400);
      expect(String(json.detail)).toContain('unknown voice catalog provider');
    });

    it('elevenlabs lists account voices; a query switches to the shared library', async () => {
      const urls: string[] = [];
      await mount(
        createVoiceCatalogRouter({
          env: { ELEVENLABS_API_KEY: 'xi-test' },
          fetchFn: async (url) => {
            urls.push(url);
            const body = url.includes('shared-voices')
              ? { voices: [{ voice_id: 'lib1', name: 'Library Voice', language: 'en' }] }
              : { voices: [{ voice_id: 'own1', name: 'My Voice', category: 'cloned' }] };
            return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
          },
        }),
      );
      const own = await get('/voice/catalog?provider=elevenlabs');
      expect(own.status).toBe(200);
      expect((own.json.voices as Array<Record<string, unknown>>)[0]).toMatchObject({ id: 'own1', provider: 'elevenlabs' });
      const lib = await get('/voice/catalog?provider=elevenlabs&q=library');
      expect(lib.status).toBe(200);
      expect((lib.json.voices as Array<Record<string, unknown>>)[0]).toMatchObject({ id: 'lib1' });
      expect(urls.some((u) => u.includes('/shared-voices'))).toBe(true);
      expect(urls.some((u) => u.endsWith('/voices'))).toBe(true);
    });

    it('fish search maps models; openai needs no key and no network', async () => {
      await mount(
        createVoiceCatalogRouter({
          env: { FISH_API_KEY: 'fish-test' },
          fetchFn: async (url) => {
            expect(url).toContain('api.fish.audio/model');
            return new Response(JSON.stringify({ total: 1, items: [{ _id: 'f1', title: 'Fish Voice' }] }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          },
        }),
      );
      const fish = await get('/voice/catalog?provider=fish&q=fish');
      expect(fish.status).toBe(200);
      expect((fish.json.voices as Array<Record<string, unknown>>)[0]).toMatchObject({ id: 'f1', name: 'Fish Voice', provider: 'fish' });

      const openai = await get('/voice/catalog?provider=openai&q=nova');
      expect(openai.status).toBe(200);
      expect(openai.json.voices).toEqual([{ id: 'nova', name: 'nova', provider: 'openai', category: 'built-in' }]);
    });
  });

  describe('voiceCatalogErrorStatus', () => {
    it('classifies config problems as 400 and upstream failures as 502', () => {
      expect(voiceCatalogErrorStatus('unknown voice catalog provider "x"')).toBe(400);
      expect(voiceCatalogErrorStatus('elevenlabs voice: missing ELEVENLABS_API_KEY. Set it')).toBe(400);
      expect(voiceCatalogErrorStatus('fish catalog failed: 503 Service Unavailable')).toBe(502);
    });
  });
});
