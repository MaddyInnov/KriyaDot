// SPDX-License-Identifier: Apache-2.0
// A9 API flow: a signed declarative-provider package installed into a
// RUNNING server (real HTTP, real PluginManager) makes its provider
// appear in the provider listing and serve a chat turn through the
// built-in driver; uninstall removes it — no restart anywhere. Unsigned
// packages are refused over HTTP too, and the publisher-trust routes
// manage the user's trusted keys. The only LLM endpoint is a local fake
// OpenAI-compatible server; zero paid APIs.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PluginManager,
  PluginTrustStore,
  createSignedPluginPackage,
  createZipArchive,
  generatePluginPublisherKeyPair,
  type PackageFileEntry,
} from '@mvp/plugins';
import { clearPluginProviderPresets, createProvider } from '@mvp/agent-runtime';
import { createPluginRouter } from '../src/plugin-routes.js';
import { listProviders } from '../src/providers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
void HERE;

let fakeServer: Server;
let fakeBaseUrl = '';
let server: { close(cb: () => void): void } | undefined;
let baseUrl = '';
let dataDir = '';
let trustStore: PluginTrustStore;

const publisher = generatePluginPublisherKeyPair();
const secondPublisher = generatePluginPublisherKeyPair();

function providerPackage(base: string, keyPair = publisher): Buffer {
  const manifest = {
    id: 'fake-llm-plugin',
    name: 'Fake LLM Provider',
    version: '1.0.0',
    description: 'Manifest-only declarative provider (A9 test fixture)',
    kinds: ['provider'],
    publisher: 'A9 Tests',
    secrets: ['FAKE_LLM_API_KEY'],
    provider: {
      providerId: 'fake-llm',
      displayName: 'Fake LLM',
      baseUrl: base,
      apiKeyEnv: 'FAKE_LLM_API_KEY',
      liveModels: true,
    },
  };
  const files: PackageFileEntry[] = [{ name: 'plugin.json', data: Buffer.from(JSON.stringify(manifest)) }];
  return createSignedPluginPackage(files, keyPair);
}

async function api(path: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(baseUrl + path, init);
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

beforeAll(async () => {
  process.env.FAKE_LLM_API_KEY = 'test-key-not-real';
  fakeServer = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'fake-1' }, { id: 'fake-2' }] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { model?: string };
        const chunk = { choices: [{ delta: { content: `pong via ${parsed.model ?? '?'}` }, finish_reason: null }] };
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => fakeServer.listen(0, '127.0.0.1', () => resolve()));
  fakeBaseUrl = `http://127.0.0.1:${(fakeServer.address() as AddressInfo).port}/v1`;

  dataDir = mkdtempSync(join(tmpdir(), 'plugin-a9-api-'));
  trustStore = new PluginTrustStore(join(dataDir, 'plugin-trust.json'));
  const manager = new PluginManager({
    dataDir,
    approveInstall: () => true,
    trustedPublisherKeys: [publisher.publicKey],
    trustStore,
  });
  const app = express();
  app.use(express.json());
  app.use('/api', createPluginRouter({ manager, trustStore }));
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve()) as unknown as { close(cb: () => void): void };
  });
  baseUrl = `http://127.0.0.1:${(server as unknown as { address(): { port: number } }).address().port}`;
});

afterAll(async () => {
  clearPluginProviderPresets();
  delete process.env.FAKE_LLM_API_KEY;
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  await new Promise<void>((resolve) => fakeServer.close(() => resolve()));
});

describe('A9 hot declarative-provider flow over HTTP', () => {
  it('install (signed) → provider listed with live models → chat turn round-trips → uninstall → gone', async () => {
    const pkgPath = join(dataDir, 'fake-llm.kdpkg');
    writeFileSync(pkgPath, providerPackage(fakeBaseUrl));

    const installed = await api('/api/plugins/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'package', path: pkgPath }),
    });
    expect(installed.status).toBe(201);
    const plugin = installed.body.plugin as { signature: { status: string; keyId?: string }; provider?: { providerId: string } };
    expect(plugin.signature.status).toBe('verified');
    expect(plugin.signature.keyId).toBe(publisher.keyId);
    expect(plugin.provider?.providerId).toBe('fake-llm');

    // The picker/listing now includes the provider, with models fetched
    // LIVE from the fake server — same running process, no restart.
    const providers = await listProviders(dataDir);
    const info = providers.find((p) => p.id === 'fake-llm');
    expect(info).toBeDefined();
    expect(info?.configured).toBe(true);
    expect(info?.models.map((m) => m.id)).toEqual(['fake-1', 'fake-2']);

    const turn = await createProvider('fake-llm').chat([{ role: 'user', content: 'ping' }], [], { model: 'fake-1' });
    expect(turn.content).toBe('pong via fake-1');

    const removed = await api('/api/plugins/fake-llm-plugin', { method: 'DELETE' });
    expect(removed.status).toBe(200);
    const after = await listProviders(dataDir);
    expect(after.find((p) => p.id === 'fake-llm')).toBeUndefined();
    expect(() => createProvider('fake-llm')).toThrow(/Unknown provider/);
  });

  it('an unsigned package is refused over HTTP (403) — no silent bypass', async () => {
    const pkgPath = join(dataDir, 'unsigned.zip');
    const manifest = { id: 'nope', name: 'Nope', version: '1.0.0', description: 'd', kinds: ['skill'] };
    writeFileSync(
      pkgPath,
      createZipArchive([
        { name: 'plugin.json', data: Buffer.from(JSON.stringify(manifest)) },
        { name: 'SKILL.md', data: Buffer.from('# nope') },
      ]),
    );
    const res = await api('/api/plugins/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'zip', path: pkgPath }),
    });
    expect(res.status).toBe(403);
    expect(String(res.body.error)).toMatch(/signature/);
  });

  it('publisher trust routes: list, add (package from that key then verifies), remove', async () => {
    const listed = await api('/api/plugins/trust');
    expect(listed.status).toBe(200);
    const keys = listed.body.trustedKeys as Array<{ keyId: string }>;
    expect(keys.map((k) => k.keyId)).toContain(publisher.keyId);

    const added = await api('/api/plugins/trust', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicKey: secondPublisher.publicKey, label: 'Second Publisher' }),
    });
    expect(added.status).toBe(201);

    // A package signed by the newly trusted key now installs as verified.
    const pkgPath = join(dataDir, 'fake-llm-2.kdpkg');
    writeFileSync(pkgPath, providerPackage(fakeBaseUrl, secondPublisher));
    const installed = await api('/api/plugins/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'package', path: pkgPath }),
    });
    expect(installed.status).toBe(201);
    expect((installed.body.plugin as { signature: { status: string } }).signature.status).toBe('verified');
    await api('/api/plugins/fake-llm-plugin', { method: 'DELETE' });

    const removed = await api(`/api/plugins/trust/${secondPublisher.keyId}`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    const missing = await api(`/api/plugins/trust/${secondPublisher.keyId}`, { method: 'DELETE' });
    expect(missing.status).toBe(404);
  });
});
