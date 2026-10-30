// SPDX-License-Identifier: Apache-2.0
/**
 * MCP-native core facade (Octomind parity #48).
 *
 * The runtime historically executed built-in tools by direct function
 * dispatch: the registry's ToolDefinition.handler was called in-process
 * and MCP was only an external surface (PlatformMcpServer re-exposes the
 * registry to OUTSIDE clients). This module closes the loop: it exposes
 * the built-in tool registry THROUGH the MCP protocol path, in-process,
 * via a loopback pair —
 *
 *   facade.listTools()/callTool()
 *     → MCPClient (the real client from mcp.ts: TOFU pinning, elicitation
 *       routing, context epochs all apply)
 *     → JSON-RPC frames over an InMemoryTransport pair
 *       (initialize, notifications/initialized, tools/list, tools/call)
 *     → an SDK Server whose handlers dispatch into the live registry
 *       (provider machinery shared with mcp-server.ts)
 *
 * so tool listing and tool calls for built-in tools traverse real MCP
 * message shapes instead of direct dispatch. The facade's listTools()
 * returns ToolDefinitions named EXACTLY like the registry's (the
 * `mcp:<tool>` registration prefix the client adds is stripped back off),
 * so a consumer can swap direct dispatch for the facade without renaming
 * anything.
 *
 * ## Transport switch (parent/runtime integration)
 *
 * `createToolFacade(registry, { toolTransport })` is the switch point:
 * - 'direct' (default): listTools/callTool dispatch to the registry
 *   handlers in-process — the historical behavior, zero protocol cost.
 * - 'mcp': everything goes through the loopback MCP path above.
 * `toolTransportFromEnv()` reads the same choice from
 * KRIYADOT_TOOL_TRANSPORT for hosts that prefer env configuration.
 * In runtime.ts the wiring is: build the registry as today, then
 * `const tools = await createToolFacade(registry, { toolTransport })`
 * and consume `tools.listTools()` / `tools.callTool(name, args, ctx)`
 * wherever the runtime currently reads the registry map directly.
 *
 * ## Deliberate non-goals
 *
 * - NO governance here: the runtime classifies/evaluates every call
 *   before dispatch (unchanged); the governed, approval-handshaking
 *   server for EXTERNAL clients remains PlatformMcpServer. The facade
 *   server is transport-only, and results are NOT untrusted-tagged —
 *   tagging is for data leaving the process to external clients.
 * - Result fidelity: strings cross as MCP text verbatim; other values
 *   cross as JSON (structuredContent when object-shaped). Values that
 *   are not JSON-serializable degrade to their JSON text form — an
 *   inherent property of the MCP wire, documented here so nobody is
 *   surprised.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { MCPClient, type McpToolDefinition, type SchemaDriftApprovalBroker } from './mcp.js';
import { annotationsForTool, coerceInputSchema, type PlatformToolDef } from './mcp-server.js';
import type { ToolContext, ToolDefinition } from './types.js';

/** Which transport built-in tool execution uses. */
export type ToolTransport = 'direct' | 'mcp';

/** Read the tool-transport switch from an env map (default: process.env). */
export function toolTransportFromEnv(env: Record<string, string | undefined> = process.env): ToolTransport {
  return env.KRIYADOT_TOOL_TRANSPORT === 'mcp' ? 'mcp' : 'direct';
}

/** One JSON-RPC frame observed on the loopback pair. */
export interface McpFrameObservation {
  direction: 'client->server' | 'server->client';
  /** The raw JSON-RPC message (jsonrpc/method/id/params or result/error). */
  frame: Record<string, unknown>;
}

export interface McpFacadeOptions {
  /** Server identity presented in the MCP initialize handshake. */
  serverInfo?: { name: string; version: string };
  /** Forwarded to the internal MCPClient (TOFU pin store path). */
  pinDbPath?: string;
  /** Forwarded to the internal MCPClient (drift approvals). */
  approvalBroker?: SchemaDriftApprovalBroker;
  sessionId?: string;
  botId?: string;
  /** Observe every JSON-RPC frame on the loopback pair (tests, tracing). */
  onFrame?: (obs: McpFrameObservation) => void;
}

