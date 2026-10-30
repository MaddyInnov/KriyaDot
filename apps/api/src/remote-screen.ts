// SPDX-License-Identifier: Apache-2.0
// Remote screen viewing: the paired Android companion app watches the PC's
// live screen (Codync parity).
//
// TRANSPORT (honest naming): this is a WebSocket frame channel — PNG frames
// streamed as base64 JSON at a few fps, MJPEG-style. It is NOT raw WebRTC.
// Raw WebRTC via the `wrtc` npm package was evaluated and rejected: it is a
// native module that routinely fails to build on current Node releases
// (node-gyp toolchain, prebuilt binaries lagging), and it buys nothing for a
// view-only low-fps screen stream. This module follows the exact pattern of
// the existing /api/computer/ws per-bot viewer (computer-view.ts), which is
// proven in production.
//
// SECURITY MODEL:
// - Every session starts in `pending` and mints a governance approval
//   (`remote_screen.share`). Frames flow ONLY after the PC owner approves in
//   the web UI approvals inbox (the approval card reads
//   "Allow screen sharing to <device>?").
// - Deny or 120s of no decision -> session `denied`/`expired`, fail closed.
// - Sessions auto-stop after 30 minutes (MAX_DURATION_MS).
// - The web UI polls GET /api/remote-screen/status and shows a banner while
//   any session is active.
// - Device-token auth on all session routes (see remote-screen-routes.ts).
//
// Capture: `screenshot-desktop` (optional dep, lazy-loaded like
// computer-real.ts). Missing package -> the phone gets a clear
// "screen capture unavailable" error, never a silent mock. Set
// REMOTE_SCREEN_MOCK=1 for an explicit labeled test-pattern feed
// (the `ok` frame message carries mock:true so clients can badge it).

import { randomUUID } from 'node:crypto';
import { shouldDropOutbound, StuckBufferEvictor } from './ws-hub-util.js';
import { createRequire } from 'node:module';
import type { ViewerSocket } from './computer-view.js';

const requireOptional = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Tool name minted into the governance approvals inbox. */
export const REMOTE_SCREEN_TOOL = 'remote_screen.share';

/** Default frames per second (1..10). */
export const DEFAULT_FPS = 4;

/** Sessions auto-stop after this long, even if the phone stays connected. */
export const MAX_DURATION_MS = 30 * 60 * 1000;

/** How long the PC owner has to approve before the request expires. */
export const APPROVAL_TIMEOUT_MS = 120_000;

/** Stale pending sessions are swept after this long. */
export const PENDING_SWEEP_MS = 10 * 60 * 1000;

/** Consecutive capture failures before a session is torn down. */
const MAX_CONSECUTIVE_CAPTURE_ERRORS = 5;

function envFps(): number {
  const raw = Number.parseInt(process.env['REMOTE_SCREEN_FPS'] ?? '', 10);
  if (Number.isFinite(raw)) return Math.min(10, Math.max(1, raw));
  return DEFAULT_FPS;
}

function mockMode(): boolean {
  return process.env['REMOTE_SCREEN_MOCK'] === '1';
}

// ---------------------------------------------------------------------------
// Capture backends
// ---------------------------------------------------------------------------

/** One captured frame: PNG bytes plus its pixel dimensions. */
export interface CapturedFrame {
  png: Buffer;
  w: number;
  h: number;
}

/** Read PNG width/height straight from the IHDR chunk (no decoder needed). */
export function pngDimensions(png: Buffer): { w: number; h: number } | null {
  // PNG signature (8) + IHDR length (4) + 'IHDR' (4) -> width/height BE u32.
  if (png.length < 26) return null;
  if (png[12] !== 0x49 || png[13] !== 0x48 || png[14] !== 0x44 || png[15] !== 0x52) return null;
  return { w: png.readUInt32BE(16), h: png.readUInt32BE(20) };
}

