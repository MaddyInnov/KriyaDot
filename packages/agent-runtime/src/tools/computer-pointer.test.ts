// SPDX-License-Identifier: Apache-2.0
// Tests for the computer pointer primitives: computer_scroll, computer_drag,
// computer_move. All OS calls are mocked — zero real input in tests.
//
// Coverage:
//   - tool registration (names, mutating flags) + governance policy gating
//   - scroll arg validation (direction/amount vs deltaX/deltaY forms)
//   - drag arg validation (button, steps, bounds)
//   - move arg validation + display bounds checks
//   - MockOSScreenLayer records scroll/drag/move calls
//   - RealOSScreenLayer: scrollAt mapping, stepped drag with button release
//     on mid-drag failure, audit hook actions
//   - PlaywrightOSScreenLayer: wheel/drag/move mappings
//   - DockerComputerSandbox: CDP mouseWheel / pressed+moved+released / mouseMoved
//   - LocalComputerSandbox delegates scroll/drag/move to the inner layer

import { describe, it, expect } from 'vitest';
import {
  COMPUTER_TOOL_NAMES,
  MockOSScreenLayer,
  computerUsePolicyRules,
  createComputerUseTools,
} from './computer.js';
import type { ToolContext, ToolDefinition } from '../types.js';
import { RealOSScreenLayer, type RealInputBackend } from './computer-real.js';
import { PlaywrightOSScreenLayer, type PlaywrightPageBackend } from './computer-playwright.js';
import { DockerComputerSandbox, LocalComputerSandbox, type CdpConnection, type CdpTarget, type DockerRunner } from './computer-sandbox.js';

const CTX = { sessionId: 's1', botId: 'helper' } as ToolContext;

function toolMap(os: MockOSScreenLayer): Map<string, ToolDefinition> {
  const m = new Map<string, ToolDefinition>();
  for (const t of createComputerUseTools({ os })) m.set(t.name, t);
  return m;
}

async function expectThrow(p: Promise<unknown>, part: string): Promise<void> {
  await expect(p).rejects.toThrow(part);
}

describe('tool registration', () => {
  it('exposes the three new canonical tool names', () => {
    expect(COMPUTER_TOOL_NAMES.scroll).toBe('computer_scroll');
    expect(COMPUTER_TOOL_NAMES.drag).toBe('computer_drag');
    expect(COMPUTER_TOOL_NAMES.move).toBe('computer_move');
  });

  it('registers eight computer tools, the new three marked mutating', () => {
    const tools = createComputerUseTools({ os: new MockOSScreenLayer() });
    expect(tools).toHaveLength(8);
    for (const name of [COMPUTER_TOOL_NAMES.scroll, COMPUTER_TOOL_NAMES.drag, COMPUTER_TOOL_NAMES.move]) {
      const t = tools.find((x) => x.name === name);
      expect(t, name).toBeDefined();
      expect(t!.mutating).toBe(true);
    }
    // screenshot stays non-mutating
    expect(tools.find((x) => x.name === COMPUTER_TOOL_NAMES.screenshot)!.mutating).not.toBe(true);
  });
});

describe('governance policy gating', () => {
  function effectFor(toolName: string): string | undefined {
    for (const rule of computerUsePolicyRules()) {
      if (new RegExp(rule.toolPattern).test(toolName)) return rule.effect;
    }
    return undefined;
  }

  it('marks scroll/drag/move as require-approval', () => {
    expect(effectFor('computer_scroll')).toBe('require-approval');
    expect(effectFor('computer_drag')).toBe('require-approval');
    expect(effectFor('computer_move')).toBe('require-approval');
  });

  it('keeps the existing gates unchanged', () => {
    expect(effectFor('computer_click')).toBe('require-approval');
    expect(effectFor('computer_type')).toBe('require-approval');
    expect(effectFor('computer_key')).toBe('require-approval');
    expect(effectFor('computer_open_app')).toBe('require-approval');
    expect(effectFor('computer_screenshot')).toBe('allow');
  });
});

