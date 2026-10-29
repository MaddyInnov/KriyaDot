// SPDX-License-Identifier: Apache-2.0
// MCP Apps HTTP surface: sandboxed app serving + the host bridge.
//
// Mount (integrator, routes.ts — behind the normal loopback API auth):
//
//   import { registerMcpAppRoutes } from './mcp-apps-routes.js';
//   registerMcpAppRoutes(router, {
//     getClient: (serverId) => mcpClientsById.get(serverId),
//     governance, // GovernanceAdapter / agent-runtime gateway surface
//   });
//
// Routes (mounted at /api):
//   GET  /mcp-apps/:serverId/:encodedUri?nonce=…  → app HTML (resources/read)
//   POST /mcp-apps/:serverId/bridge               → JSON-RPC relay
//
// Security:
//   - Both routes sit behind the standard API auth (the router is mounted
//     under /api, which the loopback-auth middleware guards).
//   - The serve route returns the app HTML with a strict CSP: the frame
//     may run inline scripts but connect-src is 'none' — the app CANNOT
//     reach the network directly. All interaction crosses the bridge.
//   - The bridge requires the per-render nonce issued when the mcp-app
//     widget was created (McpAppNonceStore, shared with the runtime);
//     unknown/expired/mismatched nonces are rejected before any relay.
//   - Bridge tools/call is evaluated through the governance gateway with
//     the registered tool name `mcp:<server>:<tool>` — exactly the policy
//     surface native tool calls use. 'deny' (and 'require-approval',
//     which a sandboxed frame cannot satisfy interactively) come back as
//     JSON-RPC errors; the tool never executes.

import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  McpAppNonceStore,
  defaultMcpAppNonceStore,
  mcpToolName,
  type ToolCall,
  type ToolContext,
} from '@mvp/agent-runtime';

/** Strict CSP for served MCP App documents. */
export const MCP_APP_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'self' blob:",
  "style-src 'unsafe-inline'",
  "connect-src 'none'",
  "frame-ancestors 'self'",
].join('; ');

/** Minimal MCP client surface the routes need (MCPClient satisfies it). */
export interface McpAppClient {
  readResource(uri: string): Promise<{ contents: Array<Record<string, unknown>> }>;
  callToolByName(name: string, args: Record<string, unknown>): Promise<unknown>;
}

/** Governance surface used for bridge tools/call (agent-runtime shape). */
export interface McpAppGovernance {
  evaluate(
    call: ToolCall,
    ctx: ToolContext,
  ): Promise<{ decision: 'allow' | 'deny' | 'require-approval'; reason?: string }>;
}

