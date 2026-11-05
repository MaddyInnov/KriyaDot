// SPDX-License-Identifier: Apache-2.0
// Connected Apps hub client (W4): types mirroring GET /api/connected-apps,
// pure filter/group/status helpers (unit-tested in connected-apps.test.ts),
// and thin fetchers over the aggregate + existing Composio / bots / MCP /
// starters endpoints. All HTTP goes through authedFetch from ./api — the
// accounts page's local api() helper pattern, shared here so the hub,
// connect flow and starters section all speak the same contract.

'use client';

import { authedFetch } from './api';

// ---------------------------------------------------------------------------
// Contract types (mirror the backend aggregate — see task API contract)
// ---------------------------------------------------------------------------

export type ConnectedAppCategory =
  | 'design-media'
  | 'social'
  | 'messaging'
  | 'productivity'
  | 'work'
  | 'development'
  | 'local'
  | 'other';

export type ConnectedAppSource = 'composio' | 'native' | 'mcp' | 'phone' | 'local';

export type ConnectedAppStatus =
  | 'connected'
  | 'available'
  | 'needs_platform_setup'
  | 'not_in_catalog'
  | 'on_this_computer'
  | 'not_installed';

export interface ConnectedAppAccount {
  id: string;
  label?: string;
  status: string;
}

export interface ConnectedAppMode {
  id: string;
  label: string;
  detail: string;
  status: ConnectedAppStatus;
}

export interface ConnectedAppLocalInfo {
  installed: boolean;
  version?: string;
  running?: boolean;
  detectionNote?: string;
}

export interface StarterTask {
  label: string;
  prompt: string;
}

export interface ConnectedAppEntry {
  id: string;
  name: string;
  description?: string;
  logo?: string;
  category: ConnectedAppCategory;
  featured?: boolean;
  source: ConnectedAppSource;
  connectionType: string;
  status: ConnectedAppStatus;
  accounts: ConnectedAppAccount[];
  enabledBotIds: string[];
  capabilities: string[];
  starterTasks: StarterTask[];
  notes?: string;
  composioSlug?: string;
  modes?: ConnectedAppMode[];
  local?: ConnectedAppLocalInfo;
}

export interface ConnectedAppsResponse {
  platform: { configured: boolean };
  apps: ConnectedAppEntry[];
  generatedAt: number;
}

export interface WebBot {
  id: string;
  name: string;
}

export interface ComposioConnectedAccount {
  id: string;
  toolkitSlug: string;
  toolkitName?: string;
  status: string;
  label?: string;
}

export interface ComposioAccountsResponse {
  connected: boolean;
  accounts: ComposioConnectedAccount[];
  pending?: unknown;
}

export type StarterTriggerKind = 'event' | 'schedule' | 'manual';

export interface StarterRecipe {
  id: string;
  name: string;
  description: string;
  requiredApps: string[];
  triggerKind: StarterTriggerKind;
  ready: boolean;
  missing: string[];
}

export interface StartersResponse {
  starters: StarterRecipe[];
}

// ---------------------------------------------------------------------------
// Fetch helpers (accounts page api() pattern)
// ---------------------------------------------------------------------------

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await authedFetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
  return json;
}

export function fetchConnectedApps(): Promise<ConnectedAppsResponse> {
  return api<ConnectedAppsResponse>('GET', '/api/connected-apps');
}

export async function fetchWebBots(): Promise<WebBot[]> {
  const data = await api<WebBot[] | { bots?: WebBot[] }>('GET', '/api/bots');
  return Array.isArray(data) ? data : (data.bots ?? []);
}

export async function fetchMcpServers(): Promise<unknown[]> {
  const data = await api<unknown>('GET', '/api/mcp/servers');
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object' && Array.isArray((data as { servers?: unknown[] }).servers)) {
    return (data as { servers: unknown[] }).servers;
  }
  return [];
}

export function connectComposioPlatform(apiKey: string): Promise<unknown> {
  return api('POST', '/api/composio/connect', { apiKey });
}

export function createComposioLink(
  toolkitSlug: string,
  label?: string,
): Promise<{ redirectUrl: string }> {
  return api<{ redirectUrl: string }>('POST', '/api/composio/accounts/link', {
    toolkitSlug,
    ...(label ? { label } : {}),
  });
}

