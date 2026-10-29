// SPDX-License-Identifier: Apache-2.0
// Multiplayer layer (W7): people directory, bot ownership, team inbox,
// @mentions of people, per-person chiefs, and human relays.
//
// Design:
// - People are persisted in SQLite (<dataDir>/people.db), aligned with
//   the tenancy package's model (own DB file, parameterized queries,
//   deny-by-default validation). The local user is auto-seeded as the
//   default person ("You", id DEFAULT_PERSON_ID) — single-user installs
//   behave exactly as before: unowned bots belong to the default user.
// - Ownership is routing metadata: a bot's approvals, questions
//   (ask_user_question widgets) and run results record the owner as the
//   addressee (governance ApprovalRecord.addresseePersonId, widget
//   addresseePersonId), and the team inbox aggregates per person.
// - Content that arrives FROM a person through a relay is external
//   content: it is defused and fenced with the peer-provenance machinery
//   (provenance.ts) before it enters a bot's chat, and it can never
//   satisfy an approval (relayed provenance — see governance).
//
// TRUST MODEL (honest): KriyaDot is local-first. A "person context"
// (x-person-id header / personId param) is a UI-level identity selector,
// not cryptographic authentication — anyone with local API access can
// present any person id. Person filtering keeps teammates' private
// chats and inbox items out of each other's views in normal use; it is
// not a security boundary against a local attacker. Hosted multi-tenant
// deployments get real auth from the tenancy layer.

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { openDb } from './sqlite.js';
import {
  defusePeerText,
  wrapPeerContent,
  type OnBehalfOfLedger,
  type ProvenanceNote,
} from './provenance.js';
import type { BotConfig } from './types.js';

// ---------------------------------------------------------------------------
// People directory
// ---------------------------------------------------------------------------

/** Stable id of the auto-seeded default person (the local user, "You"). */
export const DEFAULT_PERSON_ID = 'you';
export const DEFAULT_PERSON_NAME = 'You';

const AVATAR_COLORS = [
  '#7c6cf0', '#2f9e6e', '#d97706', '#2563eb', '#db2777',
  '#0891b2', '#65a30d', '#9333ea', '#dc2626', '#0d9488',
] as const;

/** Deterministic avatar color for a name (stable across restarts). */
export function avatarColorFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length]!;
}

/** How to reach a person outside KriyaDot. */
export interface PersonChannels {
  /** Email address for the email channel (also the person's contact email). */
  email?: string;
  /** Messaging handles per gateway/provider id, e.g. { telegram: '12345', slack: 'U0123' }. */
  handles: Record<string, string>;
}

