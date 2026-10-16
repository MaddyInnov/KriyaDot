// SPDX-License-Identifier: Apache-2.0
// Tests for apps/api/src/loopback-auth.ts (C1): per-boot bearer token,
// CORS allowlist, bearer middleware, bootstrap handler, one-time WS tickets.

import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CORS_ALLOWLIST,
  consumeWsTicket,
  corsOriginFn,
  createBootstrapHandler,
  ensureLoopbackToken,
  getCorsAllowlist,
  isOriginAllowed,
  issueWsTicket,
  requireLoopbackAuth,
  validateWsQueryToken,
} from '../src/loopback-auth.js';

describe('ensureLoopbackToken', () => {
  it('mints a 64-char hex token and persists it with mode 0600', () => {
    const dir = mkdtempSync(join(tmpdir(), 'loopback-'));
    const token = ensureLoopbackToken(dir);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const file = join(dir, '.api-token');
    expect(readFileSync(file, 'utf8').trim()).toBe(token);
    // Best-effort check: on POSIX the mode should be 0600. (Windows/macOS
    // ACLs don't map to this; only assert when the platform reports it.)
    const mode = statSync(file).mode & 0o777;
    if (process.platform !== 'win32') expect(mode).toBe(0o600);
  });

  it('regenerates the token on every call (per-boot rotation)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'loopback-'));
    const a = ensureLoopbackToken(dir);
    const b = ensureLoopbackToken(dir);
    expect(a).not.toBe(b);
    expect(readFileSync(join(dir, '.api-token'), 'utf8').trim()).toBe(b);
  });
});

describe('CORS allowlist', () => {
  it('contains the Tauri and local dev origins', () => {
    expect(CORS_ALLOWLIST).toContain('tauri://localhost');
    expect(CORS_ALLOWLIST).toContain('http://tauri.localhost');
    expect(CORS_ALLOWLIST).toContain('http://localhost:3000');
    expect(CORS_ALLOWLIST).toContain('http://127.0.0.1:3000');
    expect(CORS_ALLOWLIST).not.toContain('*');
  });

  it('honors KRIYADOT_CORS_ORIGINS (comma-separated, trimmed)', () => {
    const prev = process.env.KRIYADOT_CORS_ORIGINS;
    process.env.KRIYADOT_CORS_ORIGINS = ' https://desk.example.com ,http://10.0.0.2:8080, ';
    try {
      expect(getCorsAllowlist()).toContain('https://desk.example.com');
      expect(getCorsAllowlist()).toContain('http://10.0.0.2:8080');
      expect(isOriginAllowed('https://desk.example.com')).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.KRIYADOT_CORS_ORIGINS;
      else process.env.KRIYADOT_CORS_ORIGINS = prev;
    }
  });

  it('corsOriginFn allows allowlisted origins and headerless clients, denies evil origins', () => {
    const run = (origin: string | undefined): boolean =>
      new Promise((resolve, reject) => {
        corsOriginFn(origin, (err, allow) => (err ? reject(err) : resolve(allow === true)));
      });
    return (async () => {
      expect(await run('tauri://localhost')).toBe(true);
      expect(await run('http://localhost:3000')).toBe(true);
      expect(await run(undefined)).toBe(true); // curl / TUI / Android: CORS is not auth
      expect(await run('https://evil.example')).toBe(false);
      expect(await run('null')).toBe(false);
    })();
  });
});

describe('requireLoopbackAuth', () => {
  let base = '';
  let server: { close(cb?: () => void): void } | null = null;
  const TOKEN = 'a'.repeat(64);

  beforeEach(async () => {
    const app = express();
    app.use(requireLoopbackAuth(TOKEN));
    app.get('/api/bots', (req, res) => res.json({ ok: true, authed: req.loopbackAuthed === true }));
    app.get('/api/health', (_req, res) => res.json({ ok: true }));
    app.get('/api/companion/devices', (_req, res) => res.json({ ok: true })); // exempt prefix
    app.get('/.well-known/agent-card.json', (_req, res) => res.json({ ok: true })); // exempt prefix
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(() => {
    server?.close();
    server = null;
  });

  const get = (path: string, headers?: Record<string, string>) => fetch(`${base}${path}`, { headers });

  it('401s protected routes without a token', async () => {
    const r = await get('/api/bots');
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ ok: false, error: 'unauthorized' });
  });

  it('401s on a wrong token', async () => {
    const r = await get('/api/bots', { Authorization: `Bearer ${'b'.repeat(64)}` });
    expect(r.status).toBe(401);
  });

  it('lets the correct bearer token through and marks the request', async () => {
    const r = await get('/api/bots', { Authorization: `Bearer ${TOKEN}` });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, authed: true });
  });

  it('passes exempt prefixes without a token (health, companion, well-known)', async () => {
    for (const p of ['/api/health', '/api/companion/devices', '/.well-known/agent-card.json']) {
      const r = await get(p);
      expect(r.status).toBe(200);
    }
  });

  it('lets the web UI and other non-API paths load without a token, but protects /worktrees', async () => {
    // Web-asset paths (served by web-assets.ts) must load so the browser can
    // reach /api/auth/bootstrap; /webhooks has its own per-trigger secret.
    for (const p of ['/', '/approvals', '/_next/static/app.js', '/_kriyadot/', '/webhooks/some-hook']) {
      const r = await get(p);
      expect(r.status).not.toBe(401);
    }
    const w = await get('/worktrees/abc');
    expect(w.status).toBe(401);
  });
});

