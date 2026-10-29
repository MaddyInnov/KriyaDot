// SPDX-License-Identifier: Apache-2.0
// Approval-gated purchasing (W6, Claude Duet parity — original design).
//
// A bot NEVER buys anything directly. The flow is:
//   1. A purchase intent is created (persisted, status 'pending-approval').
//      Creating an intent executes NOTHING and charges NOTHING.
//   2. The intent raises a human approval card (governance approvals inbox)
//      showing item, merchant, amount, currency, total and checkout link.
//      Every purchase is individually approved — there is no "always allow"
//      for purchases (enforced in the API layer: the tool is privileged for
//      learned preferences and cannot be remembered as always-allow).
//   3. Only after an explicit approval does execution run, through an
//      injectable executor:
//        - 'stripe-link': the Stripe Link driver completes checkout using
//          ONLY an opaque Link reference id held server-side. Payment
//          credentials never enter bot context, tool results, logs, audit
//          payloads, or this database — they live in Stripe Link / the
//          vault and are never read by this module.
//        - 'browser-checkout' (fallback): the bot's browser opens the
//          merchant checkout and fills NON-payment details, then stops
//          BEFORE the final pay/confirm step (status
//          'awaiting-user-confirm'). It never clicks a final pay button;
//          the user finishes (or abandons) the payment personally.
//   4. On confirmed completion the spend is recorded in the usage ledger
//      (CostTracker, feature 'purchase', sessionId = intent id) and the
//      intent stores the ledger reference.
//
// Hard blocks (checked at intent creation AND again immediately before
// execution, so a forced 'approved' flag cannot smuggle them through):
//   (a) securities trading intents (stocks/ETFs/crypto trading, brokers),
//   (b) transfers between the user's own accounts / self-transfers,
//   (c) purchases that would exceed the global or per-bot spend cap
//       (reuses checkSpendCaps over the same usage ledger).
// Blocked intents are persisted with status 'blocked' + reason and audited.
//
// Money representation: integer minor units (`amountCents`) + ISO currency
// code. Spend caps and the usage ledger are USD cents; non-USD intents are
// gated/recorded with amountCents treated as the USD-cent equivalent
// (conservative 1:1 minor-unit approximation — no FX table is fabricated).

import { createHash, randomUUID } from 'node:crypto';
import { openDb } from './sqlite.js';
import type { DatabaseSync } from 'node:sqlite';
type DatabaseSyncType = DatabaseSync;
import { checkSpendCaps, formatSpendCapMessage } from './spend-caps.js';
import type { SpendCapConfig, SpendLookup } from './spend-caps.js';

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export type PurchaseStatus =
  | 'pending-approval'
  | 'approved'
  | 'denied'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'awaiting-user-confirm';

export type PurchaseExecutionMethod = 'stripe-link' | 'browser-checkout';

export interface PurchaseIntent {
  id: string;
  botId: string;
  sessionId: string;
  itemDescription: string;
  merchantName: string;
  /** Amount in integer minor units of `currency` (e.g. USD cents). */
  amountCents: number;
  /** ISO 4217 currency code, uppercase (e.g. 'USD'). */
  currency: string;
  /** Total charged for this intent (single-item intents: == amountCents). */
  totalCents: number;
  checkoutUrl: string;
  status: PurchaseStatus;
  executionMethod: PurchaseExecutionMethod;
  /** Governance approval id backing this intent, when one was raised. */
  approvalId: string | null;
  /** Usage-ledger (CostTracker) event id recorded on completion. */
  ledgerRef: string | null;
  /** Opaque provider reference returned by the executor (e.g. Link ref). */
  providerRef: string | null;
  blockReason: string | null;
  failureReason: string | null;
  /** Human-facing note (e.g. browser handoff instructions). */
  note: string | null;
  /** Stable fingerprint of (bot, session, normalized input) for tool-claim. */
  fingerprint: string;
  createdAt: number;
  decidedAt: number | null;
  completedAt: number | null;
  updatedAt: number;
}

export interface CreatePurchaseInput {
  itemDescription: string;
  merchantName: string;
  amountCents: number;
  currency?: string;
  checkoutUrl: string;
  executionMethod?: PurchaseExecutionMethod;
}

export const PURCHASE_TOOL_NAME = 'request_purchase';

const TERMINAL_STATUSES: ReadonlySet<PurchaseStatus> = new Set([
  'denied',
  'completed',
  'failed',
  'blocked',
]);

export function isTerminalPurchaseStatus(s: PurchaseStatus): boolean {
  return TERMINAL_STATUSES.has(s);
}

/** Legal status transitions. Terminal statuses have no outgoing edges. */
const TRANSITIONS: Readonly<Record<PurchaseStatus, readonly PurchaseStatus[]>> = {
  'pending-approval': ['approved', 'denied', 'blocked'],
  approved: ['executing', 'blocked', 'denied'],
  executing: ['completed', 'failed', 'awaiting-user-confirm', 'blocked'],
  'awaiting-user-confirm': ['completed', 'failed'],
  denied: [],
  completed: [],
  failed: [],
  blocked: [],
};

// ---------------------------------------------------------------------------
// Validation + sensitive-data guards
// ---------------------------------------------------------------------------

const MAX_ITEM_CHARS = 500;
const MAX_MERCHANT_CHARS = 200;
const MAX_URL_CHARS = 2048;
const MAX_AMOUNT_CENTS = 100_000_000; // $1,000,000 sanity ceiling per intent

