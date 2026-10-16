// SPDX-License-Identifier: Apache-2.0
//
// Per-bot COMPUTER VIEW (KriyaDot MVP, workstream A).
//
// What it is: a live view + control surface for each bot's sandboxed screen.
// The web UI (apps/web/components/panels/computer-panel.tsx, mounted as a
// per-bot tab inside the BOTS destination) opens a WebSocket at
// /api/computer/ws?botId=<id> and receives PNG screenshot frames as JSON
// (base64 data URLs, ~3 fps default, configurable). The user's OWN input
// (click/type/key) goes through POST /api/computer/input — no approval is
// required for the user's own input, but every input is AUDIT-LOGGED via
// the governance audit trail as 'tool.computer_viewer_action' (mirroring
// how index.ts audits 'tool.computer_real_action' for agent actions).
//
// One session per bot: each botId gets its own OS layer (created on first
// use via selectOSLayer()) and its own screenshot fan-out loop, kept in
// memory. The loop runs only while at least one viewer is attached.
//
// "Agent driving" indicator: derived from the governance audit log. If the
// bot called any computer_* tool (action 'tool.executed' with a
// tool_name starting with 'computer_', or the index.ts
// 'tool.computer_real_action' hook) inside the last DRIVING_WINDOW_MS
// (default 10s), the bot is flagged as driving and the flag is included in
// every WS frame message and in GET /api/computer/status.
//
// Wire protocol (WebSocket):
//   client -> server: { t: 'watch', botId }
//   server -> client: { t: 'ok', botId, mock, w, h, fps }
//   server -> client: { t: 'frame', png, w, h, ts, driving, mock, n }
//   server -> client: { t: 'error', detail }
//
// REST API (mounted at /api/computer):
//   POST /api/computer/input
//     { botId, action: 'click'|'type'|'key', x?, y?, text?, key? }
//     click: x/y are physical pixels, bounds-checked against displaySize().
//     type:  text string, 1..2000 chars.
//     key:   must be in COMPUTER_KEY_ALLOWLIST.
//   GET /api/computer/status?botId=<id>
//     { ok, botId, mock, agentDriving, viewers, fps, w, h }
//
// Mounting (index.ts is NOT edited by this module; the integrator wires it):
//   import { createComputerView } from './computer-view.js';
//   const computerView = createComputerView({
//     audit: (action, fields) => governance.audit(action, fields),
//     listAudit: (limit) => governance.listAudit(limit),
//     loopbackToken, // per-boot token from loopback-auth.ts (browser WS ?token=)
//   });
//   app.use('/api/computer', computerView.router);
//   // ... in the existing server 'upgrade' handler, add:
//   } else if (path === '/api/computer/ws') {
//     computerView.handleUpgrade(req, socket, head);
//   }
// Mount the router BEFORE the '/api' unknown-route 404 handler. The upgrade
// branch goes inside the existing switch alongside '/api/phone/ws'.
//
// Real control (foreground machine, NOT the mock):
//   1. On the machine whose screen you want to control:
//        npm install screenshot-desktop robotjs
//      (robotjs needs a C++ toolchain at install time — node-gyp, python3,
//      and on macOS Xcode CLT / on Linux build-essential + libxtst-dev.
//      Screenshots work with screenshot-desktop alone; input needs robotjs.)
//   2. Start the API with COMPUTER_USE_REAL=1 in the environment.
//      selectOSLayer() then returns RealOSScreenLayer (lazy robotjs, so a
//      missing install throws a clear error only on first use, never at
//      boot). The default (env unset) is the safe MockOSScreenLayer, which
//      returns a fixture PNG and records calls without touching the OS.
//   3. Approval gating is orthogonal to the layer: the runtime still
//      evaluates computer_click/type/key against policy (require-approval
//      via computerUsePolicyRules()) before the handler runs.
// SAFETY: the real layer drives the actual foreground desktop of the API
// host. Run it only on a dedicated VM/container or with explicit
// user consent per session — exactly the warning in computer-real.ts.
//
// Frame rate: COMPUTER_VIEW_FPS (1..10, default 3). Driving window:
// deps.drivingWindowMs (default 10000).
//
// No paid APIs anywhere in this module; tests inject MockOSScreenLayer.

