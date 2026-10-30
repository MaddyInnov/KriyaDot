// SPDX-License-Identifier: Apache-2.0
/**
 * Shared WebSocket hub hardening (Octomind parity #94/#95).
 *
 * The API has several hand-rolled RFC6455 hubs (companion, phone,
 * computer-view, remote-screen). They duplicated socket code but shared
 * none of the transport-hardening behaviour. This module is the shared
 * seam all of them can use:
 *
 *  - ReplayBuffer: per-session sequence numbers + a bounded replay
 *    buffer behind an opaque resume token (#94). A reconnecting client
 *    presents the token and its last-seen sequence; the hub replays
 *    exactly the events it missed, then acks the resume.
 *  - LivenessTracker: last-seen/last-pong bookkeeping + a reaper that
 *    evicts silent clients (#95). Any inbound frame counts as seen;
 *    protocol pongs count as pong.
 *  - Backpressure: `shouldDropOutbound` — when a socket's buffered
 *    (unsent) bytes exceed a cap, low-priority frames (heartbeats,
 *    activity hints, screen frames) are dropped for THAT socket only.
 *    High-priority frames (hello/resume acks, approvals, command
 *    results) are never dropped by this helper, and dropping never
 *    blocks the event loop or stalls other clients.
 */

import { randomBytes } from 'node:crypto';

/** Anything that can carry a buffered-amount reading. */
export interface BufferReadable {
  bufferedAmount?: number | (() => number);
  /** Node Duplex / net.Socket shape. */
  writableLength?: number;
  socket?: { writableLength?: number; bufferedAmount?: number };
}

/** Read the unsent-byte count of a socket-like object (0 when unknown). */
export function bufferedAmountOf(s: unknown): number {
  if (!s || typeof s !== 'object') return 0;
  const o = s as BufferReadable & { bufferedAmount?: unknown };
  try {
    if (typeof o.bufferedAmount === 'function') {
      const v = (o.bufferedAmount as () => number)();
      return Number.isFinite(v) && v > 0 ? v : 0;
    }
    if (typeof o.bufferedAmount === 'number') return Math.max(0, o.bufferedAmount);
    if (typeof o.writableLength === 'number') return Math.max(0, o.writableLength);
    const inner = o.socket;
    if (inner) {
      if (typeof inner.bufferedAmount === 'number') return Math.max(0, inner.bufferedAmount);
      if (typeof inner.writableLength === 'number') return Math.max(0, inner.writableLength);
    }
  } catch {
    return 0;
  }
  return 0;
}

export type FramePriority = 'high' | 'normal' | 'low';

export const DEFAULT_BACKPRESSURE_CAP_BYTES = 1_048_576;

/**
 * True when this frame should be dropped for this socket: only
 * low-priority frames, only when the socket is over the cap.
 */
export function shouldDropOutbound(
  socket: unknown,
  priority: FramePriority,
  capBytes: number = DEFAULT_BACKPRESSURE_CAP_BYTES,
): boolean {
  if (priority !== 'low') return false;
  return bufferedAmountOf(socket) > capBytes;
}

// ---------------------------------------------------------------------------
// Resumable sessions (#94)
// ---------------------------------------------------------------------------

export interface SequencedEvent {
  seq: number;
  /** Serialized frame (JSON text) exactly as originally sent. */
  text: string;
  at: number;
}

export interface ResumeSession {
  token: string;
  lastSeq: number;
  buffer: SequencedEvent[];
  createdAt: number;
  lastSeenAt: number;
}

/**
 * Bounded per-session replay state. One instance per logical WS
 * session (e.g. per companion device session). The buffer keeps the
 * newest `capacity` events; a resume asking for events older than the
 * buffer reports `truncated: true` so the client can resync from a
 * snapshot instead of believing it saw everything.
 */
export class ReplayBuffer {
  private session: ResumeSession | null = null;

  constructor(private readonly capacity: number = 100) {}

  /** Start (or restart) a session; returns its resume token. */
  issue(now: number = Date.now()): string {
    const token = randomBytes(24).toString('hex');
    this.session = { token, lastSeq: 0, buffer: [], createdAt: now, lastSeenAt: now };
    return token;
  }

  get token(): string | null {
    return this.session?.token ?? null;
  }

  get lastSeq(): number {
    return this.session?.lastSeq ?? 0;
  }

  /** Record an outbound frame; returns its sequence number. */
  record(text: string, now: number = Date.now()): number {
    if (!this.session) this.issue(now);
    const s = this.session!;
    s.lastSeq += 1;
    s.buffer.push({ seq: s.lastSeq, text, at: now });
    if (s.buffer.length > this.capacity) s.buffer.splice(0, s.buffer.length - this.capacity);
    s.lastSeenAt = now;
    return s.lastSeq;
  }

