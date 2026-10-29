// SPDX-License-Identifier: Apache-2.0
// Representative assistant (OpenMausBot §1.2 parity, original implementation).
//
// A person's representative answers teammates' FACTUAL questions on their
// behalf — but only from enumerated, local fact sources, only for the fact
// types the owner enabled, and only for askers the owner allowed. Every
// answer is provenance-fenced: it is labelled as coming from the person's
// representative, names the source each fact came from, and cites the
// underlying facts verbatim. Nothing beyond the allowed fact types is
// answered: an out-of-scope question gets a polite refusal plus an offer
// to relay the question to the person through the existing approval-gated
// relay path (tools/relay.ts) — the representative never decides, opines,
// or invents on the owner's behalf.
//
// Fact sources (ALL local, and ONLY these):
//   - availability   — the person's self-set PersonStatus + working hours.
//                      HONEST LIMIT: there is no calendar integration in
//                      this tree that a representative may read, so
//                      availability is exactly "what the person set as
//                      their status / working hours" — never inferred
//                      meetings or events.
//   - status         — PersonStatus + a summary of what the person's bots
//                      are doing right now (injected activity provider,
//                      backed by TurnStateRegistry + the bot roster).
//   - shared-notes   — Pages/notes the person explicitly marked
//                      shared-with-team (injected provider; the shared
//                      flag lives on the Pages model in the API app).
//   - public-profile — the person's people-directory profile fields.
//
// Answer composition is deterministic assembly from the gathered facts.
// An optional injected `polish` function may rephrase ONLY the short
// summary line; the cited fact bullets are always the verbatim assembled
// facts, so a polisher can never smuggle in a new "fact".
//
// Persistence: RepresentativeStore (SQLite, <dataDir>/representative.db)
// holds per-person policies, person statuses, and an audit record of
// EVERY representative interaction (answered or refused).

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { openDb } from './sqlite.js';
import type { Person, PeopleStore, TeamInboxStore } from './people.js';
import { botOwnerPersonId } from './people.js';
import type { BotConfig } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FactType = 'availability' | 'status' | 'shared-notes' | 'public-profile';

export const ALL_FACT_TYPES: readonly FactType[] = [
  'availability',
  'status',
  'shared-notes',
  'public-profile',
] as const;

export function isFactType(v: unknown): v is FactType {
  return typeof v === 'string' && (ALL_FACT_TYPES as readonly string[]).includes(v);
}

/** Who may ask this person's representative questions. */
export type AllowedAskers =
  | { mode: 'team' }
  | { mode: 'all' }
  | { mode: 'people'; personIds: string[] };

export interface RepresentativePolicy {
  personId: string;
  enabled: boolean;
  allowedFactTypes: FactType[];
  allowedAskers: AllowedAskers;
  /** When true, every answer also creates an FYI inbox item for the owner. */
  requireOwnerNotify: boolean;
  updatedAt: number;
}

/** Default policy: representative OFF until the owner opts in. */
export function defaultRepresentativePolicy(personId: string): RepresentativePolicy {
  return {
    personId,
    enabled: false,
    allowedFactTypes: [],
    allowedAskers: { mode: 'team' },
    requireOwnerNotify: true,
    updatedAt: 0,
  };
}

export type PersonStatusState = 'free' | 'busy' | 'focus' | 'ooo';

export interface WorkingHours {
  /** Local hour the work day starts (0–23). */
  startHour: number;
  /** Local hour the work day ends (1–24; may be <= start for overnight). */
  endHour: number;
  /** Days of week the hours apply to (0 = Sunday … 6 = Saturday). Empty = every day. */
  days: number[];
  /** IANA timezone label the hours are expressed in (display only). */
  timezone?: string;
}

export interface PersonStatus {
  personId: string;
  state: PersonStatusState;
  /** Epoch ms the state lasts until, when known. */
  until?: number;
  /** Free-text note the person set alongside the state. */
  note?: string;
  workingHours?: WorkingHours;
  updatedAt: number;
}

