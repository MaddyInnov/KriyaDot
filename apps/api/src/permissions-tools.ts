// SPDX-License-Identifier: Apache-2.0
// Permission inspection tools (Muse parity audit §4.7, P-17): read-only
// agent tools over the permission state the user manages in the
// Permissions pane (permissions-pane.ts) and the governance gateway.
//
//   list_pending_approvals — summary of approvals waiting on the user
//   list_active_grants     — lasting grants currently in force:
//                            "always allow" rules (bot-policy overlay),
//                            user allowances (pane store), per-item
//                            overrides (pane store)
//   list_allowances        — the user's allowances (website / recipient /
//                            task), each revocable from the pane
//
// All three are strictly READ-ONLY: no tool here can create, change, or
// revoke a grant — changes happen only in the pane, by the user. Results
// carry ids, tool names, targets and timestamps only; approval argument
// payloads are summarized by tool name (never echoed back), and no
// credential or code value exists in this surface at all.
//
// HOST WIRING (index.ts): registerPermissionsTools({ registry, dataDir,
// governance, bots }) alongside the other register*Tools calls, and
// prepend permissionsToolsPolicyRules() to the global policy next to
// signInCodePolicyRules() so the three read tools auto-allow like the
// other read-only tools (DEFAULT_POLICY allow-reads).

import type { BotPolicyRule, ToolContext, ToolDefinition } from '@mvp/agent-runtime';
import type { ApprovalRecord } from '@mvp/governance';
import {
  lastingAllowRules,
  listAllowances,
  listItemOverrides,
  type Allowance,
} from './permissions-pane.js';

export const PERMISSIONS_TOOL_NAMES = [
  'list_pending_approvals',
  'list_active_grants',
  'list_allowances',
] as const;

/** Policy rules auto-allowing the read-only inspection tools (cf. allow-reads). */
export function permissionsToolsPolicyRules(): BotPolicyRule[] {
  return [
    {
      id: 'allow-permissions-inspection',
      toolPattern: `^(${PERMISSIONS_TOOL_NAMES.join('|')})$`,
      effect: 'allow',
      reason:
        'Permission inspection tools are read-only views over approval/grant state the user already controls; they cannot change any grant',
    },
  ];
}

export interface PermissionsToolsDeps {
  dataDir: string;
  /** Gateway approval listing (governance.listApprovals). */
  listApprovals: (status?: 'pending' | 'approved' | 'denied' | 'expired') => ApprovalRecord[];
  /** Bot roster (allowance/item namespaces resolve from bot owners). */
  bots: Array<{ id: string; ownerId?: string }>;
  /** KriyaDot user for a tool-call context. Default: the calling bot's owner. */
  resolveUserId?: (ctx: ToolContext) => string;
}

function defaultResolveUserId(deps: PermissionsToolsDeps): (ctx: ToolContext) => string {
  const ownerOf = new Map(deps.bots.map((b) => [b.id, b.ownerId ?? 'default-user']));
  return (ctx) => ownerOf.get(ctx.botId) ?? 'default-user';
}

function allowanceSummary(a: Allowance): Record<string, unknown> {
  return {
    id: a.id,
    kind: a.kind,
    target: a.target,
    actions: a.actions,
    ...(a.scope.botId ? { botId: a.scope.botId } : {}),
    ...(a.scope.sessionId ? { sessionId: a.scope.sessionId } : {}),
    createdAt: a.createdAt,
    ...(a.expiresAt ? { expiresAt: a.expiresAt } : {}),
  };
}

export function createPermissionsTools(deps: PermissionsToolsDeps): ToolDefinition[] {
  const resolveUserId = deps.resolveUserId ?? defaultResolveUserId(deps);

  const listPendingApprovals: ToolDefinition = {
    name: 'list_pending_approvals',
    description: [
      'List the approvals currently waiting for the user to decide, as a',
      'read-only summary: how many are pending and, for each, its id, the',
      'tool that wants to run, the bot asking, and when it was raised.',
      'Use this to answer "what are you waiting on me for?". It cannot',
      'approve or deny anything — only the user decides approvals.',
      'Returns { count, pending: [{ id, toolName, botId, createdAt }] }.',
    ].join('\n'),
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const pending = deps.listApprovals('pending');
      return {
        count: pending.length,
        pending: pending.map((a) => ({
          id: a.id,
          toolName: a.toolName,
          botId: a.botId,
          createdAt: a.ts,
        })),
      };
    },
  };

  const listActiveGrants: ToolDefinition = {
    name: 'list_active_grants',
    description: [
      'List the lasting permission grants currently in force, read-only:',
      '"always allow" tool rules the user saved from approval cards, the',
      'allowances from the Permissions pane (websites, recipients, tasks),',
      'and per-item permission overrides. Use this to answer "what have I',
      'given you standing permission to do?". It cannot change any grant.',
      'Returns { alwaysAllow: [{ botId, ruleId, toolPattern }],',
      'allowances: [...], itemOverrides: [{ key, actions }] }.',
    ].join('\n'),
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (_args, ctx) => {
      const userId = resolveUserId(ctx);
      return {
        alwaysAllow: lastingAllowRules(deps.dataDir),
        allowances: listAllowances(deps.dataDir, userId).map(allowanceSummary),
        itemOverrides: listItemOverrides(deps.dataDir, userId).map((i) => ({
          key: i.key,
          actions: i.actions,
          updatedAt: i.updatedAt,
        })),
      };
    },
  };

  const listAllowancesTool: ToolDefinition = {
    name: 'list_allowances',
    description: [
      'List the user\'s allowances from the Permissions pane, read-only.',
      'An allowance lets an exact action proceed without asking for one',
      'exact target: a website (host), a recipient (sends), or a task.',
      'Each entry shows its id, kind, target, actions, scope and expiry.',
      'Allowances are created and revoked by the user in the pane — this',
      'tool cannot create or revoke one.',
      'Returns { count, allowances: [...] }.',
    ].join('\n'),
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (_args, ctx) => {
      const userId = resolveUserId(ctx);
      const allowances = listAllowances(deps.dataDir, userId);
      return { count: allowances.length, allowances: allowances.map(allowanceSummary) };
    },
  };

  return [listPendingApprovals, listActiveGrants, listAllowancesTool];
}

/** Register the inspection tools into a tool registry (skips on collision, like registerSignInCodeTools). */
export function registerPermissionsTools(
  deps: PermissionsToolsDeps & { registry: Map<string, ToolDefinition> },
): void {
  for (const tool of createPermissionsTools(deps)) {
    if (!deps.registry.has(tool.name)) {
      deps.registry.set(tool.name, tool);
    }
  }
}
