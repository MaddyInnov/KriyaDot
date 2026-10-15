// SPDX-License-Identifier: Apache-2.0
// Tests for the read-only telemetry MCP resources (kriyadot://telemetry/*).

import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { GovernanceDecision, GovernanceGateway } from '../src/governance.js';
import { PlatformMcpServer } from '../src/mcp-server.js';
import { TelemetryCollector } from '../src/telemetry.js';

type FakeGovernance = Pick<GovernanceGateway, 'classify' | 'evaluate' | 'audit'>;

const allowAll: FakeGovernance = {
  classify: () => 'allow' as GovernanceDecision,
  evaluate: async () => ({ decision: 'allow' as GovernanceDecision }),
  audit: () => undefined,
};

function seededCollector(): { collector: TelemetryCollector; runId: string } {
  const collector = new TelemetryCollector();
  const runId = collector.beginRun({ kind: 'bot-turn', botId: 'bot-a', sessionId: 's1' })!;
  const step = collector.startStep(runId, 'llm:model', 'llm')!;
  step.end({ ok: true });
  collector.endRun(runId, {
    status: 'ok',
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    providerId: 'groq',
    model: 'llama-3.3-70b-versatile',
  });
  const wfId = collector.beginRun({ id: 'wf-1', kind: 'workflow-run', workflowId: 'wf' })!;
  collector.endRun(wfId, { status: 'error' });
  return { collector, runId };
}

async function withClient(
  telemetry: TelemetryCollector | undefined,
  fn: (client: Client) => Promise<void>,
): Promise<void> {
  const server = new PlatformMcpServer({
    tools: { listTools: () => [], callTool: async () => ({}) },
    governance: allowAll,
    botId: 'test-bot',
    telemetry,
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' }, { capabilities: {} });
  await server.connect(serverT);
  await client.connect(clientT);
  try {
    await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function jsonOf(contents: Array<{ text?: string }>): unknown {
  return JSON.parse(contents.map((c) => c.text ?? '').join(''));
}

describe('telemetry MCP resources (read-only)', () => {
  it('lists the kriyadot://telemetry resources and templates', async () => {
    const { collector } = seededCollector();
    await withClient(collector, async (client) => {
      const { resources, resourceTemplates } = await client.listResources();
      const uris = resources.map((r) => r.uri).sort();
      expect(uris).toEqual([
        'kriyadot://telemetry/bots',
        'kriyadot://telemetry/runs',
        'kriyadot://telemetry/summary',
      ]);
      for (const r of resources) expect(r.mimeType).toBe('application/json');
      expect(resourceTemplates.map((t) => t.uriTemplate).sort()).toEqual([
        'kriyadot://telemetry/bots/{id}',
        'kriyadot://telemetry/runs/{id}',
      ]);
    });
  });

  it('reads summary, runs, and bots resources', async () => {
    const { collector } = seededCollector();
    await withClient(collector, async (client) => {
      const summary = jsonOf((await client.readResource({ uri: 'kriyadot://telemetry/summary' })).contents) as {
        windowRuns: number;
        errors: number;
        totalTokens: number;
      };
      expect(summary.windowRuns).toBe(2);
      expect(summary.errors).toBe(1);
      expect(summary.totalTokens).toBe(150);

      const runs = jsonOf((await client.readResource({ uri: 'kriyadot://telemetry/runs' })).contents) as Array<{
        kind: string;
      }>;
      expect(runs).toHaveLength(2);

      const bots = jsonOf((await client.readResource({ uri: 'kriyadot://telemetry/bots' })).contents) as Array<{
        id: string;
      }>;
      expect(bots.map((b) => b.id).sort()).toEqual(['bot-a', 'workflow:wf']);
    });
  });

  it('reads a single run and a single bot via URI templates', async () => {
    const { collector, runId } = seededCollector();
    await withClient(collector, async (client) => {
      const run = jsonOf(
        (await client.readResource({ uri: `kriyadot://telemetry/runs/${runId}` })).contents,
      ) as { id: string; botId: string; steps: unknown[] };
      expect(run.id).toBe(runId);
      expect(run.botId).toBe('bot-a');
      expect(run.steps).toHaveLength(1);

      const bot = jsonOf((await client.readResource({ uri: 'kriyadot://telemetry/bots/bot-a' })).contents) as {
        id: string;
        runs: number;
      };
      expect(bot.id).toBe('bot-a');
      expect(bot.runs).toBe(1);
    });
  });

  it('rejects unknown run ids, bot ids, and URIs', async () => {
    const { collector } = seededCollector();
    await withClient(collector, async (client) => {
      await expect(client.readResource({ uri: 'kriyadot://telemetry/runs/nope' })).rejects.toThrow();
      await expect(client.readResource({ uri: 'kriyadot://telemetry/bots/nope' })).rejects.toThrow();
      await expect(client.readResource({ uri: 'kriyadot://telemetry/nope' })).rejects.toThrow();
      await expect(client.readResource({ uri: 'other://telemetry/summary' })).rejects.toThrow();
    });
  });

  it('adds no tools: telemetry is resources-only (read-only surface)', async () => {
    const { collector } = seededCollector();
    await withClient(collector, async (client) => {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(0);
    });
  });

  it('advertises no telemetry capability when no collector is wired', async () => {
    await withClient(undefined, async (client) => {
      await expect(client.listResources()).rejects.toThrow();
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(0);
    });
  });
});
