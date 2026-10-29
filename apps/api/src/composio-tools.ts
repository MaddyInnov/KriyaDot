// SPDX-License-Identifier: Apache-2.0
// Composio tool execution bridge (OpenMausBot parity P0 #2): lets bots call
// Gmail/Slack/GitHub/… actions through connected Composio accounts.
//
// Two agent tools, registered into the shared tool registry by the host:
//
//   composio_list_actions — read-only discovery of available actions for the
//                          bot's enabled accounts (auto-allowed).
//   composio_call         — execute one action on one account. MUTATING:
//                          approval-gated by governance (deny-by-default),
//                          and additionally refused unless the account's app
//                          is explicitly enabled for the calling bot.
//
// Trust model (never weakened):
//   - The Composio API key is resolved SERVER-SIDE inside the handlers via
//     the injected getApiKey(). It never appears in tool args, results,
//     logs, audit detail, or thrown errors.
//   - Per-bot enablement is enforced in the handler (defense in depth on
//     top of the UI toggle): a bot can only reach accounts whose toolkit
//     is enabled for it in composio-enables.json. Cross-bot account use is
//     refused with a clear error.
//   - Parameters are audit-logged REDACTED; results are redacted and
//     truncated to a sane size before reaching the model.
//   - Tool slugs and account ids are charset-validated; argument payloads
//     are size-capped.

import type {
  BotPolicyRule,
  ToolContext,
  ToolDefinition,
} from '@mvp/agent-runtime';
import { redactSecrets } from '@mvp/governance';
import type { ComposioClient } from './composio.js';
import { fetchComposioClient, readComposioEnables } from './composio.js';
import { resolveAccount } from './composio-accounts.js';

/** Execute one Composio action. Approval-gated (mutating). */
export const COMPOSIO_CALL_TOOL = 'composio_call';
/** List available Composio actions. Read-only (auto-allowed). */
export const COMPOSIO_LIST_ACTIONS_TOOL = 'composio_list_actions';

/**
 * Governance policy rules the host should install (prepended to the global
 * policy, first match wins — same pattern as computerUsePolicyRules()).
 * Discovery is read-only → allow; execution touches external services →
 * require human approval.
 */
export function composioToolPolicies(): BotPolicyRule[] {
  return [
    {
      id: 'composio-list-actions-allow',
      toolPattern: '^composio_list_actions$',
      effect: 'allow',
      reason: 'Read-only discovery of Composio action metadata; no state changes.',
    },
    {
      id: 'composio-call-approval',
      toolPattern: '^composio_call$',
      effect: 'require-approval',
      reason: 'Composio actions write/read external services (Gmail, Slack, …); require human approval.',
    },
  ];
}

export interface ComposioToolHostOptions {
  dataDir: string;
  /** Server-side API key lookup. The key never leaves this closure. */
  getApiKey: (userId: string) => string | undefined;
  /**
   * Resolve the KriyaDot user for a tool-call context. Defaults to
   * 'default-user' (single-user desktop; matches what the Settings UI
   * writes — same assumption as the type_login tool).
   */
  resolveUserId?: (ctx: ToolContext) => string;
  /** Injected in tests; the real fetch client in production. */
  client?: ComposioClient;
  /**
   * Per-conversation connector override (Octop #110): given a thread
   * (conversation) id, return the app slugs enabled for THAT thread, or
   * undefined when the thread has no override. When present, the
   * effective enablement is bot enablement ∩ thread override — a thread
   * can narrow, never widen, what a bot may use. The host wires this to
   * ThreadTitleStore.getConnectorOverride.
   */
  getThreadConnectorOverride?: (threadId: string) => string[] | undefined;
  /** Audit sink (host governance.audit). Parameters are logged redacted. */
  audit?: (action: string, fields: { actor?: string; toolName?: string; detail?: unknown; sessionId?: string }) => void;
  /** Max JSON chars of an execution result returned to the model. */
  maxResultChars?: number;
}

const ACCOUNT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ACTION_SLUG_RE = /^[A-Z0-9_]{1,128}$/;
const MAX_ARGS_BYTES = 64 * 1024;
const DEFAULT_MAX_RESULT_CHARS = 8000;
const MAX_TOOLS_PER_ACCOUNT = 25;
const MAX_ACCOUNTS_LISTED = 5;

function strArg(args: Record<string, unknown>, name: string, required: boolean, pattern: RegExp): string | undefined {
  const v = args[name];
  if (v === undefined || v === null) {
    if (required) throw new Error(`"${name}" is required`);
    return undefined;
  }
  if (typeof v !== 'string' || !pattern.test(v)) {
    throw new Error(`"${name}" is invalid`);
  }
  return v;
}

