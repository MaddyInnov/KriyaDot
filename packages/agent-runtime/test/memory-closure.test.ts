// SPDX-License-Identifier: Apache-2.0
// Octomind Layer-F closure tests:
// - #75 grounded distillation (verbatim-quote rules + citation-backed
//   experiences, fail-closed) through the distiller entry points
// - #74 project scoping + role-filtered retrieval
// - #76 orientation store distinct from experience atoms (+ about-me shim)
// - #77 runDistillPipeline extraction-on-demand
// - #78 per-turn Memory Pack + material-use credit
// - #79 session:// evidence links + one-hop expansion
// - #80 watermark budgets, verifier forwarding, archive-after-replace
// - #81 cold tier: demote → cold search → material use promotes
// - #82 generic shadow-trial evolution (verifier stage, bounded trial)
// - #84 multi-pass synthesis → evolution candidates
// - #85 standing global rules + scoped memory rules

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  TieredMemoryStore,
  parseSessionEvidenceLink,
  sessionEvidenceLink,
} from '../src/memory.js';
import type { SyncEmbedder } from '../src/hybrid-search.js';
import {
  MemoryJournal,
  applySynthesisProposal,
  enforceWatermarkBudgets,
  orientationAboutMe,
  proposeScopedMemoryRules,
  proposeStandingGlobalRules,
  runSynthesisPass,
  runUpkeepPass,
  synthesisProposalToCandidate,
  syncAboutMeToOrientation,
  tidyMemory,
  writeAboutMe,
} from '../src/memory-upkeep.js';
import {
  proposeCandidate,
  promoteEvolutionCandidate,
  recordEvolutionTrial,
  verifyCandidate,
  evolutionEligible,
} from '../src/routing-learn.js';

let dir: string;
let store: TieredMemoryStore;
let journal: MemoryJournal;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mvp-closure-'));
  store = new TieredMemoryStore(dir);
  journal = new MemoryJournal(dir);
});

afterEach(() => {
  journal.close();
  rmSync(dir, { recursive: true, force: true });
});

const BOT = 'bot-closure';

