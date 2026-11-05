// SPDX-License-Identifier: Apache-2.0
// Connected Apps registry + aggregate read model (API side).
//
// ONE read model behind the Connected Apps surface: it merges every way
// KriyaDot can reach an outside app into a single honest view —
//
//   - Composio toolkits (catalog, connected accounts, per-bot enablement)
//   - first-party/native connections (OAuth providers, messaging channels)
//   - installed MCP servers
//   - a paired companion phone
//   - local apps on this computer (supplied by a later blender module
//     through `sources.localApps` — appended verbatim)
//
// Honesty rules enforced here:
//   - A featured app that is absent from the live Composio catalog is
//     reported `not_in_catalog` — never dressed up as connectable.
//   - Without a Composio platform key, featured apps are
//     `needs_platform_setup`, with their capabilities still visible.
//   - When the catalog cannot be loaded, the view says so
//     (`platform.catalogError`) and featured apps fall back to
//     `available` rather than a fabricated catalog verdict.
//   - No starter prompt anywhere in this module names a concrete
//     Composio action slug: every prompt instructs the bot to discover
//     real actions with composio_list_actions first and to use only an
//     action that tool returns.
//
// Wiring (coordinator, in routes.ts):
//   import { registerConnectedAppsRoutes } from './connected-apps.js';
//   registerConnectedAppsRoutes(router, deps);
//
// Routes (relative to the router mount, i.e. /api/...):
//   GET /connected-apps            → ConnectedAppsView for the caller
//   GET /connected-apps/need?slug=&botId=
//                                  → { need: ConnectionNeeded | null }
//                                    (null when the app is ready to use)

