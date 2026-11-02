// SPDX-License-Identifier: Apache-2.0
// Tests for templated provider presets (Azure OpenAI, Cloudflare) and the
// harness-gap static presets (apps/api/src/providers.ts):
// - saving a key for a templated provider stores the endpoint field values
//   next to the key (encrypted file + env bridge) and the provider reports
//   configured only once key AND fields resolve to a real base URL
// - a first save missing a required field fails naming the field, and a
//   re-save may omit fields whose values are already stored
// - removing the key removes the endpoint field values too
// - a liveModels preset (google-aistudio) lists models from the provider's
//   /models endpoint — with fetch stubbed; zero live calls in tests.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  listProviders,
  removeProviderKey,
  resolveProviderModels,
  saveProviderKey,
  syncProviderKeysToEnv,
} from '../src/providers.js';
import type { ProviderKeyInput } from '../src/providers.js';

function freshDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'mvp-providers-tpl-'));
}

/** Build a key-save input (shorthand keeps test key values readable). */
function keyInput(key: string, templateValues?: Record<string, string>): ProviderKeyInput {
  return templateValues ? { apiKey: key, templateValues } : { apiKey: key };
}

const TOUCHED_ENV = [
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_API_KEY_TPL_RESOURCE',
  'CLOUDFLARE_AI_GATEWAY_API_KEY',
  'CLOUDFLARE_AI_GATEWAY_API_KEY_TPL_ACCOUNTID',
  'CLOUDFLARE_AI_GATEWAY_API_KEY_TPL_GATEWAYID',
  'GEMINI_API_KEY',
];
const OLD_ENV = { ...process.env };
for (const k of TOUCHED_ENV) delete process.env[k];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of Object.keys(process.env)) {
    if (!(k in OLD_ENV)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(OLD_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('templated provider keys (azure-openai)', () => {
  it('stores key + resource, bridges both into env, and reports configured with template metadata', async () => {
    const dataDir = freshDataDir();
    saveProviderKey(dataDir, 'azure-openai', keyInput('azure-key-1', { resource: 'my-res' }));
    // Env bridge: the runtime resolves template values via env first.
    expect(process.env.AZURE_OPENAI_API_KEY).toBe('azure-key-1');
    expect(process.env.AZURE_OPENAI_API_KEY_TPL_RESOURCE).toBe('my-res');

    const infos = await listProviders(dataDir);
    const azure = infos.find((p) => p.id === 'azure-openai');
    expect(azure).toBeDefined();
    expect(azure?.configured).toBe(true);
    expect(azure?.baseUrlTemplate).toBe('https://{resource}.openai.azure.com/openai/v1/');
    expect(azure?.templateFields).toEqual([
      expect.objectContaining({ name: 'resource', label: 'Azure OpenAI resource name' }),
    ]);
    // Curated starter list (Azure does not serve deployment names on /models).
    expect(azure?.models.map((m) => m.id)).toContain('gpt-4o');
    expect(azure?.notes).toMatch(/DEPLOYMENT/);
  });

  it('fails a first save that is missing the resource, naming the field, and writes nothing', async () => {
    const dataDir = freshDataDir();
    expect(() => saveProviderKey(dataDir, 'azure-openai', keyInput('azure-key-1'))).toThrow(
      /Azure OpenAI resource name/,
    );
    const infos = await listProviders(dataDir);
    expect(infos.find((p) => p.id === 'azure-openai')?.configured).toBe(false);
  });

  it('allows a re-save that omits fields already stored', async () => {
    const dataDir = freshDataDir();
    saveProviderKey(dataDir, 'azure-openai', keyInput('azure-key-1', { resource: 'my-res' }));
    // Second save: new key only — the stored resource is kept.
    saveProviderKey(dataDir, 'azure-openai', keyInput('azure-key-2'));
    // Re-bridge from the file (what a restart does): the new key AND the
    // kept resource both come back.
    delete process.env.AZURE_OPENAI_API_KEY;
    delete process.env.AZURE_OPENAI_API_KEY_TPL_RESOURCE;
    syncProviderKeysToEnv(dataDir);
    expect(process.env.AZURE_OPENAI_API_KEY).toBe('azure-key-2');
    expect(process.env.AZURE_OPENAI_API_KEY_TPL_RESOURCE).toBe('my-res');
    const infos = await listProviders(dataDir);
    expect(infos.find((p) => p.id === 'azure-openai')?.configured).toBe(true);
  });

  it('removeProviderKey removes the endpoint field values with the key', async () => {
    const dataDir = freshDataDir();
    saveProviderKey(dataDir, 'azure-openai', keyInput('azure-key-1', { resource: 'my-res' }));
    expect(removeProviderKey(dataDir, 'azure-openai')).toBe(true);
    expect(process.env.AZURE_OPENAI_API_KEY).toBeUndefined();
    expect(process.env.AZURE_OPENAI_API_KEY_TPL_RESOURCE).toBeUndefined();
    const infos = await listProviders(dataDir);
    expect(infos.find((p) => p.id === 'azure-openai')?.configured).toBe(false);
  });

  it('key without endpoint fields is NOT configured (base URL cannot be built)', async () => {
    const dataDir = freshDataDir();
    // Simulate an env-only key (no stored resource anywhere).
    process.env.AZURE_OPENAI_API_KEY = 'env-only-key';
    const infos = await listProviders(dataDir);
    expect(infos.find((p) => p.id === 'azure-openai')?.configured).toBe(false);
  });
});

describe('templated provider keys (cloudflare-ai-gateway)', () => {
  it('requires BOTH account and gateway ids, then reports configured', async () => {
    const dataDir = freshDataDir();
    expect(() =>
      saveProviderKey(
        dataDir,
        'cloudflare-ai-gateway',
        keyInput('gw-key', { accountId: 'acct42' }),
      ),
    ).toThrow(/AI Gateway ID/);
    saveProviderKey(
      dataDir,
      'cloudflare-ai-gateway',
      keyInput('gw-key', { accountId: 'acct42', gatewayId: 'default' }),
    );
    const infos = await listProviders(dataDir);
    const gw = infos.find((p) => p.id === 'cloudflare-ai-gateway');
    expect(gw?.configured).toBe(true);
    expect(gw?.templateFields?.map((f) => f.name)).toEqual(['accountId', 'gatewayId']);
    expect(gw?.models.map((m) => m.id)).toContain('workers-ai/@cf/meta/llama-3.3-70b-fp8-fast');
  });
});

describe('live model listing (google-aistudio, fetch stubbed)', () => {
  it('lists models from the provider /models endpoint once a key is saved', async () => {
    const dataDir = freshDataDir();
    const seen: { url: string; auth: string | undefined }[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: { headers?: Record<string, string> }) => {
      seen.push({ url: String(url), auth: init?.headers?.Authorization });
      if (String(url).startsWith('https://generativelanguage.googleapis.com/v1beta/openai/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              { id: 'gemini-live-flash', context_length: 1048576 },
              { id: 'gemini-live-pro' },
            ],
          }),
        };
      }
      throw new Error('network disabled in tests');
    });
    saveProviderKey(dataDir, 'google-aistudio', keyInput('gemini-key-1'));
    const models = await resolveProviderModels('google-aistudio');
    expect(models.map((m) => m.id)).toEqual(['gemini-live-flash', 'gemini-live-pro']);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/models');
    expect(seen[0]?.auth).toBe('Bearer gemini-key-1');
  });

  it('falls back to the curated catalog list when the live fetch fails', async () => {
    const dataDir = freshDataDir();
    vi.stubGlobal('fetch', async () => {
      throw new Error('network disabled in tests');
    });
    saveProviderKey(dataDir, 'google-aistudio', keyInput('gemini-key-1'));
    const models = await resolveProviderModels('google-aistudio');
    expect(models.map((m) => m.id)).toContain('gemini-2.5-flash');
  });
});

describe('new presets appear in the provider list', () => {
  it('includes all six harness-gap presets, unconfigured, with no-key catalog models', async () => {
    const dataDir = freshDataDir();
    const infos = await listProviders(dataDir);
    for (const id of [
      'azure-openai',
      'baseten',
      'cloudflare-ai-gateway',
      'cloudflare-workers-ai',
      'google-aistudio',
      'huggingface',
    ]) {
      const info = infos.find((p) => p.id === id);
      expect(info, id).toBeDefined();
      expect(info?.configured, id).toBe(false);
      expect(info?.models.length ?? 0, id).toBeGreaterThan(0);
    }
    // liveModels presets expose their curated fallback list before any key.
    expect(infos.find((p) => p.id === 'huggingface')?.models.map((m) => m.id)).toContain(
      'meta-llama/Llama-3.3-70B-Instruct',
    );
    expect(infos.find((p) => p.id === 'baseten')?.models.map((m) => m.id)).toContain(
      'openai/gpt-oss-120b',
    );
    expect(infos.find((p) => p.id === 'cloudflare-workers-ai')?.models.map((m) => m.id)).toContain(
      '@cf/meta/llama-3.3-70b-fp8-fast',
    );
  });
});
