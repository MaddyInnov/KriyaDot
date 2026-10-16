// SPDX-License-Identifier: Apache-2.0
// Tests for per-bot computers + "Works on" surface selection (OpenMausBot
// parity P1 #14): per-bot isolation, surface routing, conversation pins,
// idle disposal, bot deletion cleanup, 'off' disabling, and per-call layer
// resolution in the computer tools.

import { describe, expect, it } from 'vitest';
import {
  ComputerSurfaceOffError,
  PerBotComputerManager,
  isComputerSurface,
  layerIsMock,
  resolveAutoSurface,
  resolveSurfaceKind,
  type OSScreenLayer,
  type ResolvedComputerSurface,
} from '../src/tools/computer-surfaces.js';
import { MockOSScreenLayer } from '../src/tools/computer.js';
import { createComputerUseTools } from '../src/tools/computer.js';
import type { ToolContext } from '../src/types.js';

/** Recording mock backend (no real input anywhere in these tests). */
class RecordingLayer implements OSScreenLayer {
  readonly calls: string[] = [];
  constructor(readonly tag: string) {}
  async displaySize() {
    return { width: 1920, height: 1080 };
  }
  async screenshot() {
    this.calls.push('screenshot');
    return { png: new Uint8Array(), width: 1920, height: 1080 };
  }
  async click(x: number, y: number) {
    this.calls.push(`click:${x},${y}`);
  }
  async type(text: string) {
    this.calls.push(`type:${text}`);
  }
  async key(name: string) {
    this.calls.push(`key:${name}`);
  }
  async keyChord(modifiers: string[], keyName: string) {
    this.calls.push(`chord:${modifiers.join('+')}+${keyName}`);
  }
  async scroll(x: number, y: number, dx: number, dy: number) {
    this.calls.push(`scroll:${x},${y},${dx},${dy}`);
  }
  async drag(x1: number, y1: number, x2: number, y2: number) {
    this.calls.push(`drag:${x1},${y1},${x2},${y2}`);
  }
  async move(x: number, y: number) {
    this.calls.push(`move:${x},${y}`);
  }
}

function makeManager(opts: {
  clock?: () => number;
  idleTimeoutMs?: number;
} = {}) {
  const created: Array<{ resolved: ResolvedComputerSurface; botId: string }> = [];
  const backends = new Map<string, RecordingLayer>();
  const mgr = new PerBotComputerManager({
    clock: opts.clock,
    idleTimeoutMs: opts.idleTimeoutMs,
    createBackend: (resolved, botId) => {
      created.push({ resolved, botId });
      const layer = new RecordingLayer(`${resolved}:${botId}`);
      backends.set(`${resolved}:${botId}:${created.length}`, layer);
      return layer;
    },
  });
  return { mgr, created, backends };
}

const ctxFor = (botId: string, conversationId?: string): ToolContext => ({
  sessionId: 's1',
  botId,
  conversationId,
});

describe('surface validation + resolution', () => {
  it('accepts exactly the five surfaces', () => {
    for (const s of ['auto', 'local', 'docker', 'browser', 'off']) {
      expect(isComputerSurface(s)).toBe(true);
    }
    expect(isComputerSurface('windows')).toBe(false);
    expect(isComputerSurface('')).toBe(false);
    expect(isComputerSurface(undefined)).toBe(false);
  });

  it('resolves explicit surfaces to themselves; off stays off', () => {
    expect(resolveSurfaceKind('local')).toBe('local');
    expect(resolveSurfaceKind('docker')).toBe('docker');
    expect(resolveSurfaceKind('browser')).toBe('browser');
    expect(resolveSurfaceKind('off')).toBe('off');
  });

  it('auto follows env priority: docker > playwright > local', () => {
    const prev = { ...process.env };
    try {
      delete process.env.COMPUTER_USE_DOCKER;
      delete process.env.COMPUTER_USE_PLAYWRIGHT;
      expect(resolveAutoSurface()).toBe('local');
      process.env.COMPUTER_USE_PLAYWRIGHT = '1';
      expect(resolveAutoSurface()).toBe('browser');
      process.env.COMPUTER_USE_DOCKER = '1';
      expect(resolveAutoSurface()).toBe('docker');
    } finally {
      process.env = prev;
    }
  });
});

