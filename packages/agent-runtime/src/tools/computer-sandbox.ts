// SPDX-License-Identifier: Apache-2.0
// Pluggable computer-use sandbox backends (OpenAI Dots parity: Docker/Playwright-style isolation).
//
// The computer-use tools (computer.ts) drive an OSScreenLayer. This module
// adds a LIFECYCLE around that layer — launch/kill — so the automation target
// can be an isolated sandbox instead of the local machine:
//
//   ComputerSandbox (interface)
//     ├── LocalComputerSandbox   — DEFAULT. Wraps selectOSLayer(): the mock
//     │                            unless COMPUTER_USE_REAL=1 (unchanged path).
//     │                            launch()/kill() are no-ops: there is no
//     │                            container to manage.
//     └── DockerComputerSandbox  — Runs headless Chrome with remote debugging
//                                  inside a Docker container and drives it over
//                                  the Chrome DevTools Protocol (CDP).
//                                  Opt in with COMPUTER_USE_DOCKER=1.
//                                  See packages/agent-runtime/DOCKER.md.
//
// A ComputerSandbox IS an OSScreenLayer, so it plugs straight into
// createComputerUseTools()/registerComputerUseTool() as the `os` option:
//
//   const sandbox = selectComputerSandbox({ onRealAction });
//   await sandbox.launch();                    // no-op for local, starts container for docker
//   registerComputerUseTool(registry, { os: sandbox });
//   ...
//   await sandbox.kill();                      // no-op for local, stops container for docker
//
// Trust model (never weakened):
//   - Approval gating is orthogonal to the backend: computerUsePolicyRules()
//     still marks click/type/key require-approval and the runtime evaluates
//     policy BEFORE the handler runs, whichever sandbox is active.
//   - The Docker backend exposes the container's debugger port on 127.0.0.1
//     only (never 0.0.0.0), runs Chrome --no-sandbox INSIDE the container
//     (the container is the sandbox), and applies memory/CPU limits.
//   - Native/docker CLIs are only invoked by explicit backend selection;
//     merely importing this module never touches Docker.

import { execFile, spawnSync } from 'node:child_process';
import { selectOSLayer } from './computer-real.js';
import type { RealOSLayerDeps } from './computer-real.js';
import type { DisplaySize, OSScreenLayer, Screenshot } from './computer.js';

/** Env var that opts into the Docker-backed computer sandbox. */
export const COMPUTER_USE_DOCKER_ENV = 'COMPUTER_USE_DOCKER';
/** Env var overriding the Docker image used for the computer sandbox. */
export const COMPUTER_DOCKER_IMAGE_ENV = 'COMPUTER_DOCKER_IMAGE';
/** Env vars overriding the sandboxed viewport geometry. */
export const COMPUTER_DOCKER_WIDTH_ENV = 'COMPUTER_DOCKER_WIDTH';
export const COMPUTER_DOCKER_HEIGHT_ENV = 'COMPUTER_DOCKER_HEIGHT';

/** Which sandbox backend a ComputerSandbox runs on (for status endpoints). */
export type ComputerSandboxBackend = 'local' | 'docker';

/**
 * A computer-use sandbox: an OSScreenLayer with an explicit lifecycle.
 * launch() prepares the target (no-op for local), kill() tears it down
 * (no-op for local, stops the container for docker). All OSScreenLayer
 * methods throw a clear error if called before a successful launch().
 */
export interface ComputerSandbox extends OSScreenLayer {
  readonly backend: ComputerSandboxBackend;
  /** Prepare the sandbox target. Idempotent. */
  launch(): Promise<void>;
  /** Tear the sandbox target down. Idempotent; best-effort, never throws. */
  kill(): Promise<void>;
}

/**
 * Local sandbox — the DEFAULT. Delegates to selectOSLayer(), i.e. the mock
 * layer unless COMPUTER_USE_REAL=1 selects the real foreground layer. The
 * COMPUTER_USE_REAL=1 path is unchanged: construction stays side-effect
 * free and native modules still load lazily on first real action.
 */
export class LocalComputerSandbox implements ComputerSandbox {
  readonly backend: ComputerSandboxBackend = 'local';
  private readonly inner: OSScreenLayer;

  constructor(deps: RealOSLayerDeps = {}) {
    this.inner = selectOSLayer(deps);
  }

  async launch(): Promise<void> {
    // Nothing to start: the local layer is always available.
  }

  async kill(): Promise<void> {
    // Nothing to stop.
  }

