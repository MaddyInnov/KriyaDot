// SPDX-License-Identifier: Apache-2.0
// SCH-14 — hook lifecycle contract: starts disabled, dry-run never
// executes, terminal auto-disable after repeated failures, secret
// scanning refuses credential-carrying configs.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HookLifecycleRegistry,
  HookRegistrationError,
  createHookLifecycleRouter,
  scanHookConfigForSecrets,
} from '../src/hook-lifecycle.js';

describe('scanHookConfigForSecrets', () => {
  it('finds planted keys, tokens and inline credential assignments', () => {
    const findings = scanHookConfigForSecrets({
      command: ['node', 'hook.mjs', '--key', 'sk-1234567890abcdefghijklmnop'],
      env: { NOTE: 'password=hunter2hunter2' },
    });
    const kinds = findings.map((f) => f.kind);
    expect(kinds).toContain('openai-style-api-key');
    expect(kinds).toContain('inline-credential-assignment');
    // Findings are redacted — the full secret never appears.
    expect(JSON.stringify(findings)).not.toContain('sk-1234567890abcdefghijklmnop');
    expect(JSON.stringify(findings)).not.toContain('hunter2hunter2');
  });

  it('passes clean configs (vault references are fine)', () => {
    expect(
      scanHookConfigForSecrets({ command: ['node', 'check.mjs'], env: { KEY_REF: 'vault:provider-key' } }),
    ).toEqual([]);
  });
});

describe('HookLifecycleRegistry (SCH-14)', () => {
  let dir: string;
  let registry: HookLifecycleRegistry;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hook-lifecycle-'));
    registry = new HookLifecycleRegistry(dir, { maxConsecutiveFailures: 3 });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses registration when the config carries a secret', () => {
    expect(() =>
      registry.register({
        name: 'leaky',
        events: ['tool.after'],
        config: { command: ['node', 'x.mjs', 'ghp_1234567890abcdefghijklmnopqrst'] },
      }),
    ).toThrow(HookRegistrationError);
    expect(registry.list()).toHaveLength(0);
  });

  it('starts disabled: the wrapped handler is a no-op until enabled', async () => {
    const hook = registry.register({ name: 'audit', events: ['tool.after'], config: { command: ['node', 'a.mjs'] } });
    expect(hook.state).toBe('disabled');
    let calls = 0;
    const wrapped = registry.wrap(hook.id, async () => {
      calls += 1;
    });
    await wrapped({});
    expect(calls).toBe(0);

    registry.enable(hook.id);
    await wrapped({});
    expect(calls).toBe(1);
    expect(registry.get(hook.id)?.totalRuns).toBe(1);
  });

  it('dry-run records the invocation and NEVER executes the handler', async () => {
    const hook = registry.register({ name: 'notify', events: ['tool.after'], config: {} });
    let calls = 0;
    const wrapped = registry.wrap(hook.id, async () => {
      calls += 1;
    });

    const result = registry.dryRun(hook.id, 'tool.after', { tool: 'send_email' });
    expect(result.recorded).toBe(true);
    expect(registry.dryRunLog(hook.id)).toHaveLength(1);
    expect(registry.dryRunLog(hook.id)[0]?.payloadPreview).toContain('send_email');

    registry.setDryRunMode(hook.id, true);
    await wrapped({ tool: 'send_email' });
    expect(calls).toBe(0);
    expect(registry.get(hook.id)?.dryRuns).toBe(2);
    expect(registry.get(hook.id)?.totalRuns).toBe(0);
  });

  it('auto-disables terminally after 3 consecutive failures; re-enable resets', async () => {
    const hook = registry.register({ name: 'flaky', events: ['tool.after'], config: {} });
    registry.enable(hook.id);
    const failing = registry.wrap(hook.id, async () => {
      throw new Error('handler exploded');
    });
    await expect(failing({})).rejects.toThrow('handler exploded');
    await expect(failing({})).rejects.toThrow('handler exploded');
    expect(registry.get(hook.id)?.state).toBe('enabled');
    await expect(failing({})).rejects.toThrow('handler exploded');

    const after = registry.get(hook.id);
    expect(after?.state).toBe('auto-disabled');
    expect(after?.autoDisableReason).toContain('3 consecutive handler failures');
    expect(after?.totalFailures).toBe(3);

    // Terminal: further emits are no-ops (handler not even called).
    let calls = 0;
    const wrapped = registry.wrap(hook.id, async () => {
      calls += 1;
    });
    await wrapped({});
    expect(calls).toBe(0);

    // A human re-enable resets the streak.
    const reenabled = registry.enable(hook.id);
    expect(reenabled.state).toBe('enabled');
    expect(reenabled.consecutiveFailures).toBe(0);
    expect(reenabled.autoDisabledAt).toBeUndefined();
  });

  it('a success resets the consecutive-failure streak', async () => {
    const hook = registry.register({ name: 'mixed', events: ['tool.after'], config: {} });
    registry.enable(hook.id);
    let shouldFail = true;
    const wrapped = registry.wrap(hook.id, async () => {
      if (shouldFail) throw new Error('nope');
    });
    await expect(wrapped({})).rejects.toThrow();
    await expect(wrapped({})).rejects.toThrow();
    shouldFail = false;
    await wrapped({});
    expect(registry.get(hook.id)?.consecutiveFailures).toBe(0);
    shouldFail = true;
    await expect(wrapped({})).rejects.toThrow();
    await expect(wrapped({})).rejects.toThrow();
    expect(registry.get(hook.id)?.state).toBe('enabled');
  });

  it('registers Wave-3 script-hook entries under lifecycle management', () => {
    const hooks = registry.registerScriptHooks([
      { kind: 'script', command: ['node', 'check.mjs'], events: ['tool.after'], name: 'checker' },
    ]);
    expect(hooks).toHaveLength(1);
    expect(hooks[0]?.name).toBe('checker');
    expect(hooks[0]?.state).toBe('disabled');
  });

  it('serves lifecycle state + dry-run over HTTP', async () => {
    const hook = registry.register({ name: 'web', events: ['tool.after'], config: {} });
    const app = express();
    app.use(express.json());
    app.use('/api', createHookLifecycleRouter({ registry }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}/api/hooks/lifecycle`;
    try {
      const list = (await (await fetch(base)).json()) as { hooks: Array<{ id: string; state: string }> };
      expect(list.hooks[0]?.state).toBe('disabled');

      const dry = await fetch(`${base}/${hook.id}/dry-run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event: 'tool.after', payload: { x: 1 } }),
      });
      expect(dry.status).toBe(200);

      const enable = await fetch(`${base}/${hook.id}/enable`, { method: 'POST' });
      expect(enable.status).toBe(200);
      expect(registry.get(hook.id)?.state).toBe('enabled');

      const missing = await fetch(`${base}/ghost/enable`, { method: 'POST' });
      expect(missing.status).toBe(404);
    } finally {
      server.close();
    }
  });
});
