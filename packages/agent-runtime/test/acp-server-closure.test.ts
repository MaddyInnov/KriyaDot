// SPDX-License-Identifier: Apache-2.0
// ACP closure (#98/#99): session/new parses mcpServers + cwd, host MCP
// tools are exposed to the session and torn down at close; session/load
// restores + replays; usage events are emitted as usage_update.

import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../src/runtime.js';
import { AcpGovernanceGateway, AcpServer, parseAcpMcpServers, type AcpMcpClientLike } from '../src/acp-server.js';
import { MockProvider } from '../src/providers/mock.js';
import type { BotConfig, LLMProvider, ToolDefinition } from '../src/types.js';

const bot: BotConfig = {
  id: 'bot-acp2', name: 'ACP2', description: 'test', systemPrompt: 'You are a test bot.',
  provider: 'mock', model: 'mock-model', skills: [], tools: [], mcpServers: [],
};

class TestRuntime extends AgentRuntime {
  constructor(opts: ConstructorParameters<typeof AgentRuntime>[0], private readonly provider: LLMProvider) { super(opts); }
  protected override resolveProvider(): LLMProvider { return this.provider; }
}

const fakeTool: ToolDefinition = {
  name: 'mcp:fake:echo', description: 'Echo via fake MCP server.',
  parameters: { type: 'object', properties: { text: { type: 'string' } } },
  handler: async (args) => ({ echoed: String(args.text ?? '') }),
};

function harness(provider: MockProvider) {
  const input = new PassThrough();
  const output = new PassThrough();
  const bridge: { server?: AcpServer } = {};
  const toolRegistry = new Map<string, ToolDefinition>();
  const runtime = new TestRuntime({
    dbPath: ':memory:', skillsDir: '/tmp/agent-runtime-test-skills-missing',
    governance: new AcpGovernanceGateway(bridge), toolRegistry, defaultProviderId: 'mock',
  }, provider);
  let counter = 0;
  let closedClients = 0;
  const server = new AcpServer({
    runtime, bot, input, output,
    createSessionId: () => `acp2-session-${++counter}`,
    toolRegistry,
    createMcpClient: (): AcpMcpClientLike => ({
      connectStdio: async () => {}, connectHttp: async () => {},
      listTools: async () => [fakeTool],
      close: async () => { closedClients += 1; },
    }),
  });
  bridge.server = server;
  server.start();
  const lines: Array<Record<string, unknown>> = [];
  const waiters: Array<{ pred: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void }> = [];
  const rl = createInterface({ input: output, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const msg = JSON.parse(line) as Record<string, unknown>;
    lines.push(msg);
    // Client behavior: approve permission requests (governance gateway).
    if (msg.method === 'session/request_permission') {
      input.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'selected', optionId: 'approve' } } }) + '\n');
    }
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i]!.pred(msg)) { waiters[i]!.resolve(msg); waiters.splice(i, 1); }
  });
  return {
    lines, toolRegistry, server,
    closedClients: () => closedClients,
    send: (msg: Record<string, unknown>) => { input.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n'); },
    waitFor: (pred: (m: Record<string, unknown>) => boolean, ms = 5000) => new Promise<Record<string, unknown>>((resolve, reject) => {
      const existing = lines.find(pred);
      if (existing) return resolve(existing);
      const timer = setTimeout(() => reject(new Error('waitFor timed out')), ms);
      waiters.push({ pred, resolve: (m) => { clearTimeout(timer); resolve(m); } });
    }),
    stop: async () => { await server.stop(); rl.close(); },
  };
}

describe('ACP closure #98/#99', () => {
  it('parseAcpMcpServers keeps only connectable entries', () => {
    expect(parseAcpMcpServers([{ name: 'a', command: 'x' }, { name: 'b' }, { name: 'c', url: 'http://x' }, 'junk'])).toHaveLength(2);
    expect(parseAcpMcpServers(undefined)).toEqual([]);
  });

  it('session/new connects host MCP servers, exposes tools, tears down on close; usage + load work', async () => {
    const provider = new MockProvider([
      { toolCalls: [{ id: 'c1', name: 'mcp:fake:echo', args: { text: 'hi' } }] },
      { content: 'echo done' },
      { content: 'second turn' },
    ]);
    const h = harness(provider);
    try {
      h.send({ id: 1, method: 'initialize', params: {} });
      const init = await h.waitFor((m) => m.id === 1);
      const caps = (init.result as { agentCapabilities: { loadSession: boolean; mcpCapabilities: Record<string, boolean> } }).agentCapabilities;
      expect(caps.loadSession).toBe(true);
      expect(caps.mcpCapabilities.http).toBe(true);
      expect(caps.mcpCapabilities.sse).toBe(false);
      expect(caps.mcpCapabilities.stdio).toBe(true);

      h.send({ id: 2, method: 'session/new', params: { cwd: '/tmp/work', mcpServers: [{ name: 'fake', command: 'fake-mcp' }] } });
      const created = await h.waitFor((m) => m.id === 2);
      const result = created.result as { sessionId: string; cwd?: string; _meta?: { mcpTools?: string[] } };
      expect(result.cwd).toBe('/tmp/work');
      expect(result._meta?.mcpTools).toContain('mcp:fake:echo');
      expect(h.server.sessionMcpTools(result.sessionId)).toContain('mcp:fake:echo');
      expect(h.toolRegistry.has('mcp:fake:echo')).toBe(true);

      h.send({ id: 3, method: 'session/prompt', params: { sessionId: result.sessionId, prompt: [{ type: 'text', text: 'echo hi' }] } });
      const doneRes = await h.waitFor((m) => m.id === 3);
      expect((doneRes.result as { stopReason: string }).stopReason).toBe('end_turn');
      const updates = h.lines.filter((m) => m.method === 'session/update');
      const kinds = updates.map((u) => (u.params as { update: { sessionUpdate: string } }).update.sessionUpdate);
      expect(kinds).toContain('tool_call');
      // Usage side-channel: a usage_update notification fired for the turn.
      const usage = updates.find((u) => (u.params as { update: { sessionUpdate: string } }).update.sessionUpdate === 'usage_update');
      expect(usage).toBeDefined();
      expect((usage!.params as { update: { used: number } }).update.used).toBeGreaterThanOrEqual(0);

      // session/load restores the persisted session and replays history.
      const before = h.lines.length;
      h.send({ id: 4, method: 'session/load', params: { sessionId: result.sessionId } });
      await h.waitFor((m) => m.id === 4);
      const replayed = h.lines.slice(before).filter((m) => m.method === 'session/update')
        .map((u) => (u.params as { update: { sessionUpdate: string } }).update.sessionUpdate);
      expect(replayed).toContain('user_message_chunk');
      expect(replayed).toContain('agent_message_chunk');

      h.send({ id: 5, method: 'session/load', params: { sessionId: 'nope-unknown' } });
      const loadErr = await h.waitFor((m) => m.id === 5);
      expect((loadErr.error as { code: number }).code).toBe(-32602);

      // Session close tears the MCP client down and unregisters its tools.
      h.send({ id: 6, method: 'session/close', params: { sessionId: result.sessionId } });
      await h.waitFor((m) => m.id === 6);
      expect(h.closedClients()).toBe(1);
      expect(h.toolRegistry.has('mcp:fake:echo')).toBe(false);
      expect(h.server.sessionMcpTools(result.sessionId)).toEqual([]);
    } finally {
      await h.stop();
    }
  });
});
