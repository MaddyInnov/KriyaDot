// SPDX-License-Identifier: Apache-2.0
// A10 memory pipeline: capture → synthesis → USER-APPROVED promotion.
// - captured facts distil into PENDING candidate rules (inbox only)
// - an unapproved candidate is NEVER injected
// - approval injects the rule for matching scopes only (agent/project/global matrix)
// - dismiss removes the candidate and it is not re-proposed verbatim
// - edit-then-approve stores the edited text
// - synthesis with no model configured is a no-op success
// - scopes are strict: project rules need the project, agent rules their bot

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TieredMemoryStore } from '../src/memory.js';
import {
  createModelRuleSynthesizer,
  deterministicRuleCandidates,
  synthesizeRuleProposals,
} from '../src/memory-pipeline.js';

const BOT = 'bot-a';
const OTHER_BOT = 'bot-b';

let dir: string;
let store: TieredMemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'a10-pipeline-'));
  store = new TieredMemoryStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Capture a rule-like fact the way the grounded keeper stores preferences. */
function captureRuleFact(botId: string, fact: string, projectId?: string): string {
  return store.storeAtom(
    botId,
    { fact, entities: [], confidence: 0.9 },
    'turn-1',
    undefined,
    { category: 'preference', ...(projectId ? { projectId } : {}) },
  );
}

describe('capture → synthesis → pending (stage a/b)', () => {
  it('distils captured rule-like facts into PENDING proposals only', async () => {
    captureRuleFact(BOT, 'Always run the test suite before pushing.');
    const result = await synthesizeRuleProposals(store, BOT, {});
    expect(result.ok).toBe(true);
    expect(result.created).toHaveLength(1);
    expect(result.created[0]).toMatchObject({ status: 'pending', botId: BOT });
    expect(result.created[0]!.text).toContain('test suite');
    expect(result.created[0]!.scope).toEqual({ kind: 'agent', id: BOT });
    expect(result.created[0]!.sourceAtomIds).toHaveLength(1);
    // Nothing became a rule yet.
    expect(store.listRuleAtoms(BOT)).toHaveLength(0);
  });

  it('does not propose plain (non-rule) facts', async () => {
    store.storeAtom(BOT, { fact: 'The user lives in Portland.', entities: [], confidence: 0.9 }, 't1', undefined, { category: 'fact' });
    const result = await synthesizeRuleProposals(store, BOT, {});
    expect(result.created).toHaveLength(0);
    expect(result.lane).toBe('none');
  });

  it('is idempotent: a second synthesis run creates no duplicates', async () => {
    captureRuleFact(BOT, 'Always run the test suite before pushing.');
    await synthesizeRuleProposals(store, BOT, {});
    const second = await synthesizeRuleProposals(store, BOT, {});
    expect(second.created).toHaveLength(0);
    expect(second.skipped).toBeGreaterThan(0);
    expect(store.listRuleProposals(BOT, 'pending')).toHaveLength(1);
  });

  it('promotes cross-project recurrence to a GLOBAL candidate', async () => {
    captureRuleFact(BOT, 'Always sign commits with the project key.', 'proj-1');
    captureRuleFact(BOT, 'Always sign commits with the project key.', 'proj-2');
    const candidates = deterministicRuleCandidates(store, BOT);
    const global = candidates.find((c) => c.scope.kind === 'global');
    expect(global).toBeDefined();
    expect(global!.text).toContain('sign commits');
    expect(global!.sourceAtomIds).toHaveLength(2);
  });
});

describe('unapproved rules are never injected', () => {
  it('pending candidate does not appear in packs, rules context, or applicable rules', async () => {
    captureRuleFact(BOT, 'Always run the test suite before pushing.');
    await synthesizeRuleProposals(store, BOT, {});
    expect(store.getApplicableRules(BOT)).toHaveLength(0);
    expect(store.buildRulesContext(BOT)).toBe('');
    const pack = store.buildMemoryPack(BOT, 'test suite', {});
    expect(pack.atoms.some((a) => a.isRule)).toBe(false);
    const neural = await store.buildMemoryPackNeural(BOT, 'test suite', {});
    expect(neural.atoms.some((a) => a.isRule)).toBe(false);
  });
});

