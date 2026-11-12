// SPDX-License-Identifier: Apache-2.0
// A14: OS service install — generator output correctness, dry-run
// changes nothing (filesystem diff), and a real install/uninstall
// cycle of the systemd user unit in a sandboxed XDG_CONFIG_HOME with
// systemctl faked (this VM has no user bus; the file cycle is what's
// proven here, the systemctl step is machine-only — see A14 log).
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import {
  renderLaunchdPlist,
  renderSystemdUserUnit,
  renderWindowsTaskXml,
  ServiceInstallManager,
  SERVICE_LAUNCHD_LABEL,
  SERVICE_TASK_NAME,
  SERVICE_UNIT_NAME,
  type CommandResult,
  type ServiceSpec,
} from '../src/service.js';
import { makeDeps, makeFakeApi } from './fake-api.js';

const SPEC: ServiceSpec = { execPath: '/opt/kriyadot/kriyadot-server', execArgs: ['--port', '4000'] };

let root = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'service-a14-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, prefix: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      out.push(prefix + e.name);
      if (e.isDirectory()) walk(join(d, e.name), `${prefix}${e.name}/`);
    }
  };
  walk(dir, '');
  return out.sort();
}

describe('generators', () => {
  it('systemd user unit carries the exec, restart policy and install target', () => {
    const unit = renderSystemdUserUnit(SPEC);
    expect(unit).toContain('[Unit]');
    expect(unit).toContain('Description=KriyaDot server');
    expect(unit).toContain('[Service]');
    expect(unit).toContain('ExecStart=/opt/kriyadot/kriyadot-server --port 4000');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('[Install]');
    expect(unit).toContain('WantedBy=default.target');
  });

  it('systemd unit renders DATA_DIR and quotes paths with spaces', () => {
    const unit = renderSystemdUserUnit({ execPath: '/opt/my dir/server', execArgs: [], dataDir: '/var/lib/kd data' });
    expect(unit).toContain('ExecStart="/opt/my dir/server"');
    expect(unit).toContain('Environment=DATA_DIR="/var/lib/kd data"');
  });

  it('launchd plist carries the label, program arguments and keep-alive', () => {
    const plist = renderLaunchdPlist(SPEC);
    expect(plist).toContain(`<string>${SERVICE_LAUNCHD_LABEL}</string>`);
    expect(plist).toContain('<string>/opt/kriyadot/kriyadot-server</string>');
    expect(plist).toContain('<string>--port</string>');
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<key>KeepAlive</key>');
  });

  it('windows task XML carries the logon trigger and the exec command', () => {
    const xml = renderWindowsTaskXml(SPEC);
    expect(xml).toContain('<LogonTrigger>');
    expect(xml).toContain('<Command>/opt/kriyadot/kriyadot-server</Command>');
    expect(xml).toContain('<Arguments>--port 4000</Arguments>');
    expect(xml).toContain('<RestartOnFailure>');
  });

  it('plan paths land in the per-OS service locations', () => {
    const home = join(root, 'home');
    const linux = new ServiceInstallManager({ platform: 'linux', homeDir: home, xdgConfigHome: join(root, 'xdg') });
    expect(linux.filePath()).toBe(join(root, 'xdg', 'systemd', 'user', SERVICE_UNIT_NAME));
    const mac = new ServiceInstallManager({ platform: 'darwin', homeDir: home });
    expect(mac.filePath()).toBe(join(home, 'Library', 'LaunchAgents', `${SERVICE_LAUNCHD_LABEL}.plist`));
    const win = new ServiceInstallManager({ platform: 'win32', homeDir: home, configDir: join(root, 'cfg') });
    expect(win.filePath()).toBe(join(root, 'cfg', 'service', 'kriyadot-task.xml'));
    expect(win.plan(SPEC).commands[0]).toEqual(['schtasks', '/Create', '/TN', SERVICE_TASK_NAME, '/XML', win.filePath(), '/F']);
  });
});