export function fetchComposioAccounts(): Promise<ComposioAccountsResponse> {
  return api<ComposioAccountsResponse>('GET', '/api/composio/accounts');
}

export function setComposioAccountLabel(id: string, label: string): Promise<unknown> {
  return api('POST', `/api/composio/accounts/${encodeURIComponent(id)}/label`, { label });
}

export function deleteComposioAccount(id: string): Promise<unknown> {
  return api('DELETE', `/api/composio/accounts/${encodeURIComponent(id)}`);
}

/** Per-bot app enable toggle: POST /api/composio/apps/:appId { botId, enabled }. */
export function setComposioAppEnabledForBot(
  appId: string,
  botId: string,
  enabled: boolean,
): Promise<unknown> {
  return api('POST', `/api/composio/apps/${encodeURIComponent(appId)}`, { botId, enabled });
}

export async function fetchStarters(botId: string): Promise<StartersResponse> {
  // The API serves starters at /api/automation-starters; its readiness
  // `missing` entries are { slug, need } objects — flatten to slugs for
  // the section UI.
  const raw = await api<{ starters: Array<Omit<StarterRecipe, 'missing'> & { missing?: Array<string | { slug: string }> }> }>(
    'GET',
    `/api/automation-starters?botId=${encodeURIComponent(botId)}`,
  );
  return {
    starters: (raw.starters ?? []).map((s) => ({
      ...s,
      missing: (s.missing ?? []).map((m) => (typeof m === 'string' ? m : m.slug)),
    })),
  };
}

export function createStarter(
  id: string,
  botId: string,
): Promise<{ ok: true; routineId: string; name: string; enabled: false }> {
  return api('POST', `/api/automation-starters/${encodeURIComponent(id)}/create`, { botId });
}

// ---------------------------------------------------------------------------
// Chat prefill (app/page.tsx pattern: sessionStorage 'mvp:chat-prefill')
// ---------------------------------------------------------------------------

export function storeChatPrefill(prompt: string): void {
  try {
    sessionStorage.setItem('mvp:chat-prefill', prompt);
  } catch {
    // sessionStorage unavailable — navigation still happens.
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** The slug used for Composio calls (accounts/link, apps/:appId toggles). */
export function composioSlugFor(app: ConnectedAppEntry): string {
  return app.composioSlug ?? app.id;
}

export const CATEGORY_LABELS: Record<ConnectedAppCategory, string> = {
  'design-media': 'Design & Media',
  social: 'Social',
  messaging: 'Messaging',
  productivity: 'Productivity',
  work: 'Work',
  development: 'Development',
  local: 'On this computer',
  other: 'Other',
};

export const CATEGORY_ORDER: ConnectedAppCategory[] = [
  'design-media',
  'social',
  'messaging',
  'productivity',
  'work',
  'development',
  'local',
  'other',
];

/** Pseudo-filters (featured / connected / local) plus real categories. */
export type AppFilter = 'all' | 'featured' | 'connected' | 'local' | ConnectedAppCategory;

export const FILTER_CHIPS: Array<{ id: AppFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'featured', label: 'Featured' },
  { id: 'connected', label: 'Connected' },
  { id: 'design-media', label: 'Design & Media' },
  { id: 'social', label: 'Social' },
  { id: 'messaging', label: 'Messaging' },
  { id: 'productivity', label: 'Productivity' },
  { id: 'work', label: 'Work' },
  { id: 'development', label: 'Development' },
  { id: 'local', label: 'On this computer' },
];

export function categoryLabel(category: ConnectedAppCategory | string): string {
  return (CATEGORY_LABELS as Record<string, string>)[category] ?? 'Other';
}

export function isLocalApp(app: ConnectedAppEntry): boolean {
  return app.source === 'local' || app.category === 'local';
}

function matchesCategory(app: ConnectedAppEntry, category: AppFilter): boolean {
  switch (category) {
    case 'all':
      return true;
    case 'featured':
      return Boolean(app.featured);
    case 'connected':
      return app.status === 'connected';
    case 'local':
      return isLocalApp(app);
    default:
      return app.category === category;
  }
}

function matchesQuery(app: ConnectedAppEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    app.name,
    app.description ?? '',
    app.id,
    app.composioSlug ?? '',
    categoryLabel(app.category),
    ...(app.capabilities ?? []),
  ]
    .join(' ')
    .toLowerCase();
  return q.split(/\s+/).every((word) => haystack.includes(word));
}

