// SPDX-License-Identifier: Apache-2.0
// Idea cards (Muse parity): create / list / run / dismiss, with status
// tracking. Lifecycle: new → active (run) → done (complete); new/active →
// dismissed (USER ONLY, I-4); new → expired (store expiry rules, I-5).
// Dismissed ideas can be re-run; expired ideas are terminal.
//
// Closure additions (Wave 5, audit §4.3):
//   I-4 — dismissal is structurally user-only. `dismiss()` requires a
//         DismissalActor of kind 'user'; agent/system actors are refused
//         with PermissionError at the store layer, and the agent tool
//         surface (./tools.ts) exposes no dismiss action at all.
//   I-5 — expiry / early-retirement rules: `expireStale()` retires 'new'
//         ideas past their expiresAt (or the default TTL) and early-
//         retires low-rank curated ideas after a grace period. Expiry is
//         a store rule, not an agent action, so it does not weaken I-4.
//   I-6 — curated ideas carry feasibility/fit/novelty scores, a combined
//         rank, a human-readable rationale and evidence strings (the
//         provenance the SI-5 "why was this suggested?" lookup reads).

import { randomUUID } from 'node:crypto';
import { ValidationError, NotFoundError, PermissionError } from '../errors.js';
import type { ModuleDb } from '../db.js';

export type IdeaStatus = 'new' | 'active' | 'done' | 'dismissed' | 'expired';

export type IdeaSource = 'manual' | 'dream' | 'curation' | 'goal-study';

export interface IdeaScores {
  /** 0..1 — how doable this looks with the user's current setup. */
  feasibility: number;
  /** 0..1 — overlap with the user's goals and memory. */
  fit: number;
  /** 0..1 — distance from ideas already in the store. */
  novelty: number;
  /** 0..1 — weighted combination used for ordering and retirement. */
  rank: number;
}