describe('per-bot isolation', () => {
  it('two bots get different backends; actions do not cross', async () => {
    const { mgr } = makeManager();
    const a = mgr.getLayer('scout', { surface: 'local' });
    const b = mgr.getLayer('coder', { surface: 'local' });
    expect(a).not.toBe(b);
    await a.click(10, 20);
    await b.type('hello');
    // Both are LazyPerBotLayer proxies; unwrap via status + created order.
    expect(mgr.status('scout')).toHaveLength(1);
    expect(mgr.status('coder')).toHaveLength(1);
  });

  it('serializes one bot\'s input actions in order', async () => {
    const order: string[] = [];
    const mgr = new PerBotComputerManager({
      createBackend: () => {
        const base = new MockOSScreenLayer();
        return new Proxy(base, {
          get(t, prop, recv) {
            if (prop === 'click' || prop === 'type') {
              return async (...args: unknown[]) => {
                order.push(`${String(prop)}-start`);
                await new Promise((r) => setTimeout(r, 5));
                order.push(`${String(prop)}-end`);
                return (t[prop as keyof MockOSScreenLayer] as (...a: unknown[]) => Promise<void>).apply(t, args);
              };
            }
            return Reflect.get(t, prop, recv);
          },
        }) as OSScreenLayer;
      },
    });
    const layer = mgr.getLayer('scout', { surface: 'local' });
    await Promise.all([layer.click(1, 1), layer.type('x'), layer.click(2, 2)]);
    expect(order).toEqual([
      'click-start', 'click-end',
      'type-start', 'type-end',
      'click-start', 'click-end',
    ]);
  });

  it('creates the backend lazily — no backend before first use', async () => {
    const { mgr, created } = makeManager();
    mgr.getLayer('scout', { surface: 'docker' });
    expect(created).toHaveLength(0);
    await mgr.getLayer('scout', { surface: 'docker' }).displaySize();
    expect(created).toEqual([{ resolved: 'docker', botId: 'scout' }]);
  });
});

describe('surface routing', () => {
  it('routes each surface to the right backend kind', async () => {
    const { mgr, created } = makeManager();
    for (const [surface, kind] of [
      ['local', 'local'],
      ['docker', 'docker'],
      ['browser', 'browser'],
    ] as const) {
      await mgr.getLayer(`bot-${surface}`, { surface }).displaySize();
    }
    expect(created.map((c) => c.resolved)).toEqual(['local', 'docker', 'browser']);
  });

  it('off surface throws ComputerSurfaceOffError on every method', async () => {
    const { mgr } = makeManager();
    const layer = mgr.getLayer('scout', { surface: 'off' });
    await expect(layer.screenshot()).rejects.toBeInstanceOf(ComputerSurfaceOffError);
    await expect(layer.click(1, 1)).rejects.toThrow(/disabled for bot "scout"/);
  });

  it('changing the surface drops the old instance', async () => {
    const { mgr, created } = makeManager();
    await mgr.getLayer('scout', { surface: 'local' }).displaySize();
    expect(created).toHaveLength(1);
    await mgr.setSurface('scout', 'docker');
    expect(mgr.status('scout')).toHaveLength(0);
    await mgr.getLayer('scout', { surface: 'docker' }).displaySize();
    expect(created).toHaveLength(2);
    expect(created[1].resolved).toBe('docker');
  });
});

describe('conversation pins', () => {
  it('a pin overrides the bot surface for one conversation only', async () => {
    const { mgr, created } = makeManager();
    mgr.pinSurface('scout', 'conv-1', 'browser');
    await mgr.getLayer('scout', { surface: 'local', conversationId: 'conv-1' }).displaySize();
    await mgr.getLayer('scout', { surface: 'local', conversationId: 'conv-2' }).displaySize();
    expect(created.map((c) => c.resolved)).toEqual(['browser', 'local']);
    // Pinned instance is keyed separately.
    const statuses = mgr.status('scout');
    expect(statuses.some((s) => s.pinned && s.conversationId === 'conv-1')).toBe(true);
  });

  it('clearing a pin falls back to the bot surface', async () => {
    const { mgr, created } = makeManager();
    mgr.pinSurface('scout', 'conv-1', 'off');
    await expect(
      mgr.getLayer('scout', { surface: 'local', conversationId: 'conv-1' }).displaySize(),
    ).rejects.toBeInstanceOf(ComputerSurfaceOffError);
    mgr.pinSurface('scout', 'conv-1', null);
    await mgr.getLayer('scout', { surface: 'local', conversationId: 'conv-1' }).displaySize();
    expect(created.map((c) => c.resolved)).toEqual(['local']);
  });
});

