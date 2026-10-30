// SPDX-License-Identifier: Apache-2.0

/**
 * `mcp_manage` agent tool (Octomind parity — MCP completion pass).
 *
 * Gives bots a first-class handle on their lazy MCP servers: list
 * installed servers with live health, check one server, run a health
 * sweep, restart a server, bind a server to the calling bot — and, since
 * the #53 closure, add/remove servers mid-session:
 *
 * - `add` persists a NEW server (from a curated `directoryId`, or a
 *   custom `config` object) through the same store the API uses
 *   (<dataDir>/mcp-directory.db) and connects it live, so the install
 *   is usable immediately AND survives a restart. A failed live connect
 *   still leaves the server persisted, with the error in its health.
 * - `remove` disconnects a server live and deletes its persisted
 *   record — gone from the registry, the store, and the next boot.
 *
 * `restart`/`add`/`remove` are state-changing; the tool is marked
 * mutating so governance/parallelism rules treat it as a barrier.
 */

import type {
  InstalledMcpServerConfig,
  LazyMcpManager,
  ToolDefinition,
} from '@mvp/agent-runtime';

export function createMcpManageTool(manager: LazyMcpManager): ToolDefinition {
  return {
    name: 'mcp_manage',
    description:
      'Inspect and manage this workspace\'s MCP servers. Actions: "list" (installed servers with health), "status" (one server, needs serverId or label), "health_check" (probe all connected servers now; dead ones auto-restart), "restart" (disconnect + reconnect one server), "bind" (enable a server for your bot — server must be the EXACT label; near-matches never bind), "add" (install a NEW server and persist it: pass directoryId for a curated directory server, or label + config {kind:"stdio",command,args?,env?} / {kind:"http",url,oauth?}; connects live unless "connect":false), "remove" (disconnect + permanently delete a server, needs server). Use it when an mcp: tool fails repeatedly, before relying on a flaky server, or to install a server the task needs.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'status', 'health_check', 'restart', 'bind', 'add', 'remove'],
        },
        server: { type: 'string', description: 'Server id or label (for status/restart); exact label for bind; id or label for remove' },
        directoryId: { type: 'string', description: 'For "add": id of a curated directory entry to install' },
        label: { type: 'string', description: 'For "add" with a custom config: the new server\'s label' },
        config: {
          type: 'object',
          description: 'For "add": a full custom server config ({kind:"stdio",command,args?,env?,requiredEnv?} or {kind:"http",url,oauth?,requiredEnv?}); with directoryId it patches the directory config per-field',
          additionalProperties: true,
        },
        connect: { type: 'boolean', description: 'For "add": connect live after persisting (default true); false = persist only, connects lazily on first tool call' },
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
        case 'add': {
          // #53: persist a new server mid-session and (by default)
          // connect it live. manager.addServer persists through the
          // directory store first, so even a failed connect leaves a
          // durable install whose health records the error.
          const directoryId = typeof args.directoryId === 'string' ? args.directoryId.trim() : '';
          const label = typeof args.label === 'string' ? args.label.trim() : '';
          const config =
            typeof args.config === 'object' && args.config !== null && !Array.isArray(args.config)
              ? (args.config as InstalledMcpServerConfig)
              : undefined;
          if (!directoryId && !config) {
            return { error: 'add needs either "directoryId" (curated server) or "label" + "config" (custom server)' };
          }
          if (!directoryId && !label) {
            return { error: 'add with a custom "config" needs a "label" for the new server' };
          }
          try {
            const installed = await manager.addServer({
              ...(directoryId ? { directoryId } : {}),
              ...(label ? { label } : {}),
              ...(config ? { config } : {}),
              connect: args.connect !== false,
            });
            return {
              added: true,
              persisted: true,
              server: installed.label,
              id: installed.id,
              kind: installed.config.kind,
              health: manager.status(installed.id),
            };
          } catch (err) {
            // addServer persists BEFORE connecting: a connect failure
            // still leaves a durable install. Report that honestly
            // instead of claiming the whole add failed.
            const persisted = manager
              .list()
              .find((s) => s.label === (label || directoryId));
            if (persisted) {
              return {
                added: true,
                persisted: true,
                connected: false,
                server: persisted.label,
                id: persisted.id,
                kind: persisted.config.kind,
                health: manager.status(persisted.id),
                warning: `server persisted but the live connect failed: ${err instanceof Error ? err.message : String(err)}`,
              };
            }
            return { error: `add failed: ${err instanceof Error ? err.message : String(err)}` };
          }
        }
        case 'remove': {
          // #53: disconnect live + delete the persisted record.
          const needle = typeof args.server === 'string' ? args.server.trim() : '';
          if (!needle) return { error: 'remove needs "server" (an MCP server id or label)' };
          const removed = await manager.removeServer(needle);
          if (!removed) return { error: `no MCP server matches "${needle}"` };
          return { removed: true, persisted: true, server: needle };
        }
        default:
          return { error: `unknown action "${action}" — use list, status, health_check, restart, bind, add, or remove` };
      }
    },
  };
}
