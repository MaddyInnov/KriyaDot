// SPDX-License-Identifier: Apache-2.0
// Verified Composio app profiles (Muse parity audit §4.12: CN-4 / CN-5 /
// CN-6 / CN-8 — one workstream).
//
// The Composio bridge (composio.ts + composio-tools.ts) is generic: any
// of 1,000+ toolkits COULD flow through composio_call once a user
// connects an account and enables the app for a bot. "Could" is a
// catalog possibility, not a capability. This module promotes six apps
// to VERIFIED, DOCUMENTED bot capabilities:
//
//   facebook (CN-4) · messenger (CN-4) · instagram (CN-5) ·
//   spotify (CN-5) · threads (CN-5) · shopify (CN-6)
//
// For each app this module ships:
//   - a profile: toolkit slug, what a bot can actually do with it, and a
//     set of REPRESENTATIVE actions (slug, name, read/write access) that
//     define the documented capability surface;
//   - verifyComposioAppWiring(): an end-to-end wiring check against an
//     injected ComposioClient — catalog presence, an ACTIVE connected
//     account, per-bot enablement, representative actions present in
//     the toolkit's live action list, and the bridge surface itself
//     (both tools registered, policy rules intact). It reports per-check
//     results HONESTLY: a representative action missing from the live
//     catalog is reported missing, never papered over. In tests the
//     client is a mock (zero live Composio calls); the host can run the
//     same check against the real client when a key is connected.
//   - capability-registry descriptors (composioAppCapabilityFeatures)
//     shaped for capabilities.ts PRODUCT_FEATURES, so the apps appear
//     in the product-wide capability registry once the host adds them
//     (see the WIRING note — capabilities.ts is host-owned).
//
// Governance is NOT weakened anywhere here: execution still flows
// through composio_call (approval-gated, per-bot enablement enforced in
// the handler, thread overrides still narrow). The profiles only
// document and verify what the bridge already enforces.

import {
  COMPOSIO_TOOL_NAMES,
  composioEntityId,
  readComposioEnables,
  type ComposioClient,
} from './composio.js';
import { composioToolPolicies } from './composio-tools.js';
import { readAccountCache } from './composio-accounts.js';
import type { ProductFeatureDescriptor } from './capabilities.js';

// ---------------------------------------------------------------------------
// App profiles
// ---------------------------------------------------------------------------

export interface ComposioRepresentativeAction {
  /** Composio action slug as it appears in the toolkit's action catalog. */
  slug: string;
  name: string;
  access: 'read' | 'write';
}

export interface ComposioAppProfile {
  /** Composio toolkit slug — also the enablement key in composio-enables.json. */
  toolkitSlug: string;
  displayName: string;
  /** Audit row(s) this profile closes. */
  auditRows: string[];
  /** What a bot can do with this app, in plain language (docs + capability registry). */
  summary: string;
  /** The documented capability surface: representative actions per app. */
  representativeActions: ComposioRepresentativeAction[];
  notes?: string;
}

