// SPDX-License-Identifier: Apache-2.0
// ADD-2 Capability Awareness Layer: the registry is GENERATED from fixture
// catalogs (entries derived, never hardcoded), search ranks the ADD-2
// example queries to the right capability, the prompt summary stays
// inside its token budget, the discover_capabilities tool answers with a
// handoff, and GET /api/capabilities serves the stable shape.

import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import type { BotConfig, ToolContext, ToolDefinition } from '@mvp/agent-runtime';
import {
  approxTokens,
  buildCapabilityRegistry,
  buildCapabilitySummary,
  createCapabilityService,
  searchCapabilities,
  suggestCapabilityHandoffs,
  type CapabilityRegistryDeps,
} from '../src/capabilities.js';
import {
  capabilityToolsPolicyRules,
  createCapabilityTools,
  grantCapabilityToolsToBots,
  registerCapabilityTools,
} from '../src/capability-tools.js';
import { createCapabilitiesRouter } from '../src/capabilities-routes.js';

const CTX = { sessionId: 's-1', botId: 'chief' } as ToolContext;

function fixtureDeps(overrides: Partial<CapabilityRegistryDeps> = {}): CapabilityRegistryDeps {
  return {
    bots: () => [
      { id: 'chief', name: 'Chief of Staff', description: 'Coordinates the whole team and delegates work.', routeKeywords: ['planning', 'coordination'], chiefOfStaff: true },
      { id: 'coder', name: 'Coder', description: 'Writes and fixes code in the workspace.', routeKeywords: ['code', 'bug', 'typescript'] },
      { id: 'writer', name: 'Writer', description: 'Drafts articles, posts and documents.', routeKeywords: ['writing', 'article', 'blog'] },
    ],
    tools: () => [
      { name: 'read_file', description: 'Read a file from the workspace.' },
      { name: 'computer_screenshot', description: 'Capture the screen of the computer surface.' },
      { name: 'schedule_task', description: 'Schedule a task to run later or on a recurring schedule.', mutating: true },
      { name: 'publish_page', description: 'Publish a page as a public web page.', mutating: true },
      { name: 'mcp:fetch:get', description: 'Fetch a URL as markdown via the fetch MCP server.' },
      { name: 'composio_call', description: 'Execute one action on a connected app account (Gmail, Slack, WhatsApp and more).', mutating: true },
    ],
    skills: () => [
      { name: 'api-design', description: 'Design REST APIs with consistent conventions.' },
      { name: 'csv-cleaning', description: 'Clean and normalize messy CSV files.' },
    ],
    workflows: () => [
      { id: 'wf-digest', name: 'Morning Digest', description: 'Collects updates and sends a digest.' },
      { id: 'wf-backup', name: 'Nightly Backup' },
    ],
    plugins: () => [
      { id: 'plug-notes', name: 'Notes Plus', description: 'Extra note-taking hooks.', enabled: true, kinds: ['hook'] },
      { id: 'plug-off', enabled: false },
    ],
    channels: () => [{ id: 'whatsapp' }, { id: 'telegram' }],
    now: () => new Date('2026-10-30T12:00:00.000Z'),
    ...overrides,
  };
}

function botConfig(id: string): BotConfig {
  return {
    id, name: `Bot ${id}`, description: 'd', systemPrompt: 'p', provider: 'groq',
    model: 'm', skills: [], tools: [], mcpServers: [],
  };
}

