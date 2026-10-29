// SPDX-License-Identifier: Apache-2.0
// Lazy MCP loading for CLI-driver bots (W9 engines pack):
// - the tool set presented to a CLI driver excludes full MCP schemas up
//   front and includes only the search/describe affordances
// - the prompt a mock CLI driver receives carries tool names/descriptions
//   but NOT the unloaded tools' schema payloads
// - searching loads the matching tools; describing loads one tool
// - calling a loaded tool routes to its real handler; calling an unloaded
//   or unknown tool fails closed
// - loaded state persists across turns on the driver; the next turn's
//   prompt carries the loaded tool's full schema
// All CLI processes are mocks — zero real CLI invocations.

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  CliLazyMcpBridge,
  MCP_DESCRIBE_TOOL_NAME,
  MCP_SEARCH_TOOL_NAME,
} from '../src/providers/cli-lazy-mcp.js';
import { NativeCliDriver, CliSessionStore } from '../src/providers/cli-driver.js';
import { CopilotAcpProvider } from '../src/providers/acp-engines.js';
import type { ToolContext, ToolDefinition } from '../src/types.js';

const SECRET_SCHEMA_PROP = 'secretSchemaPropFetch';

function mcpTool(name: string, description: string, result: unknown): ToolDefinition {
  return {
    name,
    description,
    parameters: {
      type: 'object',
      properties: { [SECRET_SCHEMA_PROP]: { type: 'string' } },
      required: [SECRET_SCHEMA_PROP],
    },
    handler: async (args) => ({ result, args }),
  };
}

function sampleTools(): ToolDefinition[] {
  return [
    {
      name: 'read_file',
      description: 'Read a file.',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
      handler: async () => 'file contents',
    },
    mcpTool('mcp:fetch:fetch', 'Fetch a URL and return markdown.', 'fetched!'),
    mcpTool('mcp:time:get_current_time', 'Get the current time in a timezone.', '12:00'),
  ];
}

const ctx: ToolContext = { sessionId: 's1', botId: 'bot-a' };

describe('CliLazyMcpBridge presentation', () => {
  it('presents non-MCP tools + affordances, and withholds full MCP schemas', () => {
    const bridge = CliLazyMcpBridge.fromTools(sampleTools());
    const presented = bridge.presentedTools(sampleTools());
    const names = presented.map((t) => t.name);
    expect(names).toContain('read_file');
    expect(names).toContain(MCP_SEARCH_TOOL_NAME);
    expect(names).toContain(MCP_DESCRIBE_TOOL_NAME);
    // The MCP tools themselves are NOT presented with schemas up front.
    expect(names).not.toContain('mcp:fetch:fetch');
    expect(names).not.toContain('mcp:time:get_current_time');
    const serialized = JSON.stringify(presented.map((t) => t.parameters));
    expect(serialized).not.toContain(SECRET_SCHEMA_PROP);
  });

  it('prompt section lists names + descriptions but no unloaded schemas', () => {
    const bridge = CliLazyMcpBridge.fromTools(sampleTools());
    const section = bridge.promptSection();
    expect(section).toContain('mcp:fetch:fetch');
    expect(section).toContain('Fetch a URL');
    expect(section).toContain(MCP_SEARCH_TOOL_NAME);
    expect(section).not.toContain(SECRET_SCHEMA_PROP);
  });

  it('is inert when the bot has no MCP tools', () => {
    const plain: ToolDefinition[] = [
      { name: 'read_file', description: 'x', parameters: {}, handler: async () => 1 },
    ];
    const bridge = CliLazyMcpBridge.fromTools(plain);
    expect(bridge.hasMcpTools()).toBe(false);
    expect(bridge.promptSection()).toBe('');
    expect(bridge.presentedTools(plain).map((t) => t.name)).toEqual(['read_file']);
  });
});