  /**
   * Validate a presented resume token. On success returns the events
   * with seq > lastSeq (in order) and whether the request predates the
   * retained buffer (truncated). On failure returns null — the caller
   * falls back to a fresh hello + snapshot.
   */
  resume(
    token: string,
    lastSeq: number,
    now: number = Date.now(),
  ): { events: SequencedEvent[]; truncated: boolean; currentSeq: number } | null {
    const s = this.session;
    if (!s || !token || token !== s.token) return null;
    s.lastSeenAt = now;
    const events = s.buffer.filter((e) => e.seq > lastSeq);
    const oldest = s.buffer[0]?.seq ?? s.lastSeq + 1;
    const truncated = lastSeq > 0 && lastSeq < oldest - 1;
    return { events, truncated, currentSeq: s.lastSeq };
  }

  /** Forget the session (device revoked / session closed). */
  clear(): void {
    this.session = null;
  }
}

// ---------------------------------------------------------------------------
// Dead-client eviction (#95)
// ---------------------------------------------------------------------------

export interface LivenessEntry {
  id: string;
  lastSeenAt: number;
  lastPongAt: number;
}

/**
 * Tracks last-seen per connection id and reaps silent ones. The hub
 * calls `touch(id)` on any inbound frame and `pong(id)` on protocol
 * pongs; `reap(now)` returns (and forgets) the ids silent for longer
 * than the configured window so the hub can close them.
 */
export class LivenessTracker {
  private readonly entries = new Map<string, LivenessEntry>();

  constructor(private readonly silenceMs: number = 90_000) {}

  track(id: string, now: number = Date.now()): void {
    this.entries.set(id, { id, lastSeenAt: now, lastPongAt: now });
  }

  touch(id: string, now: number = Date.now()): void {
    const e = this.entries.get(id);
    if (e) e.lastSeenAt = now;
    else this.track(id, now);
  }

  pong(id: string, now: number = Date.now()): void {
    const e = this.entries.get(id);
    if (e) {
      e.lastPongAt = now;
      e.lastSeenAt = now;
    } else this.track(id, now);
  }

  forget(id: string): void {
    this.entries.delete(id);
  }

  lastSeen(id: string): number | undefined {
    return this.entries.get(id)?.lastSeenAt;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Ids silent beyond the window; they are forgotten as a side effect. */
  reap(now: number = Date.now()): string[] {
    const dead: string[] = [];
    for (const [id, e] of this.entries) {
      if (now - e.lastSeenAt > this.silenceMs) {
        dead.push(id);
        this.entries.delete(id);
      }
    }
    return dead;
  }
}

/**
 * Dead-viewer eviction for the frame hubs (computer-view, remote-screen).
 *
 * Those viewers are receive-mostly: a healthy viewer may send nothing
 * for a long time, so silence alone is NOT a death signal there (unlike
 * companion/phone, which have an application ping/pong). The reliable
 * signal is a socket whose outbound buffer stays over the backpressure
 * cap continuously — the consumer is gone or wedged and frames are
 * piling up unsent. `observe(socket, now)` returns true exactly once a
 * socket has been continuously over-cap for `stuckMs`; the hub then
 * closes and forgets it. A socket that drains below the cap resets its
 * clock. State is a WeakMap keyed by the socket object, so forgotten
 * sockets cost nothing.
 */
export class StuckBufferEvictor {
  private readonly overSince = new WeakMap<object, number>();

  constructor(
    private readonly stuckMs: number = 30_000,
    private readonly capBytes: number = DEFAULT_BACKPRESSURE_CAP_BYTES,
  ) {}

  /** True when this socket has been continuously over-cap past the window and should be evicted. */
  observe(socket: unknown, now: number = Date.now()): boolean {
    if (!socket || typeof socket !== 'object') return false;
    if (bufferedAmountOf(socket) <= this.capBytes) {
      this.overSince.delete(socket as object);
      return false;
    }
    const since = this.overSince.get(socket as object);
    if (since === undefined) {
      this.overSince.set(socket as object, now);
      return false;
    }
    return now - since >= this.stuckMs;
  }

  /** Stop tracking a socket (hub removed it for another reason). */
  forget(socket: unknown): void {
    if (socket && typeof socket === 'object') this.overSince.delete(socket as object);
  }
}

/**
 * Start a reaper interval that evicts silent clients. `close(id)` is
 * called once per evicted id. The timer is unref'd and the returned
 * handle stops it. Reaping is O(connections) per tick and never blocks.
 */
export function startReaper(opts: {
  tracker: LivenessTracker;
  intervalMs?: number;
  close: (id: string) => void;
  now?: () => number;
}): { stop: () => void; reapNow: () => string[] } {
  const reapNow = (): string[] => {
    const dead = opts.tracker.reap(opts.now ? opts.now() : Date.now());
    for (const id of dead) {
      try {
        opts.close(id);
      } catch {
        // one bad close must not stop the reaper
      }
    }
    return dead;
  };
  const timer = setInterval(reapNow, opts.intervalMs ?? 30_000);
  (timer as unknown as { unref?: () => void }).unref?.();
  return { stop: () => clearInterval(timer), reapNow };
}