describe('buildCapabilityRegistry (generated from catalogs)', () => {
  it('derives an entry for every fixture bot, tool, skill, workflow, plugin and channel', () => {
    const registry = buildCapabilityRegistry(fixtureDeps());
    const ids = registry.entries.map((e) => e.id);
    for (const id of [
      'bot:chief', 'bot:coder', 'bot:writer',
      'tool:read_file', 'tool:computer_screenshot', 'tool:schedule_task',
      'tool:publish_page', 'tool:mcp:fetch:get', 'tool:composio_call',
      'skill:api-design', 'skill:csv-cleaning',
      'workflow:wf-digest', 'workflow:wf-backup',
      'plugin:plug-notes', 'plugin:plug-off',
      'channel:whatsapp', 'channel:telegram',
    ]) {
      expect(ids).toContain(id);
    }
    expect(registry.counts).toMatchObject({ bot: 3, tool: 6, skill: 2, workflow: 2, plugin: 2, channel: 2 });
    expect(registry.generatedAt).toBe('2026-10-30T12:00:00.000Z');
  });

  it('is generated, not hardcoded: changing the fixture changes the registry', () => {
    const small = buildCapabilityRegistry(fixtureDeps({ bots: () => [{ id: 'solo', name: 'Solo' }] }));
    expect(small.counts.bot).toBe(1);
    expect(small.entries.map((e) => e.id)).toContain('bot:solo');
    expect(small.entries.map((e) => e.id)).not.toContain('bot:coder');
    const bigger = buildCapabilityRegistry(fixtureDeps());
    expect(bigger.entries.length).toBeGreaterThan(small.entries.length);
  });

  it('carries invocation + whenToUse derived from the real catalog data', () => {
    const registry = buildCapabilityRegistry(fixtureDeps());
    const coder = registry.entries.find((e) => e.id === 'bot:coder')!;
    expect(coder.howToInvoke).toMatchObject({ type: 'bot', botId: 'coder' });
    expect(coder.whenToUse).toContain('code');
    const mcp = registry.entries.find((e) => e.id === 'tool:mcp:fetch:get')!;
    expect(mcp.group).toBe('MCP · fetch');
    expect(mcp.howToInvoke).toMatchObject({ type: 'tool', toolName: 'mcp:fetch:get' });
    const screen = registry.entries.find((e) => e.id === 'tool:computer_screenshot')!;
    expect(screen.group).toBe('Computer use');
  });

  it('includes the product features, referencing real tools and routes', () => {
    const registry = buildCapabilityRegistry(fixtureDeps());
    const features = registry.entries.filter((e) => e.kind === 'feature');
    expect(features.length).toBeGreaterThanOrEqual(15);
    const bySlug = new Map(features.map((f) => [f.id, f]));
    expect(bySlug.get('feature:automations')!.howToInvoke.toolName).toBe('schedule_task');
    expect(bySlug.get('feature:pages-publishing')!.howToInvoke.toolName).toBe('publish_page');
    expect(bySlug.get('feature:chief-of-staff')!.howToInvoke.toolName).toBe('coordinate_bots');
    expect(bySlug.get('feature:computer-use')!.howToInvoke.toolName).toBe('computer_screenshot');
    expect(bySlug.get('feature:workflows')!.howToInvoke.route).toBe('POST /api/workflows/:id/run');
    expect(bySlug.get('feature:workflows')!.whatItDoes).toContain('2 workflows currently defined');
    expect(bySlug.get('feature:universal-chat')!.howToInvoke.route).toBe('POST /api/universal/chat');
    expect(bySlug.get('feature:capability-discovery')!.howToInvoke.toolName).toBe('discover_capabilities');
  });

  it('tolerates absent catalogs (no fabricated entries)', () => {
    const registry = buildCapabilityRegistry({});
    expect(registry.counts).toMatchObject({ bot: 0, tool: 0, skill: 0, workflow: 0, plugin: 0, channel: 0 });
    expect(registry.entries.every((e) => e.kind === 'feature')).toBe(true);
  });
});

