// SPDX-License-Identifier: Apache-2.0
// First-party Google Workspace connectors (Muse parity audit §4.12:
// CN-3): Gmail + Calendar + Drive as KriyaDot's OWN bot tools, built on
// the existing OAuth framework (oauth.ts) instead of routing the core
// Google suite through Composio. This reduces Composio dependence for
// the three apps most users connect first; Composio remains the
// long-tail catalog for everything else.
//
// What exists here:
//   registerGoogleWorkspaceProvider()  re-registers the 'google' OAuth
//     provider with the FULL core-suite scope set (the shipped preset in
//     oauth.ts carries only gmail.readonly + calendar.readonly; the core
//     suite adds gmail.send, calendar.events and drive.readonly). Host
//     calls this once at boot BEFORE registerOAuthRoutes serves a
//     connect flow. Least privilege per tool is still enforced by the
//     tool set itself: no delete/trash tool exists at all.
//   createGoogleWorkspaceTools()       six agent tools:
//       google_gmail_search   (read)   google_gmail_read    (read)
//       google_gmail_send     (WRITE — mutating, approval-gated)
//       google_calendar_list  (read)   google_calendar_create (WRITE)
//       google_drive_search   (read)   google_drive_read    (read, metadata)
//   googleWorkspaceToolPolicies()      governance rules: reads allow,
//     writes require-approval (same pattern as composioToolPolicies).
//   registerGoogleWorkspaceRoutes()    GET /google-workspace/status —
//     honest status: whether founder OAuth credentials are configured,
//     whether a user token is connected, the scope set, and
//     `liveVerified: false`.
//
// ENV-GATED, HONESTLY: the OAuth credential flow needs the founder's
// Google OAuth client (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET,
// env or the encrypted provider store via providers.ts). Those
// credentials are NOT available to this build and are NEVER invented:
// without them the status route says so, the connect flow in oauth.ts
// fails with its existing clear error, and every tool fails closed with
// "not connected / not configured". All tests run against a mock
// GoogleWorkspaceClient (or a stubbed fetch + stubbed token getter) —
// zero live Google calls.
//
// Token handling: tools resolve a valid access token SERVER-SIDE per
// call via getValidToken('google', dataDir) (oauth.ts — auto-refresh).
// The token never appears in tool args, results, logs or audit detail.

import express from 'express';
import type { Request, Response } from 'express';
import type { BotPolicyRule, ToolDefinition } from '@mvp/agent-runtime';
import {
  getOAuthStatus,
  getValidToken,
  registerOAuthProvider,
} from './oauth.js';
import { syncProviderKeysToEnv } from './providers.js';

// ---------------------------------------------------------------------------
// Provider registration (core-suite scopes)
// ---------------------------------------------------------------------------

export const GOOGLE_PROVIDER_ID = 'google';
export const GOOGLE_CLIENT_ID_ENV = 'GOOGLE_OAUTH_CLIENT_ID';
export const GOOGLE_CLIENT_SECRET_ENV = 'GOOGLE_OAUTH_CLIENT_SECRET';

/** Least-privilege scope set for the core suite (no delete scopes exist). */
export const GOOGLE_WORKSPACE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/drive.readonly',
] as const;

/**
 * Re-register the 'google' OAuth provider with the core-suite scopes.
 * Idempotent; the host calls it once at boot. Until it is called, the
 * oauth.ts preset (read-only Gmail + Calendar) remains in force.
 */
export function registerGoogleWorkspaceProvider(): void {
  registerOAuthProvider({
    id: GOOGLE_PROVIDER_ID,
    name: 'Google Workspace (Gmail, Calendar, Drive)',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: [...GOOGLE_WORKSPACE_SCOPES],
    clientIdEnv: GOOGLE_CLIENT_ID_ENV,
    clientSecretEnv: GOOGLE_CLIENT_SECRET_ENV,
  });
}

export interface GoogleWorkspaceConfigStatus {
  /** True when an OAuth client id + secret are visible (env or encrypted store). */
  credentialsConfigured: boolean;
  /** Env var names still missing (never values). */
  missingEnv: string[];
}

