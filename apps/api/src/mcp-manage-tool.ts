// SPDX-License-Identifier: Apache-2.0

/**
 * `mcp_manage` agent tool (Octomind parity — MCP completion pass).
 *
 * Gives bots a first-class handle on their lazy MCP servers: list
 * installed servers with live health, check one server, run a health
 * sweep, or restart a server — the operations the health monitor and
 * the Workspace UI expose, callable mid-task when a tool starts
 * failing. Read-mostly; `restart` is the only state-changing action
 * and it is marked mutating so governance/parallelism rules treat it
 * as a barrier.
 */

import type { LazyMcpManager, ToolDefinition } from '@mvp/agent-runtime';

export function createMcpManageTool(manager: LazyMcpManager): ToolDefinition {
  return {
    name: 'mcp_manage',
    description:
      'Inspect and manage this workspace\'s MCP servers. Actions: "list" (installed servers with health), "status" (one server, needs serverId or label), "health_check" (probe all connected servers now; dead ones auto-restart), "restart" (disconnect + reconnect one server), "bind" (enable a server for your bot — server must be the EXACT label; near-matches never bind). Use it when an mcp: tool fails repeatedly or before relying on a flaky server.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'status', 'health_check', 'restart', 'bind'] },
        server: { type: 'string', description: 'Server id or label (for status/restart); exact label for bind' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    mutating: true,
    handler: async (args, ctx) => {
      const action = String(args.action ?? '');
      const resolve = (): { id: string; label: string } | { error: string } => {
        const needle = typeof args.server === 'string' ? args.server.trim() : '';
        if (!needle) return { error: 'this action needs "server" (an MCP server id or label)' };
        const servers = manager.list();
        const found =
          servers.find((s) => s.id === needle) ?? servers.find((s) => s.label === needle);
        return found ? { id: found.id, label: found.label } : { error: `no MCP server matches "${needle}"` };
      };
      switch (action) {
        case 'list':
          return {
            servers: manager.list().map((s) => ({
              id: s.id,
              label: s.label,
              enabled: s.enabled,
              kind: s.config.kind,
              health: manager.status(s.id),
            })),
          };
        case 'status': {
          const r = resolve();
          if ('error' in r) return r;
          return { server: r.label, health: manager.status(r.id) };
        }
        case 'health_check': {
          await manager.checkHealthOnce();
          return {
            servers: manager.list().map((s) => ({ label: s.label, health: manager.status(s.id) })),
          };
        }
        case 'restart': {
          const r = resolve();
          if ('error' in r) return r;
          await manager.disconnect(r.id);
          await manager.warmUp(r.id);
          return { server: r.label, restarted: true, health: manager.status(r.id) };
        }
        case 'bind': {
          // Exact-match only, by design (auto-bind safety rule).
          const label = typeof args.server === 'string' ? args.server : '';
          if (!label) return { error: 'bind needs "server" (the exact server label)' };
          const bound = manager.autoBindExact(ctx.botId, label);
          if (!bound) {
            return { error: `no installed, enabled MCP server is labeled exactly "${label}" — binds never fuzzy-match` };
          }
          return { bound: true, server: bound.label, id: bound.id };
        }
        default:
          return { error: `unknown action "${action}" — use list, status, health_check, restart, or bind` };
      }
    },
  };
}