describe('searchCapabilities (plain-language ranking)', () => {
  const registry = buildCapabilityRegistry(fixtureDeps());

  it('"send a WhatsApp message" → the WhatsApp channel first', () => {
    const hits = searchCapabilities(registry, 'what can send a WhatsApp message');
    expect(hits[0]!.entry.id).toBe('channel:whatsapp');
  });

  it('"run while the PC is off" → automation anchors / Lightning cloud on top', () => {
    const hits = searchCapabilities(registry, 'what can run while the PC is off');
    expect(['feature:automation-anchors', 'feature:lightning-cloud']).toContain(hits[0]!.entry.id);
    const top3 = hits.slice(0, 3).map((h) => h.entry.id);
    expect(top3).toContain('feature:automation-anchors');
  });

  it('"turn this into a recurring job" → automations feature first', () => {
    const hits = searchCapabilities(registry, 'turn this into a recurring job');
    expect(hits[0]!.entry.id).toBe('feature:automations');
  });

  it('"who writes code" → the Coder bot; empty/gibberish queries return nothing', () => {
    const hits = searchCapabilities(registry, 'who can write and fix code');
    expect(hits[0]!.entry.id).toBe('bot:coder');
    expect(searchCapabilities(registry, '')).toEqual([]);
    expect(searchCapabilities(registry, 'zzqqx nonsense')).toEqual([]);
  });

  it('respects kind filters and limit', () => {
    const hits = searchCapabilities(registry, 'schedule a recurring task', { kinds: ['tool'], limit: 2 });
    expect(hits.length).toBeLessThanOrEqual(2);
    expect(hits.every((h) => h.entry.kind === 'tool')).toBe(true);
    expect(hits[0]!.entry.id).toBe('tool:schedule_task');
  });
});

describe('buildCapabilitySummary (token-bounded prompt summary)', () => {
  it('stays inside the budget and keeps the discovery hint', () => {
    const registry = buildCapabilityRegistry(fixtureDeps());
    const summary = buildCapabilitySummary(registry, { maxApproxTokens: 1200 });
    expect(approxTokens(summary)).toBeLessThanOrEqual(1200);
    expect(summary).toContain('discover_capabilities');
    expect(summary).toContain('Features:');
    expect(summary).toContain('Coder');
    expect(summary).toContain('WhatsApp');
  });

  it('degrades gracefully under a tight budget with a huge catalog', () => {
    const manyTools = Array.from({ length: 400 }, (_, i) => ({
      name: `tool_number_${i}`,
      description: `Generated fixture tool number ${i} with a reasonably long description to consume budget.`,
    }));
    const registry = buildCapabilityRegistry(fixtureDeps({ tools: () => manyTools }));
    const summary = buildCapabilitySummary(registry, { maxApproxTokens: 300 });
    expect(approxTokens(summary)).toBeLessThanOrEqual(300);
    expect(summary).toContain('discover_capabilities');
  });
});

describe('discover_capabilities tool', () => {
  it('registers once, is read-only, auto-allowed, and granted to every bot', () => {
    const service = createCapabilityService(fixtureDeps());
    const registry = new Map<string, ToolDefinition>();
    registerCapabilityTools({ registry, service });
    registerCapabilityTools({ registry, service }); // collision-safe
    expect([...registry.keys()]).toEqual(['discover_capabilities']);
    const tool = registry.get('discover_capabilities')!;
    expect(tool.mutating).toBeUndefined();
    const rules = capabilityToolsPolicyRules();
    expect(rules[0]).toMatchObject({ effect: 'allow' });
    expect(new RegExp(rules[0]!.toolPattern, 'i').test('discover_capabilities')).toBe(true);

    const bots = [botConfig('a'), botConfig('b')];
    grantCapabilityToolsToBots(bots);
    grantCapabilityToolsToBots(bots); // idempotent
    for (const b of bots) expect(b.tools).toEqual(['discover_capabilities']);
  });

  it('answers a plain-language query with ranked matches and a handoff', async () => {
    const service = createCapabilityService(fixtureDeps());
    const [tool] = createCapabilityTools({ service });
    const res = (await tool!.handler({ query: 'turn this into a recurring job' }, CTX)) as {
      matches: Array<{ id: string; howToInvoke: { toolName?: string } }>;
      handoff?: { capabilityId: string; action: { toolName?: string }; note: string };
    };
    expect(res.matches[0]!.id).toBe('feature:automations');
    expect(res.matches[0]!.howToInvoke.toolName).toBe('schedule_task');
    expect(res.handoff).toBeDefined();
    expect(res.handoff!.capabilityId).toBe('feature:automations');
    expect(res.handoff!.action.toolName).toBe('schedule_task');
  });

  it('answers the WhatsApp query with the channel, and rejects an empty query', async () => {
    const service = createCapabilityService(fixtureDeps());
    const [tool] = createCapabilityTools({ service });
    const res = (await tool!.handler({ query: 'send a WhatsApp message' }, CTX)) as {
      matches: Array<{ id: string; kind: string }>;
    };
    expect(res.matches[0]).toMatchObject({ id: 'channel:whatsapp', kind: 'channel' });
    const empty = (await tool!.handler({}, CTX)) as { error?: string };
    expect(empty.error).toBe('query is required');
  });
});