function objectArg(args: Record<string, unknown>, name: string): Record<string, unknown> {
  const v = args[name];
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw new Error(`"${name}" must be an object`);
  }
  const bytes = JSON.stringify(v).length;
  if (bytes > MAX_ARGS_BYTES) {
    throw new Error(`"${name}" exceeds the ${MAX_ARGS_BYTES / 1024}KB argument cap`);
  }
  return v as Record<string, unknown>;
}

/** Redact secrets, then cap the JSON size for the model. */
function finalizeResult(data: unknown, maxChars: number): Record<string, unknown> {
  const redacted = redactSecrets(data);
  let json: string;
  try {
    json = JSON.stringify(redacted);
  } catch {
    json = '"[unserializable result]"';
  }
  if (json.length <= maxChars) {
    return { ok: true, data: redacted };
  }
  return {
    ok: true,
    dataPreview: json.slice(0, maxChars),
    truncated: true,
    totalChars: json.length,
    hint: 'Result truncated — refine the action arguments to narrow the results.',
  };
}

/**
 * Octop #110: resolve the thread override for a tool-call context.
 * Threads are sessions; the runtime carries the conversation id on
 * ctx.conversationId (falling back to ctx.sessionId).
 */
function threadOverrideFor(
  opts: ComposioToolHostOptions,
  ctx: ToolContext,
): string[] | undefined {
  if (!opts.getThreadConnectorOverride) return undefined;
  const threadId = ctx.conversationId ?? ctx.sessionId;
  if (!threadId) return undefined;
  try {
    const override = opts.getThreadConnectorOverride(threadId);
    return override ? override.map((s) => s.toLowerCase()) : undefined;
  } catch {
    return undefined;
  }
}

function compactParameters(schema: unknown): unknown {
  let json: string;
  try {
    json = JSON.stringify(schema ?? {});
  } catch {
    return {};
  }
  if (json.length <= 1200) {
    try {
      return JSON.parse(json) as unknown;
    } catch {
      return {};
    }
  }
  // Large schema: keep the shape (required + property names/types) only.
  try {
    const s = JSON.parse(json) as { required?: unknown; properties?: Record<string, { type?: unknown; description?: unknown }> };
    const properties: Record<string, unknown> = {};
    if (s.properties && typeof s.properties === 'object') {
      for (const [k, v] of Object.entries(s.properties)) {
        properties[k] = { type: (v as { type?: unknown }).type ?? 'string' };
      }
    }
    return { required: Array.isArray(s.required) ? s.required : [], properties, truncated: true };
  } catch {
    return {};
  }
}

export function createComposioCallTool(opts: ComposioToolHostOptions): ToolDefinition {
  const client = opts.client ?? fetchComposioClient;
  const maxResultChars = opts.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
  const resolveUserId = opts.resolveUserId ?? (() => 'default-user');

  return {
    name: COMPOSIO_CALL_TOOL,
    mutating: true,
    description:
      'Execute one Composio action on a connected external account (Gmail, Slack, GitHub, …). ' +
      'Use composio_list_actions first to discover action names and their parameters. ' +
      'MUTATING: requires human approval via governance, and the account\u2019s app must be enabled for this bot.',
    parameters: {
      type: 'object',
      properties: {
        accountId: {
          type: 'string',
          description: 'Connected account id (nanoid, e.g. "ca_abc123") from composio_list_actions.',
        },
        actionName: {
          type: 'string',
          description: 'Action slug, e.g. "GMAIL_SEND_EMAIL".',
        },
        parameters: {
          type: 'object',
          description: 'Action arguments (max 64KB JSON).',
        },
      },
      required: ['accountId', 'actionName', 'parameters'],
      additionalProperties: false,
    },
    handler: async (args, ctx: ToolContext) => {
      const accountId = strArg(args, 'accountId', true, ACCOUNT_ID_RE)!;
      const actionName = strArg(args, 'actionName', true, ACTION_SLUG_RE)!;
      const parameters = objectArg(args, 'parameters');

      const userId = resolveUserId(ctx);
      const apiKey = opts.getApiKey(userId);
      if (!apiKey) {
        throw new Error('Composio is not connected — connect an API key in Accounts first.');
      }
      const account = await resolveAccount(opts.dataDir, userId, client, apiKey, accountId);
      if (!account) {
        throw new Error(`unknown Composio account "${accountId}"`);
      }
      // Per-bot enablement gate (defense in depth over the UI toggle).
      const enabled =
        readComposioEnables(opts.dataDir, userId)[ctx.botId]?.[account.toolkitSlug] === true;
      if (!enabled) {
        throw new Error(
          `refused: app "${account.toolkitSlug}" is not enabled for this bot — enable it in Accounts → Composio first.`,
        );
      }
      // Per-conversation override (Octop #110): thread ∩ bot enablement.
      const override = threadOverrideFor(opts, ctx);
      if (override && !override.includes(account.toolkitSlug.toLowerCase())) {
        throw new Error(
          `refused: app "${account.toolkitSlug}" is not enabled for this conversation — the thread's connector selection narrows the bot's apps.`,
        );
      }

      let result;
      try {
        result = await client.executeTool(apiKey, {
          toolSlug: actionName,
          connectedAccountId: accountId,
          userId,
          args: parameters,
        });
      } catch (err) {
        throw new Error(
          `Composio execution failed for "${actionName}": ${err instanceof Error ? err.message : String(err)}`.slice(0, 500),
        );
      }
      try {
        opts.audit?.('composio.tool_executed', {
          actor: ctx.botId,
          toolName: COMPOSIO_CALL_TOOL,
          sessionId: ctx.sessionId,
          // Parameters are audit-logged REDACTED — never raw.
          detail: {
            accountId,
            toolkitSlug: account.toolkitSlug,
            actionName,
            successful: result.successful,
            parameters: redactSecrets(parameters),
          },
        });
      } catch {
        // Audit must never break execution.
      }
      if (!result.successful) {
        throw new Error(
          `Composio action "${actionName}" failed: ${(result.error ?? 'unknown error').slice(0, 500)}`,
        );
      }
      return finalizeResult(result.data, maxResultChars);
    },
  };
}

