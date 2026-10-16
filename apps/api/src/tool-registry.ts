// SPDX-License-Identifier: Apache-2.0
// Tool registry assembly: built-in tools plus MCP tools from every configured
// server, as a Map<string, ToolDefinition> (what AgentRuntime expects).
// MCPClient.listTools() already returns fully-wired ToolDefinitions named
// `mcp:<server>:<tool>` (server = the config key in mcp.json, e.g. "fetch");
// they are registered verbatim. A failing MCP connection is
// logged and skipped — the bot keeps working with the remaining tools.

import path from 'node:path';
import {
  BotMemoryStore,
  MCPClient,
  McpOAuthClient,
  McpOAuthRequiredError,
  SkillLoader,
  createBuiltInTools,
  createCodingTools,
  createGitTools,
  createMemoryTools,
  createSkillTools,
  makeWorkspaceResolver,
} from '@mvp/agent-runtime';
import type { BotConfig, SchemaDriftApprovalBroker, ToolDefinition } from '@mvp/agent-runtime';
import type { McpServerConfig } from './seed.js';
import {
  createMcpOAuthTokenStore,
  peekMcpOAuthClientInfo,
} from './mcp-oauth.js';

export interface McpConnection {
  server: string;
  tools: string[];
  ok: boolean;
  error?: string;
}

export interface BuiltRegistry {
  registry: Map<string, ToolDefinition>;
  connections: McpConnection[];
  /**
   * Connect to configured MCP servers and register their tools.
   * Deferred until after the HTTP server is listening so a slow/failing
   * MCP server (e.g. npx registry timeouts) never delays boot. Mutates the
   * shared `connections` array and `registry` map in place.
   */
  connectMcp: () => Promise<void>;
  close: () => Promise<void>;
}

export async function buildToolRegistry(opts: {
  workspaceDir: string;
  /** Directory for the TOFU schema-pin database (mcp-pins.db). */
  dataDir: string;
  /** Seed skills dir (for the read_skill tool's SkillLoader). */
  skillsDir: string;
  mcpServers: Record<string, McpServerConfig>;
  /** Broker used to request human approval when an MCP tool's schema drifts. */
  approvalBroker?: SchemaDriftApprovalBroker;
  /**
   * Optional bot lookup for per-bot workspaces (Octop-style isolation).
   * When provided, file/shell/git tools resolve the calling bot's workspace
   * per tool-call; bots without a workspace use `workspaceDir`.
   */
  getBotConfig?: (botId: string) => BotConfig | undefined;
}): Promise<BuiltRegistry> {
  const registry = new Map<string, ToolDefinition>();
  // Per-bot workspace resolver: falls back to the global workspaceDir when
  // no bot lookup is wired or the bot has no workspace configured.
  const resolveWorkspace = opts.getBotConfig
    ? makeWorkspaceResolver({
        getBotWorkspace: (botId) => opts.getBotConfig!(botId)?.workspace,
        globalWorkspaceDir: opts.workspaceDir,
        dataDir: opts.dataDir,
      })
    : opts.workspaceDir;
  for (const tool of createBuiltInTools({ workspaceDir: resolveWorkspace })) {
    registry.set(tool.name, tool);
  }
  // Phase 2: coding tools (patch/edit/glob/grep/LSP), per-bot memory tools,
  // and read_skill (progressive skill disclosure). All are ordinary registry
  // tools, so deny-by-default governance applies to each of them.
  for (const tool of createCodingTools({ workspaceDir: resolveWorkspace })) {
    registry.set(tool.name, tool);
  }
  // PR integration: git tools (status/diff auto-allowed; commit/branch/push
  // require approval via the default deny-by-default policy).
  for (const tool of createGitTools({ workspaceDir: resolveWorkspace })) {
    registry.set(tool.name, tool);
  }
  for (const tool of createMemoryTools({ store: new BotMemoryStore(opts.dataDir) })) {
    registry.set(tool.name, tool);
  }
  for (const tool of createSkillTools(
    new SkillLoader(opts.skillsDir, {
      pinDbPath: path.join(opts.dataDir, 'skill-pins.db'),
      approvalBroker: opts.approvalBroker,
      // User-imported skills (e.g. from Claude Code) land here; the primary
      // seed dir wins on name collisions.
      additionalDirs: [path.join(opts.dataDir, 'skills')],
    }),
  )) {
    registry.set(tool.name, tool);
  }

  const connections: McpConnection[] = [];
  const clients: MCPClient[] = [];

  async function connectMcp(): Promise<void> {
  for (const [serverName, serverConfig] of Object.entries(opts.mcpServers)) {
    // serverName becomes the `<server>` segment of `mcp:<server>:<tool>` so
    // governance policy can allowlist per server (mcpServerAllowRule).
    // TOFU schema pinning is enabled (mcp-pins.db): tool schemas are pinned
    // at first connect and any drift requires fresh human approval via the
    // governance broker (fail closed). Drift at boot is awaited with the
    // broker's default timeout — a rare, bounded delay; the tool stays
    // blocked on timeout/deny.
    const client = new MCPClient({
      serverName,
      pinDbPath: path.join(opts.dataDir, 'mcp-pins.db'),
      approvalBroker: opts.approvalBroker,
    });
    try {
      if ('url' in serverConfig && serverConfig.url) {
        // OAuth-protected MCP server: mint a bearer token from the encrypted
        // store (refreshing when needed). Missing/expired tokens fail with a
        // clear "OAuth required" error pointing at the connect URL.
        let authToken: string | undefined;
        if (serverConfig.oauth === true) {
          const oauthStore = createMcpOAuthTokenStore(opts.dataDir);
          const oauthClient = new McpOAuthClient({
            serverId: serverName,
            serverUrl: serverConfig.url,
            store: oauthStore,
            resolveClient: async (sid, metadata) => {
              const peeked = peekMcpOAuthClientInfo(opts.dataDir, sid);
              if (peeked) return peeked;
              // No client known and no request context for dynamic
              // registration here — the user must run the API connect flow.
              void metadata;
              throw new McpOAuthRequiredError(
                sid,
                `/api/mcp/oauth/start?server=${encodeURIComponent(sid)}`,
              );
            },
          });
          authToken = await oauthClient.getValidAccessToken();
        }
        await client.connectHttp(serverConfig.url, authToken ? { authToken } : undefined);
      } else if ('command' in serverConfig) {
        await client.connectStdio(serverConfig);
      } else {
        throw new Error('MCP server config needs either "url" or "command"');
      }
      clients.push(client);
      const registered: string[] = [];
      for (const tool of await client.listTools()) {
        if (registry.has(tool.name)) {
          console.warn(
            `[tools] MCP tool name collision for "${tool.name}" from server "${serverName}" — skipping`,
          );
          continue;
        }
        registry.set(tool.name, tool);
        registered.push(tool.name);
      }
      connections.push({ server: serverName, tools: registered, ok: true });
      console.log(`[tools] MCP server "${serverName}" connected: ${registered.length} tool(s)`);
    } catch (err) {
      // Contract: connection failure → log + continue, bot still works.
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[tools] MCP server "${serverName}" failed to connect: ${message} — continuing without it`);
      connections.push({ server: serverName, tools: [], ok: false, error: message });
      try {
        await client.close();
      } catch {
        // ignore close errors on a failed client
      }
    }
  }
  }

  return {
    registry,
    connections,
    connectMcp,
    close: async () => {
      await Promise.allSettled(clients.map((c) => c.close()));
    },
  };
}