  displaySize(): Promise<DisplaySize> {
    return this.inner.displaySize();
  }

  screenshot(): Promise<Screenshot> {
    return this.inner.screenshot();
  }

  click(x: number, y: number): Promise<void> {
    return this.inner.click(x, y);
  }

  type(text: string): Promise<void> {
    return this.inner.type(text);
  }

  key(name: string): Promise<void> {
    return this.inner.key(name);
  }
}

// ---------------------------------------------------------------------------
// Docker backend
// ---------------------------------------------------------------------------

/** Default image: small Alpine-based headless Chrome with a known remote-debugging recipe. */
export const DEFAULT_DOCKER_IMAGE = 'zenika/alpine-chrome:latest';
/** Container-side CDP port. */
export const DEFAULT_DOCKER_CDP_PORT = 9222;
export const DEFAULT_DOCKER_WIDTH = 1280;
export const DEFAULT_DOCKER_HEIGHT = 720;

/** Minimal docker-CLI runner. Injectable so tests never touch Docker. */
export interface DockerRunner {
  /** Throw a helpful error when the docker CLI/daemon is unavailable. */
  checkAvailable(): Promise<void>;
  /** `docker run -d …`; resolves with the container id. */
  start(args: string[]): Promise<string>;
  /** Host port mapped to containerPort (we always publish on 127.0.0.1). */
  hostPort(containerId: string, containerPort: number): Promise<number>;
  /** `docker stop` + remove fallback. Best-effort. */
  stop(containerId: string): Promise<void>;
}

/** docker-CLI implementation of DockerRunner. */
export class CliDockerRunner implements DockerRunner {
  async checkAvailable(): Promise<void> {
    let res;
    try {
      res = spawnSync('docker', ['info', '--format', '{{json .ServerVersion}}'], {
        timeout: 8_000,
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch (err) {
      throw new Error(
        `Docker is not available: ${err instanceof Error ? err.message : String(err)}. ` +
          'Install Docker Desktop (or the engine) and retry — see packages/agent-runtime/DOCKER.md.',
      );
    }
    if (res.error || res.status !== 0) {
      throw new Error(
        'Docker daemon is not reachable (`docker info` failed). ' +
          'Start Docker Desktop (or dockerd) and retry — see packages/agent-runtime/DOCKER.md.',
      );
    }
  }

  start(args: string[]): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      execFile('docker', args, { timeout: 120_000, windowsHide: true }, (err, stdout) => {
        if (err) {
          reject(
            new Error(
              `docker run failed: ${err instanceof Error ? err.message : String(err)}. ` +
                'See packages/agent-runtime/DOCKER.md for the image/setup requirements.',
            ),
          );
          return;
        }
        const id = String(stdout ?? '').trim();
        if (!id) {
          reject(new Error('docker run produced no container id.'));
          return;
        }
        resolve(id);
      });
    });
  }

  hostPort(containerId: string, containerPort: number): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      execFile(
        'docker',
        ['port', containerId, `${containerPort}/tcp`],
        { timeout: 15_000, windowsHide: true },
        (err, stdout) => {
          if (err) {
            reject(
              new Error(
                `docker port failed for ${containerId}: ${err instanceof Error ? err.message : String(err)}`,
              ),
            );
            return;
          }
          // Output looks like "127.0.0.1:32768" (one line per binding).
          const m = String(stdout ?? '').match(/:(\d+)\s*$/m);
          const port = m ? Number(m[1]) : NaN;
          if (!Number.isInteger(port) || port <= 0) {
            reject(new Error(`could not parse mapped host port from "docker port" output`));
            return;
          }
          resolve(port);
        },
      );
    });
  }

  async stop(containerId: string): Promise<void> {
    await new Promise<void>((resolve) => {
      execFile('docker', ['stop', '--time', '5', containerId], { timeout: 30_000, windowsHide: true }, () => {
        // Best-effort: the container is --rm, so stop is enough; never reject.
        resolve();
      });
    });
  }
}

/** One entry from the Chrome /json/list debugger endpoint. */
export interface CdpTarget {
  type: string;
  webSocketDebuggerUrl: string;
}

/** List debuggable targets. Default uses fetch against http://host:port/json/list. */
export type ListCdpTargets = (baseUrl: string) => Promise<CdpTarget[]>;

