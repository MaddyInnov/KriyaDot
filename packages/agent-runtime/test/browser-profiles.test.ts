// SPDX-License-Identifier: Apache-2.0
// W4 tests: per-bot persistent browser profiles.
//
// The real `playwright` package is never loaded (repo convention — see
// computer-playwright.test.ts). Instead a FILE-BACKED fake chromium
// implements the PlaywrightChromiumLike shape: launchPersistentContext(dir)
// loads profile state (localStorage + cookies) from <dir>/fake-state.json
// and flushes it back on context.close(), exactly like a real persistent
// context flushes to its user-data directory. That makes the persistence
// semantics under test real: same dir → state survives close/relaunch,
// different dir → state absent, close keeps the directory, wipe deletes it.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PerBotComputerManager,
  PlaywrightOSScreenLayer,
  browserProfileDirFor,
  browserProfileDirName,
  createEphemeralPageBackend,
  createPersistentPageBackend,
  profileDiskUsage,
  type PlaywrightChromiumLike,
  type PlaywrightRawBrowser,
  type PlaywrightRawContext,
  type PlaywrightRawPage,
} from '../src/tools/computer-surfaces.js';

// ---------------------------------------------------------------------------
// File-backed fake chromium
// ---------------------------------------------------------------------------

const STATE_FILE = 'fake-state.json';

interface FakeState {
  localStorage: Record<string, string>;
  cookies: Record<string, string>;
}

function loadState(dir: string): FakeState {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, STATE_FILE), 'utf8')) as FakeState;
    return { localStorage: parsed.localStorage ?? {}, cookies: parsed.cookies ?? {} };
  } catch {
    return { localStorage: {}, cookies: {} };
  }
}

class FakePage implements PlaywrightRawPage {
  constructor(private readonly ctx: FakeContext) {}
  viewportSize(): { width: number; height: number } {
    return { width: 1280, height: 720 };
  }
  async goto(_url: string): Promise<void> {}
  async screenshot(): Promise<Buffer> {
    return Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  }
  mouse = {
    click: async (): Promise<void> => undefined,
    move: async (): Promise<void> => undefined,
    wheel: async (): Promise<void> => undefined,
    down: async (): Promise<void> => undefined,
    up: async (): Promise<void> => undefined,
  };
  keyboard = {
    type: async (text: string): Promise<void> => {
      this.ctx.typed.push(text);
    },
    press: async (): Promise<void> => undefined,
    down: async (): Promise<void> => undefined,
    up: async (): Promise<void> => undefined,
  };
  /** Test handle: this page's localStorage (backed by the context state). */
  get localStorage(): Map<string, string> {
    return this.ctx.localStorage;
  }
  get cookies(): Map<string, string> {
    return this.ctx.cookies;
  }
}

class FakeContext implements PlaywrightRawContext {
  readonly pages: FakePage[] = [];
  readonly typed: string[] = [];
  readonly localStorage: Map<string, string>;
  readonly cookies: Map<string, string>;
  closed = false;
  constructor(readonly profileDir: string | null) {
    const state = profileDir ? loadState(profileDir) : { localStorage: {}, cookies: {} };
    this.localStorage = new Map(Object.entries(state.localStorage));
    this.cookies = new Map(Object.entries(state.cookies));
  }
  async newPage(): Promise<FakePage> {
    const page = new FakePage(this);
    this.pages.push(page);
    return page;
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.profileDir) {
      // A real persistent context flushes storage to the user-data dir.
      mkdirSync(this.profileDir, { recursive: true });
      const state: FakeState = {
        localStorage: Object.fromEntries(this.localStorage),
        cookies: Object.fromEntries(this.cookies),
      };
      writeFileSync(join(this.profileDir, STATE_FILE), JSON.stringify(state));
    }
  }
}