describe('suggestCapabilityHandoffs', () => {
  it('only suggests entries that carry a handoff, as structured actions', () => {
    const registry = buildCapabilityRegistry(fixtureDeps());
    const handoffs = suggestCapabilityHandoffs(registry, 'I want this published as a shareable page');
    expect(handoffs.length).toBeGreaterThanOrEqual(1);
    expect(handoffs[0]).toMatchObject({
      capabilityId: 'feature:pages-publishing',
      action: { type: 'tool', toolName: 'publish_page' },
    });
    expect(handoffs[0]!.note).toContain('in place');
  });
});

describe('createCapabilityService (TTL cache)', () => {
  it('rebuilds only after TTL expiry or invalidate()', () => {
    let builds = 0;
    let nowMs = 1_000_000;
    const deps = fixtureDeps({
      bots: () => {
        builds += 1;
        return [{ id: 'b1', name: 'B1' }];
      },
    });
    const service = createCapabilityService(deps, { ttlMs: 30_000, nowMs: () => nowMs });
    service.getRegistry();
    service.getRegistry();
    expect(builds).toBe(1);
    nowMs += 30_001;
    service.getRegistry();
    expect(builds).toBe(2);
    service.invalidate();
    service.getRegistry();
    expect(builds).toBe(3);
    expect(service.promptSection()).toContain('capability map');
  });
});

describe('GET /api/capabilities', () => {
  let server: { close(cb: () => void): void } | null = null;
  let baseUrl = '';

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
  });

  async function mount(): Promise<void> {
    const service = createCapabilityService(fixtureDeps());
    const app = express();
    app.use('/api/capabilities', createCapabilitiesRouter({ service }));
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve()) as unknown as { close(cb: () => void): void };
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}/api/capabilities`;
  }

  it('serves the full registry in the stable { entries, generatedAt } shape', async () => {
    await mount();
    const res = await fetch(baseUrl);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: Array<{ id: string; howToInvoke: unknown }>;
      generatedAt: string;
      counts: Record<string, number>;
    };
    expect(body.generatedAt).toBe('2026-10-30T12:00:00.000Z');
    expect(body.counts.bot).toBe(3);
    expect(body.entries.some((e) => e.id === 'channel:whatsapp')).toBe(true);
    const entry = body.entries.find((e) => e.id === 'feature:automations')!;
    expect(entry.howToInvoke).toMatchObject({ type: 'tool', toolName: 'schedule_task' });
  });

  it('?q= returns ranked entries with scores', async () => {
    await mount();
    const res = await fetch(`${baseUrl}?q=${encodeURIComponent('run while the PC is off')}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: Array<{ id: string; score: number }>;
      generatedAt: string;
      query: string;
    };
    expect(body.query).toBe('run while the PC is off');
    expect(body.generatedAt).toBeTruthy();
    expect(['feature:automation-anchors', 'feature:lightning-cloud']).toContain(body.entries[0]!.id);
    expect(body.entries[0]!.score).toBeGreaterThan(0);
  });
});
