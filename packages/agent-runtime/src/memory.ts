// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolContext, ToolDefinition } from './types.js';
// Privacy tiers (write-time tags; local-only atoms never reach cloud
// prompts — see @mvp/governance privacy-tiers.ts).
import type { PrivacyTier } from '@mvp/governance';
import { isPrivacyTier, resolveTier, tierAtMost } from '@mvp/governance';
import {
  TrigramEmbedder,
  buildFtsMatchQuery,
  cosineSimilarity,
  reciprocalRankFuse,
  type SyncEmbedder,
} from './hybrid-search.js';

const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
type DatabaseSyncType = InstanceType<typeof DatabaseSync>;

/**
 * Bot ids are used as file names, so restrict them to a safe alphabet.
 * Rejects path traversal (e.g. "../../etc") fail-closed.
 */
const BOT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function checkBotId(botId: string): void {
  if (!BOT_ID_PATTERN.test(botId)) {
    throw new Error(
      `Invalid bot id "${botId}": must match ${BOT_ID_PATTERN.source} (memory file names are derived from bot ids)`,
    );
  }
}

/**
 * Per-bot persistent memory: one markdown file per bot at
 * `<dataDir>/memories/<botId>.md`. Survives sessions and restarts — it is
 * just a file on disk.
 *
 * Two write modes:
 * - append(): timestamped journal entries (bot's memory_store tool).
 * - replace(): full rewrite (used by the Workspace UI's memory editor).
 *
 * NOTE (follow-up for the Workspace UI, owned by the top coordinator):
 * expose this over HTTP as GET/PUT /api/bots/:id/memory so users can read
 * and edit bot memory from the dashboard. The store class below is already
 * safe to call from a route handler.
 */
export class BotMemoryStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'memories');
  }

  /** Absolute path of a bot's memory file (handy for debugging/tests). */
  path(botId: string): string {
    checkBotId(botId);
    return join(this.dir, `${botId}.md`);
  }

  /** Read the bot's memory file; returns '' when it has no memory yet. */
  read(botId: string): string {
    checkBotId(botId);
    try {
      return readFileSync(this.path(botId), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw err;
    }
  }

  /** Append a timestamped markdown section. Creates the dir/file as needed. */
  append(botId: string, entry: string): void {
    checkBotId(botId);
    const text = entry.trim();
    if (!text) throw new Error('memory_store: "entry" must be a non-empty string');
    mkdirSync(this.dir, { recursive: true });
    const existing = this.read(botId);
    const section = `## ${new Date().toISOString()}\n\n${text}\n`;
    const next = existing ? (existing.endsWith('\n') ? existing : existing + '\n') + '\n' + section : section;
    writeFileSync(this.path(botId), next, 'utf8');
  }

  /** Full replace of the memory file (user edits from the UI). */
  replace(botId: string, content: string): void {
    checkBotId(botId);
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.path(botId), content, 'utf8');
  }
}

export interface CreateMemoryToolsOptions {
  store: BotMemoryStore;
}

/**
 * Two tools, both scoped to the calling bot via ctx.botId:
 * - memory_recall: returns the bot's memory file content ('' if none yet).
 * - memory_store: appends a timestamped fact to the bot's memory.
 *
 * Governance: memory_store is a write tool, so it goes through the normal
 * approval flow like any other tool — nothing here bypasses Phase 1 policy.
 * Deliberately minimal: no system-prompt injection; the bot discovers its
 * memory through the tool descriptions, which the model sees.
 */
export function createMemoryTools(opts: CreateMemoryToolsOptions): ToolDefinition[] {
  const { store } = opts;

  const recall: ToolDefinition = {
    name: 'memory_recall',
    description:
      'Read your persistent memory: durable facts you chose to remember across ' +
      'conversations (preferences, project state, user details). Returns the ' +
      'memory file content, or empty text if nothing is stored yet. Call it ' +
      'when past context would help the current task.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (_args: Record<string, unknown>, ctx: ToolContext) => {
      return { content: store.read(ctx.botId) };
    },
  };

  const storeTool: ToolDefinition = {
    name: 'memory_store',
    mutating: true,
    description:
      'Save a durable fact to your persistent memory (survives sessions). ' +
      'Use for user preferences, project decisions, and anything you will ' +
      'need in future conversations. Do NOT store secrets, credentials, or ' +
      'private data the user did not ask you to remember.',
    parameters: {
      type: 'object',
      properties: {
        entry: {
          type: 'string',
          description: 'The fact to remember, as a short markdown paragraph.',
        },
      },
      required: ['entry'],
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>, ctx: ToolContext) => {
      const entry = typeof args.entry === 'string' ? args.entry : '';
      store.append(ctx.botId, entry);
      return { stored: true, botId: ctx.botId };
    },
  };

  return [recall, storeTool];
}

// ===========================================================================
// Tiered memory (Octop parity): L0 raw events → L2 atom cards → L3 entity pages.
//
// L0: every turn's raw user/assistant text + tool calls, stored as events.
// L2: durable facts distilled from turns into AtomCards (deduped).
// L3: per-entity pages aggregating the atoms that mention an entity.
//
// Distillation runs async and non-blocking after each turn (ingestTurn).
// Recall is a cheap keyword lookup injected into the system prompt at turn
// start ("What I remember"), capped at ~500 tokens.
// ===========================================================================

/** L0: a raw turn event. */
export interface MemoryEvent {
  id: string;
  ts: number;
  botId: string;
  sessionId: string;
  role: 'user' | 'assistant';
  text: string;
  toolCalls: string[];
  /** Privacy tier (write-time tag; defaults to `cloud-ok`). */
  tier: PrivacyTier;
}

/** L2: a distilled durable fact card. */
export interface AtomCard {
  id: string;
  botId: string;
  fact: string;
  entities: string[];
  confidence: number;
  sourceTurn: string;
  createdAt: number;
  /** Privacy tier (write-time tag; defaults to `cloud-ok`). */
  tier: PrivacyTier;
  /** Pinned memories always surface first in recall and are never auto-pruned. */
  pinned: boolean;
  /** Memory category: fact | preference | summary | decision | lesson | procedure | reflection. */
  category: MemoryCategory;
  /**
   * Active memories participate in recall/search. Memories superseded by a
   * conflict resolution are kept (audit trail) but marked inactive.
   */
  active: boolean;
}

/** Durable memory categories (Engram + Atomic parity). */
export type MemoryCategory =
  | 'fact'
  | 'preference'
  | 'summary'
  | 'decision'
  | 'lesson'
  | 'procedure'
  | 'reflection';

const MEMORY_CATEGORIES: ReadonlySet<string> = new Set([
  'fact',
  'preference',
  'summary',
  'decision',
  'lesson',
  'procedure',
  'reflection',
]);

function normalizeCategory(c: unknown): MemoryCategory {
  return typeof c === 'string' && MEMORY_CATEGORIES.has(c) ? (c as MemoryCategory) : 'fact';
}

/** L3: an entity page aggregating atoms. */
export interface EntityPage {
  entity: string;
  botId: string;
  summary: string;
  atomIds: string[];
  updatedAt: number;
}

/** One distilled fact, before persistence. */
export interface DistilledFact {
  fact: string;
  entities: string[];
  confidence: number;
  /** Optional explicit category (used by the advanced LLM distiller for lessons/procedures). */
  category?: MemoryCategory;
}

