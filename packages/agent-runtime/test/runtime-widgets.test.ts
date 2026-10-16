// SPDX-License-Identifier: Apache-2.0
// Runtime wiring for interactive widgets (OpenMausBot parity P1 #15):
// - ctx.widget is set when runTurn gets a widgetCoordinator (and absent
//   otherwise, so ask_user_question falls back gracefully);
// - a tool result's `widget` attachment raises a non-interactive widget;
// - ask_user_question pauses the turn and resumes when the coordinator
//   settles the widget.
// Zero paid API usage: MockProvider + in-memory/SQLite temp stores.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../src/runtime.js';
import { MockProvider } from '../src/providers/mock.js';
import type { GovernanceDecision, GovernanceGateway } from '../src/governance.js';
import type { BotConfig, StreamEvent, ToolDefinition } from '../src/types.js';
import { WidgetCoordinator, WidgetStore } from '../src/widgets.js';
import { createBuiltInTools } from '../src/tools/builtin.js';

class FakeGateway implements GovernanceGateway {
  async classify(): Promise<GovernanceDecision> {
    return 'allow';
  }
  async evaluate(): Promise<{ decision: GovernanceDecision }> {
    return { decision: 'allow' };
  }
  async awaitDecision(): Promise<'approved' | 'denied'> {
    return 'approved';
  }
  decide(): void {}
  audit(): void {}
  async runPreHooks(): Promise<void> {}
  async runPostHooks(): Promise<void> {}
}

function testBot(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    id: 'bot-test',
    name: 'Test Bot',
    description: 'A bot for tests',
    systemPrompt: 'You are a test bot.',
    provider: 'mock',
    model: 'mock-model',
    skills: [],
    tools: [],
    mcpServers: [],
    ...overrides,
  };
}