async function defaultListCdpTargets(baseUrl: string): Promise<CdpTarget[]> {
  const res = await fetch(`${baseUrl}/json/list`);
  if (!res.ok) throw new Error(`CDP /json/list failed with HTTP ${res.status}`);
  return (await res.json()) as CdpTarget[];
}

/** Minimal CDP connection: JSON-RPC request/response over a WebSocket. */
export interface CdpConnection {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
}

/** Narrow WebSocket surface the CDP client needs (keeps it unit-testable). */
export interface CdpWebSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(
    type: 'message' | 'error' | 'close' | 'open',
    listener: (ev: { data?: unknown }) => void,
  ): void;
  removeEventListener(
    type: 'message' | 'error' | 'close' | 'open',
    listener: (ev: { data?: unknown }) => void,
  ): void;
}

/**
 * CDP client over any WebSocket-like transport. Pending requests are matched
 * by id; unsolicited events (no id) are ignored. A send that gets no reply
 * within timeoutMs rejects.
 */
export class WebSocketCdpConnection implements CdpConnection {
  private readonly createSocket: (url: string) => CdpWebSocketLike;
  private readonly timeoutMs: number;
  private ws: CdpWebSocketLike | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(opts: { createSocket?: (url: string) => CdpWebSocketLike; timeoutMs?: number } = {}) {
    this.createSocket =
      opts.createSocket ??
      ((url: string) => new WebSocket(url) as unknown as CdpWebSocketLike);
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  async connect(url: string): Promise<void> {
    if (this.ws) return;
    const ws = this.createSocket(url);
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error(`CDP websocket error connecting to ${url}`));
      };
      const onClose = () => {
        cleanup();
        reject(new Error(`CDP websocket closed before connecting to ${url}`));
      };
      const cleanup = () => {
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('error', onError);
        ws.removeEventListener('close', onClose);
      };
      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onError);
      ws.addEventListener('close', onClose);
    });
    this.ws = ws;
    ws.addEventListener('message', (ev) => this.onMessage(ev));
    ws.addEventListener('close', () => this.failAllPending(new Error('CDP websocket closed')));
    ws.addEventListener('error', () => this.failAllPending(new Error('CDP websocket error')));
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const ws = this.ws;
    if (!ws) return Promise.reject(new Error('CDP connection is not open'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
      });
      try {
        ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async close(): Promise<void> {
    this.failAllPending(new Error('CDP connection closed'));
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      // best-effort
    }
  }

  private onMessage(ev: { data?: unknown }): void {
    if (typeof ev.data !== 'string') return;
    let msg: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(ev.data) as typeof msg;
    } catch {
      return;
    }
    if (typeof msg.id !== 'number') return; // unsolicited event — ignore
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error) {
      entry.reject(new Error(`CDP error: ${msg.error.message ?? 'unknown'}`));
    } else {
      entry.resolve(msg.result);
    }
  }

  private failAllPending(err: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }
}

/** CDP key description for one of our COMPUTER_KEY_ALLOWLIST names. */
interface CdpKeyDef {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  /** Printable text to include (Space only). */
  text?: string;
}

/** Our key allowlist → CDP Input.dispatchKeyEvent parameters. */
const CDP_KEY_MAP: Record<string, CdpKeyDef> = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
};

export interface DockerComputerSandboxOptions {
  /** Docker image with headless Chrome. Default: zenika/alpine-chrome:latest. */
  image?: string;
  /** Sandboxed viewport geometry (passed as --window-size + emulation). */
  width?: number;
  height?: number;
  /** Container-side CDP port (published on 127.0.0.1 with a random host port). */
  cdpPort?: number;
  /** Extra flags appended to the chrome command line. */
  chromeArgs?: string[];
  /** How long to wait for a debuggable page target after container start. */
  targetTimeoutMs?: number;
  /** Injectable seams (tests / custom transports). */
  runner?: DockerRunner;
  listTargets?: ListCdpTargets;
  connectCdp?: (url: string) => Promise<CdpConnection>;
  /**
   * Audit hook: called AFTER every mutating container action (click/type/key)
   * and on launch/kill. The host wires this to the governance audit trail —
   * same role as RealOSLayerDeps.onRealAction for the local backend.
   */
  onEvent?: (action: 'launch' | 'kill' | 'click' | 'type' | 'key', detail: Record<string, unknown>) => void;
}

/**
 * Docker-backed computer sandbox: runs headless Chrome in a container and
 * drives it over CDP. Full isolation of the automation target from the host
 * machine — the Dots-style backend.
 *
 * Constructing is cheap and side-effect free; `launch()` starts the
 * container, `kill()` stops it. All I/O methods require launch() first.
 */
