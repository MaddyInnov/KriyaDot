// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from 'vitest';
import { ModuleDb } from '../db.js';
import { NotFoundError } from '../errors.js';
import {
  FeedStore,
  FeedTasteStore,
  LlmFeedGenerator,
  MockFeedGenerator,
  buildFeedPrompt,
  parseFeedDrafts,
  sanitizeFeedDraft,
  stripUncitedUrls,
  orderByUsefulness,
  ensureSeedPosts,
  FEED_SEED_POSTS,
  refreshFeedTaste,
  updateBriefAndRegenerate,
  generateFeedPosts,
  buildDiscussPayload,
  type FeedSourceItem,
  type SourceProvider,
  type ContextProvider,
} from './index.js';

const SOURCES: FeedSourceItem[] = [
  { title: 'Agents Weekly', url: 'https://example.com/agents', snippet: 'Agent frameworks roundup.', source: 'web' },
  { title: 'Pricing Post', url: 'https://example.com/pricing', snippet: 'SaaS pricing moved.', source: 'social' },
];

const fakeSources: SourceProvider = { fetchSources: () => SOURCES };
const fakeContext: ContextProvider = {
  getContext: () => ({
    profile: 'Builder based in India.',
    memorySnippets: ['Prefers TypeScript.'],
    goals: ['Ship the MVP'],
    pastPosts: [{ title: 'Old post' }],
  }),
};

describe('citation discipline (F-6)', () => {
  it('strips bare and markdown URLs that were not provided', () => {
    const allowed = new Set(SOURCES.map((s) => s.url));
    const text = 'Read [the roundup](https://example.com/agents) and [evil](https://evil.example/x) plus https://evil.example/y and https://example.com/pricing.';
    const out = stripUncitedUrls(text, allowed);
    expect(out).toContain('https://example.com/agents');
    expect(out).not.toContain('evil.example');
    expect(out).toContain('the roundup');
  });

  it('sanitizeFeedDraft keeps only provided sources', () => {
    const draft = sanitizeFeedDraft(
      {
        title: 'News https://evil.example/t',
        body: 'Body citing https://example.com/agents and https://nope.example/z',
        sources: [
          { title: 'x', url: 'https://example.com/agents', snippet: '', source: 'web' },
          { title: 'y', url: 'https://nope.example/z', snippet: '', source: 'web' },
        ],
      },
      SOURCES,
    );
    expect((draft.sources ?? []).map((s) => s.url)).toEqual(['https://example.com/agents']);
    expect(draft.body).not.toContain('nope.example');
    expect(draft.title).not.toContain('evil.example');
  });

  it('with no sources provided, every URL is stripped', () => {
    const draft = sanitizeFeedDraft({ title: 'T', body: 'see https://example.com/agents' }, []);
    expect(draft.body).not.toContain('http');
    expect(draft.sources).toEqual([]);
  });
});