class FakeChromium implements PlaywrightChromiumLike {
  readonly launchCalls: number[] = [];
  readonly persistentCalls: string[] = [];
  readonly contexts: FakeContext[] = [];
  async launch(): Promise<PlaywrightRawBrowser> {
    this.launchCalls.push(1);
    return {
      newContext: async () => {
        const ctx = new FakeContext(null);
        this.contexts.push(ctx);
        return ctx;
      },
      close: async () => undefined,
    };
  }
  async launchPersistentContext(userDataDir: string): Promise<PlaywrightRawContext> {
    this.persistentCalls.push(userDataDir);
    const ctx = new FakeContext(userDataDir);
    this.contexts.push(ctx);
    return ctx;
  }
  get lastContext(): FakeContext {
    return this.contexts[this.contexts.length - 1]!;
  }
}

// ---------------------------------------------------------------------------

let root: string | undefined;
function freshRoot(): string {
  root = mkdtempSync(join(tmpdir(), 'browser-profiles-'));
  return root;
}
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe('profile directory keying', () => {
  it('uses safe bot ids verbatim and separates different bots', () => {
    const r = freshRoot();
    expect(browserProfileDirFor(r, 'scout')).toBe(join(r, 'scout'));
    expect(browserProfileDirFor(r, 'coder')).toBe(join(r, 'coder'));
    expect(browserProfileDirFor(r, 'scout')).not.toBe(browserProfileDirFor(r, 'coder'));
  });

  it('never collides sanitized ids ("a:b" vs "a_b" get different dirs)', () => {
    expect(browserProfileDirName('a:b')).not.toBe(browserProfileDirName('a_b'));
    expect(browserProfileDirName('a:b')).toBe(browserProfileDirName('a:b')); // deterministic
    expect(browserProfileDirName('a/b')).not.toContain('/');
  });
});

describe('persistent page backend (fake chromium)', () => {
  it('launches a persistent context bound to the profile dir', async () => {
    const r = freshRoot();
    const dir = join(r, 'scout');
    const chromium = new FakeChromium();
    const backend = await createPersistentPageBackend(chromium, dir);
    expect(chromium.persistentCalls).toEqual([dir]);
    expect(chromium.launchCalls).toEqual([]);
    await backend.close();
  });

  it('storage + cookies survive close → relaunch with the same profile dir', async () => {
    const r = freshRoot();
    const dir = join(r, 'scout');
    const chromium = new FakeChromium();

    const first = await createPersistentPageBackend(chromium, dir);
    const page1 = chromium.lastContext.pages[0]!;
    page1.localStorage.set('theme', 'dark');
    page1.cookies.set('session', 'opaque-session-value');
    await first.close();
    // Close closed the context but KEPT the profile directory + state.
    expect(chromium.contexts[0]!.closed).toBe(true);
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, STATE_FILE))).toBe(true);

    const second = await createPersistentPageBackend(chromium, dir);
    const page2 = chromium.lastContext.pages[0]!;
    expect(page2.localStorage.get('theme')).toBe('dark');
    expect(page2.cookies.get('session')).toBe('opaque-session-value');
    await second.close();
  });

  it('a different bot profile dir does NOT see the first bot state', async () => {
    const r = freshRoot();
    const chromium = new FakeChromium();
    const a = await createPersistentPageBackend(chromium, join(r, 'scout'));
    chromium.lastContext.pages[0]!.localStorage.set('theme', 'dark');
    await a.close();

    const b = await createPersistentPageBackend(chromium, join(r, 'coder'));
    expect(chromium.lastContext.pages[0]!.localStorage.get('theme')).toBeUndefined();
    await b.close();
  });

  it('ephemeral backend never uses a persistent context and persists nothing', async () => {
    freshRoot();
    const chromium = new FakeChromium();
    const backend = await createEphemeralPageBackend(chromium);
    expect(chromium.launchCalls).toHaveLength(1);
    expect(chromium.persistentCalls).toEqual([]);
    chromium.lastContext.pages[0]!.localStorage.set('theme', 'dark');
    await backend.close();
    const again = await createEphemeralPageBackend(chromium);
    expect(chromium.lastContext.pages[0]!.localStorage.get('theme')).toBeUndefined();
    await again.close();
  });
});