export interface McpAppsDeps {
  /** Resolve a connected MCP client by server id (the mcp config key). */
  getClient: (serverId: string) => McpAppClient | undefined;
  /** Governance gateway for bridge tool calls. Absent → tools/call denied. */
  governance?: McpAppGovernance;
  /** Nonce store; defaults to the process-wide store the runtime issues into. */
  nonces?: McpAppNonceStore;
  /** Identity stamped onto governance evaluations for bridge calls. */
  botId?: string;
  actor?: string;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcError(id: string | number | null | undefined, code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function rpcResult(id: string | number | null | undefined, result: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Extract the HTML text from a resources/read result. */
export function appHtmlFromReadResult(result: {
  contents: Array<Record<string, unknown>>;
}): string | undefined {
  for (const c of result.contents ?? []) {
    if (typeof c.text === 'string') return c.text;
    if (typeof c.blob === 'string') {
      try {
        return Buffer.from(c.blob, 'base64').toString('utf8');
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export function registerMcpAppRoutes(router: Router, deps: McpAppsDeps): void {
  const nonces = deps.nonces ?? defaultMcpAppNonceStore;

  // ---- Serve the app document -------------------------------------------
  router.get('/mcp-apps/:serverId/:encodedUri', async (req: Request, res: Response) => {
    const serverId = req.params.serverId;
    let resourceUri: string;
    try {
      resourceUri = decodeURIComponent(req.params.encodedUri);
    } catch {
      res.status(400).json({ error: 'invalid encoded resource URI' });
      return;
    }
    if (!resourceUri.startsWith('ui://')) {
      res.status(400).json({ error: 'resource URI must use the ui:// scheme' });
      return;
    }
    const nonce = typeof req.query.nonce === 'string' ? req.query.nonce : '';
    if (!nonces.verify(nonce, serverId, resourceUri)) {
      res.status(401).json({ error: 'invalid or expired MCP App render nonce' });
      return;
    }
    const client = deps.getClient(serverId);
    if (!client) {
      res.status(404).json({ error: `unknown MCP server: ${serverId}` });
      return;
    }
    try {
      const read = await client.readResource(resourceUri);
      const html = appHtmlFromReadResult(read);
      if (html === undefined) {
        res.status(502).json({ error: 'MCP server returned no HTML for the app resource' });
        return;
      }
      res
        .status(200)
        .set({
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': MCP_APP_CSP,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
        })
        .send(html);
    } catch (err) {
      res.status(502).json({ error: `failed to read app resource: ${errMessage(err)}` });
    }
  });

  // ---- Bridge: JSON-RPC relayed from the sandboxed frame -----------------
  router.post('/mcp-apps/:serverId/bridge', async (req: Request, res: Response) => {
    const serverId = req.params.serverId;
    const body = (req.body ?? {}) as { nonce?: unknown; message?: JsonRpcRequest };
    const message: JsonRpcRequest =
      body.message && typeof body.message === 'object'
        ? body.message
        : (body as unknown as JsonRpcRequest);
    const nonce =
      typeof body.nonce === 'string'
        ? body.nonce
        : typeof req.header('x-mcp-app-nonce') === 'string'
          ? (req.header('x-mcp-app-nonce') as string)
          : '';
    const id = message.id ?? null;
    if (!nonces.verify(nonce, serverId)) {
      res.status(401).json(rpcError(id, -32001, 'invalid or expired MCP App render nonce'));
      return;
    }
    const client = deps.getClient(serverId);
    if (!client) {
      res.status(404).json(rpcError(id, -32002, `unknown MCP server: ${serverId}`));
      return;
    }
    const method = typeof message.method === 'string' ? message.method : '';
    const params = (message.params ?? {}) as Record<string, unknown>;
    try {
      switch (method) {
        case 'ui/initialize': {
          res.json(
            rpcResult(id, {
              protocolVersion: '2025-06-18',
              host: { name: 'KriyaDot', version: '0.1.0' },
              capabilities: { tools: true, resources: true },
              serverId,
            }),
          );
          return;
        }
        case 'resources/read': {
          const uri = typeof params.uri === 'string' ? params.uri : '';
          if (!uri) {
            res.json(rpcError(id, -32602, 'resources/read requires a "uri" param'));
            return;
          }
          // The nonce was verified for this server above; reads are scoped
          // to that server for the life of the render.
          const read = await client.readResource(uri);
          res.json(rpcResult(id, read));
          return;
        }
        case 'tools/call': {
          const name = typeof params.name === 'string' ? params.name : '';
          const args =
            params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
              ? (params.arguments as Record<string, unknown>)
              : {};
          if (!name) {
            res.json(rpcError(id, -32602, 'tools/call requires a "name" param'));
            return;
          }
          if (!deps.governance) {
            res.json(
              rpcError(id, -32003, 'tools/call denied: governance gateway is not configured'),
            );
            return;
          }
          const registeredName = mcpToolName(serverId, name);
          const call: ToolCall = { id: `mcp-app-bridge-${Date.now()}`, name: registeredName, args };
          const ctx = {
            sessionId: 'mcp-app-bridge',
            botId: deps.botId ?? 'mcp-app',
            actor: deps.actor ?? 'mcp-app-bridge',
          } as unknown as ToolContext;
          const evaluation = await deps.governance.evaluate(call, ctx);
          if (evaluation.decision !== 'allow') {
            res.json(
              rpcError(
                id,
                -32004,
                evaluation.decision === 'deny'
                  ? `tools/call denied by governance: ${evaluation.reason ?? registeredName}`
                  : `tools/call requires human approval, which a sandboxed app cannot request: ${registeredName}`,
              ),
            );
            return;
          }
          const result = await client.callToolByName(name, args);
          res.json(rpcResult(id, result ?? null));
          return;
        }
        default:
          res.json(rpcError(id, -32601, `method not supported by the MCP App bridge: ${method}`));
          return;
      }
    } catch (err) {
      res.json(rpcError(id, -32603, errMessage(err)));
    }
  });
}

/** Convenience factory when the caller wants a standalone router. */
export function createMcpAppsRouter(deps: McpAppsDeps): Router {
  const router = Router();
  registerMcpAppRoutes(router, deps);
  return router;
}