export function createComposioListActionsTool(opts: ComposioToolHostOptions): ToolDefinition {
  const client = opts.client ?? fetchComposioClient;
  const resolveUserId = opts.resolveUserId ?? (() => 'default-user');

  return {
    name: COMPOSIO_LIST_ACTIONS_TOOL,
    description:
      'List Composio actions available to this bot, grouped by connected account. ' +
      'Call this before composio_call to discover action names and parameters. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        accountId: {
          type: 'string',
          description: 'Restrict to one connected account id.',
        },
        search: {
          type: 'string',
          description: 'Filter actions by substring in name/description (max 100 chars).',
        },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx: ToolContext) => {
      const accountId = strArg(args, 'accountId', false, ACCOUNT_ID_RE);
      const searchRaw = args['search'];
      const search =
        typeof searchRaw === 'string' ? searchRaw.trim().toLowerCase().slice(0, 100) : '';

      const userId = resolveUserId(ctx);
      const apiKey = opts.getApiKey(userId);
      if (!apiKey) {
        return { ok: true, accounts: [], connected: false };
      }
      const enables = readComposioEnables(opts.dataDir, userId)[ctx.botId] ?? {};
      let accounts;
      try {
        accounts = await client.listConnectedAccounts(apiKey, userId);
      } catch (err) {
        throw new Error(
          `Could not list Composio accounts: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
        );
      }
      // Only ACTIVE accounts whose app is enabled for this bot — and, when
      // the thread carries a connector override (Octop #110), in the
      // override too (intersection: threads narrow, never widen).
      const override = threadOverrideFor(opts, ctx);
      let usable = accounts.filter(
        (a) =>
          a.status === 'ACTIVE' &&
          enables[a.toolkitSlug] === true &&
          (!override || override.includes(a.toolkitSlug.toLowerCase())),
      );
      if (accountId) {
        usable = usable.filter((a) => a.id === accountId);
        if (usable.length === 0) {
          throw new Error(
            `unknown or unavailable account "${accountId}" (must be ACTIVE and its app enabled for this bot)`,
          );
        }
      }
      usable = usable.slice(0, MAX_ACCOUNTS_LISTED);
      const out: Array<Record<string, unknown>> = [];
      for (const a of usable) {
        let tools;
        try {
          tools = await client.listTools(apiKey, a.toolkitSlug);
        } catch {
          // One toolkit's catalog failing must not hide the others.
          continue;
        }
        let filtered = tools;
        if (search) {
          filtered = tools.filter(
            (t) =>
              t.slug.toLowerCase().includes(search) ||
              t.name.toLowerCase().includes(search) ||
              (t.description ?? '').toLowerCase().includes(search),
          );
        }
        out.push({
          accountId: a.id,
          toolkitSlug: a.toolkitSlug,
          toolkitName: a.toolkitName,
          tools: filtered.slice(0, MAX_TOOLS_PER_ACCOUNT).map((t) => ({
            slug: t.slug,
            name: t.name,
            description: t.description?.slice(0, 200),
            parameters: compactParameters(t.inputParameters),
          })),
        });
      }
      return { ok: true, connected: true, accounts: out };
    },
  };
}

/**
 * Register both Composio bridge tools into a tool registry. Throws on name
 * collision, mirroring registerTypeLoginTool.
 */
export function registerComposioTools(
  registry: Map<string, ToolDefinition>,
  opts: ComposioToolHostOptions,
): void {
  for (const tool of [createComposioCallTool(opts), createComposioListActionsTool(opts)]) {
    if (registry.has(tool.name)) {
      throw new Error(`tool name collision: "${tool.name}" is already registered`);
    }
    registry.set(tool.name, tool);
  }
}
