// SPDX-License-Identifier: Apache-2.0
// MCP tool scope settings HTTP API (sibling web agent builds the panel).
// Mounted by the integrator (routes.ts), e.g.:
//
//   import { registerMcpToolScopeRoutes } from './mcp-tools-routes.js';
//   registerMcpToolScopeRoutes(router, { mcpServer, mcpScopeStore, governance });
//
// Routes (mounted at /api):
//   GET   /mcp/tools             → [{ id, name, description, requiredScope, scopes: { read, write, egress } }]
//   PATCH /mcp/tools/:id/scopes  → { read?, write?, egress? } → updated entry
//
// Enforcement lives in PlatformMcpServer.handleCallTool (mcp-scopes.ts): a
// call whose required scope toggle is OFF is denied with code `scope_denied`
// before governance evaluation runs.

import { Router } from 'express';
import type { Request, Response } from 'express';
import { parseScopePatch, requiredScopeForTool } from '@mvp/agent-runtime';
import type { McpScopeStore, PlatformToolDef } from '@mvp/agent-runtime';
import type { GovernanceGateway } from '@mvp/governance';
import { resolvePrincipal } from './principal.js';

export interface McpToolScopeDeps {
  mcpServer: { listToolDefs(): Promise<PlatformToolDef[]> };
  mcpScopeStore: McpScopeStore;
  governance: GovernanceGateway;
}

function errorBody(error: string, detail?: string): { error: string; detail?: string } {
  return detail ? { error, detail } : { error };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function registerMcpToolScopeRoutes(router: Router, deps: McpToolScopeDeps): void {
  const { mcpServer, mcpScopeStore, governance } = deps;

  const toolEntry = (def: PlatformToolDef) => ({
    id: def.name,
    name: def.name,
    description: def.description,
    requiredScope: requiredScopeForTool(def.name),
    scopes: mcpScopeStore.get(def.name),
  });

  router.get('/mcp/tools', async (_req: Request, res: Response) => {
    try {
      const defs = await mcpServer.listToolDefs();
      res.json(defs.map(toolEntry));
    } catch (err) {
      res.status(500).json(errorBody('failed to list MCP tools', errMessage(err)));
    }
  });

  router.patch('/mcp/tools/:id/scopes', async (req: Request, res: Response) => {
    let patch: { read?: boolean; write?: boolean; egress?: boolean };
    try {
      patch = parseScopePatch(req.body ?? {});
    } catch (err) {
      res.status(400).json(errorBody('invalid scopes patch', errMessage(err)));
      return;
    }
    try {
      const defs = await mcpServer.listToolDefs();
      const def = defs.find((d) => d.name === req.params.id);
      if (!def) {
        res.status(404).json(errorBody(`unknown MCP tool: ${req.params.id}`));
        return;
      }
      mcpScopeStore.set(def.name, patch);
      governance.audit('mcp.tool_scopes_updated', {
        actor: resolvePrincipal(req, {})?.userId ?? 'api',
        toolName: def.name,
        detail: { scopes: mcpScopeStore.get(def.name) },
      });
      res.json(toolEntry(def));
    } catch (err) {
      res.status(500).json(errorBody('failed to update MCP tool scopes', errMessage(err)));
    }
  });
}