/**
 * Whether the founder OAuth credentials exist. Mirrors oauth.ts's own
 * resolution: stored keys are bridged into env by syncProviderKeysToEnv,
 * real env vars always win. `env` is injectable for tests.
 */
export function googleWorkspaceConfigStatus(
  dataDir: string,
  env: Record<string, string | undefined> = process.env,
): GoogleWorkspaceConfigStatus {
  if (env === process.env) {
    try {
      syncProviderKeysToEnv(dataDir);
    } catch {
      // A broken store must not break the status answer.
    }
  }
  const missingEnv: string[] = [];
  if (!env[GOOGLE_CLIENT_ID_ENV]?.trim()) missingEnv.push(GOOGLE_CLIENT_ID_ENV);
  if (!env[GOOGLE_CLIENT_SECRET_ENV]?.trim()) missingEnv.push(GOOGLE_CLIENT_SECRET_ENV);
  return { credentialsConfigured: missingEnv.length === 0, missingEnv };
}

// ---------------------------------------------------------------------------
// Google API client (interface + production fetch implementation)
// ---------------------------------------------------------------------------

export interface GmailMessageSummary {
  id: string;
  threadId?: string;
  snippet?: string;
  from?: string;
  subject?: string;
  date?: string;
}

export interface GmailMessage extends GmailMessageSummary {
  to?: string;
  bodyText?: string;
}

export interface CalendarEvent {
  id?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: string;
  end?: string;
  htmlLink?: string;
}

export interface DriveFile {
  id: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string;
  size?: string;
  webViewLink?: string;
  owners?: string[];
}

/**
 * Thin facade over the Gmail / Calendar / Drive REST APIs. Behind an
 * interface so tests inject a deterministic mock — the real client is
 * never used in tests (zero live Google calls).
 */
export interface GoogleWorkspaceClient {
  listMessages(accessToken: string, query: string, maxResults: number): Promise<GmailMessageSummary[]>;
  getMessage(accessToken: string, messageId: string): Promise<GmailMessage>;
  sendMessage(accessToken: string, input: { to: string; subject: string; body: string }): Promise<{ id: string }>;
  listEvents(
    accessToken: string,
    opts: { timeMin?: string; timeMax?: string; maxResults: number },
  ): Promise<CalendarEvent[]>;
  createEvent(accessToken: string, event: CalendarEvent & { summary: string; start: string; end: string }): Promise<CalendarEvent>;
  listFiles(accessToken: string, query: string, maxResults: number): Promise<DriveFile[]>;
  getFile(accessToken: string, fileId: string): Promise<DriveFile>;
}

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3/calendars/primary';
const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';