export interface Person {
  id: string;
  name: string;
  pictureUrl?: string;
  avatarColor: string;
  email?: string;
  channels: PersonChannels;
  /** True for the auto-seeded local user. Exactly one person has this set. */
  isDefaultUser: boolean;
  /** The bot designated as this person's Chief of Staff (per-person chief). */
  chiefBotId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface PersonInput {
  name: string;
  pictureUrl?: string;
  avatarColor?: string;
  email?: string;
  channels?: { email?: string; handles?: Record<string, string> };
  chiefBotId?: string;
}

export type PersonPatch = Partial<Omit<PersonInput, 'chiefBotId'>> & {
  /** null clears the designation. */
  chiefBotId?: string | null;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_NAME = 120;
const MAX_HANDLE = 200;

function cleanStr(v: unknown, field: string, max: number): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new Error(`person "${field}" must be a string`);
  const t = v.trim();
  if (!t) return undefined;
  if (t.length > max) throw new Error(`person "${field}" must be at most ${max} chars`);
  return t;
}

function cleanEmail(v: unknown, field: string): string | undefined {
  const s = cleanStr(v, field, 320);
  if (s !== undefined && !EMAIL_RE.test(s)) throw new Error(`person "${field}" must be a valid email address`);
  return s;
}

function cleanChannels(raw: PersonInput['channels'], fallbackEmail?: string): PersonChannels {
  const handles: Record<string, string> = {};
  if (raw?.handles) {
    if (typeof raw.handles !== 'object' || Array.isArray(raw.handles)) {
      throw new Error('person "channels.handles" must be an object of provider → handle');
    }
    for (const [k, v] of Object.entries(raw.handles)) {
      const key = k.trim().toLowerCase();
      const val = cleanStr(v, `channels.handles.${k}`, MAX_HANDLE);
      if (key && val) handles[key] = val;
      if (Object.keys(handles).length > 16) throw new Error('person "channels.handles" supports at most 16 gateways');
    }
  }
  const email = cleanEmail(raw?.email, 'channels.email') ?? fallbackEmail;
  return { ...(email ? { email } : {}), handles };
}

export function newPersonId(): string {
  return `per_${Date.now().toString(36)}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

interface PersonRow {
  id: string;
  name: string;
  picture_url: string | null;
  avatar_color: string;
  email: string | null;
  channels_json: string;
  is_default_user: number;
  chief_bot_id: string | null;
  created_at: number;
  updated_at: number;
}

function rowToPerson(r: PersonRow): Person {
  let channels: PersonChannels = { handles: {} };
  try {
    const parsed = JSON.parse(r.channels_json) as PersonChannels;
    if (parsed && typeof parsed === 'object') {
      channels = {
        ...(typeof parsed.email === 'string' ? { email: parsed.email } : {}),
        handles:
          parsed.handles && typeof parsed.handles === 'object' && !Array.isArray(parsed.handles)
            ? { ...parsed.handles }
            : {},
      };
    }
  } catch {
    // Corrupt channels JSON degrades to "no channels", never a crash.
  }
  return {
    id: r.id,
    name: r.name,
    ...(r.picture_url ? { pictureUrl: r.picture_url } : {}),
    avatarColor: r.avatar_color,
    ...(r.email ? { email: r.email } : {}),
    channels,
    isDefaultUser: r.is_default_user === 1,
    ...(r.chief_bot_id ? { chiefBotId: r.chief_bot_id } : {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** SQLite-backed people directory: <dataDir>/people.db. */
export class PeopleStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { mkdirSync } = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join } = require('node:path') as typeof import('node:path');
    mkdirSync(dataDir, { recursive: true });
    this.db = openDb(join(dataDir, 'people.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS people (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        picture_url TEXT,
        avatar_color TEXT NOT NULL,
        email TEXT,
        channels_json TEXT NOT NULL DEFAULT '{"handles":{}}',
        is_default_user INTEGER NOT NULL DEFAULT 0,
        chief_bot_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_people_default ON people (is_default_user) WHERE is_default_user = 1;
    `);
    this.ensureDefaultUser();
  }

  /** The local user, auto-seeded on first open. Never returns undefined. */
  ensureDefaultUser(): Person {
    const existing = this.db
      .prepare('SELECT * FROM people WHERE is_default_user = 1')
      .get() as unknown as PersonRow | undefined;
    if (existing) return rowToPerson(existing);
    const now = Date.now();
    const person: Person = {
      id: DEFAULT_PERSON_ID,
      name: DEFAULT_PERSON_NAME,
      avatarColor: AVATAR_COLORS[0],
      channels: { handles: {} },
      isDefaultUser: true,
      createdAt: now,
      updatedAt: now,
    };
    this.insert(person);
    return person;
  }

  private insert(p: Person): void {
    this.db
      .prepare(
        `INSERT INTO people (id, name, picture_url, avatar_color, email, channels_json, is_default_user, chief_bot_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.id, p.name, p.pictureUrl ?? null, p.avatarColor, p.email ?? null,
        JSON.stringify(p.channels), p.isDefaultUser ? 1 : 0, p.chiefBotId ?? null,
        p.createdAt, p.updatedAt,
      );
  }

  listPeople(): Person[] {
    const rows = this.db
      .prepare('SELECT * FROM people ORDER BY is_default_user DESC, name COLLATE NOCASE ASC')
      .all() as unknown as PersonRow[];
    return rows.map(rowToPerson);
  }

  getPerson(id: string): Person | undefined {
    const row = this.db.prepare('SELECT * FROM people WHERE id = ?').get(id) as unknown as
      | PersonRow
      | undefined;
    return row ? rowToPerson(row) : undefined;
  }

  getDefaultUser(): Person {
    return this.ensureDefaultUser();
  }

  createPerson(input: PersonInput): Person {
    const name = cleanStr(input.name, 'name', MAX_NAME);
    if (!name) throw new Error('person "name" is required');
    const email = cleanEmail(input.email, 'email');
    const now = Date.now();
    const person: Person = {
      id: newPersonId(),
      name,
      ...(cleanStr(input.pictureUrl, 'pictureUrl', 2000)
        ? { pictureUrl: cleanStr(input.pictureUrl, 'pictureUrl', 2000) }
        : {}),
      avatarColor: cleanStr(input.avatarColor, 'avatarColor', 32) ?? avatarColorFor(name),
      ...(email ? { email } : {}),
      channels: cleanChannels(input.channels, email),
      isDefaultUser: false,
      ...(cleanStr(input.chiefBotId, 'chiefBotId', 64)
        ? { chiefBotId: cleanStr(input.chiefBotId, 'chiefBotId', 64) }
        : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.insert(person);
    return person;
  }

  updatePerson(id: string, patch: PersonPatch): Person | undefined {
    const cur = this.getPerson(id);
    if (!cur) return undefined;
    const next: Person = { ...cur, updatedAt: Date.now() };
    if (patch.name !== undefined) {
      const name = cleanStr(patch.name, 'name', MAX_NAME);
      if (!name) throw new Error('person "name" must be a non-empty string');
      next.name = name;
    }
    if (patch.pictureUrl !== undefined) {
      const v = cleanStr(patch.pictureUrl, 'pictureUrl', 2000);
      if (v) next.pictureUrl = v; else delete next.pictureUrl;
    }
    if (patch.avatarColor !== undefined) {
      next.avatarColor = cleanStr(patch.avatarColor, 'avatarColor', 32) ?? avatarColorFor(next.name);
    }
    if (patch.email !== undefined) {
      const v = cleanEmail(patch.email, 'email');
      if (v) next.email = v; else delete next.email;
    }
    if (patch.channels !== undefined) {
      next.channels = cleanChannels(patch.channels, next.email);
    } else if (patch.email !== undefined) {
      // Keep the email channel in sync with the contact email.
      next.channels = { ...next.channels, ...(next.email ? { email: next.email } : {}) };
      if (!next.email) delete next.channels.email;
    }
    if (patch.chiefBotId !== undefined) {
      if (patch.chiefBotId === null) delete next.chiefBotId;
      else {
        const v = cleanStr(patch.chiefBotId, 'chiefBotId', 64);
        if (v) next.chiefBotId = v; else delete next.chiefBotId;
      }
    }
    this.db
      .prepare(
        `UPDATE people SET name = ?, picture_url = ?, avatar_color = ?, email = ?,
           channels_json = ?, chief_bot_id = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.name, next.pictureUrl ?? null, next.avatarColor, next.email ?? null,
        JSON.stringify(next.channels), next.chiefBotId ?? null, next.updatedAt, id,
      );
    return next;
  }

  /** Designate (or clear, with null) a person's Chief bot. */
  setChief(personId: string, chiefBotId: string | null): Person | undefined {
    return this.updatePerson(personId, { chiefBotId });
  }

  /** The default user cannot be deleted. Returns false when unknown/protected. */
  deletePerson(id: string): boolean {
    const p = this.getPerson(id);
    if (!p || p.isDefaultUser) return false;
    const r = this.db.prepare('DELETE FROM people WHERE id = ?').run(id);
    return r.changes > 0;
  }

  /** Find by messaging handle on one gateway (case-insensitive, '@' optional). */
  findByHandle(provider: string, handle: string): Person | undefined {
    const needle = handle.trim().replace(/^@+/, '').toLowerCase();
    if (!needle) return undefined;
    const key = provider.trim().toLowerCase();
    return this.listPeople().find((p) => {
      const h = p.channels.handles[key];
      return h !== undefined && h.trim().replace(/^@+/, '').toLowerCase() === needle;
    });
  }

  findByEmail(email: string): Person | undefined {
    const needle = email.trim().toLowerCase();
    if (!needle) return undefined;
    return this.listPeople().find(
      (p) => p.email?.toLowerCase() === needle || p.channels.email?.toLowerCase() === needle,
    );
  }

  findByName(name: string): Person | undefined {
    const needle = name.trim().toLowerCase();
    if (!needle) return undefined;
    return this.listPeople().find((p) => p.name.trim().toLowerCase() === needle);
  }

  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