describe('LlmFeedGenerator (F-1/F-4/F-5)', () => {
  let prompts: string[];

  beforeEach(() => {
    prompts = [];
  });

  function makeGen(llmOut: string, extra: Partial<ConstructorParameters<typeof LlmFeedGenerator>[0]> = {}) {
    return new LlmFeedGenerator({
      llm: (p) => {
        prompts.push(p);
        return llmOut;
      },
      sourceProvider: fakeSources,
      contextProvider: fakeContext,
      ...extra,
    });
  }

  it('assembles the prompt from brief, context, taste and sources', async () => {
    const db = new ModuleDb(':memory:');
    const taste = new FeedTasteStore(db);
    taste.setTaste('Loves pricing analysis; dislikes crypto hype.');
    const gen = makeGen('[{"title":"A","body":"B","sources":["https://example.com/agents"]}]', { tasteStore: taste });
    await gen.generate('AI agents and SaaS pricing');
    const prompt = prompts[0];
    expect(prompt).toContain('AI agents and SaaS pricing');
    expect(prompt).toContain('Builder based in India.');
    expect(prompt).toContain('Prefers TypeScript.');
    expect(prompt).toContain('Ship the MVP');
    expect(prompt).toContain('Old post');
    expect(prompt).toContain('Loves pricing analysis');
    expect(prompt).toContain('https://example.com/agents');
    expect(prompt).toContain('UNTRUSTED');
    db.close();
  });

  it('parses JSON posts and strips invented citations end-to-end', async () => {
    const gen = makeGen(
      JSON.stringify([
        {
          title: 'Pricing moved',
          body: 'Details at https://example.com/pricing and https://invented.example/fake',
          sources: ['https://example.com/pricing', 'https://invented.example/fake'],
          actionable: true,
          deadlineAt: 1893456000000,
        },
      ]),
    );
    const drafts = await gen.generate('pricing');
    expect(drafts).toHaveLength(1);
    expect((drafts[0].sources ?? []).map((s) => s.url)).toEqual(['https://example.com/pricing']);
    expect(drafts[0].body).not.toContain('invented.example');
    expect(drafts[0].actionable).toBe(true);
    expect(drafts[0].deadlineAt).toBe(1893456000000);
  });

  it('falls back to a single prose post when the LLM does not return JSON', async () => {
    const gen = makeGen('Big headline\nSome body text.');
    const drafts = await gen.generate('anything');
    expect(drafts).toHaveLength(1);
    expect(drafts[0].title).toBe('Big headline');
  });

  it('parseFeedDrafts handles fenced JSON and {posts:[...]} shapes', () => {
    expect(parseFeedDrafts('```json\n[{"title":"X","body":"Y"}]\n```')[0].title).toBe('X');
    expect(parseFeedDrafts('{"posts":[{"title":"Z","body":"W"}]}')[0].title).toBe('Z');
    expect(parseFeedDrafts('')).toEqual([]);
  });

  it('buildFeedPrompt bans invented URLs explicitly', () => {
    const prompt = buildFeedPrompt('brief', {}, SOURCES);
    expect(prompt).toContain('Never invent a URL');
  });
});

describe('taste learning (F-7)', () => {
  let db: ModuleDb;
  let store: FeedStore;
  let taste: FeedTasteStore;

  beforeEach(() => {
    db = new ModuleDb(':memory:');
    store = new FeedStore(db);
    taste = new FeedTasteStore(db);
  });

  it('refresh summarises reactions via the injected summarizer', async () => {
    const post = store.addPost({ title: 'Pricing deep dive', body: '...' });
    store.recordReaction(post.id, 'like');
    store.recordReaction(post.id, 'discussed');
    let seenPrompt = '';
    const result = await refreshFeedTaste(taste, store, (p) => {
      seenPrompt = p;
      return 'Loves pricing deep dives.';
    });
    expect(seenPrompt).toContain('Pricing deep dive');
    expect(result?.summary).toBe('Loves pricing deep dives.');
    expect(taste.getTaste()?.summary).toBe('Loves pricing deep dives.');
  });

  it('refresh is a no-op with no reactions', async () => {
    let called = false;
    const result = await refreshFeedTaste(taste, store, () => {
      called = true;
      return 'x';
    });
    expect(result).toBeNull();
    expect(called).toBe(false);
  });

  it('taste can be viewed and reset, and is never a post', async () => {
    taste.setTaste('Prefers long reads.');
    expect(taste.getTaste()?.summary).toContain('long reads');
    taste.resetTaste();
    expect(taste.getTaste()).toBeNull();
    expect(store.listPosts(true)).toHaveLength(0);
  });
});

describe('usefulness ordering (F-8)', () => {
  const base = { title: 't', body: '', sourceNote: null, dismissed: false, sources: [], seed: false };
  it('orders unseen > actionable > deadline-bearing > rest, earliest deadline first', () => {
    const posts = [
      { ...base, id: 'seen-plain', seen: true, actionable: false, deadlineAt: null, createdAt: 500 },
      { ...base, id: 'unseen-plain', seen: false, actionable: false, deadlineAt: null, createdAt: 100 },
      { ...base, id: 'unseen-actionable', seen: false, actionable: true, deadlineAt: null, createdAt: 90 },
      { ...base, id: 'unseen-deadline-late', seen: false, actionable: true, deadlineAt: 2000, createdAt: 80 },
      { ...base, id: 'unseen-deadline-early', seen: false, actionable: true, deadlineAt: 1000, createdAt: 70 },
      { ...base, id: 'seen-actionable', seen: true, actionable: true, deadlineAt: null, createdAt: 600 },
    ];
    const ordered = orderByUsefulness(posts).map((p) => p.id);
    expect(ordered).toEqual([
      'unseen-deadline-early',
      'unseen-deadline-late',
      'unseen-actionable',
      'unseen-plain',
      'seen-actionable',
      'seen-plain',
    ]);
    // Input not mutated.
    expect(posts[0].id).toBe('seen-plain');
  });

  it('listPostsQuery applies usefulness order and keeps chronological default', () => {
    const db = new ModuleDb(':memory:');
    const store = new FeedStore(db);
    const a = store.addPost({ title: 'A plain', body: '' });
    store.addPost({ title: 'B actionable', body: '', actionable: true });
    store.markSeen(a.id);
    expect(store.listPostsQuery({ order: 'usefulness' })[0].title).toBe('B actionable');
    expect(store.listPostsQuery()[0].title).toBe('B actionable'); // chronological: newest first
    db.close();
  });
});