describe('#75 grounded distillation', () => {
  it('routes user rules/preferences through verbatim-quote grounding', () => {
    const userText = 'I prefer dark mode for all my editors. The weather is nice today.';
    const res = store.storeDistilledFacts(
      BOT,
      [
        { fact: 'The user prefers dark mode for all editors.', entities: [], confidence: 0.9, category: 'preference' },
        { fact: 'The user prefers tea in the morning.', entities: [], confidence: 0.9, category: 'preference' },
      ],
      { sessionId: 'sess-1', userText, userEventId: 'evt-1' },
    );
    expect(res.stored).toBe(1);
    expect(res.rejected).toBe(1);
    const atom = store.getAtom(BOT, res.atomIds[0]!);
    expect(atom?.grounding).toBe('verbatim-quote');
    expect(atom?.quote).toContain('dark mode');
    expect(atom?.evidenceLinks).toContain('session://sess-1#evt-1');
    // The ungrounded candidate was counted AND journaled.
    expect(store.droppedUngroundedQuotes).toBeGreaterThanOrEqual(1);
    expect(store.listGroundingRejections(BOT).length).toBeGreaterThanOrEqual(1);
    expect(store.getAtoms(BOT, 50).some((a) => a.fact.includes('tea'))).toBe(false);
  });

  it('verifier-claimed quotes are checked literally against the source', () => {
    const userText = 'We deploy on Fridays, never on Mondays, that is the rule.';
    const res = store.storeDistilledFacts(
      BOT,
      [
        {
          fact: 'Always deploy on Fridays.',
          entities: [],
          confidence: 0.9,
          quote: 'We deploy on Fridays, never on Mondays',
        },
        {
          fact: 'Always deploy on Sundays.',
          entities: [],
          confidence: 0.9,
          quote: 'We deploy on Sundays, always',
        },
      ],
      { sessionId: 'sess-2', userText, userEventId: 'evt-2' },
    );
    expect(res.stored).toBe(1);
    expect(res.rejected).toBe(1);
    const atom = store.getAtom(BOT, res.atomIds[0]!);
    expect(atom?.grounding).toBe('verbatim-quote');
    expect(atom?.quote).toBe('We deploy on Fridays, never on Mondays');
  });

  it('experience atoms require a session citation', () => {
    const lesson = {
      fact: 'Always run the full test suite before merging.',
      entities: [],
      confidence: 0.9,
      category: 'lesson' as const,
    };
    // No message citation → rejected fail-closed. (The fact also reads
    // as a rule, so ground it in the user text to isolate the citation
    // requirement: use a pure procedure instead.)
    const proc = {
      fact: 'Deploy procedure: build, smoke test, then publish the release.',
      entities: [],
      confidence: 0.9,
      category: 'procedure' as const,
    };
    const noCite = store.storeDistilledFacts(BOT, [proc], {
      sessionId: 'sess-3',
      userText: 'We talked about deploys for a while.',
    });
    expect(noCite.stored).toBe(0);
    expect(noCite.rejected).toBe(1);

    const cited = store.storeDistilledFacts(BOT, [proc], {
      sessionId: 'sess-3',
      userText: 'We talked about deploys for a while.',
      userEventId: 'evt-9',
    });
    expect(cited.stored).toBe(1);
    const atom = store.getAtom(BOT, cited.atomIds[0]!);
    expect(atom?.grounding).toBe('experience-citation');
    expect(atom?.evidenceLinks).toEqual(['session://sess-3#evt-9']);
    expect(lesson.fact).toContain('test suite'); // (lesson shape sanity)
  });

  it('ingestTurn (live path) stores grounded atoms end-to-end', async () => {
    store.ingestTurn(
      BOT,
      'sess-live',
      'I prefer dark mode for all my editors and tools, thanks.',
      'Noted, dark mode everywhere.',
    );
    // Distillation is fire-and-forget; wait for the atom to land.
    let atoms = store.getAtoms(BOT, 50);
    for (let i = 0; i < 50 && atoms.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      atoms = store.getAtoms(BOT, 50);
    }
    expect(atoms.length).toBeGreaterThanOrEqual(1);
    expect(atoms[0]!.grounding).toBe('verbatim-quote');
    expect(atoms[0]!.evidenceLinks?.[0]).toMatch(/^session:\/\/sess-live#/);
  });
});

describe('#77 runDistillPipeline', () => {
  it('distills a whole session on demand and kicks off reflection', async () => {
    store.recordEvent(BOT, 'sess-done', 'user', 'I prefer dark mode for all my editors and tools.', []);
    store.recordEvent(BOT, 'sess-done', 'assistant', 'Got it, dark mode it is.', []);
    store.recordEvent(BOT, 'sess-done', 'user', 'My name is Ashutosh and I work at Acme Corp.', []);
    store.recordEvent(BOT, 'sess-done', 'assistant', 'Nice to meet you.', []);
    // Seed enough atoms for the reflection pass to run.
    store.storeAtom(BOT, { fact: 'The user builds developer tools.', entities: [], confidence: 0.8 }, 'seed');
    store.storeAtom(BOT, { fact: 'The user reviews code on Fridays.', entities: [], confidence: 0.8 }, 'seed');

    const result = await store.runDistillPipeline(BOT, 'sess-done', {
      chat: async () =>
        JSON.stringify({ lessons: [], procedures: [], contradictions: [], reflection: 'Memory looks healthy.' }),
    });
    expect(result.turns).toBe(2);
    expect(result.stored).toBeGreaterThanOrEqual(1);
    expect(result.reflection).not.toBeNull();
    expect(result.reflection!.reflectionAtomId).not.toBeNull();
    const grounded = store.getAtoms(BOT, 50).filter((a) => a.grounding === 'verbatim-quote');
    expect(grounded.length).toBeGreaterThanOrEqual(1);
  });

  it('without a chat fn, reflection is skipped (null), distillation still runs', async () => {
    store.recordEvent(BOT, 'sess-plain', 'user', 'I prefer compact tabs in every editor I use.', []);
    store.recordEvent(BOT, 'sess-plain', 'assistant', 'OK.', []);
    const result = await store.runDistillPipeline(BOT, 'sess-plain');
    expect(result.reflection).toBeNull();
    expect(result.stored).toBeGreaterThanOrEqual(1);
  });
});

describe('#74 project scoping + role-filtered retrieval', () => {
  it('recall filters by project and roles; unscoped atoms stay global', () => {
    store.storeAtom(BOT, { fact: 'Alpha project uses dark mode editors.', entities: [], confidence: 0.9 }, 't', undefined, { projectId: 'proj-a' });
    store.storeAtom(BOT, { fact: 'Beta project uses dark mode editors.', entities: [], confidence: 0.9 }, 't', undefined, { projectId: 'proj-b' });
    store.storeAtom(BOT, { fact: 'Everyone likes dark mode editors.', entities: [], confidence: 0.9 }, 't');
    store.storeAtom(BOT, { fact: 'Admins review dark mode editors weekly.', entities: [], confidence: 0.9 }, 't', undefined, { roles: ['admin'] });

    const scopedA = store.recallForPrompt(BOT, 'dark mode editors', 4000, { scope: { projectId: 'proj-a' } });
    expect(scopedA).toContain('Alpha project');
    expect(scopedA).toContain('Everyone likes');
    expect(scopedA).not.toContain('Beta project');
    // Role-filtered atom invisible without the role, visible with it.
    expect(scopedA).not.toContain('Admins review');
    const asAdmin = store.recallForPrompt(BOT, 'dark mode editors', 4000, {
      scope: { projectId: 'proj-a', roles: ['admin'] },
    });
    expect(asAdmin).toContain('Admins review');

    // searchAtoms honors scope too.
    const hits = store.searchAtoms(BOT, 'dark mode', 20, { scope: { projectId: 'proj-b' } });
    expect(hits.some((a) => a.fact.includes('Beta'))).toBe(true);
    expect(hits.some((a) => a.fact.includes('Alpha'))).toBe(false);
  });

  it('the distiller stamps scope onto stored atoms', () => {
    const res = store.storeDistilledFacts(
      BOT,
      [{ fact: 'The roadmap review happens every Monday.', entities: [], confidence: 0.8 }],
      { sessionId: 's', userText: 'Roadmap review on Monday.', userEventId: 'e', scope: { projectId: 'proj-x', roles: ['pm'] } },
    );
    expect(res.stored).toBe(1);
    const atom = store.getAtom(BOT, res.atomIds[0]!);
    expect(atom?.projectId).toBe('proj-x');
    expect(atom?.roles).toEqual(['pm']);
  });
});

describe('#76 orientation store', () => {
  it('overwrites in place while experience atoms accumulate', () => {
    store.setOrientation(BOT, 'user.name', 'Ash');
    store.setOrientation(BOT, 'user.name', 'Ashutosh');
    store.setOrientation(BOT, 'project.main', 'KriyaDot');
    const all = store.recallOrientation(BOT);
    expect(all).toHaveLength(2);
    expect(store.getOrientation(BOT, 'user.name')?.value).toBe('Ashutosh');
    // Query-filtered orientation recall.
    expect(store.recallOrientation(BOT, 'KriyaDot project').map((e) => e.key)).toEqual(['project.main']);
    // Experiences accumulate side by side (contrast).
    store.storeAtom(BOT, { fact: 'The user renamed the project once.', entities: [], confidence: 0.8 }, 't');
    store.storeAtom(BOT, { fact: 'The user renamed the project twice.', entities: [], confidence: 0.8 }, 't');
    expect(store.getAtoms(BOT, 50)).toHaveLength(2);
  });

  it('the about-me profile is expressible via the orientation store (adapter shim)', () => {
    writeAboutMe(dir, 'I am a night owl. I build robots.');
    const entry = syncAboutMeToOrientation(store, BOT, dir);
    expect(entry?.key).toBe('about-me');
    expect(orientationAboutMe(store, BOT).text).toBe('I am a night owl. I build robots.');
  });
});

describe('#79 session:// evidence links + one-hop expansion', () => {
  it('link helpers round-trip', () => {
    const link = sessionEvidenceLink('sess-9', 'msg-42');
    expect(link).toBe('session://sess-9#msg-42');
    expect(parseSessionEvidenceLink(link)).toEqual({ sessionId: 'sess-9', messageId: 'msg-42' });
    expect(parseSessionEvidenceLink('relates:abc')).toBeNull();
  });

  it('recall expands one hop over typed links, marked as expansion', () => {
    // Stub embedder: deploy-ish text is one axis, everything else is
    // orthogonal — so atom B cannot surface via either recall leg and
    // can ONLY arrive through link expansion.
    const stub: SyncEmbedder = {
      name: 'stub-orth',
      dim: 2,
      embedSync: (texts) =>
        texts.map((t) =>
          /deploy|schedule|friday/i.test(t) ? new Float32Array([1, 0]) : new Float32Array([0, 1]),
        ),
      embed: async (texts) =>
        texts.map((t) =>
          /deploy|schedule|friday/i.test(t) ? new Float32Array([1, 0]) : new Float32Array([0, 1]),
        ),
    };
    const s2 = new TieredMemoryStore(dir, { embedder: stub });
    const a = s2.storeAtom(BOT, { fact: 'The deploy schedule ships every Friday afternoon.', entities: [], confidence: 0.9 }, 't');
    const b = s2.storeAtom(BOT, { fact: 'Mnbvc xlkjhg fdsapoiuyt qwertz.', entities: [], confidence: 0.9 }, 't');
    s2.createLink(BOT, a, b, 'relates');
    const plain = s2.recallHybrid(BOT, 'deploy schedule Friday', 5);
    expect(plain.map((h) => h.atom.id)).toEqual([a]);
    const expanded = s2.recallHybrid(BOT, 'deploy schedule Friday', 5, 'cloud-ok', { expandLinks: true });
    const hitB = expanded.find((h) => h.atom.id === b);
    expect(hitB).toBeDefined();
    expect(hitB!.expansion).toBe(true);
  });

  it('addEvidenceLink attaches a session citation to an existing atom', () => {
    const id = store.storeAtom(BOT, { fact: 'A fact needing evidence.', entities: [], confidence: 0.8 }, 't');
    expect(store.addEvidenceLink(BOT, id, sessionEvidenceLink('s1', 'm1'))).toBe(true);
    expect(store.getAtom(BOT, id)?.evidenceLinks).toEqual(['session://s1#m1']);
  });
});

describe('#81 cold tier + #78 memory pack credit', () => {
  it('demote → cold-search finds it (paged) → material use promotes it', () => {
    const ids: string[] = [];
    for (const word of ['one', 'two', 'three']) {
      ids.push(
        store.storeAtom(BOT, { fact: `Zebra archive entry ${word} for retrieval.`, entities: [], confidence: 0.8 }, 't'),
      );
    }
    for (const id of ids) expect(store.archiveAtom(BOT, id)).toBe(true);
    expect(store.getAtoms(BOT, 50)).toHaveLength(0);
    expect(store.listColdAtoms(BOT)).toHaveLength(3);

    const page0 = store.searchCold(BOT, 'zebra archive', { page: 0, pageSize: 2 });
    expect(page0.total).toBe(3);
    expect(page0.atoms).toHaveLength(2);
    const page1 = store.searchCold(BOT, 'zebra archive', { page: 1, pageSize: 2 });
    expect(page1.atoms).toHaveLength(1);

    // Material use promotes exactly the used atom back to hot.
    const used = store.recordMaterialUse(BOT, ids[0]!);
    expect(used).toEqual({ atomId: ids[0], useCredit: 1, promoted: true });
    const atom = store.getAtom(BOT, ids[0]!);
    expect(atom?.active).toBe(true);
    expect(atom?.archived).toBe(false);
    expect(store.searchCold(BOT, 'zebra archive').total).toBe(2);
  });

  it('buildMemoryPack respects the token budget; creditPackUse credits only packed atoms', () => {
    const id1 = store.storeAtom(BOT, { fact: 'Pack fact alpha one.', entities: [], confidence: 0.9 }, 't');
    const id2 = store.storeAtom(BOT, { fact: 'Pack fact beta two.', entities: [], confidence: 0.9 }, 't');
    const id3 = store.storeAtom(BOT, { fact: 'Pack fact gamma three.', entities: [], confidence: 0.9 }, 't');

    const pack = store.buildMemoryPack(BOT, '', { tokenBudget: 20 });
    expect(pack.tokensUsed).toBeLessThanOrEqual(20);
    expect(pack.atoms.length).toBeGreaterThanOrEqual(1);
    expect(pack.atoms.length).toBeLessThan(3);
    expect(pack.atomIds).toEqual(pack.atoms.map((a) => a.id));
    // Stored AFTER the pack was built → cannot be in it, cannot be credited.
    const outside = store.storeAtom(BOT, { fact: 'Outside the pack entirely.', entities: [], confidence: 0.9 }, 't');
    expect(pack.atomIds).not.toContain(outside);

    const credit = store.creditPackUse(pack.id, [pack.atomIds[0]!, outside]);
    expect(credit.credited).toEqual([pack.atomIds[0]!]);
    expect(store.getAtom(BOT, pack.atomIds[0]!)?.useCredit).toBe(1);
    expect(store.getAtom(BOT, outside)?.useCredit ?? 0).toBe(0);
    expect(() => store.creditPackUse('no-such-pack', [id1])).toThrow();
    expect([id1, id2, id3]).toContain(pack.atomIds[0]);
  });

  it('pack credit promotes a cold atom that was packed before demotion', () => {
    const id = store.storeAtom(BOT, { fact: 'Promotable pack atom about comets.', entities: [], confidence: 0.9 }, 't');
    const pack = store.buildMemoryPack(BOT, 'comets');
    expect(pack.atomIds).toContain(id);
    store.archiveAtom(BOT, id);
    const credit = store.creditPackUse(pack.id, [id]);
    expect(credit.promoted).toEqual([id]);
    expect(store.getAtom(BOT, id)?.active).toBe(true);
  });
});

describe('#80 watermark budgets + verifier forwarding + archive-after-replace', () => {
  it('hot tier over its high watermark archives down to the low watermark', () => {
    for (let i = 0; i < 10; i++) {
      store.storeAtom(BOT, { fact: `Watermark filler fact number ${i} about topic ${i}.`, entities: [], confidence: 0.9 }, 't');
    }
    const pinnedId = store.storeAtom(BOT, { fact: 'Pinned watermark survivor fact.', entities: [], confidence: 0.9 }, 't', undefined, { pinned: true });
    const res = enforceWatermarkBudgets(store, journal, BOT, {
      budgets: { hot: { maxAtoms: 5 }, cold: { maxAtoms: 100 } },
    });
    expect(res.hotBefore).toBe(11);
    expect(res.hotAfter).toBe(4); // low watermark = 80% of 5
    expect(res.archived).toBe(7);
    expect(res.coldAfter).toBe(7);
    expect(store.getAtom(BOT, pinnedId)?.active).toBe(true); // pinned exempt
    // Archived atoms are retrievable from the cold catalog, not lost.
    expect(store.searchCold(BOT, 'watermark filler').total).toBeGreaterThanOrEqual(1);
  });

  it('cold tier over its high watermark forgets its oldest down to the low watermark', () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      ids.push(store.storeAtom(BOT, { fact: `Cold overflow entry ${i} for budget test.`, entities: [], confidence: 0.9 }, 't'));
    }
    for (const id of ids) store.archiveAtom(BOT, id);
    const res = enforceWatermarkBudgets(store, journal, BOT, {
      budgets: { hot: { maxAtoms: 100 }, cold: { maxAtoms: 3 } },
    });
    expect(res.coldBefore).toBe(6);
    expect(res.coldForgotten).toBe(4); // down to low watermark = 2
    expect(res.coldAfter).toBe(2);
  });

  it('runUpkeepPass forwards the mergeVerifier into tidy (gate is live)', () => {
    store.storeAtom(BOT, { fact: 'The user prefers dark roast coffee in the morning', entities: [], confidence: 0.9 }, 't1');
    store.storeAtom(BOT, { fact: 'The user prefers dark roast coffee every morning', entities: [], confidence: 0.9 }, 't2');
    // Without a verifier the paraphrase merge must NOT happen.
    const noVerifier = runUpkeepPass(store, journal, BOT, { nearDuplicateThreshold: 0.8 });
    expect(noVerifier.tidy.duplicatesDeactivated).toBe(0);
    expect(store.getAtoms(BOT, 50).filter((a) => a.fact.includes('dark roast'))).toHaveLength(2);
    // With an approving verifier it merges — and the loser is ARCHIVED.
    const withVerifier = runUpkeepPass(store, journal, BOT, {
      nearDuplicateThreshold: 0.8,
      mergeVerifier: () => true,
    });
    expect(withVerifier.tidy.duplicatesDeactivated).toBeGreaterThanOrEqual(1);
    expect(withVerifier.tidy.archived).toBeGreaterThanOrEqual(1);
    const remaining = store.getAtoms(BOT, 50).filter((a) => a.fact.includes('dark roast'));
    expect(remaining).toHaveLength(1);
    expect(store.searchCold(BOT, 'dark roast coffee').total).toBe(1);
  });

  it('superseded atoms move to the cold archive (archive-after-replace)', () => {
    const a = store.storeAtom(BOT, { fact: 'The office is in Bengaluru this year.', entities: [], confidence: 0.9 }, 't');
    const b = store.storeAtom(BOT, { fact: 'The office was in Mysuru last year.', entities: [], confidence: 0.9 }, 't');
    store.createLink(BOT, a, b, 'supersedes');
    const loser = store.getAtom(BOT, b);
    expect(loser?.active).toBe(false);
    expect(loser?.archived).toBe(true);
    expect(store.searchCold(BOT, 'Mysuru office').atoms.map((x) => x.id)).toContain(b);
    // tidyMemory still journals deactivations for structural stores.
    const tidy = tidyMemory(store, journal, BOT);
    expect(tidy.examined).toBeGreaterThanOrEqual(1);
  });
});

