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
//   vps      — the user's own server over SSH (VpsComputerLayer; needs a VPS
//              profile for the bot, configured in Bots → Computer → VPS).
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

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
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
import { VpsNotConfiguredError } from './vps.js';
import { defaultBrowserHoldRegistry, type BrowserHoldRegistry } from './browser-hold.js';

/** "Works on" surface choices. Stored on BotConfig.computerSurface. */
export type ComputerSurface = 'auto' | 'local' | 'docker' | 'browser' | 'vps' | 'off';

export const COMPUTER_SURFACES: readonly ComputerSurface[] = [
  'auto',
  'local',
  'docker',
  'browser',
  'vps',
  'off',
];

/** A surface that actually resolves to a backend ('off' never does). */
export type ResolvedComputerSurface = 'local' | 'docker' | 'browser' | 'vps';

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

// ---------------------------------------------------------------------------
// Configured computer providers (per-bot `computerProvider`)
// ---------------------------------------------------------------------------
// A finer-grained, provider-named dial on top of surfaces:
//   auto       — fall through to env, then the safe default.
//   mock       — the safe MockOSScreenLayer (local surface, no real input).
//   playwright — the Playwright browser surface.
//   desktop    — real foreground desktop (local surface + COMPUTER_USE_REAL path).
//   docker     — the Docker computer sandbox.
// Resolution order: per-bot config → env (COMPUTER_USE_DOCKER /
// COMPUTER_USE_PLAYWRIGHT / COMPUTER_USE_REAL) → auto (mock).

export type ComputerProvider = 'auto' | 'mock' | 'playwright' | 'desktop' | 'docker';
export const COMPUTER_PROVIDERS: readonly ComputerProvider[] = ['auto', 'mock', 'playwright', 'desktop', 'docker'];
export function isComputerProvider(v: unknown): v is ComputerProvider {
  return typeof v === 'string' && (COMPUTER_PROVIDERS as readonly string[]).includes(v);
}
export type ComputerBackend = 'mock' | 'playwright' | 'desktop' | 'docker';
export type ComputerProviderSource = 'config' | 'env' | 'auto' | 'unavailable';

export interface ComputerProviderResolution {
  requested: ComputerProvider;
  backend: ComputerBackend | null;
  source: ComputerProviderSource;
  reason: string;
}

export function resolveComputerProvider(input: {
  configProvider?: ComputerProvider | null;
  env?: NodeJS.ProcessEnv;
  surface?: ComputerSurface;
} = {}): ComputerProviderResolution {
  const env = input.env ?? process.env;
  if (input.surface === 'off') {
    return { requested: input.configProvider ?? 'auto', backend: null, source: 'unavailable', reason: 'computer surface is "off" for this bot' };
  }
  const cfg = input.configProvider;
  if (cfg && cfg !== 'auto') {
    return { requested: cfg, backend: cfg, source: 'config', reason: `per-bot computerProvider="${cfg}"` };
  }
  if (env.COMPUTER_USE_DOCKER === '1') return { requested: 'auto', backend: 'docker', source: 'env', reason: 'COMPUTER_USE_DOCKER=1 in environment' };
  if (env.COMPUTER_USE_PLAYWRIGHT === '1') return { requested: 'auto', backend: 'playwright', source: 'env', reason: 'COMPUTER_USE_PLAYWRIGHT=1 in environment' };
  if (env.COMPUTER_USE_REAL === '1') return { requested: 'auto', backend: 'desktop', source: 'env', reason: 'COMPUTER_USE_REAL=1 in environment' };
  return { requested: 'auto', backend: 'mock', source: 'auto', reason: 'auto: no real backend opted in — safe mock layer' };
}

/** Map a resolved provider backend back to the surface that implements it. */
export function surfaceForComputerBackend(backend: ComputerBackend): ResolvedComputerSurface {
  if (backend === 'docker') return 'docker';
  if (backend === 'playwright') return 'browser';
  return 'local'; // mock and desktop both live on the local surface
}

/** Default idle timeout: dispose a bot's computer after 30 min unused. */
export const DEFAULT_COMPUTER_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// W4: per-bot persistent browser profiles
// ---------------------------------------------------------------------------

/**
 * Directory name for one bot's profile under the profile root. Bot ids in
 * the safe charset ([A-Za-z0-9_-]) are used verbatim; anything else is
 * sanitized AND suffixed with a short hash of the raw id, so two distinct
 * ids ("a:b" vs "a_b") can never collide into one profile — profiles hold
 * logins, and cross-bot leakage would be a credential-isolation failure.
 */
export function browserProfileDirName(botId: string): string {
  if (/^[A-Za-z0-9_-]{1,128}$/.test(botId)) return botId;
  const sanitized = botId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 96) || 'bot';
  const hash = createHash('sha256').update(botId).digest('hex').slice(0, 12);
  return `${sanitized}-${hash}`;
}

