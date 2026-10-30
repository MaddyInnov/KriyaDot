// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { parseKriyaDotDeepLink, deepLinkToRoute, wireDesktopDictation, wireDeepLinks, type TauriEventLike } from './desktop-bridge';

describe('CA-27 deep links', () => {
  it('parses chat, quick, and repo+prompt links', () => {
    expect(parseKriyaDotDeepLink('kriyadot://chat/abc-1')).toEqual({ kind: 'chat', chatId: 'abc-1' });
    expect(parseKriyaDotDeepLink('kriyadot://quick')).toEqual({ kind: 'quick' });
    const repo = parseKriyaDotDeepLink('kriyadot://repo/%2Fhome%2Fuser%2Fproj?prompt=fix%20the%20tests');
    expect(repo).toMatchObject({ kind: 'repo', repo: '/home/user/proj', prompt: 'fix the tests' });
    expect(deepLinkToRoute(repo)).toContain('prompt=fix%20the%20tests');
    expect(parseKriyaDotDeepLink('https://example.com').kind).toBe('unknown');
    expect(deepLinkToRoute({ kind: 'unknown', raw: 'x' })).toBeNull();
  });

  it('navigates when the deep-link plugin delivers a URL', async () => {
    const handlers = new Map<string, (e: { payload?: unknown }) => void>();
    const surface: TauriEventLike = {
      listen: async (name, h) => { handlers.set(name, h); return () => handlers.delete(name); },
    };
    const routes: string[] = [];
    await wireDeepLinks(surface, (r) => routes.push(r));
    handlers.get('deep-link://new-url')?.({ payload: { urls: ['kriyadot://chat/xyz'] } });
    expect(routes).toEqual(['/chat/xyz']);
  });
});

describe('CA-35 desktop dictation wiring', () => {
  it('press starts recognition; a final transcript is inserted via the Tauri command', async () => {
    const handlers = new Map<string, (e: { payload?: unknown }) => void>();
    const invoked: Array<{ cmd: string; text?: string }> = [];
    let finalCb: ((t: string) => void) | undefined;
    let stopped = false;
    const surface: TauriEventLike = {
      listen: async (name, h) => { handlers.set(name, h); return () => handlers.delete(name); },
      invoke: async (cmd, args) => { invoked.push({ cmd, text: args?.text as string }); },
    };
    await wireDesktopDictation({
      surface,
      recognizer: { start: (cb) => { finalCb = cb; }, stop: () => { stopped = true; } },
      onComposerText: () => { throw new Error('composer should not be used when invoke succeeds'); },
    });
    handlers.get('dictation://press')?.({});
    finalCb?.('  hello desktop  ');
    // invoke is async inside the callback; flush microtasks
    await new Promise((r) => setTimeout(r, 0));
    expect(invoked).toEqual([{ cmd: 'dictation_insert_text', text: 'hello desktop' }]);
    handlers.get('dictation://release')?.({});
    expect(stopped).toBe(true);
  });

  it('is a no-op on the plain web (no Tauri surface)', async () => {
    const un = await wireDesktopDictation({ surface: null, recognizer: { start: () => {}, stop: () => {} }, onComposerText: () => {} });
    expect(typeof un).toBe('function');
  });
});