import express from 'express';
import type { Request, Response } from 'express';
import { accessSync, constants, existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { LazyMcpManager } from '@mvp/agent-runtime';
import type { RouteDeps } from './routes.js';
import { principalMiddleware, type PrincipalContext } from './principal.js';
import {
  composioCallerOf,
  composioEntityId,
  fetchComposioClient,
  getComposioApiKey,
  readComposioEnables,
  type ComposioApp,
  type ComposioClient,
  type ComposioConnectedAccount,
} from './composio.js';
import { readAccountCache } from './composio-accounts.js';
import { composioAppCapabilityFeatures, composioAppProfile } from './composio-apps.js';
import type { ProductFeatureDescriptor } from './capabilities.js';
import { getOAuthStatus, type OAuthStatus } from './oauth.js';
import { ChannelConnectionService } from './channel-connections.js';
import { CompanionStore } from './companion.js';

// ---------------------------------------------------------------------------
// JSON contract (EXACT — the web Connected Apps surface builds against this)
// ---------------------------------------------------------------------------

export type ConnectedAppStatus =
  | 'connected'
  | 'available'
  | 'needs_platform_setup'
  | 'not_in_catalog'
  | 'on_this_computer'
  | 'not_installed';

export type ConnectedAppCategory =
  | 'design-media'
  | 'social'
  | 'messaging'
  | 'productivity'
  | 'work'
  | 'development'
  | 'local'
  | 'other';

export interface ConnectedAppEntry {
  id: string;
  name: string;
  description?: string;
  logo?: string;
  category: ConnectedAppCategory;
  featured?: boolean;
  source: 'composio' | 'native' | 'mcp' | 'phone' | 'local';
  connectionType: string;
  status: ConnectedAppStatus;
  accounts: { id: string; label?: string; status: string }[];
  enabledBotIds: string[];
  capabilities: string[];
  starterTasks: { label: string; prompt: string }[];
  notes?: string;
  composioSlug?: string;
  modes?: { id: string; label: string; detail: string; status: ConnectedAppStatus }[];
  local?: { installed: boolean; version?: string; detectionNote?: string };
}

export interface ConnectedAppsView {
  platform: { configured: boolean; catalogError?: string };
  apps: ConnectedAppEntry[];
  generatedAt: number;
}

export interface ConnectionNeeded {
  kind: 'platform_not_configured' | 'not_in_catalog' | 'account_not_connected' | 'not_enabled_for_bot';
  appSlug: string;
  appName: string;
  botId?: string;
  message: string;
  action: { type: 'setup_platform' | 'connect_app' | 'enable_for_bot' | 'open_connected_apps'; href: string };
}

// ---------------------------------------------------------------------------
// Source overrides (tests + the later local-apps blender module)
// ---------------------------------------------------------------------------

export interface ChannelConnectionLike {
  providerId: string;
  displayName: string;
  status: string;
  connectedAt?: string;
}

export interface CompanionDeviceLike {
  id: string;
  name: string;
  platform?: string;
}

export interface ConnectedAppsSources {
  /** First-party OAuth statuses; default reads getOAuthStatus(dataDir). */
  oauthStatuses?: (dataDir: string) => OAuthStatus[] | Promise<OAuthStatus[]>;
  /** Messaging channel connections; default reads ChannelConnectionService read-only. */
  channelConnections?: (dataDir: string) => ChannelConnectionLike[] | Promise<ChannelConnectionLike[]>;
  /** Paired companion devices; default reads CompanionStore when its DB exists. */
  companionDevices?: (dataDir: string) => CompanionDeviceLike[] | Promise<CompanionDeviceLike[]>;
  /** Local-app entries from the coordinator's blender module — appended verbatim. */
  localApps?: () => ConnectedAppEntry[] | Promise<ConnectedAppEntry[]>;
  /**
   * Local detection for one app key (e.g. 'whatsapp'). Returning
   * undefined means "this source does not know" — the view then falls
   * back to a conservative PATH check instead of guessing.
   */
  localAppStatus?: (
    appKey: string,
  ) => Promise<{ installed: boolean; version?: string } | undefined> | { installed: boolean; version?: string } | undefined;
  /** Clock override (deterministic generatedAt in tests). */
  now?: () => number;
}

export type ConnectedAppsDeps = Pick<RouteDeps, 'config' | 'governance' | 'bots' | 'loopbackToken'> & {
  /** Injected in tests; defaults to the real fetch client in production. */
  composioClient?: ComposioClient;
  /** Tenancy JWT secret override (defaults to the KRIYADOT_TENANCY_JWT_SECRET env). */
  jwtSecret?: string;
  /** Installed MCP servers; when absent, no mcp entries are produced. */
  lazyMcpManager?: LazyMcpManager;
  /** Partial source overrides (tests, local-apps blender). */
  sources?: ConnectedAppsSources;
};

// ---------------------------------------------------------------------------
// Featured apps
// ---------------------------------------------------------------------------

export interface FeaturedAppDefinition {
  /** Composio toolkit slug. */
  slug: string;
  name: string;
  category: ConnectedAppCategory;
  /** Short plain-language blurb shown as the entry description. */
  blurb: string;
  /** 2–4 plain-language capabilities. */
  capabilities: string[];
  /** 2–3 starter tasks; prompts always start with real action discovery. */
  starterTasks: { label: string; prompt: string }[];
  notes?: string;
}

/**
 * The discovery preamble every featured starter prompt carries: the bot
 * must discover the toolkit's real actions with composio_list_actions
 * and use only an action that tool returns — no invented action slugs.
 */
function discoveryPreamble(slug: string): string {
  return (
    `First call composio_list_actions for ${slug} to discover the real actions available, ` +
    'and use only an action it returns — never invent an action name.'
  );
}

function starter(
  slug: string,
  label: string,
  task: string,
): { label: string; prompt: string } {
  return { label, prompt: `${discoveryPreamble(slug)} Then ${task}` };
}

export const FEATURED_APPS: FeaturedAppDefinition[] = [
  {
    slug: 'canva',
    name: 'Canva',
    category: 'design-media',
    blurb: 'Design graphics, presentations and social posts in Canva.',
    capabilities: ['Create new designs', 'Edit and update existing designs', 'Export finished designs'],
    starterTasks: [
      starter('canva', 'Make a social post design', 'create a design for an Instagram post announcing a new product launch.'),
      starter('canva', 'Find my recent designs', 'list my most recent designs and summarise what each one is for.'),
    ],
  },
  {
    slug: 'whatsapp',
    name: 'WhatsApp',
    category: 'messaging',
    blurb: 'Message customers through the WhatsApp Business API.',
    capabilities: [
      'Send WhatsApp Business messages to customers',
      'Read incoming business messages and their status',
      'Work with business message templates',
    ],
    starterTasks: [
      starter('whatsapp', 'Message a customer', 'send a WhatsApp Business message to a customer confirming their order has shipped.'),
      starter('whatsapp', 'Check recent conversations', 'list my recent WhatsApp Business conversations and flag any that are waiting for a reply.'),
    ],
    notes:
      'Business/API use only: this Composio connection acts through the WhatsApp Business / Cloud API on a business number. ' +
      'It is not your personal WhatsApp account, not your personal number, and not the WhatsApp app on your phone. ' +
      'Personal/desktop use is the separate Desktop mode below, and KriyaDot\u2019s own WhatsApp Cloud messaging channel is the separate Channel mode.',
  },
  {
    slug: 'instagram',
    name: 'Instagram',
    category: 'social',
    blurb: 'Work with your Instagram professional account.',
    capabilities: [
      'Read your Instagram professional profile',
      'List your Instagram media',
      'Publish media through your connected account',
    ],
    starterTasks: [
      starter('instagram', 'Review my profile', 'read my Instagram profile and recent media and summarise how the account is doing.'),
      starter('instagram', 'Publish a post', 'publish the photo I provide with a caption I approve first.'),
    ],
  },
  {
    slug: 'linkedin',
    name: 'LinkedIn',
    category: 'social',
    blurb: 'Post updates and follow your professional network on LinkedIn.',
    capabilities: ['Read your LinkedIn profile', 'Publish posts and updates', 'Read posts and engagement'],
    starterTasks: [
      starter('linkedin', 'Draft a post', 'draft a LinkedIn post about a recent project milestone and show it to me before posting.'),
      starter('linkedin', 'Check my profile', 'read my LinkedIn profile and point out anything incomplete or out of date.'),
    ],
  },
  {
    slug: 'gmail',
    name: 'Gmail',
    category: 'productivity',
    blurb: 'Read, search and send email in Gmail.',
    capabilities: ['Search and read email', 'Send email', 'Organise messages with labels'],
    starterTasks: [
      starter('gmail', 'Summarise my inbox', 'search my recent unread email and summarise the ones that need a reply.'),
      starter('gmail', 'Send an email', 'send an email with the subject and message I give you.'),
      starter('gmail', 'Find an email', 'search my email for the message I describe and show me what it says.'),
    ],
  },
  {
    slug: 'googlecalendar',
    name: 'Google Calendar',
    category: 'productivity',
    blurb: 'See your schedule and manage events in Google Calendar.',
    capabilities: ['List upcoming events', 'Create new events', 'Update or cancel events'],
    starterTasks: [
      starter('googlecalendar', 'What is on today?', 'list today\u2019s events in order with times.'),
      starter('googlecalendar', 'Schedule a meeting', 'create an event with the title, time and attendees I give you.'),
    ],
  },
  {
    slug: 'googledrive',
    name: 'Google Drive',
    category: 'productivity',
    blurb: 'Find, read and organise files in Google Drive.',
    capabilities: ['Search and find files', 'Read file contents', 'Organise files and folders'],
    starterTasks: [
      starter('googledrive', 'Find a file', 'search my Drive for the file I describe and tell me where it is.'),
      starter('googledrive', 'Summarise a document', 'find the document I name, read it, and summarise the key points.'),
    ],
  },
  {
    slug: 'slack',
    name: 'Slack',
    category: 'messaging',
    blurb: 'Read and post messages in your Slack workspace.',
    capabilities: ['Read channel messages', 'Post messages to channels', 'Search conversations'],
    starterTasks: [
      starter('slack', 'Catch me up', 'read the recent messages in the channel I name and summarise what I missed.'),
      starter('slack', 'Post an update', 'post the update I give you to the channel I name.'),
    ],
  },
  {
    slug: 'github',
    name: 'GitHub',
    category: 'development',
    blurb: 'Work with your GitHub repositories, issues and pull requests.',
    capabilities: ['Read repositories, issues and pull requests', 'Create and update issues', 'Comment on issues and pull requests'],
    starterTasks: [
      starter('github', 'Triage my issues', 'list the open issues on the repository I name and group them by urgency.'),
      starter('github', 'Check pull requests', 'list the open pull requests on the repository I name and summarise what each changes.'),
    ],
  },
  {
    slug: 'notion',
    name: 'Notion',
    category: 'productivity',
    blurb: 'Search, read and update pages in your Notion workspace.',
    capabilities: ['Search pages and databases', 'Read page contents', 'Create and update pages'],
    starterTasks: [
      starter('notion', 'Find a note', 'search my Notion workspace for the page I describe and summarise it.'),
      starter('notion', 'Save a note', 'create a new Notion page with the notes I give you.'),
    ],
  },
  {
    slug: 'youtube',
    name: 'YouTube',
    category: 'social',
    blurb: 'Manage your YouTube channel and videos.',
    capabilities: ['Read channel and video details', 'Update video titles and descriptions', 'Read comments and channel activity'],
    starterTasks: [
      starter('youtube', 'Review my channel', 'read my channel\u2019s recent videos and summarise their performance from the data available.'),
      starter('youtube', 'Update a video', 'update the title and description of the video I name, showing me the changes first.'),
    ],
  },
  {
    slug: 'tiktok',
    name: 'TikTok',
    category: 'social',
    blurb: 'Work with your TikTok account and videos.',
    capabilities: ['Read your TikTok profile', 'List your videos', 'Read video performance details'],
    starterTasks: [
      starter('tiktok', 'Review my videos', 'list my recent TikTok videos and summarise what each one is about.'),
      starter('tiktok', 'Check my profile', 'read my TikTok profile and tell me what it currently shows.'),
    ],
  },
  {
    slug: 'facebook',
    name: 'Facebook',
    category: 'social',
    blurb: 'Work with your Facebook Pages.',
    capabilities: [
      'Read your Facebook Pages, posts and insights',
      'Publish posts to your Facebook Pages',
    ],
    starterTasks: [
      starter('facebook', 'Review my Pages', 'list my Facebook Pages and summarise recent posts and insights for each.'),
      starter('facebook', 'Publish a Page post', 'publish the post I give you to the Page I name, after I approve the text.'),
    ],
    notes: 'Personal-profile posting is not part of this surface — Page actions only.',
  },
  {
    slug: 'figma',
    name: 'Figma',
    category: 'design-media',
    blurb: 'Read design files and comments in Figma.',
    capabilities: ['Read design files and their structure', 'Read comments on designs', 'Export design assets'],
    starterTasks: [
      starter('figma', 'Review a design file', 'read the Figma file I link and summarise its screens and structure.'),
      starter('figma', 'Check design comments', 'list the open comments on the Figma file I name.'),
    ],
  },
  {
    slug: 'shopify',
    name: 'Shopify',
    category: 'work',
    blurb: 'Run your Shopify store.',
    capabilities: [
      'List and read store products and orders',
      'Create and update products',
    ],
    starterTasks: [
      starter('shopify', 'Review recent orders', 'list my store\u2019s recent orders and flag any that need attention.'),
      starter('shopify', 'Check my products', 'list my store\u2019s products and point out any with missing details.'),
    ],
  },
  {
    slug: 'zoom',
    name: 'Zoom',
    category: 'work',
    blurb: 'Schedule and manage Zoom meetings.',
    capabilities: ['List upcoming meetings', 'Schedule new meetings', 'Read meeting recordings and details'],
    starterTasks: [
      starter('zoom', 'List my meetings', 'list my upcoming Zoom meetings with times and participants.'),
      starter('zoom', 'Schedule a meeting', 'schedule a Zoom meeting with the time and attendees I give you.'),
    ],
  },
];

export function featuredAppDefinition(slug: string): FeaturedAppDefinition | undefined {
  return FEATURED_APPS.find((f) => f.slug === slug.toLowerCase());
}

// ---------------------------------------------------------------------------
// Connection-need classifier (pure)
// ---------------------------------------------------------------------------

export function classifyConnectionNeed(input: {
  platformConfigured: boolean;
  inCatalog: boolean;
  hasActiveAccount: boolean;
  enabledForBot: boolean;
  appSlug: string;
  appName: string;
  botId?: string;
}): ConnectionNeeded | { kind: 'ready' } {
  const slug = input.appSlug;
  const href = `/accounts?app=${encodeURIComponent(slug)}`;
  const botPart = input.botId ? { botId: input.botId } : {};
  // Precedence: platform → catalog → account → enablement.
  if (!input.platformConfigured) {
    return {
      kind: 'platform_not_configured',
      appSlug: slug,
      appName: input.appName,
      ...botPart,
      message: `Composio is not set up yet — add the platform API key before connecting ${input.appName}.`,
      action: { type: 'setup_platform', href: `${href}&setup=platform` },
    };
  }
  if (!input.inCatalog) {
    return {
      kind: 'not_in_catalog',
      appSlug: slug,
      appName: input.appName,
      ...botPart,
      message: `${input.appName} is not in the Composio catalog, so it cannot be connected through Composio.`,
      action: { type: 'open_connected_apps', href },
    };
  }
  if (!input.hasActiveAccount) {
    return {
      kind: 'account_not_connected',
      appSlug: slug,
      appName: input.appName,
      ...botPart,
      message: `No active ${input.appName} account is connected yet — connect one to let bots use it.`,
      action: { type: 'connect_app', href },
    };
  }
  if (!input.enabledForBot) {
    return {
      kind: 'not_enabled_for_bot',
      appSlug: slug,
      appName: input.appName,
      ...botPart,
      message: input.botId
        ? `${input.appName} is connected but not enabled for bot "${input.botId}" — enable it for that bot first.`
        : `${input.appName} is connected but not enabled for this bot — enable it first.`,
      action: { type: 'enable_for_bot', href },
    };
  }
  return { kind: 'ready' };
}

// ---------------------------------------------------------------------------
// Capability-registry descriptors for the featured apps not already covered
// by composioAppCapabilityFeatures() (facebook, instagram, shopify — and
// the non-featured messenger, spotify, threads — are covered there).
// ---------------------------------------------------------------------------

export function connectedAppCapabilityFeatures(): ProductFeatureDescriptor[] {
  const covered = new Set(composioAppCapabilityFeatures().map((f) => f.slug.replace(/^composio-/, '')));
  return FEATURED_APPS.filter((f) => !covered.has(f.slug)).map((f) => ({
    slug: `composio-${f.slug}`,
    name: `${f.name} (via Composio)`,
    whatItDoes: f.blurb,
    whenToUse:
      `When the user asks about their ${f.name} and it is connected in Connected Apps and enabled for the bot.`,
    invoke: {
      type: 'tool' as const,
      toolName: 'composio_call',
      description:
        `Discover the real actions first with composio_list_actions (use only actions it returns — never invent one), ` +
        `then execute with composio_call (approval-gated). Requires a connected ${f.name} account in Connected Apps ` +
        'plus per-bot enablement for this bot.',
    },
    keywords: [f.slug, f.name.toLowerCase(), 'composio', 'connected app', ...f.capabilities.map((c) => c.toLowerCase())],
  }));
}

// ---------------------------------------------------------------------------
// View building blocks
// ---------------------------------------------------------------------------

function mapComposioCategory(categories: string[] | undefined): ConnectedAppCategory {
  const text = (categories ?? []).join(' ').toLowerCase();
  if (/design|media|creative|photo|video|image/.test(text)) return 'design-media';
  if (/social/.test(text)) return 'social';
  if (/messag|chat|communication|email/.test(text)) return 'messaging';
  if (/productiv|notes|docs|storage|calendar/.test(text)) return 'productivity';
  if (/develop|code|devops|git/.test(text)) return 'development';
  if (/work|business|crm|sales|commerce|shop|marketing|finance/.test(text)) return 'work';
  if (/local/.test(text)) return 'local';
  return 'other';
}

function enabledBotIdsFor(
  enables: Record<string, Record<string, boolean>>,
  slug: string,
): string[] {
  return Object.entries(enables)
    .filter(([, apps]) => apps?.[slug] === true)
    .map(([botId]) => botId)
    .sort();
}

function accountsForSlug(
  accounts: ComposioConnectedAccount[],
  cache: Record<string, { label?: string }>,
  slug: string,
): { id: string; label?: string; status: string }[] {
  return accounts
    .filter((a) => a.toolkitSlug.toLowerCase() === slug)
    .map((a) => ({
      id: a.id,
      // The local cache label wins over anything Composio reports.
      ...(cache[a.id]?.label ? { label: cache[a.id]!.label } : {}),
      status: a.status,
    }));
}

function hasActiveAccount(accounts: ComposioConnectedAccount[], slug: string): boolean {
  return accounts.some(
    (a) => a.toolkitSlug.toLowerCase() === slug && a.status.toUpperCase() === 'ACTIVE',
  );
}

interface ComposioState {
  configured: boolean;
  catalog: ComposioApp[] | null;
  catalogError?: string;
  accounts: ComposioConnectedAccount[];
}

async function loadComposioState(
  deps: ConnectedAppsDeps,
  userId: string,
): Promise<ComposioState> {
  const dataDir = deps.config.dataDir;
  const apiKey = getComposioApiKey(dataDir, userId);
  if (!apiKey) return { configured: false, catalog: null, accounts: [] };
  const client: ComposioClient = deps.composioClient ?? fetchComposioClient;
  let catalog: ComposioApp[] | null = null;
  let catalogError: string | undefined;
  try {
    catalog = await client.listApps(apiKey);
  } catch (err) {
    catalogError = err instanceof Error ? err.message : String(err);
  }
  let accounts: ComposioConnectedAccount[] = [];
  try {
    accounts = await client.listConnectedAccounts(apiKey, composioEntityId(userId));
  } catch {
    // Account lookup failure degrades to "no accounts known" — the
    // catalog verdict above stays authoritative for presence.
    accounts = [];
  }
  return { configured: true, catalog, ...(catalogError ? { catalogError } : {}), accounts };
}

async function resolveChannels(deps: ConnectedAppsDeps): Promise<ChannelConnectionLike[]> {
  const dataDir = deps.config.dataDir;
  try {
    if (deps.sources?.channelConnections) return await deps.sources.channelConnections(dataDir);
    // Read-only construction: the injected key hooks never write.
    const service = new ChannelConnectionService({
      dataDir,
      saveKey: () => {},
      removeKey: () => false,
    });
    return service.listConnections();
  } catch {
    return [];
  }
}

async function resolveOAuth(deps: ConnectedAppsDeps): Promise<OAuthStatus[]> {
  const dataDir = deps.config.dataDir;
  try {
    if (deps.sources?.oauthStatuses) return await deps.sources.oauthStatuses(dataDir);
    return getOAuthStatus(dataDir);
  } catch {
    return [];
  }
}

async function resolveDevices(deps: ConnectedAppsDeps): Promise<CompanionDeviceLike[]> {
  const dataDir = deps.config.dataDir;
  try {
    if (deps.sources?.companionDevices) return await deps.sources.companionDevices(dataDir);
    // Only open the store when a companion DB already exists — a read
    // must not create one as a side effect.
    if (!existsSync(join(dataDir, 'companion.db'))) return [];
    return new CompanionStore(dataDir).listDevices();
  } catch {
    return [];
  }
}

async function resolveLocalApps(deps: ConnectedAppsDeps): Promise<ConnectedAppEntry[]> {
  try {
    if (deps.sources?.localApps) return await deps.sources.localApps();
  } catch {
    // A failing local source must not sink the whole view.
  }
  return [];
}

/** Executable names tried for the WhatsApp Desktop PATH check (Linux). */
const WHATSAPP_LINUX_NAMES = ['whatsapp', 'whatsapp-desktop', 'WhatsApp'];

function detectOnPath(names: string[]): string | undefined {
  if (process.platform !== 'linux') return undefined;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      try {
        accessSync(join(dir, name), constants.X_OK);
        return name;
      } catch {
        // Not in this dir — keep looking.
      }
    }
  }
  return undefined;
}