function makeRuntime(tools: ToolDefinition[], provider: MockProvider): AgentRuntime {
  class TestRuntime extends AgentRuntime {
    protected resolveProvider(): MockProvider {
      return provider;
    }
  }
  return new TestRuntime({
    dbPath: ':memory:',
    skillsDir: '/tmp/agent-runtime-test-skills-missing',
    governance: new FakeGateway(),
    toolRegistry: new Map(tools.map((t) => [t.name, t])),
    defaultProviderId: 'mock',
  });
}

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('runTurn widget wiring', () => {
  it('raises a non-interactive widget from a tool result attachment', async () => {
    const report: ToolDefinition = {
      name: 'report',
      description: 'report',
      parameters: { type: 'object', properties: {} },
      handler: async () => ({
        summary: 'ok',
        widget: { kind: 'table', title: 'Results', columns: ['a'], rows: [[1], [2]] },
      }),
    };
    const provider = new MockProvider([
      { toolCalls: [{ id: 'c1', name: 'report', args: {} }] },
      { content: 'done' },
    ]);
    const runtime = makeRuntime([report], provider);
    const dir = mkdtempSync(join(tmpdir(), 'rt-widgets-'));
    const store = new WidgetStore(dir);
    const coordinator = new WidgetCoordinator(store);
    const events: StreamEvent[] = [];
    await runtime.runTurn({
      bot: testBot({ tools: ['report'] }),
      message: 'report',
      sessionId: 'sess-attach',
      widgetCoordinator: coordinator,
      onEvent: (e) => void events.push(e),
    });
    const widgetEvent = events.find((e) => e.type === 'widget');
    expect(widgetEvent).toMatchObject({
      type: 'widget',
      sessionId: 'sess-attach',
      interactive: false,
      widget: { kind: 'table', title: 'Results', columns: ['a'] },
    });
    if (widgetEvent?.type === 'widget') {
      expect(typeof widgetEvent.expiresAt).toBe('number');
      expect(store.get(widgetEvent.widgetId)?.status).toBe('pending');
    }
    runtime.close();
    store.close();
  });

  it('ignores invalid widget attachments without breaking the turn', async () => {
    const report: ToolDefinition = {
      name: 'report',
      description: 'report',
      parameters: { type: 'object', properties: {} },
      handler: async () => ({ widget: { kind: 'carousel', nonsense: true } }),
    };
    const provider = new MockProvider([{ toolCalls: [{ id: 'c1', name: 'report', args: {} }] }, { content: 'done' }]);
    const runtime = makeRuntime([report], provider);
    const dir = mkdtempSync(join(tmpdir(), 'rt-widgets-'));
    const coordinator = new WidgetCoordinator(new WidgetStore(dir));
    const events: StreamEvent[] = [];
    await runtime.runTurn({
      bot: testBot({ tools: ['report'] }),
      message: 'report',
      widgetCoordinator: coordinator,
      onEvent: (e) => void events.push(e),
    });
    expect(events.some((e) => e.type === 'widget')).toBe(false);
    expect(events.some((e) => e.type === 'done')).toBe(true);
    runtime.close();
    coordinator.widgetStore.close();
  });

  it('ask_user_question reports "not available" when no coordinator is attached', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rt-widgets-'));
    const ask = createBuiltInTools({ workspaceDir: dir }).find((t) => t.name === 'ask_user_question')!;
    const provider = new MockProvider([
      { toolCalls: [{ id: 'c1', name: 'ask_user_question', args: { question: 'Pick?' } }] },
      { content: 'done' },
    ]);
    const runtime = makeRuntime([ask], provider);
    const events: StreamEvent[] = [];
    await runtime.runTurn({
      bot: testBot({ tools: ['ask_user_question'] }),
      message: 'ask',
      onEvent: (e) => void events.push(e),
    });
    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(toolResult).toMatchObject({
      result: { error: expect.stringMatching(/not available in this context/) },
    });
    expect(events.some((e) => e.type === 'widget')).toBe(false);
    runtime.close();
  });

  it('ask_user_question pauses the turn and resumes on the settled answer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rt-widgets-'));
    const ask = createBuiltInTools({ workspaceDir: dir }).find((t) => t.name === 'ask_user_question')!;
    const provider = new MockProvider([
      {
        toolCalls: [
          {
            id: 'c1',
            name: 'ask_user_question',
            args: { question: 'Deploy?', options: [{ label: 'Yes' }, { label: 'No' }], timeoutMinutes: 1 },
          },
        ],
      },
      { content: 'deploying' },
    ]);
    const runtime = makeRuntime([ask], provider);
    const store = new WidgetStore(dir);
    const coordinator = new WidgetCoordinator(store);
    const events: StreamEvent[] = [];
    const turn = runtime.runTurn({
      bot: testBot({ tools: ['ask_user_question'] }),
      message: 'ask',
      sessionId: 'sess-ask',
      widgetCoordinator: coordinator,
      onEvent: (e) => void events.push(e),
    });
    // Wait for the widget event, then answer like the HTTP route would.
    let widgetId = '';
    for (let i = 0; i < 100 && !widgetId; i++) {
      await tick();
      const w = events.find((e) => e.type === 'widget');
      if (w?.type === 'widget') widgetId = w.widgetId;
    }
    expect(widgetId).toBeTruthy();
    coordinator.settle(widgetId, { answered: true, value: { selected: ['o2'] } });
    await turn;
    const widgetEvents = events.filter((e) => e.type === 'widget');
    expect(widgetEvents).toHaveLength(1);
    expect(widgetEvents[0]).toMatchObject({ sessionId: 'sess-ask', interactive: true });
    const answeredEvents = events.filter((e) => e.type === 'widget_answered');
    expect(answeredEvents).toHaveLength(1);
    expect(answeredEvents[0]).toMatchObject({ widgetId, answer: { answered: true } });
    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(toolResult).toMatchObject({
      result: {
        answers: [{ question: 'Deploy?', answered: true, selected: ['o2'], labels: ['No'] }],
        allAnswered: true,
      },
    });
    expect(events.some((e) => e.type === 'done')).toBe(true);
    runtime.close();
    store.close();
  });
});