describe('computer_scroll validation', () => {
  it('direction+amount resolves to pixel deltas (down, amount 2 → +240px)', async () => {
    const os = new MockOSScreenLayer();
    const t = toolMap(os).get('computer_scroll')!;
    const res = (await t.handler({ x: 100, y: 200, direction: 'down', amount: 2 }, CTX)) as {
      scrolled: { x: number; y: number; deltaX: number; deltaY: number };
    };
    expect(res.scrolled).toEqual({ x: 100, y: 200, deltaX: 0, deltaY: 240 });
    expect(os.callsOf('scroll')).toEqual([{ x: 100, y: 200, deltaX: 0, deltaY: 240 }]);
  });

  it('defaults amount to 3 notches; up/left/right map to negative deltas', async () => {
    const os = new MockOSScreenLayer();
    const t = toolMap(os).get('computer_scroll')!;
    await t.handler({ x: 10, y: 10, direction: 'up' }, CTX);
    await t.handler({ x: 10, y: 10, direction: 'left', amount: 1 }, CTX);
    await t.handler({ x: 10, y: 10, direction: 'right', amount: 1 }, CTX);
    expect(os.callsOf('scroll')).toEqual([
      { x: 10, y: 10, deltaX: 0, deltaY: -360 },
      { x: 10, y: 10, deltaX: -120, deltaY: 0 },
      { x: 10, y: 10, deltaX: 120, deltaY: 0 },
    ]);
  });

  it('accepts the raw deltaX/deltaY form', async () => {
    const os = new MockOSScreenLayer();
    const t = toolMap(os).get('computer_scroll')!;
    const res = (await t.handler({ x: 5, y: 5, deltaX: -30, deltaY: 500 }, CTX)) as {
      scrolled: { deltaX: number; deltaY: number };
    };
    expect(res.scrolled.deltaX).toBe(-30);
    expect(res.scrolled.deltaY).toBe(500);
  });

  it('rejects an invalid direction', async () => {
    const os = new MockOSScreenLayer();
    const t = toolMap(os).get('computer_scroll')!;
    await expectThrow(t.handler({ x: 5, y: 5, direction: 'diagonal' }, CTX), 'direction');
  });

  it('rejects out-of-range and non-integer amounts', async () => {
    const os = new MockOSScreenLayer();
    const t = toolMap(os).get('computer_scroll')!;
    await expectThrow(t.handler({ x: 5, y: 5, direction: 'down', amount: 0 }, CTX), 'amount');
    await expectThrow(t.handler({ x: 5, y: 5, direction: 'down', amount: 51 }, CTX), 'amount');
    await expectThrow(t.handler({ x: 5, y: 5, direction: 'down', amount: 2.5 }, CTX), 'amount');
  });

  it('rejects mixing direction with deltaX/deltaY', async () => {
    const os = new MockOSScreenLayer();
    const t = toolMap(os).get('computer_scroll')!;
    await expectThrow(
      t.handler({ x: 5, y: 5, direction: 'down', deltaY: 100 }, CTX),
      'not both',
    );
  });

  it('rejects a scroll with no amount at all and over-cap deltas', async () => {
    const os = new MockOSScreenLayer();
    const t = toolMap(os).get('computer_scroll')!;
    await expectThrow(t.handler({ x: 5, y: 5 }, CTX), 'non-zero');
    await expectThrow(t.handler({ x: 5, y: 5, deltaX: 0, deltaY: 0 }, CTX), 'non-zero');
    await expectThrow(t.handler({ x: 5, y: 5, deltaY: 5000 }, CTX), 'capped');
  });

  it('rejects non-numeric coords and out-of-bounds targets', async () => {
    const os = new MockOSScreenLayer();
    const t = toolMap(os).get('computer_scroll')!;
    await expectThrow(t.handler({ x: 'a', y: 5, direction: 'down' }, CTX), '"x" must be a number');
    await expectThrow(t.handler({ x: 5000, y: 5, direction: 'down' }, CTX), 'outside the 1920×1080 display');
    await expectThrow(t.handler({ x: 5, y: -1, direction: 'down' }, CTX), 'outside the 1920×1080 display');
  });
});