export const VERIFIED_COMPOSIO_APPS: ComposioAppProfile[] = [
  {
    toolkitSlug: 'facebook',
    displayName: 'Facebook',
    auditRows: ['CN-4'],
    summary:
      'Act on the user\u2019s Facebook Pages through their connected account: read page posts and insights, publish page posts. Personal-profile posting is not part of the documented surface.',
    representativeActions: [
      { slug: 'FACEBOOK_LIST_PAGES', name: 'List Pages', access: 'read' },
      { slug: 'FACEBOOK_GET_PAGE_POSTS', name: 'Get page posts', access: 'read' },
      { slug: 'FACEBOOK_GET_PAGE_INSIGHTS', name: 'Get page insights', access: 'read' },
      { slug: 'FACEBOOK_CREATE_PAGE_POST', name: 'Create page post', access: 'write' },
    ],
  },
  {
    toolkitSlug: 'messenger',
    displayName: 'Messenger',
    auditRows: ['CN-4'],
    summary:
      'Read and reply in Messenger conversations attached to the user\u2019s connected Facebook Page: list conversations, read a thread, send a reply (approval-gated like every composio_call).',
    representativeActions: [
      { slug: 'MESSENGER_LIST_CONVERSATIONS', name: 'List conversations', access: 'read' },
      { slug: 'MESSENGER_GET_CONVERSATION_MESSAGES', name: 'Get conversation messages', access: 'read' },
      { slug: 'MESSENGER_SEND_MESSAGE', name: 'Send message', access: 'write' },
    ],
    notes: 'Messenger access rides on a connected Page; without one the account check in verifyComposioAppWiring fails honestly.',
  },
  {
    toolkitSlug: 'instagram',
    displayName: 'Instagram',
    auditRows: ['CN-5'],
    summary:
      'Work with the user\u2019s Instagram professional account: read the profile and media list, publish media through the connected account (approval-gated).',
    representativeActions: [
      { slug: 'INSTAGRAM_GET_PROFILE', name: 'Get profile', access: 'read' },
      { slug: 'INSTAGRAM_LIST_MEDIA', name: 'List media', access: 'read' },
      { slug: 'INSTAGRAM_CREATE_MEDIA_CONTAINER', name: 'Create media container', access: 'write' },
      { slug: 'INSTAGRAM_PUBLISH_MEDIA', name: 'Publish media', access: 'write' },
    ],
  },
  {
    toolkitSlug: 'spotify',
    displayName: 'Spotify',
    auditRows: ['CN-5'],
    summary:
      'Search the Spotify catalog, see what is playing, and manage the user\u2019s playlists: create a playlist and add tracks (approval-gated writes).',
    representativeActions: [
      { slug: 'SPOTIFY_SEARCH_TRACKS', name: 'Search tracks', access: 'read' },
      { slug: 'SPOTIFY_GET_CURRENTLY_PLAYING', name: 'Get currently playing', access: 'read' },
      { slug: 'SPOTIFY_CREATE_PLAYLIST', name: 'Create playlist', access: 'write' },
      { slug: 'SPOTIFY_ADD_TRACKS_TO_PLAYLIST', name: 'Add tracks to playlist', access: 'write' },
    ],
  },
  {
    toolkitSlug: 'threads',
    displayName: 'Threads',
    auditRows: ['CN-5'],
    summary:
      'Read the user\u2019s Threads profile and posts and publish new posts through the connected account (approval-gated).',
    representativeActions: [
      { slug: 'THREADS_GET_PROFILE', name: 'Get profile', access: 'read' },
      { slug: 'THREADS_LIST_POSTS', name: 'List posts', access: 'read' },
      { slug: 'THREADS_CREATE_POST', name: 'Create post', access: 'write' },
    ],
  },
  {
    toolkitSlug: 'shopify',
    displayName: 'Shopify',
    auditRows: ['CN-6'],
    summary:
      'Run the user\u2019s Shopify store through their connected account: list and read products and orders, create and update products (approval-gated writes).',
    representativeActions: [
      { slug: 'SHOPIFY_LIST_PRODUCTS', name: 'List products', access: 'read' },
      { slug: 'SHOPIFY_GET_PRODUCT', name: 'Get product', access: 'read' },
      { slug: 'SHOPIFY_LIST_ORDERS', name: 'List orders', access: 'read' },
      { slug: 'SHOPIFY_CREATE_PRODUCT', name: 'Create product', access: 'write' },
      { slug: 'SHOPIFY_UPDATE_PRODUCT', name: 'Update product', access: 'write' },
    ],
  },
];

export function composioAppProfile(toolkitSlug: string): ComposioAppProfile | undefined {
  return VERIFIED_COMPOSIO_APPS.find((p) => p.toolkitSlug === toolkitSlug.toLowerCase());
}

// ---------------------------------------------------------------------------
// End-to-end wiring verification
// ---------------------------------------------------------------------------

export interface ComposioWiringCheck {
  id: 'catalog' | 'account' | 'enablement' | 'actions' | 'bridge';
  ok: boolean;
  detail: string;
}

