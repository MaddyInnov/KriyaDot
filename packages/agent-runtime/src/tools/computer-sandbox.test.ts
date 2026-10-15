// SPDX-License-Identifier: Apache-2.0
// Tests for the pluggable computer-use sandbox backends.
// Zero paid APIs, zero network, zero Docker: the container runner, the CDP
// transport, and the target lister are all injected fakes.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  COMPUTER_DOCKER_HEIGHT_ENV,
  COMPUTER_DOCKER_IMAGE_ENV,
  COMPUTER_DOCKER_WIDTH_ENV,
  COMPUTER_USE_DOCKER_ENV,
  DEFAULT_DOCKER_CDP_PORT,
  DEFAULT_DOCKER_HEIGHT,
  DEFAULT_DOCKER_IMAGE,
  DEFAULT_DOCKER_WIDTH,
  DockerComputerSandbox,
  LocalComputerSandbox,
  WebSocketCdpConnection,
  parsePngDimensions,
  selectComputerSandbox,
} from './computer-sandbox.js';
import type {
  CdpConnection,
  CdpTarget,
  CdpWebSocketLike,
  DockerRunner,
} from './computer-sandbox.js';
import { createComputerUseTools, computerUsePolicyRules } from './computer.js';

/** Real 1×1 transparent PNG bytes (same fixture shape as computer.ts). */
const FIXTURE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** Minimal PNG with chosen dimensions (signature + IHDR; CRC not needed by the parser). */
function pngWithDims(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0, 0, 0, 13], 8); // IHDR length
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

class FakeRunner implements DockerRunner {
  startedArgs: string[] | null = null;
  stopped: string[] = [];
  failCheck = false;

  async checkAvailable(): Promise<void> {
    if (this.failCheck) throw new Error('docker unavailable (fake)');
  }
  async start(args: string[]): Promise<string> {
    this.startedArgs = args;
    return 'fake-container-id';
  }
  async hostPort(): Promise<number> {
    return 19922;
  }
  async stop(containerId: string): Promise<void> {
    this.stopped.push(containerId);
  }
}

class FakeCdp implements CdpConnection {
  sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  closed = false;
  screenshotBase64 = FIXTURE_PNG_BASE64;

  async send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.sent.push({ method, params });
    if (method === 'Page.captureScreenshot') {
      return { data: this.screenshotBase64 } as unknown as T;
    }
    return {} as T;
  }
  async close(): Promise<void> {
    this.closed = true;
  }

  methods(): string[] {
    return this.sent.map((s) => s.method);
  }
}

const FAKE_TARGETS: CdpTarget[] = [
  { type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:19922/devtools/page/1' },
];

function fakeListTargets(targets: CdpTarget[] = FAKE_TARGETS) {
  return async (): Promise<CdpTarget[]> => targets;
}

class FakeSocket implements CdpWebSocketLike {
  sent: string[] = [];
  closed = false;
  private readonly listeners = new Map<string, Array<(ev: { data?: unknown }) => void>>();

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  addEventListener(
    type: 'message' | 'error' | 'close' | 'open',
    listener: (ev: { data?: unknown }) => void,
  ): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  removeEventListener(
    type: 'message' | 'error' | 'close' | 'open',
    listener: (ev: { data?: unknown }) => void,
  ): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((l) => l !== listener),
    );
  }
  emit(type: 'message' | 'error' | 'close' | 'open', ev: { data?: unknown } = {}): void {
    for (const l of this.listeners.get(type) ?? []) l(ev);
  }
}

const ENV = process.env as Record<string, string | undefined>;
const MANAGED_ENV = [
  COMPUTER_USE_DOCKER_ENV,
  COMPUTER_DOCKER_IMAGE_ENV,
  COMPUTER_DOCKER_WIDTH_ENV,
  COMPUTER_DOCKER_HEIGHT_ENV,
  'COMPUTER_USE_REAL',
];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const k of MANAGED_ENV) {
    savedEnv[k] = ENV[k];
    delete ENV[k];
  }
});

afterEach(() => {
  for (const k of MANAGED_ENV) {
    if (savedEnv[k] === undefined) delete ENV[k];
    else ENV[k] = savedEnv[k];
  }
});

function dockerSandbox(
  runner: FakeRunner,
  cdp: FakeCdp,
  extra: Record<string, unknown> = {},
): DockerComputerSandbox {
  const events: Array<{ action: string; detail: Record<string, unknown> }> = [];
  const sbx = new DockerComputerSandbox({
    runner,
    listTargets: fakeListTargets(),
    connectCdp: async () => cdp,
    onEvent: (action, detail) => events.push({ action, detail }),
    ...extra,
  });
  (sbx as unknown as { events: typeof events }).events = events;
  return sbx;
}

