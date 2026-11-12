// SPDX-License-Identifier: Apache-2.0
// Tests for the in-app CLI sign-in routes (OpenMausBot parity):
// - status shape, unknown CLI rejection, login conflict handling
// - sessions listing (empty when the CLI layout is unknown)
// - responses never contain token bytes
// - 2026-11-09: the paste-code endpoint (Claude Code `claude auth login`)
//   and the namesake warning on /status, exercised end-to-end against
//   fake CLI scripts that mimic the real CLIs' sign-in behaviour.

import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
    // A2: the sign-in surface covers the five manifest bridges too.
    expect(body.clis.map((c) => c['cliId']).sort()).toEqual(['antigravity', 'claude', 'codex', 'copilot', 'grok', 'hermes', 'kimi', 'opencode', 'pi']);
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

  it('POST /:cliId/login/:loginId/code 404s for unknown logins', async () => {
    const { status } = await request(app, 'POST', '/api/cli-auth/claude/login/nope/code', { code: 'X' });
    expect(status).toBe(404);
  });
});

describe('cli-auth routes with fake CLIs on PATH', () => {
  let app: express.Express;
  let fakeBin: string;

  function plant(name: string, body: string): void {
    const p = join(fakeBin, name);
    writeFileSync(p, body);
    chmodSync(p, 0o755);
  }

  beforeEach(() => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'cli-auth-routes-home-'));
    fakeBin = mkdtempSync(join(tmpdir(), 'cli-auth-routes-bin-'));
    mkdirSync(fakeBin, { recursive: true });
    process.env.HOME = fakeHome;
    // Fake bin first, then the coreutils dirs only: the fake scripts use
    // external commands (mkdir), but no real CLI may shadow the fakes.
    process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
    app = makeApp();
  });

  it('GET /status flags a Python namesake codex as not-present with a plain warning', async () => {
    plant(
      'codex',
      '#!/bin/sh\necho "Traceback (most recent call last):" >&2\necho "ImportError: boom" >&2\nexit 1\n',
    );
    const { status, json } = await request(app, 'GET', '/api/cli-auth/status');
    expect(status).toBe(200);
    const body = json as { clis: Array<Record<string, unknown>> };
    const codex = body.clis.find((c) => c['cliId'] === 'codex');
    expect(codex?.['cliPresent']).toBe(false);
    expect(String(codex?.['namesakeWarning'])).toMatch(/Python/);
  });

  it('POST code to a login that takes no code -> 400', async () => {
    plant(
      'codex',
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then echo "codex-cli 0.44.0"; exit 0; fi',
        'echo "To sign in, open https://example.com/device in your browser"',
        'sleep 30',
        '',
      ].join('\n'),
    );
    const started = await request(app, 'POST', '/api/cli-auth/codex/login');
    expect(started.status).toBe(200);
    const { loginId, acceptsCode } = started.json as { loginId: string; acceptsCode?: boolean };
    expect(acceptsCode).toBe(false);
    const posted = await request(app, 'POST', `/api/cli-auth/codex/login/${loginId}/code`, { code: 'ABC' });
    expect(posted.status).toBe(400);
    await request(app, 'POST', `/api/cli-auth/codex/login/${loginId}/cancel`);
  });

  it('Claude paste-code sign-in completes end-to-end (URL -> code -> credentials -> done)', async () => {
    plant(
      'claude',
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then echo "2.0.0 (Claude Code)"; exit 0; fi',
        'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then echo \'{"loggedIn":false}\'; exit 1; fi',
        'if [ "$1" = "auth" ] && [ "$2" = "login" ]; then',
        '  echo "Open this URL: https://claude.ai/oauth/authorize?fake=1"',
        '  echo "Paste code here if prompted > "',
        '  read -r code || exit 1',
        '  mkdir -p "$HOME/.claude"',
        '  printf \'%s\' \'{"claudeAiOauth":{"accessToken":"sk-ant-oat01-e2e","expiresAt":9999999999999}}\' > "$HOME/.claude/.credentials.json"',
        '  exit 0',
        'fi',
        'exit 0',
        '',
      ].join('\n'),
    );
    const started = await request(app, 'POST', '/api/cli-auth/claude/login');
    expect(started.status).toBe(200);
    const { loginId, url, acceptsCode } = started.json as { loginId: string; url: string; acceptsCode?: boolean };
    expect(url).toContain('https://claude.ai/oauth/authorize');
    expect(acceptsCode).toBe(true);

    const bad = await request(app, 'POST', `/api/cli-auth/claude/login/${loginId}/code`, { code: '   ' });
    expect(bad.status).toBe(400);

    const posted = await request(app, 'POST', `/api/cli-auth/claude/login/${loginId}/code`, { code: 'FAKE-CODE-1' });
    expect(posted.status).toBe(200);

    // The manager polls the credential file (2s cadence): wait for done.
    let finalStatus = '';
    for (let i = 0; i < 40; i++) {
      const polled = await request(app, 'GET', `/api/cli-auth/claude/login/${loginId}`);
      finalStatus = (polled.json as { status: string }).status;
      if (finalStatus === 'done' || finalStatus === 'failed') break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(finalStatus).toBe('done');
  }, 30_000);
});