/** One cited fact in a representative answer. */
export interface RepresentativeFact {
  source: FactType | 'person-status' | 'bot-activity' | 'shared-notes' | 'people-directory';
  text: string;
}

/** A note/page the owner explicitly marked shared-with-team. */
export interface SharedNoteFact {
  id: string;
  title: string;
  excerpt: string;
  updatedAt?: number;
}

/** One live/recent activity line for one of the person's bots. */
export interface BotActivityFact {
  botId: string;
  botName: string;
  /** e.g. "Running read_file (step 3)" or "Idle — no turn in flight". */
  summary: string;
}

export interface RepresentativeAuditRecord {
  id: string;
  personId: string;
  askerId: string;
  question: string;
  factType: FactType | null;
  outcome: 'answered' | 'refused';
  reason: string;
  sources: string[];
  createdAt: number;
}

export interface RepresentativeAnswer {
  answered: boolean;
  personId: string;
  personName: string;
  askerId: string;
  factType: FactType | null;
  /** Provenance-fenced answer text (present when answered). */
  text?: string;
  /** The verbatim facts the answer was assembled from. */
  facts: RepresentativeFact[];
  /** Refusal explanation (present when not answered). */
  refusal?: string;
  /** True when the caller should offer the relay_to_person path instead. */
  offerRelay: boolean;
  auditId: string;
}

// ---------------------------------------------------------------------------
// Store: policies + statuses + audit (representative.db)
// ---------------------------------------------------------------------------

interface PolicyRow { person_id: string; policy_json: string; updated_at: number }
interface StatusRow {
  person_id: string; state: string; until_ms: number | null;
  note: string | null; working_hours_json: string | null; updated_at: number;
}
interface AuditRow {
  id: string; person_id: string; asker_id: string; question: string;
  fact_type: string | null; outcome: string; reason: string;
  sources_json: string; created_at: number;
}

function cleanHour(v: unknown, field: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new Error(`workingHours "${field}" must be an integer in [${min}, ${max}]`);
  }
  return v;
}