/** A typed link between two memory atoms (Atomic parity). */
export type MemoryLinkKind = 'relates' | 'contradicts' | 'supersedes';

export interface MemoryLink {
  id: string;
  botId: string;
  fromAtomId: string;
  toAtomId: string;
  kind: MemoryLinkKind;
  createdAt: number;
  /** Who created the link: 'user' | 'reflection' | 'system'. */
  createdBy: string;
}

/** One vote in a memory conflict (Atomic parity: voting/consensus). */
export interface ConflictVote {
  by: string;
  winnerId: string;
  ts: number;
}

/** A contradiction between two memories awaiting (or having received) a verdict. */
export interface MemoryConflict {
  id: string;
  botId: string;
  atomAId: string;
  atomBId: string;
  status: 'open' | 'resolved';
  votes: ConflictVote[];
  winnerId: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

/** Result of one reflection pass. */
export interface ReflectionResult {
  ok: boolean;
  skipped: boolean;
  reason?: string;
  lessonsCreated: number;
  proceduresCreated: number;
  conflictsOpened: number;
  reflectionAtomId: string | null;
}

/**
 * Optional LLM distiller injected by the host. Receives the turn text
 * (user + assistant) and returns durable facts. When absent, the heuristic
 * extractor below is used — no model call, no latency, no cost.
 */
export type LlmDistiller = (turnText: string) => Promise<DistilledFact[]>;

/**
 * Minimal LLM chat function for the keeper. The host wires this to the
 * bot's own provider; keeping it a tiny interface avoids coupling
 * memory.ts to the full AgentRuntime.
 */
export type KeeperChatFn = (systemPrompt: string, userText: string) => Promise<string>;

const KEEPER_SYSTEM_PROMPT = `You extract durable facts about the user from conversations for long-term memory.
Return ONLY a JSON array of objects, each with "fact" (a concise declarative sentence),
"entities" (array of proper nouns mentioned), and "confidence" (0-1).
Include: preferences, names, projects, decisions, goals, important context.
Exclude: transient chit-chat, greetings, one-off questions with no lasting value.
If nothing is worth remembering, return [].
Example: [{"fact": "The user's preferred name is \\"Ashutosh\\".", "entities": ["Ashutosh"], "confidence": 0.95}]`;

/**
 * Advanced extraction prompt (memory fabric / Atomic parity): in addition
 * to facts, extracts reusable lessons (what the bot learned from a mistake
 * or a success) and procedures (multi-step processes the bot should reuse).
 * Each item carries a "category": "fact" | "preference" | "decision" |
 * "lesson" | "procedure".
 */
const KEEPER_ADVANCED_SYSTEM_PROMPT = `You extract durable memories from conversations for a long-term memory fabric.
Return ONLY a JSON array of objects, each with:
- "fact": a concise declarative sentence (for procedures: the procedure name followed by numbered steps)
- "entities": array of proper nouns mentioned
- "confidence": 0-1
- "category": one of "fact", "preference", "decision", "lesson", "procedure"

Rules:
- "fact": durable personal facts (names, projects, goals, context).
- "preference": likes, dislikes, stated preferences.
- "decision": decisions or agreements made in the conversation.
- "lesson": something the bot learned from a mistake, a correction, or a success
  (e.g. "Always run the test suite before committing"). Only when the turn shows
  learning — do not invent lessons.
- "procedure": a reusable multi-step process demonstrated or agreed in the turn
  (e.g. "Deploy procedure: 1. Build the app. 2. Run smoke tests. 3. Publish the release.").
  Only when the turn actually contains a repeatable sequence.
Exclude transient chit-chat, greetings, one-off questions with no lasting value.
If nothing is worth remembering, return [].
Example: [{"fact": "Always run npm test before pushing to main.", "entities": [], "confidence": 0.9, "category": "lesson"}]`;

/**
 * Build an LLM distiller from a chat function. Parses the model's JSON
 * response; falls back to the heuristic extractor on any failure
 * (bad JSON, model error) — the keeper must never lose facts to a
 * malformed response.
 *
 * Pass { advanced: true } to also extract lessons and procedures with
 * explicit categories (memory fabric). The advanced prompt is only used
 * for the live bot-model distiller (memoryLiveDistill), never for the
 * zero-cost heuristic path.
 */
export function createLlmDistiller(chat: KeeperChatFn, opts: { advanced?: boolean } = {}): LlmDistiller {
  const systemPrompt = opts.advanced ? KEEPER_ADVANCED_SYSTEM_PROMPT : KEEPER_SYSTEM_PROMPT;
  return async (turnText: string): Promise<DistilledFact[]> => {
    let raw: string;
    try {
      raw = await chat(systemPrompt, turnText.slice(0, 4000));
    } catch {
      return heuristicDistill(turnText);
    }
    try {
      // Strip markdown code fences if the model wrapped the JSON.
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      const parsed = JSON.parse(cleaned) as Array<{ fact?: unknown; entities?: unknown; confidence?: unknown; category?: unknown }>;
      if (!Array.isArray(parsed)) return heuristicDistill(turnText);
      const facts: DistilledFact[] = [];
      for (const item of parsed.slice(0, 10)) {
        if (typeof item?.fact !== 'string' || !item.fact.trim()) continue;
        const distilled: DistilledFact = {
          fact: item.fact.trim().slice(0, 500),
          entities: Array.isArray(item.entities)
            ? (item.entities.filter((e): e is string => typeof e === 'string').map((e) => e.trim()).filter(Boolean).slice(0, 10))
            : [],
          confidence: typeof item.confidence === 'number' ? Math.min(1, Math.max(0, item.confidence)) : 0.7,
        };
        if (opts.advanced && typeof item.category === 'string' && MEMORY_CATEGORIES.has(item.category)) {
          distilled.category = item.category as MemoryCategory;
        }
        facts.push(distilled);
      }
      return facts;
    } catch {
      return heuristicDistill(turnText);
    }
  };
}

const ATOM_TABLE = `
  CREATE TABLE IF NOT EXISTS memory_atoms (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL,
    fact TEXT NOT NULL,
    fact_norm TEXT NOT NULL,
    entities_json TEXT NOT NULL,
    confidence REAL NOT NULL,
    source_turn TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    tier TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_memory_atoms_bot ON memory_atoms(bot_id);
  CREATE INDEX IF NOT EXISTS idx_memory_atoms_norm ON memory_atoms(bot_id, fact_norm);
`;

const ENTITY_TABLE = `
  CREATE TABLE IF NOT EXISTS memory_entities (
    bot_id TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_norm TEXT NOT NULL,
    summary TEXT NOT NULL,
    atom_ids_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (bot_id, entity_norm)
  );
`;

const EVENT_TABLE = `
  CREATE TABLE IF NOT EXISTS memory_events (
    id TEXT PRIMARY KEY,
    ts INTEGER NOT NULL,
    bot_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    tool_calls_json TEXT NOT NULL,
    tier TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_memory_events_bot ON memory_events(bot_id, ts);
`;

// Lexical leg of hybrid search: FTS5/BM25 over atom facts + entities.
// Synced manually in storeAtom/deleteAtom (atoms use TEXT primary keys,
// so the external-content trigger pattern does not apply).
const ATOM_FTS_TABLE = `
  CREATE VIRTUAL TABLE IF NOT EXISTS memory_atoms_fts USING fts5(
    atom_id UNINDEXED,
    bot_id UNINDEXED,
    fact,
    entities
  );
`;

// Memory fabric (Atomic parity): explicit links between atoms,
// contradiction conflicts with votes, and reflection turn counters.
const LINK_TABLE = `
  CREATE TABLE IF NOT EXISTS memory_links (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL,
    from_atom_id TEXT NOT NULL,
    to_atom_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    created_by TEXT NOT NULL DEFAULT 'user',
    UNIQUE (bot_id, from_atom_id, to_atom_id, kind)
  );
  CREATE INDEX IF NOT EXISTS idx_memory_links_bot ON memory_links(bot_id);
  CREATE INDEX IF NOT EXISTS idx_memory_links_atoms ON memory_links(bot_id, from_atom_id, to_atom_id);
`;

const CONFLICT_TABLE = `
  CREATE TABLE IF NOT EXISTS memory_conflicts (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL,
    atom_a_id TEXT NOT NULL,
    atom_b_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    votes_json TEXT NOT NULL DEFAULT '[]',
    winner_id TEXT,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_memory_conflicts_bot ON memory_conflicts(bot_id, status);
`;

const REFLECTION_COUNTER_TABLE = `
  CREATE TABLE IF NOT EXISTS memory_reflection_counters (
    bot_id TEXT PRIMARY KEY,
    turns INTEGER NOT NULL DEFAULT 0
  );
`;

function normFact(fact: string): string {
  return fact.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Read a tier column back: NULL or an unknown value falls back to the
 * write-time default for the memory source (`cloud-ok`) — fail open to the
 * conversational default, never to `local-only` (which would silently hide
 * data) and never past it.
 */
function readTier(v: unknown): PrivacyTier {
  return isPrivacyTier(v) ? v : resolveTier('memory');
}

function normEntity(entity: string): string {
  return entity.toLowerCase().trim();
}

/**
 * Heuristic category inference for keeper-extracted facts.
 * Preferences ("I like/prefer") and decisions ("decided/agreed") get their
 * own categories so recall can weight them; everything else is a fact.
 */
function inferCategory(factText: string): MemoryCategory {
  const t = factText.toLowerCase();
  if (/\b(i (?:like|love|prefer|hate|dislike|enjoy)|preferred name is)\b/.test(t)) return 'preference';
  if (/\b(decided|agreed|chosen|will use|going with)\b/.test(t)) return 'decision';
  return 'fact';
}

/**
 * Heuristic fact extractor (no LLM needed). Catches durable personal facts:
 * preferences ("I like/prefer/love/hate X"), identity ("my X is Y", "call me X",
 * "I am a/an X"), and explicit memory requests ("remember that X").
 */
export function heuristicDistill(text: string): DistilledFact[] {
  const facts: DistilledFact[] = [];
  const seen = new Set<string>();
  const push = (fact: string, entities: string[], confidence: number) => {
    const key = normFact(fact);
    if (key.length < 8 || seen.has(key)) return;
    seen.add(key);
    facts.push({ fact: fact.trim(), entities, confidence });
  };

  // Split into sentences; keep it simple and dependency-free.
  const sentences = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);

  const prefRe = /\b(i (?:like|love|prefer|hate|dislike|enjoy))\b\s+(.+)/i;
  const myIsRe = /\bmy ([\w ]{1,40}?) (?:is|are)\b\s+(.+)/i;
  const callMeRe = /\bcall me ([\w-]{1,40})/i;
  const iAmRe = /\bi am (?:a |an )?([\w ]{1,60})/i;
  const rememberRe = /\bremember that\b\s+(.+)/i;

  for (const s of sentences) {
    if (s.length > 400) continue; // skip walls of text
    let m: RegExpMatchArray | null;
    if ((m = s.match(prefRe))) {
      push(`${capitalize(m[1])} ${m[2]}.`, extractEntities(m[2]), 0.8);
    } else if ((m = s.match(rememberRe))) {
      push(`Remember: ${m[1]}.`, extractEntities(m[1]), 0.9);
    } else if ((m = s.match(callMeRe))) {
      push(`The user's preferred name is "${m[1]}".`, [m[1]], 0.95);
    } else if ((m = s.match(myIsRe))) {
      push(`The user's ${m[1].trim()} is ${m[2]}.`, extractEntities(m[1] + ' ' + m[2]), 0.75);
    } else if ((m = s.match(iAmRe))) {
      push(`The user is ${m[1].trim()}.`, extractEntities(m[1]), 0.7);
    }
  }
  return facts;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Crude entity extraction: capitalized words/phrases (proper nouns). */
function extractEntities(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/g)) {
    const e = m[1].trim();
    if (e.length > 1 && !/^(I|My|The|This|That)$/.test(e)) out.add(e);
  }
  return [...out].slice(0, 6);
}

