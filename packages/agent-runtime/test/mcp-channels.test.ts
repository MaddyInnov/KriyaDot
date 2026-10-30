// SPDX-License-Identifier: Apache-2.0
// CA-25: MCP channels — a fake MCP server/transport pushes channel
// events; the hub must inject them into the BOUND session only, behind
// the governance gate and the per-channel rate limit. Zero network,
// zero paid APIs: the "server" is an in-process fake emitting through
// the same setNotificationHandler seam the real MCP SDK client uses.

import { describe, expect, it } from 'vitest';
import {
  McpChannelHub,
  allowAllChannelGate,
  channelGateFromClassifier,
  formatChannelEventText,
  MCP_CHANNEL_NOTIFICATION_METHOD,
} from '../src/mcp-channels.js';

/** Fake MCP client: captures the notification handler the hub registers. */
class FakeMcpClient {
  handler?: (req: { params: unknown }) => Promise<void>;
  schema?: unknown;
  setNotificationHandler(schema: unknown, handler: (req: { params: unknown }) => Promise<void>): void {
    this.schema = schema;
    this.handler = handler;
  }
  /** Fake server push: emit one channel notification over the "transport". */
  async serverPush(params: unknown): Promise<void> {
    if (!this.handler) throw new Error('hub not attached');
    await this.handler({ params });
  }
}

