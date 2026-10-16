// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, GovernanceGateway, mergeBotPolicy } from '@mvp/governance';
import {
  COMPUTER_KEY_ALLOWLIST,
  COMPUTER_TOOL_NAMES,
  MockOSScreenLayer,
  computerUsePolicyRules,
  createComputerUseTools,
  registerComputerUseTool,
} from '../src/tools/computer.js';
import type { ToolContext, ToolDefinition } from '../src/types.js';

const ctx: ToolContext = { sessionId: 's1', botId: 'b1' };

const gateways: GovernanceGateway[] = [];
afterEach(() => {
  for (const gw of gateways.splice(0)) gw.close();
});

function gatewayWithComputerPolicy(): GovernanceGateway {
  const gw = new GovernanceGateway({
    dbPath: ':memory:',
    policy: mergeBotPolicy(DEFAULT_POLICY, { rules: computerUsePolicyRules() }),
  });
  gateways.push(gw);
  return gw;
}

function freshRegistry(os?: MockOSScreenLayer): { registry: Map<string, ToolDefinition>; os: MockOSScreenLayer } {
  const layer = os ?? new MockOSScreenLayer();
  const registry = new Map<string, ToolDefinition>();
  registerComputerUseTool(registry, { os: layer });
  return { registry, os: layer };
}

describe('registration', () => {
  it('registers eight tools with the canonical names', () => {
    const { registry } = freshRegistry();
    expect([...registry.keys()].sort()).toEqual([
      COMPUTER_TOOL_NAMES.click,
      COMPUTER_TOOL_NAMES.drag,
      COMPUTER_TOOL_NAMES.key,
      COMPUTER_TOOL_NAMES.move,
      COMPUTER_TOOL_NAMES.openApp,
      COMPUTER_TOOL_NAMES.screenshot,
      COMPUTER_TOOL_NAMES.scroll,
      COMPUTER_TOOL_NAMES.type,
    ]);
  });

  it('refuses to shadow an already-registered tool', () => {
    const { registry } = freshRegistry();
    expect(() => registerComputerUseTool(registry)).toThrow(/collision/);
  });

  it('createComputerUseTools defaults to a safe mock layer', async () => {
    const [shot] = createComputerUseTools();
    const res = (await shot?.handler({}, ctx)) as { pngBase64: string };
    expect(typeof res.pngBase64).toBe('string');
  });
});

