// SPDX-License-Identifier: Apache-2.0
// API-side runtime automations: items 2,3,4,5,6,12,13 + steer/context routes.
// Zero paid API — in-memory stores and mock functions only.
import { describe, expect, it } from 'vitest';
import express from 'express';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoutineStore } from '../src/bot-routines.js';
import { RoutineRunStore, RoutineRunExecutor } from '../src/routine-runs.js';
import { RoutineScheduler, validateRoutineSchedule, describeSchedule } from '../src/routine-schedules.js';
import { createTriggerTools } from '../src/trigger-tools.js';
import { FirstReplyRescue } from '../src/first-reply-rescue.js';
import { createSteerRouter } from '../src/steer-routes.js';
import { createContextBudgetRouter } from '../src/context-budget-routes.js';
import { createTriggersCalendarRouter } from '../src/triggers-calendar-routes.js';
import { createChatThreadsRouter, ThreadTitleStore } from '../src/chat-threads-routes.js';
import { MemoryBackupStore, adoptMemoryPack, doctorMemory, exportMemoryPack } from '../src/memory-pack.js';
import { DreamStore, NightlyDreamer, dreamBriefingItems, ensureDreamRoutine, generateDreamIdeas } from '../src/dreaming.js';
import { TieredMemoryStore } from '@mvp/agent-runtime';

async function withServer(router: express.Router, fn: (base: string) => Promise<void>): Promise<void> {
  const app = express(); app.use(express.json()); app.use(router);
  const srv = app.listen(0); const port = (srv.address() as { port: number }).port;
  try { await fn(`http://127.0.0.1:${port}`); } finally { srv.close(); }
}
const tmp = (): string => mkdtempSync(join(tmpdir(), 'api-auto-'));

