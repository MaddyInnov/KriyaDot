// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compareVersions,
  isNewerVersion,
  parseVersion,
  sanitizeSettings,
  selectAssetForPlatform,
  SelfUpdateManager,
  type ReleaseAsset,
} from '../src/self-update.js';

describe('parseVersion / compareVersions', () => {
  it('compares plain semver', () => {
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0);
    expect(compareVersions('0.1.0', '0.1.1')).toBe(-1);
    expect(compareVersions('0.2.0', '0.1.9')).toBe(1);
    expect(compareVersions('1.0.0', '0.9.9')).toBe(1);
  });

  it('handles a leading v', () => {
    expect(compareVersions('v0.1.0', '0.1.0')).toBe(0);
    expect(compareVersions('v0.1.1', 'v0.1.0')).toBe(1);
  });

  it('treats release as newer than the same -alpha prerelease', () => {
    expect(compareVersions('0.1.0-alpha', '0.1.0')).toBe(-1);
    expect(compareVersions('0.1.0', '0.1.0-alpha')).toBe(1);
    expect(compareVersions('0.1.0-alpha', '0.1.0-alpha')).toBe(0);
  });

  it('orders prereleases lexically', () => {
    expect(compareVersions('0.1.0-alpha', '0.1.0-beta')).toBe(-1);
    expect(compareVersions('0.1.1-alpha', '0.1.0')).toBe(1);
  });

  it('isNewerVersion answers the update question', () => {
    expect(isNewerVersion('0.1.0-alpha', 'v0.1.0')).toBe(true);
    expect(isNewerVersion('0.1.0-alpha', '0.1.1')).toBe(true);
    expect(isNewerVersion('0.1.0', '0.1.0-alpha')).toBe(false);
    expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false);
  });

  it('parseVersion tolerates junk', () => {
    expect(parseVersion('')).toEqual({ nums: [0], pre: null });
    expect(parseVersion('v1.x.3')).toEqual({ nums: [1, 0, 3], pre: null });
  });
});

describe('selectAssetForPlatform', () => {
  const assets: ReleaseAsset[] = [
    { name: 'KriyaDot_0.1.1_x64-setup.exe', size: 10, browser_download_url: 'https://x/e' },
    { name: 'KriyaDot_0.1.1_arm64.dmg', size: 11, browser_download_url: 'https://x/a' },
    { name: 'KriyaDot_0.1.1_x64.dmg', size: 12, browser_download_url: 'https://x/i' },
    { name: 'KriyaDot_0.1.1_amd64.AppImage', size: 13, browser_download_url: 'https://x/p' },
    { name: 'KriyaDot_0.1.1_amd64.deb', size: 14, browser_download_url: 'https://x/d' },
  ];

  it('picks the windows setup exe', () => {
    expect(selectAssetForPlatform(assets, 'win32', 'x64')?.name).toBe('KriyaDot_0.1.1_x64-setup.exe');
  });

  it('picks the mac dmg matching arch', () => {
    expect(selectAssetForPlatform(assets, 'darwin', 'arm64')?.name).toBe('KriyaDot_0.1.1_arm64.dmg');
    expect(selectAssetForPlatform(assets, 'darwin', 'x64')?.name).toBe('KriyaDot_0.1.1_x64.dmg');
  });

  it('prefers AppImage over deb on linux', () => {
    expect(selectAssetForPlatform(assets, 'linux', 'x64')?.name).toBe('KriyaDot_0.1.1_amd64.AppImage');
  });

  it('falls back to deb when no AppImage exists', () => {
    const debOnly = assets.filter((a) => !a.name.includes('AppImage'));
    expect(selectAssetForPlatform(debOnly, 'linux', 'x64')?.name).toBe('KriyaDot_0.1.1_amd64.deb');
  });

  it('returns null when nothing matches', () => {
    expect(selectAssetForPlatform([], 'win32', 'x64')).toBeNull();
    expect(selectAssetForPlatform(assets, 'freebsd', 'x64')).toBeNull();
  });
});

