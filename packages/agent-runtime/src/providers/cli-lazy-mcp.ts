// SPDX-License-Identifier: Apache-2.0
/**
 * Lazy MCP loading for CLI-driver / ACP bots (W9 engines pack).
 *
 * Native bots get MCP tools through the lazy directory (mcp-directory.ts):
 * stub definitions whose handlers connect the real server on first call.
 * Bots running on native CLI drivers (cli-driver.ts) or ACP engines
 * (acp-engines.ts) are different: the driver receives the turn's
 * ToolDefinitions but the CLI owns its own tool execution, so dumping every
 * MCP tool's full JSON schema into the turn is wasteful and, for
 * prompt-driven drivers, impossible to act on mid-turn.
 *
 * This bridge mirrors the native lazy behaviour at the driver boundary:
 *
 * - PRESENTATION: `presentedTools()` returns the non-MCP tools untouched
 *   plus exactly two lightweight affordances — `mcp_search_tools` and
 *   `mcp_describe_tool`. Full MCP schemas are NOT presented up front.
 * - SEARCH / DESCRIBE: searching matches tools by name/description/server
 *   and LOADS them (their full schemas become available); describing one
 *   tool loads just that tool. This is load-on-first-use, like the native
 *   stubs' connect-on-first-call.
 * - CALLING: `callTool()` routes to the real handler ONLY for loaded
 *   tools; calling an unloaded MCP tool fails closed with instructions to
 *   search first.
 * - PROMPT DRIVERS: `promptSection()` renders the same affordance as text
 *   for prompt-only drivers (native CLI / ACP): tool NAMES + one-line
 *   descriptions (never schemas) for unloaded tools, and full schemas only
 *   for tools already loaded in earlier turns. Loaded state lives on the
 *   bridge instance, which the driver keeps across turns.
 *
 * Honest limitation: a non-interactive CLI turn cannot call back into
 * KriyaDot mid-turn, so loading happens BETWEEN turns — the host (or the
 * driver's observation of an affordance tool event) runs the search, and
 * the next turn presents the loaded schemas. Within a single turn the CLI
 * still has its own built-in tools, exactly as before.
 *
 * Bot boundary: when constructed with a botId, affordance handlers and
 * callTool refuse contexts from any other bot.
 */

import type { ToolCall, ToolContext, ToolDefinition } from '../types.js';

export const MCP_SEARCH_TOOL_NAME = 'mcp_search_tools';
export const MCP_DESCRIBE_TOOL_NAME = 'mcp_describe_tool';

/** MCP tools are the `mcp:<server>:<tool>` definitions (see mcp.ts). */
export function isMcpToolName(name: string): boolean {
  return name.startsWith('mcp:');
}

export interface McpToolSearchHit {
  name: string;
  description: string;
  /** Server segment of `mcp:<server>:<tool>` ('' for legacy `mcp:<tool>`). */
  server: string;
}

function serverOf(name: string): string {
  const parts = name.split(':');
  return parts.length >= 3 ? parts[1] : '';
}

function shortDescription(description: string): string {
  const firstLine = description.split('\n')[0]?.trim() ?? '';
  return firstLine.length > 160 ? `${firstLine.slice(0, 157)}...` : firstLine;
}

export interface CliLazyMcpBridgeOptions {
  /** Owning bot: affordance handlers + callTool enforce this bot boundary. */
  botId?: string;
}

export class CliLazyMcpBridge {
  private readonly catalog = new Map<string, ToolDefinition>();
  private readonly loaded = new Set<string>();
  private readonly botId?: string;

  constructor(mcpTools: ToolDefinition[], opts: CliLazyMcpBridgeOptions = {}) {
    for (const def of mcpTools) {
      if (isMcpToolName(def.name)) this.catalog.set(def.name, def);
    }
    this.botId = opts.botId;
  }

  /** Build a bridge from a turn's full tool list (non-MCP tools are ignored). */
  static fromTools(tools: ToolDefinition[], opts: CliLazyMcpBridgeOptions = {}): CliLazyMcpBridge {
    return new CliLazyMcpBridge(tools.filter((t) => isMcpToolName(t.name)), opts);
  }

  get size(): number {
    return this.catalog.size;
  }

  hasMcpTools(): boolean {
    return this.catalog.size > 0;
  }

  catalogNames(): string[] {
    return [...this.catalog.keys()];
  }

  isLoaded(name: string): boolean {
    return this.loaded.has(name);
  }

  loadedToolNames(): string[] {
    return [...this.loaded];
  }

  /** Full definitions of the tools loaded so far. */
  loadedTools(): ToolDefinition[] {
    return [...this.loaded].map((n) => this.catalog.get(n)!).filter(Boolean);
  }

  private assertBot(ctx: ToolContext): void {
    if (this.botId && ctx.botId !== this.botId) {
      throw new Error(`Lazy MCP bridge belongs to bot "${this.botId}" and cannot be used by bot "${ctx.botId}".`);
    }
  }