async function googleFetch(
  fetchFn: typeof fetch,
  accessToken: string,
  url: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Record<string, unknown>> {
  const res = await fetchFn(url, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(20_000) : undefined,
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const errObj = (body.error ?? {}) as { message?: string; status?: string };
    throw new Error(
      `Google API request failed (HTTP ${res.status})${errObj.message ? `: ${errObj.message.slice(0, 200)}` : ''}`,
    );
  }
  return body;
}

function headerOf(headers: unknown, name: string): string | undefined {
  if (!Array.isArray(headers)) return undefined;
  for (const h of headers as Array<{ name?: string; value?: string }>) {
    if (h?.name?.toLowerCase() === name.toLowerCase() && typeof h.value === 'string') return h.value;
  }
  return undefined;
}

function summaryOf(raw: Record<string, unknown>): GmailMessageSummary {
  const payload = (raw.payload ?? {}) as { headers?: unknown };
  return {
    id: String(raw.id ?? ''),
    threadId: typeof raw.threadId === 'string' ? raw.threadId : undefined,
    snippet: typeof raw.snippet === 'string' ? raw.snippet : undefined,
    from: headerOf(payload.headers, 'From'),
    subject: headerOf(payload.headers, 'Subject'),
    date: headerOf(payload.headers, 'Date'),
  };
}

/** Best-effort plain-text body extraction from a Gmail payload tree. */
function extractBodyText(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const p = payload as { mimeType?: string; body?: { data?: string }; parts?: unknown[] };
  if (p.mimeType === 'text/plain' && typeof p.body?.data === 'string') {
    try {
      return Buffer.from(p.body.data, 'base64url').toString('utf8');
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(p.parts)) {
    for (const part of p.parts) {
      const text = extractBodyText(part);
      if (text) return text;
    }
  }
  return undefined;
}

function eventOf(raw: Record<string, unknown>): CalendarEvent {
  const when = (v: unknown): string | undefined => {
    const o = (v ?? {}) as { dateTime?: string; date?: string };
    return o.dateTime ?? o.date;
  };
  return {
    id: typeof raw.id === 'string' ? raw.id : undefined,
    summary: typeof raw.summary === 'string' ? raw.summary : undefined,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    location: typeof raw.location === 'string' ? raw.location : undefined,
    start: when(raw.start),
    end: when(raw.end),
    htmlLink: typeof raw.htmlLink === 'string' ? raw.htmlLink : undefined,
  };
}

function fileOf(raw: Record<string, unknown>): DriveFile {
  const owners = Array.isArray(raw.owners)
    ? (raw.owners as Array<{ displayName?: string }>).map((o) => o.displayName).filter((n): n is string => !!n)
    : undefined;
  return {
    id: String(raw.id ?? ''),
    name: typeof raw.name === 'string' ? raw.name : undefined,
    mimeType: typeof raw.mimeType === 'string' ? raw.mimeType : undefined,
    modifiedTime: typeof raw.modifiedTime === 'string' ? raw.modifiedTime : undefined,
    size: typeof raw.size === 'string' ? raw.size : undefined,
    webViewLink: typeof raw.webViewLink === 'string' ? raw.webViewLink : undefined,
    owners,
  };
}

/** Production client: real HTTPS to Google APIs. Never used in tests. */
export function createFetchGoogleWorkspaceClient(fetchFn: typeof fetch = fetch): GoogleWorkspaceClient {
  return {
    async listMessages(accessToken, query, maxResults) {
      const params = new URLSearchParams({ maxResults: String(maxResults) });
      if (query) params.set('q', query);
      const list = await googleFetch(fetchFn, accessToken, `${GMAIL_BASE}/messages?${params}`);
      const refs = Array.isArray(list.messages) ? (list.messages as Array<{ id?: string }>) : [];
      const out: GmailMessageSummary[] = [];
      for (const ref of refs.slice(0, maxResults)) {
        if (!ref.id) continue;
        const raw = await googleFetch(
          fetchFn,
          accessToken,
          `${GMAIL_BASE}/messages/${encodeURIComponent(ref.id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
        );
        out.push(summaryOf(raw));
      }
      return out;
    },
    async getMessage(accessToken, messageId) {
      const raw = await googleFetch(fetchFn, accessToken, `${GMAIL_BASE}/messages/${encodeURIComponent(messageId)}?format=full`);
      const payload = (raw.payload ?? {}) as { headers?: unknown };
      return {
        ...summaryOf(raw),
        to: headerOf(payload.headers, 'To'),
        bodyText: extractBodyText(raw.payload)?.slice(0, 20_000),
      };
    },
    async sendMessage(accessToken, input) {
      const raw822 = [
        `To: ${input.to}`,
        `Subject: ${input.subject}`,
        'Content-Type: text/plain; charset="UTF-8"',
        '',
        input.body,
      ].join('\r\n');
      const body = await googleFetch(fetchFn, accessToken, `${GMAIL_BASE}/messages/send`, {
        method: 'POST',
        body: { raw: Buffer.from(raw822, 'utf8').toString('base64url') },
      });
      return { id: String(body.id ?? '') };
    },
    async listEvents(accessToken, opts) {
      const params = new URLSearchParams({
        maxResults: String(opts.maxResults),
        singleEvents: 'true',
        orderBy: 'startTime',
        timeMin: opts.timeMin ?? new Date().toISOString(),
      });
      if (opts.timeMax) params.set('timeMax', opts.timeMax);
      const body = await googleFetch(fetchFn, accessToken, `${CALENDAR_BASE}/events?${params}`);
      const items = Array.isArray(body.items) ? (body.items as Array<Record<string, unknown>>) : [];
      return items.map(eventOf);
    },
    async createEvent(accessToken, event) {
      const body = await googleFetch(fetchFn, accessToken, `${CALENDAR_BASE}/events`, {
        method: 'POST',
        body: {
          summary: event.summary,
          ...(event.description ? { description: event.description } : {}),
          ...(event.location ? { location: event.location } : {}),
          start: { dateTime: event.start },
          end: { dateTime: event.end },
        },
      });
      return eventOf(body);
    },
    async listFiles(accessToken, query, maxResults) {
      const params = new URLSearchParams({
        pageSize: String(maxResults),
        fields: 'files(id,name,mimeType,modifiedTime,size,webViewLink,owners/displayName)',
        orderBy: 'modifiedTime desc',
      });
      if (query) params.set('q', `name contains '${query.replace(/'/g, "\\'")}'`);
      const body = await googleFetch(fetchFn, accessToken, `${DRIVE_BASE}/files?${params}`);
      const items = Array.isArray(body.files) ? (body.files as Array<Record<string, unknown>>) : [];
      return items.map(fileOf);
    },
    async getFile(accessToken, fileId) {
      const body = await googleFetch(
        fetchFn,
        accessToken,
        `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,modifiedTime,size,webViewLink,owners/displayName`,
      );
      return fileOf(body);
    },
  };
}

// ---------------------------------------------------------------------------
// Agent tools
// ---------------------------------------------------------------------------

export const GOOGLE_TOOL_NAMES = [
  'google_gmail_search',
  'google_gmail_read',
  'google_gmail_send',
  'google_calendar_list',
  'google_calendar_create',
  'google_drive_search',
  'google_drive_read',
] as const;

/**
 * Governance rules the host installs (prepended, first match wins — same
 * pattern as composioToolPolicies): reads are metadata/content reads over
 * the user's OWN account → allow; writes leave the machine → approval.
 */
export function googleWorkspaceToolPolicies(): BotPolicyRule[] {
  return [
    {
      id: 'google-workspace-reads-allow',
      toolPattern: '^(google_gmail_search|google_gmail_read|google_calendar_list|google_drive_search|google_drive_read)$',
      effect: 'allow',
      reason: 'Read-only access to the user\u2019s own Google Workspace data via their connected account.',
    },
    {
      id: 'google-workspace-writes-approval',
      toolPattern: '^(google_gmail_send|google_calendar_create)$',
      effect: 'require-approval',
      reason: 'Sending mail or creating calendar events acts externally in the user\u2019s name; require human approval.',
    },
  ];
}

export interface GoogleWorkspaceToolOptions {
  dataDir: string;
  /** Injected in tests; defaults to the real fetch client. */
  client?: GoogleWorkspaceClient;
  /** Injected in tests; defaults to oauth.ts getValidToken('google', …). */
  getAccessToken?: (dataDir: string) => Promise<string>;
  /** Env source for the credential-config check. Defaults to process.env. */
  env?: Record<string, string | undefined>;
}

function strArg(args: Record<string, unknown>, name: string, required = true): string | undefined {
  const v = args[name];
  if (v === undefined || v === null || v === '') {
    if (required) throw new Error(`"${name}" is required`);
    return undefined;
  }
  if (typeof v !== 'string') throw new Error(`"${name}" must be a string`);
  return v;
}

function maxResultsArg(args: Record<string, unknown>): number {
  const raw = typeof args.maxResults === 'number' ? Math.floor(args.maxResults) : 10;
  return Math.min(50, Math.max(1, raw));
}

export function createGoogleWorkspaceTools(opts: GoogleWorkspaceToolOptions): ToolDefinition[] {
  const client = opts.client ?? createFetchGoogleWorkspaceClient();
  const getAccessToken = opts.getAccessToken ?? ((dataDir: string) => getValidToken(GOOGLE_PROVIDER_ID, dataDir));

  /** Resolve a token or fail closed with an actionable message. */
  async function token(): Promise<string> {
    const cfg = googleWorkspaceConfigStatus(opts.dataDir, opts.env);
    if (!cfg.credentialsConfigured) {
      throw new Error(
        `Google Workspace is not configured: the founder OAuth credentials are missing (${cfg.missingEnv.join(', ')}). ` +
          'They must be set by the workspace owner — no tool can connect Google without them.',
      );
    }
    try {
      return await getAccessToken(opts.dataDir);
    } catch {
      throw new Error(
        'Google Workspace is not connected — connect the Google account in Accounts (OAuth) first.',
      );
    }
  }

  return [
    {
      name: 'google_gmail_search',
      description:
        'Search the user\u2019s own Gmail (first-party connector, not Composio). Uses Gmail search syntax (from:, subject:, after:, …). Returns sender, subject, date and snippet per message.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Gmail search query; empty = most recent.' },
          maxResults: { type: 'number', description: 'Max messages (default 10, max 50).' },
        },
        additionalProperties: false,
      },
      handler: async (args) => {
        const accessToken = await token();
        const messages = await client.listMessages(accessToken, strArg(args, 'query', false) ?? '', maxResultsArg(args));
        return { ok: true, messages };
      },
    },
    {
      name: 'google_gmail_read',
      description: 'Read one Gmail message (headers + plain-text body, capped) by message id from google_gmail_search.',
      parameters: {
        type: 'object',
        properties: { messageId: { type: 'string', description: 'Gmail message id.' } },
        required: ['messageId'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const accessToken = await token();
        const message = await client.getMessage(accessToken, strArg(args, 'messageId')!);
        return { ok: true, message };
      },
    },
    {
      name: 'google_gmail_send',
      description:
        'Send an email from the user\u2019s own Gmail account. MUTATING: requires human approval via governance.',
      mutating: true,
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient email address.' },
          subject: { type: 'string', description: 'Subject line.' },
          body: { type: 'string', description: 'Plain-text body.' },
        },
        required: ['to', 'subject', 'body'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const to = strArg(args, 'to')!;
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new Error(`"${to}" is not an email address`);
        const accessToken = await token();
        const sent = await client.sendMessage(accessToken, {
          to,
          subject: strArg(args, 'subject')!,
          body: strArg(args, 'body')!,
        });
        return { ok: true, messageId: sent.id };
      },
    },
    {
      name: 'google_calendar_list',
      description:
        'List upcoming events on the user\u2019s primary Google Calendar (first-party connector). Defaults to events from now, soonest first.',
      parameters: {
        type: 'object',
        properties: {
          timeMin: { type: 'string', description: 'ISO 8601 lower bound (default: now).' },
          timeMax: { type: 'string', description: 'ISO 8601 upper bound.' },
          maxResults: { type: 'number', description: 'Max events (default 10, max 50).' },
        },
        additionalProperties: false,
      },
      handler: async (args) => {
        const accessToken = await token();
        const events = await client.listEvents(accessToken, {
          timeMin: strArg(args, 'timeMin', false),
          timeMax: strArg(args, 'timeMax', false),
          maxResults: maxResultsArg(args),
        });
        return { ok: true, events };
      },
    },
    {
      name: 'google_calendar_create',
      description:
        'Create an event on the user\u2019s primary Google Calendar. MUTATING: requires human approval via governance. Times are ISO 8601 with timezone offset.',
      mutating: true,
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Event title.' },
          start: { type: 'string', description: 'Start, ISO 8601 (e.g. 2026-11-02T10:00:00+05:30).' },
          end: { type: 'string', description: 'End, ISO 8601.' },
          description: { type: 'string', description: 'Optional notes.' },
          location: { type: 'string', description: 'Optional location.' },
        },
        required: ['summary', 'start', 'end'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const accessToken = await token();
        const event = await client.createEvent(accessToken, {
          summary: strArg(args, 'summary')!,
          start: strArg(args, 'start')!,
          end: strArg(args, 'end')!,
          description: strArg(args, 'description', false),
          location: strArg(args, 'location', false),
        });
        return { ok: true, event };
      },
    },
    {
      name: 'google_drive_search',
      description:
        'Search the user\u2019s Google Drive by file name (first-party connector, read-only). Returns name, type, modified time and a view link — never file contents.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Name substring to search for; empty = most recently modified.' },
          maxResults: { type: 'number', description: 'Max files (default 10, max 50).' },
        },
        additionalProperties: false,
      },
      handler: async (args) => {
        const accessToken = await token();
        const files = await client.listFiles(accessToken, strArg(args, 'query', false) ?? '', maxResultsArg(args));
        return { ok: true, files };
      },
    },
    {
      name: 'google_drive_read',
      description: 'Get one Drive file\u2019s metadata by id (name, type, size, modified time, view link). Metadata only — no content download.',
      parameters: {
        type: 'object',
        properties: { fileId: { type: 'string', description: 'Drive file id.' } },
        required: ['fileId'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const accessToken = await token();
        const file = await client.getFile(accessToken, strArg(args, 'fileId')!);
        return { ok: true, file };
      },
    },
  ];
}