export interface ComposioAppWiringReport {
  toolkitSlug: string;
  displayName: string;
  /** True only when every check passes. */
  ok: boolean;
  checks: ComposioWiringCheck[];
  /** Representative actions ABSENT from the toolkit's live action list. */
  missingActions: string[];
  /** Representative actions present (verified against the action list). */
  foundActions: string[];
  /** ACTIVE connected account id used for the account check, when any. */
  accountId?: string;
}

export interface VerifyComposioAppOptions {
  client: ComposioClient;
  apiKey: string;
  dataDir: string;
  userId: string;
  botId: string;
  toolkitSlug: string;
}

/**
 * Verify one app end-to-end. Every step is checked against the injected
 * client + the local stores the bridge itself uses (account cache,
 * enables file, policy rules) — the same evidence a live run would
 * traverse. Nothing is executed: verification is read-only.
 */
export async function verifyComposioAppWiring(
  opts: VerifyComposioAppOptions,
): Promise<ComposioAppWiringReport> {
  const profile = composioAppProfile(opts.toolkitSlug);
  if (!profile) {
    throw new Error(`no verified profile for toolkit "${opts.toolkitSlug}" — see VERIFIED_COMPOSIO_APPS`);
  }
  const slug = profile.toolkitSlug;
  const checks: ComposioWiringCheck[] = [];

  // 1. Catalog: the toolkit exists in the connected Composio catalog.
  let catalogOk = false;
  try {
    const apps = await opts.client.listApps(opts.apiKey);
    catalogOk = apps.some((a) => a.appId === slug);
    checks.push({
      id: 'catalog',
      ok: catalogOk,
      detail: catalogOk ? `toolkit "${slug}" present in the Composio catalog` : `toolkit "${slug}" NOT in the Composio catalog`,
    });
  } catch (err) {
    checks.push({ id: 'catalog', ok: false, detail: `catalog lookup failed: ${err instanceof Error ? err.message : String(err)}` });
  }

  // 2. Account: an ACTIVE connected account for the toolkit exists
  //    (live list; the local cache alone is not proof of liveness).
  let accountId: string | undefined;
  try {
    const accounts = await opts.client.listConnectedAccounts(opts.apiKey, composioEntityId(opts.userId));
    const active = accounts.find((a) => a.toolkitSlug === slug && a.status === 'ACTIVE');
    accountId = active?.id;
    const cached = Object.values(readAccountCache(opts.dataDir, opts.userId)).some(
      (r) => r.toolkitSlug === slug,
    );
    checks.push({
      id: 'account',
      ok: active !== undefined,
      detail: active
        ? `ACTIVE account ${active.id}${cached ? ' (mirrored in the local cache)' : ''}`
        : `no ACTIVE connected account for "${slug}" — connect it in Accounts first`,
    });
  } catch (err) {
    checks.push({ id: 'account', ok: false, detail: `account lookup failed: ${err instanceof Error ? err.message : String(err)}` });
  }

  // 3. Enablement: the app is enabled for this bot (the bridge's own gate).
  const enabled = readComposioEnables(opts.dataDir, opts.userId)[opts.botId]?.[slug] === true;
  checks.push({
    id: 'enablement',
    ok: enabled,
    detail: enabled
      ? `app enabled for bot "${opts.botId}"`
      : `app NOT enabled for bot "${opts.botId}" — composio_call would refuse`,
  });

  // 4. Actions: representative actions exist in the toolkit's action list.
  const foundActions: string[] = [];
  const missingActions: string[] = [];
  try {
    const tools = await opts.client.listTools(opts.apiKey, slug);
    const slugs = new Set(tools.map((t) => t.slug));
    for (const action of profile.representativeActions) {
      (slugs.has(action.slug) ? foundActions : missingActions).push(action.slug);
    }
    checks.push({
      id: 'actions',
      ok: missingActions.length === 0,
      detail:
        missingActions.length === 0
          ? `all ${foundActions.length} representative actions present in the live action list`
          : `representative actions missing from the live action list: ${missingActions.join(', ')}`,
    });
  } catch (err) {
    missingActions.push(...profile.representativeActions.map((a) => a.slug));
    checks.push({ id: 'actions', ok: false, detail: `action list failed: ${err instanceof Error ? err.message : String(err)}` });
  }

  // 5. Bridge surface: both tools exist and the policy rules are intact
  //    (discovery allowed, execution approval-gated — never weakened).
  const rules = composioToolPolicies();
  const listRule = rules.find((r) => r.toolPattern === '^composio_list_actions$');
  const callRule = rules.find((r) => r.toolPattern === '^composio_call$');
  const bridgeOk =
    (COMPOSIO_TOOL_NAMES as readonly string[]).includes('composio_call') &&
    (COMPOSIO_TOOL_NAMES as readonly string[]).includes('composio_list_actions') &&
    listRule?.effect === 'allow' &&
    callRule?.effect === 'require-approval';
  checks.push({
    id: 'bridge',
    ok: bridgeOk,
    detail: bridgeOk
      ? 'composio_call (approval-gated) + composio_list_actions (read-only) registered with intact policy rules'
      : 'bridge surface incomplete or policy rules weakened',
  });

  return {
    toolkitSlug: slug,
    displayName: profile.displayName,
    ok: checks.every((c) => c.ok),
    checks,
    missingActions,
    foundActions,
    ...(accountId ? { accountId } : {}),
  };
}

