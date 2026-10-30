// SPDX-License-Identifier: Apache-2.0
// Closure-fix tests (verification workstream, 2026-10-30):
// - #79 buildMemoryPackNeural one-hop link expansion is LIVE by default
//   (previously the flag was accepted and silently ignored; hosts call
//   the neural pack builder with no options, so live recall never
//   traversed links) and can be disabled with expandLinks:false.
// - #81 recallColdForPrompt: cold-archive hits rendered as a prompt
//   block (searchCold existed, nothing turned a hit into context);
//   rendering does not promote — promotion stays material-use-only.
// - #82/#84/#85 runLearningEvolutionPass / runUpkeepPassWithLearning:
//   synthesis + standing/scoped proposals composed into ONE pass and
//   run through the independent verifier into bounded shadow trials.
// - #141 triageDecision: the 'triage' purpose profile finally has a
//   consumer (evaluate seam, purpose:'triage'); low-confidence "yes"
//   fails safe to not-urgent; unresolvable model → null.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TieredMemoryStore } from '../src/memory.js';
import type { SyncEmbedder } from '../src/hybrid-search.js';
import {
  MemoryJournal,
  runLearningEvolutionPass,
  runUpkeepPassWithLearning,
} from '../src/memory-upkeep.js';
import { triageDecision, resolveTriageProfile } from '../src/decision-seam.js';
import type { ChatMessage, LLMProvider, ToolDefinition } from '../src/types.js';

let dir: string;
let journal: MemoryJournal;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mvp-fix-'));
  journal = new MemoryJournal(dir);
});

afterEach(() => {
  journal.close();
  rmSync(dir, { recursive: true, force: true });
});

const BOT = 'bot-fix';