describe('createBootstrapHandler', () => {
  const TOKEN = 'c'.repeat(64);
  let base = '';
  let server: { close(cb?: () => void): void } | null = null;

  beforeEach(async () => {
    const app = express();
    app.get('/api/auth/bootstrap', createBootstrapHandler(TOKEN));
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(() => {
    server?.close();
    server = null;
  });

  const get = (origin?: string) =>
    fetch(`${base}/api/auth/bootstrap`, origin === undefined ? {} : { headers: { Origin: origin } });

  it('returns the token when Origin is absent (non-browser client)', async () => {
    const r = await get();
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, token: TOKEN });
  });

  it('returns the token for an allowlisted Origin', async () => {
    const r = await get('tauri://localhost');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, token: TOKEN });
  });

  it('403s for a non-allowlisted Origin (evil site cannot steal the token)', async () => {
    const r = await get('https://evil.example');
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ ok: false, error: 'origin_not_allowed' });
  });
});

describe('one-time WS tickets', () => {
  it('issues a ticket that consumes exactly once', () => {
    const t = issueWsTicket();
    expect(typeof t).toBe('string');
    expect(t.length).toBeGreaterThan(0);
    expect(consumeWsTicket(t)).toBe(true);
    expect(consumeWsTicket(t)).toBe(false); // replay rejected
  });

  it('rejects unknown, empty and non-string tickets', () => {
    expect(consumeWsTicket('definitely-not-a-real-ticket')).toBe(false);
    expect(consumeWsTicket('')).toBe(false);
    expect(consumeWsTicket(undefined)).toBe(false);
    expect(consumeWsTicket(123)).toBe(false);
  });

  it('rejects expired tickets', async () => {
    const t = issueWsTicket(1);
    await new Promise((r) => setTimeout(r, 10));
    expect(consumeWsTicket(t)).toBe(false);
  });

  it('issues unique tickets', () => {
    expect(issueWsTicket()).not.toBe(issueWsTicket());
  });

  it('does not depend on wall-clock equality tricks (constant-time path smoke)', () => {
    const t = issueWsTicket();
    // A same-length wrong ticket must not match.
    const wrong = `${t.slice(0, -1)}${t.endsWith('A') ? 'B' : 'A'}`;
    expect(consumeWsTicket(wrong)).toBe(false);
    expect(consumeWsTicket(t)).toBe(true);
  });
});

describe('validateWsQueryToken', () => {
  const TOKEN = 'd'.repeat(64);
  const params = (qs: string) => new URLSearchParams(qs);

  it('accepts the exact loopback token as ?token=', () => {
    expect(validateWsQueryToken(params(`token=${TOKEN}`), TOKEN)).toBe(true);
  });

  it('rejects a wrong, empty, or missing ?token=', () => {
    expect(validateWsQueryToken(params(`token=${'e'.repeat(64)}`), TOKEN)).toBe(false);
    expect(validateWsQueryToken(params('token='), TOKEN)).toBe(false);
    expect(validateWsQueryToken(params(''), TOKEN)).toBe(false);
  });

  it('accepts a one-time ?ticket= and consumes it', () => {
    const t = issueWsTicket();
    expect(validateWsQueryToken(params(`ticket=${encodeURIComponent(t)}`), TOKEN)).toBe(true);
    // Single-use: the same ticket is now spent.
    expect(validateWsQueryToken(params(`ticket=${encodeURIComponent(t)}`), TOKEN)).toBe(false);
  });

  it('rejects a bogus ?ticket=', () => {
    expect(validateWsQueryToken(params('ticket=nope'), TOKEN)).toBe(false);
  });
});