/** A tiny 320x200 striped test-pattern PNG (base64), for mock mode. */
const MOCK_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAUAAAADICAIAAAAWZq/8AAAEs0lEQVR4nO3dsW3DQBBFwatEBbgE' +
  + '507UivvPnQuUSAYG7mEH2Hjwk43f+n7+3rrH18+t4/P5/+ev9Ho+f7h/44E3XM/nD/evPvCe6/n8' +
  + '4f6lB952PZ8/3D9/4J3X8/nD/ZMH3nw9nz/c//TA+6/n84f7bx84sZ7PH+4fP3BlPZ8/3D944NB6' +
  + 'Pn+4//rArfV8/nB/pdfz+cP9lV7P5w/3V3o9nz/cX+n1fP5wf6XX8/nD/XsPvNt6Pn+4f+OBN1zP' +
  + '5w/3rz7wnuv5/OH+pQfedj2fP9w/f+Cd1/P5w/2TB958PZ8/3P/0wPuv5/OH+28fOLGezx/uHz9w' +
  + 'ZT2fP9w/eODQej5/uP/6wK31fP5wf6XX8/nD/ZVez+cP91d6PZ8/3F/p9Xz+cP9eXnS39Xz+cF8f' +
  + 'mM8P+/rAfH7Y1wfm88O+PjCfH/b1gfn8sK8PzOeHfX1gPj/s6wPz+WFfH5jPD/v6wHx+2NcH5vPD' +
  + 'vj4wnx/29YH5/LCvD8znh319YD4/7OsD8/lhXx+Yzw/7+sB8ftjXB+bzw74+MJ8f9vWB+fywrw/M' +
  + '54d9fWA+P+zrA/P5YV8fmM8P+/rAfH7Y1wfm88O+PjCfH/b1gfn8sK8PzOeHfX1gPj/s6wPz+WFf' +
  + 'H5jPD/v6wHx+2NcH5vPDvj4wnx/29YH5/LCvD8znh319YD4/7OsD8/lhXx+Yzw/7+sB8ftjXB+bz' +
  + 'w74+MJ8f9vWB+fywrw/M54d9fWA+P+zrA/P5YV8fmM8P+/rAfH7Y1wfm88O+PjCfH/b1gfn8sK8P' +
  + 'zOeHfX1gPj/s6wPz+WFfH5jPD/v6wHx+2NcH5vPDvj4wnx/29YH5/LCvD8znh319YD4/7OsD8/lh' +
  + 'Xx+Yzw/7+sB8ftjXB+bzw74+MJ8f9vWB+fywrw/M54d9fWA+P+zrA/P5YV8fmM8P+/rAfH7Y1wfm' +
  + '88O+PjCfH/b1gfn8sK8PzOeHfX1gPj/s6wPz+WFfH5jPD/v6wHx+2NcH5vPDvj4wnx/29YH5/LCv' +
  + 'D8znh319YD4/7OsD8/lhXx+Yzw/7+sB8ftjXB+bzw74+MJ8f9vWB+fywrw/M54d9fWA+P+zrA/P5' +
  + 'YV8fmM8P+/rAfH7Y1wfm88O+PjCfH/b1gfn8sK8PzOeHfX1gPj/s6wPz+WFfH5jPD/v6wHx+2NcH' +
  + '5vPDvj4wnx/29YH5/LCvD8znh319YD4/7OsD8/lhXx+Yzw/7+sB8ftjXB+bzw74+MJ8f9vWB+fyw' +
  + 'rw/M54d9fWA+P+zrA/P5YV8fmM8P+/rAfH7Y1wfm88O+PjCfH/b1gfn8sK8PzOeHfX1gPj/s6wPz' +
  + '+WFfH5jPD/v6wHx+2NcH5vPDvj4wnx/29YH5/LCvD8znh319YD4/7OsD8/lhXx+Yzw/7+sB8ftjX' +
  + 'B+bzw74+MJ8f9vWB+fywrw/M54d9fWA+P+zrA/P5YV8fmM8P+/rAfH7Y1wfm88O+PjCfH/b1gfn8' +
  + 'sK8PzOeHfX1gPj/s6wPz+WFfH5jPD/v6wHx+2NcH5vPDvj4wnx/29YH5/LCvD8znh319YD4/7OsD' +
  + '8/lhXx+Yzw/7+sB8ftjXB+bzw74+MJ8f9vWB+fywrw/M54d9fWA+P+z/AaB2ltibTgIKAAAAAElF' +
  + 'TkSuQmCC';

/** Capture via screenshot-desktop (optional dep). Throws a clear install hint when missing. */
function lazyScreenshotDesktop(): (opts?: { format?: string }) => Promise<Buffer> {
  try {
    return requireOptional('screenshot-desktop') as (opts?: { format?: string }) => Promise<Buffer>;
  } catch {
    throw new Error(
      'Remote screen needs the "screenshot-desktop" package on the PC: ' +
        'run `npm install screenshot-desktop` where the KriyaDot API runs, then restart. ' +
        '(For a labeled test feed instead, set REMOTE_SCREEN_MOCK=1.)',
    );
  }
}

