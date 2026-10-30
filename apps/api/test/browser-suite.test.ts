// SPDX-License-Identifier: Apache-2.0
// Wave-4 browser finishes (Muse parity audit §4.11): BR-13 permission
// suite, BR-9 takeover + handback, BR-7 file grants, BR-10 question
// cards, BR-12 protected artifacts, BR-11 one-checkout-per-window,
// BR-8 CAPTCHA user-takeover-only handling, and the composing gate.
// Temp dirs only; mock/fake clocks; no real browser, no network beyond
// loopback HTTP harnesses, zero paid usage.

import fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrowserHoldRegistry, WidgetCoordinator, WidgetStore } from '@mvp/agent-runtime';
import {
  BrowserPermissionStore,
  BROWSER_ACTION_DEFAULTS,
} from '../src/browser-permissions.js';
import { BrowserTakeoverManager, TakeoverConflictError, TakeoverStateError } from '../src/browser-takeover.js';
import {
  BrowserFileGrantStore,
  FileGrantDeniedError,
  classifyFileSize,
  FILE_GRANT_HARD_MAX_BYTES,
} from '../src/browser-file-grants.js';
import { BrowserQuestionCards } from '../src/browser-question-cards.js';
import { BrowserArtifactStore } from '../src/browser-artifacts.js';
import { FileLinkService } from '../src/file-links.js';
import { CheckoutWindowGuard, CheckoutBusyError } from '../src/browser-checkout.js';
import {
  BrowserCaptchaHandler,
  CAPTCHA_BOUNDARY_COPY,
  assertNoSolverConfig,
  detectChallengeSignal,
} from '../src/browser-captcha.js';
import { BrowserActionGate } from '../src/browser-action-gate.js';
import { createBrowserSuite } from '../src/browser-suite-routes.js';

// ---------------------------------------------------------------------------

let dir: string;
let workspace: string;
const servers: Array<{ close: () => Promise<void> }> = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'browser-suite-'));
  workspace = join(dir, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
});

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  rmSync(dir, { recursive: true, force: true });
});

async function startApp(build: (app: express.Express) => void): Promise<string> {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  build(app);
  const server = await new Promise<ReturnType<typeof import('node:http').createServer>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = (server as unknown as { address(): AddressInfo }).address();
  servers.push({
    close: () => new Promise<void>((resolve) => (server as unknown as { close(cb: () => void): void }).close(() => resolve())),
  });
  return `http://127.0.0.1:${addr.port}`;
}

