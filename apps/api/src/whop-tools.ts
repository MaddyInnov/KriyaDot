// SPDX-License-Identifier: Apache-2.0
// Whop connector tools (read-only): products + memberships for a company
// over the Whop API (https://api.whop.com/api/v5).
//
//   whop_list_products    — products for a company (biz_... id).
//   whop_list_memberships — memberships for a company.
//
// Config: WHOP_API_KEY resolved server-side per call (injected getter —
// host wires the vault — or env). The key never appears in
// args/results/errors. Both tools are read-only (mutating unset), so the
// standard policy allows them; whopToolPolicyRules() states that explicitly.
// Parent wiring note: register the tools; this module does not edit
// tool-registry.ts.

import type { BotPolicyRule, ToolContext, ToolDefinition } from '@mvp/agent-runtime';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface WhopToolsOptions {
  getApiKey?: (ctx: ToolContext) => string | undefined;
  /** Company id default (WHOP_COMPANY_ID env in the host getter). */
  getCompanyId?: (ctx: ToolContext) => string | undefined;
  fetchImpl?: FetchLike;
  apiBase?: string;
}

export function whopToolPolicyRules(): BotPolicyRule[] {
  return [
    { id: 'whop-read-allow', toolPattern: '^whop_list_(products|memberships)$', effect: 'allow', reason: 'Read-only Whop catalog/membership listing.' },
  ];
}

const COMPANY_RE = /^biz_[A-Za-z0-9]{8,64}$/;

function companyId(opts: WhopToolsOptions, ctx: ToolContext, args: Record<string, unknown>): string {
  const fromArg = typeof args.companyId === 'string' ? args.companyId.trim() : '';
  const id = fromArg || opts.getCompanyId?.(ctx) || process.env.WHOP_COMPANY_ID?.trim() || '';
  if (!COMPANY_RE.test(id)) throw new Error('"companyId" must be a Whop company id (biz_...); pass it or set WHOP_COMPANY_ID');
  return id;
}

async function whopFetch(opts: WhopToolsOptions, ctx: ToolContext, path: string): Promise<unknown> {
  const key = opts.getApiKey?.(ctx) ?? process.env.WHOP_API_KEY?.trim();
  if (!key) throw new Error('Whop is not configured: set WHOP_API_KEY (or store it in the vault)');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = (opts.apiBase ?? 'https://api.whop.com').replace(/\/$/, '');
  let res: Response;
  try {
    res = await fetchImpl(`${base}${path}`, { headers: { Authorization: `Bearer ${key}`, accept: 'application/json' } });
  } catch (err) {
    throw new Error(`Whop API request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const text = await res.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  if (!res.ok) {
    const msg = (parsed as { message?: string } | undefined)?.message ?? `HTTP ${res.status}`;
    throw new Error(`Whop API error (${res.status}): ${String(msg).slice(0, 200)}`);
  }
  return parsed;
}

function page(args: Record<string, unknown>): { page: number; pageSize: number } {
  const n = (v: unknown, def: number, max: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(1, Math.min(max, Math.floor(v))) : def);
  return { page: n(args.page, 1, 10_000), pageSize: n(args.pageSize, 20, 100) };
}

interface ListRaw<T> { data?: T[]; page_info?: { end_cursor?: string | null; has_next_page?: boolean } }

export function createWhopTools(opts: WhopToolsOptions = {}): ToolDefinition[] {
  return [
    {
      name: 'whop_list_products',
      description: 'List products for a Whop company. Read-only.',
      parameters: {
        type: 'object',
        properties: {
          companyId: { type: 'string', description: 'Whop company id (biz_...); defaults to WHOP_COMPANY_ID' },
          page: { type: 'number' }, pageSize: { type: 'number', description: '1-100, default 20' },
        },
        required: [], additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const id = companyId(opts, ctx, args);
        const { page: p, pageSize } = page(args);
        const raw = await whopFetch(opts, ctx, `/api/v5/companies/${encodeURIComponent(id)}/products?page=${p}&per_page=${pageSize}`) as ListRaw<Record<string, unknown>>;
        const products = (raw.data ?? []).map((pr) => ({
          id: pr.id ?? null, title: pr.title ?? pr.name ?? null,
          visibility: pr.visibility ?? null, createdAt: pr.created_at ?? null,
        }));
        return { ok: true, companyId: id, products, hasNextPage: Boolean(raw.page_info?.has_next_page) };
      },
    },
    {
      name: 'whop_list_memberships',
      description: 'List memberships for a Whop company. Read-only.',
      parameters: {
        type: 'object',
        properties: {
          companyId: { type: 'string', description: 'Whop company id (biz_...); defaults to WHOP_COMPANY_ID' },
          page: { type: 'number' }, pageSize: { type: 'number', description: '1-100, default 20' },
        },
        required: [], additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const id = companyId(opts, ctx, args);
        const { page: p, pageSize } = page(args);
        const raw = await whopFetch(opts, ctx, `/api/v5/companies/${encodeURIComponent(id)}/memberships?page=${p}&per_page=${pageSize}`) as ListRaw<Record<string, unknown>>;
        const memberships = (raw.data ?? []).map((m) => ({
          id: m.id ?? null,
          status: m.status ?? null,
          productId: (m.product as { id?: string } | undefined)?.id ?? m.product_id ?? null,
          userId: (m.user as { id?: string } | undefined)?.id ?? m.user_id ?? null,
          createdAt: m.created_at ?? null,
          // Deliberately no email/name: memberships are listed by id/status only.
        }));
        return { ok: true, companyId: id, memberships, hasNextPage: Boolean(raw.page_info?.has_next_page) };
      },
    },
  ];
}

export function registerWhopTools(registry: Map<string, ToolDefinition>, opts: WhopToolsOptions = {}): void {
  for (const tool of createWhopTools(opts)) if (!registry.has(tool.name)) registry.set(tool.name, tool);
}
