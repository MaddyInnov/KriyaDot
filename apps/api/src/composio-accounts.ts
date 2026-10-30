// SPDX-License-Identifier: Apache-2.0
// Composio connected accounts (OpenMausBot parity P0 #2): per-service OAuth
// connections (e.g. two Gmail accounts) that bots can act through.
//
// A connected account is a single user's authorized connection to one
// toolkit. Composio stores and refreshes the OAuth tokens — KriyaDot never
// sees them. The Connect Link flow is:
//
//   POST /composio/accounts/link { toolkitSlug, label? }
//     → { redirectUrl }          (user opens it, signs in at the provider)
//   GET  /composio/accounts      (poll: the new account appears here)
//     → { connected, accounts: [...], pending: [...] }
//
// Local state (per user, <dataDir>):
//   composio-accounts[.user].json       — cache + labels, keyed by nanoid
//   composio-pending-links[.user].json  — in-flight connect flows; when a
//                                         new account for the toolkit shows
//                                         up, the pending label is applied
//                                         automatically and the entry is
//                                         consumed.
//
// Security: the Composio API key stays in the encrypted vault (server-side
// only). No route returns credentials. Disconnect revokes the provider
// grant (best-effort) and deletes the Composio record.

import express from 'express';
import type { Request, Response } from 'express';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ComposioClient,
  ComposioConnectedAccount,
  ComposioDeps,
} from './composio.js';
import {
  composioCallerOf,
  composioEntityId,
  fetchComposioClient,
  getComposioApiKey,
  readComposioEnables,
} from './composio.js';
import { principalMiddleware, type PrincipalContext } from './principal.js';

export interface AccountRecord {
  toolkitSlug: string;
  toolkitName?: string;
  status: string;
  /** User label, e.g. "work Gmail". */
  label?: string;
  firstSeenAt: number;
  updatedAt: number;
}

export interface PendingLink {
  toolkitSlug: string;
  label?: string;
  requestedAt: number;
  /** Account ids already known when the link was created. */
  seenIds: string[];
}

/** Pending links expire after 30 minutes (abandoned flows are cleaned up). */
export const PENDING_LINK_TTL_MS = 30 * 60 * 1000;

function sanitizeUser(ns: string): string {
  return ns.toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 64) || 'user';
}

function accountsPath(dataDir: string, userId: string): string {
  const suffix = userId === 'default-user' ? '' : `.${sanitizeUser(userId)}`;
  return join(dataDir, `composio-accounts${suffix}.json`);
}

function pendingPath(dataDir: string, userId: string): string {
  const suffix = userId === 'default-user' ? '' : `.${sanitizeUser(userId)}`;
  return join(dataDir, `composio-pending-links${suffix}.json`);
}

function readJsonFile<T>(path: string, fallback: T): T {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as T;
  } catch {
    // Missing or corrupt → fallback (never 500).
  }
  return fallback;
}

function writeJsonFile(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 });
}

export function readAccountCache(dataDir: string, userId: string): Record<string, AccountRecord> {
  return readJsonFile<Record<string, AccountRecord>>(accountsPath(dataDir, userId), {});
}

export function writeAccountCache(
  dataDir: string,
  userId: string,
  cache: Record<string, AccountRecord>,
): void {
  writeJsonFile(accountsPath(dataDir, userId), cache);
}

export function readPendingLinks(dataDir: string, userId: string): PendingLink[] {
  const links = readJsonFile<PendingLink[]>(pendingPath(dataDir, userId), []);
  return Array.isArray(links) ? links : [];
}

export function writePendingLinks(dataDir: string, userId: string, links: PendingLink[]): void {
  writeJsonFile(pendingPath(dataDir, userId), links);
}

const NANOID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TOOLKIT_RE = /^[a-z0-9_-]{1,64}$/;

function errorBody(error: string, detail?: string): { error: string; detail?: string } {
  return detail ? { error, detail } : { error };
}

/** Public account shape returned by GET /composio/accounts. */
export interface AccountView {
  id: string;
  toolkitSlug: string;
  toolkitName?: string;
  status: string;
  label?: string;
  connectedAt?: string;
}

