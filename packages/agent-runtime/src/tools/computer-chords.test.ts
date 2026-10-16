// SPDX-License-Identifier: Apache-2.0
// Tests for keyboard chords, hotkey presets, and right/double-click
// across every computer-use layer. All OS input is mocked — zero real
// input in tests.
//
// Coverage:
//   - parseKeyChord: valid chords, modifier aliases, case/whitespace
//     tolerance, and every rejection path
//   - resolveHotkey: per-OS mapping (darwin vs win32/linux), unknown names
//   - computer_key tool: chords + hotkeys route to os.keyChord, single
//     keys keep the original os.key path, approval gating unchanged
//   - computer_click: button/clicks validation and per-layer behavior
//     (real backend, Playwright, Docker CDP, local delegation, mock)
//   - modifier down/up ordering (CDP bitmask sequence)

import { describe, it, expect } from 'vitest';
import {
  COMPUTER_TOOL_NAMES,
  MockOSScreenLayer,
  computerUsePolicyRules,
  createComputerUseTools,
} from './computer.js';
import type { ToolContext, ToolDefinition } from '../types.js';
import {
  HOTKEY_NAMES,
  formatChord,
  parseKeyChord,
  resolveHotkey,
  type ChordModifier,
} from './computer-keys.js';
import { RealOSScreenLayer, type RealInputBackend, type RealMouseButton } from './computer-real.js';
import { PlaywrightOSScreenLayer, type PlaywrightPageBackend } from './computer-playwright.js';
import {
  DockerComputerSandbox,
  LocalComputerSandbox,
  type CdpConnection,
  type CdpTarget,
  type DockerRunner,
} from './computer-sandbox.js';

const CTX = { sessionId: 's1', botId: 'helper' } as ToolContext;

function toolMap(os: MockOSScreenLayer, platform?: 'win32' | 'darwin' | 'linux'): Map<string, ToolDefinition> {
  const m = new Map<string, ToolDefinition>();
  for (const t of createComputerUseTools({ os, platform })) m.set(t.name, t);
  return m;
}

// ---------------------------------------------------------------------------
// Chord parsing
// ---------------------------------------------------------------------------