describe('computer_drag validation', () => {
  it('drags with defaults (left button, 20 steps)', async () => {
    const os = new MockOSScreenLayer();
    const t = toolMap(os).get('computer_drag')!;
    const res = (await t.handler({ x1: 10, y1: 20, x2: 300, y2: 400 }, CTX)) as {
      dragged: { x1: number; y1: number; x2: number; y2: number; button: string; steps: number };
    };
    expect(res.dragged).toEqual({ x1: 10, y1: 20, x2: 300, y2: 400, button: 'left', steps: 20 });
    expect(os.callsOf('drag')).toEqual([
      { x1: 10, y1: 20, x2: 300, y2: 400, button: 'left', steps: 20 },
    ]);
  });

  it('accepts right/middle buttons and custom steps', async () => {
    const os = new MockOSScreenLayer();
    const t = toolMap(os).get('computer_drag')!;
    await t.handler({ x1: 1, y1: 1, x2: 2, y2: 2, button: 'right', steps: 5 }, CTX);
    expect(os.callsOf('drag')[0]).toMatchObject({ button: 'right', steps: 5 });
  });

  it('rejects bad buttons and steps', async () => {
    const os = new MockOSScreenLayer();
    const t = toolMap(os).get('computer_drag')!;
    await expectThrow(t.handler({ x1: 1, y1: 1, x2: 2, y2: 2, button: 'wheel' }, CTX), 'button');
    await expectThrow(t.handler({ x1: 1, y1: 1, x2: 2, y2: 2, steps: 0 }, CTX), 'steps');
    await expectThrow(t.handler({ x1: 1, y1: 1, x2: 2, y2: 2, steps: 101 }, CTX), 'steps');
    await expectThrow(t.handler({ x1: 1, y1: 1, x2: 2, y2: 2, steps: 2.5 }, CTX), 'steps');
  });

  it('bounds-checks both endpoints', async () => {
    const os = new MockOSScreenLayer();
    const t = toolMap(os).get('computer_drag')!;
    await expectThrow(t.handler({ x1: -5, y1: 1, x2: 2, y2: 2 }, CTX), 'drag start');
    await expectThrow(t.handler({ x1: 1, y1: 1, x2: 1920, y2: 2 }, CTX), 'drag end');
  });
});

describe('computer_move validation', () => {
  it('moves and records the call', async () => {
    const os = new MockOSScreenLayer();
    const t = toolMap(os).get('computer_move')!;
    const res = (await t.handler({ x: 123.7, y: 456.2 }, CTX)) as { moved: { x: number; y: number } };
    expect(res.moved).toEqual({ x: 123, y: 456 });
    expect(os.callsOf('move')).toEqual([{ x: 123, y: 456 }]);
  });

  it('rejects out-of-bounds targets', async () => {
    const os = new MockOSScreenLayer();
    const t = toolMap(os).get('computer_move')!;
    await expectThrow(t.handler({ x: 2000, y: 10 }, CTX), 'outside the 1920×1080 display');
  });
});

// ---------------------------------------------------------------------------
// Real layer (fake injected backend — no native modules, no real input)
// ---------------------------------------------------------------------------

function fakeRealInput(): RealInputBackend & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    async moveMouse(x, y) {
      log.push(`move:${x},${y}`);
    },
    async mouseClick(button, double) {
      log.push(`click:${button}${double ? ':double' : ''}`);
    },
    async mouseDown(b) {
      log.push(`down:${b}`);
    },
    async mouseUp(b) {
      log.push(`up:${b}`);
    },
    async scrollAt(x, y, dx, dy) {
      log.push(`scrollAt:${x},${y},${dx},${dy}`);
    },
    async typeString() {
      log.push('type');
    },
    async pressKey() {
      log.push('key');
    },
    async pressKeyChord(modifiers, key) {
      log.push(`chord:${[...modifiers, key].join('+')}`);
    },
    async screenWidth() {
      return 1920;
    },
    async screenHeight() {
      return 1080;
    },
  };
}

