// SPDX-License-Identifier: Apache-2.0
// W12d open-at-login: file-based autostart entries per OS (mock platform
// + temp HOME), plus the HTTP routes. Enabling creates the correct entry
// file with the correct exec path; disabling removes it; status reports
// correctly, including the stale-entry case.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutostartManager, autostartEntryPath, renderAutostartEntry } from '../src/autostart.js';
import { createAutostartRouter } from '../src/autostart-routes.js';

const EXEC = '/opt/kriyadot/KriyaDot';
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'autostart-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('AutostartManager — linux (XDG)', () => {
  it('enable creates ~/.config/autostart/kriyadot.desktop with the exec path; disable removes it', () => {
    const m = new AutostartManager({ platform: 'linux', homeDir: home, execPath: EXEC });
    expect(m.status()).toMatchObject({ enabled: false, supported: true, stale: false });
    const on = m.enable();
    expect(on.enabled).toBe(true);
    const entry = join(home, '.config', 'autostart', 'kriyadot.desktop');
    expect(m.entryPath).toBe(entry);
    expect(existsSync(entry)).toBe(true);
    const content = readFileSync(entry, 'utf8');
    expect(content).toContain('[Desktop Entry]');
    expect(content).toContain(`Exec=${EXEC}`);
    expect(content).toContain('Name=KriyaDot');
    const off = m.disable();
    expect(off.enabled).toBe(false);
    expect(existsSync(entry)).toBe(false);
    // Disabling twice is a no-op, not an error.
    expect(m.disable().enabled).toBe(false);
  });

  it('quotes an exec path containing spaces', () => {
    const content = renderAutostartEntry({ platform: 'linux', execPath: '/opt/My Apps/KriyaDot' });
    expect(content).toContain('Exec="/opt/My Apps/KriyaDot"');
  });
});

describe('AutostartManager — macOS (LaunchAgent)', () => {
  it('enable creates the plist with label, RunAtLoad and the exec path', () => {
    const m = new AutostartManager({ platform: 'darwin', homeDir: home, execPath: EXEC });
    const on = m.enable();
    expect(on.enabled).toBe(true);
    const entry = join(home, 'Library', 'LaunchAgents', 'com.kriyadot.desktop.plist');
    expect(existsSync(entry)).toBe(true);
    const content = readFileSync(entry, 'utf8');
    expect(content).toContain('<string>com.kriyadot.desktop</string>');
    expect(content).toContain('<key>RunAtLoad</key>');
    expect(content).toContain(`<string>${EXEC}</string>`);
    expect(m.disable().enabled).toBe(false);
    expect(existsSync(entry)).toBe(false);
  });

  it('XML-escapes the exec path', () => {
    const content = renderAutostartEntry({ platform: 'darwin', execPath: '/opt/a&b/KriyaDot' });
    expect(content).toContain('/opt/a&amp;b/KriyaDot');
  });
});

describe('AutostartManager — Windows (Startup folder)', () => {
  it('enable creates KriyaDot.cmd under the Startup folder with the exec path', () => {
    const appData = join(home, 'AppData', 'Roaming');
    const m = new AutostartManager({ platform: 'win32', homeDir: home, appDataDir: appData, execPath: 'C:\\KriyaDot\\KriyaDot.exe' });
    const on = m.enable();
    expect(on.enabled).toBe(true);
    const entry = join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'KriyaDot.cmd');
    expect(m.entryPath).toBe(entry);
    expect(existsSync(entry)).toBe(true);
    expect(readFileSync(entry, 'utf8')).toContain('C:\\KriyaDot\\KriyaDot.exe');
    expect(m.disable().enabled).toBe(false);
    expect(existsSync(entry)).toBe(false);
  });
});

describe('AutostartManager — stale + unsupported', () => {
  it('an entry pointing elsewhere reports stale and not enabled', () => {
    const m = new AutostartManager({ platform: 'linux', homeDir: home, execPath: EXEC });
    const entry = autostartEntryPath({ platform: 'linux', homeDir: home });
    mkdirSync(join(home, '.config', 'autostart'), { recursive: true });
    writeFileSync(entry, '[Desktop Entry]\nExec=/somewhere/else\n', 'utf8');
    const s = m.status();
    expect(s.enabled).toBe(false);
    expect(s.stale).toBe(true);
    // Re-enabling rewrites it to point here.
    expect(m.enable().enabled).toBe(true);
    expect(m.status().stale).toBe(false);
  });

  it('unsupported platforms report supported:false and enable() throws', () => {
    const m = new AutostartManager({ platform: 'freebsd', homeDir: home, execPath: EXEC });
    expect(m.status().supported).toBe(false);
    expect(() => m.enable()).toThrow(/not supported/);
  });
});

describe('autostart routes', () => {
  it('GET reports state; PUT toggles the entry on and off', async () => {
    const manager = new AutostartManager({ platform: 'linux', homeDir: home, execPath: EXEC });
    const app = express();
    app.use(express.json());
    app.use('/api/autostart', createAutostartRouter(manager));
    const server = app.listen(0);
    await new Promise<void>((r) => server.on('listening', r));
    const addr = server.address();
    const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    try {
      const get1 = (await (await fetch(`${base}/api/autostart`)).json()) as { status: { enabled: boolean } };
      expect(get1.status.enabled).toBe(false);
      const put = (await (
        await fetch(`${base}/api/autostart`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: true }),
        })
      ).json()) as { status: { enabled: boolean; entryPath: string } };
      expect(put.status.enabled).toBe(true);
      expect(existsSync(put.status.entryPath)).toBe(true);
      const bad = await fetch(`${base}/api/autostart`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(bad.status).toBe(400);
      const off = (await (
        await fetch(`${base}/api/autostart`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: false }),
        })
      ).json()) as { status: { enabled: boolean } };
      expect(off.status.enabled).toBe(false);
    } finally {
      server.close();
    }
  });
});