import express, { type Request, type Response, type Router } from 'express';
import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { validateWsQueryToken } from './loopback-auth.js';
import { selectOSLayer } from '@mvp/agent-runtime/dist/tools/computer-real.js';
import { COMPUTER_KEY_ALLOWLIST } from '@mvp/agent-runtime/dist/tools/computer.js';
import type { OSScreenLayer } from '@mvp/agent-runtime/dist/tools/computer.js';
// Per-bot computers (P1 #14): unwrap the manager's lazy proxy so the
// "mock layer" badge stays honest now that layers resolve per bot.
import { layerIsMock } from '@mvp/agent-runtime/dist/tools/computer-surfaces.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** WebSocket endpoint path (query: ?botId=<id>). */
export const COMPUTER_VIEW_WS_PATH = '/api/computer/ws';

/** Bot ids are validated like phone device ids. */
const BOT_ID_RE = /^[A-Za-z0-9_:-]{1,128}$/;

/** Max typed text per input (mirrors the computer_type tool's cap). */
const MAX_TYPE_CHARS = 2000;

/** Default frames per second for the screenshot fan-out loop. */
const DEFAULT_FPS = 3;

/** Default "agent driving" window: a computer_* tool call within this window counts. */
const DEFAULT_DRIVING_WINDOW_MS = 10_000;

/** Audit log scan depth for the driving indicator (newest-first scan). */
const AUDIT_SCAN_LIMIT = 500;

