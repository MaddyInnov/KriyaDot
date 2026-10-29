// SPDX-License-Identifier: Apache-2.0
// Sign-in code tool (W4b): `enter_sign_in_code`.
//
// When a bot is signing into a site in its (per-bot, persistent) browser
// and the site asks for a one-time code sent to the user's email, this
// tool — AFTER human approval — reads a fresh code from the user's OWN
// connected Gmail (via the existing Composio path, per-bot enablement
// enforced exactly like composio_call) and types it into the focused
// field on the bot's current browser/computer surface.
//
// CRITICAL secrecy contract (never weakened):
//   - The code value is fetched only INSIDE the handler, i.e. only after
//     governance has approved the call. The approval card therefore shows
//     the tool ARGS — site/domain, optional service label, and where the
//     code will be read from — and can never contain a code, because no
//     code exists yet at approval time.
//   - The code is passed exactly once, into the OS layer's type() call.
//     It is NEVER returned in the tool result, NEVER written to audit
//     detail, NEVER logged, and error messages are built without it.
//     Audit records THAT a code entry was attempted for a site, from
//     which source, with which outcome — nothing more.
//   - Ambiguity is a hard stop: zero or multiple distinct candidate codes
//     (or only stale ones) → a failure result, no typing, no guessing.
//     The user handles it manually.
//
// Governance: enter_sign_in_code is require-approval by default via
// signInCodePolicyRules() (prepended to the global policy in index.ts,
// first match wins — same pattern as publishPagePolicyRules()).

import type { BotPolicyRule, ToolContext, ToolDefinition } from '@mvp/agent-runtime';
import { MockOSScreenLayer, type OSScreenLayer } from '@mvp/agent-runtime/dist/tools/computer.js';
import type { ComposioClient } from './composio.js';
import {
  composioEntityId,
  fetchComposioClient,
  readComposioEnables,
} from './composio.js';

/** Canonical tool name. */
export const ENTER_SIGN_IN_CODE_TOOL = 'enter_sign_in_code';

/** Default freshness window: codes older than ~10 minutes are not used. */
export const DEFAULT_SIGN_IN_CODE_FRESHNESS_MS = 10 * 60 * 1000;

export function signInCodePolicyRules(): BotPolicyRule[] {
  return [
    {
      id: 'enter-sign-in-code-approval',
      toolPattern: '^enter_sign_in_code$',
      effect: 'require-approval',
      reason:
        'Typing a one-time sign-in code from the user\'s email into a site is a credential action; needs human approval (the card shows the site and code source, never a code)',
    },
  ];
}

// ---------------------------------------------------------------------------
// Site helpers
// ---------------------------------------------------------------------------

/** Normalize a site arg to a bare domain ("https://www.GitHub.com/login" → "github.com"). */
export function domainOfSite(site: string): string {
  let s = site.trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  s = s.replace(/^www\./, '');
  s = s.split('/')[0] ?? '';
  s = s.split(':')[0] ?? '';
  return s;
}

