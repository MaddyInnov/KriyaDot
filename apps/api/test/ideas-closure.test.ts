// SPDX-License-Identifier: Apache-2.0
// Wave-5 closure tests: SI-2 reflective dreaming, SI-1 goal study,
// SI-3 skill audit, SI-4 quiet sweep, SI-5 why-lookup, I-3/I-6 routes.
// Zero paid API — all model/research legs are injected mocks.
import { describe, expect, it } from 'vitest';
import express from 'express';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModuleDb, GoalStore, IdeaStore } from '@mvp/muse-modules';
import { InvocationDecisionLog, saveRoutingRules, loadRoutingRules, proposeCandidate, verifyCandidate, type LearnedRoutingRule } from '@mvp/agent-runtime';
import { ReflectionStore, ReflectiveDreamer, generateReflection, reflectionBriefingItems, ensureReflectionRoutine } from '../src/reflective-dreaming.js';
import { DailyGoalStudyLoop, GoalStudyStore, ensureGoalStudyRoutine, SkillAuditLoop, auditRoutingRules, auditEvolutionCandidates, readSkillAuditHistory, ensureSkillAuditRoutine, QuietMomentSweep } from '../src/idea-loops.js';
import { createWhyRouter, explainSubject } from '../src/why-routes.js';
import { createIdeasExtRouter, runDreamCuration } from '../src/ideas-ext-routes.js';
import { RoutineStore } from '../src/bot-routines.js';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'ideas-closure-'));

async function withServer(router: express.Router, fn: (base: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(router);
  const srv = app.listen(0);
  const port = (srv.address() as { port: number }).port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    srv.close();
  }
}

describe('SI-2 reflective dreaming', () => {
  it('parses WORKED/RUPTURED/BECOMING/REPAIR sections and opens repair threads', async () => {
    const model = async () =>
      [
        'WORKED:',
        '- Shipped the invoice exporter',
        'RUPTURED:',
        '- Demo call dropped twice — flaky TURN server',
        'BECOMING:',
        '- Moving from prototypes to paid pilots',
        'REPAIR:',
        '- Fix TURN server config — check coturn logs before next demo',
      ].join('\n');
    const generated = await generateReflection({ botId: 'b1', episodes: ['worked on exporter', 'demo call dropped'], model, now: 5000 });
    expect(generated).not.toBeNull();
    expect(generated!.reflection.worked).toEqual(['Shipped the invoice exporter']);
    expect(generated!.reflection.ruptured[0]).toContain('TURN');
    expect(generated!.reflection.becoming).toHaveLength(1);
    expect(generated!.repairs).toHaveLength(1);
    expect(generated!.repairs[0]!.status).toBe('open');
  });

  it('returns null with no episodes and stores + addresses repair threads via the dreamer', async () => {
    const store = new ReflectionStore(tmp());
    const dreamer = new ReflectiveDreamer({
      store,
      episodesForBot: async () => ['a day'],
      model: async () => 'WORKED:\n- x\nREPAIR:\n- Follow up with clinic — send the pilot summary',
    });
    const out = await dreamer.runForBot('b1');
    expect(out?.repairs).toHaveLength(1);
    const empty = new ReflectiveDreamer({ store, episodesForBot: async () => [], model: async () => 'WORKED:\n- x' });
    expect(await empty.runForBot('b1')).toBeNull();
    const open = store.listRepairThreads('open');
    expect(open).toHaveLength(1);
    const items = reflectionBriefingItems(store);
    expect(items.some((i) => i.kind === 'repair')).toBe(true);
    const addressed = store.addressRepairThread(open[0]!.id);
    expect(addressed?.status).toBe('addressed');
    expect(store.listRepairThreads('open')).toHaveLength(0);
  });

  it('registers the reflection routine idempotently', () => {
    const routines = new RoutineStore(tmp());
    expect(ensureReflectionRoutine(routines, 'b1')).toBe(true);
    expect(ensureReflectionRoutine(routines, 'b1')).toBe(false);
  });
});