const orthEmbedder: SyncEmbedder = {
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

describe('#79 neural memory pack traverses links by default', () => {
  it('linked neighbor joins the pack; expandLinks:false keeps it out', async () => {
    const store = new TieredMemoryStore(dir, { embedder: orthEmbedder });
    const a = store.storeAtom(
      BOT,
      { fact: 'The deploy schedule ships every Friday afternoon.', entities: [], confidence: 0.9 },
      't',
    );
    const b = store.storeAtom(
      BOT,
      { fact: 'Mnbvc xlkjhg fdsapoiuyt qwertz.', entities: [], confidence: 0.9 },
      't',
    );
    store.createLink(BOT, a, b, 'relates');

    const pack = await store.buildMemoryPackNeural(BOT, 'deploy schedule Friday', { tokenBudget: 2000 });
    expect(pack.atomIds).toContain(a);
    expect(pack.atomIds).toContain(b); // only reachable via the link

    const noExpand = await store.buildMemoryPackNeural(BOT, 'deploy schedule Friday', {
      tokenBudget: 2000,
      expandLinks: false,
    });
    expect(noExpand.atomIds).toContain(a);
    expect(noExpand.atomIds).not.toContain(b);
  });
});

describe('#81 cold recall prompt surface', () => {
  it('renders archived hits as a block and does not promote them', () => {
    const store = new TieredMemoryStore(dir);
    const id = store.storeAtom(
      BOT,
      { fact: 'Zebra archive entry about quarterly budgets.', entities: [], confidence: 0.8 },
      't',
    );
    expect(store.recallColdForPrompt(BOT, 'zebra archive')).toBe('');
    expect(store.archiveAtom(BOT, id)).toBe(true);
    const block = store.recallColdForPrompt(BOT, 'zebra archive');
    expect(block).toContain('cold memory');
    expect(block).toContain('quarterly budgets');
    // Rendering is not material use: the atom stays cold.
    expect(store.getAtom(BOT, id)?.archived).toBe(true);
    expect(store.recallColdForPrompt(BOT, 'unrelated platypus')).toBe('');
  });
});

describe('#82/#84/#85 composed learning-evolution pass', () => {
  function seedLearningStore(): TieredMemoryStore {
    const store = new TieredMemoryStore(dir);
    store.storeAtom(BOT, { fact: 'Acme Corp uses TypeScript for the dashboard.', entities: ['Acme Corp'], confidence: 0.9 }, 't');
    store.storeAtom(BOT, { fact: 'Acme Corp migrated the dashboard to TypeScript last spring.', entities: ['Acme Corp'], confidence: 0.8 }, 't');
    const rule = 'Always run the test suite before merging code.';
    store.storeAtom(BOT, { fact: rule, entities: [], confidence: 0.9 }, 't', undefined, { projectId: 'proj-a', category: 'procedure' });
    store.storeAtom(BOT, { fact: rule, entities: [], confidence: 0.9 }, 't', undefined, { projectId: 'proj-b', category: 'procedure' });
    return store;
  }

  it('without a verifier, candidates from all three sources stay candidate', async () => {
    const store = seedLearningStore();
    const res = await runLearningEvolutionPass(store, BOT);
    expect(res.synthesis.length).toBeGreaterThanOrEqual(1);
    expect(res.standing).toHaveLength(1);
    expect(res.candidates.length).toBe(res.synthesis.length + res.standing.length + res.scoped.length);
    expect(res.candidates.every((c) => c.status === 'candidate')).toBe(true);
    expect(res.shadowed).toBe(0);
  });

  it('with a verifier, candidates enter bounded shadow; rejection is terminal', async () => {
    const store = seedLearningStore();
    const res = await runLearningEvolutionPass(store, BOT, {
      verifier: (c) => (c.kind === 'standing-global-rule' ? { ok: false, reason: 'not yet' } : true),
      now: '2026-10-30T00:00:00.000Z',
      windowMs: 60_000,
    });
    expect(res.verified).toBe(res.candidates.length);
    expect(res.rejected).toBe(1);
    expect(res.shadowed).toBe(res.candidates.length - 1);
    for (const c of res.candidates) {
      if (c.status === 'shadow') {
        expect(c.shadowSince).toBe('2026-10-30T00:00:00.000Z');
        expect(c.expiresAt).toBe('2026-10-30T00:01:00.000Z'); // bounded window
      }
      if (c.status === 'rejected') expect(c.kind).toBe('standing-global-rule');
    }
  });

  it('runUpkeepPassWithLearning returns tidy + watermarks + learning', async () => {
    const store = seedLearningStore();
    const out = await runUpkeepPassWithLearning(store, journal, BOT, { verifier: () => true });
    expect(out.tidy).toBeDefined();
    expect(out.watermarks).toBeDefined();
    expect(out.learning.shadowed).toBeGreaterThanOrEqual(1);
  });
});

class TriageProvider implements LLMProvider {
  readonly providerId = 'mock';
  readonly calls: Array<{ messages: ChatMessage[]; opts: Record<string, unknown> }> = [];
  constructor(private readonly reply: string) {}
  async chat(messages: ChatMessage[], _tools: ToolDefinition[], opts: Record<string, unknown>) {
    this.calls.push({ messages, opts });
    return {
      content: this.reply,
      toolCalls: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
  }
  async listModels() {
    return [{ id: 'mock-model', name: 'Mock' }];
  }
}

describe('#141 triage purpose consumer', () => {
  it('resolves the triage profile and returns a calibrated verdict', async () => {
    expect(resolveTriageProfile({ profiles: { triage: { modelId: 'mock-model' } } })?.modelId).toBe('mock-model');
    const provider = new TriageProvider('{"answer": true, "probability": 90}');
    const d = await triageDecision(provider, 'Is this alert urgent?', {
      profiles: { triage: { modelId: 'mock-model' } },
    });
    expect(d).not.toBeNull();
    expect(d!.urgent).toBe(true);
    expect(d!.probability).toBeCloseTo(0.9);
    expect(d!.model).toBe('mock-model');
    // The triage profile's model is what the provider was asked to run.
    expect(provider.calls[0]!.opts.model).toBe('mock-model');
  });

  it('a low-confidence yes fails safe to not-urgent', async () => {
    const provider = new TriageProvider('{"answer": true, "probability": 30}');
    const d = await triageDecision(provider, 'Urgent?', {
      profiles: { triage: { modelId: 'mock-model' } },
    });
    expect(d!.urgent).toBe(false);
    expect(d!.probability).toBeCloseTo(0.3);
  });
});
