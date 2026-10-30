// SPDX-License-Identifier: Apache-2.0
// Companion WS closure: #94 resumable sessions (token + seq + replay,
// cost fields), #95 dead-client eviction + backpressure, #96 session
// commands over WS, #51 WS elicitation bridge. In-process mock sockets.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CompanionHub, CompanionStore, runStatusPush, type CompanionSocket } from '../src/companion.js';
import { LivenessTracker, ReplayBuffer, shouldDropOutbound } from '../src/ws-hub-util.js';
import { createWsElicitationBridge, registerCompanionElicitationSurface } from '../src/elicitation-ws.js';
import { ElicitationRouter } from '@mvp/agent-runtime';

class MockSocket implements CompanionSocket {
  sent: string[] = [];
  closedWith: number | null = null;
  bufferedAmount = 0;
  private msgCb: ((t: string) => void) | null = null;
  private closeCb: (() => void) | null = null;
  sendText(t: string): void { this.sent.push(t); }
  close(code = 1000): void { if (this.closedWith === null) { this.closedWith = code; this.closeCb?.(); } }
  onMessage(cb: (t: string) => void): void { this.msgCb = cb; }
  onClose(cb: () => void): void { this.closeCb = cb; }
  clientSend(obj: unknown): void { this.msgCb?.(JSON.stringify(obj)); }
  clientDisconnect(): void { this.closeCb?.(); }
  allJson(): Array<Record<string, unknown>> { return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>); }
}

function setup(opts: ConstructorParameters<typeof CompanionHub>[2] = {}) {
  const store = new CompanionStore(mkdtempSync(join(tmpdir(), 'companion-ws-')));
  const rec = store.requestPairingOTT();
  const res = store.exchangePairing({ ott: rec.ott, deviceName: 'Pixel', platform: 'android' });
  if (!res.ok) throw new Error('pairing failed');
  const hub = new CompanionHub(store, () => {}, opts);
  const device = store.findDeviceByToken(res.token)!;
  return { store, hub, device };
}

describe('#94 resumable WS sessions', () => {
  it('issues a resume token + sequence numbers and replays missed events on reconnect', () => {
    const { hub, device } = setup();
    const a = new MockSocket();
    hub.acceptSocket(a, '127.0.0.1', device);
    a.clientSend({ t: 'hello' });
    const hello = a.allJson().find((m) => m.type === 'hello')!;
    const token = hello.resumeToken as string;
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect(typeof hello.seq).toBe('number');
    hub.broadcast({ type: 'run-status', run: { id: 'r1', state: 'running' } });
    hub.broadcast({ type: 'run-status', run: { id: 'r2', state: 'done' } });
    const seqs = a.allJson().map((m) => m.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => Number(x) - Number(y))); // monotonic
    a.clientDisconnect();

    const b = new MockSocket();
    hub.acceptSocket(b, '127.0.0.1', device);
    b.clientSend({ t: 'hello', resumeToken: token, lastSeq: hello.seq });
    const frames = b.allJson();
    const resume = frames.find((m) => m.type === 'resume')!;
    expect(resume.ok).toBe(true);
    expect(resume.replayed).toBe(2);
    const replayedRuns = frames.filter((m) => m.type === 'run-status').map((m) => (m.run as { id: string }).id);
    expect(replayedRuns).toEqual(['r1', 'r2']);
    hub.close();
  });

  it('a bogus resume token falls back to a fresh hello with a new token', () => {
    const { hub, device } = setup();
    const a = new MockSocket();
    hub.acceptSocket(a, '127.0.0.1', device);
    a.clientSend({ t: 'hello', resumeToken: 'deadbeef', lastSeq: 5 });
    const hello = a.allJson().find((m) => m.type === 'hello')!;
    expect(hello.resumed).toBeUndefined();
    expect(hello.resumeToken).not.toBe('deadbeef');
    hub.close();
  });

  it('run-status pushes carry cost fields (null when the runtime has none)', () => {
    const withCost = runStatusPush({ id: 'r' }, { costUsd: 0.42, totalTokens: 1234 });
    expect((withCost as { run: Record<string, unknown> }).run.costUsd).toBe(0.42);
    const without = runStatusPush({ id: 'r' });
    expect((without as { run: Record<string, unknown> }).run.costUsd).toBeNull();
    expect((without as { run: Record<string, unknown> }).run.totalTokens).toBeNull();
  });

  it('ReplayBuffer reports truncation when the client is behind the retained window', () => {
    const buf = new ReplayBuffer(2);
    const token = buf.issue(1000);
    buf.record('a', 1001); buf.record('b', 1002); buf.record('c', 1003);
    const r = buf.resume(token, 0, 1004);
    expect(r?.truncated).toBe(false); // lastSeq 0 = fresh client, not "behind"
    const r2 = buf.resume(token, 1, 1004);
    expect(r2?.events.map((e) => e.text)).toEqual(['b', 'c']);
    expect(buf.resume('wrong', 1)).toBeNull();
  });
});