describe('install/uninstall cycle (sandboxed XDG_CONFIG_HOME, faked systemctl)', () => {
  function fakeRunner(calls: string[][]): (argv: string[]) => CommandResult {
    return (argv) => {
      calls.push(argv);
      return { argv, ok: true, detail: 'ok' };
    };
  }

  it('writes the unit, registers it, then removes exactly that file', () => {
    const calls: string[][] = [];
    const manager = new ServiceInstallManager({
      platform: 'linux',
      homeDir: join(root, 'home'),
      xdgConfigHome: join(root, 'xdg'),
      runCommand: fakeRunner(calls),
    });
    const { plan, commandResults } = manager.install(SPEC);
    expect(existsSync(plan.filePath)).toBe(true);
    expect(readFileSync(plan.filePath, 'utf8')).toBe(plan.contents);
    expect(commandResults.every((r) => r.ok)).toBe(true);
    expect(calls).toEqual([
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', SERVICE_UNIT_NAME],
    ]);
    expect(manager.status(SPEC)).toEqual({ installed: true, current: true, filePath: plan.filePath });

    // A stale spec reports not-current.
    expect(manager.status({ ...SPEC, execArgs: ['--port', '9999'] }).current).toBe(false);

    const un = manager.uninstall(SPEC);
    expect(un.removed).toBe(true);
    expect(existsSync(plan.filePath)).toBe(false);
    expect(calls.slice(2)).toEqual([
      ['systemctl', '--user', 'disable', '--now', SERVICE_UNIT_NAME],
      ['systemctl', '--user', 'daemon-reload'],
    ]);
    expect(manager.status(SPEC).installed).toBe(false);
    // Uninstall again: no file, no throw.
    expect(manager.uninstall(SPEC).removed).toBe(false);
  });

  it('a failing registration command is reported, not hidden', () => {
    const manager = new ServiceInstallManager({
      platform: 'linux',
      homeDir: join(root, 'home'),
      xdgConfigHome: join(root, 'xdg'),
      runCommand: (argv) => ({ argv, ok: false, detail: 'Failed to connect to bus: No medium found' }),
    });
    const { plan, commandResults } = manager.install(SPEC);
    expect(existsSync(plan.filePath)).toBe(true);
    expect(commandResults.map((r) => r.ok)).toEqual([false, false]);
    expect(commandResults[0]!.detail).toMatch(/bus/);
  });
});

describe('kriyadot service command — dry-run by default', () => {
  function withSandboxEnv<T>(fn: () => Promise<T>): Promise<T> {
    const prev = { HOME: process.env.HOME, XDG: process.env.XDG_CONFIG_HOME, CFG: process.env.KRIYADOT_CONFIG_DIR };
    process.env.HOME = join(root, 'home');
    process.env.XDG_CONFIG_HOME = join(root, 'xdg');
    process.env.KRIYADOT_CONFIG_DIR = join(root, 'cfg');
    return fn().finally(() => {
      if (prev.HOME === undefined) delete process.env.HOME;
      else process.env.HOME = prev.HOME;
      if (prev.XDG === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prev.XDG;
      if (prev.CFG === undefined) delete process.env.KRIYADOT_CONFIG_DIR;
      else process.env.KRIYADOT_CONFIG_DIR = prev.CFG;
    });
  }

  it('install dry-run prints the unit and changes nothing on disk', async () => {
    await withSandboxEnv(async () => {
      writeFileSync(join(root, 'marker.txt'), 'keep me');
      const before = tree(root);
      const deps = makeDeps(makeFakeApi({}));
      const code = await runCommand(parseArgs(['service', 'install', '--exec', '/opt/kriyadot/kriyadot-server', '--port', '4000']), deps);
      expect(code).toBe(0);
      const text = deps.stdoutText();
      expect(text).toContain('ExecStart=/opt/kriyadot/kriyadot-server --port 4000');
      expect(text).toContain(join(root, 'xdg', 'systemd', 'user', SERVICE_UNIT_NAME));
      expect(text).toContain('Dry run — nothing was written or registered');
      expect(text).toContain('--apply');
      expect(tree(root)).toEqual(before);
    });
  });

  it('uninstall dry-run also changes nothing', async () => {
    await withSandboxEnv(async () => {
      const deps = makeDeps(makeFakeApi({}));
      const code = await runCommand(parseArgs(['service', 'uninstall']), deps);
      expect(code).toBe(0);
      expect(deps.stdoutText()).toContain('Dry run — nothing was removed or deregistered');
      expect(tree(root)).toEqual([]);
    });
  });

  it('service status reports not-installed in a fresh sandbox', async () => {
    await withSandboxEnv(async () => {
      const deps = makeDeps(makeFakeApi({}));
      const code = await runCommand(parseArgs(['service', 'status']), deps);
      expect(code).toBe(0);
      expect(deps.stdoutText()).toMatch(/not installed/);
    });
  });

  it('bad service usage is a usage error (exit 2)', async () => {
    const deps = makeDeps(makeFakeApi({}));
    const code = await runCommand(parseArgs(['service', 'frobnicate']), deps);
    expect(code).toBe(2);
  });
});