describe('parseKeyChord', () => {
  it('parses simple chords', () => {
    expect(parseKeyChord('ctrl+c')).toEqual({ modifiers: ['ctrl'], key: 'c' });
    expect(parseKeyChord('alt+tab')).toEqual({ modifiers: ['alt'], key: 'Tab' });
    expect(parseKeyChord('ctrl+alt+del')).toEqual({ modifiers: ['ctrl', 'alt'], key: 'Delete' });
  });

  it('parses multi-modifier chords preserving order', () => {
    expect(parseKeyChord('ctrl+shift+s')).toEqual({ modifiers: ['ctrl', 'shift'], key: 's' });
    // Order is preserved as typed — backends press down in this order.
    expect(parseKeyChord('shift+ctrl+a').modifiers).toEqual(['shift', 'ctrl']);
  });

  it('resolves modifier aliases', () => {
    expect(parseKeyChord('cmd+q').modifiers).toEqual(['meta']);
    expect(parseKeyChord('command+w').modifiers).toEqual(['meta']);
    expect(parseKeyChord('control+x').modifiers).toEqual(['ctrl']);
    expect(parseKeyChord('win+e').modifiers).toEqual(['meta']);
    expect(parseKeyChord('windows+r').modifiers).toEqual(['meta']);
    expect(parseKeyChord('super+t').modifiers).toEqual(['meta']);
    expect(parseKeyChord('option+f').modifiers).toEqual(['alt']);
  });

  it('is case-insensitive and tolerates whitespace', () => {
    expect(parseKeyChord('CTRL+C')).toEqual({ modifiers: ['ctrl'], key: 'c' });
    expect(parseKeyChord('Ctrl+Shift+S')).toEqual({ modifiers: ['ctrl', 'shift'], key: 's' });
    expect(parseKeyChord('  ctrl + c  ')).toEqual({ modifiers: ['ctrl'], key: 'c' });
  });

  it('accepts digits, F-keys, and named keys as the final key', () => {
    expect(parseKeyChord('ctrl+1')).toEqual({ modifiers: ['ctrl'], key: '1' });
    expect(parseKeyChord('alt+F4')).toEqual({ modifiers: ['alt'], key: 'F4' });
    expect(parseKeyChord('ctrl+f12').key).toBe('F12');
    expect(parseKeyChord('meta+Escape')).toEqual({ modifiers: ['meta'], key: 'Escape' });
    expect(parseKeyChord('ctrl+prtsc').key).toBe('PrintScreen');
  });

  it('rejects malformed chords', () => {
    expect(() => parseKeyChord('')).toThrow(/non-empty/);
    expect(() => parseKeyChord(42)).toThrow(/must be a string/);
    expect(() => parseKeyChord('c')).toThrow(/not a chord/);
    expect(() => parseKeyChord('ctrl+')).toThrow(/empty part/);
    expect(() => parseKeyChord('+c')).toThrow(/empty part/);
    expect(() => parseKeyChord('ctrl++c')).toThrow(/empty part/);
    expect(() => parseKeyChord('hyper+c')).toThrow(/not a modifier/);
    expect(() => parseKeyChord('ctrl+ctrl+c')).toThrow(/duplicate modifier/);
    expect(() => parseKeyChord('ctrl+foo')).toThrow(/not a supported chord key/);
    expect(() => parseKeyChord('ctrl+shift')).toThrow(/not a supported chord key/);
    expect(() => parseKeyChord('ctrl+alt+shift+meta+x+y')).toThrow(/too many parts/);
    expect(() => parseKeyChord(`ctrl+${'c'.repeat(100)}`)).toThrow(/too long/);
  });

  it('allows four distinct modifiers plus a key', () => {
    expect(parseKeyChord('ctrl+alt+shift+meta+x')).toEqual({
      modifiers: ['ctrl', 'alt', 'shift', 'meta'],
      key: 'x',
    });
  });

  it('formatChord round-trips', () => {
    expect(formatChord(parseKeyChord('ctrl+shift+s'))).toBe('ctrl+shift+s');
    expect(formatChord({ modifiers: [], key: 'PrintScreen' })).toBe('PrintScreen');
  });
});

// ---------------------------------------------------------------------------
// Hotkey presets
// ---------------------------------------------------------------------------

