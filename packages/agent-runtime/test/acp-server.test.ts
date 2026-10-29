// SPDX-License-Identifier: Apache-2.0
// ACP server mode: KriyaDot as an ACP agent over stdio JSON-RPC.
// In-process streams + scripted mock provider — zero paid API usage.

import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../src/runtime.js';
import { AcpGovernanceGateway, AcpServer } from '../src/acp-server.js';
import { MockProvider } from '../src/providers/mock.js';
import type { BotConfig, LLMProvider, ToolDefinition } from '../src/types.js';

const deployTool: ToolDefinition = {
  name: 'deploy_app',
  description: 'Deploy the app.',
  parameters: { type: 'object', properties: {} },
  mutating: true,
  handler: async () => ({ deployed: true }),
};

class TestRuntime extends AgentRuntime {
  constructor(
    opts: ConstructorParameters<typeof AgentRuntime>[0],
    private readonly provider: LLMProvider,
  ) {
    super(opts);
  }
  protected override resolveProvider(): LLMProvider {
    return this.provider;
  }
}

const bot: BotConfig = {
  id: 'bot-acp',
  name: 'ACP Bot',
  description: 'test',
  systemPrompt: 'You are a test bot.',
  provider: 'mock',
  model: 'mock-model',
  skills: [],
  tools: ['deploy_app'],
  mcpServers: [],
};

interface Harness {
  send: (msg: Record<string, unknown>) => void;
  lines: Array<Record<string, unknown>>;
  waitFor: (pred: (m: Record<string, unknown>) => boolean, ms?: number) => Promise<Record<string, unknown>>;
  stop: () => Promise<void>;
}

function harness(provider: MockProvider, permission: 'approve' | 'deny'): Harness {
  const input = new PassThrough();
  const output = new PassThrough();
  const bridge: { server?: AcpServer } = {};
  const runtime = new TestRuntime(
    {
      dbPath: ':memory:',
      skillsDir: '/tmp/agent-runtime-test-skills-missing',
      governance: new AcpGovernanceGateway(bridge),
      toolRegistry: new Map([[deployTool.name, deployTool]]),
      defaultProviderId: 'mock',
    },
    provider,
  );
  let counter = 0;
  const server = new AcpServer({
    runtime,
    bot,
    input,
    output,
    createSessionId: () => `acp-session-${++counter}`,
  });
  bridge.server = server;
  server.start();

  const lines: Array<Record<string, unknown>> = [];
  const waiters: Array<{ pred: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void }> = [];
  const rl = createInterface({ input: output, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const msg = JSON.parse(line) as Record<string, unknown>;
    lines.push(msg);
    // Client behavior: answer permission requests per the scenario.
    if (msg.method === 'session/request_permission') {
      input.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            outcome: {
              outcome: 'selected',
              optionId: permission === 'approve' ? 'approve' : 'deny',
            },
          },
        }) + '\n',
      );
    }
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.pred(msg)) {
        waiters[i]!.resolve(msg);
        waiters.splice(i, 1);
      }
    }
  });

  return {
    send: (msg) => {
      input.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
    },
    lines,
    waitFor: (pred, ms = 5000) =>
      new Promise((resolve, reject) => {
        const existing = lines.find(pred);
        if (existing) return resolve(existing);
        const timer = setTimeout(() => reject(new Error('waitFor timed out')), ms);
        waiters.push({
          pred,
          resolve: (m) => {
            clearTimeout(timer);
            resolve(m);
          },
        });
      }),
    stop: async () => {
      await server.stop();
      rl.close();
    },
  };
}

describe('AcpServer', () => {
  it('handshakes, opens a session, and streams a turn with an approved tool call', async () => {
    const provider = new MockProvider([
      { toolCalls: [{ id: 'c1', name: 'deploy_app', args: {} }] },
      { content: 'Deployment finished.' },
    ]);
    const h = harness(provider, 'approve');
    try {
      h.send({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      const init = await h.waitFor((m) => m.id === 1);
      const initResult = init.result as { agentCapabilities?: unknown; protocolVersion?: number };
      expect(initResult.protocolVersion).toBe(1);
      expect(initResult.agentCapabilities).toBeDefined();

      h.send({ id: 2, method: 'session/new', params: { cwd: '/tmp', mcpServers: [] } });
      const created = await h.waitFor((m) => m.id === 2);
      const sessionId = (created.result as { sessionId: string }).sessionId;
      expect(sessionId).toContain('acp-session');

      h.send({
        id: 3,
        method: 'session/prompt',
        params: { sessionId, prompt: [{ type: 'text', text: 'deploy it' }] },
      });
      const done = await h.waitFor((m) => m.id === 3);
      expect((done.result as { stopReason: string }).stopReason).toBe('end_turn');

      const updates = h.lines.filter((m) => m.method === 'session/update');
      const kinds = updates.map(
        (u) => (u.params as { update: { sessionUpdate: string } }).update.sessionUpdate,
      );
      expect(kinds).toContain('tool_call');
      expect(kinds).toContain('tool_call_update');
      expect(kinds).toContain('agent_message_chunk');
      const chunkText = updates
        .filter(
          (u) =>
            (u.params as { update: { sessionUpdate: string } }).update.sessionUpdate ===
            'agent_message_chunk',
        )
        .map(
          (u) =>
            (u.params as { update: { content: { text: string } } }).update.content.text,
        )
        .join('');
      expect(chunkText).toContain('Deployment finished.');
      // The permission round-trip actually happened.
      expect(h.lines.some((m) => m.method === 'session/request_permission')).toBe(true);
    } finally {
      await h.stop();
    }
  });

  it('fails closed when the client denies permission', async () => {
    const provider = new MockProvider([
      { toolCalls: [{ id: 'c1', name: 'deploy_app', args: {} }] },
      { content: 'Understood, not deploying.' },
    ]);
    const h = harness(provider, 'deny');
    try {
      h.send({ id: 1, method: 'session/new', params: { cwd: '/tmp', mcpServers: [] } });
      const created = await h.waitFor((m) => m.id === 1);
      const sessionId = (created.result as { sessionId: string }).sessionId;
      h.send({
        id: 2,
        method: 'session/prompt',
        params: { sessionId, prompt: [{ type: 'text', text: 'deploy it' }] },
      });
      const done = await h.waitFor((m) => m.id === 2);
      expect((done.result as { stopReason: string }).stopReason).toBe('end_turn');
      const updates = h.lines.filter((m) => m.method === 'session/update');
      const toolUpdate = updates.find(
        (u) =>
          (u.params as { update: { sessionUpdate: string } }).update.sessionUpdate ===
          'tool_call_update',
      );
      expect(JSON.stringify(toolUpdate)).toContain('failed');
    } finally {
      await h.stop();
    }
  });

  it('answers unknown methods with a JSON-RPC error', async () => {
    const provider = new MockProvider([{ content: 'x' }]);
    const h = harness(provider, 'approve');
    try {
      h.send({ id: 9, method: 'bogus/method', params: {} });
      const err = await h.waitFor((m) => m.id === 9);
      expect((err.error as { code: number }).code).toBe(-32601);
    } finally {
      await h.stop();
    }
  });
});