/** The person id a bot's work is addressed to (default user when unowned). */
export function botOwnerPersonId(bot: Pick<BotConfig, 'ownerId'>): string {
  return bot.ownerId && bot.ownerId.trim() ? bot.ownerId : DEFAULT_PERSON_ID;
}

/** One org-view column: a person and the bots they own. */
export interface OrgColumn {
  person: Person;
  bots: Array<Pick<BotConfig, 'id' | 'name' | 'ownerId'>>;
}

/**
 * Build the team org view: one column per person, their bots listed.
 * Bots with an unknown owner id fall back to the default user's column
 * (they behave as the default user's bots everywhere else too).
 */
export function buildOrgView(
  people: Person[],
  bots: Array<Pick<BotConfig, 'id' | 'name' | 'ownerId'>>,
): OrgColumn[] {
  const byId = new Map(people.map((p) => [p.id, p]));
  const columns = new Map<string, OrgColumn>();
  for (const p of people) columns.set(p.id, { person: p, bots: [] });
  for (const bot of bots) {
    const ownerId = botOwnerPersonId(bot);
    const col = columns.get(ownerId) ?? columns.get(DEFAULT_PERSON_ID);
    if (col) col.bots.push(bot);
    else if (byId.size === 0) {
      // No people at all (defensive): single implicit column.
    }
  }
  return [...columns.values()];
}

