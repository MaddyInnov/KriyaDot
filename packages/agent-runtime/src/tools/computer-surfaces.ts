// SPDX-License-Identifier: Apache-2.0
// Per-bot computers + "Works on" surface selection (OpenMausBot parity P1 #14).
//
// Before this module, every bot shared one global computer sandbox instance,
// so Scout clicking moved Coder's mouse. Now each bot gets its OWN computer
// instance (own display state, own serialized input queue), and each bot
// (plus each conversation, via a pin override) chooses which surface it
// works on:
//
//   auto     — best available backend (docker if COMPUTER_USE_DOCKER=1, else
//              playwright if COMPUTER_USE_PLAYWRIGHT=1, else local). Default.
//   local    — the machine KriyaDot runs on (mock unless COMPUTER_USE_REAL=1).
//   docker   — the Docker computer sandbox (isolated container + CDP).
//   browser  — the Playwright browser surface.
//   off      — computer tools disabled for this bot (calls fail with a clear
//              error instead of driving a shared screen).
//
// Instances are created lazily on first computer-tool use, torn down when
// the bot's surface changes or the bot is deleted, and reaped after an idle
// timeout (default 30 min). The computer-view WebSocket viewer resolves to
// the same per-bot instance, so "Watch screen" shows what the bot drives.
//
// Trust model (unchanged): approval gating is orthogonal to the backend —
// computerUsePolicyRules() still marks the mutating actions require-approval
// and governance evaluates BEFORE any handler runs, whichever surface or
// bot is active.

import {
  COMPUTER_USE_DOCKER_ENV,
  DockerComputerSandbox,
  LocalComputerSandbox,
} from './computer-sandbox.js';
import {
  COMPUTER_USE_PLAYWRIGHT_ENV,
  PlaywrightOSScreenLayer,
} from './computer-playwright.js';
import {
  MockOSScreenLayer,
  type ChordModifier,
  type ClickOptions,
  type DisplaySize,
  type DragOptions,
  type OSScreenLayer,
  type Screenshot,
  type ToolContext,
} from './computer.js';

/** "Works on" surface choices. Stored on BotConfig.computerSurface. */
export type ComputerSurface = 'auto' | 'local' | 'docker' | 'browser' | 'off';

export const COMPUTER_SURFACES: readonly ComputerSurface[] = [
  'auto',
  'local',
  'docker',
  'browser',
  'off',
];

/** A surface that actually resolves to a backend ('off' never does). */
export type ResolvedComputerSurface = 'local' | 'docker' | 'browser';

export function isComputerSurface(v: unknown): v is ComputerSurface {
  return typeof v === 'string' && (COMPUTER_SURFACES as readonly string[]).includes(v);
}

/** Error thrown when a bot's computer surface is 'off' (or its pin is). */
export class ComputerSurfaceOffError extends Error {
  readonly botId: string;
  constructor(botId: string) {
    super(
      `computer tools are disabled for bot "${botId}" (surface "off"). ` +
        'Set "Works on" to a surface in Bots → Computer to enable them.',
    );
    this.name = 'ComputerSurfaceOffError';
    this.botId = botId;
  }
}

/** 'auto' picks the best available backend, mirroring selectOSLayer() priority. */
export function resolveAutoSurface(): ResolvedComputerSurface {
  if (process.env[COMPUTER_USE_DOCKER_ENV] === '1') return 'docker';
  if (process.env[COMPUTER_USE_PLAYWRIGHT_ENV] === '1') return 'browser';
  return 'local';
}

export function resolveSurfaceKind(
  surface: ComputerSurface,
): ResolvedComputerSurface | 'off' {
  if (surface === 'off') return 'off';
  if (surface === 'auto') return resolveAutoSurface();
  return surface;
}

/** Default idle timeout: dispose a bot's computer after 30 min unused. */
export const DEFAULT_COMPUTER_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export interface PerBotComputerManagerDeps {
  /**
   * Audit hook for real input actions (wired to governance in index.ts).
   * Receives the same (action, detail) shape as computer-real's onRealAction.
   */
  onRealAction?: (action: string, detail: unknown) => void;
  /** Idle timeout in ms. Default 30 min. */
  idleTimeoutMs?: number;
  /** Clock (tests inject a fake). */
  clock?: () => number;
  /**
   * Backend factory (tests inject mocks). Defaults to the real backends:
   * LocalComputerSandbox / DockerComputerSandbox / PlaywrightOSScreenLayer.
   */
  createBackend?: (
    resolved: ResolvedComputerSurface,
    botId: string,
  ) => OSScreenLayer | Promise<OSScreenLayer>;
}

