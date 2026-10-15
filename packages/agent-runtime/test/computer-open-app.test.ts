// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, GovernanceGateway, mergeBotPolicy } from '@mvp/governance';
import {
  APP_ALIASES,
  COMPUTER_TOOL_NAMES,
  OPEN_APP_TOOL_NAME,
  computerUsePolicyRules,
  createOpenAppTool,
  normalizeAppName,
  registerComputerUseTool,
  resolveLaunchAttempts,
  validateAppName,
} from '../src/tools/computer.js';
import type { AppLauncher, LaunchAttempt, ToolContext, ToolDefinition } from '../src/tools/computer.js';

const ctx: ToolContext = { sessionId: 's1', botId: 'b1' };

/** Recording mock launcher: never spawns a real process. */
class MockLauncher implements AppLauncher {
  readonly attempts: LaunchAttempt[] = [];
  failOn: number[] = []; // attempt indexes that should throw
  async launch(attempt: LaunchAttempt): Promise<void> {
    const idx = this.attempts.length;
    this.attempts.push(attempt);
    if (this.failOn.includes(idx)) throw new Error(`mock launch failure #${idx}`);
  }
}

function toolWith(launcher: MockLauncher, platform: 'win32' | 'darwin' | 'linux' = 'win32'): ToolDefinition {
  return createOpenAppTool({ launcher, platform });
}

describe('tool definition', () => {
  it('is registered under the canonical name with an app parameter', () => {
    const registry = new Map<string, ToolDefinition>();
    registerComputerUseTool(registry, { appLauncher: new MockLauncher(), platform: 'win32' });
    const tool = registry.get(COMPUTER_TOOL_NAMES.openApp);
    expect(tool).toBeDefined();
    expect(tool!.name).toBe('computer_open_app');
    expect(tool!.name).toBe(OPEN_APP_TOOL_NAME);
    const schema = tool!.parameters as Record<string, unknown>;
    expect((schema['required'] as string[])).toContain('app');
  });
});

describe('normalizeAppName', () => {
  it('resolves "whatsapp desktop" to the whatsapp alias', () => {
    expect(normalizeAppName('WhatsApp Desktop')).toBe('whatsapp');
    expect(normalizeAppName('  CHROME  ')).toBe('chrome');
    expect(normalizeAppName('Spotify App')).toBe('spotify');
  });
});

describe('validateAppName', () => {
  it('rejects empty, over-long, and unsafe names', () => {
    expect(() => validateAppName('')).toThrow(/non-empty/);
    expect(() => validateAppName('   ')).toThrow(/non-empty/);
    expect(() => validateAppName('x'.repeat(121))).toThrow(/too long/);
    expect(() => validateAppName('foo & bar')).toThrow(/unsafe/);
    expect(() => validateAppName('a;rm -rf /')).toThrow(/unsafe/);
    expect(() => validateAppName('$(whoami)')).toThrow(/unsafe/);
    expect(validateAppName('whatsapp')).toBe('whatsapp');
  });
});

describe('resolveLaunchAttempts', () => {
  it('resolves whatsapp on Windows to the URI scheme first, then the exe', () => {
    const attempts = resolveLaunchAttempts('whatsapp', 'win32');
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    expect(attempts[0]!.label).toBe('URI scheme whatsapp:');
    expect(attempts[0]!.command).toBe('cmd');
    expect(attempts[0]!.args).toEqual(['/c', 'start', '', 'whatsapp:']);
    expect(attempts[1]!.label).toBe('start WhatsApp.exe');
  });

  it('resolves chrome/notepad/calculator on Windows to their exes', () => {
    expect(resolveLaunchAttempts('chrome', 'win32')[0]!.args).toEqual(['/c', 'start', '', 'chrome.exe']);
    expect(resolveLaunchAttempts('notepad', 'win32')[0]!.args).toEqual(['/c', 'start', '', 'notepad.exe']);
    expect(resolveLaunchAttempts('calculator', 'win32')[0]!.args).toEqual(['/c', 'start', '', 'calc.exe']);
  });

  it('resolves apps on macOS via open -a', () => {
    const attempts = resolveLaunchAttempts('whatsapp', 'darwin');
    expect(attempts[0]).toEqual({ command: 'open', args: ['-a', 'WhatsApp'], label: 'open -a "WhatsApp"' });
    expect(resolveLaunchAttempts('chrome', 'darwin')[0]!.args).toEqual(['-a', 'Google Chrome']);
  });

  it('resolves apps on Linux to binaries', () => {
    const attempts = resolveLaunchAttempts('chrome', 'linux');
    expect(attempts[0]!.command).toBe('google-chrome');
  });

  it('falls back to the raw name for unknown apps', () => {
    const win = resolveLaunchAttempts('myobscureapp', 'win32');
    expect(win).toHaveLength(1);
    expect(win[0]!.args).toEqual(['/c', 'start', '', 'myobscureapp']);
    const mac = resolveLaunchAttempts('myobscureapp', 'darwin');
    expect(mac[0]!.args).toEqual(['-a', 'Myobscureapp']);
  });

  it('uses no shell: every attempt is a command + argv array', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      for (const attempts of [
        resolveLaunchAttempts('whatsapp', platform),
        resolveLaunchAttempts('unknown-app-xyz', platform),
      ]) {
        for (const a of attempts) {
          expect(typeof a.command).toBe('string');
          expect(Array.isArray(a.args)).toBe(true);
          expect(a.args.every((x) => typeof x === 'string')).toBe(true);
        }
      }
    }
  });
});