function makeHub(opts: { gate?: unknown; capacity?: number; now?: () => number } = {}) {
  const injected: Array<{ sessionId: string; text: string }> = [];
  const hub = new McpChannelHub({
    inject: ({ sessionId, text }) => {
      injected.push({ sessionId, text });
    },
    ...(opts.gate === undefined ? { gate: allowAllChannelGate } : { gate: opts.gate as never }),
    ...(opts.capacity !== undefined ? { rateLimitCapacity: opts.capacity } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { hub, injected };
}

function boundHub(opts: Parameters<typeof makeHub>[0] = {}) {
  const rig = makeHub(opts);
  rig.hub.registerChannel({ serverLabel: 'ci-server', channel: 'builds', description: 'CI builds' });
  rig.hub.bindSession('ci-server/builds', 'sess-1');
  return rig;
}

describe('McpChannelHub registration + binding', () => {
  it('registers channels with stable ids and lists them', () => {
    const { hub } = makeHub();
    const ch = hub.registerChannel({ serverLabel: 'ci-server', channel: 'builds' });
    expect(ch.id).toBe('ci-server/builds');
    expect(ch.boundSessionId).toBeNull();
    expect(hub.listChannels()).toHaveLength(1);
    expect(hub.bindSession('nope/x', 's')).toBe(false);
    expect(hub.unregisterChannel('ci-server/builds')).toBe(true);
    expect(hub.listChannels()).toHaveLength(0);
  });

  it('drops events for unknown channels and unbound channels', async () => {
    const { hub, injected } = makeHub();
    hub.registerChannel({ serverLabel: 'ci-server', channel: 'builds' });
    const unbound = await hub.handleEvent('ci-server', { channel: 'builds', text: 'build ok' });
    expect(unbound).toEqual({ delivered: false, channelId: 'ci-server/builds', reason: 'no-bound-session' });
    const unknown = await hub.handleEvent('ci-server', { channel: 'deploys', text: 'x' });
    expect(unknown.delivered).toBe(false);
    if (!unknown.delivered) expect(unknown.reason).toBe('unknown-channel');
    expect(injected).toHaveLength(0);
  });
});

describe('McpChannelHub delivery via a fake MCP server', () => {
  it('injects server-pushed events into the bound session with external framing', async () => {
    const { hub, injected } = boundHub();
    const client = new FakeMcpClient();
    const attached = hub.attachToClient(client, 'ci-server', { fakeSchema: true });
    expect(attached).toBe(true);
    expect(MCP_CHANNEL_NOTIFICATION_METHOD).toBe('notifications/kriyadot/channel');

    await client.serverPush({ channel: 'builds', text: 'build #42 passed', data: { status: 'green' } });
    expect(injected).toHaveLength(1);
    expect(injected[0]!.sessionId).toBe('sess-1');
    expect(injected[0]!.text).toContain('external source, not a user instruction');
    expect(injected[0]!.text).toContain('ci-server/builds');
    expect(injected[0]!.text).toContain('build #42 passed');
    expect(injected[0]!.text).toContain('"status":"green"');
    expect(hub.stats('ci-server/builds').delivered).toBe(1);
  });

  it('re-binding moves delivery to the new session; unbinding stops it', async () => {
    const { hub, injected } = boundHub();
    hub.bindSession('ci-server/builds', 'sess-2');
    await hub.handleEvent('ci-server', { channel: 'builds', text: 'one' });
    expect(injected[0]!.sessionId).toBe('sess-2');
    hub.unbindSession('ci-server/builds');
    const res = await hub.handleEvent('ci-server', { channel: 'builds', text: 'two' });
    expect(res.delivered).toBe(false);
    expect(injected).toHaveLength(1);
  });

  it('drops empty events', async () => {
    const { hub, injected } = boundHub();
    const res = await hub.handleEvent('ci-server', { channel: 'builds', text: '   ' });
    expect(res).toEqual({ delivered: false, channelId: 'ci-server/builds', reason: 'empty-event' });
    expect(injected).toHaveLength(0);
  });
});

describe('McpChannelHub governance gate', () => {
  it('denies everything when NO gate is configured (fail closed)', async () => {
    const injected: unknown[] = [];
    const hub = new McpChannelHub({ inject: () => { injected.push(1); } });
    hub.registerChannel({ serverLabel: 's', channel: 'c' });
    hub.bindSession('s/c', 'sess');
    const res = await hub.handleEvent('s', { channel: 'c', text: 'hi' });
    expect(res).toEqual({ delivered: false, channelId: 's/c', reason: 'gate-denied' });
    expect(injected).toHaveLength(0);
  });

  it('honors a denying gate and a throwing gate (deny, never inject)', async () => {
    const deny = boundHub({ gate: () => 'deny' });
    expect((await deny.hub.handleEvent('ci-server', { channel: 'builds', text: 'x' })).delivered).toBe(false);
    expect(deny.injected).toHaveLength(0);

    const boom = boundHub({ gate: () => { throw new Error('gate down'); } });
    const res = await boom.hub.handleEvent('ci-server', { channel: 'builds', text: 'x' });
    expect(res).toEqual({ delivered: false, channelId: 'ci-server/builds', reason: 'gate-error' });
    expect(boom.injected).toHaveLength(0);
  });

  it('channelGateFromClassifier allows only an explicit allow decision', async () => {
    const gate = channelGateFromClassifier(async ({ event }) => (event.text.includes('spam') ? 'require-approval' : 'allow'));
    const { hub, injected } = boundHub({ gate });
    expect((await hub.handleEvent('ci-server', { channel: 'builds', text: 'ok' })).delivered).toBe(true);
    expect((await hub.handleEvent('ci-server', { channel: 'builds', text: 'spam offer' })).delivered).toBe(false);
    expect(injected).toHaveLength(1);
  });
});

describe('McpChannelHub rate limiting', () => {
  it('delivers up to capacity, then drops with rate-limited and counts drops', async () => {
    const { hub, injected } = boundHub({ capacity: 3 });
    for (let i = 0; i < 3; i++) {
      expect((await hub.handleEvent('ci-server', { channel: 'builds', text: `e${i}` })).delivered).toBe(true);
    }
    const fourth = await hub.handleEvent('ci-server', { channel: 'builds', text: 'e3' });
    expect(fourth).toEqual({ delivered: false, channelId: 'ci-server/builds', reason: 'rate-limited' });
    expect(injected).toHaveLength(3);
    expect(hub.stats('ci-server/builds')).toEqual({ delivered: 3, dropped: { 'rate-limited': 1 } });
  });

  it('refills over time (injected clock)', async () => {
    let nowMs = 1_000_000;
    const { hub } = boundHub({ capacity: 1, now: () => nowMs });
    // capacity 1 but default refill = capacity/min → use explicit hub below
    expect((await hub.handleEvent('ci-server', { channel: 'builds', text: 'a' })).delivered).toBe(true);
    nowMs += 61_000; // >1 minute at default refill (capacity per minute)
    expect((await hub.handleEvent('ci-server', { channel: 'builds', text: 'b' })).delivered).toBe(true);
  });

  it('denied events do not consume rate-limit tokens', async () => {
    let allow = false;
    const { hub } = boundHub({ capacity: 1, gate: () => (allow ? 'allow' : 'deny') });
    await hub.handleEvent('ci-server', { channel: 'builds', text: 'denied' });
    allow = true;
    expect((await hub.handleEvent('ci-server', { channel: 'builds', text: 'allowed' })).delivered).toBe(true);
  });
});

describe('formatChannelEventText caps', () => {
  it('truncates oversize text and data with a note', () => {
    const text = formatChannelEventText(
      { serverLabel: 's', channel: 'c', id: 's/c', createdAt: '', boundSessionId: 'x' },
      { channel: 'c', text: 'y'.repeat(5000), data: { blob: 'z'.repeat(9000) } },
    );
    expect(text).toContain('[truncated]');
    expect(text.length).toBeLessThan(5000 + 8192);
  });
});
