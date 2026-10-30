// SPDX-License-Identifier: Apache-2.0
// Permissions & identity pane (Muse parity audit §4.7: P-3..P-7, P-15,
// P-16, CN-10's toggle). Enforcement already lives in @mvp/governance
// (policy gateway, hard floors, approval modes, per-bot policies) — this
// module builds the missing VIEWS over that enforcement plus the two
// object types the audit found absent: first-class ALLOWANCES (P-6/P-15/
// P-16) and PER-ITEM permission overrides (P-5). It never invents new
// enforcement and never weakens a hard denial:
//
//   - Surface defaults are READ from the shipped DEFAULT_POLICY and the
//     product rules around it (purchases are always individually
//     approved; external sends hit a hard floor). The pane stores only
//     per-surface OVERRIDES the user picks; an override can change a
//     surface's presented default but cannot auto-allow purchases.
//   - Connector action-group settings persist in a sibling store
//     (permissions-connector-settings.json). The existing Composio
//     enablement file ({botId:{appId:boolean}}) is NOT reshaped: its
//     boolean values are load-bearing for tool grants. Enable/disable
//     stays on the existing Composio routes; this pane records the
//     per-action-group Allow/Ask/Deny choices + the background-sync flag
//     (persisted + exposed; sync engines that exist — the email poller —
//     are flagged `implemented`, the rest honestly report false). The
//     sync-engine side of CN-10 lives in connector-sync.ts: its gate
//     functions READ this store (the email IMAP poller in messaging.ts
//     consults resolveChannelSyncEnabled every tick), registered sync
//     targets run only while their toggle is on, and reauth-needed
//     states are surfaced both there and on the connector entries below
//     (`reauthNeeded`, derived from the Composio account cache).
//   - Allowances are the only new evaluation input, wired at ONE seam:
//     GovernanceAdapter's optional `getAllowance` hook (see
//     governance-adapter.ts). An allowance converts Ask → Allow ONLY
//     when (a) it matches the call's (kind, target, action) exactly,
//     (b) no hard floor (either tier) or command denylist hits the call,
//     (c) the tool is not privileged (purchases, shell, file writes, MCP
//     and destructive names are excluded — same probe set as the
//     learned-preference allow), and (d) a side-effect-free policy
//     simulation says the call would otherwise be 'require-approval'
//     (a policy DENY stays a deny). Everything else is untouched.
//
// Routes (register-style; the host mounts the returned router under /api,
// so paths below are /api/permissions/...):
//   GET    /permissions/overview
//   POST   /permissions/reset                 { confirm: true }
//   PUT    /permissions/surfaces/:surfaceId   { effect }
//   GET    /permissions/connectors?botId=
//   PUT    /permissions/connectors/:id        { botId, groups?, backgroundSync? }
//   GET    /permissions/allowances
//   POST   /permissions/allowances            { kind, target, actions, scope?, expiresAt? }
//   DELETE /permissions/allowances/:id
//   GET    /permissions/items
//   GET    /permissions/items/:itemKind/:itemId
//   PUT    /permissions/items/:itemKind/:itemId  { actions, note? }
//   DELETE /permissions/items/:itemKind/:itemId
//   GET    /permissions/protocols
//   PUT    /permissions/protocols/:id         → always 400 (read-only rows)
//
// Identity: every route resolves the verified principal (principal.ts,
// the OPEN-1 model) exactly like the Composio routes; allowance / item /
// connector stores are namespaced per user id, mirroring the Composio
// enablement file naming.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type Request, type Response, type Router } from 'express';
import { DEFAULT_POLICY, DENYLIST_COMMAND_RE, checkHardFloor, extractTargetHost, hostMatchesDomains } from '@mvp/governance';
import type { BotConfig, ToolCall, ToolContext } from '@mvp/agent-runtime';
import { principalMiddleware, resolvePrincipal, type PrincipalContext } from './principal.js';
import { listChannelIds } from './channel-config.js';
import { loadBotPolicies } from './bot-policies.js';
import {
  getComposioApiKey,
  readComposioEnables,
  type ComposioClient,
} from './composio.js';
import { readAccountCache } from './composio-accounts.js';

// ---------------------------------------------------------------------------
// Shared vocabulary
// ---------------------------------------------------------------------------

/** Pane-facing effect vocabulary (maps to governance allow / require-approval / deny). */
export type PaneEffect = 'allow' | 'ask' | 'deny';

export function toPaneEffect(effect: 'allow' | 'require-approval' | 'deny'): PaneEffect {
  return effect === 'require-approval' ? 'ask' : effect;
}

export function fromPaneEffect(effect: PaneEffect): 'allow' | 'require-approval' | 'deny' {
  return effect === 'ask' ? 'require-approval' : effect;
}

function isPaneEffect(v: unknown): v is PaneEffect {
  return v === 'allow' || v === 'ask' || v === 'deny';
}

// ---------------------------------------------------------------------------
// P-3: surfaces + documented defaults (read from existing policy stores)
// ---------------------------------------------------------------------------

export interface PermissionSurface {
  id: string;
  label: string;
  description: string;
  /** The documented default, derived from DEFAULT_POLICY / product rules. */
  defaultEffect: PaneEffect;
  /** Where the default comes from (existing store/rule id) — shown in the UI. */
  source: string;
  /** Whether the user may override this surface's default from the pane. */
  overridable: boolean;
}

const defaultEffectOfRule = (ruleId: string): PaneEffect => {
  const rule = DEFAULT_POLICY.rules.find((r) => r.id === ruleId);
  return rule ? toPaneEffect(rule.effect) : toPaneEffect(DEFAULT_POLICY.defaultEffect);
};