describe('RealOSScreenLayer pointer primitives', () => {
  it('scroll delegates to the backend scrollAt and audits', async () => {
    const input = fakeRealInput();
    const audited: Array<{ action: string; detail: Record<string, unknown> }> = [];
    const layer = new RealOSScreenLayer({
      input,
      onRealAction: (action, detail) => audited.push({ action, detail }),
    });
    await layer.scroll(100, 200, 0, -360);
    expect(input.log).toContain('scrollAt:100,200,0,-360');
    expect(audited[0].action).toBe('scroll');
    expect(audited[0].detail).toMatchObject({ x: 100, y: 200, deltaX: 0, deltaY: -360 });
  });

  it('drag performs down → interpolated moves → up with the button', async () => {
    const input = fakeRealInput();
    const layer = new RealOSScreenLayer({ input });
    await layer.drag(0, 0, 100, 50, { button: 'left', steps: 4 });
    expect(input.log[0]).toBe('move:0,0');
    expect(input.log[1]).toBe('down:left');
    // 4 interpolated moves, ending exactly on the target
    expect(input.log.slice(2, 6)).toEqual(['move:25,13', 'move:50,25', 'move:75,38', 'move:100,50']);
    expect(input.log[6]).toBe('up:left');
  });

  it('drag releases the button even when a move fails mid-drag', async () => {
    const input = fakeRealInput();
    let moves = 0;
    const orig = input.moveMouse.bind(input);
    input.moveMouse = async (x, y) => {
      moves++;
      if (moves === 3) throw new Error('injected move failure');
      return orig(x, y);
    };
    const layer = new RealOSScreenLayer({ input });
    await expect(layer.drag(0, 0, 100, 100, { button: 'right', steps: 5 })).rejects.toThrow(
      'injected move failure',
    );
    // button was still released (no stuck held button)
    expect(input.log).toContain('down:right');
    expect(input.log).toContain('up:right');
  });

  it('move delegates to moveMouse and audits', async () => {
    const input = fakeRealInput();
    const audited: string[] = [];
    const layer = new RealOSScreenLayer({ input, onRealAction: (a) => audited.push(a) });
    await layer.move(42, 43);
    expect(input.log).toContain('move:42,43');
    expect(audited).toEqual(['move']);
  });
});

// ---------------------------------------------------------------------------
// Playwright layer (fake page backend)
// ---------------------------------------------------------------------------

function fakePageBackend(): PlaywrightPageBackend & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    viewportSize: () => ({ width: 1280, height: 720 }),
    async goto() {},
    async screenshot() {
      return new Uint8Array([1, 2, 3]);
    },
    async mouseClick(x, y) {
      log.push(`click:${x},${y}`);
    },
    async mouseMove(x, y) {
      log.push(`move:${x},${y}`);
    },
    async mouseDown(b) {
      log.push(`down:${b ?? 'left'}`);
    },
    async mouseUp(b) {
      log.push(`up:${b ?? 'left'}`);
    },
    async mouseWheel(x, y, dx, dy) {
      log.push(`wheel:${x},${y},${dx},${dy}`);
    },
    async keyboardType() {},
    async keyboardPress() {},
    async keyboardChord(modifiers, key) {
      log.push(`chord:${[...modifiers, key].join('+')}`);
    },
    async close() {},
  };
}

describe('PlaywrightOSScreenLayer pointer primitives', () => {
  it('scroll dispatches a wheel event at the target', async () => {
    const page = fakePageBackend();
    const layer = new PlaywrightOSScreenLayer({ pageFactory: async () => page });
    await layer.scroll(300, 400, 0, 240);
    expect(page.log).toContain('wheel:300,400,0,240');
  });

  it('drag does move → down → stepped moves → up', async () => {
    const page = fakePageBackend();
    const audited: string[] = [];
    const layer = new PlaywrightOSScreenLayer({
      pageFactory: async () => page,
      onRealAction: (a) => audited.push(a),
    });
    await layer.drag(0, 0, 60, 30, { button: 'left', steps: 3 });
    expect(page.log[0]).toBe('move:0,0');
    expect(page.log[1]).toBe('down:left');
    expect(page.log.slice(2, 5)).toEqual(['move:20,10', 'move:40,20', 'move:60,30']);
    expect(page.log[5]).toBe('up:left');
    expect(audited).toEqual(['drag']);
  });

  it('move moves the mouse without clicking', async () => {
    const page = fakePageBackend();
    const layer = new PlaywrightOSScreenLayer({ pageFactory: async () => page });
    await layer.move(11, 22);
    expect(page.log).toEqual(['move:11,22']);
  });
});