/** Absolute profile directory for a bot under a profile root. */
export function browserProfileDirFor(profileRoot: string, botId: string): string {
  return path.join(profileRoot, browserProfileDirName(botId));
}

/** On-disk usage of a directory tree (missing dir → zeros). Best-effort. */
export function profileDiskUsage(dir: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        try {
          bytes += fs.statSync(p).size;
          files += 1;
        } catch {
          // Raced with a browser write/delete — skip the file.
        }
      }
    }
  };
  walk(dir);
  return { bytes, files };
}

export interface BrowserProfileInfo {
  botId: string;
  /** Absolute per-bot profile directory (the persistent-context user-data dir). */
  profileDir: string;
  exists: boolean;
  bytes: number;
  files: number;
}

export interface BrowserProfileWipeResult {
  botId: string;
  profileDir: string;
  /** True when a profile directory existed (and was deleted). */
  wiped: boolean;
  bytesFreed: number;
}

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
   * LocalComputerSandbox / DockerComputerSandbox / PlaywrightOSScreenLayer /
   * the VPS layer (via vpsLayerFor).
   */
  createBackend?: (
    resolved: ResolvedComputerSurface,
    botId: string,
  ) => OSScreenLayer | Promise<OSScreenLayer>;
  /**
   * ADD-5: host override for the LOCAL backend only (other surfaces
   * keep their defaults). The API host wires the setup-aware layer:
   * setup-required until the user completes the computer-use setup
   * flow, the real verified OS adapter once enabled.
   */
  localLayerFor?: (botId: string) => OSScreenLayer | Promise<OSScreenLayer>;
  /**
   * VPS layer factory: builds the OSScreenLayer for a bot whose surface
   * resolves to 'vps'. The host wires this to a VpsConnectionPool backed by
   * the bot's VPS profile. Throw VpsNotConfiguredError when the bot has no
   * profile — the error message tells the user where to add one.
   */
  vpsLayerFor?: (botId: string) => OSScreenLayer | Promise<OSScreenLayer>;
  /**
   * W4: server data directory. Browser profiles live at
   * `<dataDir>/browser-profiles/<botId>/`. Ignored when
   * `browserProfileRoot` is set.
   */
  dataDir?: string;
  /**
   * W4: explicit browser-profile root (overrides the dataDir-derived
   * default `<dataDir>/browser-profiles`, or `data/browser-profiles`
   * under the process cwd when neither is given). Tests point this at a
   * temp dir.
   */
  browserProfileRoot?: string;
  /**
   * W4: audit hook fired after a profile wipe (host wires it to
   * governance). Receives the wipe result — metadata only, never any
   * profile content.
   */
  onProfileWipe?: (result: BrowserProfileWipeResult) => void;
  /**
   * §1.4 per-person browser hold registry. Defaults to the process-wide
   * `defaultBrowserHoldRegistry` (shared with the API hold/release
   * routes): while a person holds a bot's browser profile, every bot
   * browser action on it fails with BrowserHeldError.
   */
  browserHolds?: BrowserHoldRegistry;
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
  /**
   * W4: for browser-resolved instances, the bot's persistent profile
   * directory and its current on-disk size. Absent for other surfaces.
   */
  profileDir?: string;
  profileBytes?: number;
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
      // §1.4: a person's hold on this browser profile blocks bot actions.
      this.mgr.assertBrowserNotHeld(entry.botId);
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
  private readonly localLayerFor?: PerBotComputerManagerDeps['localLayerFor'];
  private readonly vpsLayerFor?: PerBotComputerManagerDeps['vpsLayerFor'];
  private readonly profileRoot: string;
  private readonly onProfileWipe?: PerBotComputerManagerDeps['onProfileWipe'];
  private readonly browserHolds: BrowserHoldRegistry;

  constructor(deps: PerBotComputerManagerDeps = {}) {
    this.idleTimeoutMs = deps.idleTimeoutMs ?? DEFAULT_COMPUTER_IDLE_TIMEOUT_MS;
    this.clock = deps.clock ?? Date.now;
    this.onRealAction = deps.onRealAction;
    this.createBackendOverride = deps.createBackend;
    this.localLayerFor = deps.localLayerFor;
    this.vpsLayerFor = deps.vpsLayerFor;
    this.onProfileWipe = deps.onProfileWipe;
    this.browserHolds = deps.browserHolds ?? defaultBrowserHoldRegistry;
    this.profileRoot =
      deps.browserProfileRoot ??
      (deps.dataDir
        ? path.join(deps.dataDir, 'browser-profiles')
        : path.resolve(process.cwd(), 'data', 'browser-profiles'));
  }

  /** §1.4: throw BrowserHeldError when a person holds this bot's browser profile. */
  assertBrowserNotHeld(botId: string): void {
    this.browserHolds.assertNotHeld(botId);
  }

  /** The hold registry in effect (the shared default unless injected). */
  browserHoldRegistry(): BrowserHoldRegistry {
    return this.browserHolds;
  }

  // ---- W4 browser profiles --------------------------------------------------

  /** Root directory holding every bot's browser profile. */
  browserProfileRoot(): string {
    return this.profileRoot;
  }

  /**
   * The persistent profile directory for one bot — the keying guarantee:
   * exactly one directory per bot id, shared by that bot's main and
   * conversation-pinned browser instances (same bot, same logins), and
   * never shared with another bot.
   */
  profileDirFor(botId: string): string {
    return browserProfileDirFor(this.profileRoot, botId);
  }

  /** Profile existence + disk usage for status surfaces. */
  profileInfo(botId: string): BrowserProfileInfo {
    const profileDir = this.profileDirFor(botId);
    const exists = fs.existsSync(profileDir);
    const { bytes, files } = exists ? profileDiskUsage(profileDir) : { bytes: 0, files: 0 };
    return { botId, profileDir, exists, bytes, files };
  }

  /**
   * W4 explicit wipe: close the bot's live computer instances (contexts
   * close, flushing nothing further) and DELETE the profile directory, so
   * the next browser launch starts from a fresh profile. This is the ONLY
   * operation that deletes a profile — bot deletion, surface changes,
   * restarts and idle teardown all keep it. Conversation pins and the
   * bot's surface choice are preserved (the bot still works on the same
   * surface, just logged out everywhere).
   */
  async wipeBrowserProfile(botId: string): Promise<BrowserProfileWipeResult> {
    const profileDir = this.profileDirFor(botId);
    const before = this.profileInfo(botId);
    const doomed = [...this.entries.values()].filter((e) => e.botId === botId);
    await Promise.all(doomed.map((e) => this.killEntry(e).catch(() => undefined)));
    let wiped = false;
    if (before.exists) {
      await fs.promises.rm(profileDir, { recursive: true, force: true });
      wiped = true;
    }
    const result: BrowserProfileWipeResult = {
      botId,
      profileDir,
      wiped,
      bytesFreed: wiped ? before.bytes : 0,
    };
    try {
      this.onProfileWipe?.(result);
    } catch {
      // Audit hooks must never break the wipe.
    }
    return result;
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
          : await this.defaultBackend(entry.resolved, entry.botId);
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

  private async defaultBackend(resolved: ResolvedComputerSurface, botId: string): Promise<OSScreenLayer> {
    const onRealAction = this.onRealAction;
    if (resolved === 'vps') {
      if (!this.vpsLayerFor) {
        throw new VpsNotConfiguredError(botId);
      }
      // The layer itself connects lazily (first tool use), so this stays fast.
      return this.vpsLayerFor(botId);
    }
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
      // W4: persistent context keyed by bot id — this bot's cookies and
      // logins live in its own profile directory and survive restarts.
      return new PlaywrightOSScreenLayer({
        profileDir: this.profileDirFor(botId),
        ...(onRealAction ? { onRealAction: (a, d) => onRealAction(a, d) } : {}),
      });
    }
    // ADD-5: the host's setup-aware local layer wins when provided.
    if (this.localLayerFor) return this.localLayerFor(botId);
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

  /**
   * Tear down every instance for a bot (bot deleted / surface changed /
   * restart). Best-effort. W4: closes browser contexts but deliberately
   * KEEPS the bot's browser profile on disk — persistence is the point;
   * only wipeBrowserProfile() deletes it.
   */
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

  private statusOf(e: Entry, at: number): ComputerInstanceStatus {
    const base: ComputerInstanceStatus = {
      botId: e.botId,
      key: e.key,
      pinned: e.pinned,
      conversationId: e.conversationId,
      surface: e.configured,
      resolved: e.resolved,
      running: e.running,
      lastUsedMs: e.lastUsedMs,
      idleMs: Math.max(0, at - e.lastUsedMs),
    };
    if (e.resolved === 'browser') {
      base.profileDir = this.profileDirFor(e.botId);
      base.profileBytes = this.profileInfo(e.botId).bytes;
    }
    return base;
  }

  status(botId: string): ComputerInstanceStatus[] {
    const at = this.now();
    return [...this.entries.values()]
      .filter((e) => e.botId === botId)
      .map((e) => this.statusOf(e, at));
  }

  statusAll(): ComputerInstanceStatus[] {
    const at = this.now();
    return [...this.entries.values()].map((e) => this.statusOf(e, at));
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
export {
  createEphemeralPageBackend,
  createPersistentPageBackend,
  lazyPlaywrightPageFactory,
  loadPlaywrightChromium,
  wrapPlaywrightPage,
} from './computer-playwright.js';
export type {
  PlaywrightChromiumLike,
  PlaywrightPageBackend,
  PlaywrightRawBrowser,
  PlaywrightRawContext,
  PlaywrightRawPage,
} from './computer-playwright.js';