describe('sanitizeSettings', () => {
  it('coerces and clamps', () => {
    expect(sanitizeSettings({})).toEqual({ autoCheck: true, checkIntervalHours: 24, applyWhenIdle: false });
    expect(sanitizeSettings({ autoCheck: false, checkIntervalHours: 0.2 })).toEqual({
      autoCheck: false,
      checkIntervalHours: 1,
      applyWhenIdle: false,
    });
    expect(sanitizeSettings({ checkIntervalHours: 99999 }).checkIntervalHours).toBe(720);
    expect(sanitizeSettings({ autoCheck: 'yes' as unknown as boolean }).autoCheck).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Manager with mocked fetch.
// ---------------------------------------------------------------------------

function ghRelease(tag: string, assets: ReleaseAsset[], extra: Record<string, unknown> = {}) {
  return {
    tag_name: tag,
    name: `KriyaDot ${tag}`,
    body: 'notes',
    published_at: '2026-10-16T00:00:00Z',
    prerelease: true,
    draft: false,
    html_url: `https://github.com/x/releases/tag/${tag}`,
    assets,
    ...extra,
  };
}

function makeFetch(releases: unknown[]) {
  const calls: string[] = [];
  const fn = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => releases,
      text: async () => '',
      body: null,
    };
  }) as unknown as typeof fetch;
  return { fn, calls };
}

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'self-update-test-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeManager(opts: {
  releases?: unknown[];
  fetchImpl?: typeof fetch;
  platform?: string;
  arch?: string;
  currentVersion?: string;
} = {}) {
  const { fn, calls } = opts.fetchImpl
    ? { fn: opts.fetchImpl, calls: [] as string[] }
    : makeFetch(opts.releases ?? []);
  const spawned: Array<{ cmd: string; args: string[] }> = [];
  const exited: number[] = [];
  const manager = new SelfUpdateManager({
    dataDir: dir,
    currentVersion: opts.currentVersion ?? '0.1.0-alpha',
    fetch: fn,
    platform: opts.platform ?? 'linux',
    arch: opts.arch ?? 'x64',
    noAutoCheck: true,
    spawn: ((cmd: string, args: string[]) => {
      spawned.push({ cmd, args });
      return { unref: () => undefined } as unknown as never;
    }) as never,
    exit: (code: number) => {
      exited.push(code);
    },
  });
  return { manager, calls, spawned, exited };
}

const LINUX_ASSETS: ReleaseAsset[] = [
  { name: 'KriyaDot_0.1.1_amd64.AppImage', size: 8, browser_download_url: 'https://dl/appimage' },
];

describe('SelfUpdateManager.checkNow', () => {
  it('transitions idle → checking → available when a newer release exists', async () => {
    const { manager } = makeManager({ releases: [ghRelease('v0.1.1', LINUX_ASSETS)] });
    const status = await manager.checkNow();
    expect(status.state).toBe('available');
    expect(status.latest?.tag).toBe('v0.1.1');
    expect(status.asset?.name).toBe('KriyaDot_0.1.1_amd64.AppImage');
    expect(status.lastCheckedAt).toBeTypeOf('number');
  });

  it('stays idle when nothing is newer', async () => {
    const { manager } = makeManager({ releases: [ghRelease('v0.1.0-alpha', LINUX_ASSETS)] });
    const status = await manager.checkNow();
    expect(status.state).toBe('idle');
    expect(status.latest).toBeNull();
  });

  it('picks the newest release across several', async () => {
    const { manager } = makeManager({
      releases: [
        ghRelease('v0.1.1', LINUX_ASSETS),
        ghRelease('v0.2.0', LINUX_ASSETS),
        ghRelease('v0.1.9', LINUX_ASSETS),
      ],
    });
    const status = await manager.checkNow();
    expect(status.latest?.tag).toBe('v0.2.0');
  });

  it('ignores drafts', async () => {
    const { manager } = makeManager({
      releases: [ghRelease('v9.9.9', LINUX_ASSETS, { draft: true })],
    });
    const status = await manager.checkNow();
    expect(status.state).toBe('idle');
  });

  it('lands in error (fail-closed) when the API fails, without throwing', async () => {
    const badFetch = (async () => ({
      ok: false,
      status: 500,
      json: async () => [],
    })) as unknown as typeof fetch;
    const { manager } = makeManager({ fetchImpl: badFetch });
    const status = await manager.checkNow();
    expect(status.state).toBe('error');
    expect(status.lastError).toMatch(/500/);
  });

  it('never downloads during a check', async () => {
    const { manager, calls } = makeManager({ releases: [ghRelease('v0.1.1', LINUX_ASSETS)] });
    await manager.checkNow();
    // Only the releases API was hit — no asset URL.
    expect(calls).toEqual(['https://api.github.com/repos/MaddyInnov/KriyaDot/releases']);
  });
});

