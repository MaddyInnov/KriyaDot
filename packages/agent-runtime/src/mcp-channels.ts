// SPDX-License-Identifier: Apache-2.0
/**
 * MCP channels (CA-25, coding-apps parity audit).
 *
 * An MCP server may open an EVENT CHANNEL: a named stream of
 * server-pushed events (CI results, chat messages, webhook relays…)
 * whose messages inject into a BOUND live session, so the agent sees
 * them without anyone typing. This module is the client-side hub:
 *
 *   registerChannel(server, channel)  → channel record
 *   bindSession(channelId, sessionId) → events now have a destination
 *   handleEvent(channelId, rawEvent)  → governance gate → rate limit →
 *                                       host injection seam
 *
 * Safety contract (governance is never weakened):
 * - INJECTION ONLY VIA THE HOST SEAM. The hub never touches a session
 *   store itself; the host supplies `inject`, which is expected to go
 *   through the unified-inbox / steering path (AgentRuntime.
 *   enqueueSteer or the API daemon-inject route). Injected text is
 *   formatted as an external event notice, never as a user instruction.
 * - GOVERNANCE GATE. Every event passes `gate` (host-supplied; e.g.
 *   built from the governance gateway's classify over the synthetic
 *   tool name `mcp_channel_event`). A gate that denies, throws, or is
 *   absent DENIES — channels are opt-in per host, fail-closed. The
 *   `allowAllChannelGate` exists for tests and trusted in-process
 *   servers only, and says so in its name.
 * - RATE LIMIT. A per-channel token bucket (default 10 events/minute,
 *   burst = capacity) drops excess events; drops are counted and
 *   reported in the delivery result, never silently queued.
 * - SIZE CAPS. Event text is truncated at `maxTextLength` (default
 *   4000 chars) and structured data at `maxDataBytes` (default 8192
 *   JSON bytes); oversize data is replaced with a truncation note.
 *
 * Wire shape: servers send a JSON-RPC notification with method
 * {@link MCP_CHANNEL_NOTIFICATION_METHOD} and params
 * `{ channel: string, text: string, data?: unknown }`. `attachToClient`
 * registers the handler on any client exposing the MCP SDK's
 * `setNotificationHandler` seam (the same seam MCPClient uses for
 * tools/list_changed); the coordinator wiring note shows the 3-line
 * hook inside MCPClient.connectWith. `handleEvent` is also directly
 * callable by hosts that receive channel events over their own
 * transport (webhooks, test fakes).
 */

export const MCP_CHANNEL_NOTIFICATION_METHOD = 'notifications/kriyadot/channel';

export interface McpChannelDescriptor {
  /** MCP server label the channel belongs to (e.g. 'github-ci'). */
  serverLabel: string;
  /** Channel name on that server (e.g. 'builds'). */
  channel: string;
  /** Human description shown in channel listings. */
  description?: string;
}

export interface McpChannel extends McpChannelDescriptor {
  /** Stable channel id: `<serverLabel>/<channel>`. */
  id: string;
  createdAt: string;
  /** Session currently bound, or null when events are dropped. */
  boundSessionId: string | null;
}

export interface McpChannelEvent {
  /** Target channel name (descriptor channel, not the full id). */
  channel: string;
  /** Event text (human-readable payload). */
  text: string;
  /** Optional structured payload; JSON-serialized with a size cap. */
  data?: unknown;
  /** Server-side timestamp (ISO or epoch ms); informational only. */
  ts?: string | number;
}

export type McpChannelGateVerdict = 'allow' | 'deny';

/**
 * Governance gate for channel injection. Consulted for EVERY event
 * before rate limiting and injection. Must resolve 'allow' to inject;
 * 'deny', any other value, or a throw all deny (fail closed).
 */
export type McpChannelGate = (info: {
  channel: McpChannel;
  event: McpChannelEvent;
  sessionId: string;
}) => Promise<McpChannelGateVerdict> | McpChannelGateVerdict;

/** Host injection seam: deliver formatted event text into a live session. */
export type McpChannelInjector = (info: {
  sessionId: string;
  channel: McpChannel;
  event: McpChannelEvent;
  /** The exact text handed to the session (external-event framing). */
  text: string;
}) => Promise<void> | void;

export type McpChannelDropReason =
  | 'unknown-channel'
  | 'no-bound-session'
  | 'gate-denied'
  | 'gate-error'
  | 'rate-limited'
  | 'empty-event';

export type McpChannelDeliveryResult =
  | { delivered: true; channelId: string; sessionId: string }
  | { delivered: false; channelId?: string; reason: McpChannelDropReason };