/** Luhn check over a digit string (13-19 digits). */
export function luhnValid(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/**
 * True when `text` contains a card-number-like sequence (13-19 digits,
 * optionally space/dash separated) that passes the Luhn check. Used to
 * REJECT purchase inputs carrying payment details and to REDACT free text
 * before it is persisted or audited: payment details must never touch bot
 * prompts, tool results, logs, audit payloads, or the DB.
 */
export function containsCardLike(text: string): boolean {
  if (typeof text !== 'string' || !text) return false;
  const candidates = text.match(/(?:\d[ -]?){12,18}\d/g) ?? [];
  for (const c of candidates) {
    const digits = c.replace(/[ -]/g, '');
    if (luhnValid(digits)) return true;
  }
  return false;
}

/** Replace any card-like sequence in free text with '[redacted]'. */
export function redactCardLike(text: string): string {
  return text.replace(/(?:\d[ -]?){12,18}\d/g, (m) =>
    luhnValid(m.replace(/[ -]/g, '')) ? '[redacted]' : m,
  );
}

/** Sanitize an executor/provider free-text string before persistence. */
export function sanitizePurchaseText(text: unknown, max = 500): string {
  const s = typeof text === 'string' ? text : String(text ?? '');
  return redactCardLike(s).slice(0, max);
}

function requireText(v: unknown, name: string, max: number): string {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`"${name}" must be a non-empty string`);
  const t = v.trim();
  if (t.length > max) throw new Error(`"${name}" exceeds ${max} chars`);
  if (containsCardLike(t)) {
    throw new Error(
      `"${name}" appears to contain payment card details — payment details must never be included in a purchase request`,
    );
  }
  return t;
}

export function normalizePurchaseInput(input: CreatePurchaseInput): Required<CreatePurchaseInput> {
  const itemDescription = requireText(input?.itemDescription, 'itemDescription', MAX_ITEM_CHARS);
  const merchantName = requireText(input?.merchantName, 'merchantName', MAX_MERCHANT_CHARS);
  const amount = input?.amountCents;
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0 || amount > MAX_AMOUNT_CENTS) {
    throw new Error(`"amountCents" must be a positive integer (minor units) up to ${MAX_AMOUNT_CENTS}`);
  }
  const currencyRaw = input?.currency ?? 'USD';
  if (typeof currencyRaw !== 'string' || !/^[A-Za-z]{3}$/.test(currencyRaw.trim())) {
    throw new Error('"currency" must be a 3-letter ISO currency code');
  }
  const currency = currencyRaw.trim().toUpperCase();
  const urlRaw = requireText(input?.checkoutUrl, 'checkoutUrl', MAX_URL_CHARS);
  let url: URL;
  try {
    url = new URL(urlRaw);
  } catch {
    throw new Error('"checkoutUrl" must be a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('"checkoutUrl" must use http or https');
  }
  const executionMethod = input?.executionMethod;
  if (executionMethod !== undefined && executionMethod !== 'stripe-link' && executionMethod !== 'browser-checkout') {
    throw new Error('"executionMethod" must be stripe-link or browser-checkout');
  }
  return {
    itemDescription,
    merchantName,
    amountCents: amount,
    currency,
    checkoutUrl: url.toString(),
    executionMethod: executionMethod ?? 'browser-checkout',
  };
}

