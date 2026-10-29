// SPDX-License-Identifier: Apache-2.0
// X (Twitter) research + posting tools.
//
//   x_search — X API v2 recent search (read-only).
//   x_post   — post a tweet via X API v2. MUTATING: approval-gated via
//              xToolPolicyRules() (standard tool approval metadata:
//              `mutating: true` plus a require-approval policy rule).
//
// Config is resolved server-side per call (host wires this to the vault;
// the fallback reads env): X_BEARER_TOKEN for search, and for posting a
// user-context token X_ACCESS_TOKEN when present (app-only bearer tokens
// cannot post) else the bearer. Tokens never appear in args/results/errors.
// Parent wiring note: register the returned tools into the registry and
// prepend xToolPolicyRules() — this module does not edit tool-registry.ts.

import type { BotPolicyRule, ToolContext, ToolDefinition } from '@mvp/agent-runtime';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface XToolsOptions {
  /** Server-side token lookup (vault first in the host). ctx-aware for per-bot config. */
  getBearerToken?: (ctx: ToolContext) => string | undefined;
  getAccessToken?: (ctx: ToolContext) => string | undefined;
  fetchImpl?: FetchLike;
  apiBase?: string;
}

export function xToolPolicyRules(): BotPolicyRule[] {
  return [
    { id: 'x-search-allow', toolPattern: '^x_search$', effect: 'allow', reason: 'Read-only X recent search.' },
    { id: 'x-post-approval', toolPattern: '^x_post$', effect: 'require-approval', reason: 'Posting to X publishes publicly under the user\'s account; needs human approval.' },
  ];
}

function bearerFromEnv(): string | undefined {
  return process.env.X_BEARER_TOKEN?.trim() || undefined;
}

async function xFetch(opts: XToolsOptions, token: string, path: string, init: RequestInit = {}): Promise<unknown> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = (opts.apiBase ?? 'https://api.x.com').replace(/\/$/, '');
  let res: Response;
  try {
    res = await fetchImpl(`${base}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
  } catch (err) {
    throw new Error(`X API request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const text = await res.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  if (!res.ok) {
    const detail = (parsed as { detail?: string; title?: string } | undefined)?.detail
      ?? (parsed as { title?: string } | undefined)?.title ?? `HTTP ${res.status}`;
    throw new Error(`X API error (${res.status}): ${String(detail).slice(0, 200)}`);
  }
  return parsed;
}

interface XTweetRaw {
  id: string; text: string; author_id?: string; created_at?: string;
  public_metrics?: { like_count?: number; retweet_count?: number; reply_count?: number };
}
interface XSearchRaw {
  data?: XTweetRaw[];
  includes?: { users?: Array<{ id: string; username?: string; name?: string }> };
  meta?: { result_count?: number; next_token?: string };
}

/** Map an X search response into the compact tool shape. Pure; exported for tests. */
export function mapXSearchResponse(raw: XSearchRaw): { tweets: Array<Record<string, unknown>>; resultCount: number; nextToken?: string } {
  const users = new Map((raw.includes?.users ?? []).map((u) => [u.id, u]));
  const tweets = (raw.data ?? []).map((t) => ({
    id: t.id,
    text: t.text,
    authorId: t.author_id ?? null,
    authorUsername: t.author_id ? users.get(t.author_id)?.username ?? null : null,
    createdAt: t.created_at ?? null,
    likeCount: t.public_metrics?.like_count ?? 0,
    retweetCount: t.public_metrics?.retweet_count ?? 0,
    replyCount: t.public_metrics?.reply_count ?? 0,
  }));
  return { tweets, resultCount: raw.meta?.result_count ?? tweets.length, ...(raw.meta?.next_token ? { nextToken: raw.meta.next_token } : {}) };
}

export function createXTools(opts: XToolsOptions = {}): ToolDefinition[] {
  const searchToken = (ctx: ToolContext): string => {
    const t = opts.getBearerToken?.(ctx) ?? bearerFromEnv();
    if (!t) throw new Error('X is not configured: set X_BEARER_TOKEN (or store it in the vault) to use x_search');
    return t;
  };
  const postToken = (ctx: ToolContext): string => {
    const t = opts.getAccessToken?.(ctx) ?? opts.getBearerToken?.(ctx) ?? process.env.X_ACCESS_TOKEN?.trim() ?? bearerFromEnv();
    if (!t) throw new Error('X is not configured: set X_ACCESS_TOKEN / X_BEARER_TOKEN (or store it in the vault) to use x_post');
    return t;
  };
  return [
    {
      name: 'x_search',
      description: 'Search recent posts on X (Twitter) via the X API v2 recent-search endpoint. Read-only.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'X search query (max 512 chars)' },
          maxResults: { type: 'number', description: 'Results to return (10-100, default 10)' },
        },
        required: ['query'], additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const query = typeof args.query === 'string' ? args.query.trim() : '';
        if (!query || query.length > 512) throw new Error('"query" is required (non-empty string, max 512 chars)');
        const max = typeof args.maxResults === 'number' && Number.isFinite(args.maxResults)
          ? Math.max(10, Math.min(100, Math.floor(args.maxResults))) : 10;
        const qs = new URLSearchParams({
          query, max_results: String(max),
          'tweet.fields': 'created_at,public_metrics,author_id',
          expansions: 'author_id', 'user.fields': 'username,name',
        });
        const raw = await xFetch(opts, searchToken(ctx), `/2/tweets/search/recent?${qs.toString()}`);
        return { ok: true, ...mapXSearchResponse(raw as XSearchRaw) };
      },
    },
    {
      name: 'x_post',
      mutating: true,
      description: 'Post a tweet to X via the X API v2. MUTATING: requires human approval via governance.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: 'Tweet text (max 280 chars)' } },
        required: ['text'], additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const text = typeof args.text === 'string' ? args.text.trim() : '';
        if (!text || text.length > 280) throw new Error('"text" is required (non-empty string, max 280 chars)');
        const raw = await xFetch(opts, postToken(ctx), '/2/tweets', { method: 'POST', body: JSON.stringify({ text }) }) as { data?: { id?: string; text?: string } };
        if (!raw.data?.id) throw new Error('X API error: post response carried no tweet id');
        return { ok: true, id: raw.data.id, text: raw.data.text ?? text, url: `https://x.com/i/web/status/${raw.data.id}` };
      },
    },
  ];
}

/** Register into a registry (skips collisions) — the parent calls this. */
export function registerXTools(registry: Map<string, ToolDefinition>, opts: XToolsOptions = {}): void {
  for (const tool of createXTools(opts)) if (!registry.has(tool.name)) registry.set(tool.name, tool);
}
