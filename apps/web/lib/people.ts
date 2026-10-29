// SPDX-License-Identifier: Apache-2.0
// Client for the multiplayer layer (W7): people directory, bot ownership
// (org view), team inbox, and relays.
//
//   GET    /api/people                 POST /api/people
//   PATCH  /api/people/:id             DELETE /api/people/:id
//   POST   /api/people/:id/chief       GET  /api/people/:id/chats
//   GET    /api/org                    POST /api/bots/:botId/owner
//   GET    /api/team-inbox?personId=   POST /api/team-inbox/:id/reply
//   POST   /api/team-inbox/:id/state
//
// The pure helpers (org grouping, owner moves, mention picker) are
// exported separately from the fetchers so they can be unit-tested
// without a server.

'use client';

import { authedFetch } from './api';

export interface PersonChannels {
  email?: string;
  handles: Record<string, string>;
}

export interface Person {
  id: string;
  name: string;
  pictureUrl?: string;
  avatarColor: string;
  email?: string;
  channels: PersonChannels;
  isDefaultUser: boolean;
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
  refId?: string;
  groupId?: string;
  replyText?: string;
  repliedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface TeamInboxResponse {
  personId: string;
  needsYou: TeamInboxItem[];
  fyi: TeamInboxItem[];
  done: TeamInboxItem[];
  counts: { needsYou: number; fyi: number; done: number };
}

export interface OrgBot {
  id: string;
  name: string;
  ownerId?: string;
}

export interface OrgColumn {
  person: Person;
  bots: OrgBot[];
}

export const DEFAULT_PERSON_ID = 'you';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** The person id a bot belongs to (default user when unowned). */
export function ownerOf(bot: OrgBot): string {
  return bot.ownerId && bot.ownerId.trim() ? bot.ownerId : DEFAULT_PERSON_ID;
}

/** Group bots into one org column per person (unknown owners → default user). */
export function groupBotsByPerson(people: Person[], bots: OrgBot[]): OrgColumn[] {
  const columns = new Map<string, OrgColumn>();
  for (const p of people) columns.set(p.id, { person: p, bots: [] });
  for (const bot of bots) {
    const col = columns.get(ownerOf(bot)) ?? columns.get(DEFAULT_PERSON_ID);
    if (col) col.bots.push(bot);
  }
  return [...columns.values()];
}

/**
 * Return a NEW bots array with one bot's owner changed (the org view's
 * drag / click-to-move state transition — the API call persists it).
 */
export function moveBotOwner<T extends OrgBot>(bots: T[], botId: string, personId: string): T[] {
  return bots.map((b) => (b.id === botId ? { ...b, ownerId: personId } : b));
}

// ---- Mention picker ---------------------------------------------------------

export interface MentionCandidate {
  kind: 'bot' | 'person';
  id: string;
  /** Display label, e.g. "Ana Rao". */
  label: string;
  /** Token inserted into the draft, e.g. "@ana". */
  token: string;
  detail: string;
}

/** The @token for a person: first name word (matches the server parser). */
export function personMentionToken(person: Person): string {
  const first = person.name.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  return first ? `@${first}` : `@${person.id}`;
}

/** The @token for a bot: name without spaces (matches the server parser). */
export function botMentionToken(bot: OrgBot): string {
  return `@${bot.name.replace(/\s+/g, '')}`;
}

/** The in-progress @query at the END of the draft, or null. */
export function currentMentionQuery(draft: string): string | null {
  const m = /(?:^|\s)@([A-Za-z0-9_.-]*)$/.exec(draft);
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * Mention candidates for the room composer: bots AND people, filtered by
 * the in-progress @query. People are included alongside bots so a room
 * message can notify a person (team inbox) as well as pick bot speakers.
 */
export function mentionCandidates(
  bots: OrgBot[],
  people: Person[],
  query: string | null,
): MentionCandidate[] {
  if (query === null) return [];
  const q = query.toLowerCase();
  const matches = (label: string, token: string): boolean =>
    q === '' || label.toLowerCase().includes(q) || token.toLowerCase().includes(q);
  const out: MentionCandidate[] = [];
  for (const b of bots) {
    const token = botMentionToken(b);
    if (matches(b.name, token)) {
      out.push({ kind: 'bot', id: b.id, label: b.name, token, detail: 'bot — replies in the room' });
    }
  }
  for (const p of people) {
    const token = personMentionToken(p);
    if (matches(p.name, token)) {
      out.push({
        kind: 'person',
        id: p.id,
        label: p.name,
        token,
        detail: p.isDefaultUser ? 'person — that’s you' : 'person — gets a team-inbox ping',
      });
    }
  }
  return out.slice(0, 8);
}

/** Replace the trailing @query in the draft with the chosen token. */
export function applyMention(draft: string, candidate: MentionCandidate): string {
  return draft.replace(/(?:^|\s)@[A-Za-z0-9_.-]*$/, (m) =>
    m.startsWith('@') ? `${candidate.token} ` : ` ${candidate.token} `,
  );
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await authedFetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const json = (await res.json()) as { ok: boolean; error?: string } & T;
  if (!res.ok || !json.ok) {
    throw new Error(json.error || `People API failed: ${res.status}`);
  }
  return json;
}

export async function listPeople(): Promise<Person[]> {
  const r = await req<{ people: Person[] }>('/api/people');
  return r.people;
}

export async function createPerson(input: PersonInput): Promise<Person> {
  const r = await req<{ person: Person }>('/api/people', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return r.person;
}

export async function updatePerson(id: string, patch: Partial<PersonInput>): Promise<Person> {
  const r = await req<{ person: Person }>(`/api/people/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  return r.person;
}

export async function deletePerson(id: string): Promise<void> {
  await req<{ deleted: string }>(`/api/people/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function setPersonChief(personId: string, botId: string | null): Promise<Person> {
  const r = await req<{ person: Person }>(`/api/people/${encodeURIComponent(personId)}/chief`, {
    method: 'POST',
    body: JSON.stringify({ botId }),
  });
  return r.person;
}

export async function getOrg(): Promise<OrgColumn[]> {
  const r = await req<{ columns: OrgColumn[] }>('/api/org');
  return r.columns;
}

export async function reassignBotOwner(botId: string, personId: string): Promise<void> {
  await req<{ ok: boolean }>(`/api/bots/${encodeURIComponent(botId)}/owner`, {
    method: 'POST',
    body: JSON.stringify({ personId }),
  });
}

export async function getTeamInbox(personId: string): Promise<TeamInboxResponse> {
  return req<TeamInboxResponse>(`/api/team-inbox?personId=${encodeURIComponent(personId)}`);
}

export async function replyToInboxItem(itemId: string, text: string): Promise<TeamInboxItem> {
  const r = await req<{ item: TeamInboxItem }>(`/api/team-inbox/${encodeURIComponent(itemId)}/reply`, {
    method: 'POST',
    body: JSON.stringify({ text }),
  });
  return r.item;
}

export async function setInboxItemState(itemId: string, state: TeamInboxState): Promise<TeamInboxItem> {
  const r = await req<{ item: TeamInboxItem }>(`/api/team-inbox/${encodeURIComponent(itemId)}/state`, {
    method: 'POST',
    body: JSON.stringify({ state }),
  });
  return r.item;
}