describe('approval + scope matrix', () => {
  async function proposeAndApprove(scope: { kind: 'global' | 'agent' | 'project'; id?: string }, text: string): Promise<string> {
    const id = store.createRuleProposal(BOT, { text, scope, sourceAtomIds: [] });
    const decided = store.decideRuleProposal(BOT, id, { action: 'approve', decidedBy: 'user-1' });
    expect(decided.status).toBe('approved');
    expect(decided.decidedBy).toBe('user-1');
    return decided.ruleAtomId!;
  }

  it('global rule fires for the bot in any (or no) project', async () => {
    await proposeAndApprove({ kind: 'global' }, 'Reply in the user language.');
    expect(store.getApplicableRules(BOT)).toHaveLength(1);
    expect(store.getApplicableRules(BOT, { projectId: 'anything' })).toHaveLength(1);
    expect(store.buildRulesContext(BOT)).toContain('Reply in the user language.');
  });

  it('agent rule fires only for its own bot', async () => {
    await proposeAndApprove({ kind: 'agent', id: BOT }, 'Use the red pen for bot-a.');
    await proposeAndApprove({ kind: 'agent', id: OTHER_BOT }, 'Use the blue pen for bot-b.');
    const mine = store.getApplicableRules(BOT);
    expect(mine.map((a) => a.fact)).toEqual(['Use the red pen for bot-a.']);
  });

  it('project rule fires only inside its project', async () => {
    await proposeAndApprove({ kind: 'project', id: 'proj-1' }, 'Deploy only on Fridays in proj-1.');
    expect(store.getApplicableRules(BOT)).toHaveLength(0);
    expect(store.getApplicableRules(BOT, { projectId: 'proj-2' })).toHaveLength(0);
    const inProj = store.getApplicableRules(BOT, { projectId: 'proj-1' });
    expect(inProj).toHaveLength(1);
    expect(inProj[0]!.ruleScopeKind).toBe('project');
    expect(inProj[0]!.ruleScopeId).toBe('proj-1');
  });

  it('approved rule is injected into the memory pack (sync + neural) and rendered as a Rule', async () => {
    await proposeAndApprove({ kind: 'global' }, 'Always cite sources for prices.');
    const pack = store.buildMemoryPack(BOT, 'unrelated zzqqx query', {});
    expect(pack.atoms.some((a) => a.isRule && a.fact.includes('cite sources'))).toBe(true);
    const rendered = store.renderMemoryPack(pack);
    expect(rendered).toContain('- Rule: Always cite sources for prices.');
    const neural = await store.buildMemoryPackNeural(BOT, 'unrelated zzqqx query', {});
    expect(neural.atoms.some((a) => a.isRule)).toBe(true);
  });

  it('project-scoped pack injection honours the pack scope', async () => {
    await proposeAndApprove({ kind: 'project', id: 'proj-9' }, 'Freeze deploys during the audit.');
    const inScope = store.buildMemoryPack(BOT, 'deploy', { scope: { projectId: 'proj-9' } });
    expect(inScope.atoms.some((a) => a.isRule)).toBe(true);
    const noScope = store.buildMemoryPack(BOT, 'deploy', {});
    expect(noScope.atoms.some((a) => a.isRule)).toBe(false);
    const otherScope = store.buildMemoryPack(BOT, 'deploy', { scope: { projectId: 'proj-1' } });
    expect(otherScope.atoms.some((a) => a.isRule)).toBe(false);
  });
});