describe('SI-1 daily goal study loop', () => {
  it('briefs each goal, nudges stalled ones, suggests implied goals, and acceptance creates a goal', async () => {
    const mdb = new ModuleDb(':memory:');
    const goals = new GoalStore(mdb);
    const active = goals.create({ title: 'Reach 10 paying customers', description: 'SaaS sales' });
    goals.create({ title: 'Unrelated existing goal about marathons', description: 'running' });
    // Backdate the active goal's history so it counts as stalled.
    mdb.db.prepare('UPDATE mm_goal_progress SET created_at = ? WHERE goal_id = ?').run(Date.now() - 10 * 86_400_000, active.id);
    const store = new GoalStudyStore(tmp());
    const loop = new DailyGoalStudyLoop({
      mdb,
      store,
      research: async (g) => `research note for ${g.title}`,
      signals: async () => ['Practising Telugu conversation every weekend with a tutor', 'Reach 10 paying customers for the SaaS'],
    });
    const report = await loop.run();
    const briefing = report.briefings.find((b) => b.goalId === active.id)!;
    expect(briefing.research).toContain('research note');
    expect(briefing.stalled).toBe(true);
    expect(briefing.nudge).toContain('no recorded progress');
    // The Telugu signal implies a goal; the sales signal is already a goal.
    expect(report.newSuggestions).toHaveLength(1);
    expect(report.newSuggestions[0]!.title).toContain('Telugu');
    const accepted = store.acceptSuggestion(report.newSuggestions[0]!.id, goals);
    expect(accepted?.status).toBe('accepted');
    expect(goals.get(accepted!.goalId!).title).toContain('Telugu');
    // Second run suggests nothing new (already suggested).
    const again = await loop.run();
    expect(again.newSuggestions).toHaveLength(0);
  });

  it('skips entirely while the global pause is on, and registers its routine', async () => {
    const loop = new DailyGoalStudyLoop({
      mdb: new ModuleDb(':memory:'),
      store: new GoalStudyStore(tmp()),
      research: async () => 'x',
      signals: async () => [],
      isPaused: () => true,
    });
    expect((await loop.run()).skipped).toBe('paused');
    const routines = new RoutineStore(tmp());
    expect(ensureGoalStudyRoutine(routines, 'b1')).toBe(true);
    expect(ensureGoalStudyRoutine(routines, 'b1')).toBe(false);
    expect(DailyGoalStudyLoop.ROUTINE_NAME).toBe('Daily goal study');
  });
});

describe('SI-3 skill audit cadence + retire-on-evidence', () => {
  const rule = (id: string, shadow?: LearnedRoutingRule['shadow']): LearnedRoutingRule => ({
    id,
    description: `rule ${id}`,
    when: {},
    then: { providerId: 'groq', modelId: 'm' },
    count: 1,
    updatedAt: '2026-10-01T00:00:00.000Z',
    status: 'shadow',
    shadow,
  });
  const NOW = '2026-10-30T00:00:00.000Z';

  it('retires losers and stale shadows, promotes winners, keeps the undecided', () => {
    const rules = [
      rule('loser', { trials: 5, agreements: 1, disagreements: 4, since: '2026-10-20T00:00:00.000Z' }),
      rule('stale', { trials: 1, agreements: 1, disagreements: 0, since: '2026-10-01T00:00:00.000Z' }),
      rule('winner', { trials: 4, agreements: 4, disagreements: 0, since: '2026-10-28T00:00:00.000Z' }),
      rule('young', { trials: 1, agreements: 0, disagreements: 1, since: '2026-10-29T00:00:00.000Z' }),
    ];
    const { rules: out, decisions } = auditRoutingRules(rules, {}, NOW);
    const byId = new Map(out.map((r) => [r.id, r]));
    expect(byId.get('loser')!.status).toBe('retired');
    expect(byId.get('stale')!.status).toBe('retired');
    expect(byId.get('winner')!.status).toBe('active');
    expect(byId.get('young')!.status).toBe('shadow');
    expect(decisions.find((d) => d.subject === 'loser')!.action).toBe('retired-loser');
    expect(decisions.find((d) => d.subject === 'winner')!.action).toBe('promoted');
  });

  it('loop persists audited rules + report, and respects the pause', () => {
    const dir = tmp();
    saveRoutingRules(dir, [rule('loser', { trials: 6, agreements: 0, disagreements: 6, since: '2026-10-20T00:00:00.000Z' })]);
    const loop = new SkillAuditLoop({ dataDir: dir, now: () => NOW });
    const report = loop.run();
    expect(report.decisions[0]!.action).toBe('retired-loser');
    expect(loadRoutingRules(dir)[0]!.status).toBe('retired');
    expect(readSkillAuditHistory(dir)).toHaveLength(1);
    const paused = new SkillAuditLoop({ dataDir: dir, isPaused: () => true, now: () => NOW });
    expect(paused.run().skipped).toBe('paused');
    expect(readSkillAuditHistory(dir)).toHaveLength(1); // nothing new recorded
    const routines = new RoutineStore(tmp());
    expect(ensureSkillAuditRoutine(routines, 'b1')).toBe(true);
    expect(ensureSkillAuditRoutine(routines, 'b1')).toBe(false);
  });

  it('audits generic evolution candidates with the same evidence rules', async () => {
    const loser = await verifyCandidate(
      proposeCandidate({ kind: 'lesson', description: 'bad lesson', payload: {}, at: '2026-10-01T00:00:00.000Z' }),
      () => true,
      { now: '2026-10-01T00:00:00.000Z', windowMs: 90 * 86_400_000 },
    );
    const trialed = { ...loser, trials: 5, agreements: 1, disagreements: 4 };
    const { candidates, decisions } = auditEvolutionCandidates([trialed], {}, NOW);
    expect(candidates[0]!.status).toBe('retired');
    expect(decisions[0]!.action).toBe('retired-loser');
  });
});

