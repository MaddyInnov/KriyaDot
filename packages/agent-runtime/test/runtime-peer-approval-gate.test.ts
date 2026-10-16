// SPDX-License-Identifier: Apache-2.0
// Peer-approval gate inside AgentRuntime.runTurn (OpenMausBot parity):
// - the gate is consulted BEFORE governance on ask_bot / message_bot /
//   delegate-to-another-bot;
// - when the gate allows, governance does NOT raise a second (generic)
//   approval card for the same call (no double-prompting);
// - a deny aborts the call with a clear message and never executes it.

import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRuntime } from '../src/runtime.js';
import { MockProvider } from '../src/providers/mock.js';
import type { GovernanceDecision, GovernanceGateway } from '../src/governance.js';
import type { BotConfig, StreamEvent, ToolCall, ToolDefinition } from '../src/types.js';
import {
  PeerApprovalStore,
  createPeerApprovalGate,
} from '../src/peer-approval.js';
import type { PeerApprovalBroker, PeerApprovalCard, RaisePeerCardInput } from '../src/peer-approval.js';

/** Governance that requires approval for everything (deny-by-default). */
class RequireApprovalGateway implements GovernanceGateway {
  approvalsMinted = 0;
  async classify(): Promise<GovernanceDecision> {
    return 'require-approval';
  }
  async evaluate(): Promise<{ decision: GovernanceDecision; approvalId?: string }> {
    this.approvalsMinted += 1;
    return { decision: 'require-approval', approvalId: `gw-${this.approvalsMinted}` };
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
    id: 'scout',
    name: 'Scout',
    description: 'research',
    systemPrompt: 'You research.',
    provider: 'mock',
    model: 'mock-model',
    skills: [],
    tools: ['ask_bot'],
    mcpServers: [],
    ...overrides,
  };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'peer-gate-runtime-test-'));
}

interface GateHarness {
  runtime: AgentRuntime;
  store: PeerApprovalStore;
  gateway: RequireApprovalGateway;
  requested: RaisePeerCardInput[];
  cards: PeerApprovalCard[];
  settle: (verdict: 'allowed' | 'denied' | 'expired') => void;
}

function makeHarness(): GateHarness {
  const dir = tempDir();
  const store = new PeerApprovalStore(dir);
  const gateway = new RequireApprovalGateway();
  const requested: RaisePeerCardInput[] = [];
  const cards: PeerApprovalCard[] = [];
  let settleFn: (v: 'allowed' | 'denied' | 'expired') => void = () => {};
  const broker: PeerApprovalBroker = {
    requestCard: async (input) => {
      requested.push(input);
      const card = store.raiseCard(input);
      cards.push(card);
      return card;
    },
    awaitDecision: (cardId) =>
      new Promise<'allowed' | 'denied' | 'expired'>((resolve) => {
        settleFn = resolve;
        void cardId;
      }),
    settle: (cardId, decision) => {
      void cardId;
      settleFn(decision);
    },
  };
  const gate = createPeerApprovalGate({
    store,
    broker,
    getBotName: (id) => ({ scout: 'Scout', coder: 'Coder' })[id] ?? id,
  });

  class TestRuntime extends AgentRuntime {
    private readonly mock: MockProvider;
    constructor(provider: MockProvider) {
      super({
        dbPath: ':memory:',
        skillsDir: '/tmp/peer-gate-runtime-test-skills-missing',
        governance: gateway,
        toolRegistry: new Map<string, ToolDefinition>(),
        defaultProviderId: 'mock',
        peerApprovalGate: gate,
      });
      this.mock = provider;
    }
    protected resolveProvider(): MockProvider {
      return this.mock;
    }
  }

  const askCall: ToolCall = {
    id: 'call-1',
    name: 'ask_bot',
    args: { bot_id: 'coder', message: 'what is 2+2?' },
  };
  const provider = new MockProvider([{ toolCalls: [askCall] }, { content: 'done' }]);
  const runtime = new TestRuntime(provider);
  // Register the ask_bot tool after construction (registry is a live map).
  const toolRegistry = (runtime as unknown as { toolRegistry: Map<string, ToolDefinition> }).toolRegistry;
  toolRegistry.set('ask_bot', {
    name: 'ask_bot',
    description: 'ask another bot',
    parameters: {},
    handler: async () => ({ reply: '4' }),
  });

  return {
    runtime,
    store,
    gateway,
    requested,
    cards,
    settle: (v) => settleFn(v),
  };
}