describe('decisions', () => {
  it('dismiss removes the candidate and synthesis does not re-propose it', async () => {
    captureRuleFact(BOT, 'Never force-push to main.');
    const first = await synthesizeRuleProposals(store, BOT, {});
    expect(first.created).toHaveLength(1);
    const decided = store.decideRuleProposal(BOT, first.created[0]!.id, { action: 'dismiss', decidedBy: 'user-1' });
    expect(decided.status).toBe('dismissed');
    expect(store.listRuleProposals(BOT, 'pending')).toHaveLength(0);
    expect(store.getApplicableRules(BOT)).toHaveLength(0);
    const again = await synthesizeRuleProposals(store, BOT, {});
    expect(again.created).toHaveLength(0);
  });

  it('edit-then-approve stores the EDITED text as the rule', () => {
    const id = store.createRuleProposal(BOT, { text: 'Always run tests.', scope: { kind: 'global' }, sourceAtomIds: [] });
    const decided = store.decideRuleProposal(BOT, id, {
      action: 'approve',
      editedText: 'Always run the full test suite and lint before pushing.',
      decidedBy: 'user-1',
    });
    const atom = store.getAtom(BOT, decided.ruleAtomId!);
    expect(atom?.fact).toBe('Always run the full test suite and lint before pushing.');
    expect(atom?.isRule).toBe(true);
    expect(atom?.pinned).toBe(true);
    expect(store.getApplicableRules(BOT).map((a) => a.fact)).toEqual([
      'Always run the full test suite and lint before pushing.',
    ]);
  });

  it('deciding twice or deciding an unknown proposal fails closed', () => {
    const id = store.createRuleProposal(BOT, { text: 'Always run tests.', scope: { kind: 'global' }, sourceAtomIds: [] });
    store.decideRuleProposal(BOT, id, { action: 'dismiss', decidedBy: 'user-1' });
    expect(() => store.decideRuleProposal(BOT, id, { action: 'approve', decidedBy: 'user-1' })).toThrow(/already dismissed/);
    expect(() => store.decideRuleProposal(BOT, 'nope', { action: 'approve', decidedBy: 'user-1' })).toThrow(/Unknown rule proposal/);
    expect(() => store.decideRuleProposal(BOT, id, { action: 'approve', decidedBy: ' ' })).toThrow(/decidedBy/);
  });

  it('approving a rule whose text matches a captured fact mints a distinct RULE atom', () => {
    const factId = captureRuleFact(BOT, 'Always run the test suite before pushing.');
    const id = store.createRuleProposal(BOT, { text: 'Always run the test suite before pushing.', scope: { kind: 'global' }, sourceAtomIds: [factId] });
    const decided = store.decideRuleProposal(BOT, id, { action: 'approve', decidedBy: 'user-1' });
    expect(decided.ruleAtomId).not.toBe(factId);
    expect(store.getAtom(BOT, factId)?.isRule).toBeFalsy();
    expect(store.getAtom(BOT, decided.ruleAtomId!)?.isRule).toBe(true);
  });
});

describe('synthesis lanes', () => {
  it('with no model and no atoms: no-op success, zero proposals', async () => {
    const result = await synthesizeRuleProposals(store, BOT, {});
    expect(result).toMatchObject({ ok: true, lane: 'none', skipped: 0 });
    expect(result.created).toHaveLength(0);
  });

  it('model lane (mocked) proposes scoped candidates; a failing model degrades to no-op', async () => {
    store.storeAtom(BOT, { fact: 'The user works on the Sauda app.', entities: [], confidence: 0.9 }, 't1', undefined, { category: 'fact' });
    const synthesizer = vi.fn(async () => [
      { text: 'Use USD equivalents in money answers.', scope: { kind: 'global' as const }, sourceAtomIds: [], rationale: 'mock' },
      { text: 'Keep proj-x deploys frozen.', scope: { kind: 'project' as const, id: 'proj-x' }, sourceAtomIds: [] },
    ]);
    const result = await synthesizeRuleProposals(store, BOT, { synthesizer });
    expect(result.created).toHaveLength(2);
    expect(result.lane).toBe('model');
    expect(store.listRuleProposals(BOT, 'pending').map((p) => p.scope.kind).sort()).toEqual(['global', 'project']);

    const failing = createModelRuleSynthesizer(async () => {
      throw new Error('no model configured');
    });
    const degraded = await synthesizeRuleProposals(store, OTHER_BOT, { synthesizer: failing });
    expect(degraded.ok).toBe(true);
    expect(degraded.created).toHaveLength(0);
  });

  it('model synthesizer parses fenced JSON and drops ungrounded scopes', async () => {
    const atomId = captureRuleFact(BOT, 'Always run the test suite before pushing.');
    const chat = vi.fn(async () =>
      '```json\n[{"text":"Always run tests first.","scopeKind":"global","scopeId":null,"sourceIndexes":[0]},{"text":"Bad scope","scopeKind":"project","scopeId":null,"sourceIndexes":[]}]\n```',
    );
    const synthesizer = createModelRuleSynthesizer(chat);
    const candidates = await synthesizer({ botId: BOT, atoms: store.getAtoms(BOT, 10) });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ text: 'Always run tests first.', scope: { kind: 'global' }, sourceAtomIds: [atomId] });
  });
});

describe('migration: pre-A10 facts stay global facts', () => {
  it('legacy atoms read back as non-rules with global scope and unchanged recall', () => {
    const id = store.storeAtom(BOT, { fact: 'The user favorite color is teal', entities: [], confidence: 0.9 }, 't1');
    const atom = store.getAtom(BOT, id)!;
    expect(atom.isRule).toBeFalsy();
    expect(atom.ruleScopeKind).toBeUndefined();
    expect(store.listRuleAtoms(BOT)).toHaveLength(0);
    expect(store.recallForPrompt(BOT, 'favorite color')).toContain('teal');
  });
});
