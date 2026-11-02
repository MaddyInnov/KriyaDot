// SPDX-License-Identifier: Apache-2.0
// OH-1 + OH-2: spill handle tools contract, blended capability search,
// and blended universal routing with conservative (non-hash-only)
// activation.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ToolSpillStore,
  TrigramEmbedder,
  createSpillTools,
  type BotConfig,
  type SyncEmbedder,
} from '@mvp/agent-runtime';
import {
  buildCapabilityRegistry,
  createCapabilityService,
  searchCapabilities,
  searchCapabilitiesBlended,
  type CapabilityEntry,
  type CapabilityRegistry,
} from '../src/capabilities.js';
import { decideUniversalRoute } from '../src/universal.js';

// ---------------------------------------------------------------------------
// OH-1: the handle-tools option the API call sites now pass
// ---------------------------------------------------------------------------

describe('OH-1 createSpillTools({ handleTools: true })', () => {
  it('yields fetch_handle + search_handle alongside the legacy reader', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spill-'));
    try {
      const store = new ToolSpillStore(join(dir, 'spill'));
      const names = createSpillTools(store, { handleTools: true }).map((t) => t.name);
      expect(names).toContain('fetch_handle');
      expect(names).toContain('search_handle');
      expect(names).toContain('read_spilled_result');
      const plain = createSpillTools(store).map((t) => t.name);
      expect(plain).toEqual(['read_spilled_result']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// OH-2: capability search blending
// ---------------------------------------------------------------------------

function entry(partial: Partial<CapabilityEntry> & { id: string; name: string }): CapabilityEntry {
  return {
    whatItDoes: '',
    whenToUse: '',
    howToInvoke: { type: 'tool', toolName: partial.id, description: 'call it' },
    kind: 'tool',
    group: 'General',
    keywords: [],
    ...partial,
  } as CapabilityEntry;
}

const REGISTRY: CapabilityRegistry = {
  generatedAt: '2026-11-02T00:00:00.000Z',
  counts: { bot: 0, tool: 2, skill: 0, workflow: 0, plugin: 0, channel: 0, feature: 0 },
  entries: [
    entry({ id: 'tool:alpha', name: 'Alpha', whatItDoes: 'alpha work' }),
    entry({ id: 'tool:beta', name: 'Beta', whatItDoes: 'beta work' }),
  ],
};

/** Fake neural embedder: 'beta'-ish texts → [1,0], everything else → [0,1]. */
const fakeNeural: SyncEmbedder = {
  name: 'fake-neural',
  dim: 2,
  kind: 'neural',
  embedSync: (texts) =>
    texts.map((t) => (t.toLowerCase().includes('beta') ? new Float32Array([1, 0]) : new Float32Array([0, 1]))),
  embed: (texts) => fakeNeural.embedSync(texts),
};

describe('OH-2 searchCapabilitiesBlended', () => {
  it('keyword-only ranking ties break by name (Alpha first)', () => {
    const hits = searchCapabilities(REGISTRY, 'alpha beta');
    expect(hits[0]!.entry.id).toBe('tool:alpha');
  });

  it('semantic cosine re-ranks: the semantic winner beats the keyword tie', () => {
    const hits = searchCapabilitiesBlended(REGISTRY, 'alpha beta', fakeNeural);
    expect(hits[0]!.entry.id).toBe('tool:beta');
    expect(hits[0]!.semanticActive).toBe(true);
    expect(hits[0]!.semanticScore).toBe(1);
    expect(typeof hits[0]!.keywordScore).toBe('number');
  });

  it('trigram fallback degrades gracefully (semanticActive=false, keyword order preserved)', () => {
    const service = createCapabilityService(
      {
        bots: () => [{ id: 'coder', name: 'Coder', description: 'Writes and fixes code.', routeKeywords: ['code'] }],
        tools: () => [{ name: 'schedule_task', description: 'Schedule a recurring task.' }],
      },
      { embedder: new TrigramEmbedder() },
    );
    const hits = service.search('who can write and fix code');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.entry.id).toBe('bot:coder');
    expect(hits[0]!.semanticActive).toBe(false);
  });

  it('service without an embedder stays keyword-only (no blend fields)', () => {
    const registry = buildCapabilityRegistry({
      bots: () => [{ id: 'coder', name: 'Coder', description: 'Writes code.', routeKeywords: ['code'] }],
    });
    const service = createCapabilityService({
      bots: () => [{ id: 'coder', name: 'Coder', description: 'Writes code.', routeKeywords: ['code'] }],
    });
    expect(registry.entries.length).toBeGreaterThan(0);
    const hits = service.search('write code');
    expect(hits[0]!.keywordScore).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// OH-2: universal routing blend
// ---------------------------------------------------------------------------

const CHIEF = {
  id: 'chief', name: 'Chief', description: 'Chief of Staff coordinating the team',
  systemPrompt: 'coordinate', provider: 'ovh-anonymous', model: 'gpt-oss-120b', tools: [], skills: [],
} as BotConfig;
const CODER = {
  id: 'coder', name: 'Coder', description: 'Writes and debugs code, programming in typescript',
  systemPrompt: 'code', provider: 'ovh-anonymous', model: 'gpt-oss-120b', tools: [], skills: [],
  routeKeywords: ['code', 'debug'],
} as BotConfig;
const WRITER = {
  id: 'writer', name: 'Copywriter', description: 'Writes essays, blogs, sonnets and poems',
  systemPrompt: 'write', provider: 'ovh-anonymous', model: 'gpt-oss-120b', tools: [], skills: [],
  routeKeywords: ['essay', 'blog'],
} as BotConfig;
const BOTS = [CHIEF, CODER, WRITER];

/** Fake neural embedder: poetry-ish → [1,0], code-ish → [0,1], else [0,0]. */
const fakeRouterEmbedder: SyncEmbedder = {
  name: 'fake-neural',
  dim: 2,
  kind: 'neural',
  embedSync: (texts) =>
    texts.map((t) => {
      const s = t.toLowerCase();
      if (/sonnet|poem|poetry|essay|blog|copywriter/.test(s)) return new Float32Array([1, 0]);
      if (/code|debug|typescript|coder/.test(s)) return new Float32Array([0, 1]);
      return new Float32Array([0, 0]);
    }),
  embed: (texts) => fakeRouterEmbedder.embedSync(texts),
};

describe('OH-2 decideUniversalRoute blending', () => {
  it('keyword-only behavior is unchanged without an embedder', () => {
    expect(decideUniversalRoute('please compose a sonnet for me', BOTS, CHIEF).path).toBe('direct');
    const d = decideUniversalRoute('help me debug this typescript code, it has a bug', BOTS, CHIEF);
    expect(d.path).toBe('specialist');
    expect(d.botId).toBe('coder');
    expect(d.blend).toBeUndefined();
  });

  it('a neural embedder blends: a semantic-only match routes to the specialist with blend detail', () => {
    const d = decideUniversalRoute('please compose a sonnet for me', BOTS, CHIEF, undefined, {
      embedder: fakeRouterEmbedder,
    });
    expect(d.path).toBe('specialist');
    expect(d.botId).toBe('writer');
    expect(d.via).toBe('keyword-score'); // union unchanged
    expect(d.blend?.semanticActive).toBe(true);
    expect(d.reason).toContain('semantic blend');
  });

  it('the trigram fallback does NOT activate blending (conservative activation)', () => {
    const d = decideUniversalRoute('please compose a sonnet for me', BOTS, CHIEF, undefined, {
      embedder: new TrigramEmbedder(),
    });
    expect(d.path).toBe('direct');
    expect(d.blend).toBeUndefined();
  });
});