export const PERMISSION_SURFACES: PermissionSurface[] = [
  {
    id: 'chat',
    label: 'Chat',
    description: 'Tool calls a bot makes while chatting with you. Anything without a more specific rule waits for your approval.',
    defaultEffect: toPaneEffect(DEFAULT_POLICY.defaultEffect),
    source: 'governance DEFAULT_POLICY.defaultEffect',
    overridable: true,
  },
  {
    id: 'tools',
    label: 'Tools',
    description: 'Reading is automatic; writing files and running commands always wait for approval unless a bot policy you saved says otherwise.',
    defaultEffect: defaultEffectOfRule('approval-execution'),
    source: 'governance rules allow-reads + approval-file-writes + approval-execution',
    overridable: true,
  },
  {
    id: 'browser',
    label: 'Browser',
    description: 'Network and browser actions (HTTP calls, page interaction) are approved one at a time unless you created an allowance for the site.',
    defaultEffect: defaultEffectOfRule('approval-http'),
    source: 'governance rule approval-http',
    overridable: true,
  },
  {
    id: 'channels',
    label: 'Channels',
    description: 'Sending a message out through a connected channel is a hard floor: it always needs approval, or an exact recipient allowance you created.',
    defaultEffect: 'ask',
    source: 'governance hard floor external-send (tier: destructive)',
    overridable: true,
  },
  {
    id: 'calls',
    label: 'Calls',
    description: 'Outbound voice calls follow the general default: the bot asks before dialling.',
    defaultEffect: toPaneEffect(DEFAULT_POLICY.defaultEffect),
    source: 'governance DEFAULT_POLICY.defaultEffect',
    overridable: true,
  },
  {
    id: 'computer-use',
    label: 'Computer use (your real desktop)',
    description:
      'Real control uses YOUR mouse cursor, in the foreground, on the screen you are looking at — there is no background mode for real mouse control (background-safe work uses a browser, an API, or the sandbox). Real control is off until the one-time setup in this pane is finished and its self-test passes. Setup never grants a standing allow: every click, keystroke and typed text still asks for approval, one action at a time.',
    defaultEffect: 'ask',
    source: 'computerUsePolicyRules() (require-approval) + computer-use-setup.ts setup state (ADD-5)',
    overridable: false,
  },
  {
    id: 'purchases',
    label: 'Purchases',
    description: 'Every purchase is approved individually, every time. This cannot be changed — there is no always-allow for buying (product rule, QA-verified).',
    defaultEffect: 'ask',
    source: 'purchases.ts safety contract + privileged-tool probe (request_purchase)',
    overridable: false,
  },
];

export function surfaceById(id: string): PermissionSurface | undefined {
  return PERMISSION_SURFACES.find((s) => s.id === id);
}

// ---------------------------------------------------------------------------
// Per-user file stores (namespaced like the Composio enablement files)
// ---------------------------------------------------------------------------

function sanitizeNamespace(ns: string): string {
  return ns.toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 64) || 'user';
}

function namespacedPath(dataDir: string, base: string, userId: string): string {
  const suffix = userId === 'default-user' ? '' : `.${sanitizeNamespace(userId)}`;
  return path.join(dataDir, `${base}${suffix}.json`);
}

function readJsonFile<T>(file: string, fallback: T): T {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as T;
  } catch {
    // Missing or corrupt → fallback (never 500 on a settings read).
  }
  return fallback;
}

