// SPDX-License-Identifier: Apache-2.0
// Tests for the JSON body-limit split (L8). The middleware stack mirrors
// src/index.ts exactly: a 150mb parser ONLY on POST /api/files/upload,
// mounted before the global 5mb parser.

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

let server: Server | null = null;
afterEach(() => {
  if (server) {
    server.close();
    server = null;
  }
});

async function buildApp(): Promise<string> {
  const app = express();
  // ---- same order as src/index.ts ----
  app.use('/api/files/upload', express.json({ limit: '150mb' }));
  app.use(express.json({ limit: '5mb' }));
  // ------------------------------------
  app.post('/api/files/upload', (_req, res) => {
    res.json({ ok: true });
  });
  app.post('/api/chat', (_req, res) => {
    res.json({ ok: true });
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server!.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

const bigBody = JSON.stringify({ data: 'x'.repeat(6 * 1024 * 1024) }); // ~6mb
const post = (baseUrl: string, path: string, body: string) =>
  fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });

describe('JSON body limits (L8)', () => {
  it('the upload route still accepts large bodies (150mb parser)', async () => {
    const baseUrl = await buildApp();
    const res = await post(baseUrl, '/api/files/upload', bigBody);
    expect(res.status).toBe(200);
  });

  it('other routes reject oversize bodies with 413 (5mb default)', async () => {
    const baseUrl = await buildApp();
    const res = await post(baseUrl, '/api/chat', bigBody);
    expect(res.status).toBe(413);
  });

  it('other routes accept normal bodies', async () => {
    const baseUrl = await buildApp();
    const res = await post(baseUrl, '/api/chat', JSON.stringify({ message: 'hello' }));
    expect(res.status).toBe(200);
  });
});