export interface ComputerInstanceStatus {
  botId: string;
  /** Instance key: botId, or "botId@conversationId" when pinned. */
  key: string;
  pinned: boolean;
  conversationId?: string;
  surface: ComputerSurface;
  resolved: ResolvedComputerSurface;
  /** True once the backend has been launched/created. */
  running: boolean;
  lastUsedMs: number;
  idleMs: number;
}

interface Entry {
  botId: string;
  key: string;
  pinned: boolean;
  conversationId?: string;
  configured: ComputerSurface;
  resolved: ResolvedComputerSurface;
  proxy: LazyPerBotLayer;
  backend?: OSScreenLayer;
  launching?: Promise<OSScreenLayer>;
  running: boolean;
  lastUsedMs: number;
  /** Serialization queue: one bot's input actions never interleave. */
  tail: Promise<void>;
  closed: boolean;
}

/** A layer that throws on every method — used when the surface is 'off'. */
class DisabledComputerLayer implements OSScreenLayer {
  constructor(private readonly botId: string) {}
  private fail(): never {
    throw new ComputerSurfaceOffError(this.botId);
  }
  async displaySize(): Promise<DisplaySize> {
    this.fail();
  }
  async screenshot(): Promise<Screenshot> {
    this.fail();
  }
  async click(): Promise<void> {
    this.fail();
  }
  async type(): Promise<void> {
    this.fail();
  }
  async key(): Promise<void> {
    this.fail();
  }
  async keyChord(): Promise<void> {
    this.fail();
  }
  async scroll(): Promise<void> {
    this.fail();
  }
  async drag(): Promise<void> {
    this.fail();
  }
  async move(): Promise<void> {
    this.fail();
  }
}

function hasLaunch(l: OSScreenLayer): l is OSScreenLayer & { launch(): Promise<void> } {
  return typeof (l as { launch?: unknown }).launch === 'function';
}

function hasKill(l: OSScreenLayer): l is OSScreenLayer & { kill(): Promise<void> } {
  return typeof (l as { kill?: unknown }).kill === 'function';
}

function hasClose(l: OSScreenLayer): l is OSScreenLayer & { close(): Promise<void> } {
  return typeof (l as { close?: unknown }).close === 'function';
}

/**
 * Lazy proxy: creation is synchronous (so the computer-view WebSocket's
 * stateFor() can use it), but the backend is only constructed and launched
 * on first actual use. Every method serializes through the entry's queue so
 * one bot's actions never interleave, and updates the idle clock.
 */
class LazyPerBotLayer implements OSScreenLayer {
  /** Brand for layerIsMock() unwrapping. */
  readonly __perBotEntryBrand = true;
  constructor(
    private readonly mgr: PerBotComputerManager,
    private readonly entry: Entry,
  ) {}

  /** The live backend, if created yet (inspection only). */
  currentBackend(): OSScreenLayer | undefined {
    return this.entry.backend;
  }

  private enqueue<T>(fn: (layer: OSScreenLayer) => Promise<T>): Promise<T> {
    const entry = this.entry;
    entry.lastUsedMs = this.mgr.now();
    const run = entry.tail.then(async () => {
      if (entry.closed) {
        throw new Error(`computer for bot "${entry.botId}" was shut down`);
      }
      const layer = await this.mgr.ensureBackend(entry);
      return fn(layer);
    });
    // Keep the chain alive across failures; the caller still sees the error.
    entry.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  displaySize(): Promise<DisplaySize> {
    return this.enqueue((l) => l.displaySize());
  }
  screenshot(): Promise<Screenshot> {
    return this.enqueue((l) => l.screenshot());
  }
  click(x: number, y: number, opts?: ClickOptions): Promise<void> {
    return this.enqueue((l) => l.click(x, y, opts));
  }
  type(text: string): Promise<void> {
    return this.enqueue((l) => l.type(text));
  }
  key(name: string): Promise<void> {
    return this.enqueue((l) => l.key(name));
  }
  keyChord(modifiers: ChordModifier[], keyName: string): Promise<void> {
    return this.enqueue((l) => l.keyChord(modifiers, keyName));
  }
  scroll(x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
    return this.enqueue((l) => l.scroll(x, y, deltaX, deltaY));
  }
  drag(x1: number, y1: number, x2: number, y2: number, opts: DragOptions): Promise<void> {
    return this.enqueue((l) => l.drag(x1, y1, x2, y2, opts));
  }
  move(x: number, y: number): Promise<void> {
    return this.enqueue((l) => l.move(x, y));
  }
}

export class PerBotComputerManager {
  private readonly entries = new Map<string, Entry>();
  /** Conversation pins: `${botId}:${conversationId}` -> surface. */
  private readonly pins = new Map<string, ComputerSurface>();
  private readonly idleTimeoutMs: number;
  private readonly clock: () => number;
  private readonly onRealAction?: (action: string, detail: unknown) => void;
  private readonly createBackendOverride?: PerBotComputerManagerDeps['createBackend'];