// ---------------------------------------------------------------------------
// Docker CDP sandbox
// ---------------------------------------------------------------------------

class FakeRunner implements DockerRunner {
  async checkAvailable(): Promise<void> {}
  async start(): Promise<string> {
    return 'fake-container-id';
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

const FAKE_TARGETS: CdpTarget[] = [
  { type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:19922/devtools/page/1' },
];

function launchedDocker() {
  const cdp = new FakeCdp();
  const events: Array<{ action: string; detail: Record<string, unknown> }> = [];
  const sbx = new DockerComputerSandbox({
    runner: new FakeRunner(),
    listTargets: async () => FAKE_TARGETS,
    connectCdp: async () => cdp,
    onEvent: (action, detail) => events.push({ action, detail }),
  });
  return { sbx, cdp, events };
}

describe('DockerComputerSandbox pointer primitives', () => {
  it('scroll sends a CDP mouseWheel event', async () => {
    const { sbx, cdp, events } = launchedDocker();
    await sbx.launch();
    await sbx.scroll(100, 200, 0, 360);
    const wheel = cdp.sent.filter((s) => s.params.type === 'mouseWheel');
    expect(wheel).toHaveLength(1);
    expect(wheel[0].method).toBe('Input.dispatchMouseEvent');
    expect(wheel[0].params).toMatchObject({ x: 100, y: 200, deltaX: 0, deltaY: 360 });
    expect(events.map((e) => e.action)).toContain('scroll');
    await sbx.kill();
  });

  it('drag sends pressed → moved steps → released with the button', async () => {
    const { sbx, cdp, events } = launchedDocker();
    await sbx.launch();
    await sbx.drag(10, 10, 110, 60, { button: 'left', steps: 4 });
    // launch() sends Page.enable / Emulation.* first — only look at mouse events
    const mouse = cdp.sent.filter((s) => s.method === 'Input.dispatchMouseEvent');
    const types = mouse.map((s) => s.params.type);
    expect(types[0]).toBe('mousePressed');
    expect(types.slice(1, 5)).toEqual(['mouseMoved', 'mouseMoved', 'mouseMoved', 'mouseMoved']);
    expect(types[5]).toBe('mouseReleased');
    expect(mouse[0].params).toMatchObject({ button: 'left', x: 10, y: 10 });
    expect(mouse[5].params).toMatchObject({ button: 'left', x: 110, y: 60 });
    expect(events.map((e) => e.action)).toContain('drag');
    await sbx.kill();
  });

  it('move sends a CDP mouseMoved event', async () => {
    const { sbx, cdp } = launchedDocker();
    await sbx.launch();
    await sbx.move(55, 66);
    const moved = cdp.sent.filter((s) => s.params.type === 'mouseMoved');
    expect(moved).toHaveLength(1);
    expect(moved[0].params).toMatchObject({ x: 55, y: 66 });
    await sbx.kill();
  });
});

describe('LocalComputerSandbox delegation', () => {
  it('forwards scroll/drag/move to the inner layer', async () => {
    const sbx = new LocalComputerSandbox(); // inner = MockOSScreenLayer by default
    await sbx.scroll(1, 2, 0, 120);
    await sbx.drag(1, 2, 3, 4, { button: 'middle', steps: 2 });
    await sbx.move(7, 8);
    const inner = (sbx as unknown as { inner: MockOSScreenLayer }).inner;
    expect(inner.callsOf('scroll')).toEqual([{ x: 1, y: 2, deltaX: 0, deltaY: 120 }]);
    expect(inner.callsOf('drag')).toEqual([{ x1: 1, y1: 2, x2: 3, y2: 4, button: 'middle', steps: 2 }]);
    expect(inner.callsOf('move')).toEqual([{ x: 7, y: 8 }]);
  });
});