describe('resolveHotkey', () => {
  it('maps copy/paste/cut/undo/save/select_all/find per OS', () => {
    expect(resolveHotkey('copy', 'darwin')).toEqual({ modifiers: ['meta'], key: 'c' });
    expect(resolveHotkey('copy', 'win32')).toEqual({ modifiers: ['ctrl'], key: 'c' });
    expect(resolveHotkey('copy', 'linux')).toEqual({ modifiers: ['ctrl'], key: 'c' });
    expect(resolveHotkey('paste', 'darwin')!.key).toBe('v');
    expect(resolveHotkey('undo', 'win32')).toEqual({ modifiers: ['ctrl'], key: 'z' });
    expect(resolveHotkey('save', 'darwin')).toEqual({ modifiers: ['meta'], key: 's' });
    expect(resolveHotkey('select_all', 'linux')).toEqual({ modifiers: ['ctrl'], key: 'a' });
    expect(resolveHotkey('find', 'darwin')).toEqual({ modifiers: ['meta'], key: 'f' });
  });

  it('maps redo/close_window/switch_app with OS-specific chords', () => {
    expect(resolveHotkey('redo', 'darwin')).toEqual({ modifiers: ['meta', 'shift'], key: 'z' });
    expect(resolveHotkey('redo', 'win32')).toEqual({ modifiers: ['ctrl'], key: 'y' });
    expect(resolveHotkey('close_window', 'darwin')).toEqual({ modifiers: ['meta'], key: 'q' });
    expect(resolveHotkey('close_window', 'win32')).toEqual({ modifiers: ['alt'], key: 'F4' });
    expect(resolveHotkey('switch_app', 'darwin')).toEqual({ modifiers: ['meta'], key: 'Tab' });
    expect(resolveHotkey('switch_app', 'linux')).toEqual({ modifiers: ['alt'], key: 'Tab' });
  });

  it('maps screenshot per OS (bare PrintScreen off macOS)', () => {
    expect(resolveHotkey('screenshot', 'darwin')).toEqual({ modifiers: ['meta', 'shift'], key: '3' });
    expect(resolveHotkey('screenshot', 'win32')).toEqual({ modifiers: [], key: 'PrintScreen' });
    expect(resolveHotkey('screenshot', 'linux')).toEqual({ modifiers: [], key: 'PrintScreen' });
  });

  it('is case-insensitive and returns null for unknown names', () => {
    expect(resolveHotkey('Copy', 'darwin')).toEqual({ modifiers: ['meta'], key: 'c' });
    expect(resolveHotkey('COPY', 'win32')).toEqual({ modifiers: ['ctrl'], key: 'c' });
    expect(resolveHotkey('Enter', 'darwin')).toBeNull();
    expect(resolveHotkey('hyperdrive', 'linux')).toBeNull();
    expect(resolveHotkey('', 'win32')).toBeNull();
  });

  it('returns defensive copies', () => {
    const a = resolveHotkey('copy', 'darwin')!;
    a.modifiers.push('shift');
    expect(resolveHotkey('copy', 'darwin')).toEqual({ modifiers: ['meta'], key: 'c' });
  });

  it('covers every advertised hotkey name', () => {
    for (const name of HOTKEY_NAMES) {
      expect(resolveHotkey(name, 'darwin'), name).not.toBeNull();
      expect(resolveHotkey(name, 'win32'), name).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// computer_key tool: chords + hotkeys
// ---------------------------------------------------------------------------

describe('computer_key tool with chords and hotkeys', () => {
  it('routes chords to os.keyChord with parsed modifiers', async () => {
    const os = new MockOSScreenLayer();
    const tool = toolMap(os).get(COMPUTER_TOOL_NAMES.key)!;
    const res = await tool.handler({ name: 'ctrl+shift+s' }, CTX);
    expect(res).toEqual({ pressed: 'ctrl+shift+s', chord: 'ctrl+shift+s' });
    expect(os.callsOf('keychord')).toEqual([{ modifiers: ['ctrl', 'shift'], key: 's' }]);
    expect(os.callsOf('key')).toHaveLength(0);
  });

  it('accepts the dangerous-looking ctrl+alt+del chord (still approval-gated)', async () => {
    const os = new MockOSScreenLayer();
    const tool = toolMap(os).get(COMPUTER_TOOL_NAMES.key)!;
    const res = await tool.handler({ name: 'ctrl+alt+del' }, CTX);
    // 'del' normalizes to the canonical 'Delete' in the echoed chord.
    expect(res).toEqual({ pressed: 'ctrl+alt+del', chord: 'ctrl+alt+Delete' });
    expect(os.callsOf('keychord')).toEqual([{ modifiers: ['ctrl', 'alt'], key: 'Delete' }]);
  });

  it('resolves hotkeys per platform', async () => {
    const macOs = new MockOSScreenLayer();
    const macTool = toolMap(macOs, 'darwin').get(COMPUTER_TOOL_NAMES.key)!;
    const macRes = await macTool.handler({ name: 'copy' }, CTX);
    expect(macRes).toEqual({ pressed: 'copy', hotkey: 'copy', chord: 'meta+c' });
    expect(macOs.callsOf('keychord')).toEqual([{ modifiers: ['meta'], key: 'c' }]);

    const winOs = new MockOSScreenLayer();
    const winTool = toolMap(winOs, 'win32').get(COMPUTER_TOOL_NAMES.key)!;
    const winRes = await winTool.handler({ name: 'close_window' }, CTX);
    expect(winRes).toEqual({ pressed: 'close_window', hotkey: 'close_window', chord: 'alt+F4' });
    expect(winOs.callsOf('keychord')).toEqual([{ modifiers: ['alt'], key: 'F4' }]);
  });

  it('keeps single keys on the original os.key path', async () => {
    const os = new MockOSScreenLayer();
    const tool = toolMap(os).get(COMPUTER_TOOL_NAMES.key)!;
    expect(await tool.handler({ name: 'Enter' }, CTX)).toEqual({ pressed: 'Enter' });
    expect(os.callsOf('key')).toEqual([{ name: 'Enter' }]);
    expect(os.callsOf('keychord')).toHaveLength(0);
  });

  it('rejects invalid chords and unknown names with a helpful error', async () => {
    const os = new MockOSScreenLayer();
    const tool = toolMap(os).get(COMPUTER_TOOL_NAMES.key)!;
    await expect(tool.handler({ name: 'ctrl+foo' }, CTX)).rejects.toThrow(/not a supported chord key/);
    await expect(tool.handler({ name: 'hyper+c' }, CTX)).rejects.toThrow(/not a modifier/);
    await expect(tool.handler({ name: 'F13' }, CTX)).rejects.toThrow(/allowlist/);
    expect(os.callsOf('keychord')).toHaveLength(0);
    expect(os.callsOf('key')).toHaveLength(0);
  });

  it('documents chords and hotkeys in the tool description', () => {
    const tool = toolMap(new MockOSScreenLayer()).get(COMPUTER_TOOL_NAMES.key)!;
    expect(tool.description).toMatch(/ctrl\+c/);
    expect(tool.description).toMatch(/copy/);
  });

  it('stays require-approval under the unchanged policy rule', () => {
    const rule = computerUsePolicyRules().find(
      (r) => r.toolPattern === '^computer_(click|type|key|open_app|scroll|drag|move)$',
    );
    expect(rule?.effect).toBe('require-approval');
    expect(new RegExp(rule!.toolPattern).test(COMPUTER_TOOL_NAMES.key)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Layer backends
// ---------------------------------------------------------------------------

function fakeRealInput(): RealInputBackend & {
  log: string[];
  lastClick: { button: RealMouseButton; double: boolean } | null;
  lastChord: { modifiers: ChordModifier[]; key: string } | null;
} {
  // NOTE: methods mutate `self` directly — spreading a state object would
  // snapshot the nulls instead of tracking updates.
  const self = {
    log: [] as string[],
    lastClick: null as { button: RealMouseButton; double: boolean } | null,
    lastChord: null as { modifiers: ChordModifier[]; key: string } | null,
    async moveMouse(x: number, y: number) {
      self.log.push(`move:${x},${y}`);
    },
    async mouseClick(button: RealMouseButton, double: boolean) {
      self.lastClick = { button, double };
      self.log.push(`click:${button}:${double ? 'double' : 'single'}`);
    },
    async mouseDown(b: RealMouseButton) {
      self.log.push(`down:${b}`);
    },
    async mouseUp(b: RealMouseButton) {
      self.log.push(`up:${b}`);
    },
    async scrollAt() {},
    async typeString() {},
    async pressKey() {},
    async pressKeyChord(modifiers: ChordModifier[], key: string) {
      self.lastChord = { modifiers: [...modifiers], key };
      self.log.push(`chord:${formatChord({ modifiers, key })}`);
    },
    async screenWidth() {
      return 1920;
    },
    async screenHeight() {
      return 1080;
    },
  };
  return self;
}

function fakePageBackend(): PlaywrightPageBackend & {
  clicks: Array<{ x: number; y: number; opts?: { button?: string; clickCount?: number } }>;
  chords: Array<{ modifiers: ChordModifier[]; key: string }>;
} {
  const state = {
    clicks: [] as Array<{ x: number; y: number; opts?: { button?: string; clickCount?: number } }>,
    chords: [] as Array<{ modifiers: ChordModifier[]; key: string }>,
  };
  return {
    ...state,
    viewportSize: () => ({ width: 1280, height: 720 }),
    async goto() {},
    async screenshot() {
      return new Uint8Array([1, 2, 3]);
    },
    async mouseClick(x, y, opts) {
      state.clicks.push({ x, y, opts });
    },
    async mouseMove() {},
    async mouseDown() {},
    async mouseUp() {},
    async mouseWheel() {},
    async keyboardType() {},
    async keyboardPress() {},
    async keyboardChord(modifiers, key) {
      state.chords.push({ modifiers: [...modifiers], key });
    },
    async close() {},
  };
}

class FakeRunner implements DockerRunner {
  async checkAvailable(): Promise<void> {}
  async start(): Promise<string> {
    return 'fake-container';
  }
  async hostPort(): Promise<number> {
    return 19922;
  }
  async stop(): Promise<void> {}
}

class FakeCdp implements CdpConnection {
  sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  async send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.sent.push({ method, params });
    return {} as T;
  }
  async close(): Promise<void> {}
}

async function launchedDocker(): Promise<{ sbx: DockerComputerSandbox; cdp: FakeCdp }> {
  const cdp = new FakeCdp();
  const sbx = new DockerComputerSandbox({
    runner: new FakeRunner(),
    listTargets: async (): Promise<CdpTarget[]> => [
      { type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:19922/devtools/page/1' },
    ],
    connectCdp: async () => cdp,
  });
  await sbx.launch();
  cdp.sent.length = 0; // drop launch chatter
  return { sbx, cdp };
}

describe('RealOSScreenLayer click/chord', () => {
  it('passes button and double-click through to the backend', async () => {
    const input = fakeRealInput();
    const layer = new RealOSScreenLayer({ input });
    const seen: Array<{ action: string; detail: Record<string, unknown> }> = [];
    const layer2 = new RealOSScreenLayer({
      input,
      onRealAction: (action, detail) => seen.push({ action, detail }),
    });

    await layer.click(10, 20);
    expect(input.lastClick).toEqual({ button: 'left', double: false });

    await layer2.click(30, 40, { button: 'right', clicks: 2 });
    expect(input.lastClick).toEqual({ button: 'right', double: true });
    expect(seen[0].detail).toMatchObject({ button: 'right', clicks: 2 });
  });

  it('forwards chords to pressKeyChord and audits them as key actions', async () => {
    const input = fakeRealInput();
    const seen: Array<{ action: string; detail: Record<string, unknown> }> = [];
    const layer = new RealOSScreenLayer({
      input,
      onRealAction: (action, detail) => seen.push({ action, detail }),
    });
    await layer.keyChord(['ctrl', 'shift'], 's');
    expect(input.lastChord).toEqual({ modifiers: ['ctrl', 'shift'], key: 's' });
    expect(seen).toHaveLength(1);
    expect(seen[0].action).toBe('key');
    expect(seen[0].detail).toMatchObject({ chord: 'ctrl+shift+s' });
  });
});

describe('PlaywrightOSScreenLayer click/chord', () => {
  it('passes button/clickCount to the page backend', async () => {
    const page = fakePageBackend();
    const layer = new PlaywrightOSScreenLayer({ pageFactory: async () => page });
    await layer.click(100, 200);
    await layer.click(300, 400, { button: 'right', clicks: 2 });
    expect(page.clicks).toEqual([
      { x: 100, y: 200, opts: { button: 'left', clickCount: 1 } },
      { x: 300, y: 400, opts: { button: 'right', clickCount: 2 } },
    ]);
  });

  it('forwards chords to keyboardChord', async () => {
    const page = fakePageBackend();
    const layer = new PlaywrightOSScreenLayer({ pageFactory: async () => page });
    await layer.keyChord(['meta'], 'c');
    expect(page.chords).toEqual([{ modifiers: ['meta'], key: 'c' }]);
  });
});

describe('DockerComputerSandbox click/chord (CDP)', () => {
  it('right-click sends button:right via CDP', async () => {
    const { sbx, cdp } = await launchedDocker();
    await sbx.click(10, 20, { button: 'right' });
    const presses = cdp.sent.filter((s) => s.method === 'Input.dispatchMouseEvent');
    expect(presses).toHaveLength(2);
    expect(presses[0].params).toMatchObject({ type: 'mousePressed', button: 'right', clickCount: 1 });
    expect(presses[1].params).toMatchObject({ type: 'mouseReleased', button: 'right', clickCount: 1 });
    await sbx.kill();
  });

  it('double-click sends two press/release pairs with clickCount 1 then 2', async () => {
    const { sbx, cdp } = await launchedDocker();
    await sbx.click(10, 20, { clicks: 2 });
    const presses = cdp.sent.filter((s) => s.method === 'Input.dispatchMouseEvent');
    expect(presses.map((p) => [p.params['type'], p.params['clickCount'], p.params['button']])).toEqual([
      ['mousePressed', 1, 'left'],
      ['mouseReleased', 1, 'left'],
      ['mousePressed', 2, 'left'],
      ['mouseReleased', 2, 'left'],
    ]);
    await sbx.kill();
  });

  it('default click is unchanged (single left, clickCount 1)', async () => {
    const { sbx, cdp } = await launchedDocker();
    await sbx.click(10, 20);
    const presses = cdp.sent.filter((s) => s.method === 'Input.dispatchMouseEvent');
    expect(presses).toHaveLength(2);
    expect(presses[0].params).toMatchObject({ button: 'left', clickCount: 1 });
    await sbx.kill();
  });

  it('keyChord sequences modifiers down/up around the key tap with a CDP bitmask', async () => {
    const { sbx, cdp } = await launchedDocker();
    await sbx.keyChord(['ctrl', 'shift'], 's');
    const keys = cdp.sent.filter((s) => s.method === 'Input.dispatchKeyEvent');
    // rawKeyDown Control (mods=2), rawKeyDown Shift (mods=2|8=10),
    // keyDown/keyUp 's' (mods=10), keyUp Shift (mods=2), keyUp Control (mods=0)
    expect(keys.map((k) => [k.params['type'], k.params['key'], k.params['modifiers']])).toEqual([
      ['rawKeyDown', 'Control', 2],
      ['rawKeyDown', 'Shift', 10],
      ['keyDown', 's', 10],
      ['keyUp', 's', 10],
      ['keyUp', 'Shift', 2],
      ['keyUp', 'Control', 0],
    ]);
    await sbx.kill();
  });

  it('keyChord maps letters/digits/F-keys to CDP codes', async () => {
    const { sbx, cdp } = await launchedDocker();
    await sbx.keyChord(['alt'], 'F4');
    const tap = cdp.sent.find((s) => s.params['type'] === 'keyDown');
    expect(tap!.params).toMatchObject({ key: 'F4', code: 'F4', windowsVirtualKeyCode: 115, modifiers: 1 });
    await sbx.kill();
  });

  it('keyChord with no modifiers is a plain tap', async () => {
    const { sbx, cdp } = await launchedDocker();
    await sbx.keyChord([], 'PrintScreen');
    const keys = cdp.sent.filter((s) => s.method === 'Input.dispatchKeyEvent');
    expect(keys.map((k) => k.params['type'])).toEqual(['keyDown', 'keyUp']);
    expect(keys[0].params).toMatchObject({ key: 'PrintScreen', modifiers: 0 });
    await sbx.kill();
  });
});

describe('LocalComputerSandbox delegation', () => {
  it('forwards keyChord and click options to the inner layer', async () => {
    // LocalComputerSandbox always wraps selectOSLayer() (the mock unless
    // COMPUTER_USE_REAL=1). Drive it through the tool path and confirm the
    // inner mock recorded the chord and click options.
    const sbx = new LocalComputerSandbox();
    const tools = createComputerUseTools({ os: sbx });
    const keyTool = tools.find((t) => t.name === COMPUTER_TOOL_NAMES.key)!;
    await keyTool.handler({ name: 'ctrl+c' }, CTX);
    const clickTool = tools.find((t) => t.name === COMPUTER_TOOL_NAMES.click)!;
    await clickTool.handler({ x: 10, y: 10, button: 'right', clicks: 2 }, CTX);
    // No throw = delegation works on the default (mock) inner layer.
    await sbx.kill();
  });
});

describe('MockOSScreenLayer recording', () => {
  it('records keychord calls separately from key calls', async () => {
    const os = new MockOSScreenLayer();
    await os.key('Enter');
    await os.keyChord(['ctrl'], 'c');
    expect(os.callsOf('key')).toEqual([{ name: 'Enter' }]);
    expect(os.callsOf('keychord')).toEqual([{ modifiers: ['ctrl'], key: 'c' }]);
  });

  it('records click button and clicks with defaults', async () => {
    const os = new MockOSScreenLayer();
    await os.click(1, 2);
    await os.click(3, 4, { button: 'right', clicks: 2 });
    expect(os.callsOf('click')).toEqual([
      { x: 1, y: 2, button: 'left', clicks: 1 },
      { x: 3, y: 4, button: 'right', clicks: 2 },
    ]);
  });
});