function writeJsonFile(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// --- Surface overrides ------------------------------------------------------

const SURFACE_OVERRIDES_FILE = 'permissions-surface-overrides';

export function readSurfaceOverrides(dataDir: string, userId: string): Record<string, PaneEffect> {
  const raw = readJsonFile<Record<string, unknown>>(namespacedPath(dataDir, SURFACE_OVERRIDES_FILE, userId), {});
  const out: Record<string, PaneEffect> = {};
  for (const [k, v] of Object.entries(raw)) if (isPaneEffect(v) && surfaceById(k)) out[k] = v;
  return out;
}

export function writeSurfaceOverride(
  dataDir: string,
  userId: string,
  surfaceId: string,
  effect: PaneEffect | null,
): Record<string, PaneEffect> {
  const current = readSurfaceOverrides(dataDir, userId);
  if (effect === null) delete current[surfaceId];
  else current[surfaceId] = effect;
  writeJsonFile(namespacedPath(dataDir, SURFACE_OVERRIDES_FILE, userId), current);
  return current;
}

// --- Allowances (P-6 / P-15 / P-16) -----------------------------------------

export type AllowanceKind = 'website' | 'recipient' | 'task';

export interface AllowanceScope {
  /** When set, the allowance only applies to this bot's calls. */
  botId?: string;
  /** When set, the allowance only applies inside this session/task. */
  sessionId?: string;
}

export interface Allowance {
  id: string;
  kind: AllowanceKind;
  /** Website: bare host (example.com). Recipient: address/handle as given. Task: task/session id. */
  target: string;
  /** Exact action names this allowance covers (tool names or semantic actions like "send"). */
  actions: string[];
  scope: AllowanceScope;
  createdAt: number;
  /** Epoch ms; absent = no expiry. Expired allowances never match. */
  expiresAt?: number;
}

const ALLOWANCES_FILE = 'permissions-allowances';

interface AllowancesFileShape {
  allowances: Allowance[];
}

export function allowancesPath(dataDir: string, userId: string): string {
  return namespacedPath(dataDir, ALLOWANCES_FILE, userId);
}

export function listAllowances(dataDir: string, userId: string): Allowance[] {
  const file = readJsonFile<AllowancesFileShape>(allowancesPath(dataDir, userId), { allowances: [] });
  const list = Array.isArray(file.allowances) ? file.allowances : [];
  return list.filter(
    (a): a is Allowance =>
      !!a && typeof a === 'object' && typeof a.id === 'string' && typeof a.target === 'string' && Array.isArray(a.actions),
  );
}

function saveAllowances(dataDir: string, userId: string, allowances: Allowance[]): void {
  writeJsonFile(allowancesPath(dataDir, userId), { allowances } satisfies AllowancesFileShape);
}

export function normalizeAllowanceTarget(kind: AllowanceKind, raw: string): string {
  const trimmed = raw.trim();
  if (kind === 'website') {
    const host = extractTargetHost({ url: trimmed }) ?? trimmed.toLowerCase();
    return host.replace(/^www\./, '');
  }
  return trimmed;
}

export function validateAllowanceInput(value: unknown, bots: BotConfig[]): Omit<Allowance, 'id' | 'createdAt'> {
  if (!value || typeof value !== 'object') throw new Error('allowance body must be an object');
  const v = value as Record<string, unknown>;
  if (v.kind !== 'website' && v.kind !== 'recipient' && v.kind !== 'task') {
    throw new Error('"kind" must be one of website|recipient|task');
  }
  const kind = v.kind as AllowanceKind;
  if (typeof v.target !== 'string' || !v.target.trim() || v.target.length > 300) {
    throw new Error('"target" is required (non-empty string, max 300 chars)');
  }
  if (!Array.isArray(v.actions) || v.actions.length === 0 || v.actions.length > 20) {
    throw new Error('"actions" must be a non-empty array (max 20)');
  }
  const actions = v.actions.map((a) => {
    if (typeof a !== 'string' || !a.trim() || a.length > 120) {
      throw new Error('"actions" entries must be non-empty strings (max 120 chars)');
    }
    return a.trim();
  });
  // Purchases can never be allowance-allowed (P-14 product rule).
  if (actions.some((a) => /request_purchase|purchase/i.test(a))) {
    throw new Error('purchases cannot be covered by an allowance — every purchase is approved individually');
  }
  const scope: AllowanceScope = {};
  if (v.scope !== undefined) {
    if (!v.scope || typeof v.scope !== 'object') throw new Error('"scope" must be an object when present');
    const s = v.scope as Record<string, unknown>;
    if (s.botId !== undefined) {
      if (typeof s.botId !== 'string' || !bots.some((b) => b.id === s.botId)) {
        throw new Error('"scope.botId" must name an existing bot');
      }
      scope.botId = s.botId;
    }
    if (s.sessionId !== undefined) {
      if (typeof s.sessionId !== 'string' || !s.sessionId.trim() || s.sessionId.length > 200) {
        throw new Error('"scope.sessionId" must be a non-empty string (max 200 chars)');
      }
      scope.sessionId = s.sessionId.trim();
    }
  }
  let expiresAt: number | undefined;
  if (v.expiresAt !== undefined) {
    if (typeof v.expiresAt !== 'number' || !Number.isFinite(v.expiresAt) || v.expiresAt <= Date.now()) {
      throw new Error('"expiresAt" must be a future epoch-ms timestamp');
    }
    expiresAt = Math.floor(v.expiresAt);
  }
  return {
    kind,
    target: normalizeAllowanceTarget(kind, v.target),
    actions: [...new Set(actions)],
    scope,
    ...(expiresAt ? { expiresAt } : {}),
  };
}

export function createAllowance(
  dataDir: string,
  userId: string,
  input: Omit<Allowance, 'id' | 'createdAt'>,
  now: number = Date.now(),
): Allowance {
  const allowance: Allowance = { ...input, id: randomUUID(), createdAt: now };
  const all = listAllowances(dataDir, userId);
  all.push(allowance);
  saveAllowances(dataDir, userId, all);
  return allowance;
}

export function revokeAllowance(dataDir: string, userId: string, id: string): boolean {
  const all = listAllowances(dataDir, userId);
  const next = all.filter((a) => a.id !== id);
  if (next.length === all.length) return false;
  saveAllowances(dataDir, userId, next);
  return true;
}

// --- Allowance evaluation (the ONLY new evaluation input) -------------------

/** Tools an allowance may never auto-allow — mirrors the adapter's privileged probe set. */
export const ALLOWANCE_PRIVILEGED_TOOL_RE =
  /^(mcp:|run_command$|exec$|shell$|write_file$|edit_file$|create_file$|delete_file$|remove_file$|request_purchase$)/;

export function isAllowancePrivilegedTool(toolName: string): boolean {
  return ALLOWANCE_PRIVILEGED_TOOL_RE.test(toolName) || /delete|remove|drop|exec/.test(toolName);
}

export interface AllowanceQuery {
  kind: AllowanceKind;
  target: string;
  action: string;
  botId?: string;
  sessionId?: string;
  now?: number;
}

/** Exact-match check of one allowance against a query. Expiry + scope enforced. */
export function allowanceMatches(a: Allowance, q: AllowanceQuery): boolean {
  const now = q.now ?? Date.now();
  if (a.expiresAt !== undefined && a.expiresAt <= now) return false;
  if (a.kind !== q.kind) return false;
  // Website targets use the governance domain semantics (domains.ts): a
  // named host covers itself and its subdomains — nothing wider. Every
  // other kind is a byte-exact (case-insensitive) target match.
  const targetMatches =
    a.kind === 'website'
      ? hostMatchesDomains(q.target, [a.target])
      : a.target.toLowerCase() === q.target.toLowerCase();
  if (!targetMatches) return false;
  if (!a.actions.includes(q.action)) return false;
  if (a.scope.botId && a.scope.botId !== q.botId) return false;
  if (a.scope.sessionId && a.scope.sessionId !== q.sessionId) return false;
  return true;
}

export function findAllowance(allowances: Allowance[], q: AllowanceQuery): Allowance | undefined {
  return allowances.find((a) => allowanceMatches(a, q));
}

/**
 * Semantic action for a tool call: sends are 'send'; everything else is
 * the tool name itself. An allowance's `actions` may name either the
 * semantic action or the exact tool name — both are tried, nothing else.
 */
export function semanticActionOf(toolName: string): string {
  if (/send|message|email/i.test(toolName)) return 'send';
  return toolName;
}

function stringArg(args: Record<string, unknown>, names: string[]): string | undefined {
  for (const name of names) {
    const v = args[name];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // Bridge tools nest their real args (composio_call carries { args: {...} }).
  for (const v of Object.values(args)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const nested = stringArg(v as Record<string, unknown>, names);
      if (nested) return nested;
    }
  }
  return undefined;
}

/**
 * Derive every (kind, target, action) query a tool call could match,
 * from its arguments + context. Purely descriptive — matching itself is
 * exact (see allowanceMatches).
 */
export function allowanceQueriesForCall(call: ToolCall, ctx: ToolContext): AllowanceQuery[] {
  const args = (call.args ?? {}) as Record<string, unknown>;
  const queries: AllowanceQuery[] = [];
  const base = { botId: ctx.botId, sessionId: ctx.sessionId };
  // Action candidates: the tool name, its semantic action, and — for
  // bridge tools like composio_call — the bridged action's slug (plus
  // 'send' when the slug is a send). Matching stays exact against these.
  const actionSet = new Set<string>([semanticActionOf(call.name), call.name]);
  const slug = stringArg(args, ['toolSlug', 'slug']);
  if (slug) {
    actionSet.add(slug);
    if (/send/i.test(slug)) actionSet.add('send');
  }
  const actions = [...actionSet];

  const recipient = stringArg(args, ['to', 'recipient', 'contact', 'channel', 'chatId', 'phone', 'number']);
  if (recipient && actions.includes('send')) {
    for (const action of actions) queries.push({ kind: 'recipient', target: recipient, action, ...base });
  }
  const host = extractTargetHost(args);
  if (host) {
    for (const action of actions) queries.push({ kind: 'website', target: host, action, ...base });
  }
  const taskId = stringArg(args, ['taskId', 'task_id', 'routineId']) ?? ctx.sessionId;
  if (taskId) {
    for (const action of actions) queries.push({ kind: 'task', target: taskId, action, ...base });
  }
  return queries;
}

/**
 * The adapter-seam lookup: return the allowance that covers this call,
 * or undefined. Defense in depth — even if a future caller invokes this
 * BEFORE its own floor check, a hard-floor hit (either tier), a denylist
 * command, or a privileged tool name can never be allowance-allowed.
 * The adapter additionally requires a policy simulation verdict of
 * 'require-approval' before converting (see governance-adapter.ts), so
 * a policy deny is never widened either.
 */
export function findAllowanceForCall(
  allowances: Allowance[],
  call: ToolCall,
  ctx: ToolContext,
  now: number = Date.now(),
): Allowance | undefined {
  if (isAllowancePrivilegedTool(call.name)) return undefined;
  const args = (call.args ?? {}) as Record<string, unknown>;
  if (checkHardFloor(call.name, args)) return undefined;
  const command = args['command'];
  if (typeof command === 'string' && DENYLIST_COMMAND_RE.test(command)) return undefined;
  for (const q of allowanceQueriesForCall(call, ctx)) {
    const hit = findAllowance(allowances, { ...q, now });
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Build the GovernanceAdapter `getAllowance` hook for a bot set: the
 * allowance namespace is the bot owner's user id (BotConfig.ownerId,
 * falling back to the single-owner default user). HOST WIRING: pass the
 * result as `getAllowance` in the GovernanceAdapter options in index.ts.
 */
export function createAllowanceLookup(deps: {
  dataDir: string;
  bots: BotConfig[];
  now?: () => number;
}): (call: ToolCall, ctx: ToolContext) => { id: string; kind: string; target: string } | undefined {
  const ownerOf = new Map(deps.bots.map((b) => [b.id, b.ownerId ?? 'default-user']));
  return (call, ctx) => {
    const userId = ownerOf.get(ctx.botId) ?? 'default-user';
    const allowances = listAllowances(deps.dataDir, userId);
    if (allowances.length === 0) return undefined;
    const hit = findAllowanceForCall(allowances, call, ctx, deps.now?.() ?? Date.now());
    return hit ? { id: hit.id, kind: hit.kind, target: hit.target } : undefined;
  };
}

// --- Per-item overrides (P-5) ------------------------------------------------

export interface ItemPermissionOverride {
  /** `${itemKind}:${itemId}` */
  key: string;
  itemKind: string;
  itemId: string;
  /** Per-action effects for this one item. */
  actions: Record<string, PaneEffect>;
  note?: string;
  updatedAt: number;
}

const ITEM_OVERRIDES_FILE = 'permissions-item-overrides';

interface ItemOverridesFileShape {
  items: ItemPermissionOverride[];
}

export function listItemOverrides(dataDir: string, userId: string): ItemPermissionOverride[] {
  const file = readJsonFile<ItemOverridesFileShape>(
    namespacedPath(dataDir, ITEM_OVERRIDES_FILE, userId),
    { items: [] },
  );
  return Array.isArray(file.items) ? file.items.filter((i) => i && typeof i.key === 'string') : [];
}

export function getItemOverride(
  dataDir: string,
  userId: string,
  itemKind: string,
  itemId: string,
): ItemPermissionOverride | undefined {
  return listItemOverrides(dataDir, userId).find((i) => i.key === `${itemKind}:${itemId}`);
}

export function putItemOverride(
  dataDir: string,
  userId: string,
  itemKind: string,
  itemId: string,
  actions: Record<string, PaneEffect>,
  note?: string,
  now: number = Date.now(),
): ItemPermissionOverride {
  const key = `${itemKind}:${itemId}`;
  const entry: ItemPermissionOverride = {
    key,
    itemKind,
    itemId,
    actions,
    ...(note ? { note } : {}),
    updatedAt: now,
  };
  const items = listItemOverrides(dataDir, userId).filter((i) => i.key !== key);
  items.push(entry);
  writeJsonFile(namespacedPath(dataDir, ITEM_OVERRIDES_FILE, userId), { items } satisfies ItemOverridesFileShape);
  return entry;
}

export function deleteItemOverride(dataDir: string, userId: string, itemKind: string, itemId: string): boolean {
  const key = `${itemKind}:${itemId}`;
  const items = listItemOverrides(dataDir, userId);
  const next = items.filter((i) => i.key !== key);
  if (next.length === items.length) return false;
  writeJsonFile(namespacedPath(dataDir, ITEM_OVERRIDES_FILE, userId), { items: next } satisfies ItemOverridesFileShape);
  return true;
}

export function validateItemActions(value: unknown): Record<string, PaneEffect> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('"actions" must be an object mapping action names to allow|ask|deny');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0 || entries.length > 30) {
    throw new Error('"actions" must name between 1 and 30 actions');
  }
  const out: Record<string, PaneEffect> = {};
  for (const [action, effect] of entries) {
    if (!action.trim() || action.length > 120) throw new Error('"actions" keys must be non-empty (max 120 chars)');
    if (!isPaneEffect(effect)) throw new Error(`"actions.${action}" must be allow|ask|deny`);
    if (/purchase/i.test(action) && effect === 'allow') {
      throw new Error('purchases cannot be set to allow on an item — every purchase is approved individually');
    }
    out[action.trim()] = effect;
  }
  return out;
}

