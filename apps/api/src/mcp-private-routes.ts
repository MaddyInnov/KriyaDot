// SPDX-License-Identifier: Apache-2.0
// Per-bot private MCP server HTTP API (W9 engines pack).
//
// Mounted by routes.ts on the main router; paths land under /api/bots/...:
//
//   GET    /bots/:botId/mcp-servers                 → the bot's private servers + live state
//   POST   /bots/:botId/mcp-servers                 → install for this bot only
//        body: { directoryId, label? } | { label, config }
//   PUT    /bots/:botId/mcp-servers/:serverId       → { config } replace config
//        (running process is torn down; next tool call respawns)
//   POST   /bots/:botId/mcp-servers/:serverId/enable|disable
//   DELETE /bots/:botId/mcp-servers/:serverId       → remove + kill process
//   GET    /bots/:botId/mcp-servers/:serverId/tools → tool names visible to this bot
//
// Isolation contract: servers installed here belong to ONE bot. They never
// appear in another bot's list or tool set (PerBotMcpManager keys processes
// and storage by botId), and bot deletion tears them down (chief-routes
// onBotDeleted hook + index.ts shutdown). Install spawns nothing — the
// process starts lazily on the bot's first tool call. All mutations are
// governance-audited.

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { InstalledMcpServerConfig, PerBotMcpManager } from '@mvp/agent-runtime';
import type { GovernanceGateway } from '@mvp/governance';
import { resolvePrincipal } from './principal.js';

export interface McpPrivateRouteDeps {
  manager: PerBotMcpManager;
  governance: GovernanceGateway;
  /** Bot existence check against the live roster. */
  botExists: (botId: string) => boolean;
}

function errorBody(error: string, detail?: string): { error: string; detail?: string } {
  return detail ? { error, detail } : { error };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function actor(req: Request): string {
  // Audit actor = the verified principal (principal.ts, OPEN-1 fix), never a raw header.
  return resolvePrincipal(req, {})?.userId ?? 'api';
}

export function registerMcpPrivateRoutes(router: Router, deps: McpPrivateRouteDeps): void {
  const { manager, governance, botExists } = deps;

  const requireBot = (req: Request, res: Response): boolean => {
    if (!botExists(req.params.botId)) {
      res.status(404).json(errorBody(`Unknown bot "${req.params.botId}".`));
      return false;
    }
    return true;
  };

  router.get('/bots/:botId/mcp-servers', (req: Request, res: Response) => {
    if (!requireBot(req, res)) return;
    try {
      res.json(
        manager.listForBot(req.params.botId).map((s) => ({
          ...s,
          connected: manager.isConnected(s.botId, s.id),
        })),
      );
    } catch (err) {
      res.status(500).json(errorBody('failed to list private MCP servers', errMessage(err)));
    }
  });

  router.post('/bots/:botId/mcp-servers', (req: Request, res: Response) => {
    if (!requireBot(req, res)) return;
    try {
      const body = (req.body ?? {}) as { directoryId?: unknown; label?: unknown; config?: unknown };
      let server;
      if (typeof body.directoryId === 'string' && body.directoryId) {
        const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim() : undefined;
        server = manager.installFromDirectory(req.params.botId, body.directoryId, label);
      } else if (typeof body.label === 'string' && body.config && typeof body.config === 'object') {
        server = manager.install(req.params.botId, body.label, body.config as InstalledMcpServerConfig);
      } else {
        res.status(400).json(errorBody('provide either "directoryId" or "label" + "config"'));
        return;
      }
      governance.audit('mcp.private_server_installed', {
        actor: actor(req),
        detail: { botId: req.params.botId, serverId: server.id, label: server.label },
      });
      res.status(201).json({ ...server, connected: false });
    } catch (err) {
      const msg = errMessage(err);
      const code = /Unknown|Invalid|already|needs a/i.test(msg) ? 400 : 500;
      res.status(code).json(errorBody('failed to install private MCP server', msg));
    }
  });

  router.put('/bots/:botId/mcp-servers/:serverId', async (req: Request, res: Response) => {
    if (!requireBot(req, res)) return;
    try {
      const config = (req.body as { config?: unknown } | undefined)?.config;
      if (!config || typeof config !== 'object') {
        res.status(400).json(errorBody('"config" is required'));
        return;
      }
      const server = await manager.updateConfig(
        req.params.botId,
        req.params.serverId,
        config as InstalledMcpServerConfig,
      );
      governance.audit('mcp.private_server_config_updated', {
        actor: actor(req),
        detail: { botId: req.params.botId, serverId: server.id, label: server.label },
      });
      res.json({ ...server, connected: manager.isConnected(server.botId, server.id) });
    } catch (err) {
      const msg = errMessage(err);
      const code = /Unknown/i.test(msg) ? 404 : /Invalid|needs a/i.test(msg) ? 400 : 500;
      res.status(code).json(errorBody('failed to update private MCP server', msg));
    }
  });

  const toggle = (enabled: boolean) => async (req: Request, res: Response) => {
    if (!requireBot(req, res)) return;
    try {
      await manager.setEnabled(req.params.botId, req.params.serverId, enabled);
      governance.audit(enabled ? 'mcp.private_server_enabled' : 'mcp.private_server_disabled', {
        actor: actor(req),
        detail: { botId: req.params.botId, serverId: req.params.serverId },
      });
      res.json({ ok: true, connected: manager.isConnected(req.params.botId, req.params.serverId) });
    } catch (err) {
      res.status(404).json(errorBody(errMessage(err)));
    }
  };
  router.post('/bots/:botId/mcp-servers/:serverId/enable', toggle(true));
  router.post('/bots/:botId/mcp-servers/:serverId/disable', toggle(false));

  router.delete('/bots/:botId/mcp-servers/:serverId', async (req: Request, res: Response) => {
    if (!requireBot(req, res)) return;
    try {
      const server = manager.getForBot(req.params.botId, req.params.serverId);
      await manager.remove(req.params.botId, req.params.serverId);
      governance.audit('mcp.private_server_removed', {
        actor: actor(req),
        detail: { botId: req.params.botId, serverId: req.params.serverId, label: server?.label },
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(404).json(errorBody(errMessage(err)));
    }
  });

  router.get('/bots/:botId/mcp-servers/:serverId/tools', (req: Request, res: Response) => {
    if (!requireBot(req, res)) return;
    try {
      const server = manager.getForBot(req.params.botId, req.params.serverId);
      if (!server) {
        res.status(404).json(errorBody(`Unknown private MCP server "${req.params.serverId}" for this bot.`));
        return;
      }
      // Only this bot's own definitions are listed — the manager scopes by botId.
      const names = manager
        .toolDefinitions(req.params.botId)
        .filter((d) => d.name.startsWith(`mcp:${server.label}:`))
        .map((d) => d.name);
      res.json({ ok: true, tools: names });
    } catch (err) {
      res.status(500).json(errorBody('failed to list private MCP tools', errMessage(err)));
    }
  });
}