describe('CliLazyMcpBridge load-on-demand', () => {
  it('searching loads the matching server tools only', () => {
    const bridge = CliLazyMcpBridge.fromTools(sampleTools());
    const hits = bridge.searchTools('fetch');
    expect(hits.map((h) => h.name)).toEqual(['mcp:fetch:fetch']);
    expect(bridge.isLoaded('mcp:fetch:fetch')).toBe(true);
    expect(bridge.isLoaded('mcp:time:get_current_time')).toBe(false);
    // Loaded tools now appear in the presented set WITH their schemas.
    const presented = bridge.presentedTools(sampleTools());
    const loadedDef = presented.find((t) => t.name === 'mcp:fetch:fetch');
    expect(loadedDef).toBeDefined();
    expect(JSON.stringify(loadedDef?.parameters)).toContain(SECRET_SCHEMA_PROP);
    // And the prompt section now carries the loaded schema.
    expect(bridge.promptSection()).toContain(SECRET_SCHEMA_PROP);
  });

  it('describe loads exactly one tool and returns its full definition', () => {
    const bridge = CliLazyMcpBridge.fromTools(sampleTools());
    const def = bridge.describeTool('mcp:time:get_current_time');
    expect(def?.name).toBe('mcp:time:get_current_time');
    expect(JSON.stringify(def?.parameters)).toContain(SECRET_SCHEMA_PROP);
    expect(bridge.loadedToolNames()).toEqual(['mcp:time:get_current_time']);
    expect(bridge.describeTool('mcp:nope:nope')).toBeUndefined();
  });

  it('affordance handlers execute the search/describe against the catalog', async () => {
    const bridge = CliLazyMcpBridge.fromTools(sampleTools(), { botId: 'bot-a' });
    const search = bridge.searchToolDef();
    const out = (await search.handler({ query: 'time' }, ctx)) as { tools: Array<{ name: string }> };
    expect(out.tools.map((t) => t.name)).toEqual(['mcp:time:get_current_time']);
    const describe = bridge.describeToolDef();
    const described = (await describe.handler({ name: 'mcp:fetch:fetch' }, ctx)) as { name: string };
    expect(described.name).toBe('mcp:fetch:fetch');
    // Bot boundary: another bot cannot drive this bridge's affordances.
    await expect(search.handler({ query: 'x' }, { sessionId: 's', botId: 'bot-b' })).rejects.toThrow(
      /belongs to bot "bot-a"/,
    );
  });

  it('calling routes only after load; unloaded and unknown calls fail closed', async () => {
    const bridge = CliLazyMcpBridge.fromTools(sampleTools());
    await expect(
      bridge.callTool({ id: 'c1', name: 'mcp:fetch:fetch', args: { url: 'https://x' } }, ctx),
    ).rejects.toThrow(/not loaded yet/);
    await expect(bridge.callTool({ id: 'c2', name: 'mcp:nope:x', args: {} }, ctx)).rejects.toThrow(
      /Unknown MCP tool/,
    );
    bridge.searchTools('fetch');
    const result = await bridge.callTool(
      { id: 'c3', name: 'mcp:fetch:fetch', args: { url: 'https://x' } },
      ctx,
    );
    expect(result).toEqual({ result: 'fetched!', args: { url: 'https://x' } });
  });
});

// ---------------------------------------------------------------------------
// Driver-level: a mock CLI process receives the lazy presentation.
// ---------------------------------------------------------------------------

function makeFakeSpawn(lines: string[]) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const spawnFn = (command: string, args: string[]) => {
    calls.push({ command, args });
    const emitter = new EventEmitter();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = {
      killed: false,
      kill: () => {
        queueMicrotask(() => emitter.emit('close', null, 'SIGKILL'));
      },
    };
    queueMicrotask(() => {
      for (const line of lines) stdout.emit('data', Buffer.from(line + '\n'));
      queueMicrotask(() => emitter.emit('close', 0, null));
    });
    return {
      child: child as unknown as import('node:child_process').ChildProcess,
      stdout: stdout as unknown as NodeJS.ReadableStream,
      stderr: stderr as unknown as NodeJS.ReadableStream,
      done: new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        emitter.on('close', (code: number | null, signal: NodeJS.Signals | null) => resolve({ code, signal }));
      }),
    };
  };
  return { spawnFn, calls };
}

const CODEX_LINES = [
  JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
  JSON.stringify({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'done' } }),
  JSON.stringify({ type: 'turn.completed' }),
];