describe('PlaywrightOSScreenLayer with a profile', () => {
  it('exposes its profileDir, launches persistently, and close keeps the dir', async () => {
    const r = freshRoot();
    const dir = join(r, 'scout');
    const chromium = new FakeChromium();
    const layer = new PlaywrightOSScreenLayer({ profileDir: dir, chromium });
    expect(layer.profileDir).toBe(dir);
    await layer.screenshot();
    expect(chromium.persistentCalls).toEqual([dir]);
    chromium.lastContext.pages[0]!.localStorage.set('k', 'v');
    await layer.close();
    expect(existsSync(dir)).toBe(true);

    const layer2 = new PlaywrightOSScreenLayer({ profileDir: dir, chromium });
    await layer2.screenshot();
    expect(chromium.lastContext.pages[0]!.localStorage.get('k')).toBe('v');
    await layer2.kill(); // kill() alias also closes
    expect(chromium.lastContext.closed).toBe(true);
  });

  it('close is a no-op when never launched', async () => {
    const chromium = new FakeChromium();
    const layer = new PlaywrightOSScreenLayer({ profileDir: join(freshRoot(), 'x'), chromium });
    await layer.close();
    expect(chromium.persistentCalls).toEqual([]);
  });
});

describe('PerBotComputerManager profile wiring', () => {
  function managerWithFake(chromium: FakeChromium, r: string) {
    const holder: { mgr?: PerBotComputerManager } = {};
    const mgr = new PerBotComputerManager({
      browserProfileRoot: r,
      createBackend: (_resolved, botId) =>
        new PlaywrightOSScreenLayer({ profileDir: holder.mgr!.profileDirFor(botId), chromium }),
    });
    holder.mgr = mgr;
    return mgr;
  }

  it('keys persistent contexts by bot id: same bot same dir, other bot other dir', async () => {
    const r = freshRoot();
    const chromium = new FakeChromium();
    const mgr = managerWithFake(chromium, r);
    await mgr.getLayer('scout', { surface: 'browser' }).screenshot();
    await mgr.getLayer('coder', { surface: 'browser' }).screenshot();
    expect(chromium.persistentCalls).toEqual([join(r, 'scout'), join(r, 'coder')]);
    expect(mgr.profileDirFor('scout')).toBe(join(r, 'scout'));
    expect(mgr.browserProfileRoot()).toBe(r);
  });

  it('teardown (removeBot / idle sweep) closes contexts but KEEPS profiles', async () => {
    const r = freshRoot();
    const chromium = new FakeChromium();
    const mgr = managerWithFake(chromium, r);
    await mgr.getLayer('scout', { surface: 'browser' }).screenshot();
    chromium.lastContext.pages[0]!.localStorage.set('k', 'v');
    await mgr.removeBot('scout');
    expect(chromium.contexts[0]!.closed).toBe(true);
    expect(existsSync(join(r, 'scout'))).toBe(true);
    // Relaunch after teardown reuses the same profile (state present).
    await mgr.getLayer('scout', { surface: 'browser' }).screenshot();
    expect(chromium.persistentCalls).toEqual([join(r, 'scout'), join(r, 'scout')]);
    expect(chromium.lastContext.pages[0]!.localStorage.get('k')).toBe('v');
  });

  it('default backend wiring gives the browser layer the per-bot profileDir', async () => {
    const r = freshRoot();
    const mgr = new PerBotComputerManager({ browserProfileRoot: r });
    const layer = mgr.getLayer('scout', { surface: 'browser' });
    // Reach the lazily-created entry + backend without driving a page
    // (driving one would need the real playwright package).
    const entries = (mgr as unknown as { entries: Map<string, { backend?: unknown }> }).entries;
    const entry = entries.get('scout')!;
    const backend = await (
      mgr as unknown as { ensureBackend(e: unknown): Promise<unknown> }
    ).ensureBackend(entry);
    expect(backend).toBeInstanceOf(PlaywrightOSScreenLayer);
    expect((backend as PlaywrightOSScreenLayer).profileDir).toBe(join(r, 'scout'));
    void layer;
  });

  it('status reports profileDir + profileBytes for browser instances only', async () => {
    const r = freshRoot();
    const chromium = new FakeChromium();
    const mgr = managerWithFake(chromium, r);
    await mgr.getLayer('scout', { surface: 'browser' }).screenshot();
    chromium.lastContext.pages[0]!.localStorage.set('k', 'v');
    await mgr.removeBot('scout');
    await mgr.getLayer('scout', { surface: 'browser' }).screenshot();
    const [status] = mgr.status('scout');
    expect(status!.profileDir).toBe(join(r, 'scout'));
    expect(status!.profileBytes).toBeGreaterThan(0);
    const info = mgr.profileInfo('scout');
    expect(info.exists).toBe(true);
    expect(info.bytes).toBe(status!.profileBytes);
    expect(info.files).toBeGreaterThanOrEqual(1);
    expect(mgr.profileInfo('ghost').exists).toBe(false);
  });
});