  constructor(deps: PerBotComputerManagerDeps = {}) {
    this.idleTimeoutMs = deps.idleTimeoutMs ?? DEFAULT_COMPUTER_IDLE_TIMEOUT_MS;
    this.clock = deps.clock ?? Date.now;
    this.onRealAction = deps.onRealAction;
    this.createBackendOverride = deps.createBackend;
  }

  now(): number {
    return this.clock();
  }

  // ---- surface resolution -------------------------------------------------

  /** Pin a surface for one conversation (null clears the pin). */
  pinSurface(botId: string, conversationId: string, surface: ComputerSurface | null): void {
    const k = `${botId}:${conversationId}`;
    if (surface === null) {
      this.pins.delete(k);
    } else {
      this.pins.set(k, surface);
    }
    // A changed pin invalidates the pinned instance (if any).
    void this.killEntry(this.entries.get(`${botId}@${conversationId}`)).catch(() => undefined);
  }

  getPin(botId: string, conversationId: string): ComputerSurface | undefined {
    return this.pins.get(`${botId}:${conversationId}`);
  }

  listPins(botId: string): Array<{ conversationId: string; surface: ComputerSurface }> {
    const out: Array<{ conversationId: string; surface: ComputerSurface }> = [];
    for (const [k, surface] of this.pins) {
      if (k.startsWith(`${botId}:`)) {
        out.push({ conversationId: k.slice(botId.length + 1), surface });
      }
    }
    return out;
  }

  /**
   * The layer a bot's computer_* tools should drive for this turn.
   * `surface` is the bot's configured BotConfig.computerSurface ('auto'
   * when unset); a conversation pin overrides it for that chat.
   */
  getLayer(
    botId: string,
    opts: { surface?: ComputerSurface; conversationId?: string } = {},
  ): OSScreenLayer {
    const pin =
      opts.conversationId !== undefined
        ? this.pins.get(`${botId}:${opts.conversationId}`)
        : undefined;
    const configured = pin ?? opts.surface ?? 'auto';
    if (resolveSurfaceKind(configured) === 'off') {
      return new DisabledComputerLayer(botId);
    }
    const resolved = resolveSurfaceKind(configured) as ResolvedComputerSurface;
    const key = pin !== undefined && opts.conversationId !== undefined
      ? `${botId}@${opts.conversationId}`
      : botId;
    let entry = this.entries.get(key);
    if (!entry || entry.configured !== configured || entry.closed) {
      if (entry) void this.killEntry(entry).catch(() => undefined);
      const fresh: Entry = {
        botId,
        key,
        pinned: pin !== undefined,
        conversationId: pin !== undefined ? opts.conversationId : undefined,
        configured,
        resolved,
        proxy: undefined as unknown as LazyPerBotLayer,
        running: false,
        lastUsedMs: this.now(),
        tail: Promise.resolve(),
        closed: false,
      };
      fresh.proxy = new LazyPerBotLayer(this, fresh);
      this.entries.set(key, fresh);
      entry = fresh;
    }
    return entry.proxy;
  }

  /** Create (and launch) the backend for an entry. Idempotent per entry. */
  async ensureBackend(entry: Entry): Promise<OSScreenLayer> {
    if (entry.backend) return entry.backend;
    if (!entry.launching) {
      entry.launching = (async () => {
        const layer = this.createBackendOverride
          ? await this.createBackendOverride(entry.resolved, entry.botId)
          : this.defaultBackend(entry.resolved);
        if (hasLaunch(layer)) await layer.launch();
        entry.running = true;
        return layer;
      })();
    }
    try {
      entry.backend = await entry.launching;
      return entry.backend;
    } catch (err) {
      // Let the next call retry instead of caching a failed launch.
      entry.launching = undefined;
      throw err;
    }
  }