function sandboxEvents(sbx: DockerComputerSandbox): Array<{ action: string }> {
  return (sbx as unknown as { events: Array<{ action: string }> }).events;
}

describe('LocalComputerSandbox (default backend)', () => {
  it('delegates to the mock layer by default', async () => {
    const sbx = new LocalComputerSandbox();
    expect(sbx.backend).toBe('local');
    await sbx.launch(); // no-op
    expect(await sbx.displaySize()).toEqual({ width: 1920, height: 1080 });
    const shot = await sbx.screenshot();
    expect(shot.png.length).toBeGreaterThan(0);
    expect(parsePngDimensions(shot.png)).toEqual({ width: 1, height: 1 });
    await sbx.click(10, 20);
    await sbx.type('hello');
    await sbx.key('Enter');
    await sbx.kill(); // no-op
  });

  it('plugs into createComputerUseTools as the os layer', async () => {
    const sbx = new LocalComputerSandbox();
    const tools = createComputerUseTools({ os: sbx });
    expect(tools.map((t) => t.name).sort()).toEqual([
      'computer_click',
      'computer_key',
      'computer_open_app',
      'computer_screenshot',
      'computer_type',
    ]);
    const shot = tools.find((t) => t.name === 'computer_screenshot')!;
    const result = (await shot.handler({}, {} as never)) as { pngBase64: string };
    expect(typeof result.pngBase64).toBe('string');
    expect(result.pngBase64.length).toBeGreaterThan(0);
  });

  it('mutating actions stay approval-gated regardless of backend', () => {
    const rules = computerUsePolicyRules();
    const clickRule = rules.find((r) => r.toolPattern === '^computer_(click|type|key|open_app)$');
    expect(clickRule?.effect).toBe('require-approval');
  });
});

describe('selectComputerSandbox', () => {
  it('returns the local backend by default (COMPUTER_USE_REAL path untouched)', () => {
    const sbx = selectComputerSandbox();
    expect(sbx).toBeInstanceOf(LocalComputerSandbox);
    expect(sbx.backend).toBe('local');
  });

  it('returns the docker backend when COMPUTER_USE_DOCKER=1', () => {
    ENV[COMPUTER_USE_DOCKER_ENV] = '1';
    const sbx = selectComputerSandbox();
    expect(sbx).toBeInstanceOf(DockerComputerSandbox);
    expect(sbx.backend).toBe('docker');
    const docker = sbx as DockerComputerSandbox;
    expect(docker.image).toBe(DEFAULT_DOCKER_IMAGE);
    expect(docker.width).toBe(DEFAULT_DOCKER_WIDTH);
    expect(docker.height).toBe(DEFAULT_DOCKER_HEIGHT);
    expect(docker.cdpPort).toBe(DEFAULT_DOCKER_CDP_PORT);
  });

  it('honors image/geometry env overrides', () => {
    ENV[COMPUTER_USE_DOCKER_ENV] = '1';
    ENV[COMPUTER_DOCKER_IMAGE_ENV] = 'custom/chrome:test';
    ENV[COMPUTER_DOCKER_WIDTH_ENV] = '1600';
    ENV[COMPUTER_DOCKER_HEIGHT_ENV] = '900';
    const sbx = selectComputerSandbox() as DockerComputerSandbox;
    expect(sbx.image).toBe('custom/chrome:test');
    expect(sbx.width).toBe(1600);
    expect(sbx.height).toBe(900);
  });

  it('ignores invalid geometry env values', () => {
    ENV[COMPUTER_USE_DOCKER_ENV] = '1';
    ENV[COMPUTER_DOCKER_WIDTH_ENV] = 'banana';
    const sbx = selectComputerSandbox() as DockerComputerSandbox;
    expect(sbx.width).toBe(DEFAULT_DOCKER_WIDTH);
  });
});