// ---------------------------------------------------------------------------
// @mentions of people
// ---------------------------------------------------------------------------

/**
 * Parse @mentions of PEOPLE from room text. Mirrors the bot mention rules
 * in group-room-turn.ts (full name, name without spaces, first word, id),
 * plus messaging handles. `@all`/`@everyone` never match a person — a
 * person mention notifies exactly that person, never the whole room.
 */
export function parsePersonMentions(text: string, people: Person[]): Person[] {
  const mentionRe = /@([A-Za-z0-9_.-]+)/g;
  const tokens = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = mentionRe.exec(text)) !== null) tokens.add(m[1].toLowerCase());
  tokens.delete('all');
  tokens.delete('everyone');
  if (tokens.size === 0) return [];
  const matched: Person[] = [];
  const seen = new Set<string>();
  for (const person of people) {
    const nameLower = person.name.toLowerCase();
    const noSpaces = nameLower.replace(/\s+/g, '');
    const firstWord = nameLower.split(/\s+/)[0] ?? '';
    const handles = Object.values(person.channels.handles).map((h) =>
      h.trim().replace(/^@+/, '').toLowerCase(),
    );
    for (const token of tokens) {
      if (
        token === nameLower ||
        token === noSpaces ||
        token === firstWord ||
        token === person.id.toLowerCase() ||
        handles.includes(token) ||
        (token.length >= 3 && (nameLower.startsWith(token) || noSpaces.startsWith(token)))
      ) {
        if (!seen.has(person.id)) {
          matched.push(person);
          seen.add(person.id);
        }
        break;
      }
    }
  }
  return matched;
}

/** The @token that mentions this person in a room (first name word or handle). */
export function mentionTokenFor(person: Person): string {
  const first = person.name.trim().split(/\s+/)[0]?.toLowerCase();
  return first && first.length > 0 ? first : person.id;
}

// ---------------------------------------------------------------------------
// Team inbox
// ---------------------------------------------------------------------------

export type TeamInboxKind = 'approval' | 'question' | 'relay' | 'mention' | 'fyi' | 'run-result';
export type TeamInboxState = 'needs-you' | 'fyi' | 'done';