export class DockerComputerSandbox implements ComputerSandbox {
  readonly backend: ComputerSandboxBackend = 'docker';
  readonly image: string;
  readonly width: number;
  readonly height: number;
  readonly cdpPort: number;

  private readonly chromeArgs: string[];
  private readonly targetTimeoutMs: number;
  private readonly runner: DockerRunner;
  private readonly listTargets: ListCdpTargets;
  private readonly connectCdp: (url: string) => Promise<CdpConnection>;
  private readonly onEvent?: DockerComputerSandboxOptions['onEvent'];

  private containerId: string | null = null;
  private cdp: CdpConnection | null = null;
  private launched = false;

  constructor(opts: DockerComputerSandboxOptions = {}) {
    this.image = opts.image?.trim() || DEFAULT_DOCKER_IMAGE;
    this.width = positiveIntOr(opts.width, DEFAULT_DOCKER_WIDTH);
    this.height = positiveIntOr(opts.height, DEFAULT_DOCKER_HEIGHT);
    this.cdpPort = positiveIntOr(opts.cdpPort, DEFAULT_DOCKER_CDP_PORT);
    this.targetTimeoutMs = positiveIntOr(opts.targetTimeoutMs, 30_000);
    this.chromeArgs = opts.chromeArgs ?? [
      '--headless=new',
      '--no-sandbox', // sandboxed by the container itself, not by chrome
      '--disable-gpu',
      '--remote-debugging-address=0.0.0.0',
      `--remote-debugging-port=${this.cdpPort}`,
      `--window-size=${this.width},${this.height}`,
    ];
    this.runner = opts.runner ?? new CliDockerRunner();
    this.listTargets = opts.listTargets ?? defaultListCdpTargets;
    this.connectCdp =
      opts.connectCdp ??
      (async (url: string) => {
        const conn = new WebSocketCdpConnection();
        await conn.connect(url);
        return conn;
      });
    this.onEvent = opts.onEvent;
  }

  async launch(): Promise<void> {
    if (this.launched) return;
    await this.runner.checkAvailable();
    const name = `kriyadot-computer-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffff).toString(16)}`;
    const args = [
      'run',
      '-d',
      '--rm',
      '--name',
      name,
      // Debugger port on loopback only — never exposed to the LAN.
      '-p',
      `127.0.0.1::${this.cdpPort}`,
      '--shm-size',
      '512m',
      '--memory',
      '2g',
      '--cpus',
      '2',
      this.image,
      ...this.chromeArgs,
      'about:blank',
    ];
    this.containerId = await this.runner.start(args);
    try {
      const hostPort = await this.runner.hostPort(this.containerId, this.cdpPort);
      const page = await this.waitForPageTarget(`http://127.0.0.1:${hostPort}`);
      this.cdp = await this.connectCdp(page.webSocketDebuggerUrl);
      await this.cdp.send('Page.enable');
      await this.cdp.send('Emulation.setDeviceMetricsOverride', {
        width: this.width,
        height: this.height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      this.launched = true;
      this.onEvent?.('launch', { containerId: this.containerId, hostPort, image: this.image });
    } catch (err) {
      await this.kill();
      throw err;
    }
  }

  async kill(): Promise<void> {
    const cdp = this.cdp;
    this.cdp = null;
    this.launched = false;
    if (cdp) {
      try {
        await cdp.close();
      } catch {
        // best-effort
      }
    }
    const id = this.containerId;
    this.containerId = null;
    if (id) {
      try {
        await this.runner.stop(id);
      } catch {
        // best-effort
      }
      this.onEvent?.('kill', { containerId: id });
    }
  }

  displaySize(): Promise<DisplaySize> {
    // Viewport is fixed by --window-size + device metrics override.
    return Promise.resolve({ width: this.width, height: this.height });
  }

  async screenshot(): Promise<Screenshot> {
    const cdp = this.requireCdp();
    const { data } = await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
    if (typeof data !== 'string' || data.length === 0) {
      throw new Error('CDP Page.captureScreenshot returned no image data');
    }
    const png = new Uint8Array(Buffer.from(data, 'base64'));
    const dims = parsePngDimensions(png);
    return { png, width: dims?.width ?? this.width, height: dims?.height ?? this.height };
  }

  async click(x: number, y: number): Promise<void> {
    const cdp = this.requireCdp();
    const px = Math.floor(x);
    const py = Math.floor(y);
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: px,
      y: py,
      button: 'left',
      clickCount: 1,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: px,
      y: py,
      button: 'left',
      clickCount: 1,
    });
    this.onEvent?.('click', { x: px, y: py });
  }

