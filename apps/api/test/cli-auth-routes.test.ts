// SPDX-License-Identifier: Apache-2.0
// Tests for the in-app CLI sign-in routes (OpenMausBot parity):
// - status shape, unknown CLI rejection, login conflict handling
// - sessions listing (empty when the CLI layout is unknown)
// - responses never contain token bytes

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { beforeEach, describe, expect, it } from 'vitest';
import { createCliAuthRouter } from '../src/cli-auth-routes.js';

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/cli-auth', createCliAuthRouter());
  return app;
}

// Minimal supertest-style helper without the dependency.
async function request(
  app: express.Express,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const http = await import('node:http');
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      json = text;
    }
    return { status: res.status, json };
  } finally {
    server.close();
  }
}

describe('cli-auth routes', () => {
  let app: express.Express;
  let fakeHome: string;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'cli-auth-routes-test-'));
    process.env.HOME = fakeHome;
    process.env.PATH = '/nonexistent-bin-dir';
    app = makeApp();
  });

  it('GET /status returns per-CLI status without token bytes', async () => {
    const { status, json } = await request(app, 'GET', '/api/cli-auth/status');
    expect(status).toBe(200);
    const body = json as { ok: boolean; clis: Array<Record<string, unknown>> };
    expect(body.ok).toBe(true);
    expect(body.clis.map((c) => c['cliId']).sort()).toEqual(['antigravity', 'claude', 'codex', 'copilot', 'opencode']);
    for (const c of body.clis) {
      expect(c).toHaveProperty('cliPresent');
      expect(c).toHaveProperty('signedIn');
      expect(c['signedIn']).toBe(false);
    }
    // No token material anywhere in the response.
    expect(JSON.stringify(body)).not.toMatch(/sk-ant|sk-[A-Za-z0-9]{8,}|eyJ/);
  });

  it('POST /:cliId/login rejects unknown CLIs', async () => {
    const { status, json } = await request(app, 'POST', '/api/cli-auth/bogus/login');
    expect(status).toBe(400);
    expect((json as { ok: boolean }).ok).toBe(false);
  });

  it('POST /:cliId/login fails cleanly when the CLI is absent', async () => {
    // PATH has no codex: the login child fails to spawn → 502 with a clean message.
    const { status, json } = await request(app, 'POST', '/api/cli-auth/codex/login');
    expect([502, 500]).toContain(status);
    expect(JSON.stringify(json)).not.toMatch(/sk-ant|eyJ/);
  });

  it('GET /:cliId/login/:loginId 404s for unknown logins', async () => {
    const { status } = await request(app, 'GET', '/api/cli-auth/codex/login/nope');
    expect(status).toBe(404);
  });

  it('POST /:cliId/login/:loginId/cancel 404s for unknown logins', async () => {
    const { status } = await request(app, 'POST', '/api/cli-auth/codex/login/nope/cancel');
    expect(status).toBe(404);
  });

  it('GET /:cliId/sessions returns a list (empty for unknown layouts)', async () => {
    const { status, json } = await request(app, 'GET', '/api/cli-auth/codex/sessions');
    expect(status).toBe(200);
    const body = json as { ok: boolean; sessions: unknown[] };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.sessions)).toBe(true);
  });

  it('GET /:cliId/sessions rejects unknown CLIs', async () => {
    const { status } = await request(app, 'GET', '/api/cli-auth/bogus/sessions');
    expect(status).toBe(400);
  });

  it('accepts the driver-style cli ids for sessions too', async () => {
    const { status, json } = await request(app, 'GET', '/api/cli-auth/claude-code/sessions');
    expect(status).toBe(200);
    expect((json as { ok: boolean }).ok).toBe(true);
  });
});
