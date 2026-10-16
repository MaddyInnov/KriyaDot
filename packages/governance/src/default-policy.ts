// SPDX-License-Identifier: Apache-2.0

import type { Policy, PolicyRule } from './types.js';

/**
 * Hard denylist applied to `run_command` args.command BEFORE any policy rule.
 * A match is an unconditional 'deny' and is audited.
 *
 * Matches: `rm -rf /` (exact root wipe), mkfs invocations, `dd` writing to a
 * raw block device (`of=/dev/...`), disk wipe/partition tools
 * (shred/wipefs/fdisk/parted/…), and shell fork bombs like
 * `:(){ :|:& };:` or `(){ ... }`.
 */
export const DENYLIST_COMMAND_RE = /\brm\s+-rf\s+\/$|mkfs|\bdd\b[^;&|]*\bof=\/dev\/|\b(shred|wipefs|fdisk|sfdisk|gdisk|sgdisk|cgdisk|parted)\b|:?\(\)\s*\{/;

/**
 * Default policy for the gateway: deny-by-default.
 *
 * - `defaultEffect` is 'require-approval': any tool with no matching rule
 *   must be approved by a human (nothing auto-runs blind).
 * - Read-only tools (read_file, web_search, web_fetch) auto-allow.
 * - MCP tools (`mcp:<server>:<tool>`, legacy `mcp:<tool>`) REQUIRE APPROVAL:
 *   MCP servers are untrusted third parties. A server that exposes write,
 *   network, or command tools is NOT trusted by policy — every call pauses
 *   for a human unless the user explicitly allowlists that server (see
 *   mcpServerAllowRule below).
 * - Writes, command execution, HTTP calls, and destructive-sounding tools
 *   require approval.
 */
export const DEFAULT_POLICY: Policy = {
  defaultEffect: 'require-approval',
  rules: [
    {
      id: 'allow-reads',
      toolPattern: '^(read_file|web_search|web_fetch|read_skill|git_status|git_diff)$',
      actionClass: 'read',
      effect: 'allow',
      reason: 'Read-only tools are safe to auto-allow',
    },
    {
      id: 'allow-ask-user-question',
      toolPattern: '^ask_user_question$',
      effect: 'allow',
      reason:
        'Interactive question to the user: the human answer IS the decision; the tool cannot act without it',
    },
    {
      id: 'mcp-require-approval',
      toolPattern: '^mcp:',
      effect: 'require-approval',
      reason:
        'MCP servers are untrusted third parties; their tools need human approval unless the server is explicitly allowlisted',
    },
    {
      id: 'approval-file-writes',
      toolPattern: '^(write_file|edit_file|create_file|delete_file|remove_file)$',
      actionClass: 'write',
      effect: 'require-approval',
      reason: 'File writes mutate state',
    },
    {
      id: 'approval-execution',
      toolPattern: '^(run_command|exec|shell)$',
      actionClass: 'execute',
      effect: 'require-approval',
      reason: 'Command execution can change the system',
    },
    {
      id: 'approval-http',
      toolPattern: '^http',
      actionClass: 'network',
      effect: 'require-approval',
      reason: 'Network calls (incl. POST/PUT/DELETE) need approval',
    },
    {
      id: 'approval-destructive-names',
      toolPattern: 'delete|remove|drop|exec',
      effect: 'require-approval',
      reason: 'Destructive-sounding tool names need approval',
    },
  ],
};

/**
 * Escape a literal string for embedding in a RegExp pattern.
 */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Per-server MCP opt-in rule.
 *
 * MCP tools are registered as `mcp:<server>:<tool>` (see MCPClientOptions.serverName
 * in @mvp/agent-runtime). This builds an `allow` rule for exactly one server's
 * tools — the ONLY way an MCP tool auto-runs. Insert the returned rule into
 * the policy's `rules` array BEFORE the built-in `mcp-require-approval` rule
 * (first match wins). Servers not explicitly allowlisted keep requiring
 * human approval on every call.
 *
 * Example:
 *   const policy: Policy = {
 *     defaultEffect: 'require-approval',
 *     rules: [
 *       mcpServerAllowRule('fetch'), // user trusts the local "fetch" MCP server
 *       ...DEFAULT_POLICY.rules,
 *     ],
 *   };
 */
export function mcpServerAllowRule(serverName: string, reason?: string): PolicyRule {
  return {
    id: `allow-mcp-server-${serverName}`,
    toolPattern: `^mcp:${escapeRegExp(serverName)}:`,
    effect: 'allow',
    reason: reason ?? `User explicitly allowlisted MCP server "${serverName}"`,
  };
}