// --- Connector settings (P-4 + CN-10 toggle) ---------------------------------

export interface ConnectorActionGroup {
  id: string;
  label: string;
}

export const COMPOSIO_ACTION_GROUPS: ConnectorActionGroup[] = [
  { id: 'read', label: 'Read & search' },
  { id: 'create', label: 'Create & update' },
  { id: 'send', label: 'Send & publish' },
  { id: 'delete', label: 'Delete & remove' },
];

export const CHANNEL_ACTION_GROUPS: ConnectorActionGroup[] = [
  { id: 'receive', label: 'Receive messages' },
  { id: 'send', label: 'Send messages' },
  { id: 'manage', label: 'Manage channel settings' },
];

export interface ConnectorSetting {
  groups: Record<string, PaneEffect>;
  backgroundSync: boolean;
}

const CONNECTOR_SETTINGS_FILE = 'permissions-connector-settings';

type ConnectorSettingsFileShape = Record<string, Record<string, ConnectorSetting>>; // botId -> connectorId -> setting

export function readConnectorSettings(
  dataDir: string,
  userId: string,
): ConnectorSettingsFileShape {
  const raw = readJsonFile<ConnectorSettingsFileShape>(
    namespacedPath(dataDir, CONNECTOR_SETTINGS_FILE, userId),
    {},
  );
  return raw && typeof raw === 'object' ? raw : {};
}

