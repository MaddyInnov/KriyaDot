// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModuleDb } from '../db.js';
import { PermissionError, ValidationError } from '../errors.js';
import { IdeaStore, USER_DISMISSAL, DEFAULT_IDEA_EXPIRY } from './index.js';
import { DailyIdeaCurator, rankCandidates, scoreCandidate } from './curation.js';
import { IdeaRunTracker } from './runs.js';
import { ideaTools } from './tools.js';

const DAY = 24 * 60 * 60 * 1000;

describe('I-4: user-only dismissal', () => {
  let store: IdeaStore;
  beforeEach(() => {
    store = new IdeaStore(new ModuleDb(':memory:'));
  });

  it('refuses agent and system actors at the store layer', () => {
    const idea = store.create({ title: 'x' });
    expect(() => store.dismiss(idea.id, { kind: 'agent', botId: 'b1' })).toThrow(PermissionError);
    expect(() => store.dismiss(idea.id, { kind: 'system' })).toThrow(PermissionError);
    expect(() => store.dismiss(idea.id, undefined as never)).toThrow(PermissionError);
    expect(store.get(idea.id).status).toBe('new'); // untouched
  });

  it('allows the user actor', () => {
    const idea = store.create({ title: 'x' });
    expect(store.dismiss(idea.id, USER_DISMISSAL).status).toBe('dismissed');
  });

  it('the agent tool surface has no dismiss action', async () => {
    const tools = ideaTools(mkdtempSync(join(tmpdir(), 'idea-tools-')));
    expect(tools).toHaveLength(1);
    const tool = tools[0]!;
    expect(tool.name).toBe('manage_ideas');
    const actions = (tool.parameters.properties as { action: { enum: string[] } }).action.enum;
    expect(actions).not.toContain('dismiss');
    await expect(tool.handler({ action: 'dismiss', ideaId: 'x' }, {} as never)).rejects.toThrow(/unknown manage_ideas action/);
  });
});

describe('I-5: expiry / early retirement', () => {
  let db: ModuleDb;
  let store: IdeaStore;
  beforeEach(() => {
    db = new ModuleDb(':memory:');
    store = new IdeaStore(db);
  });

  it('expires ideas past their explicit expiresAt', () => {
    const idea = store.create({ title: 'stale', expiresAt: 1_000 });
    const retired = store.expireStale(2_000);
    expect(retired.map((i) => i.id)).toEqual([idea.id]);
    expect(store.get(idea.id).status).toBe('expired');
    expect(store.get(idea.id).retireReason).toBe('ttl');
  });

  it('expires unscored ideas past the default TTL but not fresh ones', () => {
    const old = store.create({ title: 'old' });
    db.db.prepare('UPDATE mm_ideas SET created_at = ? WHERE id = ?').run(Date.now() - DEFAULT_IDEA_EXPIRY.ttlMs - 1, old.id);
    const fresh = store.create({ title: 'fresh' });
    const retired = store.expireStale(Date.now());
    expect(retired.map((i) => i.id)).toEqual([old.id]);
    expect(store.get(fresh.id).status).toBe('new');
  });

  it('early-retires low-rank curated ideas after the grace period only', () => {
    const low = store.create({
      title: 'weak',
      source: 'curation',
      scores: { feasibility: 0.2, fit: 0.1, novelty: 0.9, rank: 0.2 },
      expiresAt: Date.now() + 30 * DAY,
    });
    // Inside grace: survives.
    expect(store.expireStale(Date.now() + DAY)).toHaveLength(0);
    // Past grace: retired as low-rank.
    const retired = store.expireStale(Date.now() + 4 * DAY);
    expect(retired.map((i) => i.id)).toEqual([low.id]);
    expect(store.get(low.id).retireReason).toBe('low-rank');
  });

  it('never expires active or done ideas', () => {
    const a = store.create({ title: 'a', expiresAt: 1 });
    store.run(a.id);
    const b = store.create({ title: 'b', expiresAt: 1 });
    store.run(b.id);
    store.complete(b.id);
    expect(store.expireStale(Date.now())).toHaveLength(0);
  });
});