/** The interchangeable tool surface: direct registry or MCP facade. */
export interface ToolFacade {
  readonly transport: ToolTransport;
  listTools(): Promise<ToolDefinition[]>;
  callTool(name: string, args: Record<string, unknown>, ctx?: ToolContext): Promise<unknown>;
  close(): Promise<void>;
}

type RegistryInput = Map<string, ToolDefinition> | Iterable<ToolDefinition>;

/** Live view over the registry input: a Map is read fresh on every call. */
function liveDefs(registry: RegistryInput): () => ToolDefinition[] {
  if (registry instanceof Map) return () => [...registry.values()];
  const snapshot = [...registry];
  return () => snapshot;
}

function toPlatformDef(def: ToolDefinition): PlatformToolDef {
  return {
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    ...(def.mutating !== undefined ? { mutating: def.mutating } : {}),
  };
}

const FACADE_JSON_META = 'kriyadot/facade-json';

function resultToWire(result: unknown): CallToolResult {
  if (typeof result === 'string') {
    return { content: [{ type: 'text' as const, text: result }] };
  }
  const text = JSON.stringify(result) ?? 'null';
  const wire: CallToolResult & { structuredContent?: Record<string, unknown>; _meta?: Record<string, unknown> } = {
    content: [{ type: 'text' as const, text }],
    _meta: { [FACADE_JSON_META]: true },
  };
  if (result !== null && typeof result === 'object' && !Array.isArray(result)) {
    wire.structuredContent = result as Record<string, unknown>;
  }
  return wire;
}

function resultFromWire(result: unknown): unknown {
  if (result === null || typeof result !== 'object') return result;
  const r = result as {
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
    structuredContent?: unknown;
    _meta?: Record<string, unknown>;
  };
  if (!Array.isArray(r.content)) return result;
  const text = r.content
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('');
  if (r.isError) throw new Error(text || 'MCP tool call failed');
  if (r.structuredContent !== undefined) return r.structuredContent;
  if (r._meta?.[FACADE_JSON_META] === true) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}

/**
 * Build the in-process MCP facade over a tool registry. Async because
 * the loopback pair performs the real MCP initialize handshake before
 * the facade is usable.
 */