/**
 * Resolve one account for tool execution: local cache first (fast), live
 * Composio lookup on a cache miss (also refreshes the cache). Returns null
 * when the account does not exist.
 */
export async function resolveAccount(
  dataDir: string,
  userId: string,
  client: ComposioClient,
  apiKey: string,
  accountId: string,
): Promise<AccountRecord & { id: string } | null> {
  const cache = readAccountCache(dataDir, userId);
  const cached = cache[accountId];
  if (cached) return { ...cached, id: accountId };
  let live: ComposioConnectedAccount | null = null;
  try {
    live = await client.getConnectedAccount(apiKey, accountId);
  } catch {
    return null;
  }
  if (!live) return null;
  const now = Date.now();
  const record: AccountRecord = {
    toolkitSlug: live.toolkitSlug,
    toolkitName: live.toolkitName,
    status: live.status,
    firstSeenAt: now,
    updatedAt: now,
  };
  cache[accountId] = record;
  try {
    writeAccountCache(dataDir, userId, cache);
  } catch {
    // Non-fatal.
  }
  return { ...record, id: accountId };
}

export function registerComposioAccountRoutes(router: express.Router, deps: ComposioDeps): void {
  const { config, governance, bots } = deps;
  // Injected in tests; the real fetch client in production (zero paid API
  // usage in tests — same contract as registerComposioRoutes).
  const client: ComposioClient = deps.composioClient ?? fetchComposioClient;
  const pctx: PrincipalContext = { dataDir: config.dataDir, loopbackToken: deps.loopbackToken };
  const r = express.Router();
  r.use(principalMiddleware(pctx));

  // The verified principal's user id (OPEN-1); never null behind the guard.
  const callerOf = (req: Request): string => {
    const userId = composioCallerOf(req, pctx);
    if (!userId) throw new Error('unauthenticated');
    return userId;
  };

  const apiKeyOf = (req: Request): string | undefined =>
    getComposioApiKey(config.dataDir, callerOf(req));

  // POST /composio/accounts/link — start a Connect Link flow for one toolkit.
  // Returns the hosted sign-in URL; the account appears in GET /accounts
  // once the user completes OAuth at the provider.
  r.post('/accounts/link', async (req: Request, res: Response) => {
    const apiKey = apiKeyOf(req);
    if (!apiKey) {
      res
        .status(400)
        .json({ ...errorBody('Composio is not connected — connect an API key first') });
      return;
    }
    const body = (req.body ?? {}) as { toolkitSlug?: unknown; label?: unknown };
    const toolkitSlug =
      typeof body.toolkitSlug === 'string' ? body.toolkitSlug.trim().toLowerCase() : '';
    if (!TOOLKIT_RE.test(toolkitSlug)) {
      res.status(400).json(errorBody('toolkitSlug is required (lowercase letters, digits, _ -)'));
      return;
    }
    const label = typeof body.label === 'string' ? body.label.trim().slice(0, 64) : '';
    const userId = callerOf(req);
    let redirectUrl: string;
    try {
      ({ redirectUrl } = await client.createAuthLink(apiKey, {
        toolkitSlug,
        userId: composioEntityId(userId),
        label: label || undefined,
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(502).json(errorBody('Could not create the Composio auth link', message));
      return;
    }
    // Remember the in-flight flow: known account ids now, so a *new* one
    // for this toolkit can be detected (and labeled) on the next list.
    let seenIds: string[] = [];
    try {
      const existing = await client.listConnectedAccounts(apiKey, composioEntityId(userId));
      seenIds = existing.map((a) => a.id);
    } catch {
      // Non-fatal: without a baseline, any account for the toolkit created
      // after requestedAt still matches.
    }
    const pending = readPendingLinks(config.dataDir, userId).filter(
      (p) => Date.now() - p.requestedAt < PENDING_LINK_TTL_MS,
    );
    pending.push({
      toolkitSlug,
      label: label || undefined,
      requestedAt: Date.now(),
      seenIds,
    });
    try {
      writePendingLinks(config.dataDir, userId, pending);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json(errorBody('Failed to persist the pending link', message));
      return;
    }
    governance.audit('composio.account_link_started', {
      actor: userId,
      toolName: 'composio',
      detail: { toolkitSlug },
    });
    res.json({ redirectUrl });
  });

  // GET /composio/accounts — merged live + cached account list. Consumes
  // pending links whose account has appeared (auto-applying their labels).
  r.get('/accounts', async (req: Request, res: Response) => {
    const apiKey = apiKeyOf(req);
    if (!apiKey) {
      res.json({ connected: false, accounts: [] as AccountView[], pending: [] as PendingLink[] });
      return;
    }
    const userId = callerOf(req);
    let live: ComposioConnectedAccount[];
    try {
      live = await client.listConnectedAccounts(apiKey, composioEntityId(userId));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res
        .status(502)
        .json({ connected: true, accounts: [] as AccountView[], pending: [] as PendingLink[], ...errorBody('Could not reach the Composio API', message) });
      return;
    }
    const now = Date.now();
    const cache = readAccountCache(config.dataDir, userId);
    const liveIds = new Set(live.map((a) => a.id));
    // Refresh the cache from live data (labels survive).
    for (const a of live) {
      const prev = cache[a.id];
      cache[a.id] = {
        toolkitSlug: a.toolkitSlug,
        toolkitName: a.toolkitName ?? prev?.toolkitName,
        status: a.status,
        label: prev?.label,
        firstSeenAt: prev?.firstSeenAt ?? now,
        updatedAt: now,
      };
    }
    // Drop cache entries for accounts deleted outside KriyaDot.
    for (const id of Object.keys(cache)) {
      if (!liveIds.has(id)) delete cache[id];
    }
    // Consume pending links: a live account for the toolkit that was not
    // known at link time (and appeared after the request) gets the label.
    const pending = readPendingLinks(config.dataDir, userId).filter(
      (p) => now - p.requestedAt < PENDING_LINK_TTL_MS,
    );
    const remaining: PendingLink[] = [];
    for (const p of pending) {
      const match = live.find(
        (a) =>
          a.toolkitSlug === p.toolkitSlug &&
          !p.seenIds.includes(a.id) &&
          (cache[a.id]?.firstSeenAt ?? 0) >= p.requestedAt - 60_000,
      );
      if (match && p.label) {
        cache[match.id] = { ...cache[match.id], label: p.label, updatedAt: now };
        governance.audit('composio.account_connected', {
          actor: userId,
          toolName: 'composio',
          detail: { accountId: match.id, toolkitSlug: match.toolkitSlug },
        });
      } else if (match) {
        governance.audit('composio.account_connected', {
          actor: userId,
          toolName: 'composio',
          detail: { accountId: match.id, toolkitSlug: match.toolkitSlug },
        });
      } else {
        remaining.push(p);
      }
    }
    try {
      writeAccountCache(config.dataDir, userId, cache);
      writePendingLinks(config.dataDir, userId, remaining);
    } catch {
      // Cache write failure is non-fatal for the read path.
    }
    const accounts: AccountView[] = live.map((a) => ({
      id: a.id,
      toolkitSlug: a.toolkitSlug,
      toolkitName: a.toolkitName,
      status: a.status,
      label: cache[a.id]?.label,
      connectedAt: a.createdAt,
    }));
    res.json({ connected: true, accounts, pending: remaining });
  });

  // POST /composio/accounts/:id/label — rename an account (local label).
  r.post('/accounts/:id/label', async (req: Request, res: Response) => {
    const apiKey = apiKeyOf(req);
    if (!apiKey) {
      res.status(400).json(errorBody('Composio is not connected — connect an API key first'));
      return;
    }
    const id = req.params.id;
    if (!NANOID_RE.test(id)) {
      res.status(400).json(errorBody('invalid account id'));
      return;
    }
    const label = ((req.body ?? {}) as { label?: unknown }).label;
    if (typeof label !== 'string' || !label.trim() || label.trim().length > 64) {
      res.status(400).json(errorBody('label is required (1-64 chars)'));
      return;
    }
    const userId = callerOf(req);
    const cache = readAccountCache(config.dataDir, userId);
    if (!cache[id]) {
      // Validate against live data before labeling a ghost.
      let live: ComposioConnectedAccount | null = null;
      try {
        live = await client.getConnectedAccount(apiKey, id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(502).json(errorBody('Could not reach the Composio API', message));
        return;
      }
      if (!live) {
        res.status(404).json(errorBody(`unknown Composio account: ${id}`));
        return;
      }
      const now = Date.now();
      cache[id] = {
        toolkitSlug: live.toolkitSlug,
        toolkitName: live.toolkitName,
        status: live.status,
        firstSeenAt: now,
        updatedAt: now,
      };
    }
    cache[id] = { ...cache[id], label: label.trim(), updatedAt: Date.now() };
    try {
      writeAccountCache(config.dataDir, userId, cache);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json(errorBody('Failed to persist the label', message));
      return;
    }
    res.json({ ok: true, id, label: label.trim() });
  });

  // DELETE /composio/accounts/:id — revoke the provider grant and delete
  // the account (idempotent).
  r.delete('/accounts/:id', async (req: Request, res: Response) => {
    const apiKey = apiKeyOf(req);
    if (!apiKey) {
      res.status(400).json(errorBody('Composio is not connected — connect an API key first'));
      return;
    }
    const id = req.params.id;
    if (!NANOID_RE.test(id)) {
      res.status(400).json(errorBody('invalid account id'));
      return;
    }
    const userId = callerOf(req);
    try {
      await client.deleteConnectedAccount(apiKey, id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(502).json(errorBody('Could not delete the Composio account', message));
      return;
    }
    const cache = readAccountCache(config.dataDir, userId);
    delete cache[id];
    try {
      writeAccountCache(config.dataDir, userId, cache);
    } catch {
      // Non-fatal: the Composio record is already gone.
    }
    governance.audit('composio.account_disconnected', {
      actor: userId,
      toolName: 'composio',
      detail: { accountId: id },
    });
    res.json({ ok: true, id });
  });

  // GET /composio/accounts/:id/tools[?botId=] — actions available on one
  // account. With ?botId=, the account's toolkit must be enabled for that
  // bot (403 otherwise) — the per-bot gate, applied at presentation too.
  r.get('/accounts/:id/tools', async (req: Request, res: Response) => {
    const apiKey = apiKeyOf(req);
    if (!apiKey) {
      res.status(400).json(errorBody('Composio is not connected — connect an API key first'));
      return;
    }
    const id = req.params.id;
    if (!NANOID_RE.test(id)) {
      res.status(400).json(errorBody('invalid account id'));
      return;
    }
    const userId = callerOf(req);
    let account: ComposioConnectedAccount | null = null;
    const cached = readAccountCache(config.dataDir, userId)[id];
    if (cached) {
      account = { id, toolkitSlug: cached.toolkitSlug, toolkitName: cached.toolkitName, status: cached.status };
    } else {
      try {
        account = await client.getConnectedAccount(apiKey, id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(502).json(errorBody('Could not reach the Composio API', message));
        return;
      }
    }
    if (!account) {
      res.status(404).json(errorBody(`unknown Composio account: ${id}`));
      return;
    }
    const botId = typeof req.query.botId === 'string' ? req.query.botId : undefined;
    if (botId) {
      const bot = bots.find((b) => b.id === botId);
      if (!bot) {
        res.status(404).json(errorBody(`unknown bot: ${botId}`));
        return;
      }
      const enabled = readComposioEnables(config.dataDir, userId)[botId]?.[account.toolkitSlug] === true;
      if (!enabled) {
        res
          .status(403)
          .json(errorBody(`app "${account.toolkitSlug}" is not enabled for bot "${botId}"`));
        return;
      }
    }
    let tools;
    try {
      tools = await client.listTools(apiKey, account.toolkitSlug);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(502).json(errorBody('Could not reach the Composio API', message));
      return;
    }
    res.json({
      account: {
        id: account.id,
        toolkitSlug: account.toolkitSlug,
        toolkitName: account.toolkitName,
        status: account.status,
        label: cached?.label,
      },
      tools: tools.map((t) => ({
        slug: t.slug,
        name: t.name,
        description: t.description?.slice(0, 300),
        parameters: t.inputParameters,
      })),
    });
  });

  router.use('/composio', r);
}