export function normalizeWorkingHours(raw: unknown): WorkingHours | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('workingHours must be an object');
  const r = raw as Record<string, unknown>;
  const daysRaw = Array.isArray(r.days) ? r.days : [];
  const days = [...new Set(daysRaw.filter((d): d is number => typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  return {
    startHour: cleanHour(r.startHour, 'startHour', 0, 23),
    endHour: cleanHour(r.endHour, 'endHour', 1, 24),
    days,
    ...(typeof r.timezone === 'string' && r.timezone.trim() ? { timezone: r.timezone.trim().slice(0, 64) } : {}),
  };
}

export function normalizePolicy(personId: string, raw: unknown, base?: RepresentativePolicy): RepresentativePolicy {
  const b = (raw ?? {}) as Record<string, unknown>;
  const cur = base ?? defaultRepresentativePolicy(personId);
  const factTypesRaw = b.allowedFactTypes === undefined ? cur.allowedFactTypes : b.allowedFactTypes;
  if (!Array.isArray(factTypesRaw) || !factTypesRaw.every(isFactType)) {
    throw new Error(`allowedFactTypes must be a subset of ${ALL_FACT_TYPES.join('|')}`);
  }
  let allowedAskers: AllowedAskers = cur.allowedAskers;
  if (b.allowedAskers !== undefined) {
    const a = b.allowedAskers as { mode?: unknown; personIds?: unknown };
    if (a?.mode === 'team') allowedAskers = { mode: 'team' };
    else if (a?.mode === 'all') allowedAskers = { mode: 'all' };
    else if (a?.mode === 'people') {
      if (!Array.isArray(a.personIds) || !a.personIds.every((x) => typeof x === 'string' && x.trim())) {
        throw new Error('allowedAskers.personIds must be an array of person ids');
      }
      allowedAskers = { mode: 'people', personIds: [...new Set((a.personIds as string[]).map((x) => x.trim()))].slice(0, 100) };
    } else {
      throw new Error('allowedAskers.mode must be team|all|people');
    }
  }
  return {
    personId,
    enabled: b.enabled === undefined ? cur.enabled : b.enabled === true,
    allowedFactTypes: [...new Set(factTypesRaw as FactType[])],
    allowedAskers,
    requireOwnerNotify: b.requireOwnerNotify === undefined ? cur.requireOwnerNotify : b.requireOwnerNotify === true,
    updatedAt: Date.now(),
  };
}

export class RepresentativeStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { mkdirSync } = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join } = require('node:path') as typeof import('node:path');
    mkdirSync(dataDir, { recursive: true });
    this.db = openDb(join(dataDir, 'representative.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS representative_policies (
        person_id TEXT PRIMARY KEY, policy_json TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS person_status (
        person_id TEXT PRIMARY KEY, state TEXT NOT NULL, until_ms INTEGER,
        note TEXT, working_hours_json TEXT, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS representative_audit (
        id TEXT PRIMARY KEY, person_id TEXT NOT NULL, asker_id TEXT NOT NULL,
        question TEXT NOT NULL, fact_type TEXT, outcome TEXT NOT NULL,
        reason TEXT NOT NULL, sources_json TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rep_audit_person ON representative_audit (person_id, created_at DESC);
    `);
  }

  getPolicy(personId: string): RepresentativePolicy {
    const row = this.db.prepare('SELECT * FROM representative_policies WHERE person_id = ?').get(personId) as unknown as PolicyRow | undefined;
    if (!row) return defaultRepresentativePolicy(personId);
    try {
      const parsed = JSON.parse(row.policy_json) as RepresentativePolicy;
      return { ...defaultRepresentativePolicy(personId), ...parsed, personId, updatedAt: row.updated_at };
    } catch {
      return defaultRepresentativePolicy(personId);
    }
  }

  setPolicy(personId: string, raw: unknown): RepresentativePolicy {
    const policy = normalizePolicy(personId, raw, this.getPolicy(personId));
    this.db.prepare(
      `INSERT INTO representative_policies (person_id, policy_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(person_id) DO UPDATE SET policy_json = excluded.policy_json, updated_at = excluded.updated_at`,
    ).run(personId, JSON.stringify(policy), policy.updatedAt);
    return policy;
  }

  getStatus(personId: string): PersonStatus | undefined {
    const row = this.db.prepare('SELECT * FROM person_status WHERE person_id = ?').get(personId) as unknown as StatusRow | undefined;
    if (!row) return undefined;
    let workingHours: WorkingHours | undefined;
    if (row.working_hours_json) {
      try { workingHours = normalizeWorkingHours(JSON.parse(row.working_hours_json)); } catch { workingHours = undefined; }
    }
    return {
      personId,
      state: (['free', 'busy', 'focus', 'ooo'].includes(row.state) ? row.state : 'free') as PersonStatusState,
      ...(row.until_ms ? { until: row.until_ms } : {}),
      ...(row.note ? { note: row.note } : {}),
      ...(workingHours ? { workingHours } : {}),
      updatedAt: row.updated_at,
    };
  }

  setStatus(personId: string, input: { state: unknown; until?: unknown; note?: unknown; workingHours?: unknown }): PersonStatus {
    if (typeof input.state !== 'string' || !['free', 'busy', 'focus', 'ooo'].includes(input.state)) {
      throw new Error('status "state" must be one of free|busy|focus|ooo');
    }
    const until = input.until === undefined || input.until === null ? undefined
      : typeof input.until === 'number' && Number.isFinite(input.until) ? Math.floor(input.until)
      : (() => { throw new Error('status "until" must be epoch ms'); })();
    const note = input.note === undefined || input.note === null ? undefined
      : typeof input.note === 'string' ? (input.note.trim().slice(0, 300) || undefined)
      : (() => { throw new Error('status "note" must be a string'); })();
    const workingHours = normalizeWorkingHours(input.workingHours);
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO person_status (person_id, state, until_ms, note, working_hours_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(person_id) DO UPDATE SET state = excluded.state, until_ms = excluded.until_ms,
         note = excluded.note, working_hours_json = excluded.working_hours_json, updated_at = excluded.updated_at`,
    ).run(personId, input.state, until ?? null, note ?? null, workingHours ? JSON.stringify(workingHours) : null, now);
    return this.getStatus(personId)!;
  }

  recordAudit(input: Omit<RepresentativeAuditRecord, 'id' | 'createdAt'>): RepresentativeAuditRecord {
    const rec: RepresentativeAuditRecord = {
      ...input,
      question: input.question.slice(0, 1000),
      id: `rep_${Date.now().toString(36)}_${randomUUID().replace(/-/g, '').slice(0, 8)}`,
      createdAt: Date.now(),
    };
    this.db.prepare(
      `INSERT INTO representative_audit (id, person_id, asker_id, question, fact_type, outcome, reason, sources_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(rec.id, rec.personId, rec.askerId, rec.question, rec.factType, rec.outcome, rec.reason, JSON.stringify(rec.sources), rec.createdAt);
    return rec;
  }

  listAudit(personId: string, limit = 50): RepresentativeAuditRecord[] {
    const rows = this.db.prepare('SELECT * FROM representative_audit WHERE person_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(personId, Math.min(Math.max(limit, 1), 200)) as unknown as AuditRow[];
    return rows.map((r) => ({
      id: r.id, personId: r.person_id, askerId: r.asker_id, question: r.question,
      factType: isFactType(r.fact_type) ? r.fact_type : null,
      outcome: r.outcome === 'answered' ? 'answered' : 'refused',
      reason: r.reason,
      sources: (() => { try { const v = JSON.parse(r.sources_json); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; } catch { return []; } })(),
      createdAt: r.created_at,
    }));
  }

  close(): void { this.db.close(); }
}

// ---------------------------------------------------------------------------
// Question classification (deterministic; no model)
// ---------------------------------------------------------------------------

/**
 * Classify a teammate's question into one allowed fact type, or null when
 * it is outside the representative's scope. Ordered rules: explicit note /
 * profile vocabulary wins over the availability/status overlap ("busy"
 * alone is a status question; "when is X free" is availability).
 */
export function classifyRepresentativeQuestion(question: string): FactType | null {
  const q = ` ${question.toLowerCase()} `;
  if (/\b(shared notes?|notes?|pages?|documents?|docs?|write-?ups?)\b/.test(q)) return 'shared-notes';
  if (/\b(e-?mail|contact|profile|who is|role|title|handles?)\b/.test(q)) return 'public-profile';
  if (/\b(available|availability|free|schedule|calendar|when can|when is|book|meeting time)\b/.test(q)) return 'availability';
  if (/\b(status|working on|doing|up to|focus|busy|out of office|ooo|currently|right now)\b/.test(q)) return 'status';
  return null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface RepresentativeServiceDeps {
  people: Pick<PeopleStore, 'getPerson' | 'listPeople'>;
  store: RepresentativeStore;
  /** Team inbox for owner FYI notifications (optional). */
  inbox?: Pick<TeamInboxStore, 'addItem'>;
  /** Bots owned by a person (for status/activity). */
  getBots?: () => Array<Pick<BotConfig, 'id' | 'name' | 'ownerId'>>;
  /** Live activity per bot id (TurnStateRegistry-backed in production). */
  getBotActivity?: (botId: string) => BotActivityFact | undefined;
  /** Notes/pages the person explicitly marked shared-with-team. */
  getSharedNotes?: (personId: string) => SharedNoteFact[];
  /** Optional summary polisher — may rephrase the summary line ONLY. */
  polish?: (summary: string, facts: RepresentativeFact[]) => Promise<string> | string;
  /** Extra audit/notify observer (tests / host audit log). */
  audit?: (action: string, fields: { actor?: string; detail?: unknown }) => void;
}

export class RepresentativeService {
  constructor(private readonly deps: RepresentativeServiceDeps) {}

  private askerAllowed(policy: RepresentativePolicy, person: Person, askerId: string): { ok: boolean; reason: string } {
    if (askerId === person.id) return { ok: true, reason: 'owner asking about themselves' };
    const mode = policy.allowedAskers;
    if (mode.mode === 'all') return { ok: true, reason: 'policy allows all askers' };
    if (mode.mode === 'people') {
      return mode.personIds.includes(askerId)
        ? { ok: true, reason: 'asker is on the allowed list' }
        : { ok: false, reason: 'asker is not on the representative allowed list' };
    }
    // team: any person in the directory may ask.
    return this.deps.people.getPerson(askerId)
      ? { ok: true, reason: 'asker is a team member' }
      : { ok: false, reason: 'asker is not a team member' };
  }

  private gatherFacts(person: Person, factType: FactType, question: string): RepresentativeFact[] {
    const facts: RepresentativeFact[] = [];
    const status = this.deps.store.getStatus(person.id);
    const statusFact = (): RepresentativeFact => {
      if (!status) return { source: 'person-status', text: `${person.name} has not set a status.` };
      const until = status.until ? ` (until ${new Date(status.until).toISOString()})` : '';
      const note = status.note ? ` Note: ${status.note}` : '';
      const hours = status.workingHours
        ? ` Working hours: ${status.workingHours.startHour}:00–${status.workingHours.endHour}:00${status.workingHours.days.length ? ` on days ${status.workingHours.days.join(',')}` : ' every day'}${status.workingHours.timezone ? ` (${status.workingHours.timezone})` : ''}.`
        : '';
      return { source: 'person-status', text: `${person.name}'s status is ${status.state}${until}.${note}${hours}` };
    };
    if (factType === 'availability') {
      facts.push(statusFact());
      facts.push({
        source: 'person-status',
        text: 'Availability is derived only from the status and working hours the person set themselves; no calendar events are read.',
      });
    } else if (factType === 'status') {
      facts.push(statusFact());
      const bots = (this.deps.getBots?.() ?? []).filter((b) => botOwnerPersonId(b) === person.id);
      if (bots.length === 0) {
        facts.push({ source: 'bot-activity', text: `${person.name} has no bots, so there is no bot activity to report.` });
      } else {
        for (const bot of bots.slice(0, 8)) {
          const activity = this.deps.getBotActivity?.(bot.id);
          facts.push({
            source: 'bot-activity',
            text: activity ? `${bot.name}: ${activity.summary}` : `${bot.name}: Idle — no turn in flight.`,
          });
        }
      }
    } else if (factType === 'shared-notes') {
      const notes = this.deps.getSharedNotes?.(person.id) ?? [];
      if (notes.length === 0) {
        facts.push({ source: 'shared-notes', text: `${person.name} has not shared any notes with the team.` });
      } else {
        const terms = question.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 3);
        const ranked = notes
          .map((n) => ({ n, hits: terms.filter((t) => `${n.title} ${n.excerpt}`.toLowerCase().includes(t)).length }))
          .sort((a, b) => b.hits - a.hits)
          .slice(0, 3);
        for (const { n } of ranked) {
          facts.push({ source: 'shared-notes', text: `Shared note "${n.title}": ${n.excerpt.slice(0, 400)}` });
        }
      }
    } else {
      // public-profile: directory fields only.
      facts.push({ source: 'people-directory', text: `Name: ${person.name}.` });
      facts.push({
        source: 'people-directory',
        text: person.email ? `Email: ${person.email}.` : `${person.name} has no email on their public profile.`,
      });
      const providers = Object.keys(person.channels.handles);
      facts.push({
        source: 'people-directory',
        text: providers.length
          ? `Reachable on: ${providers.join(', ')} (handles are on their directory profile).`
          : `${person.name} has no messaging handles on their public profile.`,
      });
      if (person.chiefBotId) {
        facts.push({ source: 'people-directory', text: `Their designated Chief bot is ${person.chiefBotId}.` });
      }
    }
    return facts;
  }

  async answer(args: {
    personId: string;
    askerId: string;
    question: string;
  }): Promise<RepresentativeAnswer> {
    const question = (args.question ?? '').trim();
    const finish = (
      person: Person | undefined,
      partial: Omit<RepresentativeAnswer, 'auditId' | 'personName' | 'personId' | 'askerId'>,
    ): RepresentativeAnswer => {
      const audit = this.deps.store.recordAudit({
        personId: args.personId,
        askerId: args.askerId,
        question,
        factType: partial.factType,
        outcome: partial.answered ? 'answered' : 'refused',
        reason: partial.answered ? 'answered from allowed fact sources' : (partial.refusal ?? 'refused'),
        sources: partial.facts.map((f) => f.source),
      });
      try {
        this.deps.audit?.(partial.answered ? 'representative.answered' : 'representative.refused', {
          actor: args.askerId,
          detail: { personId: args.personId, factType: partial.factType, auditId: audit.id },
        });
      } catch { /* audit must never break answering */ }
      return {
        ...partial,
        personId: args.personId,
        personName: person?.name ?? args.personId,
        askerId: args.askerId,
        auditId: audit.id,
      };
    };

    const person = this.deps.people.getPerson(args.personId);
    if (!person) {
      return finish(undefined, {
        answered: false, factType: null, facts: [], offerRelay: false,
        refusal: `I don't know a person with id "${args.personId}" in the team directory.`,
      });
    }
    if (!question) {
      return finish(person, {
        answered: false, factType: null, facts: [], offerRelay: false,
        refusal: 'Please ask a specific factual question.',
      });
    }
    const policy = this.deps.store.getPolicy(person.id);
    if (!policy.enabled) {
      return finish(person, {
        answered: false, factType: classifyRepresentativeQuestion(question), facts: [], offerRelay: true,
        refusal: `${person.name}'s representative is not enabled. I can relay your question to ${person.name} instead — relays need their approval before anything is sent.`,
      });
    }
    const allowed = this.askerAllowed(policy, person, args.askerId);
    if (!allowed.ok) {
      return finish(person, {
        answered: false, factType: classifyRepresentativeQuestion(question), facts: [], offerRelay: true,
        refusal: `I'm not allowed to answer questions about ${person.name} for this asker (${allowed.reason}). I can relay the question to ${person.name} instead.`,
      });
    }
    const factType = classifyRepresentativeQuestion(question);
    if (!factType) {
      return finish(person, {
        answered: false, factType: null, facts: [], offerRelay: true,
        refusal: `That question is outside what ${person.name}'s representative can answer — I only cover availability, current status, notes they shared with the team, and their public profile. I can relay the question to ${person.name} instead.`,
      });
    }
    if (!policy.allowedFactTypes.includes(factType)) {
      return finish(person, {
        answered: false, factType, facts: [], offerRelay: true,
        refusal: `${person.name} has not enabled their representative to share ${factType} information. I can relay the question to ${person.name} instead.`,
      });
    }

    const facts = this.gatherFacts(person, factType, question);
    const factLines = facts.map((f) => `- [${f.source}] ${f.text}`);
    let summary = `Here is what ${person.name}'s shared ${factType} information says:`;
    if (this.deps.polish) {
      try {
        const polished = await this.deps.polish(summary, facts);
        if (typeof polished === 'string' && polished.trim()) summary = polished.trim().slice(0, 300);
      } catch { /* polish is optional; deterministic summary stands */ }
    }
    const sourceLabel = [...new Set(facts.map((f) => f.source))].join(', ');
    const text = [
      `Answered by ${person.name}'s representative from ${sourceLabel}.`,
      summary,
      'Facts:',
      ...factLines,
    ].join('\n');

    const result = finish(person, { answered: true, factType, facts, offerRelay: false, text });

    // Owner notification: an FYI inbox item for every ANSWER (audit above
    // covers refusals too). requireOwnerNotify=false suppresses the inbox
    // item, never the audit record.
    if (policy.requireOwnerNotify && this.deps.inbox) {
      try {
        this.deps.inbox.addItem({
          personId: person.id,
          kind: 'fyi',
          state: 'fyi',
          title: `Your representative answered a question from ${args.askerId}`,
          summary: `Question: ${question.slice(0, 300)}\n${text}`.slice(0, 4000),
          refId: result.auditId,
        });
      } catch { /* notification must never break answering */ }
    }
    return result;
  }
}