export interface Idea {
  id: string;
  title: string;
  description: string;
  status: IdeaStatus;
  source: IdeaSource;
  scores?: IdeaScores;
  /** Why this idea was suggested (SI-5 provenance). */
  rationale?: string;
  /** Short evidence strings backing the rationale (goal titles, memory hits). */
  evidence?: string[];
  /** Epoch ms after which a still-'new' idea expires (I-5). */
  expiresAt?: number;
  /** Why the store retired the idea: 'ttl' | 'low-rank' | 'run-failed'. */
  retireReason?: string;
  /** Run currently bound to this idea's card (I-3), null when idle. */
  runId?: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * Who is performing a dismissal. Only `{ kind: 'user' }` may dismiss —
 * the HTTP layer constructs it for the signed-in user; agent tool code
 * has no way (and no tool) to produce a dismissal.
 */
export type DismissalActor = { kind: 'user' } | { kind: 'agent'; botId?: string } | { kind: 'system' };

export const USER_DISMISSAL: DismissalActor = { kind: 'user' };

export interface IdeaExpiryPolicy {
  /** Default TTL for 'new' ideas without an explicit expiresAt. */
  ttlMs?: number;
  /** Curated ideas scoring below this rank retire early… */
  lowRankThreshold?: number;
  /** …once they are at least this old. */
  lowRankGraceMs?: number;
}

export const DEFAULT_IDEA_EXPIRY: Required<IdeaExpiryPolicy> = {
  ttlMs: 14 * 24 * 60 * 60 * 1000,
  lowRankThreshold: 0.3,
  lowRankGraceMs: 3 * 24 * 60 * 60 * 1000,
};

interface IdeaRow {
  id: string;
  title: string;
  description: string;
  status: string;
  source: string;
  scores_json: string | null;
  rationale: string | null;
  evidence_json: string | null;
  expires_at: number | null;
  retire_reason: string | null;
  run_id: string | null;
  created_at: number;
  updated_at: number;
}

const COLUMNS =
  'id, title, description, status, source, scores_json, rationale, evidence_json, expires_at, retire_reason, run_id, created_at, updated_at';

function parseJson<T>(raw: string | null): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function rowToIdea(row: IdeaRow): Idea {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status as IdeaStatus,
    source: (row.source || 'manual') as IdeaSource,
    scores: parseJson<IdeaScores>(row.scores_json),
    rationale: row.rationale ?? undefined,
    evidence: parseJson<string[]>(row.evidence_json),
    expiresAt: row.expires_at ?? undefined,
    retireReason: row.retire_reason ?? undefined,
    runId: row.run_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function clampScore(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

export class IdeaStore {
  constructor(private readonly mdb: ModuleDb) {}

  create(input: {
    title: string;
    description?: string;
    source?: IdeaSource;
    scores?: IdeaScores;
    rationale?: string;
    evidence?: string[];
    expiresAt?: number;
  }): Idea {
    const title = (input.title ?? '').trim();
    if (!title) throw new ValidationError('idea "title" must be a non-empty string');
    if (title.length > 200) throw new ValidationError('idea "title" must be at most 200 characters');
    const description = (input.description ?? '').trim();
    if (description.length > 2000) {
      throw new ValidationError('idea "description" must be at most 2000 characters');
    }
    const scores = input.scores
      ? {
          feasibility: clampScore(input.scores.feasibility),
          fit: clampScore(input.scores.fit),
          novelty: clampScore(input.scores.novelty),
          rank: clampScore(input.scores.rank),
        }
      : undefined;
    const id = randomUUID();
    const now = Date.now();
    this.mdb.db
      .prepare(
        `INSERT INTO mm_ideas (id, title, description, status, source, scores_json, rationale, evidence_json, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, 'new', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        title,
        description,
        input.source ?? 'manual',
        scores ? JSON.stringify(scores) : null,
        input.rationale?.slice(0, 1000) ?? null,
        input.evidence ? JSON.stringify(input.evidence.slice(0, 20).map((e) => String(e).slice(0, 300))) : null,
        input.expiresAt ?? null,
        now,
        now,
      );
    return this.get(id);
  }

  get(id: string): Idea {
    const row = this.mdb.db.prepare(`SELECT ${COLUMNS} FROM mm_ideas WHERE id = ?`).get(id) as IdeaRow | undefined;
    if (!row) throw new NotFoundError(`unknown idea: ${id}`);
    return rowToIdea(row);
  }

  list(status?: IdeaStatus): Idea[] {
    const rows = (
      status
        ? this.mdb.db.prepare(`SELECT ${COLUMNS} FROM mm_ideas WHERE status = ? ORDER BY updated_at DESC`).all(status)
        : this.mdb.db.prepare(`SELECT ${COLUMNS} FROM mm_ideas ORDER BY updated_at DESC`).all()
    ) as unknown as IdeaRow[];
    return rows.map(rowToIdea);
  }

  /** Ideas ordered by curation rank (unscored ideas last), for the Ideas tab. */
  listRanked(status: IdeaStatus = 'new'): Idea[] {
    return this.list(status).sort((a, b) => (b.scores?.rank ?? -1) - (a.scores?.rank ?? -1));
  }

  private transition(id: string, to: IdeaStatus, from: ReadonlySet<IdeaStatus>): Idea {
    const idea = this.get(id);
    if (!from.has(idea.status)) {
      throw new ValidationError(`cannot move idea from "${idea.status}" to "${to}"`);
    }
    const now = Date.now();
    this.mdb.db.prepare('UPDATE mm_ideas SET status = ?, updated_at = ? WHERE id = ?').run(to, now, id);
    return this.get(id);
  }

  /** Start (or re-start) working an idea. */
  run(id: string): Idea {
    return this.transition(id, 'active', new Set(['new', 'dismissed']));
  }

  /**
   * Shelve an idea without deleting it. USER-ONLY (I-4): any actor other
   * than the user — agent or system — is refused here at the store layer,
   * so no agent tool, routine or loop can dismiss an idea even by calling
   * the store directly.
   */
  dismiss(id: string, actor: DismissalActor): Idea {
    if (!actor || actor.kind !== 'user') {
      throw new PermissionError('idea dismissal is user-only; agents and system loops cannot dismiss ideas');
    }
    return this.transition(id, 'dismissed', new Set(['new', 'active']));
  }

  /** Mark a running idea finished. */
  complete(id: string): Idea {
    return this.transition(id, 'done', new Set(['active']));
  }

  /**
   * I-5 expiry sweep. Retires 'new' ideas that are stale:
   *  - past their explicit expiresAt, or older than the default TTL → 'ttl'
   *  - curated (scored) ideas under the low-rank threshold once past the
   *    grace period → 'low-rank' (early retirement)
   * Active/done/dismissed ideas are never touched. Returns retired ideas.
   */
  expireStale(now: number = Date.now(), policy: IdeaExpiryPolicy = {}): Idea[] {
    const ttlMs = policy.ttlMs ?? DEFAULT_IDEA_EXPIRY.ttlMs;
    const lowRank = policy.lowRankThreshold ?? DEFAULT_IDEA_EXPIRY.lowRankThreshold;
    const graceMs = policy.lowRankGraceMs ?? DEFAULT_IDEA_EXPIRY.lowRankGraceMs;
    const retired: Idea[] = [];
    for (const idea of this.list('new')) {
      let reason: string | undefined;
      if (idea.expiresAt !== undefined && now >= idea.expiresAt) reason = 'ttl';
      else if (now - idea.createdAt >= ttlMs) reason = 'ttl';
      else if (idea.scores && idea.scores.rank < lowRank && now - idea.createdAt >= graceMs) reason = 'low-rank';
      if (!reason) continue;
      this.mdb.db
        .prepare("UPDATE mm_ideas SET status = 'expired', retire_reason = ?, updated_at = ? WHERE id = ?")
        .run(reason, now, idea.id);
      retired.push(this.get(idea.id));
    }
    return retired;
  }

  /** Bind a chat run to this idea's card (I-3). The idea must be active. */
  bindRun(id: string, runId: string): Idea {
    const idea = this.get(id);
    if (idea.status !== 'active') {
      throw new ValidationError(`cannot bind a run to an idea in status "${idea.status}"`);
    }
    if (!runId.trim()) throw new ValidationError('runId must be a non-empty string');
    this.mdb.db.prepare('UPDATE mm_ideas SET run_id = ?, updated_at = ? WHERE id = ?').run(runId, Date.now(), id);
    return this.get(id);
  }

  /** Clear the bound run (run finished/failed). No-op when already clear. */
  clearRun(id: string): Idea {
    this.get(id);
    this.mdb.db.prepare('UPDATE mm_ideas SET run_id = NULL, updated_at = ? WHERE id = ?').run(Date.now(), id);
    return this.get(id);
  }
}