describe('I-6: curation ranking', () => {
  const ctx = {
    goals: ['Grow the KriyaDot SaaS to first paying customers', 'Learn Telugu conversation'],
    memorySnippets: ['User asked about invoice automation for clinics', 'User practices Telugu on weekends'],
  };

  it('scores goal-fitting candidates above unrelated ones', () => {
    const fit = scoreCandidate({ title: 'Build invoice automation for clinics', description: 'Automate clinic invoices' }, ctx, []);
    const off = scoreCandidate({ title: 'Collect vintage stamps', description: 'A hobby catalogue of rare stamps' }, ctx, []);
    expect(fit.scores.fit).toBeGreaterThan(off.scores.fit);
    expect(fit.scores.rank).toBeGreaterThan(off.scores.rank);
    expect(fit.evidence.length).toBeGreaterThan(0);
  });

  it('penalises novelty for near-duplicates of existing ideas', () => {
    const existing = [{ title: 'Invoice automation for clinics', description: 'Automate clinic invoices' }];
    const dupe = scoreCandidate({ title: 'Invoice automation for clinics', description: 'Automate clinic invoices' }, ctx, existing);
    expect(dupe.scores.novelty).toBeLessThan(0.2);
  });

  it('curator files top candidates with provenance and skips duplicates', () => {
    const store = new IdeaStore(new ModuleDb(':memory:'));
    store.create({ title: 'Invoice automation for clinics', description: 'Automate clinic invoices' });
    const curator = new DailyIdeaCurator(store, { now: 1_000_000 });
    const result = curator.curate(
      [
        { title: 'Invoice automation for clinics', description: 'Automate clinic invoices', origin: 'dream' },
        { title: 'Telugu conversation practice plan', description: 'Daily speaking drills to practice Telugu conversation on weekends', origin: 'dream' },
        { title: 'KriyaDot onboarding checklist', description: 'Create a checklist to get KriyaDot SaaS users to first paying customers', origin: 'dream' },
      ],
      ctx,
    );
    expect(result.skipped.some((s) => s.reason === 'duplicate')).toBe(true);
    expect(result.created.length).toBeGreaterThanOrEqual(1);
    for (const idea of result.created) {
      expect(idea.source).toBe('curation');
      expect(idea.scores?.rank).toBeGreaterThan(0);
      expect(idea.rationale).toContain('rank');
      expect(idea.expiresAt).toBe(1_000_000 + 14 * DAY);
    }
    // Ranked listing puts scored ideas in rank order.
    const ranked = store.listRanked('new').filter((i) => i.source === 'curation');
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1]!.scores!.rank).toBeGreaterThanOrEqual(ranked[i]!.scores!.rank);
    }
  });

  it('rankCandidates is deterministic and sorted', () => {
    const cands = [
      { title: 'Telugu conversation practice plan', description: 'Daily speaking drills' },
      { title: 'Stamp collecting catalogue', description: 'Rare stamps' },
    ];
    const a = rankCandidates(cands, ctx, []);
    const b = rankCandidates(cands, ctx, []);
    expect(a.map((s) => s.candidate.title)).toEqual(b.map((s) => s.candidate.title));
    expect(a[0]!.scores.rank).toBeGreaterThanOrEqual(a[1]!.scores.rank);
  });
});

describe('I-3: idea run binding with live progress', () => {
  let db: ModuleDb;
  let store: IdeaStore;
  let tracker: IdeaRunTracker;
  beforeEach(() => {
    db = new ModuleDb(':memory:');
    store = new IdeaStore(db);
    tracker = new IdeaRunTracker(db);
  });

  it('start binds the run, progress streams to subscribers, complete finishes the idea', () => {
    const idea = store.create({ title: 'build it' });
    const seen: string[] = [];
    const unsub = tracker.subscribe((e) => seen.push(`${e.kind}:${e.pct ?? ''}`));
    const { runId } = tracker.start(idea.id);
    expect(store.get(idea.id).status).toBe('active');
    expect(store.get(idea.id).runId).toBe(runId);
    tracker.progress(runId, 40, 'halfway');
    const state = tracker.state(idea.id);
    expect(state.run?.status).toBe('running');
    expect(state.run?.pct).toBe(40);
    expect(state.run?.lastNote).toBe('halfway');
    tracker.complete(runId);
    expect(store.get(idea.id).status).toBe('done');
    expect(store.get(idea.id).runId).toBeNull();
    expect(tracker.state(idea.id).run?.status).toBe('completed');
    expect(seen).toEqual(['started:0', 'progress:40', 'completed:100']);
    unsub();
  });

  it('failure returns the idea to new and unbinds', () => {
    const idea = store.create({ title: 'risky' });
    const { runId } = tracker.start(idea.id);
    tracker.fail(runId, 'boom');
    expect(store.get(idea.id).status).toBe('new');
    expect(store.get(idea.id).runId).toBeNull();
    expect(tracker.state(idea.id).run?.status).toBe('failed');
  });

  it('rejects a second concurrent run and progress on an unbound run', () => {
    const idea = store.create({ title: 'x' });
    const { runId } = tracker.start(idea.id);
    expect(() => tracker.start(idea.id)).toThrow(ValidationError);
    tracker.complete(runId);
    expect(() => tracker.progress(runId, 10)).toThrow(ValidationError);
  });

  it('agent tool can drive a full run through manage_ideas', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'idea-tools-run-'));
    const fileStore = new IdeaStore(new ModuleDb(join(dir, 'muse-modules.db')));
    const tools = ideaTools(dir);
    const tool = tools[0]!;
    const created = (await tool.handler({ action: 'create', title: 'via tool' }, {} as never)) as { id: string };
    const started = (await tool.handler({ action: 'run', ideaId: created.id }, {} as never)) as { runId: string };
    await tool.handler({ action: 'progress', runId: started.runId, pct: 50, note: 'working' }, {} as never);
    await tool.handler({ action: 'complete_run', runId: started.runId }, {} as never);
    expect(fileStore.get(created.id).status).toBe('done');
  });
});
