// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import express from 'express';
import { ServiceManager, renderServiceDefinition, type ServiceFs } from '../src/service-manager.js';
import { createServiceManagerRouter } from '../src/service-manager.js';

function fakeFs(): ServiceFs & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    writeFile(p, c) { files.set(p, c); },
    readFile(p) { return files.get(p) ?? null; },
    remove(p) { files.delete(p); },
    exists(p) { return files.has(p); },
    mkdirp() {},
  };
}
const okRunner = async () => ({ stdout: '', stderr: '', code: 0 });

describe('ServiceManager', () => {
  it('linux: generates a systemd user unit, installs via systemctl plan, status parses is-active', async () => {
    const fsImpl = fakeFs();
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const m = new ServiceManager({
      platform: 'linux', homeDir: '/home/u', execPath: '/usr/bin/node', execArgs: ['/srv/api.js'],
      fsImpl, hasTool: () => true,
      runner: async (cmd, args) => { calls.push({ cmd, args }); return { stdout: cmd === 'systemctl' && args.includes('is-active') ? 'active\n' : '', stderr: '', code: 0 }; },
    });
    const installed = await m.install();
    expect(installed.ok).toBe(true);
    expect(installed.planOnly).toBe(false);
    expect(installed.unitContent).toContain('ExecStart=/usr/bin/node /srv/api.js');
    expect(fsImpl.files.get('/home/u/.config/systemd/user/kriyadot.service')).toContain('[Service]');
    expect(calls.some((c) => c.args.includes('daemon-reload'))).toBe(true);
    await expect(m.status()).resolves.toMatchObject({ installed: true, running: true, detail: 'active' });
    const un = await m.uninstall();
    expect(un.ok).toBe(true);
    expect(fsImpl.exists('/home/u/.config/systemd/user/kriyadot.service')).toBe(false);
  });

  it('darwin: renders a launchd plist; win32: sc.exe plan only when the tool is absent', async () => {
    const rendered = renderServiceDefinition({ platform: 'darwin', execPath: '/opt/KriyaDot', execArgs: [] });
    expect(rendered?.content).toContain('com.kriyadot.api');
    expect(rendered?.content).toContain('<key>RunAtLoad</key>');
    const win = new ServiceManager({ platform: 'win32', homeDir: 'C:\\Users\\u', execPath: 'C:\\KriyaDot\\api.exe', execArgs: [], fsImpl: fakeFs(), hasTool: () => false, runner: okRunner });
    const plan = await win.install();
    expect(plan.planOnly).toBe(true);
    expect(plan.commands[0]).toEqual({ cmd: 'sc.exe', args: ['create', 'KriyaDot', 'binPath= "C:\\KriyaDot\\api.exe"', 'start= auto'] });
    await expect(win.status()).resolves.toMatchObject({ running: null });
  });

  it('routes audit every mutation', async () => {
    const audits: string[] = [];
    const m = new ServiceManager({ platform: 'linux', homeDir: '/home/u', execPath: '/bin/x', fsImpl: fakeFs(), hasTool: () => false, runner: okRunner });
    const app = express();
    app.use(express.json());
    app.use('/api/service', createServiceManagerRouter({ manager: m, audit: (a) => audits.push(a) }));
    const server = app.listen(0);
    try {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/service`;
      const st = await (await fetch(`${base}/status`)).json() as { status: { installed: boolean } };
      expect(st.status.installed).toBe(false);
      const ins = await (await fetch(`${base}/install`, { method: 'POST' })).json() as { ok: boolean; result: { planOnly: boolean } };
      expect(ins.ok).toBe(true);
      expect(ins.result.planOnly).toBe(true);
      await fetch(`${base}/start`, { method: 'POST' });
      expect(audits).toEqual(['service.install', 'service.start']);
    } finally { server.close(); }
  });
});