describe('alias map', () => {
  it('covers the common apps from the bug report and everyday use', () => {
    for (const key of ['whatsapp', 'chrome', 'firefox', 'notepad', 'calculator', 'spotify', 'vscode', 'telegram', 'discord', 'slack', 'zoom']) {
      expect(APP_ALIASES[key], `alias missing: ${key}`).toBeDefined();
    }
  });
});

describe('handler', () => {
  it('launches via the first successful candidate and reports what was used', async () => {
    const launcher = new MockLauncher();
    const res = (await toolWith(launcher).handler({ app: 'whatsapp desktop' }, ctx)) as {
      launched: boolean; app: string; via: string; attempted: string[];
    };
    expect(res.launched).toBe(true);
    expect(res.app).toBe('whatsapp desktop');
    expect(res.via).toBe('URI scheme whatsapp:');
    expect(launcher.attempts).toHaveLength(1);
    expect(launcher.attempts[0]!.args).toEqual(['/c', 'start', '', 'whatsapp:']);
  });

  it('falls through to the next candidate when one fails', async () => {
    const launcher = new MockLauncher();
    launcher.failOn = [0]; // URI scheme fails, exe should be tried next
    const res = (await toolWith(launcher).handler({ app: 'whatsapp' }, ctx)) as {
      launched: boolean; via: string;
    };
    expect(res.launched).toBe(true);
    expect(res.via).toBe('start WhatsApp.exe');
    expect(launcher.attempts).toHaveLength(2);
  });

  it('never throws unhandled: returns launched=false with the attempted list', async () => {
    const launcher = new MockLauncher();
    launcher.failOn = [0, 1, 2, 3, 4, 5]; // everything fails
    const res = (await toolWith(launcher).handler({ app: 'whatsapp' }, ctx)) as {
      launched: boolean; attempted: string[]; error: string;
    };
    expect(res.launched).toBe(false);
    expect(res.attempted.length).toBeGreaterThan(0);
    expect(typeof res.error).toBe('string');
  });

  it('rejects unsafe app names before touching the launcher', async () => {
    const launcher = new MockLauncher();
    await expect(toolWith(launcher).handler({ app: 'a & b' }, ctx)).rejects.toThrow(/unsafe/);
    expect(launcher.attempts).toHaveLength(0);
  });
});

describe('approval gating', () => {
  const gateways: GovernanceGateway[] = [];
  afterEach(() => {
    for (const gw of gateways.splice(0)) gw.close();
  });

  it('computer_open_app evaluates to require-approval', async () => {
    const gw = new GovernanceGateway({
      dbPath: ':memory:',
      policy: mergeBotPolicy(DEFAULT_POLICY, { rules: computerUsePolicyRules() }),
    });
    gateways.push(gw);
    const res = await gw.evaluate(COMPUTER_TOOL_NAMES.openApp, { app: 'whatsapp' }, {
      sessionId: 's1', botId: 'b1', actor: 'b1',
    });
    expect(res.effect).toBe('require-approval');
    expect(typeof res.approvalId).toBe('string');
  });

  it('existing tools keep their exact approval semantics', async () => {
    const gw = new GovernanceGateway({
      dbPath: ':memory:',
      policy: mergeBotPolicy(DEFAULT_POLICY, { rules: computerUsePolicyRules() }),
    });
    gateways.push(gw);
    const evalCtx = { sessionId: 's1', botId: 'b1', actor: 'b1' };
    // Screenshot still auto-allows; click/type/key still require approval.
    expect((await gw.evaluate(COMPUTER_TOOL_NAMES.screenshot, {}, evalCtx)).effect).toBe('allow');
    for (const name of [COMPUTER_TOOL_NAMES.click, COMPUTER_TOOL_NAMES.type, COMPUTER_TOOL_NAMES.key]) {
      expect((await gw.evaluate(name, {}, evalCtx)).effect).toBe('require-approval');
    }
  });
});
