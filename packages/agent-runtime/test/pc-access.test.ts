// SPDX-License-Identifier: Apache-2.0
// Tests for pc-access.ts (approval-gated PC file access):
// - segment containment (prefix trick, .., win32 case/separator semantics)
// - special-folder resolution (win32 + posix)
// - canonicalization (realpath, symlink resolution)
// - grant CRUD + per-bot vs all-bots scoping
// - just-in-time requests: allow-once / always (creates bot-scoped grant) /
//   deny / expiry, all fail-closed

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PcAccessStore,
  canonicalizeAbsolutePath,
  isPathInsideRoot,
  resolveSpecialFolder,
  resolveSpecialFolders,
} from '../src/pc-access.js';

describe('isPathInsideRoot', () => {
  it('accepts the root itself and descendants', () => {
    expect(isPathInsideRoot('/home/u/Desktop', '/home/u/Desktop')).toBe(true);
    expect(isPathInsideRoot('/home/u/Desktop', '/home/u/Desktop/a/b.txt')).toBe(true);
  });

  it('rejects the prefix trick (Desktop2 is not inside Desktop)', () => {
    expect(isPathInsideRoot('/home/u/Desktop', '/home/u/Desktop2')).toBe(false);
    expect(isPathInsideRoot('/home/u/Desktop', '/home/u/Desktop2/secret.txt')).toBe(false);
  });

  it('rejects parents and unrelated paths', () => {
    expect(isPathInsideRoot('/home/u/Desktop', '/home/u')).toBe(false);
    expect(isPathInsideRoot('/home/u/Desktop', '/etc/passwd')).toBe(false);
  });

  it('does not let .. segments sneak past (callers canonicalize first)', () => {
    expect(isPathInsideRoot('/home/u/Desktop', '/home/u/Desktop/../secret.txt')).toBe(false);
  });

  it('win32: case-insensitive and separator-agnostic', () => {
    const ci = { caseInsensitive: true };
    expect(isPathInsideRoot('C:\\Users\\sahoo\\Desktop', 'c:\\users\\sahoo\\desktop\\f.txt', ci)).toBe(true);
    expect(isPathInsideRoot('C:/Users/sahoo/Desktop', 'C:\\Users\\sahoo\\Desktop\\f.txt', ci)).toBe(true);
    expect(isPathInsideRoot('C:\\Users\\sahoo\\Desktop', 'C:\\Users\\sahoo\\Desktop2\\f.txt', ci)).toBe(false);
    expect(isPathInsideRoot('C:\\Users\\sahoo\\Desktop', 'D:\\Users\\sahoo\\Desktop\\f.txt', ci)).toBe(false);
  });

  it('posix comparison is case-sensitive when asked', () => {
    expect(
      isPathInsideRoot('/home/u/Desktop', '/home/u/desktop/f.txt', { caseInsensitive: false }),
    ).toBe(false);
  });
});