describe('consent gating', () => {
  it('refuses download without an available update', async () => {
    const { manager } = makeManager({ releases: [] });
    await expect(manager.download()).rejects.toThrow(/No update is available/);
  });

  it('refuses install without a ready download', async () => {
    const { manager } = makeManager({ releases: [ghRelease('v0.1.1', LINUX_ASSETS)] });
    await manager.checkNow();
    await expect(manager.install()).rejects.toThrow(/No downloaded update/);
  });
});

describe('download + install (linux)', () => {
  it('downloads with progress, verifies size, then xdg-opens on install', async () => {
    const payload = Buffer.from('installer-bytes');
    const asset: ReleaseAsset = {
      name: 'KriyaDot_0.1.1_amd64.AppImage',
      size: payload.length,
      browser_download_url: 'https://dl/appimage',
    };
    const progress: number[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u === 'https://dl/appimage') {
        const stream = new ReadableStream({
          start(c) {
            c.enqueue(payload);
            c.close();
          },
        });
        return { ok: true, status: 200, body: stream, json: async () => [], text: async () => '' };
      }
      return { ok: true, status: 200, json: async () => [ghRelease('v0.1.1', [asset])], text: async () => '' };
    }) as unknown as typeof fetch;

    const { fn } = { fn: fetchImpl };
    const spawned: Array<{ cmd: string; args: string[] }> = [];
    const exited: number[] = [];
    const manager = new SelfUpdateManager({
      dataDir: dir,
      currentVersion: '0.1.0-alpha',
      fetch: fn,
      platform: 'linux',
      arch: 'x64',
      noAutoCheck: true,
      onProgress: (e) => progress.push(e.progress),
      spawn: ((cmd: string, args: string[]) => {
        spawned.push({ cmd, args });
        return { unref: () => undefined } as unknown as never;
      }) as never,
      exit: (code: number) => {
        exited.push(code);
      },
    });

    const checked = await manager.checkNow();
    expect(checked.state).toBe('available');
    const dl = await manager.download();
    expect(dl.state).toBe('ready');
    expect(dl.downloadedBytes).toBe(payload.length);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[progress.length - 1]).toBe(1);

    const inst = await manager.install();
    expect(inst.state).toBe('installing');
    expect(spawned).toEqual([{ cmd: 'xdg-open', args: [dl.downloadedPath!] }]);
    // Linux stays running (software center guides the user) — no exit.
    expect(exited).toEqual([]);
  });

  it('discards the download when the size mismatches', async () => {
    const asset: ReleaseAsset = {
      name: 'KriyaDot_0.1.1_amd64.AppImage',
      size: 9999, // lies
      browser_download_url: 'https://dl/appimage',
    };
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u === 'https://dl/appimage') {
        const stream = new ReadableStream({
          start(c) {
            c.enqueue(Buffer.from('short'));
            c.close();
          },
        });
        return { ok: true, status: 200, body: stream, json: async () => [], text: async () => '' };
      }
      return { ok: true, status: 200, json: async () => [ghRelease('v0.1.1', [asset])], text: async () => '' };
    }) as unknown as typeof fetch;
    const { manager } = makeManager({ fetchImpl, platform: 'linux', arch: 'x64' });
    // Rebuild with the lying asset via releases list (makeManager already
    // wired fetchImpl, but we need checkNow to run against it).
    const checked = await manager.checkNow();
    expect(checked.state).toBe('available');
    const dl = await manager.download();
    expect(dl.state).toBe('error');
    expect(dl.lastError).toMatch(/does not match expected/);
  });
});

describe('install launch per platform', () => {
  const asset: ReleaseAsset = { name: 'x', size: 1, browser_download_url: 'https://dl/x' };

  async function readyManager(platform: string) {
    const { manager, spawned, exited } = makeManager({ platform, arch: 'x64' });
    // Force state to ready with a real file.
    const { writeFileSync } = await import('node:fs');
    const p = join(dir, 'fake-installer.bin');
    writeFileSync(p, 'x');
    (manager as unknown as { downloadedPath: string | null }).downloadedPath = p;
    (manager as unknown as { state: string }).state = 'ready';
    return { manager, spawned, exited, p };
  }

  it('windows: launches the installer and exits', async () => {
    const { manager, spawned, exited, p } = await readyManager('win32');
    await manager.install();
    expect(spawned).toEqual([{ cmd: p, args: [] }]);
    expect(exited).toEqual([0]);
  });

  it('macos: opens the dmg and exits', async () => {
    const { manager, spawned, exited, p } = await readyManager('darwin');
    await manager.install();
    expect(spawned).toEqual([{ cmd: 'open', args: [p] }]);
    expect(exited).toEqual([0]);
  });
});