/** Stable fingerprint for matching a tool call to its pre-created intent. */
export function purchaseFingerprint(botId: string, sessionId: string, input: Required<CreatePurchaseInput>): string {
  const canonical = [
    botId,
    sessionId,
    input.itemDescription,
    input.merchantName,
    String(input.amountCents),
    input.currency,
    input.checkoutUrl,
  ].join('|');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

/** Approval-card args for an intent: everything the user needs to decide. */
export function purchaseApprovalArgs(intent: PurchaseIntent): Record<string, unknown> {
  const total = `${intent.currency} ${(intent.totalCents / 100).toFixed(2)}`;
  return {
    intentId: intent.id,
    item: intent.itemDescription,
    merchant: intent.merchantName,
    amountCents: intent.amountCents,
    currency: intent.currency,
    totalCents: intent.totalCents,
    total,
    checkoutUrl: intent.checkoutUrl,
    executionMethod: intent.executionMethod,
    note: 'Purchases are always individually approved. Approving executes this purchase; payment details stay in Stripe Link / the browser — the bot never sees them.',
  };
}

// ---------------------------------------------------------------------------
// Hard-block classification (conservative)
// ---------------------------------------------------------------------------

export type PurchaseBlockCategory = 'securities' | 'self-transfer' | 'spend-cap';

export interface PurchaseBlock {
  category: PurchaseBlockCategory;
  reason: string;
}

const BROKER_DOMAINS: readonly string[] = [
  'robinhood.com',
  'coinbase.com',
  'binance.com',
  'binance.us',
  'kraken.com',
  'zerodha.com',
  'groww.in',
  'upstox.com',
  'webull.com',
  'etoro.com',
  'schwab.com',
  'fidelity.com',
  'interactivebrokers.com',
  'tradestation.com',
  'plus500.com',
  'degiro.com',
  'saxobank.com',
  'angelone.in',
  'dhan.co',
  'fyers.in',
  'gemini.com',
  'bitstamp.net',
  'bybit.com',
  'okx.com',
  'kucoin.com',
];

const SECURITIES_ACTION_RE =
  /\b(buy|buying|purchase|purchasing|trade|trading|invest|investing|acquire|acquiring|short|long)\b[^;]{0,48}\b(stocks?|shares?|etfs?|equity|equities|cryptocurrency|cryptoassets?|crypto|bitcoin|ethereum|solana|dogecoin|securities|mutual funds?|index funds?|bonds?|options?|futures?|derivatives?)\b/i;
const SECURITIES_CONTEXT_RE =
  /\b(stock market|share market|crypto exchange|cryptocurrency exchange|trading platform|brokerage account|demat account|options trading|futures trading|day trading|forex trading|swing trading|margin trading|securities trading)\b/i;
const SECURITIES_MERCHANT_RE = /\b(broker|brokers|brokerage|securities|capital markets|investments? (platform|app|broker))\b/i;

const SELF_TRANSFER_STRONG_RE =
  /\bself[-\s]?transfer\b|\btransfer between (my |own |the user's )?accounts?\b|\bmy own (bank )?account\b|\b(bank|wire|ach|sepa) transfer to (my|own)\b|\bmove money (to|between)\b[^;]{0,40}\b(my|own|account)\b|\b(transfer|send|move|wire|deposit|pay)\b[^;]{0,60}\b(my own|own|myself|my other|another of my)\b[^;]{0,32}\b(account|bank|wallet)\b|\btop[-\s]?up my (own )?(bank )?account\b/i;
const TRANSFER_SERVICES: readonly string[] = [
  'wise',
  'transferwise',
  'remitly',
  'western union',
  'moneygram',
  'paypal',
  'venmo',
  'cash app',
  'cashapp',
  'zelle',
  'xoom',
  'ria money',
];
const TRANSFER_VERB_RE = /\b(transfer|send|move|wire|deposit|cash out|withdraw)\b/i;
const SELF_INDICATOR_RE = /\b(own|myself|my account|my bank|same name|to me)\b/i;

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Classify a purchase intent against the hard blocks (securities trading
 * and self-transfers). Conservative by design: trading-flavoured language
 * blocks even when the item might be informational — the user can always
 * buy such items manually; a bot must never trade or move the user's money
 * between their own accounts. Spend-cap blocking is separate (needs the
 * live ledger) — see checkPurchaseSpendCap().
 */
export function classifyPurchaseBlock(input: {
  itemDescription: string;
  merchantName: string;
  checkoutUrl: string;
}): PurchaseBlock | null {
  const host = hostnameOf(input.checkoutUrl);
  const merchant = input.merchantName;
  const haystack = `${merchant} ${input.itemDescription} ${input.checkoutUrl}`;

  // (a) Securities trading.
  if (host && BROKER_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) {
    return {
      category: 'securities',
      reason: `Blocked: "${merchant}" is a brokerage / crypto-trading service (${host}). Bots cannot trade securities or crypto.`,
    };
  }
  if (SECURITIES_ACTION_RE.test(haystack) || SECURITIES_CONTEXT_RE.test(haystack) || SECURITIES_MERCHANT_RE.test(merchant)) {
    return {
      category: 'securities',
      reason: 'Blocked: this looks like a securities / crypto trading intent (stocks, ETFs, crypto, options, futures or a brokerage). Bots cannot trade securities.',
    };
  }

  // (b) Transfers between the user's own accounts / self-transfers.
  if (SELF_TRANSFER_STRONG_RE.test(haystack)) {
    return {
      category: 'self-transfer',
      reason: 'Blocked: this looks like a transfer between the user\'s own accounts. Bots cannot move money between the user\'s accounts.',
    };
  }
  const merchantLower = merchant.toLowerCase();
  const isTransferService =
    TRANSFER_SERVICES.some((s) => merchantLower.includes(s)) ||
    TRANSFER_SERVICES.some((s) => host === `${s.replace(/\s/g, '')}.com` || host.includes(s.replace(/\s/g, '')));
  if (isTransferService && TRANSFER_VERB_RE.test(input.itemDescription) && SELF_INDICATOR_RE.test(haystack)) {
    return {
      category: 'self-transfer',
      reason: `Blocked: "${merchant}" is a money-transfer service and this intent moves money to the user's own account. Bots cannot perform self-transfers.`,
    };
  }
  return null;
}

/** Spend-cap gate for one purchase, reusing the shared cap enforcement. */
export function checkPurchaseSpendCap(opts: {
  caps: SpendCapConfig;
  botId: string;
  amountCents: number;
  spentLookup: SpendLookup;
  now?: number;
}): PurchaseBlock | null {
  const result = checkSpendCaps({
    caps: opts.caps,
    botId: opts.botId,
    estimatedAdditionalCents: opts.amountCents,
    spentLookup: opts.spentLookup,
    now: opts.now,
  });
  if (result.allowed) return null;
  return { category: 'spend-cap', reason: formatSpendCapMessage(result) };
}

// ---------------------------------------------------------------------------
// Persistence: purchase intents + settings
// ---------------------------------------------------------------------------

const INTENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS purchase_intents (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  session_id TEXT NOT NULL DEFAULT '',
  item_description TEXT NOT NULL,
  merchant_name TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  checkout_url TEXT NOT NULL,
  status TEXT NOT NULL,
  execution_method TEXT NOT NULL,
  approval_id TEXT,
  ledger_ref TEXT,
  provider_ref TEXT,
  block_reason TEXT,
  failure_reason TEXT,
  note TEXT,
  fingerprint TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_purchase_status ON purchase_intents (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_purchase_bot ON purchase_intents (bot_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_purchase_approval ON purchase_intents (approval_id);
CREATE INDEX IF NOT EXISTS idx_purchase_fingerprint ON purchase_intents (fingerprint);
CREATE TABLE IF NOT EXISTS purchase_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

interface IntentRow {
  id: string;
  bot_id: string;
  session_id: string;
  item_description: string;
  merchant_name: string;
  amount_cents: number;
  currency: string;
  total_cents: number;
  checkout_url: string;
  status: string;
  execution_method: string;
  approval_id: string | null;
  ledger_ref: string | null;
  provider_ref: string | null;
  block_reason: string | null;
  failure_reason: string | null;
  note: string | null;
  fingerprint: string;
  created_at: number;
  decided_at: number | null;
  completed_at: number | null;
  updated_at: number;
}

function rowToIntent(r: IntentRow): PurchaseIntent {
  return {
    id: r.id,
    botId: r.bot_id,
    sessionId: r.session_id,
    itemDescription: r.item_description,
    merchantName: r.merchant_name,
    amountCents: r.amount_cents,
    currency: r.currency,
    totalCents: r.total_cents,
    checkoutUrl: r.checkout_url,
    status: r.status as PurchaseStatus,
    executionMethod: r.execution_method as PurchaseExecutionMethod,
    approvalId: r.approval_id ?? null,
    ledgerRef: r.ledger_ref ?? null,
    providerRef: r.provider_ref ?? null,
    blockReason: r.block_reason ?? null,
    failureReason: r.failure_reason ?? null,
    note: r.note ?? null,
    fingerprint: r.fingerprint,
    createdAt: r.created_at,
    decidedAt: r.decided_at ?? null,
    completedAt: r.completed_at ?? null,
    updatedAt: r.updated_at,
  };
}

export class PurchaseIntentStore {
  private readonly db: DatabaseSyncType;

  constructor(dbPath: string) {
    this.db = openDb(dbPath);
    this.db.exec(INTENT_SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  insert(intent: PurchaseIntent): PurchaseIntent {
    this.db
      .prepare(
        `INSERT INTO purchase_intents
           (id, bot_id, session_id, item_description, merchant_name, amount_cents,
            currency, total_cents, checkout_url, status, execution_method,
            approval_id, ledger_ref, provider_ref, block_reason, failure_reason,
            note, fingerprint, created_at, decided_at, completed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        intent.id,
        intent.botId,
        intent.sessionId,
        intent.itemDescription,
        intent.merchantName,
        intent.amountCents,
        intent.currency,
        intent.totalCents,
        intent.checkoutUrl,
        intent.status,
        intent.executionMethod,
        intent.approvalId,
        intent.ledgerRef,
        intent.providerRef,
        intent.blockReason,
        intent.failureReason,
        intent.note,
        intent.fingerprint,
        intent.createdAt,
        intent.decidedAt,
        intent.completedAt,
        intent.updatedAt,
      );
    return this.get(intent.id) as PurchaseIntent;
  }

  get(id: string): PurchaseIntent | undefined {
    const row = this.db.prepare(`SELECT * FROM purchase_intents WHERE id = ?`).get(id) as unknown as
      | IntentRow
      | undefined;
    return row ? rowToIntent(row) : undefined;
  }

  getByApprovalId(approvalId: string): PurchaseIntent | undefined {
    const row = this.db
      .prepare(`SELECT * FROM purchase_intents WHERE approval_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(approvalId) as unknown as IntentRow | undefined;
    return row ? rowToIntent(row) : undefined;
  }

  getByFingerprint(fingerprint: string): PurchaseIntent | undefined {
    const row = this.db
      .prepare(`SELECT * FROM purchase_intents WHERE fingerprint = ? ORDER BY created_at DESC LIMIT 1`)
      .get(fingerprint) as unknown as IntentRow | undefined;
    return row ? rowToIntent(row) : undefined;
  }

  list(opts: { botId?: string; status?: PurchaseStatus; limit?: number } = {}): PurchaseIntent[] {
    const conds: string[] = [];
    const args: Array<string | number> = [];
    if (opts.botId) {
      conds.push('bot_id = ?');
      args.push(opts.botId);
    }
    if (opts.status) {
      conds.push('status = ?');
      args.push(opts.status);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const rows = this.db
      .prepare(`SELECT * FROM purchase_intents ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...args, limit) as unknown as IntentRow[];
    return rows.map(rowToIntent);
  }

  /**
   * Transition an intent to a new status, enforcing the state machine.
   * Throws on an illegal transition (fail-closed: a completed/blocked/
   * denied intent can never be resurrected).
   */
  transition(
    id: string,
    to: PurchaseStatus,
    patch: Partial<
      Pick<
        PurchaseIntent,
        'approvalId' | 'ledgerRef' | 'providerRef' | 'blockReason' | 'failureReason' | 'note' | 'executionMethod' | 'decidedAt' | 'completedAt'
      >
    > = {},
  ): PurchaseIntent {
    const current = this.get(id);
    if (!current) throw new Error(`unknown purchase intent: ${id}`);
    if (current.status !== to && !TRANSITIONS[current.status].includes(to)) {
      throw new Error(`illegal purchase transition ${current.status} -> ${to} for intent ${id}`);
    }
    const next: PurchaseIntent = {
      ...current,
      ...patch,
      status: to,
      updatedAt: Date.now(),
    };
    this.db
      .prepare(
        `UPDATE purchase_intents
         SET status = ?, execution_method = ?, approval_id = ?, ledger_ref = ?,
             provider_ref = ?, block_reason = ?, failure_reason = ?, note = ?,
             decided_at = ?, completed_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.status,
        next.executionMethod,
        next.approvalId,
        next.ledgerRef,
        next.providerRef,
        next.blockReason,
        next.failureReason,
        next.note,
        next.decidedAt,
        next.completedAt,
        next.updatedAt,
        id,
      );
    return this.get(id) as PurchaseIntent;
  }

  /** Attach an approval id without a status change (card raised post-insert). */
  setApprovalId(id: string, approvalId: string): PurchaseIntent {
    const current = this.get(id);
    if (!current) throw new Error(`unknown purchase intent: ${id}`);
    this.db
      .prepare(`UPDATE purchase_intents SET approval_id = ?, updated_at = ? WHERE id = ?`)
      .run(approvalId, Date.now(), id);
    return this.get(id) as PurchaseIntent;
  }
}

// ---------------------------------------------------------------------------
// Stripe Link settings (flag + opaque reference — never a credential)
// ---------------------------------------------------------------------------

export interface StripeLinkConfig {
  enabled: boolean;
  /** Opaque reference id for the user's Stripe Link linkage. Never a card,
   *  never a Stripe secret — just an id the executor hands to the driver. */
  linkRef: string | null;
}

export interface PurchaseSettingsProvider {
  getStripeLinkConfig(): StripeLinkConfig;
  setStripeLinkConfig(cfg: StripeLinkConfig): void;
}

/** SQLite-backed settings (billing.db `purchase_settings` table). */
export class PurchaseSettingsStore implements PurchaseSettingsProvider {
  private readonly db: DatabaseSyncType;

  constructor(dbPath: string) {
    this.db = openDb(dbPath);
    this.db.exec(INTENT_SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  private get(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM purchase_settings WHERE key = ?`).get(key) as unknown as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  private set(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO purchase_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, Date.now());
  }

  getStripeLinkConfig(): StripeLinkConfig {
    return {
      enabled: this.get('stripe_link_enabled') === '1',
      linkRef: this.get('stripe_link_ref'),
    };
  }

  setStripeLinkConfig(cfg: StripeLinkConfig): void {
    this.set('stripe_link_enabled', cfg.enabled ? '1' : '0');
    if (cfg.linkRef) this.set('stripe_link_ref', cfg.linkRef);
  }
}

// ---------------------------------------------------------------------------
// Executors (injectable / mockable — tests never move real money)
// ---------------------------------------------------------------------------

export interface PurchaseExecutionRequest {
  intentId: string;
  approvalId: string;
}

export type PurchaseExecutionOutcome =
  | { kind: 'completed'; providerRef: string }
  | { kind: 'awaiting-user-confirm'; note: string }
  | { kind: 'failed'; reason: string };

export interface PurchaseExecutor {
  readonly method: PurchaseExecutionMethod;
  /**
   * Execute an APPROVED intent. The executor receives only the intent id
   * and the approval id — never payment details (none exist in this
   * process in a form an executor could read: the Stripe Link reference is
   * resolved inside the Stripe executor from the settings provider).
   */
  execute(req: PurchaseExecutionRequest): Promise<PurchaseExecutionOutcome>;
}

/**
 * Semantic checkout-browser surface used by both executors. The production
 * adapter (API layer) drives the bot's per-bot browser/OS surface; tests
 * inject MockCheckoutBrowser. `clickFinalPayButton` exists so mocks can
 * prove the browser-checkout path NEVER invokes it — the production OS
 * adapter's implementation throws if it is ever called.
 */
export interface CheckoutBrowser {
  goto(url: string): Promise<void>;
  /** Fill NON-payment checkout details (item, quantity, notes). */
  fillNonPaymentDetails(details: { itemDescription: string; merchantName: string; quantity: number }): Promise<void>;
  /** Complete payment inside Stripe Link's own UI using only the opaque
   *  link reference. Returns an opaque provider reference. */
  completeWithStripeLink(linkRef: string): Promise<{ providerRef: string }>;
  /** The final merchant pay/confirm action. Browser-checkout must NEVER
   *  call this; Stripe Link completion does not use it either. */
  clickFinalPayButton(): Promise<void>;
  currentUrl(): Promise<string>;
}

/** Recording CheckoutBrowser double for tests and dry runs. */
export class MockCheckoutBrowser implements CheckoutBrowser {
  readonly calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  payClickCount = 0;
  readonly linkRefsSeen: string[] = [];
  private url = 'about:blank';
  /** When set, completeWithStripeLink throws this error. */
  linkError: Error | null = null;

  async goto(url: string): Promise<void> {
    this.calls.push({ method: 'goto', args: { url } });
    this.url = url;
  }

  async fillNonPaymentDetails(details: { itemDescription: string; merchantName: string; quantity: number }): Promise<void> {
    this.calls.push({ method: 'fillNonPaymentDetails', args: { ...details } });
  }

  async completeWithStripeLink(linkRef: string): Promise<{ providerRef: string }> {
    this.calls.push({ method: 'completeWithStripeLink', args: { linkRef } });
    this.linkRefsSeen.push(linkRef);
    if (this.linkError) throw this.linkError;
    return { providerRef: `link_${randomUUID().slice(0, 12)}` };
  }

  async clickFinalPayButton(): Promise<void> {
    this.payClickCount += 1;
    this.calls.push({ method: 'clickFinalPayButton', args: {} });
  }

  async currentUrl(): Promise<string> {
    return this.url;
  }
}

export interface StripeLinkExecutorDeps {
  store: PurchaseIntentStore;
  settings: PurchaseSettingsProvider;
  browserFor: (botId: string) => Promise<CheckoutBrowser>;
}

/**
 * Stripe Link executor: opens the merchant checkout in the bot's browser
 * and completes it inside Stripe Link's own UI using ONLY the opaque link
 * reference from the settings provider. No card number, Stripe credential,
 * or wallet secret is read, held, or logged here — by construction there
 * is no code path that could surface one.
 */
export class StripeLinkExecutor implements PurchaseExecutor {
  readonly method = 'stripe-link' as const;
  constructor(private readonly deps: StripeLinkExecutorDeps) {}

  async execute(req: PurchaseExecutionRequest): Promise<PurchaseExecutionOutcome> {
    const intent = this.deps.store.get(req.intentId);
    if (!intent) return { kind: 'failed', reason: `unknown purchase intent: ${req.intentId}` };
    const cfg = this.deps.settings.getStripeLinkConfig();
    if (!cfg.enabled || !cfg.linkRef) {
      return { kind: 'failed', reason: 'Stripe Link is not enabled in billing settings.' };
    }
    try {
      const browser = await this.deps.browserFor(intent.botId);
      await browser.goto(intent.checkoutUrl);
      const { providerRef } = await browser.completeWithStripeLink(cfg.linkRef);
      const safeRef = /^[A-Za-z0-9_-]{1,128}$/.test(providerRef) ? providerRef : `link_${intent.id.slice(0, 12)}`;
      return { kind: 'completed', providerRef: safeRef };
    } catch (err) {
      return {
        kind: 'failed',
        reason: sanitizePurchaseText(err instanceof Error ? err.message : String(err)),
      };
    }
  }
}

export interface BrowserCheckoutExecutorDeps {
  store: PurchaseIntentStore;
  browserFor: (botId: string) => Promise<CheckoutBrowser>;
}

/**
 * Fallback browser-checkout executor: navigates the merchant checkout,
 * fills the non-payment details from the intent, and then STOPS — it never
 * clicks the final pay/confirm button. The intent lands in
 * 'awaiting-user-confirm' and the browser session stays on the bot's
 * surface for the user to finish (or abandon) personally.
 */
export class BrowserCheckoutExecutor implements PurchaseExecutor {
  readonly method = 'browser-checkout' as const;
  constructor(private readonly deps: BrowserCheckoutExecutorDeps) {}

  async execute(req: PurchaseExecutionRequest): Promise<PurchaseExecutionOutcome> {
    const intent = this.deps.store.get(req.intentId);
    if (!intent) return { kind: 'failed', reason: `unknown purchase intent: ${req.intentId}` };
    try {
      const browser = await this.deps.browserFor(intent.botId);
      await browser.goto(intent.checkoutUrl);
      await browser.fillNonPaymentDetails({
        itemDescription: intent.itemDescription,
        merchantName: intent.merchantName,
        quantity: 1,
      });
      // Deliberately NO payment step here. clickFinalPayButton is never
      // called on this path — the user confirms payment personally.
      const url = await browser.currentUrl().catch(() => intent.checkoutUrl);
      return {
        kind: 'awaiting-user-confirm',
        note: `Checkout is open in the bot's browser (${url}). Review it and complete the payment yourself — the bot stopped before the pay step and will never confirm payment for you. Then mark the purchase completed or failed here.`,
      };
    } catch (err) {
      return {
        kind: 'failed',
        reason: sanitizePurchaseText(err instanceof Error ? err.message : String(err)),
      };
    }
  }
}

/** Fully-mock executor for service-level tests: configurable outcome. */
export class MockPurchaseExecutor implements PurchaseExecutor {
  readonly calls: PurchaseExecutionRequest[] = [];
  outcome: PurchaseExecutionOutcome = { kind: 'completed', providerRef: 'mock_provider_ref' };
  constructor(readonly method: PurchaseExecutionMethod) {}
  async execute(req: PurchaseExecutionRequest): Promise<PurchaseExecutionOutcome> {
    this.calls.push({ ...req });
    return this.outcome;
  }
}

// ---------------------------------------------------------------------------
// Purchase service: lifecycle orchestration
// ---------------------------------------------------------------------------

export type PurchaseApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface PurchaseServiceDeps {
  store: PurchaseIntentStore;
  settings: PurchaseSettingsProvider;
  /** Live spend-cap config (global + per-bot). */
  caps: () => SpendCapConfig;
  /** Ledger-backed spend lookup (CostTracker.spentCents adapter). */
  spentLookup: SpendLookup;
  /** Record a completed purchase in the usage ledger; returns the event id. */
  recordLedger: (intent: PurchaseIntent) => string;
  /** Raise the human approval card for an intent; returns the approval id. */
  raiseApproval: (intent: PurchaseIntent) => Promise<string | undefined> | string | undefined;
  /** Current status of a governance approval (for claim/reconcile paths). */
  approvalStatus: (approvalId: string) => PurchaseApprovalStatus | undefined;
  stripeExecutor?: PurchaseExecutor;
  browserExecutor?: PurchaseExecutor;
  audit?: (action: string, detail: Record<string, unknown>) => void;
  now?: () => number;
}

export class PurchaseService {
  constructor(private readonly deps: PurchaseServiceDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private audit(action: string, intent: PurchaseIntent, extra: Record<string, unknown> = {}): void {
    try {
      this.deps.audit?.(action, {
        intentId: intent.id,
        botId: intent.botId,
        merchant: intent.merchantName,
        amountCents: intent.amountCents,
        currency: intent.currency,
        status: intent.status,
        executionMethod: intent.executionMethod,
        ...extra,
      });
    } catch {
      // Audit must never break purchasing flow.
    }
  }

  private spendCapBlock(intent: PurchaseIntent): PurchaseBlock | null {
    return checkPurchaseSpendCap({
      caps: this.deps.caps(),
      botId: intent.botId,
      amountCents: intent.amountCents,
      spentLookup: this.deps.spentLookup,
      now: this.now(),
    });
  }

  /** Hard blocks evaluated against an intent-shaped input. */
  private hardBlock(input: { itemDescription: string; merchantName: string; checkoutUrl: string; botId: string; amountCents: number }): PurchaseBlock | null {
    const classified = classifyPurchaseBlock(input);
    if (classified) return classified;
    return checkPurchaseSpendCap({
      caps: this.deps.caps(),
      botId: input.botId,
      amountCents: input.amountCents,
      spentLookup: this.deps.spentLookup,
      now: this.now(),
    });
  }

  /**
   * Create an intent and (unless blocked) raise its approval card.
   * NEVER executes anything. Blocked intents are persisted as 'blocked'
   * with the reason and raise NO approval.
   */
  async createIntent(
    rawInput: CreatePurchaseInput,
    ctx: { botId: string; sessionId?: string },
  ): Promise<PurchaseIntent> {
    const input = normalizePurchaseInput(rawInput);
    const fingerprint = purchaseFingerprint(ctx.botId, ctx.sessionId ?? '', input);
    const block = this.hardBlock({ ...input, botId: ctx.botId });
    const stripeCfg = this.deps.settings.getStripeLinkConfig();
    const requested = (rawInput as { executionMethod?: unknown }).executionMethod;
    const method: PurchaseExecutionMethod =
      requested === 'stripe-link' || requested === 'browser-checkout'
        ? requested
        : stripeCfg.enabled
          ? 'stripe-link'
          : 'browser-checkout';
    const intent: PurchaseIntent = {
      id: `pur_${randomUUID()}`,
      botId: ctx.botId,
      sessionId: ctx.sessionId ?? '',
      itemDescription: input.itemDescription,
      merchantName: input.merchantName,
      amountCents: input.amountCents,
      currency: input.currency,
      totalCents: input.amountCents,
      checkoutUrl: input.checkoutUrl,
      status: block ? 'blocked' : 'pending-approval',
      executionMethod: method,
      approvalId: null,
      ledgerRef: null,
      providerRef: null,
      blockReason: block?.reason ?? null,
      failureReason: null,
      note: null,
      fingerprint,
      createdAt: this.now(),
      decidedAt: null,
      completedAt: null,
      updatedAt: this.now(),
    };
    this.deps.store.insert(intent);
    if (block) {
      this.audit('purchase.blocked', intent, { category: block.category, reason: block.reason });
      return intent;
    }
    const approvalId = await this.deps.raiseApproval(intent);
    const withApproval = approvalId ? this.deps.store.setApprovalId(intent.id, approvalId) : intent;
    this.audit('purchase.intent_created', withApproval, { approvalId: approvalId ?? null });
    return withApproval;
  }

  /**
   * Register an intent for a tool call whose governance approval has
   * ALREADY been minted by the gateway (the API adapter calls this when
   * evaluation of `request_purchase` returns require-approval, so the
   * gateway's card IS the purchase card — exactly one card per purchase).
   * Idempotent per fingerprint: a repeat evaluation returns the existing
   * intent. Block/cap checks still run; a blocked intent is persisted and
   * its (already-minted) approval simply never executes anything.
   */
  async noteToolApprovalMinted(args: {
    botId: string;
    sessionId: string;
    approvalId: string;
    input: CreatePurchaseInput;
  }): Promise<PurchaseIntent> {
    const input = normalizePurchaseInput(args.input);
    const fingerprint = purchaseFingerprint(args.botId, args.sessionId, input);
    const existing = this.deps.store.getByFingerprint(fingerprint);
    if (existing) {
      if (!existing.approvalId) return this.deps.store.setApprovalId(existing.id, args.approvalId);
      return existing;
    }
    const block = this.hardBlock({ ...input, botId: args.botId });
    const stripeCfg = this.deps.settings.getStripeLinkConfig();
    const intent: PurchaseIntent = {
      id: `pur_${randomUUID()}`,
      botId: args.botId,
      sessionId: args.sessionId,
      itemDescription: input.itemDescription,
      merchantName: input.merchantName,
      amountCents: input.amountCents,
      currency: input.currency,
      totalCents: input.amountCents,
      checkoutUrl: input.checkoutUrl,
      status: block ? 'blocked' : 'pending-approval',
      executionMethod: stripeCfg.enabled ? 'stripe-link' : 'browser-checkout',
      approvalId: args.approvalId,
      ledgerRef: null,
      providerRef: null,
      blockReason: block?.reason ?? null,
      failureReason: null,
      note: null,
      fingerprint,
      createdAt: this.now(),
      decidedAt: null,
      completedAt: null,
      updatedAt: this.now(),
    };
    this.deps.store.insert(intent);
    if (block) this.audit('purchase.blocked', intent, { category: block.category, reason: block.reason });
    else this.audit('purchase.intent_created', intent, { approvalId: args.approvalId });
    return intent;
  }

  getIntent(id: string): PurchaseIntent | undefined {
    return this.deps.store.get(id);
  }

  getByApprovalId(approvalId: string): PurchaseIntent | undefined {
    return this.deps.store.getByApprovalId(approvalId);
  }

  getByFingerprint(fingerprint: string): PurchaseIntent | undefined {
    return this.deps.store.getByFingerprint(fingerprint);
  }

  listIntents(opts: { botId?: string; status?: PurchaseStatus; limit?: number } = {}): PurchaseIntent[] {
    return this.deps.store.list(opts);
  }

  /**
   * Apply a human decision to an intent's approval. Denied is terminal.
   * Approved re-runs every hard block and then executes. Safe to call
   * more than once (already-decided intents are returned unchanged).
   */
  async handleApprovalDecision(intentId: string, decision: 'approved' | 'denied'): Promise<PurchaseIntent> {
    const intent = this.deps.store.get(intentId);
    if (!intent) throw new Error(`unknown purchase intent: ${intentId}`);
    if (intent.status !== 'pending-approval') return intent;
    if (decision === 'denied') {
      const denied = this.deps.store.transition(intentId, 'denied', { decidedAt: this.now() });
      this.audit('purchase.denied', denied);
      return denied;
    }
    const approved = this.deps.store.transition(intentId, 'approved', { decidedAt: this.now() });
    this.audit('purchase.approved', approved);
    return this.executeIntent(intentId);
  }

  /** Decision entry point when only the governance approval id is known. */
  async handleApprovalDecisionByApprovalId(
    approvalId: string,
    decision: 'approved' | 'denied',
  ): Promise<PurchaseIntent | undefined> {
    const intent = this.deps.store.getByApprovalId(approvalId);
    if (!intent) return undefined;
    return this.handleApprovalDecision(intent.id, decision);
  }

  /**
   * Execute an intent whose approval is approved. Re-checks ALL hard
   * blocks (classification + spend caps) immediately before execution —
   * an intent whose status was forced to 'approved' out of band is still
   * blocked here. From 'pending-approval', execution additionally requires
   * the linked governance approval to actually be 'approved' (this is
   * what makes runtime bypass/auto-approve modes safe for purchases: the
   * tool handler may run, but execution waits for a real human decision).
   */
  async executeIntent(intentId: string): Promise<PurchaseIntent> {
    let intent = this.deps.store.get(intentId);
    if (!intent) throw new Error(`unknown purchase intent: ${intentId}`);
    if (isTerminalPurchaseStatus(intent.status) || intent.status === 'awaiting-user-confirm') return intent;
    if (intent.status === 'pending-approval') {
      const status = intent.approvalId ? this.deps.approvalStatus(intent.approvalId) : undefined;
      if (status === 'approved') {
        intent = this.deps.store.transition(intentId, 'approved', { decidedAt: this.now() });
        this.audit('purchase.approved', intent);
      } else if (status === 'denied' || status === 'expired') {
        const denied = this.deps.store.transition(intentId, 'denied', { decidedAt: this.now() });
        this.audit('purchase.denied', denied, { via: 'approval-sync' });
        return denied;
      } else {
        return intent; // still waiting for a human — execute nothing
      }
    }
    if (intent.status !== 'approved') return intent;

    // Pre-execution hard blocks (second enforcement point).
    const classified = classifyPurchaseBlock(intent);
    const capBlock = classified ? null : this.spendCapBlock(intent);
    const block = classified ?? capBlock;
    if (block) {
      const blocked = this.deps.store.transition(intentId, 'blocked', { blockReason: block.reason });
      this.audit('purchase.blocked', blocked, { category: block.category, reason: block.reason, stage: 'pre-execution' });
      return blocked;
    }

    this.deps.store.transition(intentId, 'executing');
    this.audit('purchase.executing', this.deps.store.get(intentId) as PurchaseIntent);

    // Executor selection: Stripe Link when enabled; otherwise (or on a
    // Stripe Link failure) the browser-checkout fallback, which hands the
    // final pay step to the user instead of failing the purchase outright.
    const cfg = this.deps.settings.getStripeLinkConfig();
    let outcome: PurchaseExecutionOutcome | null = null;
    let usedMethod: PurchaseExecutionMethod = intent.executionMethod;
    if (cfg.enabled && cfg.linkRef && this.deps.stripeExecutor) {
      outcome = await this.deps.stripeExecutor.execute({
        intentId,
        approvalId: intent.approvalId ?? '',
      });
      usedMethod = 'stripe-link';
      if (outcome.kind === 'failed' && this.deps.browserExecutor) {
        this.audit('purchase.stripe_fallback', this.deps.store.get(intentId) as PurchaseIntent, {
          stripeFailure: outcome.reason,
        });
        outcome = await this.deps.browserExecutor.execute({
          intentId,
          approvalId: intent.approvalId ?? '',
        });
        usedMethod = 'browser-checkout';
      }
    } else if (this.deps.browserExecutor) {
      outcome = await this.deps.browserExecutor.execute({
        intentId,
        approvalId: intent.approvalId ?? '',
      });
      usedMethod = 'browser-checkout';
    }

    const current = this.deps.store.get(intentId) as PurchaseIntent;
    if (!outcome) {
      const failed = this.deps.store.transition(intentId, 'failed', {
        failureReason: 'No purchase executor is configured.',
        executionMethod: usedMethod,
      });
      this.audit('purchase.failed', failed, { reason: failed.failureReason });
      return failed;
    }
    if (outcome.kind === 'completed') {
      const refIntent = { ...current, executionMethod: usedMethod };
      const ledgerRef = this.deps.recordLedger(refIntent);
      const completed = this.deps.store.transition(intentId, 'completed', {
        ledgerRef,
        providerRef: sanitizePurchaseText(outcome.providerRef, 128),
        executionMethod: usedMethod,
        completedAt: this.now(),
      });
      this.audit('purchase.completed', completed, { ledgerRef, providerRef: completed.providerRef });
      return completed;
    }
    if (outcome.kind === 'awaiting-user-confirm') {
      const waiting = this.deps.store.transition(intentId, 'awaiting-user-confirm', {
        note: sanitizePurchaseText(outcome.note, 1000),
        executionMethod: usedMethod,
      });
      this.audit('purchase.awaiting_user_confirm', waiting);
      return waiting;
    }
    const failed = this.deps.store.transition(intentId, 'failed', {
      failureReason: sanitizePurchaseText(outcome.reason),
      executionMethod: usedMethod,
    });
    this.audit('purchase.failed', failed, { reason: failed.failureReason });
    return failed;
  }

  /**
   * The user reports the outcome of a browser-checkout handoff: they
   * completed the payment personally (→ ledger + completed) or it failed /
   * was abandoned (→ failed). Only valid from 'awaiting-user-confirm'.
   */
  async confirmUserCompletion(intentId: string, outcome: 'completed' | 'failed', note?: string): Promise<PurchaseIntent> {
    const intent = this.deps.store.get(intentId);
    if (!intent) throw new Error(`unknown purchase intent: ${intentId}`);
    if (intent.status !== 'awaiting-user-confirm') {
      throw new Error(`purchase intent ${intentId} is ${intent.status}, not awaiting-user-confirm`);
    }
    if (outcome === 'failed') {
      const failed = this.deps.store.transition(intentId, 'failed', {
        failureReason: sanitizePurchaseText(note ?? 'User reported the checkout was not completed.'),
      });
      this.audit('purchase.failed', failed, { via: 'user-confirm' });
      return failed;
    }
    const ledgerRef = this.deps.recordLedger(intent);
    const completed = this.deps.store.transition(intentId, 'completed', {
      ledgerRef,
      completedAt: this.now(),
      note: note ? sanitizePurchaseText(note, 1000) : intent.note,
    });
    this.audit('purchase.completed', completed, { ledgerRef, via: 'user-confirm' });
    return completed;
  }

  /**
   * Sync an intent with its governance approval (covers decisions made
   * through surfaces that don't call handleApprovalDecision directly,
   * e.g. the companion app): pending + approved → execute; pending +
   * denied/expired → denied. Returns the (possibly updated) intent.
   */
  async reconcileIntent(intentId: string): Promise<PurchaseIntent> {
    const intent = this.deps.store.get(intentId);
    if (!intent) throw new Error(`unknown purchase intent: ${intentId}`);
    if (intent.status !== 'pending-approval' || !intent.approvalId) return intent;
    const status = this.deps.approvalStatus(intent.approvalId);
    if (status === 'approved') return this.executeIntent(intentId);
    if (status === 'denied' || status === 'expired') {
      return this.handleApprovalDecision(intentId, 'denied');
    }
    return intent;
  }

  /** Reconcile every pending intent (used by the purchases list route). */
  async reconcilePending(): Promise<void> {
    const pending = this.deps.store.list({ status: 'pending-approval', limit: 100 });
    for (const intent of pending) {
      try {
        await this.reconcileIntent(intent.id);
      } catch {
        // One bad intent must not break the list.
      }
    }
  }
}

/** Serializable public view of an intent (all fields are safe by design). */
export function purchaseIntentView(intent: PurchaseIntent): PurchaseIntent {
  return { ...intent };
}
