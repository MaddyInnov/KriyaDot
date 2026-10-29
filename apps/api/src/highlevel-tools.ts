// SPDX-License-Identifier: Apache-2.0
// HighLevel (GoHighLevel) CRM tools via the LeadConnector API:
//   highlevel_list_contacts   GET  /contacts/?locationId=…
//   highlevel_create_contact  POST /contacts/
// Config: HIGHLEVEL_API_KEY (sub-account API key or OAuth token) +
// HIGHLEVEL_LOCATION_ID. Fetch is injectable for tests — zero real
// network in the suite, and missing config fails with a clear error.

import type { ToolDefinition } from '@mvp/agent-runtime';

export const HIGHLEVEL_BASE_URL = 'https://services.leadconnectorhq.com';
export const HIGHLEVEL_API_VERSION = '2021-07-28';

export interface HighLevelToolsOptions {
  fetchFn?: typeof fetch;
  env?: Record<string, string | undefined>;
  baseUrl?: string;
}

function config(opts: HighLevelToolsOptions): { apiKey: string; locationId: string; base: string } {
  const env = opts.env ?? process.env;
  const apiKey = (env.HIGHLEVEL_API_KEY ?? '').trim();
  if (!apiKey) throw new Error('Not configured: set HIGHLEVEL_API_KEY (HighLevel sub-account API key).');
  const locationId = (env.HIGHLEVEL_LOCATION_ID ?? '').trim();
  if (!locationId) throw new Error('Not configured: set HIGHLEVEL_LOCATION_ID (the HighLevel location/sub-account id).');
  return { apiKey, locationId, base: (opts.baseUrl ?? HIGHLEVEL_BASE_URL).replace(/\/+$/, '') };
}

async function highLevelFetch(
  opts: HighLevelToolsOptions,
  pathQuery: string,
  init: { method?: string; body?: string },
): Promise<unknown> {
  const { apiKey, base } = config(opts);
  const res = await (opts.fetchFn ?? fetch)(`${base}${pathQuery}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${apiKey}`,
      version: HIGHLEVEL_API_VERSION,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    ...(init.body !== undefined ? { body: init.body } : {}),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as { message?: string };
      detail = body.message ? `: ${body.message}` : '';
    } catch {
      // keep the bare status
    }
    throw new Error(`HighLevel API failed: HTTP ${res.status}${detail}`);
  }
  return res.json();
}

function optStr(args: Record<string, unknown>, name: string): string | undefined {
  const v = args[name];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new Error(`"${name}" must be a string`);
  return v;
}

export function createHighLevelListContactsTool(opts: HighLevelToolsOptions = {}): ToolDefinition {
  return {
    name: 'highlevel_list_contacts',
    description: 'List contacts in the configured HighLevel location (name, email, phone, tags).',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional search query (name/email/phone).' },
        limit: { type: 'number', description: 'Max contacts (default 20, max 100).' },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const { locationId } = config(opts);
      const limitRaw = typeof args.limit === 'number' ? Math.floor(args.limit) : 20;
      const limit = Math.min(100, Math.max(1, limitRaw));
      const query = optStr(args, 'query');
      const qs =
        `?locationId=${encodeURIComponent(locationId)}&limit=${limit}` +
        (query ? `&query=${encodeURIComponent(query)}` : '');
      const data = (await highLevelFetch(opts, `/contacts/${qs}`, {})) as {
        contacts?: Array<Record<string, unknown>>;
      };
      return {
        ok: true,
        contacts: (data.contacts ?? []).map((c) => ({
          id: c.id,
          name: c.contactName ?? [c.firstName, c.lastName].filter(Boolean).join(' '),
          email: c.email,
          phone: c.phone,
          tags: c.tags,
          dateAdded: c.dateAdded,
        })),
      };
    },
  };
}

export function createHighLevelCreateContactTool(opts: HighLevelToolsOptions = {}): ToolDefinition {
  return {
    name: 'highlevel_create_contact',
    description: 'Create a contact in the configured HighLevel location.',
    mutating: true,
    parameters: {
      type: 'object',
      properties: {
        firstName: { type: 'string' },
        lastName: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string', description: 'Phone, ideally E.164 (e.g. +14155550123).' },
        companyName: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const { locationId } = config(opts);
      const body: Record<string, unknown> = { locationId };
      for (const key of ['firstName', 'lastName', 'email', 'phone', 'companyName'] as const) {
        const v = optStr(args, key);
        if (v) body[key] = v;
      }
      if (args.tags !== undefined) {
        if (!Array.isArray(args.tags) || args.tags.some((t) => typeof t !== 'string')) {
          throw new Error('"tags" must be an array of strings');
        }
        body.tags = args.tags;
      }
      if (!body.email && !body.phone && !body.firstName && !body.lastName) {
        throw new Error('Provide at least one of: firstName, lastName, email, phone');
      }
      const data = (await highLevelFetch(opts, '/contacts/', {
        method: 'POST',
        body: JSON.stringify(body),
      })) as { contact?: { id?: string } };
      return { ok: true, contactId: data.contact?.id, contact: body };
    },
  };
}

/** Both HighLevel CRM tools. */
export function createHighLevelTools(opts: HighLevelToolsOptions = {}): ToolDefinition[] {
  return [createHighLevelListContactsTool(opts), createHighLevelCreateContactTool(opts)];
}