describe('DockerComputerSandbox', () => {
  it('launch starts the container, maps the CDP port, and enables the page', async () => {
    const runner = new FakeRunner();
    const cdp = new FakeCdp();
    let connectedUrl = '';
    const sbx = new DockerComputerSandbox({
      runner,
      listTargets: fakeListTargets(),
      connectCdp: async (url: string) => {
        connectedUrl = url;
        return cdp;
      },
    });
    await sbx.launch();

    expect(runner.startedArgs).not.toBeNull();
    const args = runner.startedArgs!;
    expect(args[0]).toBe('run');
    expect(args).toContain(DEFAULT_DOCKER_IMAGE);
    expect(args).toContain('--headless=new');
    expect(args).toContain('--remote-debugging-port=9222');
    expect(args).toContain('--window-size=1280,720');
    expect(args).toContain('about:blank');
    // Debugger port published on loopback only.
    const pIdx = args.indexOf('-p');
    expect(args[pIdx + 1]).toMatch(/^127\.0\.0\.1::9222$/);

    expect(connectedUrl).toBe('ws://127.0.0.1:19922/devtools/page/1');
    expect(cdp.methods()).toContain('Page.enable');
    const emu = cdp.sent.find((s) => s.method === 'Emulation.setDeviceMetricsOverride')!;
    expect(emu.params).toMatchObject({ width: 1280, height: 720, deviceScaleFactor: 1 });

    // Idempotent: second launch does not start another container.
    await sbx.launch();
    expect(runner.stopped).toEqual([]);
    await sbx.kill();
  });

  it('launch fails closed with a helpful error when Docker is unavailable', async () => {
    const runner = new FakeRunner();
    runner.failCheck = true;
    const cdp = new FakeCdp();
    const sbx = dockerSandbox(runner, cdp);
    await expect(sbx.launch()).rejects.toThrow('docker unavailable (fake)');
    expect(runner.startedArgs).toBeNull();
  });

  it('launch tears the container down when no page target appears', async () => {
    const runner = new FakeRunner();
    const cdp = new FakeCdp();
    const sbx = dockerSandbox(runner, cdp, {
      listTargets: fakeListTargets([]),
      targetTimeoutMs: 10,
    });
    await expect(sbx.launch()).rejects.toThrow(/timed out.*waiting for a debuggable page target/i);
    expect(runner.stopped).toEqual(['fake-container-id']);
    expect(cdp.closed).toBe(false); // never connected
  });

  it('screenshot decodes the CDP PNG and reports real dimensions', async () => {
    const runner = new FakeRunner();
    const cdp = new FakeCdp();
    cdp.screenshotBase64 = Buffer.from(pngWithDims(320, 200)).toString('base64');
    const sbx = dockerSandbox(runner, cdp);
    await sbx.launch();
    const shot = await sbx.screenshot();
    expect(shot.width).toBe(320);
    expect(shot.height).toBe(200);
    expect(shot.png[0]).toBe(0x89);
    const sent = cdp.sent.find((s) => s.method === 'Page.captureScreenshot')!;
    expect(sent.params).toMatchObject({ format: 'png' });
    await sbx.kill();
  });

  it('click dispatches press+release and fires the audit event', async () => {
    const runner = new FakeRunner();
    const cdp = new FakeCdp();
    const sbx = dockerSandbox(runner, cdp);
    await sbx.launch();
    await sbx.click(100.7, 200.2);
    const clicks = cdp.sent.filter((s) => s.method === 'Input.dispatchMouseEvent');
    expect(clicks).toHaveLength(2);
    expect(clicks[0].params).toMatchObject({ type: 'mousePressed', x: 100, y: 200, button: 'left', clickCount: 1 });
    expect(clicks[1].params).toMatchObject({ type: 'mouseReleased', x: 100, y: 200, button: 'left', clickCount: 1 });
    expect(sandboxEvents(sbx).map((e) => e.action)).toContain('click');
    await sbx.kill();
  });

  it('type uses Input.insertText and fires the audit event', async () => {
    const runner = new FakeRunner();
    const cdp = new FakeCdp();
    const sbx = dockerSandbox(runner, cdp);
    await sbx.launch();
    await sbx.type('hello world');
    const sent = cdp.sent.find((s) => s.method === 'Input.insertText')!;
    expect(sent.params).toEqual({ text: 'hello world' });
    expect(sandboxEvents(sbx).map((e) => e.action)).toContain('type');
    await sbx.kill();
  });

  it('key maps allowlist names to CDP key events (rawKeyDown + keyUp)', async () => {
    const runner = new FakeRunner();
    const cdp = new FakeCdp();
    const sbx = dockerSandbox(runner, cdp);
    await sbx.launch();
    await sbx.key('Enter');
    await sbx.key('ArrowUp');
    const keys = cdp.sent.filter((s) => s.method === 'Input.dispatchKeyEvent');
    expect(keys).toHaveLength(4);
    expect(keys[0].params).toMatchObject({ type: 'rawKeyDown', key: 'Enter', windowsVirtualKeyCode: 13 });
    expect(keys[1].params).toMatchObject({ type: 'keyUp', key: 'Enter', windowsVirtualKeyCode: 13 });
    expect(keys[2].params).toMatchObject({ type: 'rawKeyDown', key: 'ArrowUp', windowsVirtualKeyCode: 38 });
    expect(sandboxEvents(sbx).map((e) => e.action)).toContain('key');
    await sbx.kill();
  });

  it('key rejects names outside the CDP map (defense in depth)', async () => {
    const runner = new FakeRunner();
    const cdp = new FakeCdp();
    const sbx = dockerSandbox(runner, cdp);
    await sbx.launch();
    await expect(sbx.key('F13')).rejects.toThrow('no CDP key mapping');
    await sbx.kill();
  });

  it('I/O before launch throws a clear error', async () => {
    const sbx = dockerSandbox(new FakeRunner(), new FakeCdp());
    await expect(sbx.screenshot()).rejects.toThrow('not launched');
    await expect(sbx.click(1, 2)).rejects.toThrow('not launched');
    await expect(sbx.type('x')).rejects.toThrow('not launched');
    await expect(sbx.key('Enter')).rejects.toThrow('not launched');
  });

  it('kill is idempotent and best-effort', async () => {
    const runner = new FakeRunner();
    const cdp = new FakeCdp();
    const sbx = dockerSandbox(runner, cdp);
    await sbx.launch();
    await sbx.kill();
    await sbx.kill();
    expect(cdp.closed).toBe(true);
    expect(runner.stopped).toEqual(['fake-container-id']);
    expect(sandboxEvents(sbx).filter((e) => e.action === 'kill')).toHaveLength(1);
    // After kill the sandbox must be launched again before use.
    await expect(sbx.screenshot()).rejects.toThrow('not launched');
  });

  it('displaySize reports the configured viewport', async () => {
    const sbx = dockerSandbox(new FakeRunner(), new FakeCdp(), { width: 1600, height: 900 });
    expect(await sbx.displaySize()).toEqual({ width: 1600, height: 900 });
  });
});

