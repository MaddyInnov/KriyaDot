// SPDX-License-Identifier: Apache-2.0
// Postiz publishing tools: schedule/post to connected social accounts via
// the Postiz public API.
//
//   postiz_list_integrations — connected social accounts (read-only).
//   postiz_schedule_post     — create/schedule a post. MUTATING:
//                              approval-gated via postizToolPolicyRules().
//
// Config (server-side only): POSTIZ_API_URL (default https://api.postiz.com)
// + POSTIZ_API_KEY, resolved per call via the injected getter (host wires
// the vault) or env. The key never appears in args/results/errors.
// Parent wiring note: register the tools + prepend the policy rules; this
// module does not edit tool-registry.ts.

import type { BotPolicyRule, ToolContext, ToolDefinition } from '@mvp/agent-runtime';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface PostizToolsOptions {
  getApiKey?: (ctx: ToolContext) => string | undefined;
  getApiUrl?: (ctx: ToolContext) => string | undefined;
  fetchImpl?: FetchLike;
}

export function postizToolPolicyRules(): BotPolicyRule[] {
  return [
    { id: 'postiz-list-allow', toolPattern: '^postiz_list_integrations$', effect: 'allow', reason: 'Read-only listing of connected Postiz integrations.' },
    { id: 'postiz-schedule-approval', toolPattern: '^postiz_schedule_post$', effect: 'require-approval', reason: 'Scheduling/publishing a social post changes public state; needs human approval.' },
  ];
}

export function resolvePostizConfig(opts: PostizToolsOptions, ctx: ToolContext): { apiUrl: string; apiKey: string } {
  const apiKey = opts.getApiKey?.(ctx) ?? process.env.POSTIZ_API_KEY?.trim();
  if (!apiKey) throw new Error('Postiz is not configured: set POSTIZ_API_KEY (or store it in the vault)');
  const apiUrl = (opts.getApiUrl?.(ctx) ?? process.env.POSTIZ_API_URL?.trim() ?? 'https://api.postiz.com').replace(/\/$/, '');
  return { apiUrl, apiKey };
}

async function postizFetch(opts: PostizToolsOptions, ctx: ToolContext, path: string, init: RequestInit = {}): Promise<unknown> {
  const { apiUrl, apiKey } = resolvePostizConfig(opts, ctx);
  const fetchImpl = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(`${apiUrl}${path}`, {
      ...init,
      headers: { Authorization: apiKey, 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
  } catch (err) {
    throw new Error(`Postiz API request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const text = await res.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  if (!res.ok) {
    const msg = (parsed as { msg?: string; message?: string } | undefined)?.msg ?? (parsed as { message?: string } | undefined)?.message ?? `HTTP ${res.status}`;
    throw new Error(`Postiz API error (${res.status}): ${String(msg).slice(0, 200)}`);
  }
  return parsed;
}

interface IntegrationRaw { id?: string; name?: string; identifier?: string; disabled?: boolean; profile?: string }

export function createPostizTools(opts: PostizToolsOptions = {}): ToolDefinition[] {
  return [
    {
      name: 'postiz_list_integrations',
      description: 'List the social accounts (integrations) connected in Postiz. Read-only.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      handler: async (_args, ctx) => {
        const raw = await postizFetch(opts, ctx, '/public/v1/integrations') as IntegrationRaw[] | { integrations?: IntegrationRaw[] };
        const list = Array.isArray(raw) ? raw : raw.integrations ?? [];
        return {
          ok: true,
          integrations: list.map((i) => ({
            id: i.id ?? null, name: i.name ?? null, identifier: i.identifier ?? null,
            profile: i.profile ?? null, disabled: Boolean(i.disabled),
          })),
        };
      },
    },
    {
      name: 'postiz_schedule_post',
      mutating: true,
      description: 'Schedule (or publish now) a post to one Postiz integration. MUTATING: requires human approval via governance.',
      parameters: {
        type: 'object',
        properties: {
          integrationId: { type: 'string', description: 'Postiz integration id (from postiz_list_integrations)' },
          content: { type: 'string', description: 'Post text (max 3000 chars)' },
          date: { type: 'string', description: 'ISO 8601 date/time to publish; omit or "now" to publish immediately' },
          mediaUrls: { type: 'array', items: { type: 'string' }, description: 'Optional public media URLs to attach' },
        },
        required: ['integrationId', 'content'], additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const integrationId = typeof args.integrationId === 'string' ? args.integrationId.trim() : '';
        if (!integrationId || integrationId.length > 128) throw new Error('"integrationId" is required');
        const content = typeof args.content === 'string' ? args.content.trim() : '';
        if (!content || content.length > 3000) throw new Error('"content" is required (non-empty string, max 3000 chars)');
        const immediate = args.date === undefined || args.date === null || args.date === 'now';
        let date: string;
        if (immediate) date = new Date().toISOString();
        else {
          if (typeof args.date !== 'string' || Number.isNaN(Date.parse(args.date))) throw new Error('"date" must be an ISO 8601 date/time or "now"');
          date = new Date(args.date).toISOString();
        }
        const media = Array.isArray(args.mediaUrls)
          ? (args.mediaUrls as unknown[]).filter((m): m is string => typeof m === 'string' && m.length <= 2048).slice(0, 10)
              .map((url) => ({ id: url, path: url }))
          : [];
        const payload = {
          type: immediate ? 'now' : 'schedule',
          date,
          shortLink: true,
          posts: [{
            integration: { id: integrationId },
            value: [{ content, image: media }],
            group: 'group',
            settings: {},
          }],
        };
        const raw = await postizFetch(opts, ctx, '/public/v1/posts', { method: 'POST', body: JSON.stringify(payload) }) as unknown;
        const first = (Array.isArray(raw) ? raw[0] : raw) as { postId?: string; id?: string } | undefined;
        return { ok: true, postId: first?.postId ?? first?.id ?? null, integrationId, scheduledFor: date, immediate };
      },
    },
  ];
}

export function registerPostizTools(registry: Map<string, ToolDefinition>, opts: PostizToolsOptions = {}): void {
  for (const tool of createPostizTools(opts)) if (!registry.has(tool.name)) registry.set(tool.name, tool);
}