describe('lifecycle', () => {
  it('idle sweep disposes instances idle past the timeout', async () => {
    let now = 1_000_000;
    const mgr = new PerBotComputerManager({
      clock: () => now,
      idleTimeoutMs: 30 * 60 * 1000,
      createBackend: (resolved, botId) => new RecordingLayer(`${resolved}:${botId}`),
    });
    await mgr.getLayer('scout', { surface: 'local' }).displaySize();
    expect(mgr.status('scout')).toHaveLength(1);
    now += 29 * 60 * 1000;
    expect(await mgr.idleSweep()).toBe(0);
    expect(mgr.status('scout')).toHaveLength(1);
    now += 2 * 60 * 1000;
    expect(await mgr.idleSweep()).toBe(1);
    expect(mgr.status('scout')).toHaveLength(0);
  });

  it('removeBot tears down every instance incl. pinned ones', async () => {
    const { mgr } = makeManager();
    mgr.pinSurface('scout', 'conv-1', 'browser');
    await mgr.getLayer('scout', { surface: 'local' }).displaySize();
    await mgr.getLayer('scout', { surface: 'local', conversationId: 'conv-1' }).displaySize();
    expect(mgr.status('scout')).toHaveLength(2);
    await mgr.removeBot('scout');
    expect(mgr.status('scout')).toHaveLength(0);
    expect(mgr.listPins('scout')).toHaveLength(0);
  });

  it('restart drops instances; next use rebuilds', async () => {
    const { mgr, created } = makeManager();
    await mgr.getLayer('scout', { surface: 'local' }).displaySize();
    await mgr.restart('scout');
    expect(mgr.status('scout')).toHaveLength(0);
    await mgr.getLayer('scout', { surface: 'local' }).displaySize();
    expect(created).toHaveLength(2);
  });
});

describe('layerIsMock', () => {
  it('reports mock for unlaunched proxies and mock backends', () => {
    const { mgr } = makeManager();
    const proxy = mgr.getLayer('scout', { surface: 'local' });
    expect(layerIsMock(proxy)).toBe(true); // never launched: nothing real
  });

  it('reports mock for a direct mock layer, non-mock for others', () => {
    expect(layerIsMock(new MockOSScreenLayer())).toBe(true);
    const fake = {
      displaySize: async () => ({ width: 1, height: 1 }),
      screenshot: async () => ({ png: new Uint8Array(), width: 1, height: 1 }),
      click: async () => undefined,
      type: async () => undefined,
      key: async () => undefined,
      keyChord: async () => undefined,
      scroll: async () => undefined,
      drag: async () => undefined,
      move: async () => undefined,
    } as OSScreenLayer;
    expect(layerIsMock(fake)).toBe(false);
  });
});

describe('computer tool resolveOS wiring', () => {
  it('handlers resolve the layer from ctx.botId per call', async () => {
    const layers = new Map<string, RecordingLayer>();
    const tools = createComputerUseTools({
      resolveOS: (ctx: ToolContext) => {
        let l = layers.get(ctx.botId);
        if (!l) {
          l = new RecordingLayer(ctx.botId);
          layers.set(ctx.botId, l);
        }
        return l;
      },
    });
    const byName = new Map(tools.map((t) => [t.name, t]));
    const click = byName.get('computer_click')!;
    const shot = byName.get('computer_screenshot')!;
    await click.handler({ x: 50, y: 60 }, ctxFor('scout'));
    await click.handler({ x: 1, y: 2 }, ctxFor('coder'));
    await shot.handler({}, ctxFor('scout'));
    expect(layers.get('scout')!.calls).toEqual(['click:50,60', 'screenshot']);
    expect(layers.get('coder')!.calls).toEqual(['click:1,2']);
  });

  it('resolveOS errors (e.g. surface off) surface to the caller', async () => {
    const tools = createComputerUseTools({
      resolveOS: (ctx: ToolContext) => {
        throw new ComputerSurfaceOffError(ctx.botId);
      },
    });
    const type = tools.find((t) => t.name === 'computer_type')!;
    await expect(type.handler({ text: 'hi' }, ctxFor('scout'))).rejects.toBeInstanceOf(
      ComputerSurfaceOffError,
    );
  });

  it('without resolveOS the shared os instance is used (backward compatible)', async () => {
    const shared = new RecordingLayer('shared');
    const tools = createComputerUseTools({ os: shared });
    const move = tools.find((t) => t.name === 'computer_move')!;
    await move.handler({ x: 5, y: 6 }, ctxFor('any-bot'));
    expect(shared.calls).toEqual(['move:5,6']);
  });
});