interface DesktopDetection {
  status: ConnectedAppStatus;
  installed: boolean;
  version?: string;
  detail: string;
}

async function resolveWhatsappDesktop(
  deps: ConnectedAppsDeps,
  localEntries: ConnectedAppEntry[],
): Promise<DesktopDetection> {
  // 1. Injected detection source wins when it actually knows.
  if (deps.sources?.localAppStatus) {
    try {
      const known = await deps.sources.localAppStatus('whatsapp');
      if (known !== undefined) {
        return known.installed
          ? {
              status: 'on_this_computer',
              installed: true,
              ...(known.version ? { version: known.version } : {}),
              detail: `WhatsApp Desktop was detected on this computer${known.version ? ` (version ${known.version})` : ''}.`,
            }
          : {
              status: 'not_installed',
              installed: false,
              detail: 'WhatsApp Desktop on this computer (not detected — a bot can still try to open it)',
            };
      }
    } catch {
      // Fall through to the other detectors.
    }
  }
  // 2. A local-apps blender entry for WhatsApp, when one was supplied.
  const localEntry = localEntries.find(
    (e) =>
      e.source === 'local' &&
      (e.id === 'whatsapp' || e.id === 'local:whatsapp' || e.composioSlug === 'whatsapp'),
  );
  if (localEntry) {
    const installed =
      localEntry.local?.installed ?? (localEntry.status === 'on_this_computer' || localEntry.status === 'connected');
    return {
      status: installed ? 'on_this_computer' : 'not_installed',
      installed,
      ...(localEntry.local?.version ? { version: localEntry.local.version } : {}),
      detail:
        localEntry.local?.detectionNote ??
        localEntry.description ??
        (installed
          ? 'WhatsApp Desktop was detected on this computer.'
          : 'WhatsApp Desktop on this computer (not detected — a bot can still try to open it)'),
    };
  }
  // 3. Conservative PATH check (Linux executable names only). Anything
  //    not found is reported not_installed, with the uncertainty stated
  //    in the detail text — never claimed as a definitive absence.
  const found = detectOnPath(WHATSAPP_LINUX_NAMES);
  if (found) {
    return {
      status: 'on_this_computer',
      installed: true,
      detail: `WhatsApp Desktop was detected on this computer (found "${found}" on PATH).`,
    };
  }
  return {
    status: 'not_installed',
    installed: false,
    detail: 'WhatsApp Desktop on this computer (not detected — a bot can still try to open it)',
  };
}