describe('SI-4 quiet-moment internalisation sweep', () => {
  it('fires once per quiet period, bounded, and never while paused', async () => {
    let calls = 0;
    const sweep = new QuietMomentSweep({
      idleMs: 1000,
      maxPerSweep: 5,
      internalise: async (limit) => {
        calls += 1;
        return limit + 10; // over-report: the sweep must clamp to the bound
      },
    });
    expect(await sweep.tick(10_000)).toBeNull(); // no activity yet
    sweep.noteActivity(1_000);
    expect(await sweep.tick(1_500)).toBeNull(); // not idle long enough
    const record = await sweep.tick(2_500);
    expect(record?.processed).toBe(5); // clamped to maxPerSweep
    expect(await sweep.tick(9_000)).toBeNull(); // same quiet period: no re-fire
    sweep.noteActivity(10_000); // new activity → new quiet period
    expect(await sweep.tick(11_500)).not.toBeNull();
    expect(calls).toBe(2);
    const paused = new QuietMomentSweep({ idleMs: 1, internalise: async () => 1, isPaused: () => true });
    paused.noteActivity(0);
    expect(await paused.tick(100)).toBeNull();
  });
});

describe('SI-5 why lookup + I-3/I-6 ext routes', () => {
  it('explains an idea from its curation provenance and a decision from the log', async () => {
    const dir = tmp();
    const mdb = new ModuleDb(':memory:');
    const ideas = new IdeaStore(mdb);
    const idea = ideas.create({
      title: 'Telugu practice plan',
      source: 'curation',
      scores: { feasibility: 0.8, fit: 0.7, novelty: 0.9, rank: 0.76 },
      rationale: 'rank 0.76 = fit 0.70 …',
      evidence: ['goal: Learn Telugu conversation'],
    });
    const log = new InvocationDecisionLog(dir);
    const entry = log.record({ kind: 'routing', subject: 'scout-bot', outcome: 'routed', confidence: 0.9, rationale: 'strong keyword score for research bot' });
    const byId = await explainSubject({ dataDir: dir, mdb }, idea.id);
    expect(byId.found).toBe(true);
    expect(byId.explanations[0]!.source).toBe('idea');
    expect(byId.explanations[0]!.summary).toContain('Evidence: goal: Learn Telugu');
    const byDecision = await explainSubject({ dataDir: dir, mdb }, entry.id);
    expect(byDecision.explanations.some((e) => e.source === 'decision' && e.summary.includes('keyword score'))).toBe(true);
    const missing = await explainSubject({ dataDir: dir, mdb }, 'nothing-matches-this');
    expect(missing.found).toBe(false);
  });

  it('serves /why over HTTP and binds card state to runs over HTTP', async () => {
    const dir = tmp();
    const mdb = new ModuleDb(':memory:');
    const goals = new GoalStore(mdb);
    goals.create({ title: 'Learn Telugu conversation', description: 'speaking practice' });
    const router = createIdeasExtRouter({
      mdb,
      dreamCandidates: () => [{ id: 'd1', botId: 'b1', title: 'Telugu conversation drills', detail: 'Daily speaking practice for Telugu conversation', createdAt: 1 }],
      memoryContext: () => ['User practises Telugu conversation on weekends'],
    });
    const why = createWhyRouter({ dataDir: dir, mdb });
    const app = express();
    app.use(express.json());
    app.use(router);
    app.use(why);
    const srv = app.listen(0);
    const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    try {
      // I-6: curation files the dream candidate into the Ideas tab.
      const curateRes = await fetch(`${base}/ideas/curate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const curated = (await curateRes.json()) as { created: Array<{ id: string; source: string }> };
      expect(curated.created).toHaveLength(1);
      expect(curated.created[0]!.source).toBe('curation');
      const ideaId = curated.created[0]!.id;
      // SI-5 over HTTP.
      const whyRes = await fetch(`${base}/why?subject=${ideaId}`);
      const whyBody = (await whyRes.json()) as { found: boolean; explanations: Array<{ source: string }> };
      expect(whyBody.found).toBe(true);
      expect(whyBody.explanations[0]!.source).toBe('idea');
      const badWhy = await fetch(`${base}/why`);
      expect(badWhy.status).toBe(400);
      // I-3: run lifecycle over HTTP.
      const startRes = await fetch(`${base}/ideas/${ideaId}/run-start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const started = (await startRes.json()) as { runId: string };
      expect(started.runId).toContain('run_');
      await fetch(`${base}/ideas/runs/${started.runId}/progress`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pct: 30, note: 'drafting' }),
      });
      const stateRes = await fetch(`${base}/ideas/${ideaId}/run-state`);
      const state = (await stateRes.json()) as { run: { status: string; pct: number; lastNote: string } };
      expect(state.run.status).toBe('running');
      expect(state.run.pct).toBe(30);
      expect(state.run.lastNote).toBe('drafting');
      await fetch(`${base}/ideas/runs/${started.runId}/complete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const doneRes = await fetch(`${base}/ideas/${ideaId}/run-state`);
      const done = (await doneRes.json()) as { idea: { status: string }; run: { status: string } };
      expect(done.idea.status).toBe('done');
      expect(done.run.status).toBe('completed');
    } finally {
      srv.close();
    }
  });

  it('runDreamCuration respects the ranked output and expire-sweep retires stale ideas', async () => {
    const mdb = new ModuleDb(':memory:');
    const goals = new GoalStore(mdb);
    goals.create({ title: 'Ship the clinic invoicing pilot', description: 'invoices for clinics' });
    const result = runDreamCuration({
      mdb,
      dreamCandidates: () => [{ id: 'd9', botId: 'b1', title: 'Clinic invoice automation pilot', detail: 'Automate invoices for the clinic pilot', createdAt: 2 }],
    });
    expect(result.created).toHaveLength(1);
    const router = createIdeasExtRouter({ mdb });
    await withServer(router, async (base) => {
      const ranked = (await (await fetch(`${base}/ideas/ranked`)).json()) as { ideas: Array<{ id: string }> };
      expect(ranked.ideas.map((i) => i.id)).toContain(result.created[0]!.id);
      mdb.db.prepare('UPDATE mm_ideas SET expires_at = 1 WHERE id = ?').run(result.created[0]!.id);
      const sweep = (await (await fetch(`${base}/ideas/expire-sweep`, { method: 'POST' })).json()) as { expired: Array<{ id: string }> };
      expect(sweep.expired.map((i) => i.id)).toEqual([result.created[0]!.id]);
    });
  });
});
