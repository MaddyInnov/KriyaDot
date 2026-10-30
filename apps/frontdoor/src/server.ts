// SPDX-License-Identifier: Apache-2.0
// KriyaDot frontdoor service: one small node:http server that
//   - serves the static landing site (FRONTDOOR_SITE_DIR),
//   - runs Google OIDC sign-in and cookie sessions,
//   - keeps the workspace registry (account -> instance addresses),
//   - mints single-use link codes and Ed25519 handoff tokens,
//   - renders the signed-in app shell (/app, /app/chat, /app/lightning,
//     /app/plan, /app/whats-new).
// It NEVER carries chat traffic and NEVER stores chat content or instance
// credentials — see store.ts. If this service is down, existing instances
// keep working; users lose only the launcher.

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadHandoffKeys, mintHandoffToken, type HandoffKeys } from './handoff.js';
import { OidcClient, type FetchFn } from './oidc.js';
import {
  chatPage,
  dashboardPage,
  lightningPage,
  planPage,
  signInNotConfiguredPage,
  simpleMessagePage,
  whatsNewPage,
} from './pages.js';
import { FrontdoorStore, hashToken, type Account, type Workspace } from './store.js';

export interface FrontdoorConfig {
  /** Directory holding frontdoor-state.json. */
  stateDir: string;
  /** Directory holding the static landing site (index.html, assets, …). */
  siteDir: string;
  /** Directory holding frontdoor-owned static assets (app.css). Defaults to <app>/public. */
  publicDir?: string;
  /** Public base URL of this service (redirect URI + Secure cookie decision). Derived from the request Host when unset. */
  baseUrl?: string;
  googleClientId?: string;
  googleClientSecret?: string;
  /** OIDC issuer base; default https://accounts.google.com. Overridable for tests. */
  oidcIssuer?: string;
  handoffPrivateKeyPem?: string;
  handoffKeyFile?: string;
  /** Injectable fetch (OIDC, instance probes, changelog). Defaults to global fetch. */
  fetchFn?: FetchFn;
  log?: (msg: string) => void;
}

export interface Frontdoor {
  server: Server;
  store: FrontdoorStore;
  handoffKeys: HandoffKeys;
  oidc: OidcClient | null;
  config: FrontdoorConfig;
}

const SESSION_COOKIE = 'fd_session';
const LINK_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // unambiguous: no 0/O/1/I/L
const LINK_CODE_TTL_MS = 15 * 60 * 1000;
const PROBE_TIMEOUT_MS = 2000;
const PROBE_CACHE_MS = 60 * 1000;
const CHANGELOG_TTL_MS = 10 * 60 * 1000;
const CHANGELOG_URL = 'https://api.github.com/repos/MaddyInnov/KriyaDot/releases?per_page=10';
const MAX_BODY_BYTES = 64 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function generateLinkCode(): string {
  const bytes = randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i++) code += LINK_CODE_ALPHABET[bytes[i]! % LINK_CODE_ALPHABET.length];
  return code;
}

function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buf);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html) });
  res.end(html);
}

function redirect(res: ServerResponse, location: string, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(302, { location, ...extraHeaders });
  res.end();
}