describe('starter posts (F-3)', () => {
  it('seeds exactly 3 flagged posts on first init, idempotently, deletable', () => {
    const db = new ModuleDb(':memory:');
    const store = new FeedStore(db);
    const seeded = ensureSeedPosts(store);
    expect(seeded).toHaveLength(3);
    expect(FEED_SEED_POSTS).toHaveLength(3);
    expect(seeded.every((p) => p.seed)).toBe(true);
    expect(ensureSeedPosts(store)).toEqual([]);
    store.deletePost(seeded[0].id);
    expect(store.listPosts()).toHaveLength(2);
    db.close();
  });

  it('does not seed when real posts already exist', async () => {
    const db = new ModuleDb(':memory:');
    const store = new FeedStore(db);
    store.setBrief('real topic');
    await generateFeedPosts(store, new MockFeedGenerator());
    expect(ensureSeedPosts(store)).toEqual([]);
    db.close();
  });
});

describe('brief regen, search, reactions, discuss (F-9/F-10/F-13)', () => {
  let db: ModuleDb;
  let store: FeedStore;

  beforeEach(() => {
    db = new ModuleDb(':memory:');
    store = new FeedStore(db);
  });

  it('a changed brief appends a fresh generation; an unchanged one does not', async () => {
    const gen = new MockFeedGenerator();
    const first = await updateBriefAndRegenerate(store, gen, 'topic one');
    expect(first.generated.length).toBeGreaterThan(0);
    const countAfterFirst = store.listPosts().length;
    const same = await updateBriefAndRegenerate(store, gen, 'topic one');
    expect(same.generated).toEqual([]);
    expect(store.listPosts()).toHaveLength(countAfterFirst);
    const changed = await updateBriefAndRegenerate(store, gen, 'topic two');
    expect(changed.generated.length).toBeGreaterThan(0);
    expect(store.listPosts().length).toBeGreaterThan(countAfterFirst);
  });

  it('searches past posts by title and body, case-insensitively', () => {
    store.addPost({ title: 'Kubernetes notes', body: 'pods and services' });
    store.addPost({ title: 'Cooking', body: 'A KUBERNETES-free kitchen' });
    store.addPost({ title: 'Other', body: 'nothing relevant' });
    expect(store.searchPosts('kubernetes')).toHaveLength(2);
    expect(store.searchPosts('PODS')).toHaveLength(1);
    expect(store.listPostsQuery({ q: 'cooking' })).toHaveLength(1);
    expect(store.searchPosts('missing-term')).toHaveLength(0);
  });

  it('records reactions and validates them', () => {
    const post = store.addPost({ title: 'React to me', body: '' });
    const rec = store.recordReaction(post.id, 'like');
    expect(rec.reaction).toBe('like');
    expect(store.listReactions(post.id)).toHaveLength(1);
    expect(() => store.recordReaction(post.id, 'love' as never)).toThrow();
    expect(() => store.recordReaction('nope', 'like')).toThrow(NotFoundError);
  });

  it('discuss returns a chat-seed payload and records the discussion', () => {
    const post = store.addPost({ title: 'Discuss me', body: 'The body.' });
    const payload = store.discuss(post.id);
    expect(payload.contextRef).toBe(`feed-post:${post.id}`);
    expect(payload.prompt).toContain('Discuss me');
    expect(payload.prompt).toContain('The body.');
    expect(store.listReactions(post.id).map((r) => r.reaction)).toEqual(['discussed']);
    expect(buildDiscussPayload(post).contextRef).toBe(payload.contextRef);
  });

  it('markSeen flips the seen flag used by ordering', () => {
    const post = store.addPost({ title: 'Seen test', body: '' });
    expect(post.seen).toBe(false);
    expect(store.markSeen(post.id).seen).toBe(true);
    expect(store.getPost(post.id)?.seen).toBe(true);
  });
});