describe('#82 generic shadow-trial evolution', () => {
  const T0 = '2026-01-01T00:00:00.000Z';

  it('verifier rejection is terminal and fail-closed on verifier errors', async () => {
    const cand = proposeCandidate({ kind: 'memory', description: 'lesson candidate', payload: { fact: 'x' }, at: T0 });
    expect(cand.status).toBe('candidate');
    const rejected = await verifyCandidate(cand, () => ({ ok: false, reason: 'ungrounded' }), { now: T0 });
    expect(rejected.status).toBe('rejected');
    expect(rejected.verifierNote).toBe('ungrounded');
    const threw = await verifyCandidate(cand, () => {
      throw new Error('verifier down');
    }, { now: T0 });
    expect(threw.status).toBe('rejected');
  });

  it('verified candidates shadow-trial and promote only at the 3/80% bar', async () => {
    let cand = await verifyCandidate(
      proposeCandidate({ kind: 'lesson', description: 'lesson', payload: { fact: 'y' }, at: T0 }),
      async () => true,
      { now: T0 },
    );
    expect(cand.status).toBe('shadow');
    expect(cand.expiresAt).toBeTruthy();
    cand = recordEvolutionTrial(cand, true, T0);
    cand = recordEvolutionTrial(cand, true, T0);
    expect(evolutionEligible(cand, undefined, T0)).toBe(false); // only 2 trials
    cand = recordEvolutionTrial(cand, false, T0);
    expect(evolutionEligible(cand, undefined, T0)).toBe(false); // 2/3 = 66% < 80%
    let cand2 = await verifyCandidate(
      proposeCandidate({ kind: 'lesson', description: 'lesson 2', payload: { fact: 'z' }, at: T0 }),
      () => true,
      { now: T0 },
    );
    for (let i = 0; i < 4; i++) cand2 = recordEvolutionTrial(cand2, true, T0);
    cand2 = recordEvolutionTrial(cand2, false, T0); // 4/5 = 80%
    expect(evolutionEligible(cand2, undefined, T0)).toBe(true);
    const promoted = promoteEvolutionCandidate(cand2, undefined, T0);
    expect(promoted.status).toBe('promoted');
    expect(promoted.promotedAt).toBe(T0);
  });

  it('bounded trial: trials after expiry do not count and promotion is impossible', async () => {
    let cand = await verifyCandidate(
      proposeCandidate({ kind: 'memory', description: 'short window', payload: { fact: 'w' }, at: T0 }),
      () => true,
      { now: T0, windowMs: 1000 },
    );
    const after = '2026-01-01T00:00:02.000Z'; // 2s later, window was 1s
    cand = recordEvolutionTrial(cand, true, after);
    expect(cand.status).toBe('expired');
    expect(cand.trials).toBe(0);
    expect(promoteEvolutionCandidate(cand, undefined, after).status).toBe('expired');
  });
});