export function filterApps(
  apps: ConnectedAppEntry[],
  opts: { query?: string; category?: AppFilter | string } = {},
): ConnectedAppEntry[] {
  const category = (opts.category ?? 'all') as AppFilter;
  return apps.filter(
    (app) => matchesCategory(app, category) && matchesQuery(app, opts.query ?? ''),
  );
}

export interface GroupedApps {
  featured: ConnectedAppEntry[];
  connected: ConnectedAppEntry[];
  byCategory: Array<{ category: ConnectedAppCategory; label: string; apps: ConnectedAppEntry[] }>;
  local: ConnectedAppEntry[];
}

function byName(a: ConnectedAppEntry, b: ConnectedAppEntry): number {
  return a.name.localeCompare(b.name);
}

/**
 * Group apps for the hub's sections. Buckets overlap by design (a featured
 * app that is connected appears in both `featured` and `connected`); the hub
 * de-duplicates when rendering sections in order. `byCategory` follows
 * CATEGORY_ORDER, `local` holds every on-this-computer entry.
 */
export function groupApps(apps: ConnectedAppEntry[]): GroupedApps {
  const featured = apps.filter((a) => a.featured).sort(byName);
  const connected = apps.filter((a) => a.status === 'connected').sort(byName);
  const local = apps.filter(isLocalApp).sort(byName);
  const byCategory = CATEGORY_ORDER.map((category) => ({
    category,
    label: CATEGORY_LABELS[category],
    apps: apps.filter((a) => a.category === category).sort(byName),
  })).filter((group) => group.apps.length > 0);
  return { featured, connected, byCategory, local };
}

export function statusLabel(status: ConnectedAppStatus | string): string {
  switch (status) {
    case 'connected':
      return 'Connected';
    case 'available':
      return 'Available';
    case 'needs_platform_setup':
      return 'Needs platform setup';
    case 'not_in_catalog':
      return 'Not in your Composio workspace';
    case 'on_this_computer':
      return 'On this computer';
    case 'not_installed':
      return 'Not installed';
    default:
      return status;
  }
}

/** Chip tone suffix for the existing .chip classes (green/amber/blue/gray). */
export function statusTone(status: ConnectedAppStatus | string): 'green' | 'amber' | 'blue' | 'gray' {
  switch (status) {
    case 'connected':
    case 'on_this_computer':
      return 'green';
    case 'available':
      return 'blue';
    case 'needs_platform_setup':
      return 'amber';
    default:
      return 'gray';
  }
}

export function triggerKindLabel(kind: StarterTriggerKind | string): string {
  switch (kind) {
    case 'event':
      return 'Runs when…';
    case 'schedule':
      return 'On a schedule';
    default:
      return 'Manual';
  }
}

/**
 * Merge raw MCP servers into the aggregate list as source:'mcp' entries —
 * but only when the aggregate does not already carry MCP entries (the
 * backend may include them itself; never double-list).
 */
export function mergeMcpServers(
  apps: ConnectedAppEntry[],
  servers: unknown[],
): ConnectedAppEntry[] {
  if (apps.some((a) => a.source === 'mcp')) return apps;
  const entries: ConnectedAppEntry[] = [];
  for (const raw of servers) {
    if (!raw || typeof raw !== 'object') continue;
    const s = raw as { id?: unknown; name?: unknown; description?: unknown; enabled?: unknown };
    const id = typeof s.id === 'string' && s.id ? s.id : typeof s.name === 'string' ? s.name : '';
    if (!id) continue;
    entries.push({
      id: `mcp:${id}`,
      name: typeof s.name === 'string' && s.name ? s.name : id,
      description: typeof s.description === 'string' ? s.description : 'MCP server',
      category: 'development',
      source: 'mcp',
      connectionType: 'MCP server',
      status: s.enabled === false ? 'available' : 'connected',
      accounts: [],
      enabledBotIds: [],
      capabilities: [],
      starterTasks: [],
    });
  }
  return entries.length ? [...apps, ...entries] : apps;
}
