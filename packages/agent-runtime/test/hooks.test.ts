// SPDX-License-Identifier: Apache-2.0
// Hooks + plugin loader tests. Zero paid APIs; the "plugin" fixtures are
// local .mjs files written to a temp dir.

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HookBus, loadPlugins } from '../src/hooks.js';

describe('HookBus', () => {
  it('emits payloads to registered handlers in order', async () => {
    const bus = new HookBus();
    const seen: string[] = [];
    bus.on('session.created', (p) => {
      seen.push(`a:${(p as { sessionId: string }).sessionId}`);
    });
    bus.on('session.created', (p) => {
      seen.push(`b:${(p as { sessionId: string }).sessionId}`);
    });
    const res = await bus.emit('session.created', { sessionId: 's1', botId: 'b1' });
    expect(res.cancelled).toBe(false);
    expect(res.errors).toEqual([]);
    expect(seen).toEqual(['a:s1', 'b:s1']);
  });

  it('cancels tool.before when a handler returns { cancel: true }', async () => {
    const bus = new HookBus();
    bus.on('tool.before', () => ({ cancel: true, reason: 'nope' }) as const);
    const res = await bus.emit('tool.before', { sessionId: 's', botId: 'b', toolName: 'run_command', args: {} });
    expect(res.cancelled).toBe(true);
    expect(res.reason).toBe('nope');
  });

  it('does not cancel tool.after (cancellation only honored for tool.before)', async () => {
    const bus = new HookBus();
    bus.on('tool.after', () => ({ cancel: true, reason: 'nope' }) as const);
    const res = await bus.emit('tool.after', {
      sessionId: 's',
      botId: 'b',
      toolName: 'run_command',
      args: {},
      ok: true,
      durationMs: 1,
    });
    expect(res.cancelled).toBe(false);
  });

  it('collects handler errors without throwing', async () => {
    const bus = new HookBus();
    bus.on('tool.before', () => {
      throw new Error('boom');
    });
    let ran = false;
    bus.on('tool.before', () => {
      ran = true;
    });
    const res = await bus.emit('tool.before', { sessionId: 's', botId: 'b', toolName: 'x', args: {} });
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]!.message).toBe('boom');
    expect(ran).toBe(true);
    expect(res.cancelled).toBe(false);
  });

  it('once() runs at most once and unsub works', async () => {
    const bus = new HookBus();
    let n = 0;
    bus.once('session.created', () => {
      n++;
    });
    await bus.emit('session.created', { sessionId: 's', botId: 'b' });
    await bus.emit('session.created', { sessionId: 's', botId: 'b' });
    expect(n).toBe(1);

    const unsub = bus.on('session.created', () => {
      n += 10;
    });
    expect(bus.handlerCount('session.created')).toBe(1);
    unsub();
    await bus.emit('session.created', { sessionId: 's', botId: 'b' });
    expect(n).toBe(1);
  });
});

describe('loadPlugins', () => {
  function makeDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'kriyadot-plugins-'));
    return dir;
  }

  it('loads plugins, skips bad modules, reports failures', async () => {
    const dir = makeDir();
    try {
      writeFileSync(
        join(dir, 'good.mjs'),
        `export default function activate(bus) { bus.on('tool.before', () => ({})); }\nexport const name = 'good-plugin';\nexport const version = '0.1.0';\n`,
      );
      writeFileSync(
        join(dir, 'named.mjs'),
        `export function activate(bus) { bus.on('session.created', () => {}); }\n`,
      );
      writeFileSync(join(dir, 'broken.mjs'), `throw new Error('load boom');\n`);
      writeFileSync(join(dir, 'noactivate.mjs'), `export const x = 1;\n`);
      writeFileSync(join(dir, 'skip.txt'), `not a plugin\n`);

      const bus = new HookBus();
      const report = await loadPlugins(dir, bus);
      expect(report.loaded.map((p) => p.name).sort()).toEqual(['good-plugin', 'named.mjs']);
      expect(report.loaded.find((p) => p.name === 'good-plugin')!.version).toBe('0.1.0');
      expect(report.failed.map((f) => f.file)).toHaveLength(2); // broken + noactivate
      expect(bus.handlerCount('tool.before')).toBe(1);
      expect(bus.handlerCount('session.created')).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('missing directory loads nothing without throwing', async () => {
    const report = await loadPlugins(join(tmpdir(), 'kriyadot-no-such-dir-xyz'), new HookBus());
    expect(report.loaded).toEqual([]);
    expect(report.failed).toEqual([]);
  });
});