describe('item4 routine depth', () => {
  it('startup schedule validates, describes, and the scheduler fires it once only when opted in', async () => {
    const sched = validateRoutineSchedule({ kind:'startup', timezone:'UTC', enabled:true, overlap:'skip', optIn:true });
    expect(sched.kind).toBe('startup'); expect(describeSchedule(sched)).toContain('startup');
    const dir = tmp(); const store = new RoutineStore(dir);
    const r = store.create({ name:'Boot job', botId:'b1', promptTemplate:'go', schedule: sched });
    const r2 = store.create({ name:'No opt-in', botId:'b1', promptTemplate:'go', schedule: validateRoutineSchedule({ kind:'startup', timezone:'UTC', enabled:true, overlap:'skip' }) });
    let fired = 0;
    const fakeRuntime = { runTurn: async () => ({ promptTokens:0, completionTokens:0, totalTokens:0 }) } as never;
    const scheduler = new RoutineScheduler({ routineStore: store, agentRuntime: fakeRuntime, getBots: () => [{ id:'b1' } as never], onFire: () => { fired++; } });
    await scheduler.tick(Date.now()); await scheduler.tick(Date.now());
    expect(fired).toBe(1); void r; void r2;
  });
  it('persists timeout / autoRetry / previous-summary settings on routines', () => {
    const store = new RoutineStore(tmp());
    const r = store.create({ name:'Cfg', botId:'b1', promptTemplate:'x', timeoutMs: 5000, autoRetry: false, usePreviousRunSummary: true });
    const got = store.get(r.id)!; expect(got.timeoutMs).toBe(5000); expect(got.autoRetry).toBe(false); expect(got.usePreviousRunSummary).toBe(true);
    const upd = store.update(r.id, { timeoutMs: null, autoRetry: true })!; expect(upd.timeoutMs).toBeUndefined(); expect(upd.autoRetry).toBe(true);
  });
  it('executor: failed run retries once and reports recovered; previous summary is injected', async () => {
    const dir = tmp(); const routines = new RoutineStore(dir); const runs = new RoutineRunStore(dir);
    const routine = routines.create({ name:'Flaky', botId:'b1', promptTemplate:'do work', schedule: validateRoutineSchedule({ kind:'interval', everyMinutes: 60, timezone:'UTC', enabled:true, overlap:'skip' }) });
    let calls = 0; const messages: string[] = [];
    const fakeRuntime = { runTurn: async (opts: { message: string; onEvent: (e: {type:string; content?: string}) => void }) => { calls++; messages.push(opts.message); if (calls === 1) throw new Error('boom once'); opts.onEvent({ type:'token', content:'recovered report summary' }); return { promptTokens:1, completionTokens:1, totalTokens:2 }; } } as never;
    const exec = new RoutineRunExecutor({ runStore: runs, agentRuntime: fakeRuntime, getBots: () => [{ id:'b1' } as never] });
    const settled = await exec.executeWait({ routine, trigger:'manual' });
    expect(settled.status).toBe('succeeded'); expect(settled.recovered).toBe(true); expect(settled.attempts).toBe(2);
    expect(runs.get(settled.runId)?.recovered).toBe(true);
    // Second run: previous summary injected (recurring default on)
    calls = 99; // next call succeeds immediately (calls!==1)
    const settled2 = await exec.executeWait({ routine, trigger:'manual' });
    expect(settled2.status).toBe('succeeded');
    expect(messages[messages.length-1]).toContain('recovered report summary');
  });
  it('executor: timeout aborts a hanging run and fails it after the retry', async () => {
    const dir = tmp(); const routines = new RoutineStore(dir); const runs = new RoutineRunStore(dir);
    const routine = routines.create({ name:'Slow', botId:'b1', promptTemplate:'x', timeoutMs: 60 });
    const fakeRuntime = { runTurn: async (opts: { signal?: AbortSignal }) => { await new Promise((_r, rej) => { opts.signal?.addEventListener('abort', () => rej(new Error('aborted'))); setTimeout(() => rej(new Error('late')), 5000).unref?.(); }); } } as never;
    const exec = new RoutineRunExecutor({ runStore: runs, agentRuntime: fakeRuntime, getBots: () => [{ id:'b1' } as never] });
    const settled = await exec.executeWait({ routine, trigger:'manual' });
    expect(settled.status).toBe('failed'); expect(settled.attempts).toBe(2); expect(settled.error).toContain('aborted');
  });
  it('triggers calendar router returns occurrences + runs in range', async () => {
    const dir = tmp(); const routines = new RoutineStore(dir); const runs = new RoutineRunStore(dir);
    routines.create({ name:'Daily', botId:'b1', promptTemplate:'x', schedule: validateRoutineSchedule({ kind:'daily', time:'09:00', weekdays:[0,1,2,3,4,5,6], timezone:'UTC', enabled:true, overlap:'skip' }) });
    await withServer(createTriggersCalendarRouter({ routineStore: routines, runStore: runs }), async (base) => {
      const from = Date.now(); const res = await fetch(`${base}/?from=${from}&to=${from + 3*24*3600_000}`); const body = await res.json() as { ok: boolean; routines: Array<{ occurrences: unknown[] }> };
      expect(body.ok).toBe(true); expect(body.routines[0]!.occurrences.length).toBeGreaterThanOrEqual(2);
    });
  });
});
describe('item3 trigger tools', () => {
  it('create/list/delete with a live-card widget result, scoped to the bot', async () => {
    const store = new RoutineStore(tmp());
    const tools = createTriggerTools(store);
    const ctx = { sessionId:'s', botId:'b1' };
    const create = tools.find(t=>t.name==='create_trigger')!;
    const out = await create.handler({ name:'Morning', prompt:'brief me', schedule:{ kind:'daily', time:'08:00', timezone:'UTC', enabled:true, overlap:'skip' } }, ctx) as { created: boolean; widget: { kind: string; title: string } };
    expect(out.created).toBe(true); expect(out.widget.kind).toBe('table'); expect(out.widget.title).toContain('Morning');
    const list = await tools.find(t=>t.name==='list_triggers')!.handler({}, ctx) as { triggers: unknown[] };
    expect(list.triggers).toHaveLength(1);
    const other = await tools.find(t=>t.name==='list_triggers')!.handler({}, { sessionId:'s', botId:'other' }) as { triggers: unknown[] };
    expect(other.triggers).toHaveLength(0);
    const del = await tools.find(t=>t.name==='delete_trigger')!.handler({ idOrName:'Morning' }, ctx) as { deleted: boolean };
    expect(del.deleted).toBe(true);
  });
});
describe('item2 first-reply rescue', () => {
  it('retries once with a nudge and succeeds', async () => {
    const nudges: string[] = [];
    const rescue = new FirstReplyRescue({ retryTurn: async ({ nudgePrompt }) => { nudges.push(nudgePrompt); return true; }, appendSystemMessage: async () => {}, addNeedsYou: async () => {} });
    const out = await rescue.runFirstTurn({ threadId:'t1', firstTurn: async () => false });
    expect(out).toMatchObject({ replied:true, rescued:true, rescueSucceeded:true }); expect(nudges).toHaveLength(1);
  });
  it('on retry failure posts a system message + needs-you, and never loops', async () => {
    let sys = 0; let needs = 0; let retries = 0;
    const rescue = new FirstReplyRescue({ retryTurn: async () => { retries++; return false; }, appendSystemMessage: async () => { sys++; }, addNeedsYou: async () => { needs++; } });
    const a = await rescue.runFirstTurn({ threadId:'t2', firstTurn: async () => { throw new Error('silent'); } });
    expect(a.rescued).toBe(true); expect(sys).toBe(1); expect(needs).toBe(1);
    const b = await rescue.runFirstTurn({ threadId:'t2', firstTurn: async () => false });
    expect(b.rescued).toBe(false); expect(retries).toBe(1);
  });
  it('timeout counts as no reply', async () => {
    const rescue = new FirstReplyRescue({ timeoutMs: 20, retryTurn: async () => true, appendSystemMessage: async () => {}, addNeedsYou: async () => {} });
    const out = await rescue.runFirstTurn({ threadId:'t3', firstTurn: async () => { await new Promise(r=>setTimeout(r,200)); return true; } });
    expect(out.rescued).toBe(true);
  });
});
describe('item1+5 steer & context-budget routes', () => {
  it('steer route enqueues and reports delivery mode', async () => {
    const seen: Array<[string,string]> = [];
    await withServer(createSteerRouter({ enqueueSteer: (id, text) => { seen.push([id,text]); return { id:'st1', running:false, pending:1 }; } }), async (base) => {
      const res = await fetch(`${base}/sessions/sess1/steer`, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ text:'wait, also check X' }) });
      const body = await res.json() as { ok:boolean; delivery:string };
      expect(res.status).toBe(202); expect(body.delivery).toBe('queued-for-next-turn'); expect(seen).toEqual([['sess1','wait, also check X']]);
    });
  });
  it('context-budget route returns budget state', async () => {
    await withServer(createContextBudgetRouter({ getContextBudget: (id) => ({ sessionId:id, estimatedTokens: 900, budget: 1000, ratio: 0.9, level:'warn', messageCount: 3 }) as never }), async (base) => {
      const res = await fetch(`${base}/sessions/abc/context-budget`); const body = await res.json() as { level:string };
      expect(body.level).toBe('warn');
    });
  });
});
describe('item6 thread mode routes', () => {
  it('get/set conversation mode per thread, default craft', async () => {
    const dir = tmp(); const titles = new ThreadTitleStore(dir);
    const router = createChatThreadsRouter({ dataDir: dir, titles, listThreads: () => [], branchSession: async () => ({ ok:false, reason:'thread-not-found' }) as never, listThreadMessages: () => [], duplicateThread: () => undefined, deleteThread: () => false, audit: () => {} });
    await withServer(router, async (base) => {
      let body = await (await fetch(`${base}/thr1/mode`)).json() as { mode:string }; expect(body.mode).toBe('craft');
      const put = await fetch(`${base}/thr1/mode`, { method:'PUT', headers:{'content-type':'application/json'}, body: JSON.stringify({ mode:'plan' }) }); expect(put.status).toBe(200);
      body = await (await fetch(`${base}/thr1/mode`)).json() as { mode:string }; expect(body.mode).toBe('plan');
      const bad = await fetch(`${base}/thr1/mode`, { method:'PUT', headers:{'content-type':'application/json'}, body: JSON.stringify({ mode:'wild' }) }); expect(bad.status).toBe(400);
    });
    titles.close();
  });
});
describe('item12 memory portability', () => {
  function memStore(): TieredMemoryStore { return new TieredMemoryStore(tmp()); }
  it('export → adopt into another bot, conflicts reported, overwrite decision applies', () => {
    const store = memStore();
    store.storeAtom('src', { fact:'User likes tea', entities:['tea'], confidence:0.9 }, 'turn1');
    store.storeAtom('src', { fact:'User lives in Pune', entities:['Pune'], confidence:0.9 }, 'turn1');
    const pack = exportMemoryPack(store, 'src'); expect(pack.atoms).toHaveLength(2);
    store.storeAtom('dst', { fact:'User likes tea', entities:['tea'], confidence:0.8 }, 'turn9');
    const adopt = adoptMemoryPack(store, 'dst', pack);
    expect(adopt.conflicts).toHaveLength(1); expect(adopt.applied).toHaveLength(1);
    const adopt2 = adoptMemoryPack(store, 'dst', pack, { 'User likes tea': 'overwrite' });
    expect(adopt2.overwritten).toHaveLength(1);
  });
  it('doctor reports counts and broken refs; backup/restore round-trips', () => {
    const store = memStore();
    store.storeAtom('b', { fact:'Fact one about cats', entities:['cats'], confidence:1 }, 't');
    const report = doctorMemory(store, 'b'); expect(report.atomCount).toBe(1); expect(report.brokenRefs).toEqual([]);
    const backups = new MemoryBackupStore(tmp());
    const { id } = backups.create(store, 'b'); expect(backups.list('b')).toContain(id);
    store.storeAtom('b', { fact:'Extra fact about dogs', entities:['dogs'], confidence:1 }, 't');
    expect(store.getAtoms('b', 10)).toHaveLength(2);
    backups.restore(store, 'b', id);
    expect(store.getAtoms('b', 10)).toHaveLength(1);
  });
});
describe('item13 nightly dreaming', () => {
  it('generates ideas from episodes with a mock model, stores them for the briefing, and registers a routine', async () => {
    const dir = tmp(); const store = new DreamStore(dir);
    const dreamer = new NightlyDreamer({ store, episodesForBot: async () => ['User shipped the Pune release', 'User asked about invoice totals'], model: async (prompt) => { expect(prompt).toContain('Pune'); return 'Follow up the release — share the notes\nCheck invoices — totals were requested'; } });
    const ideas = await dreamer.runForBot('b1'); expect(ideas).toHaveLength(2);
    const items = dreamBriefingItems(store, 'b1'); expect(items[0]!.kind).toBe('dream');
    expect(await generateDreamIdeas({ botId:'b', episodes: [], model: async () => 'x' })).toEqual([]);
    const routines = new RoutineStore(dir);
    expect(ensureDreamRoutine(routines, 'b1')).toBe(true); expect(ensureDreamRoutine(routines, 'b1')).toBe(false);
    expect(routines.list()[0]!.schedule?.kind).toBe('daily');
  });
});