/** Register all Google Workspace tools; throws on name collision. */
export function registerGoogleWorkspaceTools(
  registry: Map<string, ToolDefinition>,
  opts: GoogleWorkspaceToolOptions,
): void {
  for (const tool of createGoogleWorkspaceTools(opts)) {
    if (registry.has(tool.name)) {
      throw new Error(`tool name collision: "${tool.name}" is already registered`);
    }
    registry.set(tool.name, tool);
  }
}

// ---------------------------------------------------------------------------
// Status route (register-style; the host mounts under /api)
// ---------------------------------------------------------------------------

export interface GoogleWorkspaceRouteDeps {
  dataDir: string;
  env?: Record<string, string | undefined>;
  audit?: (action: string, fields: { actor?: string; toolName?: string; detail?: unknown }) => void;
}

export function registerGoogleWorkspaceRoutes(router: express.Router, deps: GoogleWorkspaceRouteDeps): void {
  const r = express.Router();

  // GET /google-workspace/status — honest connection state. Tokens and
  // credential VALUES are never returned; only presence booleans.
  r.get('/status', (_req: Request, res: Response) => {
    const cfg = googleWorkspaceConfigStatus(deps.dataDir, deps.env);
    let connected = false;
    let expiresAt: number | undefined;
    try {
      const status = getOAuthStatus(deps.dataDir).find((s) => s.id === GOOGLE_PROVIDER_ID);
      connected = status?.connected ?? false;
      expiresAt = status?.expiresAt;
    } catch {
      connected = false;
    }
    res.json({
      ok: true,
      provider: GOOGLE_PROVIDER_ID,
      firstParty: true,
      credentialsConfigured: cfg.credentialsConfigured,
      missingEnv: cfg.missingEnv,
      connected,
      ...(expiresAt ? { tokenExpiresAt: expiresAt } : {}),
      scopes: [...GOOGLE_WORKSPACE_SCOPES],
      tools: [...GOOGLE_TOOL_NAMES],
      // The live OAuth round-trip cannot be verified without the
      // founder's Google OAuth client; the flow itself is oauth.ts's
      // shipped flow and the API surface is mock-verified in tests.
      liveVerified: false,
      note: cfg.credentialsConfigured
        ? connected
          ? 'Connected. Tool calls use the stored OAuth token (auto-refreshed server-side).'
          : 'OAuth credentials are configured but no Google account is connected yet — use the OAuth connect flow.'
        : `Founder Google OAuth credentials are not configured (missing: ${cfg.missingEnv.join(', ')}). The connector layer is built and mock-verified; the live connect step is unverified until those are set.`,
    });
  });

  router.use('/google-workspace', r);
}