  /**
   * Search the catalog by free text (name, server, description). Matching
   * tools are LOADED: their full schemas join `loadedTools()` and become
   * callable via `callTool()`. An empty query loads nothing and returns
   * the lightweight directory (names + descriptions only).
   */
  searchTools(query: string): McpToolSearchHit[] {
    const q = query.trim().toLowerCase();
    const hits: McpToolSearchHit[] = [];
    for (const def of this.catalog.values()) {
      const hit: McpToolSearchHit = {
        name: def.name,
        description: shortDescription(def.description),
        server: serverOf(def.name),
      };
      if (!q) {
        hits.push(hit);
        continue;
      }
      const haystack = `${def.name} ${def.description}`.toLowerCase();
      if (haystack.includes(q)) {
        this.loaded.add(def.name);
        hits.push(hit);
      }
    }
    return hits;
  }

  /** Load one tool by exact name and return its FULL definition (schema included). */
  describeTool(name: string): ToolDefinition | undefined {
    const def = this.catalog.get(name);
    if (!def) return undefined;
    this.loaded.add(name);
    return def;
  }

  /**
   * The tool set presented at the start of a turn: non-MCP tools pass
   * through untouched; MCP tools are represented ONLY by the two
   * affordances (plus any already-loaded tools, with full schemas).
   */
  presentedTools(allTools: ToolDefinition[]): ToolDefinition[] {
    const out = allTools.filter((t) => !isMcpToolName(t.name));
    if (!this.hasMcpTools()) return out;
    out.push(...this.loadedTools());
    out.push(this.searchToolDef(), this.describeToolDef());
    return out;
  }

  searchToolDef(): ToolDefinition {
    return {
      name: MCP_SEARCH_TOOL_NAME,
      description:
        'Search the MCP tools available to this bot by keyword. Returns matching tool names and ' +
        'short descriptions, and loads them so their full schemas become available and they can be called. ' +
        'MCP tool schemas are loaded on demand — search before trying to use an MCP tool.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keyword matched against tool names, servers, and descriptions.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> => {
        this.assertBot(ctx);
        const query = typeof args.query === 'string' ? args.query : '';
        return { tools: this.searchTools(query) };
      },
    };
  }

  describeToolDef(): ToolDefinition {
    return {
      name: MCP_DESCRIBE_TOOL_NAME,
      description:
        'Load one MCP tool by its exact name (e.g. "mcp:fetch:fetch") and return its full definition, ' +
        'including the complete input schema. The tool becomes callable after this.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Exact MCP tool name, as returned by mcp_search_tools.' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> => {
        this.assertBot(ctx);
        const name = typeof args.name === 'string' ? args.name : '';
        const def = this.describeTool(name);
        if (!def) throw new Error(`Unknown MCP tool "${name}". Search first with ${MCP_SEARCH_TOOL_NAME}.`);
        return { name: def.name, description: def.description, parameters: def.parameters };
      },
    };
  }

  /**
   * Route a call to a loaded MCP tool's real handler. Fails closed for
   * unknown tools and for tools that have not been loaded yet.
   */
  async callTool(call: ToolCall, ctx: ToolContext): Promise<unknown> {
    this.assertBot(ctx);
    const def = this.catalog.get(call.name);
    if (!def) throw new Error(`Unknown MCP tool "${call.name}".`);
    if (!this.loaded.has(call.name)) {
      throw new Error(
        `MCP tool "${call.name}" is not loaded yet. Load it first with ${MCP_SEARCH_TOOL_NAME} or ${MCP_DESCRIBE_TOOL_NAME}.`,
      );
    }
    return def.handler(call.args, ctx);
  }

  /**
   * Text section for prompt-driven drivers (native CLI / ACP). Unloaded
   * tools appear as names + one-line descriptions ONLY — no schemas. Loaded
   * tools appear with their full schemas. Empty string when the bot has no
   * MCP tools.
   */
  promptSection(): string {
    if (!this.hasMcpTools()) return '';
    const lines: string[] = [
      '[KriyaDot MCP tools — loaded on demand]',
      `You have access to MCP tools through KriyaDot. Their full schemas are NOT all loaded yet.`,
      `To use one, first ask for it by name in a later turn after it has been loaded via the ` +
        `${MCP_SEARCH_TOOL_NAME} / ${MCP_DESCRIBE_TOOL_NAME} affordances (the host loads tools between turns).`,
      'Available MCP tools (name — description):',
    ];
    for (const def of this.catalog.values()) {
      if (this.loaded.has(def.name)) continue;
      lines.push(`- ${def.name} — ${shortDescription(def.description)}`);
    }
    const loaded = this.loadedTools();
    if (loaded.length > 0) {
      lines.push('', 'Loaded MCP tools (full schemas):');
      for (const def of loaded) {
        lines.push(`- ${def.name} — ${shortDescription(def.description)}`);
        lines.push(`  input schema: ${JSON.stringify(def.parameters)}`);
      }
    }
    return lines.join('\n');
  }
}