export function createFrontdoor(config: FrontdoorConfig): Frontdoor {
  const log = config.log ?? ((msg: string) => console.log(msg));
  const fetchFn: FetchFn = config.fetchFn ?? fetch;
  const store = new FrontdoorStore(config.stateDir);
  const handoffKeys = loadHandoffKeys({
    pem: config.handoffPrivateKeyPem,
    keyFile: config.handoffKeyFile,
    log,
  });
  const oidc =
    config.googleClientId && config.googleClientSecret
      ? new OidcClient(
          {
            issuer: config.oidcIssuer ?? 'https://accounts.google.com',
            clientId: config.googleClientId,
            clientSecret: config.googleClientSecret,
          },
          fetchFn,
        )
      : null;

  const siteRoot = resolve(config.siteDir);
  const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const publicRoot = resolve(config.publicDir ?? join(appDir, 'public'));

  const probeCache = new Map<string, { status: string; at: number }>();
  let changelogCache: { at: number; releases: unknown[] } | null = null;

  function effectiveBase(req: IncomingMessage): string {
    if (config.baseUrl) return config.baseUrl.replace(/\/+$/, '');
    const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'http';
    const host = req.headers.host ?? 'localhost';
    return `${proto}://${host}`;
  }

  function sessionAccount(req: IncomingMessage): Account | null {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (!token) return null;
    const record = store.getSession(hashToken(token));
    if (!record) return null;
    return store.getAccount(record.accountId) ?? null;
  }

  function requireAccount(req: IncomingMessage, res: ServerResponse): Account | null {
    const account = sessionAccount(req);
    if (!account) {
      sendJson(res, 401, { error: 'unauthorized', message: 'Sign in required.' });
      return null;
    }
    return account;
  }

  async function probeWorkspace(instanceUrl: string): Promise<'online' | 'offline' | 'unknown'> {
    let parsed: URL;
    try {
      parsed = new URL(instanceUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'unknown';
    } catch {
      return 'unknown';
    }
    const cached = probeCache.get(instanceUrl);
    if (cached && Date.now() - cached.at < PROBE_CACHE_MS) return cached.status as 'online' | 'offline' | 'unknown';
    let status: 'online' | 'offline' | 'unknown' = 'offline';
    for (const path of ['/api/health', '/api/status']) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
        try {
          const res = await fetchFn(`${instanceUrl.replace(/\/+$/, '')}${path}`, { signal: controller.signal });
          if (res.ok) {
            status = 'online';
            break;
          }
        } finally {
          clearTimeout(timer);
        }
      } catch {
        // try the next path, then report offline
      }
    }
    probeCache.set(instanceUrl, { status, at: Date.now() });
    return status;
  }

  function serveFile(res: ServerResponse, root: string, urlPath: string, fallbackIndex: boolean): boolean {
    let decoded: string;
    try {
      decoded = decodeURIComponent(urlPath);
    } catch {
      return false;
    }
    const rel = normalize(decoded.replace(/^\/+/, ''));
    const target = resolve(join(root, rel));
    if (target !== root && !target.startsWith(root + sep)) return false; // traversal guard
    let file = target;
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file) || !statSync(file).isFile()) {
      if (fallbackIndex) {
        const index = join(root, 'index.html');
        if (existsSync(index)) file = index;
        else return false;
      } else {
        return false;
      }
    }
    const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
    const body = readFileSync(file);
    res.writeHead(200, {
      'content-type': type,
      'content-length': body.length,
      'cache-control': type.startsWith('text/html') ? 'no-cache' : 'public, max-age=60',
    });
    res.end(body);
    return true;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://frontdoor.local');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    // ---- health + public key (unguarded) ---------------------------------
    if (method === 'GET' && path === '/api/health') {
      sendJson(res, 200, { ok: true, service: 'kriyadot-frontdoor' });
      return;
    }
    if (method === 'GET' && path === '/api/handoff/public-key') {
      sendJson(res, 200, { publicKey: handoffKeys.publicKeyPem, ephemeral: handoffKeys.ephemeral });
      return;
    }

    // ---- Google OIDC -------------------------------------------------------
    if (method === 'GET' && path === '/auth/google') {
      if (!oidc) {
        sendHtml(res, 503, signInNotConfiguredPage());
        return;
      }
      const redirectUri = `${effectiveBase(req)}/auth/google/callback`;
      const { url: authUrl } = await oidc.buildAuthorizationUrl(redirectUri);
      redirect(res, authUrl);
      return;
    }
    if (method === 'GET' && path === '/auth/google/callback') {
      if (!oidc) {
        sendHtml(res, 503, signInNotConfiguredPage());
        return;
      }
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const providerError = url.searchParams.get('error');
      if (providerError || !code || !state) {
        sendHtml(res, 400, simpleMessagePage('Sign-in did not complete', 'Google sign-in was cancelled or returned an error. Nothing was changed on your account.'));
        return;
      }
      try {
        const claims = await oidc.handleCallback(code, state);
        const account = store.upsertAccount({
          sub: claims.sub,
          email: typeof claims.email === 'string' ? claims.email : '',
          name: typeof claims.name === 'string' ? claims.name : 'KriyaDot user',
          picture: typeof claims.picture === 'string' ? claims.picture : undefined,
        });
        const token = randomBytes(32).toString('base64url');
        store.createSession(hashToken(token), account.id);
        const secure = effectiveBase(req).startsWith('https://');
        const cookie =
          `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}` +
          (secure ? '; Secure' : '');
        redirect(res, '/app', { 'set-cookie': cookie });
      } catch (err) {
        log(`[frontdoor] sign-in callback failed: ${err instanceof Error ? err.message : String(err)}`);
        sendHtml(res, 400, simpleMessagePage('Sign-in failed', 'We could not verify that sign-in. Please try again — if it keeps failing, the desktop app still works without this site.'));
      }
      return;
    }
    if (method === 'POST' && path === '/api/logout') {
      const token = parseCookies(req)[SESSION_COOKIE];
      if (token) store.deleteSession(hashToken(token));
      sendJson(res, 200, { ok: true });
      return;
    }

    // ---- registry register (code-guarded, no session) ----------------------
    if (method === 'POST' && path === '/api/registry/register') {
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'invalid-body' });
        return;
      }
      const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
      const rawInstanceUrl = typeof body.instanceUrl === 'string' ? body.instanceUrl.trim() : '';
      const linkCode = code ? store.getLinkCode(code) : undefined;
      if (!linkCode) {
        sendJson(res, 400, { error: 'invalid-code', message: 'That link code does not exist.' });
        return;
      }
      if (linkCode.usedAt) {
        sendJson(res, 400, { error: 'code-used', message: 'That link code was already used. Generate a fresh one.' });
        return;
      }
      if (Date.parse(linkCode.expiresAt) <= Date.now()) {
        sendJson(res, 400, { error: 'code-expired', message: 'That link code has expired. Generate a fresh one.' });
        return;
      }
      let instanceUrl: string;
      try {
        const parsed = new URL(rawInstanceUrl);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('bad protocol');
        instanceUrl = rawInstanceUrl.replace(/\/+$/, '');
      } catch {
        sendJson(res, 400, { error: 'invalid-instance-url', message: 'instanceUrl must be an http(s) URL.' });
        return;
      }
      // Single-use: burn the code on any validated registration attempt.
      store.burnLinkCode(code);
      const existing = store.findWorkspace(linkCode.accountId, instanceUrl);
      if (existing) {
        sendJson(res, 200, { workspaceId: existing.id, accountId: existing.accountId });
        return;
      }
      let defaultName = instanceUrl;
      try {
        defaultName = new URL(instanceUrl).host;
      } catch {
        /* keep raw */
      }
      const workspace = store.addWorkspace({
        accountId: linkCode.accountId,
        name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : defaultName,
        instanceUrl,
        tier: typeof body.tier === 'string' && body.tier.trim() ? body.tier.trim() : undefined,
      });
      sendJson(res, 201, { workspaceId: workspace.id, accountId: workspace.accountId });
      return;
    }

    // ---- session-guarded JSON APIs -----------------------------------------
    if (path === '/api/me' && method === 'GET') {
      const account = requireAccount(req, res);
      if (!account) return;
      sendJson(res, 200, {
        id: account.id,
        email: account.email,
        name: account.name,
        ...(account.picture ? { picture: account.picture } : {}),
        createdAt: account.createdAt,
        lastLoginAt: account.lastLoginAt,
      });
      return;
    }

    if (path === '/api/workspaces' && method === 'GET') {
      const account = requireAccount(req, res);
      if (!account) return;
      const mine = store.listWorkspaces(account.id);
      const withStatus = await Promise.all(
        mine.map(async (w: Workspace) => ({
          id: w.id,
          name: w.name,
          instanceUrl: w.instanceUrl,
          ...(w.tier ? { tier: w.tier } : {}),
          createdAt: w.createdAt,
          status: await probeWorkspace(w.instanceUrl),
        })),
      );
      sendJson(res, 200, { workspaces: withStatus });
      return;
    }

    const removeMatch = path.match(/^\/api\/workspaces\/([^/]+)\/remove$/);
    if (removeMatch && method === 'POST') {
      const account = requireAccount(req, res);
      if (!account) return;
      const removed = store.removeWorkspace(decodeURIComponent(removeMatch[1]!), account.id);
      if (!removed) {
        sendJson(res, 404, { error: 'not-found' });
        return;
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (path === '/api/link-codes' && method === 'POST') {
      const account = requireAccount(req, res);
      if (!account) return;
      const code = generateLinkCode();
      const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MS).toISOString();
      store.addLinkCode({ code, accountId: account.id, expiresAt });
      sendJson(res, 201, { code, expiresAt });
      return;
    }

    if (path === '/api/handoff' && method === 'POST') {
      const account = requireAccount(req, res);
      if (!account) return;
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'invalid-body' });
        return;
      }
      const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : '';
      const workspace = workspaceId ? store.getWorkspace(workspaceId) : undefined;
      if (!workspace || workspace.accountId !== account.id) {
        sendJson(res, 404, { error: 'workspace-not-found' });
        return;
      }
      const minted = mintHandoffToken(handoffKeys, {
        accountId: account.id,
        email: account.email,
        name: account.name,
        instanceUrl: workspace.instanceUrl,
      });
      sendJson(res, 200, {
        redirectUrl: `${workspace.instanceUrl.replace(/\/+$/, '')}/handoff#t=${minted.token}`,
        expiresAt: minted.expiresAt,
      });
      return;
    }

    if (path === '/api/lightning' && method === 'GET') {
      const account = requireAccount(req, res);
      if (!account) return;
      sendJson(res, 200, {
        pricingUrl: 'https://lightning.ai/pricing',
        billingUrl: 'https://lightning.ai/',
        tiers: [{ name: 'Free' }, { name: 'Pro' }, { name: 'Teams' }, { name: 'Enterprise' }],
        workspaces: store.listWorkspaces(account.id).map((w) => ({
          name: w.name,
          tierReportedByInstance: w.tier ?? null,
        })),
      });
      return;
    }

    if (path === '/api/plan' && method === 'GET') {
      const account = requireAccount(req, res);
      if (!account) return;
      sendJson(res, 200, {
        gatingEnabled: false,
        platform: 'Open source — Apache-2.0',
        note: 'License gating is not enabled on KriyaDot. The desktop app is free and open source; cloud plans are between you and Lightning.',
      });
      return;
    }

    if (path === '/api/changelog' && method === 'GET') {
      const account = requireAccount(req, res);
      if (!account) return;
      if (changelogCache && Date.now() - changelogCache.at < CHANGELOG_TTL_MS) {
        sendJson(res, 200, { releases: changelogCache.releases });
        return;
      }
      try {
        const ghRes = await fetchFn(CHANGELOG_URL, {
          headers: { accept: 'application/vnd.github+json', 'user-agent': 'kriyadot-frontdoor' },
        });
        if (!ghRes.ok) throw new Error(`GitHub releases HTTP ${ghRes.status}`);
        const raw = (await ghRes.json()) as Array<Record<string, unknown>>;
        const releases = raw.map((r) => ({
          tag: r.tag_name,
          name: r.name ?? r.tag_name,
          publishedAt: r.published_at,
          url: r.html_url,
          notesExcerpt: String(r.body ?? '').slice(0, 280),
        }));
        changelogCache = { at: Date.now(), releases };
        sendJson(res, 200, { releases });
      } catch {
        sendJson(res, 200, { releases: [] });
      }
      return;
    }

    if (path.startsWith('/api/')) {
      sendJson(res, 404, { error: 'not-found' });
      return;
    }

    // ---- frontdoor-owned static assets --------------------------------------
    if (method === 'GET' && path.startsWith('/frontdoor-assets/')) {
      if (serveFile(res, publicRoot, path.slice('/frontdoor-assets'.length), false)) return;
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }

    // ---- app shell pages (session required) ----------------------------------
    const appPages: Record<string, () => string> = {
      '/app': dashboardPage,
      '/app/chat': chatPage,
      '/app/lightning': lightningPage,
      '/app/plan': planPage,
      '/app/whats-new': whatsNewPage,
    };
    if (method === 'GET' && appPages[path]) {
      const account = sessionAccount(req);
      if (!account) {
        redirect(res, '/');
        return;
      }
      sendHtml(res, 200, appPages[path]!());
      return;
    }

    // ---- landing site (static) ------------------------------------------------
    if (method === 'GET' || method === 'HEAD') {
      if (serveFile(res, siteRoot, path === '/' ? '/index.html' : path, path === '/')) return;
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }

    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('method not allowed');
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      log(`[frontdoor] request failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal-error' });
      else res.end();
    });
  });

  return { server, store, handoffKeys, oidc, config };
}

/** Convenience factory returning just the http.Server (tests listen on port 0). */
export function createFrontdoorServer(config: FrontdoorConfig): Server {
  return createFrontdoor(config).server;
}