/** Verify every profiled app; reports are per app, failures never throw. */
export async function verifyAllComposioApps(
  opts: Omit<VerifyComposioAppOptions, 'toolkitSlug'>,
): Promise<ComposioAppWiringReport[]> {
  const out: ComposioAppWiringReport[] = [];
  for (const profile of VERIFIED_COMPOSIO_APPS) {
    out.push(await verifyComposioAppWiring({ ...opts, toolkitSlug: profile.toolkitSlug }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Capability-registry descriptors (host adds these to PRODUCT_FEATURES)
// ---------------------------------------------------------------------------

/**
 * ProductFeatureDescriptor-shaped entries for capabilities.ts. The host
 * adds `...composioAppCapabilityFeatures()` to the features list (or the
 * capability service's `features` dep) — see the WIRING note. Invocation
 * is honest: the flow is connect-in-Accounts → enable per bot → the bot
 * calls composio_list_actions / composio_call.
 */
export function composioAppCapabilityFeatures(): ProductFeatureDescriptor[] {
  return VERIFIED_COMPOSIO_APPS.map((profile) => ({
    slug: `composio-${profile.toolkitSlug}`,
    name: `${profile.displayName} (via Composio)`,
    whatItDoes: profile.summary,
    whenToUse: `When the user asks about their ${profile.displayName} and it is connected in Accounts and enabled for the bot — the verified ${profile.auditRows.join('/')} connector surface.`,
    invoke: {
      type: 'tool' as const,
      toolName: 'composio_call',
      description:
        `Discover actions with composio_list_actions, then execute with composio_call (approval-gated; the ${profile.displayName} app must be enabled for the bot). Representative actions: ` +
        profile.representativeActions.map((a) => a.slug).join(', ') +
        '.',
    },
    keywords: [
      profile.toolkitSlug,
      profile.displayName.toLowerCase(),
      'composio',
      ...profile.representativeActions.map((a) => a.name.toLowerCase()),
    ],
  }));
}

/**
 * Feature descriptor for the first-party Google Workspace suite (CN-3),
 * same shape — the host adds it alongside the Composio entries.
 */
export function googleWorkspaceCapabilityFeature(): ProductFeatureDescriptor {
  return {
    slug: 'google-workspace-first-party',
    name: 'Google Workspace (first-party)',
    whatItDoes:
      'Gmail, Calendar and Drive through KriyaDot\u2019s own OAuth connector (not Composio): search/read/send Gmail, list/create calendar events, search Drive — reads allowed, writes approval-gated.',
    whenToUse: 'When the user asks about their own Gmail, Google Calendar or Google Drive and the Google account is connected in Accounts (OAuth).',
    invoke: {
      type: 'tool' as const,
      toolName: 'google_gmail_search',
      description:
        'Call the google_* tools directly (google_gmail_search/read/send, google_calendar_list/create, google_drive_search/read). Status and the env gate: GET /api/google-workspace/status.',
    },
    keywords: ['gmail', 'google calendar', 'google drive', 'google workspace', 'email', 'inbox'],
  };
}