async function api(base: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

// ---------------------------------------------------------------------------
// BR-13 — permission suite
// ---------------------------------------------------------------------------

describe('BR-13 browser permission suite', () => {
  it('defaults every action to ask (never weaker than the approval-gated browser)', () => {
    const store = new BrowserPermissionStore(dir);
    expect(BROWSER_ACTION_DEFAULTS['fill-creds']).toBe('ask');
    for (const action of ['visit', 'submit', 'download', 'upload', 'fill-creds'] as const) {
      expect(store.evaluate({ profileId: 'bot-1', action }).effect).toBe('ask');
    }
    expect(store.settingsFor('bot-1').visit).toBe('ask');
  });

  it('standing rules apply per profile, and origin rules beat profile rules', () => {
    const store = new BrowserPermissionStore(dir);
    store.setRule({ profileId: 'bot-1', action: 'visit', effect: 'allow' });
    store.setRule({ profileId: 'bot-1', action: 'visit', effect: 'deny', origin: '*.evil.example' });
    expect(store.evaluate({ profileId: 'bot-1', action: 'visit', url: 'https://shop.example.com/x' }).effect).toBe('allow');
    const denied = store.evaluate({ profileId: 'bot-1', action: 'visit', url: 'https://sub.evil.example/x' });
    expect(denied.effect).toBe('deny');
    expect(denied.source).toBe('origin-rule');
    // A different profile is untouched.
    expect(store.evaluate({ profileId: 'bot-2', action: 'visit', url: 'https://shop.example.com' }).effect).toBe('ask');
    // Exact-host origin does not match subdomains.
    store.setRule({ profileId: 'bot-1', action: 'submit', effect: 'deny', origin: 'bank.example.com' });
    expect(store.evaluate({ profileId: 'bot-1', action: 'submit', url: 'https://sub.bank.example.com' }).source).toBe('default');
    expect(store.evaluate({ profileId: 'bot-1', action: 'submit', url: 'https://bank.example.com' }).effect).toBe('deny');
  });

  it('fill-creds can never be given a standing allow', () => {
    const store = new BrowserPermissionStore(dir);
    expect(() => store.setRule({ profileId: 'bot-1', action: 'fill-creds', effect: 'allow' })).toThrow(/per-action/);
    store.setRule({ profileId: 'bot-1', action: 'fill-creds', effect: 'deny' });
    expect(store.evaluate({ profileId: 'bot-1', action: 'fill-creds' }).effect).toBe('deny');
    store.setRule({ profileId: 'bot-1', action: 'fill-creds', effect: 'ask' });
    expect(store.evaluate({ profileId: 'bot-1', action: 'fill-creds' }).effect).toBe('ask');
  });

  it('one-time grants authorize exactly one action and are consumed', () => {
    const store = new BrowserPermissionStore(dir);
    const { token } = store.grantOnce({ profileId: 'bot-1', action: 'fill-creds', grantedBy: 'ashutosh' });
    const first = store.evaluate({ profileId: 'bot-1', action: 'fill-creds', onceToken: token });
    expect(first.effect).toBe('allow');
    expect(first.source).toBe('one-time-grant');
    // Second use: token spent — back to ask.
    expect(store.evaluate({ profileId: 'bot-1', action: 'fill-creds', onceToken: token }).effect).toBe('ask');
    // A token for another action does not leak across actions.
    const { token: submitToken } = store.grantOnce({ profileId: 'bot-1', action: 'submit' });
    expect(store.evaluate({ profileId: 'bot-1', action: 'fill-creds', onceToken: submitToken }).effect).toBe('ask');
    expect(store.evaluate({ profileId: 'bot-1', action: 'submit', onceToken: submitToken }).effect).toBe('allow');
    // Origin-scoped grant does not authorize a different origin.
    const { token: originToken } = store.grantOnce({ profileId: 'bot-1', action: 'submit', origin: 'shop.example.com' });
    expect(store.evaluate({ profileId: 'bot-1', action: 'submit', url: 'https://other.example.com', onceToken: originToken }).effect).toBe('ask');
    expect(store.evaluate({ profileId: 'bot-1', action: 'submit', url: 'https://shop.example.com', onceToken: originToken }).effect).toBe('allow');
    // Expired grant (fake clock) does not authorize.
    let now = 1_000_000;
    const clockStore = new BrowserPermissionStore(join(dir, 'clocked'), { now: () => now });
    const { token: expToken } = clockStore.grantOnce({ profileId: 'b', action: 'submit', ttlMs: 1000 });
    now += 2000;
    expect(clockStore.evaluate({ profileId: 'b', action: 'submit', onceToken: expToken }).effect).toBe('ask');
  });

  it('hard denials beat standing rules and one-time grants', () => {
    const store = new BrowserPermissionStore(dir, {
      hardDeny: ({ origin }) => (origin === 'blocked.example' ? 'host on the governance denylist' : undefined),
    });
    store.setRule({ profileId: 'bot-1', action: 'visit', effect: 'allow' });
    const { token } = store.grantOnce({ profileId: 'bot-1', action: 'visit' });
    const ev = store.evaluate({ profileId: 'bot-1', action: 'visit', url: 'https://blocked.example/', onceToken: token });
    expect(ev.effect).toBe('deny');
    expect(ev.source).toBe('hard-deny');
    // The grant was NOT consumed by the hard-denied evaluation.
    expect(store.evaluate({ profileId: 'bot-1', action: 'visit', url: 'https://ok.example/', onceToken: token }).effect).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// BR-9 — takeover + handback
// ---------------------------------------------------------------------------

describe('BR-9 takeover + handback flow', () => {
  it('walks the full defined flow and places/releases the §1.4 hold at the right steps', () => {
    const registry = new BrowserHoldRegistry();
    const manager = new BrowserTakeoverManager({ registry });
    const session = manager.requestTakeover({ profileId: 'bot-1', personId: 'p1', personName: 'Ashutosh', reason: 'checkout review' });
    expect(session.state).toBe('takeover-requested');
    // No hold yet: the bot still owns the browser until begin.
    expect(() => registry.assertNotHeld('bot-1')).not.toThrow();

    manager.begin(session.id);
    expect(manager.get(session.id)?.state).toBe('user-control');
    expect(() => registry.assertNotHeld('bot-1')).toThrow(/held by Ashutosh/);

    manager.requestHandback(session.id);
    expect(manager.get(session.id)?.state).toBe('handback-requested');
    // Hold stays placed during handback-requested — no race window.
    expect(() => registry.assertNotHeld('bot-1')).toThrow();

    const closed = manager.completeHandback(session.id);
    expect(closed.state).toBe('agent-control');
    expect(() => registry.assertNotHeld('bot-1')).not.toThrow();
    expect(closed.transitions.map((t) => t.to)).toEqual([
      'takeover-requested',
      'user-control',
      'handback-requested',
      'agent-control',
    ]);
    expect(manager.listHistory()).toHaveLength(1);
  });

  it('refuses a second live session and out-of-order transitions', () => {
    const manager = new BrowserTakeoverManager({ registry: new BrowserHoldRegistry() });
    const s = manager.requestTakeover({ profileId: 'bot-1', personId: 'p1' });
    expect(() => manager.requestTakeover({ profileId: 'bot-1', personId: 'p2' })).toThrow(TakeoverConflictError);
    expect(() => manager.requestHandback(s.id)).toThrow(TakeoverStateError);
    manager.begin(s.id);
    // Completing from user-control without a handback request is refused.
    expect(() => manager.completeHandback(s.id)).toThrow(TakeoverStateError);
    const forced = manager.completeHandback(s.id, { force: true, by: 'admin' });
    expect(forced.forced).toBe(true);
    expect(() => manager.begin(s.id)).toThrow(TakeoverStateError);
  });

  it('unacknowledged requests expire; user-control never auto-releases', () => {
    let now = 5000;
    const registry = new BrowserHoldRegistry();
    const manager = new BrowserTakeoverManager({ registry, now: () => now, requestTtlMs: 1000 });
    const stale = manager.requestTakeover({ profileId: 'bot-1', personId: 'p1' });
    now += 2000;
    expect(manager.liveFor('bot-1')).toBeUndefined();
    expect(manager.get(stale.id)?.state).toBe('agent-control');

    const live = manager.takeOverNow({ profileId: 'bot-2', personId: 'p1' });
    now += 60 * 60 * 1000; // an hour in user-control
    expect(manager.liveFor('bot-2')?.state).toBe('user-control');
    expect(() => registry.assertNotHeld('bot-2')).toThrow();
    expect(live.state).toBe('user-control');
  });

  it('a raw §1.4 hold by someone else blocks a takeover request', () => {
    const registry = new BrowserHoldRegistry();
    registry.hold({ profileId: 'bot-1', personId: 'someone-else' });
    const manager = new BrowserTakeoverManager({ registry });
    expect(() => manager.requestTakeover({ profileId: 'bot-1', personId: 'p1' })).toThrow(/held by/);
  });
});

// ---------------------------------------------------------------------------
// BR-7 — file grants
// ---------------------------------------------------------------------------

describe('BR-7 scoped + size-classified file grants', () => {
  it('classifies sizes with a hard 100 MiB ceiling (162 MB rejected, 84 MB = L)', () => {
    expect(classifyFileSize(1024)).toBe('S');
    expect(classifyFileSize(20 * 1024 * 1024)).toBe('M');
    expect(classifyFileSize(84 * 1024 * 1024)).toBe('L');
    expect(classifyFileSize(FILE_GRANT_HARD_MAX_BYTES)).toBe('L');
    expect(classifyFileSize(162 * 1024 * 1024)).toBeNull();
  });

  function mintUpload(store: BrowserFileGrantStore, over: Partial<Parameters<BrowserFileGrantStore['mint']>[0]> = {}) {
    return store.mint({
      direction: 'upload',
      profileId: 'bot-1',
      pathScope: 'exports/',
      sizeClass: 'M',
      grantedBy: 'ashutosh',
      ...over,
    });
  }

  it('authorizes an in-scope, in-class file and consumes uses', () => {
    const store = new BrowserFileGrantStore(dir);
    const { token, grant } = mintUpload(store);
    const auth = store.authorize({
      token, direction: 'upload', profileId: 'bot-1', relPath: 'exports/clip.mp4', sizeBytes: 30 * 1024 * 1024,
    });
    expect(auth.ok).toBe(true);
    expect(auth.actualClass).toBe('M');
    expect(auth.grant.usedCount).toBe(1);
    expect(grant.maxUses).toBe(1); // uploads default to single-use
    expect(() =>
      store.authorize({ token, direction: 'upload', profileId: 'bot-1', relPath: 'exports/clip.mp4', sizeBytes: 1024 }),
    ).toThrow(FileGrantDeniedError);
  });

  it('denies out-of-scope paths, wrong task/profile/direction, oversize and revoked grants — without consuming', () => {
    const store = new BrowserFileGrantStore(dir);
    const { token, grant } = mintUpload(store, { taskId: 'task-9', maxUses: 5 });
    const base = { token, direction: 'upload' as const, profileId: 'bot-1', taskId: 'task-9', relPath: 'exports/a.bin', sizeBytes: 1024 };
    expect(() => store.authorize({ ...base, relPath: 'secrets/a.bin' })).toThrow(/outside the grant scope/);
    expect(() => store.authorize({ ...base, taskId: 'task-2' })).toThrow(/different task/);
    expect(() => store.authorize({ ...base, profileId: 'bot-2' })).toThrow(/different browser profile/);
    expect(() => store.authorize({ ...base, direction: 'download' })).toThrow(/for upload, not download/);
    expect(() => store.authorize({ ...base, sizeBytes: 60 * 1024 * 1024 })).toThrow(/caps at class M/);
    expect(() => store.authorize({ ...base, sizeBytes: 162 * 1024 * 1024 })).toThrow(/hard classification ceiling/);
    expect(() => store.authorize({ ...base, relPath: '../escape.bin' })).toThrow(FileGrantDeniedError);
    // None of the denials consumed a use.
    expect(store.get(grant.id)?.usedCount).toBe(0);
    store.revoke(grant.id);
    expect(() => store.authorize(base)).toThrow(/revoked/);
  });

  it('confines to the real workspace file and verifies its size when a root is given', () => {
    const store = new BrowserFileGrantStore(dir);
    fs.mkdirSync(join(workspace, 'exports'), { recursive: true });
    fs.writeFileSync(join(workspace, 'exports', 'clip.mp4'), Buffer.alloc(2048));
    const { token } = mintUpload(store);
    const auth = store.authorize({
      token, direction: 'upload', profileId: 'bot-1', relPath: 'exports/clip.mp4', sizeBytes: 2048, workspaceRoot: workspace,
    });
    expect(auth.ok).toBe(true);
    const { token: token2 } = mintUpload(store);
    expect(() =>
      store.authorize({ token: token2, direction: 'upload', profileId: 'bot-1', relPath: 'exports/clip.mp4', sizeBytes: 999, workspaceRoot: workspace }),
    ).toThrow(/size mismatch/);
    const { token: token3 } = mintUpload(store);
    expect(() =>
      store.authorize({ token: token3, direction: 'upload', profileId: 'bot-1', relPath: 'exports/missing.mp4', sizeBytes: 10, workspaceRoot: workspace }),
    ).toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
// BR-10 — question cards to the originating chat
// ---------------------------------------------------------------------------

describe('BR-10 browser question cards', () => {
  it('answers through the internal surface and resolves the runner waiter', async () => {
    const cards = new BrowserQuestionCards();
    const card = await cards.ask({
      sessionId: 'chat-1', botId: 'bot-1', profileId: 'bot-1', kind: 'confirm', question: 'Price changed to $12 — proceed?',
    });
    expect(card.status).toBe('pending');
    const waiting = cards.awaitAnswer(card.id, 5000);
    cards.answer(card.id, { value: true, answeredBy: 'ashutosh' });
    await expect(waiting).resolves.toEqual({ answered: true, value: true });
    expect(cards.get(card.id)?.status).toBe('answered');
    expect(() => cards.answer(card.id, { value: false })).toThrow(/already answered/);
  });

  it('fails closed on expiry and on cancel', async () => {
    const cards = new BrowserQuestionCards();
    const card = await cards.ask({ sessionId: 'chat-1', botId: 'b', profileId: 'b', kind: 'text', question: 'OTP?', ttlMs: 30 });
    await expect(cards.awaitAnswer(card.id, 5000)).resolves.toEqual({ answered: false, expired: true });
    expect(cards.get(card.id)?.status).toBe('expired');

    const card2 = await cards.ask({ sessionId: 'chat-1', botId: 'b', profileId: 'b', kind: 'confirm', question: 'Go?' });
    const waiting = cards.awaitAnswer(card2.id, 5000);
    cards.cancel(card2.id);
    await expect(waiting).resolves.toEqual({ answered: false, expired: false, cancelled: true });
  });

  it('raises a real widget in the ORIGINATING chat session and syncs its answer', async () => {
    const widgetStore = new WidgetStore(join(dir, 'widgets'));
    const coordinator = new WidgetCoordinator(widgetStore);
    const cards = new BrowserQuestionCards({ widgets: coordinator });
    const card = await cards.ask({
      sessionId: 'originating-chat', botId: 'bot-1', profileId: 'bot-1', kind: 'choice',
      question: 'Which address?', options: ['Home', 'Office'],
    });
    expect(card.widgetId).toBeTruthy();
    const widget = widgetStore.get(card.widgetId as string);
    expect(widget?.sessionId).toBe('originating-chat');
    expect(widget?.botId).toBe('bot-1');
    expect(widget?.interactive).toBe(true);
    // The user answers in chat (the widget route settles the coordinator).
    const waiting = cards.awaitAnswer(card.id, 5000);
    coordinator.settle(card.widgetId as string, { answered: true, value: 'o2' });
    await expect(waiting).resolves.toEqual({ answered: true, value: 'o2' });
    expect(cards.list({ sessionId: 'originating-chat' })).toHaveLength(1);
    expect(cards.list({ sessionId: 'some-other-chat' })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// BR-12 — protected artifacts over FL-7
// ---------------------------------------------------------------------------

describe('BR-12 downloads/screenshots as protected artifacts', () => {
  it('registers bytes with a hash, serves them only via the store, and mints FL-7 links', () => {
    const fileLinks = new FileLinkService(dir);
    const store = new BrowserArtifactStore(dir, { fileLinks });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const artifact = store.register({
      kind: 'screenshot', profileId: 'bot-1', fileName: 'checkout page.png', bytes: png, sourceUrl: 'https://shop.example.com/cart',
    });
    expect(artifact.sizeBytes).toBe(png.length);
    expect(artifact.sha256).toHaveLength(64);
    expect(artifact.storedName).not.toContain('checkout');
    expect(store.readBytes(artifact.id).bytes).toEqual(Buffer.from(png));

    // FL-7 link: approval-gated — pending until the gateway approves.
    const created = store.mintLink(artifact.id, { ttlMs: 60 * 60 * 1000, confirmed: true });
    expect(created.link.status).toBe('active');
    const resolved = fileLinks.resolveToken(created.token);
    const served = fileLinks.fileForDownload(resolved);
    expect(fs.readFileSync(served.absPath)).toEqual(Buffer.from(png));
  });

  it('minting a link without approval or confirmation is refused (FL-7 gate)', () => {
    const store = new BrowserArtifactStore(dir);
    const artifact = store.register({ kind: 'download', profileId: 'bot-1', fileName: 'invoice.pdf', bytes: new Uint8Array([1]) });
    expect(() => store.mintLink(artifact.id, {})).toThrow(/requires an approval/);
  });

  it('deleting an artifact removes bytes and revokes its FL-7 links', () => {
    const fileLinks = new FileLinkService(dir);
    const store = new BrowserArtifactStore(dir, { fileLinks });
    const artifact = store.register({ kind: 'download', profileId: 'bot-1', fileName: 'a.zip', bytes: new Uint8Array([9, 9]) });
    const created = store.mintLink(artifact.id, { confirmed: true });
    const { linksRevoked } = store.delete(artifact.id);
    expect(linksRevoked).toBe(1);
    expect(store.get(artifact.id)).toBeUndefined();
    expect(() => fileLinks.resolveToken(created.token)).toThrow(/revoked/);
    expect(fs.existsSync(join(store.artifactDir, artifact.storedName))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// BR-11 — one checkout per window
// ---------------------------------------------------------------------------

describe('BR-11 one-checkout-per-window', () => {
  it('refuses a second checkout on the same window, allows other windows, releases cleanly', async () => {
    const guard = new CheckoutWindowGuard();
    const lease = guard.acquire({ windowId: 'win-1', profileId: 'bot-1', checkoutId: 'intent-1', merchant: 'Shop A' });
    expect(() => guard.acquire({ windowId: 'win-1', profileId: 'bot-1', checkoutId: 'intent-2' })).toThrow(CheckoutBusyError);
    // Same checkout re-acquiring is an idempotent refresh.
    expect(guard.acquire({ windowId: 'win-1', profileId: 'bot-1', checkoutId: 'intent-1' }).id).toBe(lease.id);
    expect(guard.acquire({ windowId: 'win-2', profileId: 'bot-1', checkoutId: 'intent-2' }).windowId).toBe('win-2');
    guard.release(lease.id, 'completed');
    expect(guard.activeFor('win-1')).toBeUndefined();
    expect(guard.acquire({ windowId: 'win-1', profileId: 'bot-1', checkoutId: 'intent-3' }).checkoutId).toBe('intent-3');
  });

  it('runExclusive holds the lease for the fn duration and releases on throw', async () => {
    const guard = new CheckoutWindowGuard();
    await expect(
      guard.runExclusive({ windowId: 'w', profileId: 'b', checkoutId: 'c1' }, async () => {
        expect(guard.activeFor('w')?.checkoutId).toBe('c1');
        throw new Error('checkout blew up');
      }),
    ).rejects.toThrow('checkout blew up');
    expect(guard.activeFor('w')).toBeUndefined();
    expect(guard.listHistory()[0]?.releaseReason).toBe('abandoned');
    const out = await guard.runExclusive({ windowId: 'w', profileId: 'b', checkoutId: 'c2' }, async () => 42);
    expect(out).toBe(42);
    expect(guard.listHistory()[0]?.releaseReason).toBe('completed');
  });

  it('leases expire so a crashed checkout cannot lock a window forever', () => {
    let now = 1000;
    const guard = new CheckoutWindowGuard({ now: () => now });
    guard.acquire({ windowId: 'w', profileId: 'b', checkoutId: 'c1', ttlMs: 500 });
    now += 600;
    expect(guard.activeFor('w')).toBeUndefined();
    expect(guard.listHistory()[0]?.releaseReason).toBe('expired');
    expect(guard.acquire({ windowId: 'w', profileId: 'b', checkoutId: 'c2' }).checkoutId).toBe('c2');
  });
});

// ---------------------------------------------------------------------------
// BR-8 — CAPTCHA: user-takeover only, no solver, plainly stated boundary
// ---------------------------------------------------------------------------

describe('BR-8 CAPTCHA handling (decision row)', () => {
  it('policy states the boundary and lists zero solver integrations', () => {
    const handler = new BrowserCaptchaHandler({ takeover: new BrowserTakeoverManager({ registry: new BrowserHoldRegistry() }) });
    const policy = handler.policy();
    expect(policy.mode).toBe('user-takeover');
    expect(policy.solverIntegrations).toEqual([]);
    expect(policy.automatedSolving).toBe(false);
    expect(policy.copy.body).toMatch(/will not solve CAPTCHAs/);
    expect(CAPTCHA_BOUNDARY_COPY.body).toMatch(/does not use any CAPTCHA-solving service/);
  });

  it('refuses solver-service configuration at construction', () => {
    expect(() => assertNoSolverConfig({ twoCaptchaApiKey: 'x' })).toThrow(/does not integrate solver services/);
    expect(() => assertNoSolverConfig({ CAPTCHA_SOLVER_API_KEY: 'x' })).toThrow(/does not integrate solver services/);
    expect(() => assertNoSolverConfig({ theme: 'dark' })).not.toThrow();
    expect(
      () =>
        new BrowserCaptchaHandler({
          takeover: new BrowserTakeoverManager({ registry: new BrowserHoldRegistry() }),
          config: { capSolverApiKey: 'x' },
        }),
    ).toThrow(/does not integrate solver services/);
  });

  it('a detected challenge escalates to BR-9 user takeover (hold placed, user completes it)', () => {
    const registry = new BrowserHoldRegistry();
    const takeover = new BrowserTakeoverManager({ registry });
    const handler = new BrowserCaptchaHandler({ takeover });
    const escalation = handler.handleChallenge({
      profileId: 'bot-1', personId: 'p1', personName: 'Ashutosh',
      signal: { kind: 'captcha', url: 'https://shop.example.com/login' },
    });
    expect(escalation.action).toBe('user-takeover');
    expect(escalation.takeover.state).toBe('user-control');
    expect(escalation.takeover.reason).toMatch(/user completes it personally/);
    expect(() => registry.assertNotHeld('bot-1')).toThrow(/held by Ashutosh/);
  });

  it('detects challenge signals from page evidence (detection only)', () => {
    expect(detectChallengeSignal({ selectorsPresent: ['iframe[src*="recaptcha"]'] })?.kind).toBe('captcha');
    expect(detectChallengeSignal({ pageText: 'Please verify you are human to continue' })?.kind).toBe('human-verification');
    expect(detectChallengeSignal({ pageText: 'Welcome to our shop, human visitor' })).toBeUndefined();
    expect(detectChallengeSignal({ httpStatus: 200, pageText: 'All good' })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The composing gate
// ---------------------------------------------------------------------------

describe('browser action gate (composition order)', () => {
  function makeGate() {
    const holds = new BrowserHoldRegistry();
    const permissions = new BrowserPermissionStore(dir);
    const grants = new BrowserFileGrantStore(dir);
    const checkoutGuard = new CheckoutWindowGuard();
    const gate = new BrowserActionGate({ permissions, holds, grants, checkoutGuard });
    return { holds, permissions, grants, checkoutGuard, gate };
  }

  it('hold beats everything; captcha beats permissions; permission deny beats a file grant', () => {
    const { holds, permissions, grants, gate } = makeGate();
    permissions.setRule({ profileId: 'bot-1', action: 'visit', effect: 'allow' });
    holds.hold({ profileId: 'bot-1', personId: 'p1' });
    expect(gate.check({ profileId: 'bot-1', action: 'visit', url: 'https://x.example' })).toMatchObject({ decision: 'deny', code: 'held-by-user' });
    holds.release('bot-1', { force: true });

    expect(
      gate.check({ profileId: 'bot-1', action: 'visit', url: 'https://x.example', challenge: { kind: 'captcha' } }),
    ).toMatchObject({ decision: 'deny', code: 'captcha-takeover-required' });

    permissions.setRule({ profileId: 'bot-1', action: 'upload', effect: 'deny' });
    const { token } = grants.mint({ direction: 'upload', profileId: 'bot-1', pathScope: 'exports/', sizeClass: 'S' });
    expect(
      gate.check({ profileId: 'bot-1', action: 'upload', file: { grantToken: token, relPath: 'exports/a.bin', sizeBytes: 10 } }),
    ).toMatchObject({ decision: 'deny', code: 'permission-denied' });
    // …and the grant was not consumed by the denied check.
    expect(grants.list('bot-1')[0]?.usedCount).toBe(0);
  });

  it('upload needs BOTH a permission allow and a valid grant', () => {
    const { permissions, grants, gate } = makeGate();
    // Permission still at default ask → ask, grant untouched.
    const { token } = grants.mint({ direction: 'upload', profileId: 'bot-1', pathScope: 'exports/', sizeClass: 'S' });
    expect(
      gate.check({ profileId: 'bot-1', action: 'upload', file: { grantToken: token, relPath: 'exports/a.bin', sizeBytes: 10 } }),
    ).toMatchObject({ decision: 'ask' });
    permissions.setRule({ profileId: 'bot-1', action: 'upload', effect: 'allow' });
    // No grant presented → deny.
    expect(gate.check({ profileId: 'bot-1', action: 'upload' })).toMatchObject({ decision: 'deny', code: 'file-grant-denied' });
    // Both present → allow, grant consumed.
    expect(
      gate.check({ profileId: 'bot-1', action: 'upload', file: { grantToken: token, relPath: 'exports/a.bin', sizeBytes: 10 } }),
    ).toMatchObject({ decision: 'allow' });
    expect(grants.list('bot-1')[0]?.usedCount).toBe(1);
  });

  it('a busy checkout window blocks a submit for a different checkout only', () => {
    const { permissions, checkoutGuard, gate } = makeGate();
    permissions.setRule({ profileId: 'bot-1', action: 'submit', effect: 'allow' });
    checkoutGuard.acquire({ windowId: 'win-1', profileId: 'bot-1', checkoutId: 'intent-1' });
    expect(
      gate.check({ profileId: 'bot-1', action: 'submit', checkout: { windowId: 'win-1', checkoutId: 'intent-2' } }),
    ).toMatchObject({ decision: 'deny', code: 'checkout-busy' });
    expect(
      gate.check({ profileId: 'bot-1', action: 'submit', checkout: { windowId: 'win-1', checkoutId: 'intent-1' } }),
    ).toMatchObject({ decision: 'allow' });
    expect(gate.check({ profileId: 'bot-1', action: 'submit' })).toMatchObject({ decision: 'allow' });
  });
});

// ---------------------------------------------------------------------------
// HTTP surface (combined suite router)
// ---------------------------------------------------------------------------

describe('browser suite routes', () => {
  it('serves permissions, takeover, grants, captcha policy and checkout leases over HTTP', async () => {
    const suite = createBrowserSuite({ dataDir: dir, workspaceRoot: workspace });
    const base = await startApp((app) => app.use('/api/browser', suite.router));

    // BR-13
    let r = await api(base, 'PUT', '/api/browser/permissions', { profileId: 'bot-1', action: 'visit', effect: 'allow' });
    expect(r.status).toBe(200);
    r = await api(base, 'PUT', '/api/browser/permissions', { profileId: 'bot-1', action: 'fill-creds', effect: 'allow' });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/per-action/);
    r = await api(base, 'POST', '/api/browser/permissions/evaluate', { profileId: 'bot-1', action: 'visit', url: 'https://x.example' });
    expect(r.json.evaluation.effect).toBe('allow');
    r = await api(base, 'POST', '/api/browser/permissions/once-grants', { profileId: 'bot-1', action: 'fill-creds', grantedBy: 'ashutosh' });
    expect(r.status).toBe(201);
    const onceToken = r.json.token as string;
    r = await api(base, 'POST', '/api/browser/permissions/evaluate', { profileId: 'bot-1', action: 'fill-creds', onceToken });
    expect(r.json.evaluation.effect).toBe('allow');

    // BR-9
    r = await api(base, 'POST', '/api/browser/takeover/bot-1', { personId: 'p1', beginImmediately: true, reason: 'help' });
    expect(r.status).toBe(201);
    const sessionId = r.json.session.id as string;
    expect(r.json.session.state).toBe('user-control');
    expect(suite.gate.check({ profileId: 'bot-1', action: 'visit' })).toMatchObject({ decision: 'deny', code: 'held-by-user' });
    r = await api(base, 'POST', `/api/browser/takeover/session/${sessionId}/handback`, {});
    expect(r.json.session.state).toBe('handback-requested');
    r = await api(base, 'POST', `/api/browser/takeover/session/${sessionId}/complete`, {});
    expect(r.json.session.state).toBe('agent-control');
    expect(suite.gate.check({ profileId: 'bot-1', action: 'visit' })).toMatchObject({ decision: 'allow' });

    // BR-7 (the suite was built with workspaceRoot=workspace, so the
    // confinement check needs the real file to exist there)
    fs.mkdirSync(join(workspace, 'exports'), { recursive: true });
    fs.writeFileSync(join(workspace, 'exports', 'a.bin'), Buffer.alloc(100));
    r = await api(base, 'POST', '/api/browser/file-grants', {
      direction: 'upload', profileId: 'bot-1', pathScope: 'exports/', sizeClass: 'S', grantedBy: 'ashutosh',
    });
    expect(r.status).toBe(201);
    const grantToken = r.json.token as string;
    r = await api(base, 'POST', '/api/browser/file-grants/authorize', {
      token: grantToken, direction: 'upload', profileId: 'bot-1', relPath: 'exports/a.bin', sizeBytes: 100,
    });
    expect(r.status).toBe(200);
    r = await api(base, 'POST', '/api/browser/file-grants/authorize', {
      token: grantToken, direction: 'upload', profileId: 'bot-1', relPath: 'exports/a.bin', sizeBytes: 100,
    });
    expect(r.status).toBe(403); // single use spent

    // BR-11
    r = await api(base, 'POST', '/api/browser/checkout-leases', { windowId: 'win-1', profileId: 'bot-1', checkoutId: 'i1' });
    expect(r.status).toBe(201);
    r = await api(base, 'POST', '/api/browser/checkout-leases', { windowId: 'win-1', profileId: 'bot-1', checkoutId: 'i2' });
    expect(r.status).toBe(409);
    expect(r.json.holder.checkoutId).toBe('i1');

    // BR-8
    r = await api(base, 'GET', '/api/browser/captcha/policy');
    expect(r.json.mode).toBe('user-takeover');
    expect(r.json.solverIntegrations).toEqual([]);
    expect(r.json.copy.body).toMatch(/will not solve CAPTCHAs/);
    r = await api(base, 'POST', '/api/browser/captcha/detect', { pageText: 'Please verify you are human' });
    expect(r.json.signal.kind).toBe('human-verification');
    expect(r.json.handling).toBe('user-takeover');

    // BR-10 + BR-12 over HTTP
    r = await api(base, 'POST', '/api/browser/questions', {
      sessionId: 'chat-9', botId: 'bot-1', profileId: 'bot-1', kind: 'confirm', question: 'Proceed?',
    });
    expect(r.status).toBe(201);
    const cardId = r.json.card.id as string;
    r = await api(base, 'POST', `/api/browser/questions/${cardId}/answer`, { value: true });
    expect(r.json.card.status).toBe('answered');
    r = await api(base, 'GET', '/api/browser/artifacts?profileId=bot-1');
    expect(r.json.artifacts).toEqual([]);
  });
});
