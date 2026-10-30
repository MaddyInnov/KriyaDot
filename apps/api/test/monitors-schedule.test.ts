// SPDX-License-Identifier: Apache-2.0
// #88 origin-session scheduling + #91 generic monitors.
// Fakes only: an in-memory routine store double, a fake command runner,
// and a fake fetch — no real processes, no network.

import { describe, expect, it } from 'vitest';
import { GenericMonitorService, createScheduleTools } from '../src/schedule-tools.js';
import { createTriggerTools } from '../src/trigger-tools.js';

function fakeRoutineStore() {
  const routines: Array<Record<string, unknown>> = [];
  let seq = 0;
  return {
    routines,
    create(input: Record<string, unknown>) {
      const r = { id: `r${++seq}`, enabled: true, ...input };
      routines.push(r);
      return r;
    },
    list: () => routines,
    remove: (id: string) => { const i = routines.findIndex((r) => r.id === id); if (i >= 0) routines.splice(i, 1); },
  };
}

const ctx = { botId: 'bot-1', sessionId: 'session-abc_123' } as never;

describe('#88 origin-session scheduling', () => {
  it('schedule_task records the originating session as the routine session', async () => {
    const store = fakeRoutineStore();
    const tools = createScheduleTools(store as never);
    const schedule = tools.find((t) => t.name === 'schedule_task')!;
    const out = await schedule.handler({ name: 'Ping', prompt: 'check in', when: { kind: 'in_minutes', minutes: 5 } }, ctx) as { originSessionId?: string; firesInto?: string };
    expect(out.originSessionId).toBe('session-abc_123');
    expect(out.firesInto).toBe('originating session');
    // The routine's fixed session IS the origin session, so the
    // scheduler's existing fire path (routine.sessionId ?? routine_<id>)
    // injects the fired message into the originating session.
    expect(store.routines[0]?.sessionId).toBe('session-abc_123');
  });

  it('create_trigger threads the origin session too', async () => {
    const store = fakeRoutineStore();
    const tools = createTriggerTools(store as never);
    const create = tools.find((t) => t.name === 'create_trigger')!;
    const out = await create.handler({ name: 'T', prompt: 'do it' }, ctx) as { originSessionId?: string };
    expect(out.originSessionId).toBe('session-abc_123');
    expect(store.routines[0]?.sessionId).toBe('session-abc_123');
  });

  it('without a session context, routines keep the legacy fresh-session behaviour', async () => {
    const store = fakeRoutineStore();
    const tools = createScheduleTools(store as never);
    const schedule = tools.find((t) => t.name === 'schedule_task')!;
    const out = await schedule.handler({ name: 'Ping', prompt: 'x', when: { kind: 'interval', minutes: 10 } }, { botId: 'bot-1', sessionId: '' } as never) as { firesInto?: string };
    expect(out.firesInto).toBe('fresh routine session');
    expect(store.routines[0]?.sessionId).toBeUndefined();
  });
});

describe('#91 generic monitors', () => {
  it('command monitor batches events into ONE digest per interval', async () => {
    const digests: Array<{ id: string; digest: string; n: number }> = [];
    let emitLine: ((line: string) => void) | null = null;
    let stopped = false;
    const service = new GenericMonitorService({
      onDigest: (id, digest, events) => { digests.push({ id, digest, n: events.length }); },
      commandRunner: (_cmd, emit) => { emitLine = emit; return { stop: () => { stopped = true; } }; },
    });
    const rec = service.startCommand({ name: 'svc', command: ['fake', 'cmd'], batchMs: 60_000 });
    emitLine!('line one');
    emitLine!('line two');
    emitLine!('line three');
    // Nothing injected yet — events accumulate (rate limiting).
    expect(digests).toHaveLength(0);
    const flushed = await service.flush(rec.id);
    expect(flushed).toBe(3);
    expect(digests).toHaveLength(1);
    expect(digests[0]!.digest).toContain('line one');
    expect(digests[0]!.digest).toContain('3 event(s)');
    // A second flush with no new events injects nothing.
    expect(await service.flush(rec.id)).toBe(0);
    expect(digests).toHaveLength(1);
    expect(service.stop(rec.id)).toBe(true);
    expect(stopped).toBe(true);
    expect(service.list()).toHaveLength(0);
    service.stopAll();
  });

  it('feed monitor emits only on change, via the injected fetch', async () => {
    const digests: string[] = [];
    let body = 'v1';
    const service = new GenericMonitorService({
      onDigest: (_id, digest) => { digests.push(digest); },
      fetchFn: async () => ({ ok: true, status: 200, text: async () => body }),
    });
    const rec = service.startFeed({ name: 'feed', url: 'https://example.invalid/feed', batchMs: 60_000, pollMs: 250 });
    // First poll establishes the baseline — no event.
    await new Promise((r) => setTimeout(r, 10));
    expect(await service.flush(rec.id)).toBe(0);
    body = 'v2 changed';
    await new Promise((r) => setTimeout(r, 320)); // one poll tick sees the change
    expect(await service.flush(rec.id)).toBe(1);
    expect(digests[0]).toContain('v2 changed');
    expect(service.list()).toHaveLength(1);
    expect(service.stop(rec.id)).toBe(true);
  });

  it('monitor tools are added when a service is wired', async () => {
    const store = fakeRoutineStore();
    const service = new GenericMonitorService({ onDigest: () => {}, commandRunner: () => ({ stop: () => {} }) });
    const tools = createScheduleTools(store as never, { monitors: service });
    const names = tools.map((t) => t.name);
    expect(names).toContain('monitor_start');
    expect(names).toContain('monitor_stop');
    expect(names).toContain('monitor_list');
    const start = tools.find((t) => t.name === 'monitor_start')!;
    const out = await start.handler({ name: 'm', kind: 'command', command: ['fake'] }, ctx) as { monitoring: boolean; id: string };
    expect(out.monitoring).toBe(true);
    const list = tools.find((t) => t.name === 'monitor_list')!;
    expect(((await list.handler({}, ctx)) as { monitors: unknown[] }).monitors).toHaveLength(1);
    const stop = tools.find((t) => t.name === 'monitor_stop')!;
    expect(await stop.handler({ id: out.id }, ctx)).toEqual({ stopped: true, id: out.id });
  });
});