  async type(text: string): Promise<void> {
    const cdp = this.requireCdp();
    // Inserts into the focused editable element — callers click the field
    // first (same focus semantics as the local backend).
    await cdp.send('Input.insertText', { text });
    this.onEvent?.('type', { chars: text.length });
  }

  async key(name: string): Promise<void> {
    const cdp = this.requireCdp();
    const def = CDP_KEY_MAP[name];
    if (!def) throw new Error(`no CDP key mapping for "${name}"`);
    const down: Record<string, unknown> = {
      type: 'rawKeyDown',
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.windowsVirtualKeyCode,
    };
    if (def.text !== undefined) {
      down.text = def.text;
      down.unmodifiedText = def.text;
    }
    await cdp.send('Input.dispatchKeyEvent', down);
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.windowsVirtualKeyCode,
    });
    this.onEvent?.('key', { name });
  }

  private requireCdp(): CdpConnection {
    if (!this.launched || !this.cdp) {
      throw new Error('DockerComputerSandbox is not launched — call launch() first.');
    }
    return this.cdp;
  }

  private async waitForPageTarget(baseUrl: string): Promise<CdpTarget> {
    const deadline = Date.now() + this.targetTimeoutMs;
    for (;;) {
      let targets: CdpTarget[] = [];
      try {
        targets = await this.listTargets(baseUrl);
      } catch {
        // Chrome still starting — retry until the deadline.
      }
      const page = targets.find((t) => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string');
      if (page) return page;
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out after ${this.targetTimeoutMs}ms waiting for a debuggable page target at ${baseUrl}/json/list. ` +
            'The image may not run Chrome with remote debugging — see packages/agent-runtime/DOCKER.md.',
        );
      }
      await sleep(500);
    }
  }
}

function positiveIntOr(v: number | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Read width/height from a PNG's IHDR chunk. Returns null for non-PNG input.
 * (CDP screenshots are real PNGs; the mock fixture is too.)
 */
export function parsePngDimensions(png: Uint8Array): { width: number; height: number } | null {
  if (png.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < sig.length; i++) {
    if (png[i] !== sig[i]) return null;
  }
  // IHDR: length(4) | "IHDR"(4) | width(4 BE) | height(4 BE) | ...
  const tag = String.fromCharCode(png[12], png[13], png[14], png[15]);
  if (tag !== 'IHDR') return null;
  const width = (png[16] << 24) | (png[17] << 16) | (png[18] << 8) | png[19];
  const height = (png[20] << 24) | (png[21] << 16) | (png[22] << 8) | png[23];
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

/**
 * Select the computer sandbox backend from the environment:
 *   COMPUTER_USE_DOCKER=1 → DockerComputerSandbox (containerized Chrome over CDP)
 *   otherwise             → LocalComputerSandbox (mock, or the real foreground
 *                           layer when COMPUTER_USE_REAL=1 — unchanged path)
 *
 * When both flags are set, Docker wins: explicit sandbox isolation beats
 * foreground control. Viewport/image overrides come from
 * COMPUTER_DOCKER_IMAGE / COMPUTER_DOCKER_WIDTH / COMPUTER_DOCKER_HEIGHT.
 */
export function selectComputerSandbox(deps: RealOSLayerDeps = {}): ComputerSandbox {
  if (process.env[COMPUTER_USE_DOCKER_ENV] === '1') {
    return new DockerComputerSandbox({
      image: process.env[COMPUTER_DOCKER_IMAGE_ENV]?.trim() || undefined,
      width: parseEnvPositiveInt(process.env[COMPUTER_DOCKER_WIDTH_ENV]),
      height: parseEnvPositiveInt(process.env[COMPUTER_DOCKER_HEIGHT_ENV]),
      onEvent: deps.onRealAction
        ? (action, detail) => {
            // The local-backend audit hook only models input actions;
            // launch/kill lifecycle events are container bookkeeping.
            if (action === 'click' || action === 'type' || action === 'key') {
              deps.onRealAction?.(action, detail);
            }
          }
        : undefined,
    });
  }
  return new LocalComputerSandbox(deps);
}

function parseEnvPositiveInt(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}