describe('computer_screenshot', () => {
  it('returns a decodable PNG fixture with display geometry', async () => {
    const { registry, os } = freshRegistry();
    const tool = registry.get(COMPUTER_TOOL_NAMES.screenshot)!;
    const res = (await tool.handler({}, ctx)) as { width: number; height: number; pngBase64: string };
    expect(res.width).toBe(1920);
    expect(res.height).toBe(1080);
    const bytes = Buffer.from(res.pngBase64, 'base64');
    // PNG magic bytes
    expect([...bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(os.callsOf('screenshot')).toHaveLength(1);
  });
});

describe('computer_click', () => {
  it('clicks within bounds and records the call (defaults: left, single)', async () => {
    const { registry, os } = freshRegistry();
    const res = await registry.get(COMPUTER_TOOL_NAMES.click)!.handler({ x: 100, y: 200 }, ctx);
    expect(res).toEqual({ clicked: { x: 100, y: 200, button: 'left', clicks: 1 } });
    expect(os.callsOf('click')).toEqual([{ x: 100, y: 200, button: 'left', clicks: 1 }]);
  });

  it('supports right-click and double-click', async () => {
    const { registry, os } = freshRegistry();
    const tool = registry.get(COMPUTER_TOOL_NAMES.click)!;
    const res = await tool.handler({ x: 50, y: 60, button: 'right', clicks: 2 }, ctx);
    expect(res).toEqual({ clicked: { x: 50, y: 60, button: 'right', clicks: 2 } });
    expect(os.callsOf('click')).toEqual([{ x: 50, y: 60, button: 'right', clicks: 2 }]);
  });

  it('rejects invalid button and clicks values', async () => {
    const { registry, os } = freshRegistry();
    const tool = registry.get(COMPUTER_TOOL_NAMES.click)!;
    await expect(tool.handler({ x: 10, y: 10, button: 'side' }, ctx)).rejects.toThrow(/"button" must be one of/);
    await expect(tool.handler({ x: 10, y: 10, clicks: 3 }, ctx)).rejects.toThrow(/"clicks" must be 1/);
    await expect(tool.handler({ x: 10, y: 10, clicks: 0 }, ctx)).rejects.toThrow(/"clicks" must be 1/);
    expect(os.callsOf('click')).toHaveLength(0);
  });

  it('rejects out-of-bounds coordinates', async () => {
    const { registry, os } = freshRegistry();
    const tool = registry.get(COMPUTER_TOOL_NAMES.click)!;
    await expect(tool.handler({ x: 1920, y: 10 }, ctx)).rejects.toThrow(/outside/);
    await expect(tool.handler({ x: -1, y: 10 }, ctx)).rejects.toThrow(/outside/);
    await expect(tool.handler({ x: 'a' }, ctx)).rejects.toThrow(/must be a number/);
    expect(os.callsOf('click')).toHaveLength(0); // nothing reached the OS layer
  });
});

describe('computer_type', () => {
  it('types text and reports char count', async () => {
    const { registry, os } = freshRegistry();
    const res = await registry.get(COMPUTER_TOOL_NAMES.type)!.handler({ text: 'hello' }, ctx);
    expect(res).toEqual({ typedChars: 5 });
    expect(os.callsOf('type')).toEqual([{ text: 'hello' }]);
  });

  it('rejects empty and over-long text', async () => {
    const { registry, os } = freshRegistry();
    const tool = registry.get(COMPUTER_TOOL_NAMES.type)!;
    await expect(tool.handler({ text: '' }, ctx)).rejects.toThrow(/non-empty/);
    await expect(tool.handler({ text: 'x'.repeat(2001) }, ctx)).rejects.toThrow(/too long/);
    expect(os.callsOf('type')).toHaveLength(0);
  });
});

describe('computer_key', () => {
  it('presses allowlisted single keys (backward compatible)', async () => {
    const { registry, os } = freshRegistry();
    const tool = registry.get(COMPUTER_TOOL_NAMES.key)!;
    expect(COMPUTER_KEY_ALLOWLIST.has('Enter')).toBe(true);
    const res = await tool.handler({ name: 'Enter' }, ctx);
    expect(res).toEqual({ pressed: 'Enter' });
    await expect(tool.handler({ name: 'F13' }, ctx)).rejects.toThrow(/allowlist/);
    await expect(tool.handler({ name: '' }, ctx)).rejects.toThrow(/non-empty/);
    expect(os.callsOf('key')).toEqual([{ name: 'Enter' }]);
    expect(os.callsOf('keychord')).toHaveLength(0);
  });

  it('accepts chords and routes them to keyChord', async () => {
    const { registry, os } = freshRegistry();
    const tool = registry.get(COMPUTER_TOOL_NAMES.key)!;
    const res = await tool.handler({ name: 'ctrl+alt+del' }, ctx);
    expect(res).toEqual({ pressed: 'ctrl+alt+del', chord: 'ctrl+alt+Delete' });
    expect(os.callsOf('keychord')).toEqual([{ modifiers: ['ctrl', 'alt'], key: 'Delete' }]);
    expect(os.callsOf('key')).toHaveLength(0);
  });

  it('resolves hotkey presets per platform', async () => {
    const { registry, os } = freshRegistry();
    const tool = registry.get(COMPUTER_TOOL_NAMES.key)!;
    // freshRegistry() uses the mock platform default (process.platform);
    // 'copy' must resolve to a single-modifier + 'c' chord on any platform.
    const res = (await tool.handler({ name: 'copy' }, ctx)) as { hotkey: string; chord: string };
    expect(res.hotkey).toBe('copy');
    expect(res.chord).toMatch(/^[a-z]+\+c$/);
    const [chord] = os.callsOf('keychord');
    expect(chord.key).toBe('c');
    expect((chord.modifiers as string[])).toHaveLength(1);
  });

  it('chords and hotkeys are still approval-gated like the base key tool', async () => {
    const gw = gatewayWithComputerPolicy();
    const evalCtx = { sessionId: 's1', botId: 'b1', actor: 'b1' };
    for (const name of ['ctrl+c', 'copy', 'Enter', 'alt+tab']) {
      const res = await gw.evaluate(COMPUTER_TOOL_NAMES.key, { name }, evalCtx);
      expect(res.effect, name).toBe('require-approval');
    }
  });
});

describe('approval gating (governance pattern)', () => {
  const evalCtx = { sessionId: 's1', botId: 'b1', actor: 'b1' };

  it('mutating actions evaluate to require-approval with a minted approval id', async () => {
    const gw = gatewayWithComputerPolicy();
    for (const name of [
      COMPUTER_TOOL_NAMES.click,
      COMPUTER_TOOL_NAMES.type,
      COMPUTER_TOOL_NAMES.key,
      COMPUTER_TOOL_NAMES.openApp,
    ]) {
      const res = await gw.evaluate(name, {}, evalCtx);
      expect(res.effect).toBe('require-approval');
      expect(typeof res.approvalId).toBe('string');
    }
  });

  it('screenshot evaluates to allow', async () => {
    const gw = gatewayWithComputerPolicy();
    const res = await gw.evaluate(COMPUTER_TOOL_NAMES.screenshot, {}, evalCtx);
    expect(res.effect).toBe('allow');
    expect(res.approvalId).toBeUndefined();
  });

  it('deny-by-default still holds: without the explicit rules the default policy gates mutating tools', async () => {
    const gw = new GovernanceGateway({ dbPath: ':memory:', policy: DEFAULT_POLICY });
    gateways.push(gw);
    // DEFAULT_POLICY.defaultEffect is 'require-approval': unknown tools never auto-run.
    const res = await gw.evaluate(COMPUTER_TOOL_NAMES.click, {}, evalCtx);
    expect(res.effect).toBe('require-approval');
  });

  it('a denied approval blocks the handler from ever running (runtime pattern)', async () => {
    const gw = gatewayWithComputerPolicy();
    const { registry, os } = freshRegistry();
    const evaluated = await gw.evaluate(COMPUTER_TOOL_NAMES.click, { x: 10, y: 10 }, evalCtx);
    expect(evaluated.effect).toBe('require-approval');
    // Human denies in the approvals inbox:
    gw.decide(evaluated.approvalId!, 'denied');
    const verdict = await gw.awaitDecision(evaluated.approvalId!, 1000);
    expect(verdict).toBe('denied');
    // The runtime would NOT call the handler on a denied verdict — assert the layer stayed untouched:
    expect(os.callsOf('click')).toHaveLength(0);
    expect(registry.has(COMPUTER_TOOL_NAMES.click)).toBe(true);
  });
});