describe('resolveSpecialFolder', () => {
  it('win32 resolves from USERPROFILE', () => {
    const env = { USERPROFILE: 'C:\\Users\\sahoo' };
    expect(resolveSpecialFolder('desktop', env, 'win32')).toBe('C:\\Users\\sahoo\\Desktop');
    expect(resolveSpecialFolder('documents', env, 'win32')).toBe('C:\\Users\\sahoo\\Documents');
    expect(resolveSpecialFolder('downloads', env, 'win32')).toBe('C:\\Users\\sahoo\\Downloads');
    expect(resolveSpecialFolder('home', env, 'win32')).toBe('C:\\Users\\sahoo');
  });

  it('win32 falls back to HOMEDRIVE+HOMEPATH', () => {
    const env = { HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\sahoo' };
    expect(resolveSpecialFolder('desktop', env, 'win32')).toBe('C:\\Users\\sahoo\\Desktop');
  });

  it('win32 returns null without any home env', () => {
    expect(resolveSpecialFolder('desktop', {}, 'win32')).toBeNull();
  });

  it('posix resolves from HOME and honours XDG dirs', () => {
    expect(resolveSpecialFolder('desktop', { HOME: '/home/u' }, 'linux')).toBe('/home/u/Desktop');
    expect(resolveSpecialFolder('documents', { HOME: '/home/u' }, 'linux')).toBe('/home/u/Documents');
    expect(resolveSpecialFolder('downloads', { HOME: '/home/u' }, 'linux')).toBe('/home/u/Downloads');
    expect(
      resolveSpecialFolder('desktop', { HOME: '/home/u', XDG_DESKTOP_DIR: '/data/desk' }, 'linux'),
    ).toBe('/data/desk');
    expect(resolveSpecialFolder('home', {}, 'linux')).toBeNull();
  });

  it('resolveSpecialFolders returns the full map', () => {
    const all = resolveSpecialFolders({ USERPROFILE: 'C:\\Users\\sahoo' }, 'win32');
    expect(Object.keys(all).sort()).toEqual(['desktop', 'documents', 'downloads', 'home']);
  });
});

describe('canonicalizeAbsolutePath', () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'pc-canon-')));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves .. and . segments against the real tree', () => {
    mkdirSync(join(dir, 'a', 'b'), { recursive: true });
    expect(canonicalizeAbsolutePath(join(dir, 'a', 'b', '..', 'b'))).toBe(join(dir, 'a', 'b'));
  });

  it('resolves symlinks to their real target (escape detection input)', () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'pc-outside-')));
    try {
      writeFileSync(join(outside, 'secret.txt'), 'x');
      symlinkSync(outside, join(dir, 'link'), 'dir');
      // The canonical form of a path THROUGH the symlink is the outside
      // path — containment checks then fail against the inside grant.
      expect(canonicalizeAbsolutePath(join(dir, 'link', 'secret.txt'))).toBe(
        join(outside, 'secret.txt'),
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('handles not-yet-existing tails via the nearest existing ancestor', () => {
    expect(canonicalizeAbsolutePath(join(dir, 'new-folder', 'file.txt'))).toBe(
      join(dir, 'new-folder', 'file.txt'),
    );
  });
});

describe('PcAccessStore grants', () => {
  let dir: string;
  let store: PcAccessStore;
  let pcRoot: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pc-access-'));
    store = new PcAccessStore(dir);
    pcRoot = realpathSync(mkdtempSync(join(tmpdir(), 'pc-folders-')));
    mkdirSync(join(pcRoot, 'Desktop'), { recursive: true });
    mkdirSync(join(pcRoot, 'Desktop2'), { recursive: true });
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(pcRoot, { recursive: true, force: true });
  });

  it('adds, lists and revokes grants; add is idempotent per (path, scope)', () => {
    const g1 = store.addGrant({ path: join(pcRoot, 'Desktop'), createdVia: 'settings' });
    expect(g1.scope).toBe('all');
    expect(g1.readOnly).toBe(true);
    const g2 = store.addGrant({ path: join(pcRoot, 'Desktop'), createdVia: 'settings' });
    expect(g2.id).toBe(g1.id);
    expect(store.listGrants()).toHaveLength(1);
    expect(store.revokeGrant(g1.id)?.id).toBe(g1.id);
    expect(store.listGrants()).toHaveLength(0);
    expect(store.revokeGrant(g1.id)).toBeNull();
  });

  it('scopes grants: all-bots vs one bot', () => {
    store.addGrant({ path: join(pcRoot, 'Desktop'), createdVia: 'settings' }); // all
    store.addGrant({ path: join(pcRoot, 'Desktop2'), botId: 'coder', createdVia: 'settings' });
    expect(store.grantsForBot('scout')).toEqual([join(pcRoot, 'Desktop')]);
    expect(store.grantsForBot('coder').sort()).toEqual(
      [join(pcRoot, 'Desktop'), join(pcRoot, 'Desktop2')].sort(),
    );
  });

  it('containingGrantRoot matches descendants, not prefix siblings', () => {
    store.addGrant({ path: join(pcRoot, 'Desktop'), createdVia: 'settings' });
    expect(store.containingGrantRoot('scout', join(pcRoot, 'Desktop', 'a.txt'))).toBe(
      join(pcRoot, 'Desktop'),
    );
    expect(store.containingGrantRoot('scout', join(pcRoot, 'Desktop'))).toBe(join(pcRoot, 'Desktop'));
    expect(store.containingGrantRoot('scout', join(pcRoot, 'Desktop2', 'a.txt'))).toBeNull();
  });
});