  private defaultBackend(resolved: ResolvedComputerSurface): OSScreenLayer {
    const onRealAction = this.onRealAction;
    if (resolved === 'docker') {
      return new DockerComputerSandbox(
        onRealAction
          ? {
              onEvent: (action, detail) => {
                if (
                  action === 'click' ||
                  action === 'type' ||
                  action === 'key' ||
                  action === 'scroll' ||
                  action === 'drag' ||
                  action === 'move'
                ) {
                  onRealAction(action, detail);
                }
              },
            }
          : {},
      );
    }
    if (resolved === 'browser') {
      return new PlaywrightOSScreenLayer(
        onRealAction ? { onRealAction: (a, d) => onRealAction(a, d) } : {},
      );
    }
    return new LocalComputerSandbox(onRealAction ? { onRealAction } : {});
  }

  // ---- lifecycle ----------------------------------------------------------

  private async killEntry(entry: Entry | undefined): Promise<void> {
    if (!entry || entry.closed) return;
    entry.closed = true;
    this.entries.delete(entry.key);
    try {
      await entry.tail;
    } catch {
      // Drained; individual callers already saw their errors.
    }
    const backend = entry.backend;
    entry.backend = undefined;
    entry.running = false;
    if (!backend) return;
    try {
      if (hasKill(backend)) await backend.kill();
      else if (hasClose(backend)) await backend.close();
    } catch {
      // kill() is best-effort by contract.
    }
  }

  /** Drop a bot's computer instance(s) — e.g. its surface changed. */
  async setSurface(_botId: string, _surface: ComputerSurface): Promise<void> {
    // The surface itself lives on BotConfig; the manager only needs to drop
    // cached instances so the next getLayer() rebuilds with the new config.
    await this.removeBot(_botId);
  }

  /** Full restart: fresh instance next use (also used by the Restart button). */
  async restart(botId: string): Promise<void> {
    await this.removeBot(botId);
  }

  /** Tear down every instance for a bot (bot deleted). Best-effort. */
  async removeBot(botId: string): Promise<void> {
    const doomed = [...this.entries.values()].filter((e) => e.botId === botId);
    await Promise.all(doomed.map((e) => this.killEntry(e).catch(() => undefined)));
    for (const k of [...this.pins.keys()]) {
      if (k.startsWith(`${botId}:`)) this.pins.delete(k);
    }
  }

  /** Reap instances idle longer than the idle timeout. */
  async idleSweep(now?: number): Promise<number> {
    const at = now ?? this.now();
    const doomed = [...this.entries.values()].filter(
      (e) => at - e.lastUsedMs >= this.idleTimeoutMs,
    );
    await Promise.all(doomed.map((e) => this.killEntry(e).catch(() => undefined)));
    return doomed.length;
  }

  // ---- status -------------------------------------------------------------

  status(botId: string): ComputerInstanceStatus[] {
    const at = this.now();
    return [...this.entries.values()]
      .filter((e) => e.botId === botId)
      .map((e) => ({
        botId: e.botId,
        key: e.key,
        pinned: e.pinned,
        conversationId: e.conversationId,
        surface: e.configured,
        resolved: e.resolved,
        running: e.running,
        lastUsedMs: e.lastUsedMs,
        idleMs: Math.max(0, at - e.lastUsedMs),
      }));
  }

  statusAll(): ComputerInstanceStatus[] {
    const at = this.now();
    return [...this.entries.values()].map((e) => ({
      botId: e.botId,
      key: e.key,
      pinned: e.pinned,
      conversationId: e.conversationId,
      surface: e.configured,
      resolved: e.resolved,
      running: e.running,
      lastUsedMs: e.lastUsedMs,
      idleMs: Math.max(0, at - e.lastUsedMs),
    }));
  }

  /** Resolver for registerComputerUseTool: per-bot layer per tool call. */
  resolveOSFor(getSurface: (botId: string) => ComputerSurface | undefined) {
    return (ctx: ToolContext): OSScreenLayer =>
      this.getLayer(ctx.botId, {
        surface: getSurface(ctx.botId),
        conversationId: ctx.conversationId,
      });
  }
}

/**
 * True when the layer (unwrapping per-bot lazy proxies) is the safe mock.
 * Used by the computer-view to show the "mock layer" badge honestly even
 * though tools now resolve through the manager.
 */
export function layerIsMock(layer: OSScreenLayer): boolean {
  let inner: OSScreenLayer = layer;
  if (inner instanceof LazyPerBotLayer) {
    const live = inner.currentBackend();
    if (!live) return true; // never launched: nothing real could have happened
    inner = live;
  }
  if (inner instanceof MockOSScreenLayer) return true;
  if (inner instanceof LocalComputerSandbox) return inner.isMock;
  return false;
}

// Re-export for hosts that only import this module.
export { LocalComputerSandbox, DockerComputerSandbox, PlaywrightOSScreenLayer };