export async function createMcpFacade(
  registry: RegistryInput,
  opts: McpFacadeOptions = {},
): Promise<ToolFacade> {
  const defs = liveDefs(registry);
  const serverInfo = opts.serverInfo ?? { name: 'kriyadot-builtin-mcp', version: '0.1.0' };

  // Server side of the loopback pair: real MCP protocol handlers over
  // the live registry (annotations/coercion shared with mcp-server.ts).
  const server = new Server(serverInfo, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: defs().map((def) => {
      const pd = toPlatformDef(def);
      return {
        name: pd.name,
        description: pd.description,
        inputSchema: coerceInputSchema(pd.parameters),
        annotations: annotationsForTool(pd),
      };
    }),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const def = defs().find((d) => d.name === name);
    if (!def) {
      const wire: CallToolResult = {
        content: [{ type: 'text' as const, text: `Unknown tool: "${name}"` }],
        isError: true,
      };
      return wire;
    }
    try {
      const result = await def.handler(
        (request.params.arguments ?? {}) as Record<string, unknown>,
        { sessionId: opts.sessionId ?? 'mcp-facade', botId: opts.botId ?? 'mcp-facade' },
      );
      return resultToWire(result);
    } catch (err) {
      const wire: CallToolResult = {
        content: [
          { type: 'text' as const, text: err instanceof Error ? err.message : String(err) },
        ],
        isError: true,
      };
      return wire;
    }
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  // Tap both directions so tests/tracing can assert the actual frames.
  if (opts.onFrame) {
    const onFrame = opts.onFrame;
    const tap = (transport: InMemoryTransport, direction: McpFrameObservation['direction']): void => {
      const original = transport.send.bind(transport);
      transport.send = async (message, options) => {
        onFrame({ direction, frame: message as Record<string, unknown> });
        return original(message, options);
      };
    };
    tap(clientTransport, 'client->server');
    tap(serverTransport, 'server->client');
  }

  const client = new MCPClient({
    pinDbPath: opts.pinDbPath,
    approvalBroker: opts.approvalBroker,
    sessionId: opts.sessionId,
    botId: opts.botId,
  });
  await server.connect(serverTransport);
  try {
    await client.connectTransport(clientTransport, `in-process:${serverInfo.name}`);
  } catch (err) {
    await server.close().catch(() => undefined);
    throw err;
  }

  // Facade-level def cache from the most recent listing. callTool does
  // NOT re-list: a caller holding defs from an older listing gets the
  // client's stale-epoch refusal after the tool list changes (#57b),
  // exactly like a direct MCP consumer would.
  let cachedDefs: ToolDefinition[] | null = null;

  const facade: ToolFacade = {
    transport: 'mcp',
    async listTools(): Promise<ToolDefinition[]> {
      const clientDefs = (await client.listTools()) as McpToolDefinition[];
      cachedDefs = clientDefs.map((def) => {
        // Client registered the tool as `mcp:<tool>` (no serverName was
        // set, deliberately): strip the prefix so facade consumers see
        // the registry's own names.
        const rawName = def.name.startsWith('mcp:') ? def.name.slice('mcp:'.length) : def.name;
        const listed: McpToolDefinition = {
          name: rawName,
          description: def.description,
          parameters: def.parameters,
          ...(def.annotations ? { annotations: def.annotations } : {}),
          ...(def.contextEpoch !== undefined ? { contextEpoch: def.contextEpoch } : {}),
          handler: async (args, _ctx) => {
            const result = await client.callToolByName(rawName, args, {
              contextEpoch: def.contextEpoch,
            });
            return resultFromWire(result);
          },
        };
        return listed;
      });
      return cachedDefs;
    },
    async callTool(name, args, ctx): Promise<unknown> {
      const defsNow = cachedDefs ?? (await facade.listTools());
      const def = defsNow.find((d) => d.name === name);
      if (!def) throw new Error(`Unknown tool: "${name}"`);
      return def.handler(args, ctx ?? { sessionId: 'mcp-facade', botId: 'mcp-facade' });
    },
    async close(): Promise<void> {
      cachedDefs = null;
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    },
  };
  return facade;
}

/** The direct-dispatch facade: today's behavior behind the same surface. */
export function createDirectFacade(registry: RegistryInput): ToolFacade {
  const defs = liveDefs(registry);
  return {
    transport: 'direct',
    async listTools(): Promise<ToolDefinition[]> {
      return defs();
    },
    async callTool(name, args, ctx): Promise<unknown> {
      const def = defs().find((d) => d.name === name);
      if (!def) throw new Error(`Unknown tool: "${name}"`);
      return def.handler(args, ctx ?? { sessionId: 'direct', botId: 'direct' });
    },
    async close(): Promise<void> {
      // Nothing to tear down: dispatch was in-process all along.
    },
  };
}

export interface CreateToolFacadeOptions extends McpFacadeOptions {
  /**
   * The config switch (Octomind parity #48): 'direct' (default) keeps
   * in-process dispatch; 'mcp' routes built-in tools through the
   * loopback MCP protocol path. See toolTransportFromEnv for the env
   * spelling (KRIYADOT_TOOL_TRANSPORT=mcp).
   */
  toolTransport?: ToolTransport;
}

/** Build whichever facade the switch selects. */
export async function createToolFacade(
  registry: RegistryInput,
  opts: CreateToolFacadeOptions = {},
): Promise<ToolFacade> {
  if (opts.toolTransport === 'mcp') return createMcpFacade(registry, opts);
  return createDirectFacade(registry);
}