export interface TieredMemoryOptions {
  /** Injected LLM distiller; heuristic fallback when absent. */
  distiller?: LlmDistiller;
  /**
   * Embedder for the vector leg of hybrid recall. Defaults to the
   * zero-dependency TrigramEmbedder (deterministic, offline).
   */
  embedder?: SyncEmbedder;
}

/** One hybrid-recall hit: the atom plus how it was retrieved. */
export interface HybridRecallHit {
  atom: AtomCard;
  /** RRF fused score (higher = better). */
  score: number;
  /** Which retrieval legs returned this atom. */
  sources: Array<'vector' | 'lexical'>;
}

export class TieredMemoryStore {
  private readonly db: DatabaseSyncType;
  private readonly distiller?: LlmDistiller;
  private readonly embedder: SyncEmbedder;

  constructor(dataDir: string, opts: TieredMemoryOptions = {}) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, 'tiered-memory.db'));
    this.db.exec(ATOM_TABLE);
    this.db.exec(ENTITY_TABLE);
    this.db.exec(EVENT_TABLE);
    this.db.exec(ATOM_FTS_TABLE);
    this.db.exec(LINK_TABLE);
    this.db.exec(CONFLICT_TABLE);
    this.db.exec(REFLECTION_COUNTER_TABLE);
    // Vector leg of hybrid recall: hash embedding per atom. Column added
    // idempotently so databases created before this feature keep working.
    const cols = this.db.prepare('PRAGMA table_info(memory_atoms)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'embedding')) {
      this.db.exec('ALTER TABLE memory_atoms ADD COLUMN embedding TEXT');
    }
    // Privacy tiers (write-time tags). Columns added idempotently so
    // pre-existing databases keep working; NULL reads back as the
    // write-time default for the source (cloud-ok for memory).
    const atomCols = this.db.prepare('PRAGMA table_info(memory_atoms)').all() as Array<{ name: string }>;
    if (!atomCols.some((c) => c.name === 'tier')) {
      this.db.exec('ALTER TABLE memory_atoms ADD COLUMN tier TEXT');
    }
    // Engram parity: pinned flag + category. Idempotent for existing DBs.
    if (!atomCols.some((c) => c.name === 'pinned')) {
      this.db.exec('ALTER TABLE memory_atoms ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
    }
    if (!atomCols.some((c) => c.name === 'category')) {
      this.db.exec("ALTER TABLE memory_atoms ADD COLUMN category TEXT NOT NULL DEFAULT 'fact'");
    }
    // Memory fabric: active flag for superseded memories (kept, not recalled).
    if (!atomCols.some((c) => c.name === 'active')) {
      this.db.exec('ALTER TABLE memory_atoms ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
    }
    const eventCols = this.db.prepare('PRAGMA table_info(memory_events)').all() as Array<{ name: string }>;
    if (!eventCols.some((c) => c.name === 'tier')) {
      this.db.exec('ALTER TABLE memory_events ADD COLUMN tier TEXT');
    }
    this.distiller = opts.distiller;
    this.embedder = opts.embedder ?? new TrigramEmbedder();
  }

  // ---- L0: raw events -----------------------------------------------------

  recordEvent(botId: string, sessionId: string, role: 'user' | 'assistant', text: string, toolCalls: string[] = [], tier?: PrivacyTier): MemoryEvent {
    const ev: MemoryEvent = {
      id: randomUUID(),
      ts: Date.now(),
      botId,
      sessionId,
      role,
      text: text.slice(0, 8000),
      toolCalls,
      tier: resolveTier('memory', tier),
    };
    this.db
      .prepare('INSERT INTO memory_events (id, ts, bot_id, session_id, role, text, tool_calls_json, tier) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(ev.id, ev.ts, ev.botId, ev.sessionId, ev.role, ev.text, JSON.stringify(ev.toolCalls), ev.tier);
    return ev;
  }

  // ---- Turn ingestion (async, non-blocking) --------------------------------

  /**
   * Per-bot LLM distillers for the keeper. When set for a bot, the keeper
   * uses the bot's own model for extraction instead of the heuristic.
   * Unset bots fall back to the store-wide distiller, then the heuristic.
   */
  private readonly botDistillers = new Map<string, LlmDistiller>();

  /** Register (or clear with undefined) a per-bot LLM distiller. */
  setBotDistiller(botId: string, distiller: LlmDistiller | undefined): void {
    if (distiller) this.botDistillers.set(botId, distiller);
    else this.botDistillers.delete(botId);
  }

  /**
   * Record a completed turn's L0 events and kick off L2 distillation in the
   * background. Never throws into the caller; never blocks the turn.
   *
   * The keeper is cheap by design: turns with trivial user text (< 20 chars
   * or no alphanumeric content) skip distillation entirely.
   */
  ingestTurn(botId: string, sessionId: string, userText: string, assistantText: string, toolCalls: string[] = [], tier?: PrivacyTier): void {
    try {
      this.recordEvent(botId, sessionId, 'user', userText, [], tier);
      this.recordEvent(botId, sessionId, 'assistant', assistantText, toolCalls, tier);
    } catch {
      return; // memory must never break chat
    }
    // Skip trivial exchanges — the keeper only runs on substantive turns.
    const substantive = userText.replace(/[^a-zA-Z0-9]/g, '').length >= 20;
    if (!substantive) return;
    // Fire-and-forget distillation.
    const turnText = `User: ${userText}\nAssistant: ${assistantText}`;
    void this.distillAndStore(botId, sessionId, turnText).catch(() => undefined);
  }

  private async distillAndStore(botId: string, sessionId: string, turnText: string): Promise<void> {
    let facts: DistilledFact[];
    try {
      const distiller = this.botDistillers.get(botId) ?? this.distiller;
      facts = distiller ? await distiller(turnText) : heuristicDistill(turnText);
    } catch {
      return;
    }
    for (const f of facts) {
      try {
        this.storeAtom(botId, f, sessionId, undefined, { category: f.category });
      } catch {
        // skip bad facts, keep going
      }
    }
  }

  // ---- L2: atoms ------------------------------------------------------------

  /**
   * Store one atom, deduped against existing atoms (normalized-text match).
   * Returns the atom id, or the existing id when deduped.
   */
  storeAtom(
    botId: string,
    fact: DistilledFact,
    sourceTurn: string,
    tier?: PrivacyTier,
    opts: { category?: MemoryCategory; pinned?: boolean } = {},
  ): string {
    const factText = fact.fact.trim().slice(0, 500);
    if (!factText) throw new Error('fact must be non-empty');
    const factNorm = normFact(factText);
    const existing = this.db
      .prepare('SELECT id FROM memory_atoms WHERE bot_id = ? AND fact_norm = ? LIMIT 1')
      .get(botId, factNorm) as { id: string } | undefined;
    if (existing) return existing.id;

    const id = randomUUID();
    const entities = [...new Set(fact.entities.map((e) => e.trim()).filter(Boolean))].slice(0, 10);
    const category = normalizeCategory(opts.category ?? inferCategory(factText));
    this.db
      .prepare(
        'INSERT INTO memory_atoms (id, bot_id, fact, fact_norm, entities_json, confidence, source_turn, created_at, tier, pinned, category) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        botId,
        factText,
        factNorm,
        JSON.stringify(entities),
        Math.min(1, Math.max(0, fact.confidence)),
        sourceTurn,
        Date.now(),
        resolveTier('memory', tier),
        opts.pinned ? 1 : 0,
        category,
      );
    this.indexAtomForSearch(botId, id, factText, entities);
    this.refreshEntityPages(botId, entities, id);
    return id;
  }

  /**
   * Save a session summary as a durable memory (category='summary').
   * Called when a session ends; the summary should be one paragraph.
   */
  saveSessionSummary(botId: string, sessionId: string, summary: string, tier?: PrivacyTier): string {
    const text = summary.trim().slice(0, 1000);
    if (!text) throw new Error('summary must be non-empty');
    return this.storeAtom(
      botId,
      { fact: text, entities: [], confidence: 0.9 },
      `session:${sessionId}`,
      tier,
      { category: 'summary' },
    );
  }

  /** Pin a memory: pinned atoms surface first in recall and are never auto-pruned. */
  pinAtom(botId: string, id: string): boolean {
    const res = this.db.prepare('UPDATE memory_atoms SET pinned = 1 WHERE bot_id = ? AND id = ?').run(botId, id);
    return res.changes > 0;
  }

  /** Unpin a memory. */
  unpinAtom(botId: string, id: string): boolean {
    const res = this.db.prepare('UPDATE memory_atoms SET pinned = 0 WHERE bot_id = ? AND id = ?').run(botId, id);
    return res.changes > 0;
  }

  /**
   * Full-text search over a bot's memories (FTS5/BM25 ranked).
   * Returns matching atoms ordered by relevance; pinned atoms sort first
   * on ties. Deleting via deleteAtom() removes the FTS row too (forget).
   */
  searchAtoms(botId: string, query: string, limit = 20): AtomCard[] {
    const q = query.trim();
    if (!q) return [];
    const match = buildFtsMatchQuery(q);
    if (!match) return [];
    let rows: Array<{ id: string }>;
    try {
      rows = this.db
        .prepare(
          `SELECT atom_id AS id FROM memory_atoms_fts
           WHERE memory_atoms_fts MATCH ? AND bot_id = ?
           ORDER BY bm25(memory_atoms_fts) LIMIT ?`,
        )
        .all(match, botId, Math.min(Math.max(limit, 1), 100)) as Array<{ id: string }>;
    } catch {
      return [];
    }
    if (rows.length === 0) return [];
    const byId = new Map(this.getAtoms(botId, 5000).map((a) => [a.id, a]));
    const hits: AtomCard[] = [];
    for (const r of rows) {
      const atom = byId.get(r.id);
      if (atom) hits.push(atom);
    }
    // Pinned first, then FTS rank order (already BM25-sorted).
    hits.sort((a, b) => Number(b.pinned) - Number(a.pinned));
    return hits;
  }

  /**
   * Index one atom for hybrid search: hash embedding (vector leg) + FTS5
   * row (lexical/BM25 leg). Best-effort — search indexing must never break
   * atom storage.
   */
  private indexAtomForSearch(botId: string, id: string, fact: string, entities: string[]): void {
    try {
      const [vec] = this.embedder.embedSync([fact]);
      this.db.prepare('UPDATE memory_atoms SET embedding = ? WHERE id = ?').run(JSON.stringify(Array.from(vec)), id);
    } catch {
      // vector leg degrades gracefully when embedding fails
    }
    try {
      this.db
        .prepare('INSERT INTO memory_atoms_fts (atom_id, bot_id, fact, entities) VALUES (?, ?, ?, ?)')
        .run(id, botId, fact, entities.join(' '));
    } catch {
      // lexical leg degrades gracefully
    }
  }

  /**
   * Backfill embeddings for atoms stored before hybrid search existed (or
   * whose embedding failed at write time). Called at the start of
   * recallHybrid; the sync hash embedder makes this cheap.
   */
  private ensureEmbeddings(botId: string): void {
    const missing = this.db
      .prepare('SELECT id, fact FROM memory_atoms WHERE bot_id = ? AND embedding IS NULL LIMIT 500')
      .all(botId) as Array<{ id: string; fact: string }>;
    if (missing.length === 0) return;
    const upd = this.db.prepare('UPDATE memory_atoms SET embedding = ? WHERE id = ?');
    for (const m of missing) {
      try {
        const [vec] = this.embedder.embedSync([m.fact]);
        upd.run(JSON.stringify(Array.from(vec)), m.id);
      } catch {
        // leave un-embedded; vector leg simply skips it
      }
    }
  }

  /**
   * List a bot's atoms. Inactive (superseded) atoms are excluded unless
   * includeInactive is set — recall and search must never see them.
   */
  getAtoms(botId: string, limit = 200, opts: { includeInactive?: boolean } = {}): AtomCard[] {
    const where = opts.includeInactive ? 'bot_id = ?' : 'bot_id = ? AND active = 1';
    const rows = this.db
      .prepare(`SELECT * FROM memory_atoms WHERE ${where} ORDER BY pinned DESC, created_at DESC LIMIT ?`)
      .all(botId, limit) as Array<{
        id: string; bot_id: string; fact: string; entities_json: string;
        confidence: number; source_turn: string; created_at: number; tier: string | null;
        pinned: number | null; category: string | null; active: number | null;
      }>;
    return rows.map((r) => ({
      id: r.id,
      botId: r.bot_id,
      fact: r.fact,
      entities: JSON.parse(r.entities_json) as string[],
      confidence: r.confidence,
      sourceTurn: r.source_turn,
      createdAt: r.created_at,
      tier: readTier(r.tier),
      pinned: (r.pinned ?? 0) === 1,
      category: normalizeCategory(r.category),
      active: (r.active ?? 1) === 1,
    }));
  }

  /** Fetch one atom by id (includes inactive ones; returns undefined when unknown). */
  getAtom(botId: string, id: string): AtomCard | undefined {
    const rows = this.getAtoms(botId, 20000, { includeInactive: true });
    return rows.find((a) => a.id === id);
  }

  deleteAtom(botId: string, id: string): boolean {
    const res = this.db.prepare('DELETE FROM memory_atoms WHERE bot_id = ? AND id = ?').run(botId, id);
    try {
      this.db.prepare('DELETE FROM memory_atoms_fts WHERE atom_id = ?').run(id);
    } catch {
      // FTS cleanup is best-effort
    }
    // Links referencing a forgotten atom are meaningless; drop them.
    // Conflicts are kept as an audit trail of what was decided.
    try {
      this.db.prepare('DELETE FROM memory_links WHERE bot_id = ? AND (from_atom_id = ? OR to_atom_id = ?)').run(botId, id, id);
    } catch {
      // link cleanup is best-effort
    }
    return res.changes > 0;
  }

  // ---- L3: entity pages -------------------------------------------------------

  private refreshEntityPages(botId: string, entities: string[], _newAtomId: string): void {
    for (const entity of entities) {
      const eNorm = normEntity(entity);
      if (!eNorm) continue;
      const atoms = this.db
        .prepare(
          `SELECT id, fact, confidence, entities_json FROM memory_atoms WHERE bot_id = ?
           ORDER BY created_at DESC LIMIT 200`,
        )
        .all(botId) as Array<{ id: string; fact: string; confidence: number; entities_json: string }>;
      const matching = atoms
        .filter((a) => {
          try {
            const ents = JSON.parse(a.entities_json) as string[];
            return ents.some((e) => normEntity(e) === eNorm);
          } catch {
            return false;
          }
        })
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 20);
      const summary =
        matching.length === 0
          ? `No facts recorded about ${entity} yet.`
          : `Known about ${entity} (${matching.length} fact${matching.length === 1 ? '' : 's'}): ` +
            matching.map((a) => a.fact).join(' ');
      this.db
        .prepare(
          `INSERT INTO memory_entities (bot_id, entity, entity_norm, summary, atom_ids_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(bot_id, entity_norm) DO UPDATE SET
             summary = excluded.summary,
             atom_ids_json = excluded.atom_ids_json,
             updated_at = excluded.updated_at`,
        )
        .run(
          botId,
          entity,
          eNorm,
          summary.slice(0, 2000),
          JSON.stringify(matching.map((a) => a.id)),
          Date.now(),
        );
    }
  }

  getEntities(botId: string): EntityPage[] {
    const rows = this.db
      .prepare('SELECT * FROM memory_entities WHERE bot_id = ? ORDER BY updated_at DESC')
      .all(botId) as Array<{
        entity: string; bot_id: string; summary: string; atom_ids_json: string; updated_at: number;
      }>;
    return rows.map((r) => ({
      entity: r.entity,
      botId: r.bot_id,
      summary: r.summary,
      atomIds: JSON.parse(r.atom_ids_json) as string[],
      updatedAt: r.updated_at,
    }));
  }

  // ---- Recall -----------------------------------------------------------------

  /**
   * Retrieve atoms relevant to `query` (keyword match on entities + fact
   * text, ranked by overlap then confidence) and render a compact
   * "What I remember" block capped at ~500 tokens (~2000 chars).
   *
   * Privacy: atoms above `maxTier` are excluded BEFORE ranking. The
   * default (`cloud-ok`) keeps `local-only` atoms out of cloud prompts —
   * this is the memory leg of the privacy-tier enforcement.
   */
  recallForPrompt(botId: string, query: string, maxChars = 2000, opts: { maxTier?: PrivacyTier } = {}): string {
    const maxTier = opts.maxTier ?? 'cloud-ok';
    const atoms = this.getAtoms(botId, 500).filter((a) => tierAtMost(a.tier, maxTier));
    if (atoms.length === 0) return '';
    const qTokens = new Set(normFact(query).split(' ').filter((t) => t.length > 2));
    if (qTokens.size === 0) return '';

    // Pinned memories always lead: they are the user's explicit "don't forget".
    const pinned = atoms.filter((a) => a.pinned);
    const rest = atoms.filter((a) => !a.pinned);

    const scored = rest
      .map((a) => {
        const hay = normFact(a.fact + ' ' + a.entities.join(' '));
        let overlap = 0;
        for (const t of qTokens) if (hay.includes(t)) overlap++;
        return { atom: a, overlap };
      })
      .filter((s) => s.overlap > 0)
      .sort((x, y) => y.overlap - x.overlap || y.atom.confidence - x.atom.confidence)
      .slice(0, 12);

    const ordered = [...pinned, ...scored.map((s) => s.atom)];
    if (ordered.length === 0) return '';
    let block = '# What I remember (from past conversations)\n';
    for (const atom of ordered) {
      const line = `- ${atom.fact}\n`;
      if (block.length + line.length > maxChars) break;
      block += line;
    }
    return block;
  }

  /**
   * Hybrid recall: vector (hash-embedding cosine) + lexical (FTS5/BM25)
   * legs fused with Reciprocal Rank Fusion (k=60). Returns the topK atoms
   * with fused scores and the legs that retrieved each atom.
   *
   * Additive path — recallForPrompt() keeps its original keyword-overlap
   * behavior. Prefer this when you want the best recall.
   */
  recallHybrid(botId: string, query: string, topK = 5, maxTier: PrivacyTier = 'cloud-ok'): HybridRecallHit[] {
    const q = query.trim();
    if (!q) return [];
    const k = Math.min(Math.max(topK, 1), 50);
    const depth = Math.min(k * 4, 100);

    // --- vector leg: brute-force cosine over stored hash embeddings ------
    let vectorRanked: string[] = [];
    try {
      this.ensureEmbeddings(botId);
      const [qv] = this.embedder.embedSync([q]);
      const rows = this.db
        .prepare('SELECT id, embedding FROM memory_atoms WHERE bot_id = ?')
        .all(botId) as Array<{ id: string; embedding: string | null }>;
      vectorRanked = rows
        .map((r) => {
          let vec: number[] = [];
          try {
            vec = r.embedding ? (JSON.parse(r.embedding) as number[]) : [];
          } catch {
            vec = [];
          }
          return { id: r.id, s: cosineSimilarity(qv, vec) };
        })
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, depth)
        .map((x) => x.id);
    } catch {
      // vector leg is best-effort
    }

    // --- lexical leg: FTS5 BM25 -------------------------------------------
    let lexicalRanked: string[] = [];
    const match = buildFtsMatchQuery(q);
    if (match) {
      try {
        const rows = this.db
          .prepare(
            `SELECT atom_id AS id FROM memory_atoms_fts
             WHERE memory_atoms_fts MATCH ? AND bot_id = ?
             ORDER BY bm25(memory_atoms_fts) LIMIT ?`,
          )
          .all(match, botId, depth) as Array<{ id: string }>;
        lexicalRanked = rows.map((r) => r.id);
      } catch {
        // lexical leg is best-effort
      }
    }

    // --- RRF fusion ---------------------------------------------------------
    const fused = reciprocalRankFuse([vectorRanked, lexicalRanked], 60).slice(0, k);
    if (fused.length === 0) return [];
    const vecSet = new Set(vectorRanked);
    const lexSet = new Set(lexicalRanked);
    const byId = new Map(this.getAtoms(botId, 2000).map((a) => [a.id, a]));
    const hits: HybridRecallHit[] = [];
    for (const f of fused) {
      const atom = byId.get(f.id);
      // Privacy: drop atoms above maxTier before they can reach a prompt.
      if (!atom || !tierAtMost(atom.tier, maxTier)) continue;
      const sources: Array<'vector' | 'lexical'> = [];
      if (vecSet.has(f.id)) sources.push('vector');
      if (lexSet.has(f.id)) sources.push('lexical');
      hits.push({ atom, score: Math.round(f.score * 1e6) / 1e6, sources });
    }
    return hits;
  }

  /**
   * Render hybrid recall as a "What I remember" prompt block, same shape as
   * recallForPrompt() but ranked by the hybrid (vector + BM25 + RRF) path.
   *
   * Relevance gate: hash embeddings rank *something* for every query, so a
   * hit is only injected into the prompt when the lexical leg matched it or
   * it beat the single-leg RRF floor (1/61) via multi-leg agreement —
   * otherwise gibberish queries would inject irrelevant atoms. Callers that
   * want unfiltered recall should use recallHybrid() directly.
   */
  recallForPromptHybrid(botId: string, query: string, maxChars = 2000, maxTier: PrivacyTier = 'cloud-ok'): string {
    const RRF_FLOOR = 1 / 61 + 1e-9;
    const hits = this.recallHybrid(botId, query, 12, maxTier).filter(
      (h) => h.sources.includes('lexical') || h.score > RRF_FLOOR,
    );
    if (hits.length === 0) return '';
    let block = '# What I remember (from past conversations)\n';
    for (const { atom } of hits) {
      const line = `- ${atom.fact}\n`;
      if (block.length + line.length > maxChars) break;
      block += line;
    }
    return block;
  }

  // ---- Memory fabric (Atomic parity): links, conflicts, reflection --------

  private static readonly LINK_KINDS: ReadonlySet<string> = new Set(['relates', 'contradicts', 'supersedes']);

  private static normalizeLinkKind(kind: unknown): MemoryLinkKind {
    if (typeof kind === 'string' && TieredMemoryStore.LINK_KINDS.has(kind)) return kind as MemoryLinkKind;
    throw new Error(`Invalid link kind "${String(kind)}": must be relates | contradicts | supersedes`);
  }

  private static rowToLink(r: {
    id: string; bot_id: string; from_atom_id: string; to_atom_id: string;
    kind: string; created_at: number; created_by: string;
  }): MemoryLink {
    return {
      id: r.id,
      botId: r.bot_id,
      fromAtomId: r.from_atom_id,
      toAtomId: r.to_atom_id,
      kind: r.kind as MemoryLinkKind,
      createdAt: r.created_at,
      createdBy: r.created_by,
    };
  }

  private static rowToConflict(r: {
    id: string; bot_id: string; atom_a_id: string; atom_b_id: string;
    status: string; votes_json: string; winner_id: string | null;
    created_at: number; resolved_at: number | null;
  }): MemoryConflict {
    let votes: ConflictVote[] = [];
    try {
      const parsed = JSON.parse(r.votes_json) as unknown;
      if (Array.isArray(parsed)) votes = parsed as ConflictVote[];
    } catch {
      votes = [];
    }
    return {
      id: r.id,
      botId: r.bot_id,
      atomAId: r.atom_a_id,
      atomBId: r.atom_b_id,
      status: r.status === 'resolved' ? 'resolved' : 'open',
      votes,
      winnerId: r.winner_id,
      createdAt: r.created_at,
      resolvedAt: r.resolved_at,
    };
  }

  /**
   * Create a typed link between two of the bot's atoms.
   * - 'contradicts' also opens a conflict (deduped) so the contradiction
   *   can be voted on and resolved.
   * - 'supersedes' marks the target atom inactive immediately (the source
   *   replaces it); the old atom is kept for the audit trail.
   * Returns the link id (existing id when deduped).
   */
  createLink(botId: string, fromAtomId: string, toAtomId: string, kind: MemoryLinkKind, createdBy = 'user'): string {
    const k = TieredMemoryStore.normalizeLinkKind(kind);
    if (fromAtomId === toAtomId) throw new Error('Cannot link an atom to itself');
    const from = this.getAtom(botId, fromAtomId);
    const to = this.getAtom(botId, toAtomId);
    if (!from) throw new Error(`Unknown atom "${fromAtomId}"`);
    if (!to) throw new Error(`Unknown atom "${toAtomId}"`);
    const existing = this.db
      .prepare('SELECT id FROM memory_links WHERE bot_id = ? AND from_atom_id = ? AND to_atom_id = ? AND kind = ?')
      .get(botId, fromAtomId, toAtomId, k) as { id: string } | undefined;
    if (existing) return existing.id;
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO memory_links (id, bot_id, from_atom_id, to_atom_id, kind, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, botId, fromAtomId, toAtomId, k, Date.now(), createdBy);
    if (k === 'contradicts') {
      this.openConflict(botId, fromAtomId, toAtomId, createdBy);
    } else if (k === 'supersedes') {
      this.db.prepare('UPDATE memory_atoms SET active = 0 WHERE bot_id = ? AND id = ?').run(botId, toAtomId);
    }
    return id;
  }

  /** All links touching an atom (either direction), newest first. */
  getLinksForAtom(botId: string, atomId: string): MemoryLink[] {
    const rows = this.db
      .prepare('SELECT * FROM memory_links WHERE bot_id = ? AND (from_atom_id = ? OR to_atom_id = ?) ORDER BY created_at DESC')
      .all(botId, atomId, atomId) as Array<{
        id: string; bot_id: string; from_atom_id: string; to_atom_id: string;
        kind: string; created_at: number; created_by: string;
      }>;
    return rows.map(TieredMemoryStore.rowToLink);
  }

  /** All of a bot's links, newest first (bounded). */
  getLinks(botId: string, limit = 500): MemoryLink[] {
    const rows = this.db
      .prepare('SELECT * FROM memory_links WHERE bot_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(botId, limit) as Array<{
        id: string; bot_id: string; from_atom_id: string; to_atom_id: string;
        kind: string; created_at: number; created_by: string;
      }>;
    return rows.map(TieredMemoryStore.rowToLink);
  }

  /** Delete a link. 'contradicts' links do NOT close their conflict (history is kept). */
  deleteLink(botId: string, id: string): boolean {
    const res = this.db.prepare('DELETE FROM memory_links WHERE bot_id = ? AND id = ?').run(botId, id);
    return res.changes > 0;
  }

  /**
   * Open a contradiction conflict between two atoms. Deduped: an existing
   * open conflict for the same pair (either order) returns its id.
   */
  openConflict(botId: string, atomAId: string, atomBId: string, createdBy = 'user'): string {
    if (atomAId === atomBId) throw new Error('A conflict needs two different atoms');
    const a = this.getAtom(botId, atomAId);
    const b = this.getAtom(botId, atomBId);
    if (!a) throw new Error(`Unknown atom "${atomAId}"`);
    if (!b) throw new Error(`Unknown atom "${atomBId}"`);
    const existing = this.db
      .prepare(
        `SELECT id FROM memory_conflicts WHERE bot_id = ? AND status = 'open'
         AND ((atom_a_id = ? AND atom_b_id = ?) OR (atom_a_id = ? AND atom_b_id = ?))`,
      )
      .get(botId, atomAId, atomBId, atomBId, atomAId) as { id: string } | undefined;
    if (existing) return existing.id;
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO memory_conflicts (id, bot_id, atom_a_id, atom_b_id, status, votes_json, winner_id, created_at, resolved_at)
         VALUES (?, ?, ?, ?, 'open', '[]', NULL, ?, NULL)`,
      )
      .run(id, botId, atomAId, atomBId, Date.now());
    return id;
  }

  /** List conflicts, open by default; pass 'all' or 'resolved' for the rest. */
  listConflicts(botId: string, status: 'open' | 'resolved' | 'all' = 'open'): MemoryConflict[] {
    const where = status === 'all' ? 'bot_id = ?' : 'bot_id = ? AND status = ?';
    const args = status === 'all' ? [botId] : [botId, status];
    const rows = this.db
      .prepare(`SELECT * FROM memory_conflicts WHERE ${where} ORDER BY created_at DESC`)
      .all(...args) as Array<{
        id: string; bot_id: string; atom_a_id: string; atom_b_id: string;
        status: string; votes_json: string; winner_id: string | null;
        created_at: number; resolved_at: number | null;
      }>;
    return rows.map(TieredMemoryStore.rowToConflict);
  }

  /** Record a vote for one side of an open conflict (non-binding; see resolveConflict). */
  voteConflict(botId: string, conflictId: string, winnerId: string, by = 'user'): MemoryConflict {
    const conflict = this.getConflict(botId, conflictId);
    if (!conflict) throw new Error(`Unknown conflict "${conflictId}"`);
    if (conflict.status !== 'open') throw new Error('Conflict is already resolved');
    if (winnerId !== conflict.atomAId && winnerId !== conflict.atomBId) {
      throw new Error('winnerId must be one of the two conflicting atoms');
    }
    const votes: ConflictVote[] = [...conflict.votes, { by, winnerId, ts: Date.now() }];
    this.db
      .prepare('UPDATE memory_conflicts SET votes_json = ? WHERE bot_id = ? AND id = ?')
      .run(JSON.stringify(votes), botId, conflictId);
    return { ...conflict, votes };
  }

  /**
   * Resolve an open conflict: the winner stays active, the loser is marked
   * inactive (kept for the audit trail) and a 'supersedes' link is recorded
   * winner → loser. Inactive atoms are excluded from recall and search.
   */
  resolveConflict(botId: string, conflictId: string, winnerId: string): MemoryConflict {
    const conflict = this.getConflict(botId, conflictId);
    if (!conflict) throw new Error(`Unknown conflict "${conflictId}"`);
    if (conflict.status !== 'open') throw new Error('Conflict is already resolved');
    if (winnerId !== conflict.atomAId && winnerId !== conflict.atomBId) {
      throw new Error('winnerId must be one of the two conflicting atoms');
    }
    const loserId = winnerId === conflict.atomAId ? conflict.atomBId : conflict.atomAId;
    this.db.prepare('UPDATE memory_atoms SET active = 0 WHERE bot_id = ? AND id = ?').run(botId, loserId);
    // Supersede link (dedupe-safe): the winner replaces the loser.
    try {
      this.createLink(botId, winnerId, loserId, 'supersedes', 'system');
    } catch {
      // link dedupe or atom issues must not block resolution
    }
    const now = Date.now();
    this.db
      .prepare("UPDATE memory_conflicts SET status = 'resolved', winner_id = ?, resolved_at = ? WHERE bot_id = ? AND id = ?")
      .run(winnerId, now, botId, conflictId);
    return { ...conflict, status: 'resolved', winnerId, resolvedAt: now };
  }

  private getConflict(botId: string, conflictId: string): MemoryConflict | undefined {
    const row = this.db
      .prepare('SELECT * FROM memory_conflicts WHERE bot_id = ? AND id = ?')
      .get(botId, conflictId) as {
        id: string; bot_id: string; atom_a_id: string; atom_b_id: string;
        status: string; votes_json: string; winner_id: string | null;
        created_at: number; resolved_at: number | null;
      } | undefined;
    return row ? TieredMemoryStore.rowToConflict(row) : undefined;
  }

  // ---- Reflection -----------------------------------------------------------

  /** Turns per reflection pass (memoryReflection bots). */
  static readonly REFLECTION_EVERY_TURNS = 50;

  /**
   * Increment the bot's turn counter; returns true when a reflection pass
   * is due (every REFLECTION_EVERY_TURNS turns) and resets the counter.
   * Call after ingestTurn for bots with memoryReflection enabled.
   */
  noteTurnForReflection(botId: string): boolean {
    this.db
      .prepare(
        `INSERT INTO memory_reflection_counters (bot_id, turns) VALUES (?, 1)
         ON CONFLICT(bot_id) DO UPDATE SET turns = turns + 1`,
      )
      .run(botId);
    const row = this.db
      .prepare('SELECT turns FROM memory_reflection_counters WHERE bot_id = ?')
      .get(botId) as { turns: number };
    if (row.turns >= TieredMemoryStore.REFLECTION_EVERY_TURNS) {
      this.db.prepare('UPDATE memory_reflection_counters SET turns = 0 WHERE bot_id = ?').run(botId);
      return true;
    }
    return false;
  }

  /**
   * One reflection pass (Atomic parity): the model reviews the bot's
   * recent active memories, proposes new lessons/procedures, flags
   * contradictions (opened as conflicts, with a 'reflection' vote), and
   * writes a reflection summary atom. Low-priority by design: callers
   * should fire-and-forget it; it never throws into the caller.
   */
  async runReflectionPass(botId: string, chat: KeeperChatFn, opts: { maxAtoms?: number } = {}): Promise<ReflectionResult> {
    const maxAtoms = Math.min(Math.max(opts.maxAtoms ?? 60, 1), 200);
    try {
      const atoms = this.getAtoms(botId, maxAtoms);
      if (atoms.length < 3) {
        return { ok: true, skipped: true, reason: 'not enough memories yet', lessonsCreated: 0, proceduresCreated: 0, conflictsOpened: 0, reflectionAtomId: null };
      }
      const numbered = atoms.map((a, i) => `[${i}] (${a.category}) ${a.fact}`).join('\n');
      const userText =
        `Here are this bot's current memories (numbered):\n${numbered}\n\n` +
        'Review them and respond with ONLY a JSON object:\n' +
        '{ "lessons": [{"fact": "...", "entities": [], "confidence": 0-1}],\n' +
        '  "procedures": [{"name": "...", "steps": ["...", "..."], "entities": [], "confidence": 0-1}],\n' +
        '  "contradictions": [{"a": <number>, "b": <number>, "note": "..."}],\n' +
        '  "reflection": "one paragraph: what is working, what is stale, what should change" }\n' +
        'Rules: propose at most 5 lessons and 3 procedures, only for genuinely new durable knowledge. ' +
        'Flag a contradiction only when two memories genuinely disagree. ' +
        'If there is nothing new, return {"lessons": [], "procedures": [], "contradictions": [], "reflection": "..."}.';
      let raw: string;
      try {
        raw = await chat(REFLECTION_SYSTEM_PROMPT, userText);
      } catch {
        return { ok: false, skipped: true, reason: 'reflection model call failed', lessonsCreated: 0, proceduresCreated: 0, conflictsOpened: 0, reflectionAtomId: null };
      }
      const parsed = parseReflectionJson(raw);
      if (!parsed) {
        return { ok: false, skipped: true, reason: 'reflection returned invalid JSON', lessonsCreated: 0, proceduresCreated: 0, conflictsOpened: 0, reflectionAtomId: null };
      }
      let lessonsCreated = 0;
      let proceduresCreated = 0;
      let conflictsOpened = 0;
      for (const item of parsed.lessons.slice(0, 5)) {
        if (typeof item.fact !== 'string' || !item.fact.trim()) continue;
        try {
          this.storeAtom(
            botId,
            {
              fact: item.fact.trim().slice(0, 500),
              entities: Array.isArray(item.entities) ? item.entities.filter((e): e is string => typeof e === 'string') : [],
              confidence: typeof item.confidence === 'number' ? item.confidence : 0.7,
              category: 'lesson',
            },
            `reflection:${Date.now()}`,
            undefined,
            { category: 'lesson' },
          );
          lessonsCreated++;
        } catch {
          // keep going
        }
      }
      for (const proc of parsed.procedures.slice(0, 3)) {
        if (typeof proc.name !== 'string' || !proc.name.trim()) continue;
        const steps = Array.isArray(proc.steps) ? proc.steps.filter((s): s is string => typeof s === 'string') : [];
        const fact = `Procedure: ${proc.name.trim()}\n` + steps.map((s, i) => `${i + 1}. ${s.trim()}`).join('\n');
        try {
          this.storeAtom(
            botId,
            {
              fact: fact.slice(0, 1000),
              entities: Array.isArray(proc.entities) ? proc.entities.filter((e): e is string => typeof e === 'string') : [],
              confidence: typeof proc.confidence === 'number' ? proc.confidence : 0.7,
              category: 'procedure',
            },
            `reflection:${Date.now()}`,
            undefined,
            { category: 'procedure' },
          );
          proceduresCreated++;
        } catch {
          // keep going
        }
      }
      for (const c of parsed.contradictions.slice(0, 10)) {
        const aIdx = typeof c.a === 'number' ? c.a : -1;
        const bIdx = typeof c.b === 'number' ? c.b : -1;
        if (aIdx < 0 || bIdx < 0 || aIdx >= atoms.length || bIdx >= atoms.length || aIdx === bIdx) continue;
        try {
          const conflictId = this.openConflict(botId, atoms[aIdx].id, atoms[bIdx].id, 'reflection');
          // The reflection pass votes for the higher-confidence atom as a
          // starting position; the user has the final say via resolve.
          const winnerId = atoms[aIdx].confidence >= atoms[bIdx].confidence ? atoms[aIdx].id : atoms[bIdx].id;
          this.voteConflict(botId, conflictId, winnerId, 'reflection');
          conflictsOpened++;
        } catch {
          // keep going
        }
      }
      let reflectionAtomId: string | null = null;
      if (typeof parsed.reflection === 'string' && parsed.reflection.trim()) {
        try {
          reflectionAtomId = this.storeAtom(
            botId,
            { fact: parsed.reflection.trim().slice(0, 1000), entities: [], confidence: 0.8, category: 'reflection' },
            `reflection:${Date.now()}`,
            undefined,
            { category: 'reflection' },
          );
        } catch {
          reflectionAtomId = null;
        }
      }
      return { ok: true, skipped: false, lessonsCreated, proceduresCreated, conflictsOpened, reflectionAtomId };
    } catch {
      return { ok: false, skipped: true, reason: 'reflection pass failed', lessonsCreated: 0, proceduresCreated: 0, conflictsOpened: 0, reflectionAtomId: null };
    }
  }
}

const REFLECTION_SYSTEM_PROMPT = `You review an AI assistant's long-term memories and extract higher-order knowledge.
You return ONLY valid JSON, no prose, no code fences. Be conservative: only propose
memories that are genuinely new and durable. Never invent facts that are not supported
by the listed memories.`;

/** Parse the reflection model's JSON; returns null on any failure. */
export function parseReflectionJson(raw: string): {
  lessons: Array<{ fact?: unknown; entities?: unknown; confidence?: unknown }>;
  procedures: Array<{ name?: unknown; steps?: unknown; entities?: unknown; confidence?: unknown }>;
  contradictions: Array<{ a?: unknown; b?: unknown; note?: unknown }>;
  reflection?: unknown;
} | null {
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    if (typeof parsed !== 'object' || parsed === null) return null;
    return {
      lessons: Array.isArray(parsed.lessons) ? parsed.lessons : [],
      procedures: Array.isArray(parsed.procedures) ? parsed.procedures : [],
      contradictions: Array.isArray(parsed.contradictions) ? parsed.contradictions : [],
      reflection: parsed.reflection,
    };
  } catch {
    return null;
  }
}
