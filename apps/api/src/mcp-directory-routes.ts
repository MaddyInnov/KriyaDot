// SPDX-License-Identifier: Apache-2.0
// Lazy MCP directory HTTP API (OpenMausBot parity P1 #22).
//
// Mounted by the integrator (routes.ts) on the main router; all paths land
// under /api/mcp/...:
//
//   GET    /mcp/directory                 → directory entries + install state
//   GET    /mcp/servers                   → installed servers + health
//   POST   /mcp/servers                   → install (directoryId | custom label+config)
//   POST   /mcp/servers/:id/enable|disable
//   DELETE /mcp/servers/:id              → uninstall
//   PUT    /mcp/servers/:id/bots/:botId   → { enabled } per-bot override
//   POST   /mcp/servers/:id/connect      → warm up (connect now)
//
// Install only registers the config — the server process spawns on first
// tool call (LazyMcpManager). All mutations are governance-audited.

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { LazyMcpManager } from '@mvp/agent-runtime';
import type { InstalledMcpServerConfig } from '@mvp/agent-runtime';
import type { GovernanceGateway } from '@mvp/governance';
import { resolvePrincipal } from './principal.js';

export interface McpDirectoryRouteDeps {
  manager: LazyMcpManager;
  governance: GovernanceGateway;
  /** Re-sync lazy stubs into the shared tool registry after mutations. */
  refreshStubs: () => void;
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

export function registerMcpDirectoryRoutes(router: Router, deps: McpDirectoryRouteDeps): void {
  const { manager, governance, refreshStubs } = deps;

  router.get('/mcp/directory', (_req: Request, res: Response) => {
    try {
      res.json(manager.directoryWithInstallState());
    } catch (err) {
      res.status(500).json(errorBody('failed to load MCP directory', errMessage(err)));
    }
  });

  router.get('/mcp/servers', (_req: Request, res: Response) => {
    try {
      res.json(
        manager.list().map((s) => ({
          ...s,
          health: manager.status(s.id),
          botOverrides: manager.store.botOverrides(s.id),
        })),
      );
    } catch (err) {
      res.status(500).json(errorBody('failed to list MCP servers', errMessage(err)));
    }
  });

  router.post('/mcp/servers', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as {
        directoryId?: unknown;
        label?: unknown;
        config?: unknown;
      };
      let server;
      if (typeof body.directoryId === 'string' && body.directoryId) {
        const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim() : undefined;
        server = manager.installFromDirectory(body.directoryId, label);
      } else if (typeof body.label === 'string' && body.config && typeof body.config === 'object') {
        server = manager.installCustom(body.label, body.config as InstalledMcpServerConfig);
      } else {
        res.status(400).json(errorBody('provide either "directoryId" or "label" + "config"'));
        return;
      }
      governance.audit('mcp.server_installed', {
        actor: actor(req),
        detail: { serverId: server.id, label: server.label, directoryId: server.directoryId },
      });
      refreshStubs();
      res.status(201).json({ ...server, health: manager.status(server.id) });
    } catch (err) {
      const msg = errMessage(err);
      const code = /Unknown|Invalid|already installed|needs a/i.test(msg) ? 400 : 500;
      res.status(code).json(errorBody('failed to install MCP server', msg));
    }
  });

  const toggle = (enabled: boolean) => (req: Request, res: Response) => {
    try {
      manager.setEnabled(req.params.id, enabled);
      governance.audit(enabled ? 'mcp.server_enabled' : 'mcp.server_disabled', {
        actor: actor(req),
        detail: { serverId: req.params.id },
      });
      refreshStubs();
      res.json({ ok: true, health: manager.status(req.params.id) });
    } catch (err) {
      res.status(404).json(errorBody(errMessage(err)));
    }
  };
  router.post('/mcp/servers/:id/enable', toggle(true));
  router.post('/mcp/servers/:id/disable', toggle(false));

  router.delete('/mcp/servers/:id', (req: Request, res: Response) => {
    try {
      const server = manager.list().find((s) => s.id === req.params.id);
      manager.uninstall(req.params.id);
      governance.audit('mcp.server_uninstalled', {
        actor: actor(req),
        detail: { serverId: req.params.id, label: server?.label },
      });
      refreshStubs();
      res.json({ ok: true });
    } catch (err) {
      res.status(404).json(errorBody(errMessage(err)));
    }
  });

  router.put('/mcp/servers/:id/bots/:botId', (req: Request, res: Response) => {
    try {
      const enabled = (req.body as { enabled?: unknown } | undefined)?.enabled;
      if (typeof enabled !== 'boolean') {
        res.status(400).json(errorBody('"enabled" must be a boolean'));
        return;
      }
      manager.setBotEnabled(req.params.id, req.params.botId, enabled);
      governance.audit('mcp.server_bot_access', {
        actor: actor(req),
        detail: { serverId: req.params.id, botId: req.params.botId, enabled },
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(404).json(errorBody(errMessage(err)));
    }
  });

  router.post('/mcp/servers/:id/connect', async (req: Request, res: Response) => {
    try {
      await manager.warmUp(req.params.id);
      res.json({ ok: true, health: manager.status(req.params.id) });
    } catch (err) {
      res.status(502).json(errorBody('MCP server failed to start', errMessage(err)));
    }
  });
}