describe('#84 multi-pass synthesis', () => {
  it('clusters related atoms, composes a cited proposal, enters the pipeline as a candidate', async () => {
    const a = store.storeAtom(BOT, { fact: 'Acme Corp uses TypeScript for the dashboard.', entities: ['Acme Corp'], confidence: 0.9 }, 't');
    const b = store.storeAtom(BOT, { fact: 'Acme Corp migrated the dashboard to TypeScript last spring.', entities: ['Acme Corp'], confidence: 0.8 }, 't');
    store.storeAtom(BOT, { fact: 'The user brews coffee at home every morning.', entities: [], confidence: 0.9 }, 't');
    const proposals = await runSynthesisPass(store, BOT);
    expect(proposals.length).toBeGreaterThanOrEqual(1);
    const p = proposals[0]!;
    expect(p.sourceAtomIds).toEqual(expect.arrayContaining([a, b]));
    expect(p.sourceAtomIds).toHaveLength(2);
    expect(p.fact).toContain('Synthesis of 2');
    // NOT applied directly: no synthesis atom exists yet.
    expect(store.getAtoms(BOT, 50).some((x) => x.fact.startsWith('Synthesis of'))).toBe(false);
    // It enters the #82 pipeline as a candidate.
    const cand = synthesisProposalToCandidate(p);
    expect(cand.kind).toBe('memory-synthesis');
    expect(cand.status).toBe('candidate');
    // The explicit apply step (post-promotion) stores it with source links.
    const synthId = applySynthesisProposal(store, p);
    expect(store.getAtom(BOT, synthId)?.category).toBe('reflection');
    expect(store.getLinksForAtom(BOT, synthId).length).toBe(2);
  });

  it('an injectable composer replaces the extractive default', async () => {
    store.storeAtom(BOT, { fact: 'Project Zephyr ships on Fridays weekly.', entities: ['Zephyr'], confidence: 0.9 }, 't');
    store.storeAtom(BOT, { fact: 'Project Zephyr reviews happen on Thursdays.', entities: ['Zephyr'], confidence: 0.9 }, 't');
    const proposals = await runSynthesisPass(store, BOT, {
      composer: (cluster) => `Composed from ${cluster.length} Zephyr atoms.`,
    });
    expect(proposals[0]?.fact).toBe('Composed from 2 Zephyr atoms.');
  });
});