/** Service label for matching ("github.com" → "github"; "GitHub" → "github"). */
export function serviceLabelOf(site: string, service?: string): string {
  if (service && service.trim()) return service.trim().toLowerCase();
  const domain = domainOfSite(site);
  const first = domain.split('.')[0] ?? '';
  return first || site.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Code extractor (pure, unit-testable)
// ---------------------------------------------------------------------------

/** One message snippet the extractor (and the searcher) works over. */
export interface SignInMessageInput {
  subject?: string;
  body?: string;
  snippet?: string;
  sender?: string;
  /** Epoch ms when the message was received; 0/undefined = unknown age. */
  receivedAtMs?: number;
  /** Source label, e.g. 'gmail'. */
  source?: string;
}

export type SignInCodeExtraction =
  | { status: 'found'; code: string; messageIndex: number }
  | { status: 'not-found' }
  | { status: 'ambiguous'; candidateCount: number }
  | { status: 'stale'; candidateCount: number };

export interface ExtractSignInCodeOptions {
  /** Site/domain being signed into, e.g. "github.com". */
  site: string;
  /** Optional service label override, e.g. "GitHub". */
  service?: string;
  nowMs: number;
  /** Freshness window in ms. Default 10 minutes. */
  freshnessMs?: number;
}

/** A message only yields candidates when it talks about codes at all. */
const CODE_CONTEXT_RE =
  /\b(code|otp|one[\s-]?time|passcode|verification|verify|security|sign[\s-]?in|login|log[\s-]?in|authenticat\w*|2fa|mfa)\b/i;

/** True when the message plausibly comes from / concerns the site. */
function messageMatchesSite(msg: SignInMessageInput, opts: ExtractSignInCodeOptions): boolean {
  const domain = domainOfSite(opts.site);
  const label = serviceLabelOf(opts.site, opts.service);
  const sender = (msg.sender ?? '').toLowerCase();
  const haystack = `${sender} ${msg.subject ?? ''} ${msg.body ?? ''} ${msg.snippet ?? ''}`.toLowerCase();
  if (domain && sender.includes(domain)) return true;
  if (domain && haystack.includes(domain)) return true;
  if (label.length >= 3 && new RegExp(`\\b${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(haystack)) {
    return true;
  }
  return false;
}

function isFresh(msg: SignInMessageInput, nowMs: number, freshnessMs: number): boolean {
  const ts = msg.receivedAtMs;
  if (!ts || !Number.isFinite(ts) || ts <= 0) return true; // unknown age: provider lists newest first
  if (ts > nowMs + 5 * 60 * 1000) return true; // small clock skew allowance
  return nowMs - ts <= freshnessMs;
}

/** Candidate codes in one message's text (context-gated, date-stripped). */
function candidatesInText(text: string): string[] {
  if (!CODE_CONTEXT_RE.test(text)) return [];
  // Strip dates/times first so "2026-10-29" or "12/30/2026" can't leak a
  // year or day into the candidate set.
  const cleaned = text
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
    .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, ' ')
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, ' ');
  const found = new Set<string>();
  // Grouped codes: "123 456" / "123-456" (3+3 digits = 6-digit code).
  for (const m of cleaned.matchAll(/\b(\d{3})[\s-](\d{3})\b/g)) {
    found.add(`${m[1]}${m[2]}`);
  }
  // Plain codes: a standalone run of 4-8 digits, not glued to a longer
  // number, not a currency amount.
  for (const m of cleaned.matchAll(/(?<![\d$€£₹])(\d{4,8})(?!\d)/g)) {
    found.add(m[1]!);
  }
  return [...found];
}

/**
 * Extract THE sign-in code for a site from recent messages. Conservative
 * by design: the message must match the site/service, must carry code
 * context, must be fresh, and all matching fresh messages together must
 * agree on exactly ONE distinct candidate — anything else is
 * 'ambiguous' / 'not-found' / 'stale', never a guess.
 */
export function extractSignInCode(
  messages: SignInMessageInput[],
  opts: ExtractSignInCodeOptions,
): SignInCodeExtraction {
  const freshnessMs = opts.freshnessMs ?? DEFAULT_SIGN_IN_CODE_FRESHNESS_MS;
  const freshCandidates = new Map<string, number>(); // code -> first message index
  const staleCandidates = new Set<string>();
  messages.forEach((msg, idx) => {
    if (!messageMatchesSite(msg, opts)) return;
    const text = `${msg.subject ?? ''}\n${msg.body ?? ''}\n${msg.snippet ?? ''}`;
    const candidates = candidatesInText(text);
    if (candidates.length === 0) return;
    if (isFresh(msg, opts.nowMs, freshnessMs)) {
      for (const c of candidates) if (!freshCandidates.has(c)) freshCandidates.set(c, idx);
    } else {
      for (const c of candidates) staleCandidates.add(c);
    }
  });
  if (freshCandidates.size === 1) {
    const [code, messageIndex] = [...freshCandidates.entries()][0]!;
    return { status: 'found', code, messageIndex };
  }
  if (freshCandidates.size > 1) {
    return { status: 'ambiguous', candidateCount: freshCandidates.size };
  }
  if (staleCandidates.size > 0) {
    return { status: 'stale', candidateCount: staleCandidates.size };
  }
  return { status: 'not-found' };
}

// ---------------------------------------------------------------------------
// Gmail (Composio) result normalization + default searcher
// ---------------------------------------------------------------------------

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function parseTs(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? Math.floor(v * 1000) : Math.floor(v);
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n < 1e12 ? Math.floor(n * 1000) : Math.floor(n);
    const d = Date.parse(v);
    if (Number.isFinite(d)) return d;
  }
  return 0;
}

function bodyTextOf(raw: Record<string, unknown>): string {
  const direct = str(raw.body) || str(raw.text) || str(raw.content);
  if (direct) return direct;
  const body = rec(raw.body);
  return str(body.text) || str(body.content) || str(rec(raw.messageBody).text);
}

/** Normalize one Composio GMAIL_FETCH_EMAILS result into message inputs. */
export function normalizeGmailFetchResult(data: unknown): SignInMessageInput[] {
  let items: unknown[] = [];
  if (Array.isArray(data)) items = data;
  else {
    const d = rec(data);
    for (const k of ['messages', 'emails', 'items', 'results']) {
      if (Array.isArray(d[k])) {
        items = d[k] as unknown[];
        break;
      }
    }
    if (items.length === 0) {
      for (const v of Object.values(d)) {
        const inner = rec(v);
        const nested = inner.messages ?? inner.emails;
        if (Array.isArray(nested)) {
          items = nested;
          break;
        }
      }
    }
  }
  return items.map((item) => {
    const raw = rec(item);
    return {
      subject: str(raw.subject),
      body: bodyTextOf(raw),
      snippet: str(raw.snippet) || str(raw.preview),
      sender: str(raw.sender) || str(raw.from) || str(raw.from_email),
      receivedAtMs: parseTs(raw.messageTimestamp ?? raw.timestamp ?? raw.date ?? raw.internalDate ?? raw.receivedAt),
      source: 'gmail',
    };
  });
}

export interface SignInSearchResult {
  messages: SignInMessageInput[];
  /** Sources actually searched, e.g. ['gmail']. Empty = nothing connected/enabled. */
  sourcesSearched: string[];
}

/**
 * Searches the user's connected sources for recent messages that might
 * carry a sign-in code. Injected in tests (mocked Composio); the default
 * implementation is the Composio Gmail searcher below. Additional
 * messaging sources can be added behind this same interface.
 */
export type SignInMessageSearcher = (input: {
  botId: string;
  userId: string;
  site: string;
  service?: string;
  nowMs: number;
}) => Promise<SignInSearchResult>;

/**
 * Default searcher: the user's connected Gmail via the existing Composio
 * path — API key resolved server-side by the injected getApiKey, accounts
 * listed for the user's Composio entity, per-bot 'gmail' enablement
 * enforced, GMAIL_FETCH_EMAILS executed per enabled ACTIVE account
 * (newest first). Never throws for "not connected" — it reports no
 * sources searched so the tool can answer with a clean failure outcome.
 */
export function createComposioSignInSearcher(deps: {
  dataDir: string;
  getApiKey: (userId: string) => string | undefined;
  client?: ComposioClient;
}): SignInMessageSearcher {
  const client = deps.client ?? fetchComposioClient;
  return async ({ botId, userId }) => {
    const apiKey = deps.getApiKey(userId);
    if (!apiKey) return { messages: [], sourcesSearched: [] };
    let accounts;
    try {
      accounts = await client.listConnectedAccounts(apiKey, composioEntityId(userId));
    } catch {
      return { messages: [], sourcesSearched: [] };
    }
    const enables = readComposioEnables(deps.dataDir, userId)[botId] ?? {};
    if (enables['gmail'] !== true) return { messages: [], sourcesSearched: [] };
    const usable = accounts
      .filter((a) => a.toolkitSlug === 'gmail' && a.status === 'ACTIVE')
      .slice(0, 3);
    if (usable.length === 0) return { messages: [], sourcesSearched: [] };
    const messages: SignInMessageInput[] = [];
    for (const account of usable) {
      try {
        const result = await client.executeTool(apiKey, {
          toolSlug: 'GMAIL_FETCH_EMAILS',
          connectedAccountId: account.id,
          userId: composioEntityId(userId),
          args: { max_results: 15, query: 'newer_than:1d' },
        });
        if (result.successful) messages.push(...normalizeGmailFetchResult(result.data));
      } catch {
        // One account failing must not hide another account's mail.
      }
    }
    // Newest first, so the extractor sees the freshest candidates first.
    messages.sort((a, b) => (b.receivedAtMs ?? 0) - (a.receivedAtMs ?? 0));
    return { messages, sourcesSearched: ['gmail'] };
  };
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

export interface SignInCodeToolDeps {
  registry: Map<string, ToolDefinition>;
  dataDir: string;
  /** Server-side Composio API key lookup (never leaves this closure). */
  getApiKey: (userId: string) => string | undefined;
  /** KriyaDot user for a tool-call context. Default 'default-user'. */
  resolveUserId?: (ctx: ToolContext) => string;
  /** Injected in tests; the real fetch client in production. */
  client?: ComposioClient;
  /**
   * Per-bot computer routing: the OS layer whose focused field receives
   * the code (the calling bot's own surface). Defaults to the safe mock.
   */
  resolveOS?: (ctx: ToolContext) => OSScreenLayer | Promise<OSScreenLayer>;
  /** Message searcher override (tests); default is the Composio Gmail one. */
  searcher?: SignInMessageSearcher;
  /** Audit sink (host governance.audit). NEVER receives a code value. */
  audit?: (
    action: string,
    fields: { actor?: string; toolName?: string; detail?: unknown; sessionId?: string },
  ) => void;
  /** Clock (tests inject a fake). */
  now?: () => number;
  /** Freshness window override (default ~10 min). */
  freshnessMs?: number;
}

type EnterOutcome =
  | 'entered'
  | 'ambiguous'
  | 'not-found'
  | 'stale'
  | 'no-source'
  | 'search-failed'
  | 'type-failed';

const MAX_SITE_CHARS = 200;

export function createEnterSignInCodeTool(deps: Omit<SignInCodeToolDeps, 'registry'>): ToolDefinition {
  const resolveUserId = deps.resolveUserId ?? (() => 'default-user');
  const now = deps.now ?? Date.now;
  const searcher =
    deps.searcher ??
    createComposioSignInSearcher({ dataDir: deps.dataDir, getApiKey: deps.getApiKey, client: deps.client });
  const fallbackOS = new MockOSScreenLayer();

  return {
    name: ENTER_SIGN_IN_CODE_TOOL,
    mutating: true,
    description: [
      'Enter a one-time sign-in code for the site the bot is currently',
      'signing into in its browser. Use when the page asks for a code sent',
      'to the user\'s email. The approval card shows the site and the code',
      'source; the code itself is read from the user\'s connected Gmail',
      'ONLY AFTER approval, typed directly into the focused code field,',
      'and never shown to you or returned. If no single fresh code matches',
      'unambiguously, the tool fails without typing anything.',
      '',
      'Args:',
      '- site (string, required): the site/domain being signed into, e.g. "github.com".',
      '- service (string, optional): service label if it differs from the domain, e.g. "GitHub".',
      '- freshnessMinutes (number, optional): only accept codes this fresh (1-120, default 10).',
      '',
      'Returns { entered, outcome, site, sources } — outcome is one of',
      'entered | ambiguous | not-found | stale | no-source | search-failed',
      '| type-failed. The result NEVER contains the code.',
      'Requires human approval (governance policy).',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        site: { type: 'string', description: 'Site/domain being signed into, e.g. "github.com"' },
        service: { type: 'string', description: 'Optional service label, e.g. "GitHub"' },
        freshnessMinutes: {
          type: 'number',
          description: 'Only accept codes received within this many minutes (1-120, default 10)',
        },
      },
      required: ['site'],
      additionalProperties: false,
    },
    handler: async (args, ctx: ToolContext) => {
      const siteRaw = args['site'];
      if (typeof siteRaw !== 'string' || !siteRaw.trim() || siteRaw.length > MAX_SITE_CHARS) {
        throw new Error(`"site" is required (non-empty string, max ${MAX_SITE_CHARS} chars)`);
      }
      const site = domainOfSite(siteRaw) || siteRaw.trim();
      const serviceRaw = args['service'];
      const service =
        typeof serviceRaw === 'string' && serviceRaw.trim() && serviceRaw.length <= 100
          ? serviceRaw.trim()
          : undefined;
      const freshnessRaw = args['freshnessMinutes'];
      let freshnessMs = deps.freshnessMs ?? DEFAULT_SIGN_IN_CODE_FRESHNESS_MS;
      if (freshnessRaw !== undefined) {
        if (typeof freshnessRaw !== 'number' || !Number.isFinite(freshnessRaw) || freshnessRaw < 1 || freshnessRaw > 120) {
          throw new Error('"freshnessMinutes" must be a number between 1 and 120');
        }
        freshnessMs = Math.round(freshnessRaw * 60_000);
      }

      const finish = (outcome: EnterOutcome, sources: string[], messagesSearched: number, message?: string) => {
        try {
          deps.audit?.('sign_in_code.result', {
            actor: ctx.botId,
            toolName: ENTER_SIGN_IN_CODE_TOOL,
            sessionId: ctx.sessionId,
            // Metadata only: site, source, outcome. NEVER a code value.
            detail: { site, ...(service ? { service } : {}), sources, outcome, messagesSearched },
          });
        } catch {
          // Audit must never break the tool.
        }
        return {
          entered: outcome === 'entered',
          outcome,
          site,
          sources,
          ...(message ? { message } : {}),
        };
      };

      const userId = resolveUserId(ctx);
      let search: SignInSearchResult;
      try {
        search = await searcher({ botId: ctx.botId, userId, site, service, nowMs: now() });
      } catch {
        return finish('search-failed', [], 0, 'Searching the connected accounts for a sign-in code failed. The user can enter the code manually.');
      }
      if (search.sourcesSearched.length === 0) {
        return finish(
          'no-source',
          [],
          0,
          'No connected email source is available for this bot (connect Composio and enable Gmail for this bot). The user can enter the code manually.',
        );
      }

      const extraction = extractSignInCode(search.messages, {
        site,
        service,
        nowMs: now(),
        freshnessMs,
      });
      if (extraction.status === 'ambiguous') {
        return finish(
          'ambiguous',
          search.sourcesSearched,
          search.messages.length,
          `Found ${extraction.candidateCount} different candidate codes — refusing to guess. The user should enter the code manually.`,
        );
      }
      if (extraction.status === 'stale') {
        return finish(
          'stale',
          search.sourcesSearched,
          search.messages.length,
          'Only stale codes were found (older than the freshness window). Ask the site to resend the code, or the user can enter it manually.',
        );
      }
      if (extraction.status === 'not-found') {
        return finish(
          'not-found',
          search.sourcesSearched,
          search.messages.length,
          `No fresh sign-in code for ${site} was found in the connected email. The user can enter the code manually.`,
        );
      }

      // Exactly one fresh, unambiguous candidate. The code value lives
      // only in this local and the single type() call below — it is never
      // assigned to a result, audit field, log line, or error message.
      const code = extraction.code;
      try {
        const os = deps.resolveOS ? await deps.resolveOS(ctx) : fallbackOS;
        await os.type(code);
      } catch {
        return finish(
          'type-failed',
          search.sourcesSearched,
          search.messages.length,
          'A code was found but typing it into the browser failed. The user can enter the code manually.',
        );
      }
      return finish('entered', search.sourcesSearched, search.messages.length);
    },
  };
}

/** Register enter_sign_in_code into a tool registry (skips on collision, like registerPublishTools). */
export function registerSignInCodeTools(deps: SignInCodeToolDeps): void {
  const tool = createEnterSignInCodeTool(deps);
  if (!deps.registry.has(tool.name)) {
    deps.registry.set(tool.name, tool);
  }
}