export function writeConnectorSetting(
  dataDir: string,
  userId: string,
  botId: string,
  connectorId: string,
  setting: ConnectorSetting,
): ConnectorSetting {
  const all = readConnectorSettings(dataDir, userId);
  const perBot = all[botId] ?? {};
  perBot[connectorId] = setting;
  all[botId] = perBot;
  writeJsonFile(namespacedPath(dataDir, CONNECTOR_SETTINGS_FILE, userId), all);
  return setting;
}

/** First-party channels that run a real background sync today. */
const SYNC_IMPLEMENTED_CHANNELS = new Set(['email']);

export interface ConnectorPaneEntry {
  id: string;
  name: string;
  kind: 'composio' | 'channel';
  /** Composio: app enabled for the bot on the existing enablement store. Channels: always present. */
  enabled: boolean;
  groups: Array<ConnectorActionGroup & { effect: PaneEffect }>;
  backgroundSync: { enabled: boolean; implemented: boolean };
  /**
   * CN-10 reauth surfacing: true when a connected account for this
   * connector is cached in a non-ACTIVE state (EXPIRED / INACTIVE / …)
   * or a background sync recorded an authentication failure. Derived
   * from local state only — no live provider call.
   */
  reauthNeeded: boolean;
  reauthReason?: string;
}

/**
 * CN-10: per-toolkit reauth reasons from the local Composio account
 * cache (composio-accounts.ts). Accounts not ACTIVE need reconnecting.
 */
export function composioReauthByToolkit(
  dataDir: string,
  userId: string,
): Map<string, string> {
  const out = new Map<string, string>();
  try {
    for (const record of Object.values(readAccountCache(dataDir, userId))) {
      if (record.status && record.status !== 'ACTIVE' && !out.has(record.toolkitSlug)) {
        out.set(
          record.toolkitSlug,
          `A connected account is ${record.status} — reconnect it in Accounts to restore access.`,
        );
      }
    }
  } catch {
    // Cache unreadable → no reauth claims (never break the pane).
  }
  return out;
}

// --- Protocols (P-7) -----------------------------------------------------------

export interface ProtocolPaneEntry {
  id: string;
  label: string;
  /** Default posture from the existing enforcement layer. */
  defaultEffect: PaneEffect;
  /** The existing policy key / floor / sandbox setting that enforces this. */
  policyKey: string;
  enforcement: 'governance-policy' | 'hard-floor' | 'sandbox';
  /** False for every row today: no writable per-protocol config exists. */
  writable: false;
  note: string;
}

export const PROTOCOL_PANE_ENTRIES: ProtocolPaneEntry[] = [
  {
    id: 'https',
    label: 'HTTPS',
    defaultEffect: defaultEffectOfRule('approval-http'),
    policyKey: 'governance rule approval-http (^http tools)',
    enforcement: 'governance-policy',
    writable: false,
    note: 'Enforced by the governance policy; bots ask before network calls unless a rule or allowance covers the exact site.',
  },
  {
    id: 'http',
    label: 'HTTP',
    defaultEffect: defaultEffectOfRule('approval-http'),
    policyKey: 'governance rule approval-http (^http tools)',
    enforcement: 'governance-policy',
    writable: false,
    note: 'Same policy rule as HTTPS; plaintext HTTP gets no weaker treatment.',
  },
  {
    id: 'ssh',
    label: 'SSH',
    defaultEffect: 'ask',
    policyKey: 'sandbox network default (network: false) + VPS connection approvals',
    enforcement: 'sandbox',
    writable: false,
    note: 'Enforced by the sandbox: sandboxed commands run with no network unless explicitly granted; VPS/SSH connections are configured hosts only.',
  },
  {
    id: 'mail',
    label: 'Mail (SMTP/IMAP)',
    defaultEffect: 'ask',
    policyKey: 'governance hard floor external-send + email channel config',
    enforcement: 'hard-floor',
    writable: false,
    note: 'Enforced by the external-send hard floor: outbound mail always needs approval or an exact recipient allowance.',
  },
  {
    id: 'database',
    label: 'Databases',
    defaultEffect: 'ask',
    policyKey: 'governance DEFAULT_POLICY.defaultEffect (database tools)',
    enforcement: 'governance-policy',
    writable: false,
    note: 'Database tools fall under the deny-by-default policy: nothing runs without a matching rule or an approval.',
  },
  {
    id: 'ftp',
    label: 'FTP',
    defaultEffect: 'deny',
    policyKey: 'sandbox network default (network: false)',
    enforcement: 'sandbox',
    writable: false,
    note: 'Enforced by the sandbox: no FTP client tool exists and sandboxed commands have no network by default.',
  },
  {
    id: 'dns',
    label: 'DNS',
    defaultEffect: 'deny',
    policyKey: 'sandbox network default (network: false)',
    enforcement: 'sandbox',
    writable: false,
    note: 'Enforced by the sandbox: sandboxed commands run with no network (including DNS) unless explicitly granted.',
  },
];