describe('#85 standing global rules + scoped memory rules', () => {
  it('a rule recurring across projects is proposed as a standing global rule', () => {
    const fact = 'Always run the test suite before merging code.';
    store.storeAtom(BOT, { fact, entities: [], confidence: 0.9 }, 't', undefined, { projectId: 'proj-a', category: 'procedure' });
    store.storeAtom(BOT, { fact, entities: [], confidence: 0.9 }, 't', undefined, { projectId: 'proj-b', category: 'procedure' });
    // Same fact in ONE project only → no standing proposal for this bot.
    store.storeAtom('bot-other', { fact: 'Never deploy on Fridays.', entities: [], confidence: 0.9 }, 't', undefined, { projectId: 'proj-a', category: 'procedure' });
    expect(proposeStandingGlobalRules(store, 'bot-other')).toHaveLength(0);

    const candidates = proposeStandingGlobalRules(store, BOT);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.kind).toBe('standing-global-rule');
    expect(candidates[0]!.status).toBe('candidate');
    expect(candidates[0]!.payload.scope).toBe('global');
    expect(candidates[0]!.payload.pinnedCandidate).toBe(true);
    expect(candidates[0]!.payload.projectIds.sort()).toEqual(['proj-a', 'proj-b']);
  });

  it('scoped pairing: rules grouped by project × pattern become scoped candidates', () => {
    store.storeAtom(BOT, { fact: 'I prefer dark mode in every editor.', entities: [], confidence: 0.9 }, 't', undefined, { projectId: 'proj-a' });
    store.storeAtom(BOT, { fact: 'I prefer compact tabs in every editor.', entities: [], confidence: 0.9 }, 't', undefined, { projectId: 'proj-a' });
    const candidates = proposeScopedMemoryRules(store, BOT);
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    expect(candidates.every((c) => c.kind === 'scoped-memory-rule')).toBe(true);
    expect(candidates[0]!.payload.projectId).toBe('proj-a');
    expect(candidates[0]!.payload.pattern).toBe('preference');
  });
});