// ---------------------------------------------------------------------------
// buildConnectedAppsView
// ---------------------------------------------------------------------------

export async function buildConnectedAppsView(
  deps: ConnectedAppsDeps,
  userId: string,
): Promise<ConnectedAppsView> {
  const dataDir = deps.config.dataDir;
  const sources = deps.sources;
  const state = await loadComposioState(deps, userId);
  const enables = readComposioEnables(dataDir, userId);
  const cache = readAccountCache(dataDir, userId);
  const channels = await resolveChannels(deps);
  const localEntries = await resolveLocalApps(deps);

  const apps: ConnectedAppEntry[] = [];
  const catalogBySlug = new Map<string, ComposioApp>();
  for (const app of state.catalog ?? []) catalogBySlug.set(app.appId.toLowerCase(), app);

  const whatsappChannel = channels.find((c) => c.providerId === 'whatsapp');
  const whatsappChannelStatus: ConnectedAppStatus =
    whatsappChannel?.status === 'connected' ? 'connected' : 'available';

  // -- Composio featured apps, in featured order. -------------------------
  for (const featured of FEATURED_APPS) {
    const slug = featured.slug;
    const catalogApp = catalogBySlug.get(slug);
    const accounts = state.configured ? accountsForSlug(state.accounts, cache, slug) : [];
    const active = hasActiveAccount(state.accounts, slug);
    let status: ConnectedAppStatus;
    if (!state.configured) status = 'needs_platform_setup';
    else if (state.catalogError) status = active ? 'connected' : 'available';
    else if (!catalogApp) status = 'not_in_catalog';
    else status = active ? 'connected' : 'available';

    const entry: ConnectedAppEntry = {
      id: slug,
      name: catalogApp?.name ?? featured.name,
      // Profile summaries are resolved here, at request time — NOT in the
      // FEATURED_APPS literal above: composio-apps -> composio-tools ->
      // connected-apps is an import cycle, so calling composioAppProfile()
      // during module init can hit a not-yet-initialized binding.
      description: catalogApp?.description ?? composioAppProfile(slug)?.summary ?? featured.blurb,
      ...(catalogApp?.logo ? { logo: catalogApp.logo } : {}),
      category: featured.category,
      featured: true,
      source: 'composio',
      connectionType: 'composio',
      status,
      accounts,
      enabledBotIds: enabledBotIdsFor(enables, slug),
      capabilities: featured.capabilities,
      starterTasks: featured.starterTasks,
      ...(featured.notes ? { notes: featured.notes } : {}),
      composioSlug: slug,
    };

    if (slug === 'whatsapp') {
      const desktop = await resolveWhatsappDesktop(deps, localEntries);
      entry.modes = [
        {
          id: 'business-api',
          label: 'Business API',
          detail:
            'WhatsApp Business / Cloud API through Composio — messaging for a business number, not a personal WhatsApp account.',
          status,
        },
        {
          id: 'channel',
          label: 'Channel',
          detail:
            whatsappChannelStatus === 'connected'
              ? 'KriyaDot\u2019s own WhatsApp Cloud messaging channel is connected.'
              : 'KriyaDot\u2019s own WhatsApp Cloud messaging channel is not connected yet.',
          status: whatsappChannelStatus,
        },
        {
          id: 'desktop',
          label: 'Desktop',
          detail: desktop.detail,
          status: desktop.status,
        },
      ];
      entry.local = {
        installed: desktop.installed,
        ...(desktop.version ? { version: desktop.version } : {}),
        detectionNote: desktop.detail,
      };
    }
    apps.push(entry);
  }

  // -- Non-featured catalog apps (only with a successfully loaded catalog).
  if (state.configured && state.catalog) {
    const featuredSlugs = new Set(FEATURED_APPS.map((f) => f.slug));
    const rest = state.catalog
      .filter((a) => !featuredSlugs.has(a.appId.toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const app of rest) {
      const slug = app.appId.toLowerCase();
      apps.push({
        id: slug,
        name: app.name,
        ...(app.description ? { description: app.description } : {}),
        ...(app.logo ? { logo: app.logo } : {}),
        category: mapComposioCategory(app.categories),
        source: 'composio',
        connectionType: 'composio',
        status: hasActiveAccount(state.accounts, slug) ? 'connected' : 'available',
        accounts: accountsForSlug(state.accounts, cache, slug),
        enabledBotIds: enabledBotIdsFor(enables, slug),
        capabilities: [],
        starterTasks: [],
        composioSlug: slug,
      });
    }
  }

  // -- Native: first-party OAuth providers. -------------------------------
  for (const s of await resolveOAuth(deps)) {
    const isGoogle = s.id === 'google';
    apps.push({
      id: `oauth:${s.id}`,
      name: s.name,
      description: isGoogle
        ? 'Gmail, Calendar and Drive through KriyaDot\u2019s own Google OAuth connection (not Composio).'
        : `${s.name} through KriyaDot\u2019s own OAuth connection (not Composio).`,
      category: 'productivity',
      source: 'native',
      connectionType: 'native-oauth',
      status: s.connected ? 'connected' : 'available',
      accounts: s.connected ? [{ id: s.id, label: s.name, status: 'connected' }] : [],
      enabledBotIds: [],
      capabilities: isGoogle
        ? ['Read Gmail messages', 'Read Google Calendar events', 'Search Google Drive files']
        : [`Use the connected ${s.name} account`],
      starterTasks: isGoogle
        ? [
            { label: 'Summarise my inbox', prompt: 'Use my connected Google account to summarise my most recent important emails.' },
            { label: 'What is on today?', prompt: 'Use my connected Google Calendar to list today\u2019s events in order.' },
          ]
        : [],
    });
  }

  // -- Native: messaging channel connections. -----------------------------
  for (const c of channels) {
    const isWhatsapp = c.providerId === 'whatsapp';
    const name = isWhatsapp ? 'WhatsApp (Business channel)' : c.displayName;
    const connected = c.status === 'connected';
    apps.push({
      id: `channel:${c.providerId}`,
      name,
      description: `${c.displayName} messaging channel — bots talk to users on ${c.displayName} through KriyaDot\u2019s channel connection.`,
      category: 'messaging',
      source: 'native',
      connectionType: 'messaging-channel',
      status: connected ? 'connected' : 'available',
      accounts: connected ? [{ id: c.providerId, label: name, status: 'connected' }] : [],
      enabledBotIds: [],
      capabilities: [`Send messages on ${c.displayName}`, `Receive messages on ${c.displayName}`],
      starterTasks: [
        {
          label: `Send a ${c.displayName} message`,
          prompt: `Send the message I give you on ${c.displayName} using the connected KriyaDot channel.`,
        },
      ],
    });
  }

  // -- MCP servers (only when a manager was supplied). --------------------
  const manager = deps.lazyMcpManager;
  if (manager) {
    try {
      for (const server of manager.list()) {
        const label = server.label || server.id;
        const kind = (server.config as { kind?: string } | undefined)?.kind;
        apps.push({
          id: `mcp:${server.id}`,
          name: label,
          description: `Installed MCP server${kind ? ` (${kind})` : ''} — its tools are available to bots through the MCP bridge.`,
          category: 'development',
          source: 'mcp',
          connectionType: 'mcp-server',
          status: 'connected',
          accounts: [],
          enabledBotIds: [],
          capabilities: [`Tools provided by the ${label} MCP server`],
          starterTasks: [],
        });
      }
    } catch {
      // A broken MCP store must not sink the whole view.
    }
  }

  // -- Paired companion phone. --------------------------------------------
  const devices = await resolveDevices(deps);
  if (devices.length > 0) {
    apps.push({
      id: 'phone',
      name: 'Paired phone',
      description: 'Your paired phone can follow runs, decide approvals and control bots.',
      category: 'local',
      source: 'phone',
      connectionType: 'paired-phone',
      status: 'connected',
      accounts: devices.map((d) => ({ id: d.id, label: d.name, status: 'connected' })),
      enabledBotIds: [],
      capabilities: ['See run status and approvals on your phone', 'Control bots from your phone'],
      starterTasks: [],
    });
  } else {
    apps.push({
      id: 'phone',
      name: 'Paired phone',
      description: 'Pair your phone to follow runs, decide approvals and control bots from anywhere.',
      category: 'local',
      source: 'phone',
      connectionType: 'paired-phone',
      status: 'available',
      accounts: [],
      enabledBotIds: [],
      capabilities: ['See run status and approvals on your phone', 'Control bots from your phone'],
      starterTasks: [
        {
          label: 'Pair my phone',
          prompt: 'Help me pair my phone with KriyaDot so I can follow runs and decide approvals from it.',
        },
      ],
    });
  }

  // -- Local apps from the blender module, appended verbatim. -------------
  apps.push(...localEntries);

  return {
    platform: {
      configured: state.configured,
      ...(state.catalogError ? { catalogError: state.catalogError } : {}),
    },
    apps,
    generatedAt: sources?.now ? sources.now() : Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Live connection-need computation (for the /need route)
// ---------------------------------------------------------------------------

async function computeConnectionNeed(
  deps: ConnectedAppsDeps,
  userId: string,
  slug: string,
  botId?: string,
): Promise<ConnectionNeeded | { kind: 'ready' }> {
  const state = await loadComposioState(deps, userId);
  const featured = featuredAppDefinition(slug);
  const catalogApp = state.catalog?.find((a) => a.appId.toLowerCase() === slug);
  const appName = featured?.name ?? catalogApp?.name ?? slug;
  // On a catalog error, presence is unknown — never claim not_in_catalog.
  const inCatalog = state.catalogError ? true : Boolean(catalogApp);
  const enables = readComposioEnables(deps.config.dataDir, userId);
  return classifyConnectionNeed({
    platformConfigured: state.configured,
    inCatalog,
    hasActiveAccount: hasActiveAccount(state.accounts, slug),
    enabledForBot: botId ? enables[botId]?.[slug] === true : true,
    appSlug: slug,
    appName,
    ...(botId ? { botId } : {}),
  });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerConnectedAppsRoutes(router: express.Router, deps: ConnectedAppsDeps): void {
  const pctx: PrincipalContext = {
    dataDir: deps.config.dataDir,
    loopbackToken: deps.loopbackToken,
    jwtSecret: deps.jwtSecret,
  };

  function callerOf(req: Request): string {
    const userId = composioCallerOf(req, pctx);
    if (!userId) throw new Error('unauthenticated');
    return userId;
  }

  const r = express.Router();
  r.use(principalMiddleware(pctx));

  // GET /connected-apps — the aggregate view for the caller.
  r.get('/', async (req: Request, res: Response) => {
    try {
      res.json(await buildConnectedAppsView(deps, callerOf(req)));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: 'Failed to build the connected-apps view', detail: message });
    }
  });

  // GET /connected-apps/need?slug=&botId= — what stands between the
  // caller and using one app, computed against live state. null = ready.
  r.get('/need', async (req: Request, res: Response) => {
    const slugRaw = typeof req.query.slug === 'string' ? req.query.slug.trim().toLowerCase() : '';
    if (!slugRaw) {
      res.status(400).json({ error: 'slug is required' });
      return;
    }
    const botId = typeof req.query.botId === 'string' && req.query.botId ? req.query.botId : undefined;
    if (botId && !deps.bots.find((b) => b.id === botId)) {
      res.status(404).json({ error: `unknown bot: ${botId}` });
      return;
    }
    try {
      const need = await computeConnectionNeed(deps, callerOf(req), slugRaw, botId);
      res.json({ need: need.kind === 'ready' ? null : need });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: 'Failed to compute the connection need', detail: message });
    }
  });

  router.use('/connected-apps', r);
}
