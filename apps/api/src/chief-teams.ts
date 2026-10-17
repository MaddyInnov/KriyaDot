// SPDX-License-Identifier: Apache-2.0
// Chief-of-Staff persistence (ChiefTeamsStore).
//
// SQLite <dataDir>/chief-teams.db:
//
//   team_proposals  — team-setup / create-bot / delete-bot proposals the
//                     chief files for user approval
//   team_incidents  — the chief's incidents + escalations inbox
//   chief_config    — single row: which bot is chief, which sections it owns
//   bot_field_overrides — field patches applied to seed bots by approved
//                     proposals (seed/bots.json is immutable at runtime)
//   deleted_bot_ids — bot ids removed by approved delete proposals
//
// Follow the teams.ts store conventions: DatabaseSync from node:sqlite,
// guarded migrations, ISO timestamps as text.

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import type {
  ChiefIncident,
  ChiefIncidentKind,
  ChiefIncidentStatus,
  ChiefProposal,
  ChiefProposalKind,
  ChiefProposalOp,
  ChiefProposalStatus,
  NewChiefIncident,
} from '@mvp/agent-runtime';

import { openDb } from '@mvp/agent-runtime';

export interface ChiefConfig {
  chiefBotId: string | null;
  managedSections: string[];
}

interface ProposalRow {
  id: string;
  kind: string;
  created_by_bot_id: string;
  reason: string;
  operations_json: string;
  suggestion: number;
  new_teams_json: string | null;
  status: string;
  created_at: string;
  decided_at: string | null;
}

interface IncidentRow {
  id: string;
  kind: string;
  chief_bot_id: string;
  target_bot_id: string | null;
  target_bot_name: string | null;
  thread_id: string | null;
  summary: string;
  detail: string | null;
  attempts: number;
  status: string;
  created_at: string;
  updated_at: string;
}

function parseOps(json: string | null): ChiefProposalOp[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? (parsed as ChiefProposalOp[]) : [];
  } catch {
    return [];
  }
}