export interface TeamInboxItem {
  id: string;
  personId: string;
  kind: TeamInboxKind;
  state: TeamInboxState;
  title: string;
  summary: string;
  botId?: string;
  sessionId?: string;
  /** External record this item points at (approval id, widget id, relay id…). */
  refId?: string;
  groupId?: string;
  replyText?: string;
  repliedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface NewTeamInboxItem {
  personId: string;
  kind: TeamInboxKind;
  state?: TeamInboxState;
  title: string;
  summary: string;
  botId?: string;
  sessionId?: string;
  refId?: string;
  groupId?: string;
}

interface InboxRow {
  id: string;
  person_id: string;
  kind: string;
  state: string;
  title: string;
  summary: string;
  bot_id: string | null;
  session_id: string | null;
  ref_id: string | null;
  group_id: string | null;
  reply_text: string | null;
  replied_at: number | null;
  created_at: number;
  updated_at: number;
}

function rowToItem(r: InboxRow): TeamInboxItem {
  return {
    id: r.id,
    personId: r.person_id,
    kind: r.kind as TeamInboxKind,
    state: r.state as TeamInboxState,
    title: r.title,
    summary: r.summary,
    ...(r.bot_id ? { botId: r.bot_id } : {}),
    ...(r.session_id ? { sessionId: r.session_id } : {}),
    ...(r.ref_id ? { refId: r.ref_id } : {}),
    ...(r.group_id ? { groupId: r.group_id } : {}),
    ...(r.reply_text ? { replyText: r.reply_text } : {}),
    ...(r.replied_at ? { repliedAt: r.replied_at } : {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function newInboxItemId(): string {
  return `inb_${Date.now().toString(36)}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

/**
 * Persisted team-inbox items: <dataDir>/team-inbox.db. Holds the items
 * that have no other store (mentions, relays, FYI notes, run results);
 * approvals and questions are aggregated live from their own stores by
 * aggregateTeamInbox() so their state can never drift.
 */
export class TeamInboxStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { mkdirSync } = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join } = require('node:path') as typeof import('node:path');
    mkdirSync(dataDir, { recursive: true });
    this.db = openDb(join(dataDir, 'team-inbox.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS inbox_items (
        id TEXT PRIMARY KEY,
        person_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        state TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        bot_id TEXT,
        session_id TEXT,
        ref_id TEXT,
        group_id TEXT,
        reply_text TEXT,
        replied_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_inbox_person ON inbox_items (person_id, state, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_ref ON inbox_items (kind, ref_id, person_id) WHERE ref_id IS NOT NULL;
    `);
  }

  /**
   * Add an item. When (kind, refId, personId) already exists the existing
   * item is returned unchanged (idempotent ingestion of approvals etc.).
   */
  addItem(input: NewTeamInboxItem): TeamInboxItem {
    if (input.refId) {
      const existing = this.db
        .prepare('SELECT * FROM inbox_items WHERE kind = ? AND ref_id = ? AND person_id = ?')
        .get(input.kind, input.refId, input.personId) as unknown as InboxRow | undefined;
      if (existing) return rowToItem(existing);
    }
    const now = Date.now();
    const item: TeamInboxItem = {
      id: newInboxItemId(),
      personId: input.personId,
      kind: input.kind,
      state: input.state ?? (input.kind === 'fyi' || input.kind === 'run-result' ? 'fyi' : 'needs-you'),
      title: input.title.slice(0, 300),
      summary: input.summary.slice(0, 4000),
      ...(input.botId ? { botId: input.botId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.refId ? { refId: input.refId } : {}),
      ...(input.groupId ? { groupId: input.groupId } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO inbox_items (id, person_id, kind, state, title, summary, bot_id, session_id, ref_id, group_id, reply_text, replied_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
      )
      .run(
        item.id, item.personId, item.kind, item.state, item.title, item.summary,
        item.botId ?? null, item.sessionId ?? null, item.refId ?? null, item.groupId ?? null,
        item.createdAt, item.updatedAt,
      );
    return item;
  }

  getItem(id: string): TeamInboxItem | undefined {
    const row = this.db.prepare('SELECT * FROM inbox_items WHERE id = ?').get(id) as unknown as
      | InboxRow
      | undefined;
    return row ? rowToItem(row) : undefined;
  }

  listItems(filter: { personId?: string; state?: TeamInboxState; kind?: TeamInboxKind } = {}): TeamInboxItem[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.personId) { clauses.push('person_id = ?'); params.push(filter.personId); }
    if (filter.state) { clauses.push('state = ?'); params.push(filter.state); }
    if (filter.kind) { clauses.push('kind = ?'); params.push(filter.kind); }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM inbox_items${where} ORDER BY created_at DESC`)
      .all(...params) as unknown as InboxRow[];
    return rows.map(rowToItem);
  }

  setState(id: string, state: TeamInboxState): TeamInboxItem | undefined {
    const r = this.db
      .prepare('UPDATE inbox_items SET state = ?, updated_at = ? WHERE id = ?')
      .run(state, Date.now(), id);
    return r.changes > 0 ? this.getItem(id) : undefined;
  }

  recordReply(id: string, text: string): TeamInboxItem | undefined {
    const now = Date.now();
    const r = this.db
      .prepare("UPDATE inbox_items SET reply_text = ?, replied_at = ?, state = 'done', updated_at = ? WHERE id = ?")
      .run(text.slice(0, 8000), now, now, id);
    return r.changes > 0 ? this.getItem(id) : undefined;
  }

  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Inbox aggregation (approvals + questions + stored items)
// ---------------------------------------------------------------------------

/** Structural view of a governance approval (avoids a governance dep). */
export interface ApprovalInboxSource {
  id: string;
  botId: string;
  toolName: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  ts: number;
  addresseePersonId?: string;
}

/** Structural view of an interactive widget record. */
export interface WidgetInboxSource {
  id: string;
  botId: string;
  status: 'pending' | 'answered' | 'expired';
  title?: string;
  payload?: { question?: string; title?: string };
  interactive: boolean;
  createdAt: number;
  addresseePersonId?: string;
}

export interface TeamInboxView {
  personId: string;
  needsYou: TeamInboxItem[];
  fyi: TeamInboxItem[];
  done: TeamInboxItem[];
  all: TeamInboxItem[];
}

/**
 * Aggregate one person's team inbox: persisted items (mentions, relays,
 * FYIs) + live approvals and pending/answered questions addressed to
 * them. An approval/question is addressed to its recorded addressee, or
 * — for pre-W7 records — to the current owner of its bot. Stored items
 * whose refId matches an approval/widget id suppress the synthesized
 * copy (the stored item carries richer context).
 */
export function aggregateTeamInbox(args: {
  personId: string;
  stored: TeamInboxItem[];
  approvals?: ApprovalInboxSource[];
  widgets?: WidgetInboxSource[];
  bots?: Array<Pick<BotConfig, 'id' | 'name' | 'ownerId'>>;
}): TeamInboxView {
  const botOwner = new Map<string, string>();
  if (args.bots) for (const b of args.bots) botOwner.set(b.id, botOwnerPersonId(b));
  const addresseeOf = (rec: { addresseePersonId?: string; botId: string }): string =>
    rec.addresseePersonId ?? botOwner.get(rec.botId) ?? DEFAULT_PERSON_ID;

  const storedRefs = new Set(
    args.stored.filter((i) => i.personId === args.personId && i.refId).map((i) => `${i.kind}:${i.refId}`),
  );
  const items: TeamInboxItem[] = args.stored.filter((i) => i.personId === args.personId);

  for (const a of args.approvals ?? []) {
    if (addresseeOf(a) !== args.personId) continue;
    if (storedRefs.has(`approval:${a.id}`)) continue;
    items.push({
      id: `approval:${a.id}`,
      personId: args.personId,
      kind: 'approval',
      state: a.status === 'pending' ? 'needs-you' : 'done',
      title: `Approval: ${a.toolName}`,
      summary: `Bot ${a.botId} is waiting on an approval for ${a.toolName} (${a.status}).`,
      botId: a.botId,
      refId: a.id,
      createdAt: a.ts,
      updatedAt: a.ts,
    });
  }
  for (const w of args.widgets ?? []) {
    if (!w.interactive) continue;
    if (addresseeOf(w) !== args.personId) continue;
    if (storedRefs.has(`question:${w.id}`)) continue;
    const q = w.payload?.question ?? w.payload?.title ?? w.title ?? 'Question from a bot';
    items.push({
      id: `question:${w.id}`,
      personId: args.personId,
      kind: 'question',
      state: w.status === 'pending' ? 'needs-you' : 'done',
      title: 'Question for you',
      summary: q,
      botId: w.botId,
      refId: w.id,
      createdAt: w.createdAt,
      updatedAt: w.createdAt,
    });
  }

  const sortDesc = (x: TeamInboxItem, y: TeamInboxItem): number => y.createdAt - x.createdAt;
  const needsYou = items.filter((i) => i.state === 'needs-you').sort(sortDesc);
  const fyi = items.filter((i) => i.state === 'fyi').sort(sortDesc);
  const done = items.filter((i) => i.state === 'done').sort(sortDesc);
  return { personId: args.personId, needsYou, fyi, done, all: [...needsYou, ...fyi, ...done] };
}

// ---------------------------------------------------------------------------
// Per-person chief notification
// ---------------------------------------------------------------------------

/** The text a chief bot receives when a needs-you item lands for its person. */
export function buildChiefNotificationText(person: Person, item: TeamInboxItem): string {
  return [
    `[Chief notification] A new item needs ${person.name}'s attention.`,
    `Kind: ${item.kind}. Title: ${item.title}.`,
    `Summary: ${item.summary}`,
    item.botId ? `From bot: ${item.botId}.` : '',
    'You are their Chief of Staff bot. Acknowledge it and, if you can help them triage it, say how. Do not decide approvals or answer questions in their place.',
  ]
    .filter(Boolean)
    .join('\n');
}

export type ChiefNotifyFn = (args: {
  person: Person;
  chiefBotId: string;
  item: TeamInboxItem;
  text: string;
}) => Promise<void> | void;

/**
 * Notify a person's chief bot about a new needs-you item.
 * Rules:
 * - The DEFAULT user keeps the existing global Chief behaviour → no
 *   per-person notification (returns { notified: false, reason }).
 * - A person with no chiefBotId set → no notification.
 * - Otherwise the injected notify fn runs one chief turn (mockable).
 */
export async function notifyPersonChief(
  person: Person,
  item: TeamInboxItem,
  notify: ChiefNotifyFn | undefined,
): Promise<{ notified: boolean; reason?: string }> {
  if (person.isDefaultUser) return { notified: false, reason: 'default-user-global-chief' };
  if (!person.chiefBotId) return { notified: false, reason: 'no-chief-designated' };
  if (!notify) return { notified: false, reason: 'no-notify-wired' };
  await notify({
    person,
    chiefBotId: person.chiefBotId,
    item,
    text: buildChiefNotificationText(person, item),
  });
  return { notified: true };
}

// ---------------------------------------------------------------------------
// Human relay
// ---------------------------------------------------------------------------

/** Delivers one message to a person over one channel. Pluggable. */
export interface RelaySender {
  send(args: {
    person: Person;
    channel: string;
    to: string;
    text: string;
    botId: string;
  }): Promise<{ ok: boolean; id?: string }>;
}

export type RelayChannelChoice = { channel: string; to: string } | { error: string };

/**
 * Pick the channel + destination for reaching a person: an explicitly
 * preferred channel wins, then the first messaging handle (gateway
 * order: insertion order of the handles record), then email.
 */
export function resolveRelayChannel(person: Person, preferred?: string): RelayChannelChoice {
  if (preferred) {
    const key = preferred.trim().toLowerCase();
    if (key === 'email') {
      const to = person.channels.email ?? person.email;
      return to ? { channel: 'email', to } : { error: `${person.name} has no email address configured` };
    }
    const to = person.channels.handles[key];
    return to ? { channel: key, to } : { error: `${person.name} has no ${key} handle configured` };
  }
  for (const [channel, to] of Object.entries(person.channels.handles)) {
    if (to) return { channel, to };
  }
  const email = person.channels.email ?? person.email;
  if (email) return { channel: 'email', to: email };
  return { error: `${person.name} has no reachable channel (no messaging handles, no email)` };
}

/** Delivers a fenced reply back into the originating chat session. */
export type RelayDeliverToChatFn = (args: {
  sessionId: string;
  relayId: string;
  person: Person;
  /** Defused + fenced text, safe to hand to the model as external content. */
  text: string;
  provenance: ProvenanceNote;
}) => Promise<void> | void;

/** Fired when a new needs-you item lands for a person (chief + push hooks). */
export type NeedsYouHook = (person: Person, item: TeamInboxItem) => Promise<void> | void;

export interface RelayServiceDeps {
  people: PeopleStore;
  inbox: TeamInboxStore;
  sender: RelaySender;
  deliverToChat: RelayDeliverToChatFn;
  /** Optional onBehalfOf ledger (provenance.ts) — outbound relays recorded. */
  ledger?: Pick<OnBehalfOfLedger, 'record'>;
  onNeedsYou?: NeedsYouHook;
}

export interface RelayResult {
  item: TeamInboxItem;
  channel: string;
  to: string;
  providerMessageId?: string;
}

export function newRelayId(): string {
  return `relay_${Date.now().toString(36)}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

/**
 * Human relay service: a bot passes a message to a person via their
 * configured channel; the person's reply comes back into the originating
 * chat as fenced external content. The send itself is approval-governed
 * by the caller (the `relay_to_person` tool call goes through the normal
 * governance gateway — deny-by-default, require-approval — before this
 * service is invoked; see tools/relay.ts).
 */
export class RelayService {
  private readonly deps: RelayServiceDeps;

  constructor(deps: RelayServiceDeps) {
    this.deps = deps;
  }

  /** Send a relay message to a person and open the awaiting-reply inbox item. */
  async relay(args: {
    personId: string;
    message: string;
    botId: string;
    sessionId?: string;
    channel?: string;
  }): Promise<RelayResult> {
    const person = this.deps.people.getPerson(args.personId);
    if (!person) throw new Error(`Unknown person "${args.personId}"`);
    const text = args.message.trim();
    if (!text) throw new Error('relay message is required');
    const choice = resolveRelayChannel(person, args.channel);
    if ('error' in choice) throw new Error(choice.error);
    const sent = await this.deps.sender.send({
      person,
      channel: choice.channel,
      to: choice.to,
      text,
      botId: args.botId,
    });
    if (!sent.ok) throw new Error(`relay send via ${choice.channel} did not succeed`);
    const relayId = newRelayId();
    const item = this.deps.inbox.addItem({
      personId: person.id,
      kind: 'relay',
      state: 'needs-you',
      title: `Relay from bot ${args.botId} — awaiting reply`,
      summary: text,
      botId: args.botId,
      sessionId: args.sessionId,
      refId: relayId,
    });
    try {
      this.deps.ledger?.record({
        messageId: sent.id ?? relayId,
        source: choice.channel === 'email' ? 'email' : 'messaging',
        from: args.botId,
        onBehalfOf: person.id,
        note: `outbound relay via ${choice.channel} (relay ${relayId})`,
      });
    } catch {
      // The ledger must never break the relay itself.
    }
    if (this.deps.onNeedsYou) {
      try {
        await this.deps.onNeedsYou(person, item);
      } catch {
        // Notifications are best-effort.
      }
    }
    return { item, channel: choice.channel, to: choice.to, providerMessageId: sent.id };
  }

  /**
   * Bring a person's reply back into the originating chat. The reply is
   * EXTERNAL content: defused, fenced, and provenance-tagged relayed —
   * it can never be mistaken for the local user or satisfy an approval.
   * Works for both reply paths: the inbox reply UI (via: 'inbox') and a
   * gateway inbound message matched to the person (via: 'gateway').
   */
  async reply(args: {
    itemId: string;
    text: string;
    via: 'inbox' | 'gateway';
  }): Promise<{ item: TeamInboxItem; deliveredText: string; provenance: ProvenanceNote }> {
    const item = this.deps.inbox.getItem(args.itemId);
    if (!item) throw new Error(`Unknown inbox item "${args.itemId}"`);
    if (item.kind !== 'relay') throw new Error(`Inbox item "${args.itemId}" is not a relay awaiting reply`);
    if (item.state === 'done') throw new Error(`Relay "${args.itemId}" was already answered`);
    const person = this.deps.people.getPerson(item.personId);
    if (!person) throw new Error(`Relay person "${item.personId}" no longer exists`);
    const text = args.text.trim();
    if (!text) throw new Error('reply text is required');

    const provenance: ProvenanceNote = {
      origin: 'external',
      relayPath: [person.id],
      relayNames: [person.name],
      timestamp: new Date().toISOString(),
      relayed: true,
    };
    const deliveredText = wrapPeerContent(defusePeerText(text), provenance);
    if (item.sessionId) {
      await this.deps.deliverToChat({
        sessionId: item.sessionId,
        relayId: item.refId ?? item.id,
        person,
        text: deliveredText,
        provenance,
      });
    }
    const updated = this.deps.inbox.recordReply(item.id, text) ?? item;
    return { item: updated, deliveredText, provenance };
  }

  /**
   * Gateway-inbound reply interface: an inbound message on a provider
   * channel is matched to a person (by handle, then email) and to their
   * oldest still-open relay; the reply then follows the exact same
   * fenced delivery path as an inbox reply. Returns { matched: false }
   * when no person or no open relay matches — the caller keeps its
   * normal inbound handling in that case.
   */
  async handleGatewayReply(args: {
    provider: string;
    from: string;
    text: string;
  }): Promise<
    | { matched: true; item: TeamInboxItem; deliveredText: string }
    | { matched: false; reason: string }
  > {
    const person =
      this.deps.people.findByHandle(args.provider, args.from) ??
      this.deps.people.findByEmail(args.from);
    if (!person) return { matched: false, reason: 'unknown sender' };
    const open = this.deps.inbox
      .listItems({ personId: person.id, kind: 'relay', state: 'needs-you' })
      .sort((a, b) => a.createdAt - b.createdAt);
    const target = open[0];
    if (!target) return { matched: false, reason: 'no open relay for sender' };
    const res = await this.reply({ itemId: target.id, text: args.text, via: 'gateway' });
    return { matched: true, item: res.item, deliveredText: res.deliveredText };
  }
}