function envFps(): number {
  const raw = Number.parseInt(process.env['COMPUTER_VIEW_FPS'] ?? '', 10);
  if (Number.isFinite(raw)) return Math.min(10, Math.max(1, raw));
  return DEFAULT_FPS;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/** Minimal audit-log entry shape needed for the driving indicator. */
export interface ComputerViewAuditEntry {
  ts: number;
  actor: string;
  action: string;
  toolName?: string;
  detail?: string;
}

export interface ComputerViewDeps {
  /**
   * Governance audit hook — wire as
   *   (action, fields) => governance.audit(action, fields)
   * (the same pattern index.ts uses for 'tool.computer_real_action').
   */
  audit: (action: string, fields: Record<string, unknown>) => void;
  /**
   * Recent audit entries, newest first — wire as
   *   (limit) => governance.listAudit(limit)
   */
  listAudit: (limit: number) => ComputerViewAuditEntry[];
  /**
   * Create the OS layer for a bot. Defaults to selectOSLayer(): the REAL
   * foreground layer only when COMPUTER_USE_REAL=1, otherwise the safe
   * MockOSScreenLayer. Tests inject () => new MockOSScreenLayer().
   */
  createLayer?: (botId: string) => OSScreenLayer;
  /** Frames per second for the screenshot loop (1..10). Defaults to COMPUTER_VIEW_FPS or 3. */
  fps?: number;
  /** Driving-indicator window in ms. Default 10_000. */
  drivingWindowMs?: number;
  /**
   * Per-boot loopback bearer token (index.ts). Browsers can't set
   * Authorization headers on WS handshakes, so the web UI appends it as
   * `?token=` on the computer-view WS URL (a single-use `?ticket=` from
   * issueWsTicket is also accepted).
   */
  loopbackToken: string;
}

// ---------------------------------------------------------------------------
// Minimal RFC 6455 WebSocket socket (server side, text frames only)
// ---------------------------------------------------------------------------
// Dependency-free, mirroring the approach in phone.ts: enough to serve the
// browser (masked client frames, ping/pong, close) and JSON text messages.
// Binary frames from the client are rejected.

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Max accumulated inbound bytes (frame buffer + pending fragments) per socket. */
export const MAX_WS_BUFFER_BYTES = 16 * 1024 * 1024;

export interface ViewerSocket {
  sendText(text: string): void;
  close(code?: number): void;
  onMessage(cb: (text: string) => void): void;
  onClose(cb: () => void): void;
}

class MiniWsSocket implements ViewerSocket {
  private msgCb: ((text: string) => void) | null = null;
  private closeCb: (() => void) | null = null;
  private closed = false;
  private buf = Buffer.alloc(0);
  private frag: Buffer[] = [];
  private fragBytes = 0;

  constructor(private readonly socket: Duplex) {
    socket.on('data', (d: Buffer) => this.onData(d));
    socket.on('close', () => this.emitClose());
    socket.on('error', () => this.emitClose());
    // Remote half-close (FIN): finish our side and clean up instead of
    // sitting in CLOSE-WAIT forever (same reasoning as phone.ts).
    socket.on('end', () => this.close(1000));
  }

  onMessage(cb: (text: string) => void): void {
    this.msgCb = cb;
  }

  onClose(cb: () => void): void {
    this.closeCb = cb;
  }

  sendText(text: string): void {
    if (this.closed) return;
    const payload = Buffer.from(text, 'utf8');
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
      header = Buffer.from([0x81, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch {
      this.close(1011);
    }
  }

  close(code = 1000): void {
    if (this.closed) return;
    this.closed = true;
    try {
      const payload = Buffer.alloc(2);
      payload.writeUInt16BE(code, 0);
      this.socket.write(Buffer.from([0x88, 0x02, payload[0], payload[1]]));
    } catch {
      // ignore
    }
    try {
      this.socket.destroy();
    } catch {
      // ignore
    }
    this.emitClose();
  }

  private emitClose(): void {
    if (this.closeCb) {
      const cb = this.closeCb;
      this.closeCb = null;
      try {
        cb();
      } catch {
        // ignore
      }
    }
  }

  /**
   * Destroy the underlying socket immediately without writing a close frame.
   * Used for abusive peers (e.g. unbounded inbound buffering) where we don't
   * want to spend any more effort on the connection.
   */
  private hardDestroy(): void {
    if (this.closed) return;
    this.closed = true;
    this.buf = Buffer.alloc(0);
    this.frag = [];
    this.fragBytes = 0;
    try {
      this.socket.destroy();
    } catch {
      // ignore
    }
    this.emitClose();
  }

  private onData(d: Buffer): void {
    if (this.closed) return;
    this.buf = Buffer.concat([this.buf, d]);
    // H3: cap the accumulated inbound bytes. A peer that never finishes a
    // frame (or declares a huge frame and trickles payload) would otherwise
    // grow this buffer without bound.
    if (this.buf.length + this.fragBytes > MAX_WS_BUFFER_BYTES) {
      this.hardDestroy();
      return;
    }
    while (this.buf.length >= 2) {
      const b0 = this.buf[0]!;
      const b1 = this.buf[1]!;
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        off = 10;
      }
      // Clients MUST mask; a server frame here would be a protocol error.
      if (!masked) {
        this.close(1002);
        return;
      }
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      const raw = this.buf.subarray(off + 4, off + 4 + len);
      this.buf = this.buf.subarray(off + 4 + len);
      const payload = Buffer.alloc(len);
      for (let i = 0; i < len; i++) payload[i] = raw[i]! ^ mask[i % 4]!;

      if (opcode === 0x8) {
        this.close(1000);
        return;
      }
      if (opcode === 0x9) {
        // Ping -> pong with the same payload.
        try {
          const pl = Buffer.concat([Buffer.from([0x8a, payload.length]), payload]);
          this.socket.write(pl);
        } catch {
          // ignore
        }
        continue;
      }
      if (opcode === 0xa) continue; // pong: nothing to do
      if (opcode === 0x0) {
        // continuation
        this.frag.push(payload);
        this.fragBytes += payload.length;
        if (fin) {
          const text = Buffer.concat(this.frag).toString('utf8');
          this.frag = [];
          this.fragBytes = 0;
          this.msgCb?.(text);
        }
        continue;
      }
      if (opcode === 0x1) {
        if (!fin) {
          this.frag = [payload];
          this.fragBytes = payload.length;
          continue;
        }
        this.msgCb?.(payload.toString('utf8'));
        continue;
      }
      // binary / reserved opcodes: reject
      this.close(1003);
      return;
    }
  }
}

function computeAccept(key: string): string {
  return createHash('sha1').update(key + WS_GUID, 'utf8').digest('base64');
}

/**
 * Perform the server side of the RFC 6455 handshake on an upgraded socket
 * and wrap it in a ViewerSocket. Returns null (after writing a 400 and
 * destroying the socket) when the handshake headers are invalid.
 *
 * Shared with remote-screen.ts so the minimal WS implementation lives in
 * exactly one place.
 */
export function acceptRawWsSocket(req: IncomingMessage, socket: Duplex): ViewerSocket | null {
  const key = req.headers['sec-websocket-key'];
  const upgrade = String(req.headers['upgrade'] ?? '').toLowerCase();
  if (upgrade !== 'websocket' || req.headers['sec-websocket-version'] !== '13' || typeof key !== 'string') {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return null;
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${computeAccept(key)}\r\n\r\n`,
  );
  return new MiniWsSocket(socket);
}

// ---------------------------------------------------------------------------
// Per-bot viewer state
// ---------------------------------------------------------------------------

interface BotViewState {
  botId: string;
  layer: OSScreenLayer;
  isMock: boolean;
  viewers: Set<ViewerSocket>;
  timer: ReturnType<typeof setInterval> | null;
  frames: number;
  lastError: string | null;
  /**
   * MEDIUM fix: re-entrancy guard. screenshot() is async; when it takes
   * longer than the tick interval, a second capture must not start on top
   * of the first (frame pile-up + unbounded memory). Skipped ticks are
   * simply dropped — the next tick picks up the latest screen.
   */
  capturing: boolean;
}

interface WatchMessage {
  t: string;
  botId?: unknown;
}

function err(res: Response, status: number, error: string, detail?: string): void {
  res.status(status).json(detail ? { error, detail } : { error });
}

function validBotId(botId: unknown): botId is string {
  return typeof botId === 'string' && BOT_ID_RE.test(botId);
}

// ---------------------------------------------------------------------------
// ComputerView hub: router + WS handling + per-bot sessions
// ---------------------------------------------------------------------------

export class ComputerViewHub {
  private readonly deps: Required<Pick<ComputerViewDeps, 'audit' | 'listAudit' | 'loopbackToken'>> &
    Pick<ComputerViewDeps, 'createLayer'> & { fps: number; drivingWindowMs: number };
  private readonly states = new Map<string, BotViewState>();

  constructor(deps: ComputerViewDeps) {
    this.deps = {
      audit: deps.audit,
      listAudit: deps.listAudit,
      createLayer: deps.createLayer,
      fps: deps.fps ?? envFps(),
      drivingWindowMs: deps.drivingWindowMs ?? DEFAULT_DRIVING_WINDOW_MS,
      loopbackToken: deps.loopbackToken,
    };
  }

  /** Build the Express router (mounted at /api/computer by the integrator). */
  createRouter(): Router {
    const router = express.Router();
    router.post('/input', (req, res) => void this.handleInput(req, res));
    router.get('/status', (req, res) => void this.handleStatus(req, res));
    return router;
  }

  /** Stop all screenshot loops (used by tests / shutdown). Sessions stay in memory. */
  stop(): void {
    for (const state of this.states.values()) {
      if (state.timer) {
        clearInterval(state.timer);
        state.timer = null;
      }
    }
  }

  // ---- sessions -----------------------------------------------------------

  private stateFor(botId: string): BotViewState {
    let state = this.states.get(botId);
    if (!state) {
      const layer = this.deps.createLayer ? this.deps.createLayer(botId) : selectOSLayer();
      state = {
        botId,
        layer,
        // P1 #14: layers now arrive as per-bot lazy proxies — unwrap before
        // the mock check so the badge reflects the real backend.
        isMock: layerIsMock(layer),
        viewers: new Set(),
        timer: null,
        frames: 0,
        lastError: null,
        capturing: false,
      };
      this.states.set(botId, state);
    }
    return state;
  }

  /** True when the bot called any computer_* tool inside the driving window. */
  agentDriving(botId: string): boolean {
    const cutoff = Date.now() - this.deps.drivingWindowMs;
    let entries: ComputerViewAuditEntry[];
    try {
      entries = this.deps.listAudit(AUDIT_SCAN_LIMIT);
    } catch {
      return false;
    }
    for (const e of entries) {
      if (e.ts < cutoff) break; // newest first
      if (!e.toolName || !e.toolName.startsWith('computer_')) continue;
      // Agent runtime tool executions are audited as 'tool.executed' with
      // actor = botId (see AgentRuntime audit -> GovernanceAdapter).
      if (e.action === 'tool.executed' && e.actor === botId) return true;
      // index.ts's onRealAction hook audits 'tool.computer_real_action' with
      // actor 'agent'; accept it when the detail names this bot.
      if (e.action === 'tool.computer_real_action' && e.actor === botId) return true;
      if (
        e.action === 'tool.computer_real_action' &&
        e.actor === 'agent' &&
        typeof e.detail === 'string' &&
        e.detail.includes(botId)
      ) {
        return true;
      }
    }
    return false;
  }

  // ---- REST ---------------------------------------------------------------

  private async handleInput(req: Request, res: Response): Promise<void> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { botId, action } = body;
    if (!validBotId(botId)) {
      err(res, 400, 'bad_botId', 'botId must match /^[A-Za-z0-9_:-]{1,128}$/');
      return;
    }
    if (action !== 'click' && action !== 'type' && action !== 'key') {
      err(res, 400, 'bad_action', "action must be 'click', 'type' or 'key'");
      return;
    }
    const state = this.stateFor(botId);
    const { layer } = state;

    // The user's OWN input needs no approval (it is their explicit action),
    // but every input MUST be audit-logged — same governance audit the
    // index.ts wiring uses for 'tool.computer_real_action'. Detail never
    // carries the raw typed text, only its length (audit detail is
    // secret-redacted anyway, but length is all anyone needs).
    const auditInput = (detail: Record<string, unknown>): void => {
      try {
        this.deps.audit('tool.computer_viewer_action', {
          actor: 'user',
          toolName: `computer_${action}`,
          detail: { botId, layer: state.isMock ? 'mock' : 'real', ...detail },
        });
      } catch {
        // Audit must never break input.
      }
    };

    try {
      if (action === 'click') {
        const x = body['x'];
        const y = body['y'];
        if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y)) {
          err(res, 400, 'bad_coords', 'x and y must be finite numbers (physical pixels)');
          return;
        }
        const { width, height } = await layer.displaySize();
        const xi = Math.floor(x);
        const yi = Math.floor(y);
        if (xi < 0 || yi < 0 || xi >= width || yi >= height) {
          err(res, 400, 'out_of_bounds', `click (${xi}, ${yi}) is outside the ${width}×${height} display`);
          return;
        }
        await layer.click(xi, yi);
        auditInput({ x: xi, y: yi });
        res.json({ ok: true, action, x: xi, y: yi });
        return;
      }
      if (action === 'type') {
        const text = body['text'];
        if (typeof text !== 'string' || text.length === 0) {
          err(res, 400, 'bad_text', 'text must be a non-empty string');
          return;
        }
        if (text.length > MAX_TYPE_CHARS) {
          err(res, 400, 'text_too_long', `"text" too long (${text.length} > ${MAX_TYPE_CHARS} chars)`);
          return;
        }
        await layer.type(text);
        auditInput({ typedChars: text.length });
        res.json({ ok: true, action, typedChars: text.length });
        return;
      }
      // key
      const key = body['key'];
      if (typeof key !== 'string' || !COMPUTER_KEY_ALLOWLIST.has(key)) {
        err(res, 400, 'bad_key', `key must be one of: ${[...COMPUTER_KEY_ALLOWLIST].join(', ')}`);
        return;
      }
      await layer.key(key);
      auditInput({ key });
      res.json({ ok: true, action, key });
    } catch (e) {
      err(res, 500, 'input_failed', e instanceof Error ? e.message : String(e));
    }
  }

  private async handleStatus(req: Request, res: Response): Promise<void> {
    const botId = req.query['botId'];
    if (!validBotId(botId)) {
      err(res, 400, 'bad_botId', 'botId must match /^[A-Za-z0-9_:-]{1,128}$/');
      return;
    }
    const state = this.stateFor(botId);
    let dims = { width: 0, height: 0 };
    try {
      dims = await state.layer.displaySize();
    } catch {
      // report zeros; the WS loop reports its own errors
    }
    res.json({
      ok: true,
      botId,
      mock: state.isMock,
      agentDriving: this.agentDriving(botId),
      viewers: state.viewers.size,
      fps: this.deps.fps,
      w: dims.width,
      h: dims.height,
    });
  }

  // ---- WebSocket ----------------------------------------------------------

  /** HTTP upgrade entry point — wired into the server's 'upgrade' event by the integrator. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, _head: Buffer): void {
    // NOTE: req.url carries the credential (?token= / ?ticket=) — never log it.
    const url = new URL(req.url ?? COMPUTER_VIEW_WS_PATH, 'http://localhost');
    if (!validateWsQueryToken(url.searchParams, this.deps.loopbackToken)) {
      // Reject like the voice-call upgrade: complete the handshake so we can
      // send a machine-readable error, then close with 4401.
      const sock = acceptRawWsSocket(req, socket);
      if (sock) {
        try {
          sock.sendText(JSON.stringify({ t: 'error', detail: 'unauthorized' }));
          sock.close(4401);
        } catch {
          // ignore
        }
      }
      return;
    }
    const sock = acceptRawWsSocket(req, socket);
    if (!sock) return;
    const queryBotId = url.searchParams.get('botId');
    this.acceptSocket(sock, queryBotId);
  }

  /**
   * Accept an already-established text-message socket (used by tests with
   * an in-process fake). In production the botId comes from the ?botId=
   * query; the client's first {t:'watch', botId} message must match it.
   */
  acceptSocket(sock: ViewerSocket, queryBotId: string | null): void {
    let state: BotViewState | null = null;

    const sendErr = (detail: string): void => {
      try {
        sock.sendText(JSON.stringify({ t: 'error', detail }));
      } catch {
        // ignore
      }
    };

    const detach = (): void => {
      if (state) {
        state.viewers.delete(sock);
        if (state.viewers.size === 0 && state.timer) {
          clearInterval(state.timer);
          state.timer = null;
        }
        state = null;
      }
    };
    sock.onClose(detach);

    sock.onMessage((text) => {
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        sendErr('invalid_json');
        return;
      }
      const msg = raw as WatchMessage;
      if (!msg || typeof msg !== 'object' || msg.t !== 'watch') {
        sendErr('expected_watch');
        return;
      }
      const botId = msg.botId;
      if (!validBotId(botId)) {
        sendErr('bad_botId');
        sock.close(4400);
        return;
      }
      if (queryBotId && queryBotId !== botId) {
        sendErr('botId_mismatch');
        sock.close(4400);
        return;
      }
      if (state && state.botId === botId) return; // already watching
      detach();
      const next = this.stateFor(botId);
      state = next;
      next.viewers.add(sock);
      void next.layer
        .displaySize()
        .then((dims) => {
          sock.sendText(
            JSON.stringify({
              t: 'ok',
              botId,
              mock: next.isMock,
              w: dims.width,
              h: dims.height,
              fps: this.deps.fps,
            }),
          );
        })
        .catch((e) => sendErr(e instanceof Error ? e.message : String(e)));
      this.ensureLoop(next);
    });
  }

  private ensureLoop(state: BotViewState): void {
    if (state.timer) return;
    const intervalMs = Math.max(100, Math.round(1000 / this.deps.fps));
    const tick = (): void => {
      if (state.viewers.size === 0) {
        if (state.timer) {
          clearInterval(state.timer);
          state.timer = null;
        }
        return;
      }
      // MEDIUM fix: skip this tick when the previous capture is still in
      // flight — never stack overlapping screenshot() promises.
      if (state.capturing) return;
      state.capturing = true;
      void state.layer
        .screenshot()
        .then((shot) => {
          state.frames += 1;
          state.lastError = null;
          const frame = JSON.stringify({
            t: 'frame',
            png: Buffer.from(shot.png).toString('base64'),
            w: shot.width,
            h: shot.height,
            ts: Date.now(),
            driving: this.agentDriving(state.botId),
            mock: state.isMock,
            n: state.frames,
          });
          for (const viewer of [...state.viewers]) {
            try {
              viewer.sendText(frame);
            } catch {
              state.viewers.delete(viewer);
            }
          }
        })
        .catch((e) => {
          state.lastError = e instanceof Error ? e.message : String(e);
          for (const viewer of [...state.viewers]) {
            try {
              viewer.sendText(JSON.stringify({ t: 'error', detail: state.lastError }));
            } catch {
              state.viewers.delete(viewer);
            }
          }
        })
        .finally(() => {
          state.capturing = false;
        });
    };
    state.timer = setInterval(tick, intervalMs);
    // Fire the first frame immediately so the UI doesn't wait a full interval.
    tick();
  }
}

// ---------------------------------------------------------------------------
// Factory + mount helper
// ---------------------------------------------------------------------------

export interface ComputerView {
  hub: ComputerViewHub;
  /** Express router — integrator mounts it at /api/computer. */
  router: Router;
  /** Upgrade handler — integrator branches to it for COMPUTER_VIEW_WS_PATH. */
  handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
}

/** Create the hub + router. The integrator mounts the router and wires the upgrade branch. */
export function createComputerView(deps: ComputerViewDeps): ComputerView {
  const hub = new ComputerViewHub(deps);
  return {
    hub,
    router: hub.createRouter(),
    handleUpgrade: (req, socket, head) => hub.handleUpgrade(req, socket, head),
  };
}

/**
 * Mount the REST routes on the Express app at /api/computer. Returns the
 * ComputerView (the integrator still needs ONE line in the existing
 * server 'upgrade' handler — see the module header):
 *
 *   } else if (path === '/api/computer/ws') {
 *     computerView.handleUpgrade(req, socket, head);
 *   }
 *
 * Mount BEFORE the '/api' unknown-route 404 handler.
 */
export function mountComputerView(
  app: { use: (path: string, router: Router) => void },
  deps: ComputerViewDeps,
): ComputerView {
  const view = createComputerView(deps);
  app.use('/api/computer', view.router);
  return view;
}