// ---------------------------------------------------------------------------
// Overview + reset
// ---------------------------------------------------------------------------

export interface PermissionsOverview {
  surfaces: Array<PermissionSurface & { currentEffect: PaneEffect; overridden: boolean }>;
  /**
   * ADD-5: real-desktop computer-use setup summary, present only when
   * the host wires `computerUseStatus` (computer-use-setup.ts). The full
   * flow (explainer, OS checks, self-test, enable/disable) lives on the
   * /computer-use-setup routes; this is its state, visible in the pane.
   */
  computerUse?: unknown;
  counts: {
    pendingApprovals: number;
    allowances: number;
    itemOverrides: number;
    /** Lasting "always allow" rules (user-allow-*) across bot policy overlays. */
    lastingAllows: number;
  };
}

export function lastingAllowRules(dataDir: string): Array<{ botId: string; ruleId: string; toolPattern: string }> {
  const file = loadBotPolicies(dataDir);
  const out: Array<{ botId: string; ruleId: string; toolPattern: string }> = [];
  for (const [botId, entry] of Object.entries(file)) {
    for (const rule of entry.rules) {
      if (rule.id.startsWith('user-allow-')) out.push({ botId, ruleId: rule.id, toolPattern: rule.toolPattern });
    }
  }
  return out;
}

export interface PermissionsPaneDeps {
  dataDir: string;
  bots: BotConfig[];
  audit?: (action: string, fields: { actor?: string; toolName?: string; detail?: unknown }) => void;
  listApprovals?: (status?: 'pending' | 'approved' | 'denied' | 'expired') => unknown[];
  /** Injected in tests; defaults to the real fetch client (loaded lazily). */
  composioClient?: ComposioClient;
  /** ADD-5: computer-use setup summary provider (computer-use-setup.ts's computerUsePaneSummary). */
  computerUseStatus?: (userId: string) => unknown;
  loopbackToken?: string;
  jwtSecret?: string;
  now?: () => number;
}

export function buildOverview(deps: PermissionsPaneDeps, userId: string): PermissionsOverview {
  const overrides = readSurfaceOverrides(deps.dataDir, userId);
  let pendingApprovals = 0;
  try {
    pendingApprovals = deps.listApprovals?.('pending').length ?? 0;
  } catch {
    pendingApprovals = 0;
  }
  let computerUse: unknown;
  try {
    computerUse = deps.computerUseStatus?.(userId);
  } catch {
    computerUse = undefined;
  }
  return {
    surfaces: PERMISSION_SURFACES.map((s) => ({
      ...s,
      currentEffect: overrides[s.id] ?? s.defaultEffect,
      overridden: overrides[s.id] !== undefined,
    })),
    ...(computerUse !== undefined ? { computerUse } : {}),
    counts: {
      pendingApprovals,
      allowances: listAllowances(deps.dataDir, userId).length,
      itemOverrides: listItemOverrides(deps.dataDir, userId).length,
      lastingAllows: lastingAllowRules(deps.dataDir).length,
    },
  };
}

/**
 * Reset approvals/permissions to the documented defaults: clears surface
 * overrides, allowances, per-item overrides and connector settings for
 * this user, and strips lasting user-allow-* rules from the bot-policy
 * overlay (the "always allow" choices). Bot policy rules the user wrote
 * deliberately (any other rule id) are left alone. Returns what changed.
 */