describe('wipeBrowserProfile', () => {
  it('deletes the profile dir, closes live instances, keeps pins, audits via hook', async () => {
    const r = freshRoot();
    const chromium = new FakeChromium();
    const onProfileWipe = vi.fn();
    const holder: { mgr?: PerBotComputerManager } = {};
    const mgr = new PerBotComputerManager({
      browserProfileRoot: r,
      onProfileWipe,
      createBackend: (_resolved, botId) =>
        new PlaywrightOSScreenLayer({ profileDir: holder.mgr!.profileDirFor(botId), chromium }),
    });
    holder.mgr = mgr;
    mgr.pinSurface('scout', 'conv-1', 'browser');
    await mgr.getLayer('scout', { surface: 'browser' }).screenshot();
    chromium.lastContext.pages[0]!.localStorage.set('k', 'v');
    // Flush state to disk via a teardown first so bytes exist to free.
    await mgr.removeBot('scout');
    mgr.pinSurface('scout', 'conv-1', 'browser');
    const before = mgr.profileInfo('scout');
    expect(before.exists).toBe(true);
    expect(before.bytes).toBeGreaterThan(0);

    const result = await mgr.wipeBrowserProfile('scout');
    expect(result).toMatchObject({ botId: 'scout', wiped: true, profileDir: join(r, 'scout') });
    expect(result.bytesFreed).toBe(before.bytes);
    expect(existsSync(join(r, 'scout'))).toBe(false);
    expect(mgr.status('scout')).toHaveLength(0);
    // Pins survive a wipe (the bot keeps its surface choices, just logged out).
    expect(mgr.getPin('scout', 'conv-1')).toBe('browser');
    expect(onProfileWipe).toHaveBeenCalledTimes(1);
    expect(onProfileWipe.mock.calls[0]![0]).toMatchObject({ botId: 'scout', wiped: true });

    // Next launch starts from a FRESH profile (no old state).
    await mgr.getLayer('scout', { surface: 'browser' }).screenshot();
    expect(chromium.lastContext.pages[0]!.localStorage.get('k')).toBeUndefined();
  });

  it('wiping a bot with no profile is a clean no-op', async () => {
    const r = freshRoot();
    const mgr = new PerBotComputerManager({ browserProfileRoot: r });
    const result = await mgr.wipeBrowserProfile('ghost');
    expect(result.wiped).toBe(false);
    expect(result.bytesFreed).toBe(0);
  });
});

describe('profileDiskUsage', () => {
  it('sums nested files and tolerates missing dirs', () => {
    const r = freshRoot();
    const dir = join(r, 'p');
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'a.bin'), '12345');
    writeFileSync(join(dir, 'sub', 'b.bin'), '123');
    expect(profileDiskUsage(dir)).toEqual({ bytes: 8, files: 2 });
    expect(profileDiskUsage(join(r, 'missing'))).toEqual({ bytes: 0, files: 0 });
  });
});