describe('peerApprovalGate in runTurn', () => {
  it('allow via peer card: tool executes, NO generic approval card (no double-prompt)', async () => {
    const h = makeHarness();
    const events: StreamEvent[] = [];
    const audits: Array<{ type: string; detail?: unknown }> = [];
    const origAudit = h.runtime.audit.bind(h.runtime);
    h.runtime.audit = ((entry: { type: string; detail?: unknown }) => {
      audits.push({ type: entry.type, detail: entry.detail });
      return origAudit(entry as never);
    }) as typeof h.runtime.audit;

    const turn = h.runtime.runTurn({
      bot: testBot(),
      message: 'go',
      sessionId: 'peer-allow',
      onEvent: (e) => void events.push(e),
    });
    // Let the gate raise the card, then approve it.
    await vi.waitFor(() => expect(h.requested).toHaveLength(1), { timeout: 5000 });
    h.settle('allowed');
    await turn;

    // The tool executed.
    const toolResults = events.filter((e) => e.type === 'tool_result');
    expect(toolResults).toHaveLength(1);
    // No generic approval card was raised for the peer-covered call…
    expect(events.filter((e) => e.type === 'approval_required')).toHaveLength(0);
    // …even though governance would have required one.
    expect(h.gateway.approvalsMinted).toBeGreaterThan(0);
    // Peer card events were emitted (sender "waiting on user" state).
    expect(events.some((e) => e.type === 'peer_approval_required')).toBe(true);
    expect(events.some((e) => e.type === 'peer_approval_decided')).toBe(true);
    // Audit shows the generic card was suppressed by peer coverage.
    expect(audits.some((a) => a.type === 'tool.peer_approval_covered')).toBe(true);
    h.store.close();
  });

  it('deny: the call never executes and the model gets a clear message', async () => {
    const h = makeHarness();
    const events: StreamEvent[] = [];
    const turn = h.runtime.runTurn({
      bot: testBot(),
      message: 'go',
      sessionId: 'peer-deny',
      onEvent: (e) => void events.push(e),
    });
    await vi.waitFor(() => expect(h.requested).toHaveLength(1), { timeout: 5000 });
    h.settle('denied');
    await turn;

    const toolResults = events.filter((e) => e.type === 'tool_result');
    expect(toolResults).toHaveLength(1);
    const tr = toolResults[0]!;
    expect(tr.type).toBe('tool_result');
    if (tr.type === 'tool_result') {
      expect(tr.denied).toBe(true);
      expect(JSON.stringify(tr.result)).toMatch(/denied/);
    }
    expect(events.filter((e) => e.type === 'approval_required')).toHaveLength(0);
    h.store.close();
  });

  it('expiry: graceful failure mentioning the 15-minute expiry', async () => {
    const h = makeHarness();
    const events: StreamEvent[] = [];
    const turn = h.runtime.runTurn({
      bot: testBot(),
      message: 'go',
      sessionId: 'peer-expire',
      onEvent: (e) => void events.push(e),
    });
    await vi.waitFor(() => expect(h.requested).toHaveLength(1), { timeout: 5000 });
    h.settle('expired');
    await turn;

    const toolResults = events.filter((e) => e.type === 'tool_result');
    expect(toolResults).toHaveLength(1);
    const tr = toolResults[0]!;
    if (tr.type === 'tool_result') {
      expect(tr.denied).toBe(true);
      expect(JSON.stringify(tr.result)).toMatch(/expired/);
    }
    h.store.close();
  });

  it('always-allow grant: no card raised, still no generic approval', async () => {
    const h = makeHarness();
    h.store.addGrant('scout', 'coder', 'ask', 'user');
    const events: StreamEvent[] = [];
    await h.runtime.runTurn({
      bot: testBot(),
      message: 'go',
      sessionId: 'peer-grant',
      onEvent: (e) => void events.push(e),
    });

    expect(h.requested).toHaveLength(0);
    expect(events.filter((e) => e.type === 'tool_result')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'approval_required')).toHaveLength(0);
    h.store.close();
  });
});