describe('PcAccessStore just-in-time requests', () => {
  let dir: string;
  let store: PcAccessStore;
  let pcRoot: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pc-jit-'));
    store = new PcAccessStore(dir);
    pcRoot = realpathSync(mkdtempSync(join(tmpdir(), 'pc-jit-folders-')));
    mkdirSync(join(pcRoot, 'Desktop'), { recursive: true });
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(pcRoot, { recursive: true, force: true });
  });

  const ask = (botId = 'scout', sessionId = 'sess-1') =>
    store.requestAccess({
      botId,
      sessionId,
      folder: join(pcRoot, 'Desktop'),
      action: 'list',
    });

  it('reuses the pending card for the same (bot, folder)', () => {
    const a = ask();
    const b = ask();
    expect(b.id).toBe(a.id);
    expect(store.listRequests('pending')).toHaveLength(1);
  });

  it('allow-once: outcome resolves and the session allowance sticks (incl. children)', async () => {
    const card = ask();
    const outcome = store.awaitOutcome(card.id, 5_000);
    store.decide(card.id, 'allow-once');
    await expect(outcome).resolves.toBe('allow-once');
    expect(store.isOnceAllowed('sess-1', join(pcRoot, 'Desktop'))).toBe(true);
    expect(store.isOnceAllowed('sess-1', join(pcRoot, 'Desktop', 'sub', 'f.txt'))).toBe(true);
    expect(store.isOnceAllowed('other-session', join(pcRoot, 'Desktop'))).toBe(false);
    // Allow-once never persists a grant.
    expect(store.listGrants()).toHaveLength(0);
  });

  it('always: creates a grant scoped to the requesting bot only', async () => {
    const card = ask('scout');
    const outcome = store.awaitOutcome(card.id, 5_000);
    store.decide(card.id, 'always');
    await expect(outcome).resolves.toBe('always');
    const grants = store.listGrants();
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      path: join(pcRoot, 'Desktop'),
      scope: 'scout',
      createdVia: 'approval',
    });
    expect(store.grantsForBot('coder')).toEqual([]);
  });

  it('deny: outcome is denied and nothing is granted or allowed', async () => {
    const card = ask();
    const outcome = store.awaitOutcome(card.id, 5_000);
    store.decide(card.id, 'deny');
    await expect(outcome).resolves.toBe('denied');
    expect(store.listGrants()).toHaveLength(0);
    expect(store.isOnceAllowed('sess-1', join(pcRoot, 'Desktop'))).toBe(false);
  });

  it('decide is one-shot: a second decide is a no-op', async () => {
    const card = ask();
    expect(store.decide(card.id, 'deny')?.status).toBe('denied');
    expect(store.decide(card.id, 'always')).toBeNull();
    expect(store.listGrants()).toHaveLength(0);
  });

  it('expireStale settles pending waiters as denied (fail-closed)', async () => {
    const card = ask();
    const outcome = store.awaitOutcome(card.id, 60_000);
    const expired = store.expireStale(Date.now() + 16 * 60 * 1000);
    expect(expired).toContain(card.id);
    await expect(outcome).resolves.toBe('denied');
    expect(store.getRequest(card.id)?.status).toBe('expired');
  });

  it('awaitOutcome times out as denied', async () => {
    const card = ask();
    await expect(store.awaitOutcome(card.id, 25)).resolves.toBe('denied');
  });
});