function parseStrings(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? (parsed as unknown[]).filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function rowToProposal(r: ProposalRow): ChiefProposal {
  const proposal: ChiefProposal = {
    id: r.id,
    kind: r.kind as ChiefProposalKind,
    createdByBotId: r.created_by_bot_id,
    reason: r.reason,
    operations: parseOps(r.operations_json),
    status: r.status as ChiefProposalStatus,
    createdAt: r.created_at,
  };
  if (r.suggestion === 1) proposal.suggestion = true;
  const newTeams = parseStrings(r.new_teams_json);
  if (newTeams.length > 0) proposal.newTeams = newTeams;
  if (r.decided_at) proposal.decidedAt = r.decided_at;
  return proposal;
}

function rowToIncident(r: IncidentRow): ChiefIncident {
  return {
    id: r.id,
    kind: r.kind as ChiefIncidentKind,
    chiefBotId: r.chief_bot_id,
    targetBotId: r.target_bot_id ?? undefined,
    targetBotName: r.target_bot_name ?? undefined,
    threadId: r.thread_id ?? undefined,
    summary: r.summary,
    detail: r.detail ?? undefined,
    attempts: r.attempts,
    status: r.status as ChiefIncidentStatus,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class ChiefTeamsStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { mkdirSync } = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join } = require('node:path') as typeof import('node:path');
    mkdirSync(dataDir, { recursive: true });
    this.db = openDb(join(dataDir, 'chief-teams.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chief_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        chief_bot_id TEXT,
        managed_sections_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS team_proposals (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        created_by_bot_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        operations_json TEXT NOT NULL,
        suggestion INTEGER NOT NULL DEFAULT 0,
        new_teams_json TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        decided_at TEXT
      );
      CREATE TABLE IF NOT EXISTS team_incidents (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        chief_bot_id TEXT NOT NULL,
        target_bot_id TEXT,
        target_bot_name TEXT,
        thread_id TEXT,
        summary TEXT NOT NULL,
        detail TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bot_field_overrides (
        bot_id TEXT PRIMARY KEY,
        fields_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS deleted_bot_ids (
        bot_id TEXT PRIMARY KEY
      );
      CREATE INDEX IF NOT EXISTS idx_team_proposals_status ON team_proposals (status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_team_incidents_status ON team_incidents (status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_team_incidents_thread ON team_incidents (thread_id);
    `);
    this.db
      .prepare("INSERT INTO chief_config (id, chief_bot_id, managed_sections_json) VALUES (1, NULL, '[]') ON CONFLICT(id) DO NOTHING")
      .run();
  }

  // ---- Chief config ------------------------------------------------------

  getChiefConfig(): ChiefConfig {
    const row = this.db
      .prepare('SELECT chief_bot_id, managed_sections_json FROM chief_config WHERE id = 1')
      .get() as unknown as { chief_bot_id: string | null; managed_sections_json: string };
    return {
      chiefBotId: row.chief_bot_id,
      managedSections: parseStrings(row.managed_sections_json),
    };
  }

  setChiefConfig(chiefBotId: string | null, managedSections: string[] = []): ChiefConfig {
    this.db
      .prepare('UPDATE chief_config SET chief_bot_id = ?, managed_sections_json = ? WHERE id = 1')
      .run(chiefBotId, JSON.stringify(managedSections));
    return this.getChiefConfig();
  }

  // ---- Proposals ---------------------------------------------------------

  createProposal(input: {
    kind: ChiefProposalKind;
    createdByBotId: string;
    reason: string;
    operations: ChiefProposalOp[];
    suggestion?: boolean;
    newTeams?: string[];
  }): ChiefProposal {
    const now = new Date().toISOString();
    const proposal: ChiefProposal = {
      id: `cpr_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      kind: input.kind,
      createdByBotId: input.createdByBotId,
      reason: input.reason,
      operations: input.operations,
      status: 'pending',
      createdAt: now,
    };
    if (input.suggestion) proposal.suggestion = true;
    if (input.newTeams && input.newTeams.length > 0) proposal.newTeams = [...input.newTeams];
    this.db
      .prepare(
        'INSERT INTO team_proposals (id, kind, created_by_bot_id, reason, operations_json, suggestion, new_teams_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        proposal.id,
        proposal.kind,
        proposal.createdByBotId,
        proposal.reason,
        JSON.stringify(proposal.operations),
        input.suggestion ? 1 : 0,
        input.newTeams && input.newTeams.length > 0 ? JSON.stringify(input.newTeams) : null,
        proposal.status,
        now,
      );
    return proposal;
  }

  getProposal(id: string): ChiefProposal | undefined {
    const row = this.db.prepare('SELECT * FROM team_proposals WHERE id = ?').get(id) as unknown as ProposalRow | undefined;
    return row ? rowToProposal(row) : undefined;
  }

  listProposals(status?: ChiefProposalStatus): ChiefProposal[] {
    const rows = status
      ? (this.db
          .prepare('SELECT * FROM team_proposals WHERE status = ? ORDER BY created_at DESC')
          .all(status) as unknown as ProposalRow[])
      : (this.db.prepare('SELECT * FROM team_proposals ORDER BY created_at DESC').all() as unknown as ProposalRow[]);
    return rows.map(rowToProposal);
  }

  decideProposal(id: string, status: 'approved' | 'rejected'): ChiefProposal | undefined {
    const now = new Date().toISOString();
    const r = this.db
      .prepare("UPDATE team_proposals SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'")
      .run(status, now, id);
    return r.changes > 0 ? this.getProposal(id) : undefined;
  }

  // ---- Incidents ---------------------------------------------------------

  reportIncident(input: NewChiefIncident): ChiefIncident {
    const now = new Date().toISOString();
    const incident: ChiefIncident = {
      id: `cin_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      kind: input.kind,
      chiefBotId: input.chiefBotId,
      targetBotId: input.targetBotId,
      targetBotName: input.targetBotName,
      threadId: input.threadId,
      summary: input.summary,
      detail: input.detail,
      attempts: input.attempts ?? 0,
      status: 'open',
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        'INSERT INTO team_incidents (id, kind, chief_bot_id, target_bot_id, target_bot_name, thread_id, summary, detail, attempts, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        incident.id,
        incident.kind,
        incident.chiefBotId,
        incident.targetBotId ?? null,
        incident.targetBotName ?? null,
        incident.threadId ?? null,
        incident.summary,
        incident.detail ?? null,
        incident.attempts,
        incident.status,
        now,
        now,
      );
    return incident;
  }

  getIncident(id: string): ChiefIncident | undefined {
    const row = this.db.prepare('SELECT * FROM team_incidents WHERE id = ?').get(id) as unknown as IncidentRow | undefined;
    return row ? rowToIncident(row) : undefined;
  }

  getIncidentByThread(threadId: string): ChiefIncident | undefined {
    const row = this.db
      .prepare('SELECT * FROM team_incidents WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(threadId) as unknown as IncidentRow | undefined;
    return row ? rowToIncident(row) : undefined;
  }

  listIncidents(filter: { status?: ChiefIncidentStatus; kind?: ChiefIncidentKind } = {}): ChiefIncident[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.status) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    if (filter.kind) {
      clauses.push('kind = ?');
      params.push(filter.kind);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM team_incidents ${where} ORDER BY updated_at DESC`)
      .all(...params) as unknown as IncidentRow[];
    return rows.map(rowToIncident);
  }

  updateIncident(
    id: string,
    patch: Partial<Pick<ChiefIncident, 'status' | 'attempts' | 'summary' | 'detail'>>,
  ): ChiefIncident | undefined {
    const current = this.getIncident(id);
    if (!current) return undefined;
    const now = new Date().toISOString();
    this.db
      .prepare('UPDATE team_incidents SET status = ?, attempts = ?, summary = ?, detail = ?, updated_at = ? WHERE id = ?')
      .run(
        patch.status ?? current.status,
        patch.attempts ?? current.attempts,
        patch.summary ?? current.summary,
        patch.detail ?? (current.detail ?? null),
        now,
        id,
      );
    return this.getIncident(id);
  }

  resolveIncident(id: string): ChiefIncident | undefined {
    return this.updateIncident(id, { status: 'resolved' });
  }

  // ---- Field overrides + deleted ids (applied to seed bots at boot) ------

  setBotOverride(botId: string, fields: Record<string, unknown>): void {
    const current = this.getBotOverrides()[botId] ?? {};
    const merged = { ...current, ...fields };
    this.db
      .prepare('INSERT INTO bot_field_overrides (bot_id, fields_json) VALUES (?, ?) ON CONFLICT(bot_id) DO UPDATE SET fields_json = excluded.fields_json')
      .run(botId, JSON.stringify(merged));
  }

  getBotOverrides(): Record<string, Record<string, unknown>> {
    const rows = this.db.prepare('SELECT bot_id, fields_json FROM bot_field_overrides').all() as unknown as {
      bot_id: string;
      fields_json: string;
    }[];
    const out: Record<string, Record<string, unknown>> = {};
    for (const r of rows) {
      try {
        out[r.bot_id] = JSON.parse(r.fields_json) as Record<string, unknown>;
      } catch {
        out[r.bot_id] = {};
      }
    }
    return out;
  }

  deleteBotOverride(botId: string): void {
    this.db.prepare('DELETE FROM bot_field_overrides WHERE bot_id = ?').run(botId);
  }

  addDeletedBotId(botId: string): void {
    this.db.prepare('INSERT INTO deleted_bot_ids (bot_id) VALUES (?) ON CONFLICT(bot_id) DO NOTHING').run(botId);
  }

  removeDeletedBotId(botId: string): void {
    this.db.prepare('DELETE FROM deleted_bot_ids WHERE bot_id = ?').run(botId);
  }

  getDeletedBotIds(): string[] {
    const rows = this.db.prepare('SELECT bot_id FROM deleted_bot_ids').all() as unknown as { bot_id: string }[];
    return rows.map((r) => r.bot_id);
  }

  close(): void {
    this.db.close();
  }
}