/**
 * Default capture: real screen via screenshot-desktop, or an explicit mock
 * test pattern when REMOTE_SCREEN_MOCK=1. If `sharp` is installed it is used
 * (lazy) to downscale wide screens to 1280px and re-encode as JPEG q70 —
 * otherwise the raw PNG goes over the wire.
 */
export async function defaultCaptureFrame(): Promise<CapturedFrame> {
  if (mockMode()) {
    const png = Buffer.from(MOCK_PNG_B64, 'base64');
    return { png, w: 320, h: 200 };
  }
  const shot = lazyScreenshotDesktop();
  const png = Buffer.from(await shot({ format: 'png' }));
  const dims = pngDimensions(png);
  const w = dims?.w ?? 0;
  const h = dims?.h ?? 0;
  // Optional downscale: sharp is a lazy optional dep (never required).
  try {
    const sharp = requireOptional('sharp') as (input: Buffer) => {
      metadata(): Promise<{ width?: number; height?: number }>;
      resize(o: { width: number }): { jpeg(o: { quality: number }): { toBuffer(): Promise<Buffer> } };
    };
    if (w > 1280) {
      const out = await sharp(png).resize({ width: 1280 }).jpeg({ quality: 70 }).toBuffer();
      const nh = Math.round((h * 1280) / w);
      return { png: out, w: 1280, h: nh };
    }
  } catch {
    // sharp not installed — send the raw PNG.
  }
  return { png, w, h };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export type RemoteScreenStatus = 'pending' | 'approved' | 'active' | 'denied' | 'expired' | 'ended';

export interface RemoteScreenSession {
  id: string;
  deviceId: string;
  deviceName: string;
  status: RemoteScreenStatus;
  approvalId: string;
  createdAt: number;
  approvedAt?: number;
  endedAt?: number;
  frames: number;
  mock: boolean;
}

export interface RemoteScreenDeps {
  /** Capture one frame (injectable for tests). */
  captureFrame?: () => Promise<CapturedFrame>;
  /** Mint a governance approval; returns the approval id. */
  requestApproval: (
    toolName: string,
    args: Record<string, unknown>,
    ctx: { sessionId: string; botId: string; actor: string },
  ) => string;
  /** Wait for the user's decision; resolves 'approved'|'denied', rejects on timeout. */
  awaitDecision: (approvalId: string, timeoutMs: number) => Promise<'approved' | 'denied'>;
  /** Audit hook (namespace `remote-screen.*`). */
  audit: (action: string, fields: Record<string, unknown>) => void;
  fps?: number;
  maxDurationMs?: number;
  approvalTimeoutMs?: number;
  now?: () => number;
}

interface LiveState {
  viewers: Set<ViewerSocket>;
  timer: ReturnType<typeof setInterval> | null;
  stopTimer: ReturnType<typeof setTimeout> | null;
  consecErrors: number;
  lastDims: { w: number; h: number };
  lastError: string | null;
}

export class RemoteScreenService {
  private readonly deps: Required<Pick<RemoteScreenDeps, 'requestApproval' | 'awaitDecision' | 'audit'>> &
    Pick<RemoteScreenDeps, 'captureFrame' | 'fps' | 'maxDurationMs' | 'approvalTimeoutMs' | 'now'>;
  private readonly sessions = new Map<string, RemoteScreenSession>();
  private readonly live = new Map<string, LiveState>();
  /** Dead-viewer eviction (#95): close viewers whose outbound buffer stays over-cap. */
  private readonly stuckViewers = new StuckBufferEvictor();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: RemoteScreenDeps) {
    this.deps = deps;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private get fps(): number {
    const raw = this.deps.fps ?? envFps();
    return Math.min(10, Math.max(1, Math.floor(raw)));
  }

  // -- lifecycle -----------------------------------------------------------

  /**
   * A paired device asks to view the PC screen. Creates a pending session and
   * mints an approval for the PC owner. Returns immediately — the phone polls
   * GET /session/:id until the status leaves `pending`.
   */
  requestSession(deviceId: string, deviceName: string): { sessionId: string; approvalId: string; status: RemoteScreenStatus } {
    const id = randomUUID();
    const approvalId = this.deps.requestApproval(
      REMOTE_SCREEN_TOOL,
      {
        request: `Allow screen sharing to "${deviceName || 'unnamed device'}" (device ${deviceId})?`,
        deviceId,
        deviceName: deviceName || 'unnamed device',
        sessionId: id,
        maxMinutes: Math.round((this.deps.maxDurationMs ?? MAX_DURATION_MS) / 60000),
      },
      { sessionId: 'remote-screen', botId: 'remote-screen', actor: deviceName || deviceId },
    );
    const session: RemoteScreenSession = {
      id,
      deviceId,
      deviceName: deviceName || 'unnamed device',
      status: 'pending',
      approvalId,
      createdAt: this.now(),
      frames: 0,
      mock: mockMode(),
    };
    this.sessions.set(id, session);
    this.ensureSweeper();
    this.deps.audit('remote-screen.requested', {
      actor: 'api',
      toolName: REMOTE_SCREEN_TOOL,
      detail: { sessionId: id, deviceId, deviceName: session.deviceName, approvalId },
    });
    // Background: wait for the owner's decision, fail closed on deny/timeout.
    void this.awaitApproval(session);
    return { sessionId: id, approvalId, status: session.status };
  }

  private async awaitApproval(session: RemoteScreenSession): Promise<void> {
    try {
      const verdict = await this.deps.awaitDecision(session.approvalId, this.deps.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS);
      if (session.status !== 'pending') return; // stopped while waiting
      session.status = verdict === 'approved' ? 'approved' : 'denied';
      if (verdict === 'approved') session.approvedAt = this.now();
      else session.endedAt = this.now();
      this.deps.audit(`remote-screen.${session.status}`, {
        actor: 'api',
        toolName: REMOTE_SCREEN_TOOL,
        detail: { sessionId: session.id, deviceId: session.deviceId },
      });
    } catch {
      if (session.status !== 'pending') return;
      session.status = 'expired';
      session.endedAt = this.now();
      this.deps.audit('remote-screen.expired', {
        actor: 'api',
        toolName: REMOTE_SCREEN_TOOL,
        detail: { sessionId: session.id, deviceId: session.deviceId },
      });
    }
  }

  getSession(id: string): RemoteScreenSession | undefined {
    return this.sessions.get(id);
  }

  /** Sessions the web UI banner needs: anything not terminally closed. */
  activeSessions(): RemoteScreenSession[] {
    return [...this.sessions.values()].filter((s) => s.status === 'approved' || s.status === 'active');
  }

  /**
   * End a session. Allowed for the owning device (checked by the route) or
   * the local console (actor 'local'). Viewers get {t:'ended'} and the frame
   * loop stops.
   */
  stopSession(id: string, actor: string, endedReason = 'ended'): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    if (session.status === 'ended' || session.status === 'denied' || session.status === 'expired') return true;
    session.status = 'ended';
    session.endedAt = this.now();
    this.teardownLive(id, endedReason);
    this.deps.audit('remote-screen.stopped', {
      actor,
      toolName: REMOTE_SCREEN_TOOL,
      detail: { sessionId: id, deviceId: session.deviceId, frames: session.frames, reason: endedReason },
    });
    return true;
  }

  // -- viewer attachment -----------------------------------------------------

  /**
   * Attach an already-upgraded WebSocket to an approved session. Starts the
   * frame loop on first viewer; stops it when the last viewer leaves.
   * Throws when the session cannot stream.
   */
  attachViewer(sessionId: string, sock: ViewerSocket): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('unknown_session');
    if (session.status === 'pending') throw new Error('awaiting_approval');
    if (session.status === 'denied' || session.status === 'expired') throw new Error('not_approved');
    if (session.status === 'ended') throw new Error('session_ended');

    let live = this.live.get(sessionId);
    if (!live) {
      live = { viewers: new Set(), timer: null, stopTimer: null, consecErrors: 0, lastDims: { w: 0, h: 0 }, lastError: null };
      this.live.set(sessionId, live);
      // Hard cap: even an approved session dies after maxDurationMs.
      const cap = this.deps.maxDurationMs ?? MAX_DURATION_MS;
      live.stopTimer = setTimeout(() => {
        this.stopSession(sessionId, 'api');
        this.broadcast(sessionId, { t: 'ended', reason: 'max_duration' });
      }, cap);
      if (typeof live.stopTimer === 'object' && 'unref' in live.stopTimer) {
        (live.stopTimer as unknown as { unref(): void }).unref();
      }
    }
    const st: LiveState = live;
    session.status = 'active';
    st.viewers.add(sock);
    sock.onClose(() => {
      st.viewers.delete(sock);
      if (st.viewers.size === 0) {
        // Keep the session approved (phone may reconnect), but stop capturing.
        if (st.timer) {
          clearInterval(st.timer);
          st.timer = null;
        }
        if (session.status === 'active') session.status = 'approved';
      }
    });
    sock.onMessage(() => {
      // View-only: the phone never drives the PC here. Ignore input, say so.
      try {
        sock.sendText(JSON.stringify({ t: 'error', detail: 'view_only' }));
      } catch {
        // ignore
      }
    });
    this.ensureLoop(sessionId, session, st);
    // Eager first frame so the phone isn't staring at a spinner.
    void this.captureAndFanout(sessionId, session, st);
  }

  private ensureLoop(sessionId: string, session: RemoteScreenSession, st: LiveState): void {
    if (st.timer) return;
    const intervalMs = Math.max(100, Math.round(1000 / this.fps));
    st.timer = setInterval(() => {
      void this.captureAndFanout(sessionId, session, st);
    }, intervalMs);
    if (typeof st.timer === 'object' && 'unref' in st.timer) {
      (st.timer as unknown as { unref(): void }).unref();
    }
  }

  private async captureAndFanout(sessionId: string, session: RemoteScreenSession, st: LiveState): Promise<void> {
    if (st.viewers.size === 0) return;
    const capture = this.deps.captureFrame ?? defaultCaptureFrame;
    let frame: CapturedFrame;
    try {
      frame = await capture();
      st.consecErrors = 0;
      st.lastError = null;
    } catch (e) {
      st.consecErrors += 1;
      st.lastError = e instanceof Error ? e.message : String(e);
      if (st.consecErrors === 1) {
        this.broadcast(sessionId, { t: 'error', detail: 'capture_failed', hint: st.lastError });
      }
      if (st.consecErrors >= MAX_CONSECUTIVE_CAPTURE_ERRORS) {
        this.stopSession(sessionId, 'api', 'capture_unavailable');
        return;
      }
      return;
    }
    st.lastDims = { w: frame.w, h: frame.h };
    session.frames += 1;
    const msg = JSON.stringify({
      t: 'frame',
      png: frame.png.toString('base64'),
      w: frame.w,
      h: frame.h,
      ts: this.now(),
      n: session.frames,
      mock: session.mock,
    });
    for (const v of [...st.viewers]) {
      // Dead-client eviction (#95): continuously over-cap = gone/wedged.
      if (this.stuckViewers.observe(v, this.now())) {
        st.viewers.delete(v);
        this.stuckViewers.forget(v);
        try { v.close(1011); } catch { /* already gone */ }
        continue;
      }
      if (shouldDropOutbound(v, 'low')) continue; // slow viewer drops frames (#95)
      try {
        v.sendText(msg);
      } catch {
        st.viewers.delete(v);
      }
    }
  }

  private broadcast(sessionId: string, payload: Record<string, unknown>): void {
    const st = this.live.get(sessionId);
    if (!st) return;
    const msg = JSON.stringify(payload);
    for (const v of [...st.viewers]) {
      try {
        v.sendText(msg);
      } catch {
        st.viewers.delete(v);
      }
    }
  }

  private teardownLive(sessionId: string, reason: string): void {
    const st = this.live.get(sessionId);
    if (!st) return;
    this.live.delete(sessionId);
    if (st.timer) clearInterval(st.timer);
    if (st.stopTimer) clearTimeout(st.stopTimer);
    const msg = JSON.stringify({ t: 'ended', reason });
    for (const v of [...st.viewers]) {
      try {
        v.sendText(msg);
        v.close(1000);
      } catch {
        // ignore
      }
    }
    st.viewers.clear();
  }

  private ensureSweeper(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      const cutoff = this.now() - PENDING_SWEEP_MS;
      for (const [id, s] of this.sessions) {
        if (s.status === 'pending' && s.createdAt < cutoff) {
          s.status = 'expired';
          s.endedAt = this.now();
        }
        // Forget terminal sessions older than an hour (bounded memory).
        if ((s.status === 'ended' || s.status === 'denied' || s.status === 'expired') && (s.endedAt ?? 0) < this.now() - 3600_000) {
          this.sessions.delete(id);
        }
      }
    }, 60_000);
    if (typeof this.sweepTimer === 'object' && 'unref' in this.sweepTimer) {
      (this.sweepTimer as unknown as { unref(): void }).unref();
    }
  }

  /** Test/CLI helper: how many sessions are tracked. */
  sessionCount(): number {
    return this.sessions.size;
  }

  close(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const id of [...this.live.keys()]) this.teardownLive(id, 'shutdown');
  }
}