export function resetPermissionsToDefaults(
  deps: PermissionsPaneDeps,
  userId: string,
): { surfaceOverrides: number; allowances: number; itemOverrides: number; connectorSettings: number; lastingAllows: number } {
  const counts = {
    surfaceOverrides: Object.keys(readSurfaceOverrides(deps.dataDir, userId)).length,
    allowances: listAllowances(deps.dataDir, userId).length,
    itemOverrides: listItemOverrides(deps.dataDir, userId).length,
    connectorSettings: Object.values(readConnectorSettings(deps.dataDir, userId)).reduce(
      (n, perBot) => n + Object.keys(perBot).length,
      0,
    ),
    lastingAllows: lastingAllowRules(deps.dataDir).length,
  };
  writeJsonFile(namespacedPath(deps.dataDir, SURFACE_OVERRIDES_FILE, userId), {});
  saveAllowances(deps.dataDir, userId, []);
  writeJsonFile(namespacedPath(deps.dataDir, ITEM_OVERRIDES_FILE, userId), { items: [] });
  writeJsonFile(namespacedPath(deps.dataDir, CONNECTOR_SETTINGS_FILE, userId), {});
  // Strip lasting allows from the bot-policy overlay file (all users share
  // that overlay; the rules themselves record that they were user choices).
  const policies = loadBotPolicies(deps.dataDir);
  let stripped = false;
  for (const entry of Object.values(policies)) {
    const before = entry.rules.length;
    entry.rules = entry.rules.filter((r) => !r.id.startsWith('user-allow-'));
    if (entry.rules.length !== before) stripped = true;
  }
  if (stripped) {
    writeJsonFile(path.join(deps.dataDir, 'bot-policies.json'), policies);
    // Keep in-memory bots in step: drop the same rules from live configs.
    for (const bot of deps.bots) {
      if (bot.policy) {
        bot.policy = { ...bot.policy, rules: bot.policy.rules.filter((r) => !r.id.startsWith('user-allow-')) };
      }
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function errorBody(error: string, detail?: string): { error: string; detail?: string } {
  return detail ? { error, detail } : { error };
}

export function registerPermissionsPaneRoutes(router: Router, deps: PermissionsPaneDeps): void {
  const pctx: PrincipalContext = { dataDir: deps.dataDir, loopbackToken: deps.loopbackToken, jwtSecret: deps.jwtSecret };
  const audit = (req: Request, action: string, detail?: unknown) => {
    try {
      deps.audit?.(action, { actor: callerOf(req), toolName: 'permissions', detail });
    } catch {
      // Audit must never break a settings write.
    }
  };
  function callerOf(req: Request): string {
    const userId = resolvePrincipal(req, pctx)?.userId;
    if (!userId) throw new Error('unauthenticated');
    return userId;
  }

  const r = express.Router();
  r.use(principalMiddleware(pctx));

  // --- Overview + reset (P-3) ---
  r.get('/overview', (req: Request, res: Response) => {
    res.json({ ok: true, ...buildOverview(deps, callerOf(req)) });
  });

  r.put('/surfaces/:surfaceId', (req: Request, res: Response) => {
    const surface = surfaceById(req.params.surfaceId);
    if (!surface) {
      res.status(404).json(errorBody(`unknown surface: ${req.params.surfaceId}`));
      return;
    }
    if (!surface.overridable) {
      res.status(400).json(errorBody(`${surface.label} cannot be overridden — ${surface.description}`));
      return;
    }
    const effect = (req.body as { effect?: unknown } | undefined)?.effect;
    if (!isPaneEffect(effect)) {
      res.status(400).json(errorBody('"effect" must be allow|ask|deny'));
      return;
    }
    const userId = callerOf(req);
    writeSurfaceOverride(deps.dataDir, userId, surface.id, effect);
    audit(req, 'permissions.surface_updated', { surface: surface.id, effect });
    res.json({ ok: true, surface: surface.id, currentEffect: effect, overridden: true });
  });

  r.post('/reset', (req: Request, res: Response) => {
    if ((req.body as { confirm?: unknown } | undefined)?.confirm !== true) {
      res.status(400).json(errorBody('reset requires { confirm: true }'));
      return;
    }
    const userId = callerOf(req);
    const cleared = resetPermissionsToDefaults(deps, userId);
    audit(req, 'permissions.reset', cleared);
    res.json({ ok: true, cleared, ...buildOverview(deps, userId) });
  });

  // --- Connectors (P-4 + CN-10) ---
  r.get('/connectors', async (req: Request, res: Response) => {
    const userId = callerOf(req);
    const botId = typeof req.query.botId === 'string' && req.query.botId ? req.query.botId : deps.bots[0]?.id ?? 'default';
    if (!deps.bots.some((b) => b.id === botId) && deps.bots.length > 0) {
      res.status(404).json(errorBody(`unknown bot: ${botId}`));
      return;
    }
    const settings = readConnectorSettings(deps.dataDir, userId)[botId] ?? {};
    const reauthByToolkit = composioReauthByToolkit(deps.dataDir, userId);
    const entries: ConnectorPaneEntry[] = [];
    const withSettings = (
      id: string,
      name: string,
      kind: 'composio' | 'channel',
      enabled: boolean,
      groups: ConnectorActionGroup[],
    ): ConnectorPaneEntry => {
      const setting = settings[id];
      const reauthReason = kind === 'composio' ? reauthByToolkit.get(id) : undefined;
      return {
        id,
        name,
        kind,
        enabled,
        groups: groups.map((g) => ({ ...g, effect: setting?.groups[g.id] ?? 'ask' })),
        backgroundSync: {
          enabled: setting?.backgroundSync ?? false,
          implemented: kind === 'channel' && SYNC_IMPLEMENTED_CHANNELS.has(id),
        },
        reauthNeeded: reauthReason !== undefined,
        ...(reauthReason ? { reauthReason } : {}),
      };
    };

    // Composio apps: the catalog when a key + client are available, else
    // the apps that appear in the existing enablement store.
    const enables = readComposioEnables(deps.dataDir, userId);
    const perBotEnables = enables[botId] ?? {};
    let composioApps: Array<{ appId: string; name: string }> = Object.keys(perBotEnables).map((appId) => ({
      appId,
      name: appId,
    }));
    const apiKey = getComposioApiKey(deps.dataDir, userId);
    if (apiKey && deps.composioClient) {
      try {
        const apps = await deps.composioClient.listApps(apiKey);
        composioApps = apps.map((a) => ({ appId: a.appId, name: a.name }));
      } catch {
        // Catalog unreachable — fall back to the enablement-derived list.
      }
    }
    for (const app of composioApps) {
      entries.push(withSettings(app.appId, app.name, 'composio', perBotEnables[app.appId] === true, COMPOSIO_ACTION_GROUPS));
    }
    // First-party channels.
    for (const channelId of listChannelIds()) {
      entries.push(withSettings(channelId, channelId, 'channel', true, CHANNEL_ACTION_GROUPS));
    }
    res.json({ ok: true, botId, connectors: entries });
  });

  r.put('/connectors/:connectorId', (req: Request, res: Response) => {
    const userId = callerOf(req);
    const body = (req.body ?? {}) as { botId?: unknown; groups?: unknown; backgroundSync?: unknown };
    if (typeof body.botId !== 'string' || !body.botId) {
      res.status(400).json(errorBody('botId is required'));
      return;
    }
    if (deps.bots.length > 0 && !deps.bots.some((b) => b.id === body.botId)) {
      res.status(404).json(errorBody(`unknown bot: ${body.botId}`));
      return;
    }
    const connectorId = req.params.connectorId;
    const isComposio = !(listChannelIds() as string[]).includes(connectorId);
    const knownGroups = isComposio ? COMPOSIO_ACTION_GROUPS : CHANNEL_ACTION_GROUPS;
    const existing = readConnectorSettings(deps.dataDir, userId)[body.botId]?.[connectorId];
    const setting: ConnectorSetting = {
      groups: { ...(existing?.groups ?? {}) },
      backgroundSync: existing?.backgroundSync ?? false,
    };
    if (body.groups !== undefined) {
      if (!body.groups || typeof body.groups !== 'object' || Array.isArray(body.groups)) {
        res.status(400).json(errorBody('"groups" must be an object mapping group ids to allow|ask|deny'));
        return;
      }
      for (const [groupId, effect] of Object.entries(body.groups as Record<string, unknown>)) {
        if (!knownGroups.some((g) => g.id === groupId)) {
          res.status(400).json(errorBody(`unknown action group "${groupId}" for connector ${connectorId}`));
          return;
        }
        if (!isPaneEffect(effect)) {
          res.status(400).json(errorBody(`"groups.${groupId}" must be allow|ask|deny`));
          return;
        }
        // Note: a group effect is a recorded setting. It does not by
        // itself change enforcement — sends still run through governance
        // (hard floor + policy) unless an exact allowance covers them.
        setting.groups[groupId] = effect;
      }
    }
    if (body.backgroundSync !== undefined) {
      if (typeof body.backgroundSync !== 'boolean') {
        res.status(400).json(errorBody('"backgroundSync" must be a boolean'));
        return;
      }
      setting.backgroundSync = body.backgroundSync;
    }
    writeConnectorSetting(deps.dataDir, userId, body.botId, connectorId, setting);
    audit(req, 'permissions.connector_updated', { botId: body.botId, connectorId, groups: setting.groups, backgroundSync: setting.backgroundSync });
    res.json({ ok: true, botId: body.botId, connectorId, setting });
  });

  // --- Allowances (P-6 / P-15 / P-16) ---
  r.get('/allowances', (req: Request, res: Response) => {
    res.json({ ok: true, allowances: listAllowances(deps.dataDir, callerOf(req)) });
  });

  r.post('/allowances', (req: Request, res: Response) => {
    const userId = callerOf(req);
    try {
      const input = validateAllowanceInput(req.body, deps.bots);
      const allowance = createAllowance(deps.dataDir, userId, input, deps.now?.() ?? Date.now());
      audit(req, 'permissions.allowance_created', { id: allowance.id, kind: allowance.kind, target: allowance.target, actions: allowance.actions });
      res.status(201).json({ ok: true, allowance });
    } catch (err) {
      res.status(400).json(errorBody(err instanceof Error ? err.message : 'invalid allowance'));
    }
  });

  r.delete('/allowances/:id', (req: Request, res: Response) => {
    const userId = callerOf(req);
    if (!revokeAllowance(deps.dataDir, userId, req.params.id)) {
      res.status(404).json(errorBody(`unknown allowance: ${req.params.id}`));
      return;
    }
    audit(req, 'permissions.allowance_revoked', { id: req.params.id });
    res.json({ ok: true, revoked: req.params.id });
  });

  // --- Per-item overrides (P-5) ---
  r.get('/items', (req: Request, res: Response) => {
    res.json({ ok: true, items: listItemOverrides(deps.dataDir, callerOf(req)) });
  });

  r.get('/items/:itemKind/:itemId', (req: Request, res: Response) => {
    const found = getItemOverride(deps.dataDir, callerOf(req), req.params.itemKind, req.params.itemId);
    if (!found) {
      res.status(404).json(errorBody(`no permission override for ${req.params.itemKind}:${req.params.itemId}`));
      return;
    }
    res.json({ ok: true, item: found });
  });

  r.put('/items/:itemKind/:itemId', (req: Request, res: Response) => {
    const userId = callerOf(req);
    const body = (req.body ?? {}) as { actions?: unknown; note?: unknown };
    try {
      const actions = validateItemActions(body.actions);
      if (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > 500)) {
        throw new Error('"note" must be a string (max 500 chars)');
      }
      const item = putItemOverride(
        deps.dataDir,
        userId,
        req.params.itemKind,
        req.params.itemId,
        actions,
        typeof body.note === 'string' ? body.note : undefined,
        deps.now?.() ?? Date.now(),
      );
      audit(req, 'permissions.item_updated', { key: item.key, actions: item.actions });
      res.json({ ok: true, item });
    } catch (err) {
      res.status(400).json(errorBody(err instanceof Error ? err.message : 'invalid item override'));
    }
  });

  r.delete('/items/:itemKind/:itemId', (req: Request, res: Response) => {
    const userId = callerOf(req);
    if (!deleteItemOverride(deps.dataDir, userId, req.params.itemKind, req.params.itemId)) {
      res.status(404).json(errorBody(`no permission override for ${req.params.itemKind}:${req.params.itemId}`));
      return;
    }
    audit(req, 'permissions.item_deleted', { key: `${req.params.itemKind}:${req.params.itemId}` });
    res.json({ ok: true, deleted: `${req.params.itemKind}:${req.params.itemId}` });
  });

  // --- Protocols (P-7): read-only panel data over existing enforcement ---
  r.get('/protocols', (_req: Request, res: Response) => {
    res.json({ ok: true, protocols: PROTOCOL_PANE_ENTRIES });
  });

  r.put('/protocols/:id', (req: Request, res: Response) => {
    const entry = PROTOCOL_PANE_ENTRIES.find((p) => p.id === req.params.id);
    if (!entry) {
      res.status(404).json(errorBody(`unknown protocol: ${req.params.id}`));
      return;
    }
    res.status(400).json(
      errorBody(
        `${entry.label} is read-only in this pane — it is enforced by ${entry.policyKey}, which has no per-protocol writable setting. Change the governing policy or sandbox setting instead.`,
      ),
    );
  });

  router.use('/permissions', r);
}