export interface McpChannelHubOptions {
  inject: McpChannelInjector;
  /** Governance gate. ABSENT = deny everything (fail closed). */
  gate?: McpChannelGate;
  /** Token-bucket capacity per channel (default 10). */
  rateLimitCapacity?: number;
  /** Token-bucket refill, tokens per minute (default = capacity). */
  rateLimitRefillPerMinute?: number;
  /** Max event text chars kept (default 4000). */
  maxTextLength?: number;
  /** Max JSON bytes of `data` kept (default 8192). */
  maxDataBytes?: number;
  /** Clock seam for tests (epoch ms). */
  now?: () => number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

/** Format one event for injection: external-event framing, capped. */
export function formatChannelEventText(
  channel: McpChannel,
  event: McpChannelEvent,
  opts: { maxTextLength?: number; maxDataBytes?: number } = {},
): string {
  const maxText = opts.maxTextLength ?? 4000;
  const maxData = opts.maxDataBytes ?? 8192;
  let text = typeof event.text === 'string' ? event.text : String(event.text ?? '');
  if (text.length > maxText) text = `${text.slice(0, maxText)}… [truncated]`;
  let dataNote = '';
  if (event.data !== undefined) {
    let json: string;
    try {
      json = JSON.stringify(event.data) ?? 'null';
    } catch {
      json = '"[unserializable data]"';
    }
    if (json.length > maxData) json = `${json.slice(0, maxData)}… [truncated]`;
    dataNote = `\nData: ${json}`;
  }
  return `[mcp channel event — external source, not a user instruction]\nFrom: ${channel.serverLabel}/${channel.channel}\n${text}${dataNote}`;
}

export class McpChannelHub {
  private readonly channels = new Map<string, McpChannel>();
  private readonly buckets = new Map<string, Bucket>();
  private readonly injectFn: McpChannelInjector;
  private readonly gate?: McpChannelGate;
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly maxTextLength: number;
  private readonly maxDataBytes: number;
  private readonly now: () => number;
  /** Lifetime counters per channel id (delivered + per-reason drops). */
  private readonly statsMap = new Map<string, { delivered: number; dropped: Record<string, number> }>();

  constructor(opts: McpChannelHubOptions) {
    this.injectFn = opts.inject;
    this.gate = opts.gate;
    this.capacity = Math.max(1, Math.floor(opts.rateLimitCapacity ?? 10));
    const refillPerMinute = opts.rateLimitRefillPerMinute ?? this.capacity;
    this.refillPerMs = Math.max(0, refillPerMinute) / 60_000;
    this.maxTextLength = opts.maxTextLength ?? 4000;
    this.maxDataBytes = opts.maxDataBytes ?? 8192;
    this.now = opts.now ?? (() => Date.now());
  }

  static channelId(serverLabel: string, channel: string): string {
    return `${serverLabel}/${channel}`;
  }

  /** Register (or re-register) a channel a server has opened. */
  registerChannel(desc: McpChannelDescriptor): McpChannel {
    const id = McpChannelHub.channelId(desc.serverLabel, desc.channel);
    const existing = this.channels.get(id);
    const record: McpChannel = {
      serverLabel: desc.serverLabel,
      channel: desc.channel,
      ...(desc.description ? { description: desc.description } : {}),
      id,
      createdAt: existing?.createdAt ?? new Date(this.now()).toISOString(),
      boundSessionId: existing?.boundSessionId ?? null,
    };
    this.channels.set(id, record);
    if (!this.buckets.has(id)) this.buckets.set(id, { tokens: this.capacity, lastRefillMs: this.now() });
    return record;
  }

  /** Remove a channel (server closed it). Returns false when unknown. */
  unregisterChannel(channelId: string): boolean {
    this.buckets.delete(channelId);
    return this.channels.delete(channelId);
  }

  getChannel(channelId: string): McpChannel | undefined {
    return this.channels.get(channelId);
  }

  listChannels(): McpChannel[] {
    return [...this.channels.values()];
  }

  /** Bind a channel to a live session. Returns false for unknown channels. */
  bindSession(channelId: string, sessionId: string): boolean {
    const ch = this.channels.get(channelId);
    if (!ch) return false;
    ch.boundSessionId = sessionId;
    return true;
  }

  /** Unbind a channel (events drop as no-bound-session until rebound). */
  unbindSession(channelId: string): boolean {
    const ch = this.channels.get(channelId);
    if (!ch) return false;
    ch.boundSessionId = null;
    return true;
  }

  /** Delivery counters for one channel (delivered + drops by reason). */
  stats(channelId: string): { delivered: number; dropped: Record<string, number> } {
    return this.statsMap.get(channelId) ?? { delivered: 0, dropped: {} };
  }

  private noteDrop(channelId: string | undefined, reason: McpChannelDropReason): void {
    if (!channelId) return;
    const s = this.statsMap.get(channelId) ?? { delivered: 0, dropped: {} };
    s.dropped[reason] = (s.dropped[reason] ?? 0) + 1;
    this.statsMap.set(channelId, s);
  }