describe('parsePngDimensions', () => {
  it('reads IHDR width/height', () => {
    expect(parsePngDimensions(pngWithDims(1920, 1080))).toEqual({ width: 1920, height: 1080 });
    expect(parsePngDimensions(Buffer.from(FIXTURE_PNG_BASE64, 'base64'))).toEqual({ width: 1, height: 1 });
  });

  it('returns null for non-PNG input', () => {
    expect(parsePngDimensions(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(parsePngDimensions(new Uint8Array(100))).toBeNull();
  });
});

describe('WebSocketCdpConnection', () => {
  it('connects on open and routes request/response by id', async () => {
    const socket = new FakeSocket();
    const conn = new WebSocketCdpConnection({ createSocket: () => socket });
    const connected = conn.connect('ws://fake');
    socket.emit('open');
    await connected;

    const pending = conn.send('Page.enable', { foo: 1 });
    expect(socket.sent).toHaveLength(1);
    const msg = JSON.parse(socket.sent[0]) as { id: number; method: string; params: object };
    expect(msg.method).toBe('Page.enable');
    expect(msg.params).toEqual({ foo: 1 });

    socket.emit('message', { data: JSON.stringify({ id: msg.id, result: { ok: true } }) });
    await expect(pending).resolves.toEqual({ ok: true });
    await conn.close();
  });

  it('rejects on CDP error results and ignores unsolicited events', async () => {
    const socket = new FakeSocket();
    const conn = new WebSocketCdpConnection({ createSocket: () => socket });
    const connected = conn.connect('ws://fake');
    socket.emit('open');
    await connected;

    const pending = conn.send('Page.captureScreenshot');
    const msg = JSON.parse(socket.sent[0]) as { id: number };
    socket.emit('message', { data: JSON.stringify({ method: 'Page.loadEventFired', params: {} }) }); // no id
    socket.emit('message', { data: JSON.stringify({ id: msg.id, error: { message: 'boom' } }) });
    await expect(pending).rejects.toThrow('CDP error: boom');
    await conn.close();
  });

  it('times out when no reply arrives', async () => {
    const socket = new FakeSocket();
    const conn = new WebSocketCdpConnection({ createSocket: () => socket, timeoutMs: 20 });
    const connected = conn.connect('ws://fake');
    socket.emit('open');
    await connected;
    await expect(conn.send('Page.enable')).rejects.toThrow('timed out');
    await conn.close();
  });

  it('connect rejects when the socket errors before open', async () => {
    const socket = new FakeSocket();
    const conn = new WebSocketCdpConnection({ createSocket: () => socket });
    const connected = conn.connect('ws://fake');
    socket.emit('error');
    await expect(connected).rejects.toThrow('CDP websocket error');
  });

  it('close fails pending sends', async () => {
    const socket = new FakeSocket();
    const conn = new WebSocketCdpConnection({ createSocket: () => socket });
    const connected = conn.connect('ws://fake');
    socket.emit('open');
    await connected;
    const pending = conn.send('Page.enable');
    await conn.close();
    await expect(pending).rejects.toThrow('closed');
    expect(socket.closed).toBe(true);
  });
});