describe('#95 eviction + backpressure', () => {
  it('evicts a silent client via reapStale; a chatty client survives', () => {
    let now = 1_000_000;
    const { hub, device } = setup({ silenceMs: 1000, reapIntervalMs: 0, now: () => now });
    const silent = new MockSocket();
    hub.acceptSocket(silent, '127.0.0.1', device);
    silent.clientSend({ t: 'hello' });
    now += 5000;
    expect(hub.reapStale()).toBe(1);
    expect(silent.closedWith).toBe(4001);
    hub.close();
  });

  it('drops low-priority frames for a slow client but not for others, and never drops high-priority', () => {
    const { hub, device } = setup();
    const slow = new MockSocket();
    slow.bufferedAmount = 5_000_000;
    const fast = new MockSocket();
    hub.acceptSocket(slow, '127.0.0.1', device);
    hub.acceptSocket(fast, '127.0.0.1', device);
    slow.clientSend({ t: 'hello' });
    fast.clientSend({ t: 'hello' });
    slow.sent = []; fast.sent = [];
    hub.broadcast({ type: 'activity', summary: 'hint' }); // low priority
    expect(slow.sent).toHaveLength(0);
    expect(fast.sent).toHaveLength(1);
    hub.broadcast({ type: 'run-status', run: { id: 'r9' } }); // normal priority: delivered even to slow
    expect(slow.sent).toHaveLength(1);
    expect(shouldDropOutbound({ bufferedAmount: 10 }, 'low')).toBe(false);
    expect(shouldDropOutbound({ bufferedAmount: 9_999_999 }, 'high')).toBe(false);
    hub.close();
  });

  it('LivenessTracker reaps by last-seen and forgets reaped ids', () => {
    const t = new LivenessTracker(1000);
    t.track('a', 0); t.track('b', 0); t.touch('b', 900);
    expect(t.reap(1500)).toEqual(['a']);
    expect(t.size).toBe(1);
  });
});

describe('#96 session commands over WS', () => {
  it('routes prompt/cancel/model/slash frames to the wired dispatch', async () => {
    const running = new Set<string>(['s1']);
    const calls: string[] = [];
    const { hub, device } = setup({
      onSessionCommand: (cmd) => {
        calls.push(cmd.type);
        if (cmd.type === 'cancel') { running.delete(cmd.sessionId ?? ''); return { cancelled: true }; }
        if (cmd.type === 'slash') return { reply: 'status ok' };
        return { accepted: true };
      },
    });
    const sock = new MockSocket();
    hub.acceptSocket(sock, '127.0.0.1', device);
    sock.clientSend({ t: 'hello' });
    sock.clientSend({ t: 'slash', sessionId: 's1', text: '/status' });
    sock.clientSend({ t: 'cancel', sessionId: 's1' });
    await new Promise((r) => setTimeout(r, 10));
    const results = sock.allJson().filter((m) => m.type === 'command_result');
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ command: 'slash', ok: true });
    expect(running.has('s1')).toBe(false); // cancel stopped the run
    expect(calls).toEqual(['slash', 'cancel']);
    hub.close();
  });

  it('without a wired dispatch, command frames get an honest error', () => {
    const { hub, device } = setup();
    const sock = new MockSocket();
    hub.acceptSocket(sock, '127.0.0.1', device);
    sock.clientSend({ t: 'hello' });
    sock.clientSend({ t: 'prompt', sessionId: 's1', text: 'hi' });
    expect(sock.allJson().at(-1)).toMatchObject({ type: 'error', detail: 'session_commands_unavailable' });
    hub.close();
  });
});

describe('#51 WS elicitation surface', () => {
  it('routes an elicitation request to the WS owner and returns their answer', async () => {
    const frames: Array<Record<string, unknown>> = [];
    const bridge = createWsElicitationBridge((frame) => { frames.push(frame as never); return true; }, { timeoutMs: 5000 });
    const router = new ElicitationRouter();
    const unregister = registerCompanionElicitationSurface(router, bridge);
    expect(router.surfaces()).toContain('ws');
    const pending = router.route({ message: 'Which repo?', requestedSchema: { properties: { repo: { type: 'string' } } } }, 'ws');
    expect(frames).toHaveLength(1);
    const id = (frames[0] as { id: string }).id;
    expect(bridge.resolveByFrame({ id, action: 'accept', content: { repo: 'kriyadot' } })).toBe(true);
    await expect(pending).resolves.toEqual({ action: 'accept', content: { repo: 'kriyadot' } });
    unregister();
    await expect(router.route({ message: 'x', requestedSchema: {} }, 'ws')).resolves.toEqual({ action: 'decline' });
  });
});