  private takeToken(channelId: string): boolean {
    const bucket = this.buckets.get(channelId);
    if (!bucket) return false;
    const nowMs = this.now();
    const elapsed = Math.max(0, nowMs - bucket.lastRefillMs);
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerMs);
    bucket.lastRefillMs = nowMs;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /**
   * The delivery pipeline for one raw channel event. `serverLabel`
   * identifies which server sent it; `raw` is the notification params
   * ({ channel, text, data? }) or an McpChannelEvent.
   */
  async handleEvent(serverLabel: string, raw: unknown): Promise<McpChannelDeliveryResult> {
    const params = (raw ?? {}) as Partial<McpChannelEvent>;
    const channelName = typeof params.channel === 'string' ? params.channel : '';
    const channelId = McpChannelHub.channelId(serverLabel, channelName);
    const channel = this.channels.get(channelId);
    if (!channel) {
      this.noteDrop(channelId, 'unknown-channel');
      return { delivered: false, channelId, reason: 'unknown-channel' };
    }
    const event: McpChannelEvent = {
      channel: channelName,
      text: typeof params.text === 'string' ? params.text : '',
      ...(params.data !== undefined ? { data: params.data } : {}),
      ...(params.ts !== undefined ? { ts: params.ts } : {}),
    };
    if (!event.text.trim() && event.data === undefined) {
      this.noteDrop(channelId, 'empty-event');
      return { delivered: false, channelId, reason: 'empty-event' };
    }
    const sessionId = channel.boundSessionId;
    if (!sessionId) {
      this.noteDrop(channelId, 'no-bound-session');
      return { delivered: false, channelId, reason: 'no-bound-session' };
    }
    // Governance gate BEFORE rate limiting: a denied event must not
    // consume bucket tokens, and a gate failure is always a deny.
    if (!this.gate) {
      this.noteDrop(channelId, 'gate-denied');
      return { delivered: false, channelId, reason: 'gate-denied' };
    }
    let verdict: McpChannelGateVerdict;
    try {
      verdict = await this.gate({ channel, event, sessionId });
    } catch {
      this.noteDrop(channelId, 'gate-error');
      return { delivered: false, channelId, reason: 'gate-error' };
    }
    if (verdict !== 'allow') {
      this.noteDrop(channelId, 'gate-denied');
      return { delivered: false, channelId, reason: 'gate-denied' };
    }
    if (!this.takeToken(channelId)) {
      this.noteDrop(channelId, 'rate-limited');
      return { delivered: false, channelId, reason: 'rate-limited' };
    }
    const text = formatChannelEventText(channel, event, {
      maxTextLength: this.maxTextLength,
      maxDataBytes: this.maxDataBytes,
    });
    await this.injectFn({ sessionId, channel, event, text });
    const s = this.statsMap.get(channelId) ?? { delivered: 0, dropped: {} };
    s.delivered += 1;
    this.statsMap.set(channelId, s);
    return { delivered: true, channelId, sessionId };
  }

  /**
   * Attach to an MCP client(-like) exposing the SDK's
   * `setNotificationHandler` seam: notifications with method
   * {@link MCP_CHANNEL_NOTIFICATION_METHOD} route into handleEvent for
   * `serverLabel`. The schema argument is passed through opaquely (the
   * host/wiring supplies the SDK's generic notification schema — see
   * the wiring note); clients without the seam are ignored.
   */
  attachToClient(
    clientLike: {
      setNotificationHandler?: (schema: unknown, handler: (req: { params: unknown }) => Promise<void>) => void;
    },
    serverLabel: string,
    notificationSchema: unknown,
  ): boolean {
    if (typeof clientLike.setNotificationHandler !== 'function') return false;
    clientLike.setNotificationHandler(notificationSchema, async (req) => {
      await this.handleEvent(serverLabel, req?.params).catch(() => undefined);
    });
    return true;
  }
}

/**
 * Gate that allows everything. For tests and trusted in-process
 * servers ONLY — production hosts must supply a governance-backed
 * gate (the hub denies all events when no gate is configured).
 */
export const allowAllChannelGate: McpChannelGate = () => 'allow';

/**
 * Build a gate from a classify-style function (e.g. the governance
 * gateway's evaluate over the synthetic tool `mcp_channel_event`):
 * the classifier receives the channel/event context and returns a
 * decision string; only 'allow' allows.
 */
export function channelGateFromClassifier(
  classify: (info: { channel: McpChannel; event: McpChannelEvent; sessionId: string }) =>
    Promise<string> | string,
): McpChannelGate {
  return async (info) => ((await classify(info)) === 'allow' ? 'allow' : 'deny');
}