describe('NativeCliDriver lazy MCP presentation', () => {
  it('prompt to the mock CLI excludes unloaded MCP schemas but includes the search affordance', async () => {
    const { spawnFn, calls } = makeFakeSpawn(CODEX_LINES);
    const driver = new NativeCliDriver({
      cliId: 'codex',
      model: 'gpt-5',
      command: 'fake-codex',
      spawnFn,
      sessionStore: new CliSessionStore(),
      timeoutMs: 5000,
      preflightAuthCheck: () => Promise.resolve(null),
    });
    await driver.chat([{ role: 'user', content: 'please fetch a page' }], sampleTools(), { model: 'gpt-5' });
    expect(calls).toHaveLength(1);
    const promptArg = calls[0].args[calls[0].args.length - 1];
    expect(promptArg).toContain('mcp:fetch:fetch');
    expect(promptArg).toContain(MCP_SEARCH_TOOL_NAME);
    expect(promptArg).toContain(MCP_DESCRIBE_TOOL_NAME);
    expect(promptArg).not.toContain(SECRET_SCHEMA_PROP);
    expect(driver.getLazyMcpBridge()?.hasMcpTools()).toBe(true);
  });

  it('after a host-driven search, the next turn prompt carries the loaded schema and calls route', async () => {
    const { spawnFn, calls } = makeFakeSpawn(CODEX_LINES);
    const driver = new NativeCliDriver({
      cliId: 'codex',
      model: 'gpt-5',
      command: 'fake-codex',
      spawnFn,
      sessionStore: new CliSessionStore(),
      timeoutMs: 5000,
      preflightAuthCheck: () => Promise.resolve(null),
    });
    await driver.chat([{ role: 'user', content: 'hi' }], sampleTools(), { model: 'gpt-5' });
    const hits = driver.searchMcpTools('fetch');
    expect(hits.map((h) => h.name)).toEqual(['mcp:fetch:fetch']);
    // Calling the loaded tool through the driver routes to the real handler.
    const routed = await driver.callLoadedMcpTool(
      { id: 'x', name: 'mcp:fetch:fetch', args: { url: 'https://example.com' } },
      ctx,
    );
    expect(routed).toEqual({ result: 'fetched!', args: { url: 'https://example.com' } });
    // Next turn: the loaded tool's full schema is now in the prompt.
    await driver.chat([{ role: 'user', content: 'again' }], sampleTools(), { model: 'gpt-5' });
    const prompt2 = calls[1].args[calls[1].args.length - 1];
    expect(prompt2).toContain(SECRET_SCHEMA_PROP);
    expect(prompt2).toContain('Loaded MCP tools');
  });

  it('lazyMcp: false restores the previous no-MCP prompt behavior', async () => {
    const { spawnFn, calls } = makeFakeSpawn(CODEX_LINES);
    const driver = new NativeCliDriver({
      cliId: 'codex',
      model: 'gpt-5',
      command: 'fake-codex',
      spawnFn,
      timeoutMs: 5000,
      preflightAuthCheck: () => Promise.resolve(null),
      lazyMcp: false,
    });
    await driver.chat([{ role: 'user', content: 'hi' }], sampleTools(), { model: 'gpt-5' });
    const promptArg = calls[0].args[calls[0].args.length - 1];
    expect(promptArg).not.toContain(MCP_SEARCH_TOOL_NAME);
    expect(driver.getLazyMcpBridge()).toBeNull();
  });
});

describe('CopilotAcpProvider lazy MCP presentation', () => {
  it('ACP prompt carries the lazy directory without unloaded schemas', async () => {
    const prompts: string[] = [];
    const provider = new CopilotAcpProvider({
      model: 'default',
      cwd: process.cwd(),
      createClient: () => ({
        connect: async () => ({ agentName: 'mock-copilot' }),
        promptStream: async (text: string) => {
          prompts.push(text);
          return { text: 'ok' };
        },
        isConnected: () => true,
        close: () => undefined,
      }),
    });
    await provider.chat([{ role: 'user', content: 'hi' }], sampleTools(), { model: 'default' });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('mcp:fetch:fetch');
    expect(prompts[0]).toContain(MCP_SEARCH_TOOL_NAME);
    expect(prompts[0]).not.toContain(SECRET_SCHEMA_PROP);
    const hits = provider.searchMcpTools('time');
    expect(hits.map((h) => h.name)).toEqual(['mcp:time:get_current_time']);
    provider.close();
  });
});
