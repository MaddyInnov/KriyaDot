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
      id: 'allow-process-and-task-reads',
      toolPattern: '^(read_process_output|list_processes|poll_process_notes|task_list)$',
      actionClass: 'read',
      effect: 'allow',
      reason:
        'Background-process output polling and agent todo reads are read-only session state (CA-12/CA-13)',
    },
    {
      id: 'allow-agent-todos',
      toolPattern: '^(task_create|task_update)$',
      effect: 'allow',
      reason:
        'Agent-owned todo items (CA-12) mutate only the session\'s own task list — no files, no system state',
    },
    {
      id: 'allow-ask-user-question',
      toolPattern: '^ask_user_question$',
      effect: 'allow',
      reason:
        'Interactive question to the user: the human answer IS the decision; the tool cannot act without it',
    },
    {
      id: 'allow-create-skill',
      toolPattern: '^create_skill$',
      effect: 'allow',
      reason:
        'New skills start DISABLED and cannot affect any bot until a human explicitly enables them',
    },
    {
      id: 'allow-learn-skill',
      toolPattern: '^learn_skill$',
      effect: 'allow',
      reason:
        'Learned skills are draft proposals only: saving needs human approval and starts disabled',
    },
    {
      id: 'mcp-require-approval',
      toolPattern: '^mcp:',
      effect: 'require-approval',
      reason:
        'MCP servers are untrusted third parties; their tools need human approval unless the server is explicitly allowlisted',
    },
    {
      id: 'local-tools-require-approval',
      toolPattern: '^local:',
      effect: 'require-approval',
      reason:
        'Local project tools are executables from the workspace (.kriyadot/tools/) that run on the host via execFile with no sandbox confinement; they require human approval unless a more specific policy rule explicitly allows them (see docs/local-tools-security.md)',
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
      toolPattern: '^(run_command|run_background|build_and_repair|kill_process|exec|shell)$',
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
