// SPDX-License-Identifier: Apache-2.0
/**
 * User skill lifecycle: authoring, learning, review, and disabled-by-default
 * governance (OpenMausBot parity P1 #20).
 *
 * Skills on disk live next to every other skill (seed dir +
 * `<dataDir>/skills`), loaded by SkillLoader. This module adds the
 * *lifecycle* layer on top:
 *
 * - `create_skill` (agent tool / API / UI): scaffolds a skill bundle and
 *   saves it. New skills ALWAYS start DISABLED — a human must explicitly
 *   enable them before any bot can use them. Skills carry instructions, so
 *   a malicious or sloppy skill is a prompt-injection surface; the
 *   disabled-by-default boundary is the mitigation.
 * - `learn_skill` (agent tool): the agent proposes a skill capturing a
 *   successful multi-step pattern. The proposal is a DRAFT — nothing is
 *   saved until a human approves it (approval card + review queue). An
 *   approved proposal is materialized as a DISABLED skill (still needs an
 *   explicit enable).
 * - Statuses: draft (proposal awaiting review) → disabled (saved, inert) →
 *   active (usable). `rejected` is terminal for declined proposals.
 * - Scoping: a skill is `global` or restricted to specific bot ids. A bot
 *   only sees a skill when it is active AND in scope. Disabled skills never
 *   reach any bot's prompt or `read_skill`.
 *
 * The enforcement point is SkillLoader's `usabilityGate` (see skills.ts):
 * the host wires `(name, botId) => store.isUserSkill(name)
 * ? store.isUsable(name, botId) : true` so seed/imported skills keep working
 * while user-managed skills are gated on active+in-scope.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolContext, ToolDefinition } from './types.js';
import { SkillNotUsableError } from './skills.js';

// vitest (Vite 5.4.21) cannot statically resolve the `node:sqlite` specifier,
// so load it at runtime via the builtin-module API instead of a top-level import.
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
type DatabaseSyncType = InstanceType<typeof DatabaseSync>;

export type UserSkillStatus = 'draft' | 'active' | 'disabled' | 'rejected';
export type UserSkillSource = 'agent-created' | 'learned' | 'manual' | 'imported';

export type SkillScope = { type: 'global' } | { type: 'bots'; botIds: string[] };

export interface UserSkillRecord {
  name: string;
  description: string;
  version: string;
  status: UserSkillStatus;
  scope: SkillScope;
  source: UserSkillSource;
  /**
   * Full SKILL.md body for draft proposals that have not been materialized
   * to a file yet. Materialized skills live in
   * `<skillsDir>/<name>/SKILL.md`; this stays undefined for them.
   */
  draftContent?: string;
  /** Approval card id raised for a learned proposal (drafts only). */
  approvalId?: string;
  createdByBot?: string;
  createdAt: string;
  updatedAt: string;
  reviewedAt?: string;
  reviewedBy?: string;
}

export class SkillNameError extends Error {}
export class SkillExistsError extends Error {}
export class SkillNotFoundError extends Error {}
export class SkillStateError extends Error {}
export { SkillNotUsableError };

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
const MAX_DESCRIPTION = 500;
const MAX_INSTRUCTIONS = 50_000;
const MAX_EXAMPLES = 10_000;

/** Validate a skill name. Throws SkillNameError. */
export function validateSkillName(name: unknown): string {
  if (typeof name !== 'string' || !name.trim()) {
    throw new SkillNameError('Skill name is required.');
  }
  const trimmed = name.trim().toLowerCase();
  if (!NAME_RE.test(trimmed)) {
    throw new SkillNameError(
      `Invalid skill name "${name}": use 3-64 chars of lowercase letters, digits, and hyphens, starting and ending with a letter or digit.`,
    );
  }
  return trimmed;
}

function nonEmptyString(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new SkillNameError(`Skill "${field}" is required and must be a non-empty string.`);
  }
  if (value.trim().length > max) {
    throw new SkillNameError(`Skill "${field}" is too long (max ${max} chars).`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new SkillNameError(`Skill "${field}" must be a string.`);
  if (value.length > max) throw new SkillNameError(`Skill "${field}" is too long (max ${max} chars).`);
  const t = value.trim();
  return t ? t : undefined;
}

/** Parse the `scope` argument: 'global' (default) or an array of bot ids. */
export function parseSkillScope(scope: unknown): SkillScope {
  if (scope === undefined || scope === null || scope === 'global') return { type: 'global' };
  if (Array.isArray(scope)) {
    const botIds = scope
      .filter((b): b is string => typeof b === 'string' && b.trim() !== '')
      .map((b) => b.trim());
    if (botIds.length === 0) throw new SkillNameError('Skill scope bot list must not be empty.');
    if (botIds.length > 50) throw new SkillNameError('Skill scope supports at most 50 bots.');
    return { type: 'bots', botIds: [...new Set(botIds)] };
  }
  throw new SkillNameError('Skill scope must be "global" or an array of bot ids.');
}

function scopeToJson(scope: SkillScope): string {
  return JSON.stringify(scope);
}

function scopeFromJson(raw: string): SkillScope {
  try {
    const parsed = JSON.parse(raw) as SkillScope;
    if (parsed && parsed.type === 'bots' && Array.isArray((parsed as { botIds?: unknown }).botIds)) {
      return { type: 'bots', botIds: (parsed as { botIds: string[] }).botIds };
    }
    return { type: 'global' };
  } catch {
    return { type: 'global' };
  }
}

/**
 * Render the SKILL.md file body: YAML frontmatter (name, description,
 * version) + instructions + optional examples section.
 */
export function renderSkillFile(input: {
  name: string;
  description: string;
  version: string;
  instructions: string;
  examples?: string;
}): string {
  const yaml = (s: string): string => {
    // Quote when the value could confuse a YAML parser.
    return /[:#\n"']/.test(s) ? JSON.stringify(s) : s;
  };
  const lines = [
    '---',
    `name: ${yaml(input.name)}`,
    `description: ${yaml(input.description)}`,
    `version: ${yaml(input.version)}`,
    '---',
    '',
    input.instructions.trim(),
  ];
  if (input.examples && input.examples.trim()) {
    lines.push('', '## Examples', '', input.examples.trim());
  }
  lines.push('');
  return lines.join('\n');
}

export interface CreateSkillInput {
  name: string;
  description: string;
  instructions: string;
  examples?: string;
  version?: string;
  scope?: SkillScope;
  source: UserSkillSource;
  createdByBot?: string;
}

export interface CreateProposalInput extends CreateSkillInput {
  /** Optional: the observed multi-step pattern this proposal captures. */
  observedPattern?: string;
}

export interface UserSkillStoreOptions {
  /**
   * Seed skills directory. Names colliding with seed skills are rejected —
   * the seed dir wins on collisions in SkillLoader, so a user skill with the
   * same name would silently shadow nothing and confuse everyone.
   */
  seedSkillsDir?: string;
  /** Audit sink: (action, fields). Never carries skill content (may be long). */
  audit?: (action: string, fields: Record<string, unknown>) => void;
}

interface SkillRow {
  name: string;
  description: string;
  version: string;
  status: string;
  scope_json: string;
  source: string;
  draft_content: string | null;
  approval_id: string | null;
  created_by_bot: string | null;
  created_at: string;
  updated_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
}

/**
 * SQLite-backed user skill registry. Skill *files* live in `skillsDir`
 * (`<dataDir>/skills/<name>/SKILL.md`, already an additionalDir for
 * SkillLoader); this store owns status, scope, and draft proposals.
 */
export class UserSkillStore {
  private readonly db: DatabaseSyncType;
  private readonly skillsDir: string;
  private readonly seedSkillsDir?: string;
  private readonly audit?: (action: string, fields: Record<string, unknown>) => void;

  constructor(dataDir: string, skillsDir: string, opts: UserSkillStoreOptions = {}) {
    this.skillsDir = skillsDir;
    this.seedSkillsDir = opts.seedSkillsDir;
    this.audit = opts.audit;
    mkdirSync(skillsDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, 'user-skills.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_skills (
        name TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        version TEXT NOT NULL,
        status TEXT NOT NULL,
        scope_json TEXT NOT NULL,
        source TEXT NOT NULL,
        draft_content TEXT,
        approval_id TEXT,
        created_by_bot TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        reviewed_at TEXT,
        reviewed_by TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_user_skills_status ON user_skills(status);
    `);
  }

  close(): void {
    this.db.close();
  }

  private now(): string {
    return new Date().toISOString();
  }

  private emit(action: string, fields: Record<string, unknown>): void {
    try {
      this.audit?.(action, fields);
    } catch {
      // Audit must never break skill management.
    }
  }

  private rowToRecord(row: SkillRow): UserSkillRecord {
    const rec: UserSkillRecord = {
      name: row.name,
      description: row.description,
      version: row.version,
      status: row.status as UserSkillStatus,
      scope: scopeFromJson(row.scope_json),
      source: row.source as UserSkillSource,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (row.draft_content !== null) rec.draftContent = row.draft_content;
    if (row.approval_id !== null) rec.approvalId = row.approval_id;
    if (row.created_by_bot !== null) rec.createdByBot = row.created_by_bot;
    if (row.reviewed_at !== null) rec.reviewedAt = row.reviewed_at;
    if (row.reviewed_by !== null) rec.reviewedBy = row.reviewed_by;
    return rec;
  }

  get(name: string): UserSkillRecord | undefined {
    const row = this.db.prepare('SELECT * FROM user_skills WHERE name = ?').get(name) as SkillRow | undefined;
    return row ? this.rowToRecord(row) : undefined;
  }

  /** True when this name is managed by the user-skill lifecycle (any status). */
  isUserSkill(name: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM user_skills WHERE name = ?').get(name) as
      | { '1': number }
      | undefined;
    return !!row;
  }

  /**
   * Usability gate for SkillLoader: a user-managed skill is usable only when
   * active and in scope for the bot. Unknown names (seed/imported skills)
   * are not gated here — callers compose this as
   * `isUserSkill(name) ? isUsable(name, botId) : true`.
   */
  isUsable(name: string, botId?: string): boolean {
    const rec = this.get(name);
    if (!rec) return false;
    if (rec.status !== 'active') return false;
    if (rec.scope.type === 'global') return true;
    return !!botId && rec.scope.botIds.includes(botId);
  }

  list(filter: { status?: UserSkillStatus | UserSkillStatus[]; source?: UserSkillSource } = {}): UserSkillRecord[] {
    const conds: string[] = [];
    const params: string[] = [];
    if (filter.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      conds.push(`status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    }
    if (filter.source) {
      conds.push('source = ?');
      params.push(filter.source);
    }
    const rows = this.db
      .prepare(`SELECT * FROM user_skills ${conds.length ? `WHERE ${conds.join(' AND ')}` : ''} ORDER BY updated_at DESC`)
      .all(...params) as unknown as SkillRow[];
    return rows.map((r) => this.rowToRecord(r));
  }

  /** Review queue: draft proposals first, then disabled skills awaiting enable. */
  reviewQueue(): { proposals: UserSkillRecord[]; disabled: UserSkillRecord[] } {
    return {
      proposals: this.list({ status: 'draft' }),
      disabled: this.list({ status: 'disabled' }),
    };
  }

  /** Skill file path for a materialized skill. */
  skillFilePath(name: string): string {
    return join(this.skillsDir, name, 'SKILL.md');
  }

  private assertNameFree(name: string): void {
    if (this.isUserSkill(name)) {
      throw new SkillExistsError(`A skill named "${name}" already exists. Pick another name or delete it first.`);
    }
    // Seed-dir collision: SkillLoader prefers the seed dir, so a user file
    // with the same name would be silently ignored — reject loudly instead.
    if (this.seedSkillsDir) {
      const seedFile = join(this.seedSkillsDir, name, 'SKILL.md');
      const seedFlat = join(this.seedSkillsDir, `${name}.md`);
      if (existsSync(seedFile) || existsSync(seedFlat)) {
        throw new SkillExistsError(
          `A built-in skill named "${name}" already exists. User skills cannot shadow built-in skills.`,
        );
      }
    }
    // Also reject collisions with any on-disk user skill not tracked in the
    // DB (e.g. agent-imported skills): overwriting them would be data loss.
    const userFile = join(this.skillsDir, name, 'SKILL.md');
    const userFlat = join(this.skillsDir, `${name}.md`);
    if (existsSync(userFile) || existsSync(userFlat)) {
      throw new SkillExistsError(
        `A skill file named "${name}" already exists in the user skills directory (possibly imported). Delete or rename it first.`,
      );
    }
  }

  private sanitizeVersion(version: unknown): string {
    if (version === undefined || version === null) return '1.0.0';
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+([-.+][0-9A-Za-z.-]+)?$/.test(version.trim())) {
      throw new SkillNameError('Skill version must look like semver (e.g. "1.0.0").');
    }
    return version.trim();
  }

  private writeSkillFile(rec: { name: string; description: string; version: string }, instructions: string, examples?: string): void {
    const dir = join(this.skillsDir, rec.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), renderSkillFile({ ...rec, instructions, examples }), 'utf8');
  }

  /**
   * Create a skill from an explicit authoring flow (agent `create_skill`
   * tool, API, or web UI). The skill is written to disk immediately but
   * ALWAYS starts DISABLED — a human must enable it before any bot can
   * use it.
   */
  createSkill(input: CreateSkillInput): UserSkillRecord {
    const name = validateSkillName(input.name);
    const description = nonEmptyString(input.description, 'description', MAX_DESCRIPTION);
    const instructions = nonEmptyString(input.instructions, 'instructions', MAX_INSTRUCTIONS);
    const examples = optionalString(input.examples, 'examples', MAX_EXAMPLES);
    const version = this.sanitizeVersion(input.version);
    const scope = input.scope ?? { type: 'global' as const };
    this.assertNameFree(name);

    const ts = this.now();
    this.writeSkillFile({ name, description, version }, instructions, examples);
    this.db
      .prepare(
        `INSERT INTO user_skills
           (name, description, version, status, scope_json, source, draft_content, approval_id,
            created_by_bot, created_at, updated_at, reviewed_at, reviewed_by)
         VALUES (?, ?, ?, 'disabled', ?, ?, NULL, NULL, ?, ?, ?, NULL, NULL)`,
      )
      .run(name, description, version, scopeToJson(scope), input.source, input.createdByBot ?? null, ts, ts);
    this.emit('skill.created', { name, source: input.source, status: 'disabled', botId: input.createdByBot });
    const rec = this.get(name);
    if (!rec) throw new Error(`createSkill: failed to read back "${name}"`);
    return rec;
  }

  /**
   * Create a learned-skill proposal. Nothing is written to the skills
   * directory — the proposal text is stored in the DB as a draft until a
   * human approves it.
   */
  createProposal(input: CreateProposalInput): UserSkillRecord {
    const name = validateSkillName(input.name);
    const description = nonEmptyString(input.description, 'description', MAX_DESCRIPTION);
    const instructions = nonEmptyString(input.instructions, 'instructions', MAX_INSTRUCTIONS);
    const examples = optionalString(input.examples, 'examples', MAX_EXAMPLES);
    const version = this.sanitizeVersion(input.version);
    const scope = input.scope ?? { type: 'global' as const };
    this.assertNameFree(name);

    let draft = renderSkillFile({ name, description, version, instructions, examples });
    const observed = optionalString(input.observedPattern, 'observedPattern', 5000);
    if (observed) {
      draft += `\n<!-- Learned from observed pattern (not part of the skill):\n${observed}\n-->\n`;
    }

    const ts = this.now();
    this.db
      .prepare(
        `INSERT INTO user_skills
           (name, description, version, status, scope_json, source, draft_content, approval_id,
            created_by_bot, created_at, updated_at, reviewed_at, reviewed_by)
         VALUES (?, ?, ?, 'draft', ?, 'learned', ?, NULL, ?, ?, ?, NULL, NULL)`,
      )
      .run(name, description, version, scopeToJson(scope), draft, input.createdByBot ?? null, ts, ts);
    this.emit('skill.proposal_created', { name, status: 'draft', botId: input.createdByBot });
    const rec = this.get(name);
    if (!rec) throw new Error(`createProposal: failed to read back "${name}"`);
    return rec;
  }

  attachApproval(name: string, approvalId: string): void {
    const rec = this.get(name);
    if (!rec) throw new SkillNotFoundError(`Unknown skill: "${name}"`);
    if (rec.status !== 'draft') throw new SkillStateError(`Only draft proposals take approvals (skill "${name}" is ${rec.status}).`);
    this.db.prepare('UPDATE user_skills SET approval_id = ?, updated_at = ? WHERE name = ?').run(approvalId, this.now(), name);
  }

  /**
   * Materialize an approved draft proposal into a real (DISABLED) skill:
   * the file is written and the status moves draft → disabled. Still needs
   * an explicit enable before any bot can use it.
   */
  materializeProposal(name: string, reviewedBy: string): UserSkillRecord {
    const rec = this.get(name);
    if (!rec) throw new SkillNotFoundError(`Unknown skill: "${name}"`);
    if (rec.status !== 'draft') throw new SkillStateError(`Only draft proposals can be approved (skill "${name}" is ${rec.status}).`);
    if (!rec.draftContent) throw new SkillStateError(`Proposal "${name}" has no draft content.`);
    const dir = join(this.skillsDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), rec.draftContent, 'utf8');
    const ts = this.now();
    this.db
      .prepare('UPDATE user_skills SET status = ?, reviewed_at = ?, reviewed_by = ?, updated_at = ? WHERE name = ?')
      .run('disabled', ts, reviewedBy, ts, name);
    this.emit('skill.proposal_approved', { name, status: 'disabled', reviewedBy });
    const out = this.get(name);
    if (!out) throw new Error(`materializeProposal: failed to read back "${name}"`);
    return out;
  }

  /** Reject a draft proposal (terminal). */
  rejectProposal(name: string, reviewedBy: string): UserSkillRecord {
    const rec = this.get(name);
    if (!rec) throw new SkillNotFoundError(`Unknown skill: "${name}"`);
    if (rec.status !== 'draft') throw new SkillStateError(`Only draft proposals can be rejected (skill "${name}" is ${rec.status}).`);
    const ts = this.now();
    this.db
      .prepare('UPDATE user_skills SET status = ?, reviewed_at = ?, reviewed_by = ?, updated_at = ? WHERE name = ?')
      .run('rejected', ts, reviewedBy, ts, name);
    this.emit('skill.proposal_rejected', { name, reviewedBy });
    const out = this.get(name);
    if (!out) throw new Error(`rejectProposal: failed to read back "${name}"`);
    return out;
  }

  /** Enable a disabled skill: disabled → active. */
  enable(name: string, reviewedBy: string): UserSkillRecord {
    return this.transition(name, 'disabled', 'active', reviewedBy, 'skill.enabled');
  }

  /** Disable an active skill: active → disabled. Takes effect on next turn. */
  disable(name: string, reviewedBy: string): UserSkillRecord {
    return this.transition(name, 'active', 'disabled', reviewedBy, 'skill.disabled');
  }

  private transition(
    name: string,
    from: UserSkillStatus,
    to: UserSkillStatus,
    reviewedBy: string,
    auditAction: string,
  ): UserSkillRecord {
    const rec = this.get(name);
    if (!rec) throw new SkillNotFoundError(`Unknown skill: "${name}"`);
    if (rec.status !== from) {
      throw new SkillStateError(`Cannot move skill "${name}" from ${rec.status} to ${to} (must be ${from}).`);
    }
    const ts = this.now();
    this.db
      .prepare('UPDATE user_skills SET status = ?, reviewed_at = ?, reviewed_by = ?, updated_at = ? WHERE name = ?')
      .run(to, ts, reviewedBy, ts, name);
    this.emit(auditAction, { name, from, to, reviewedBy });
    const out = this.get(name);
    if (!out) throw new Error(`transition: failed to read back "${name}"`);
    return out;
  }

  /** Update description / scope / version / file content of a saved skill. */
  updateSkill(
    name: string,
    patch: { description?: string; instructions?: string; examples?: string; version?: string; scope?: SkillScope },
  ): UserSkillRecord {
    const rec = this.get(name);
    if (!rec) throw new SkillNotFoundError(`Unknown skill: "${name}"`);
    if (rec.status === 'draft' || rec.status === 'rejected') {
      throw new SkillStateError(`Cannot edit a ${rec.status} proposal via updateSkill.`);
    }
    const description = patch.description !== undefined ? nonEmptyString(patch.description, 'description', MAX_DESCRIPTION) : rec.description;
    const version = patch.version !== undefined ? this.sanitizeVersion(patch.version) : rec.version;
    const scope = patch.scope ?? rec.scope;
    // Re-render the file only when content-level fields change.
    if (patch.instructions !== undefined || patch.examples !== undefined || patch.description !== undefined || patch.version !== undefined) {
      const current = this.readSkillFileContent(name);
      const instructions = patch.instructions !== undefined ? nonEmptyString(patch.instructions, 'instructions', MAX_INSTRUCTIONS) : current.instructions;
      const examples = patch.examples !== undefined ? optionalString(patch.examples, 'examples', MAX_EXAMPLES) : current.examples;
      this.writeSkillFile({ name, description, version }, instructions, examples);
    }
    const ts = this.now();
    this.db
      .prepare('UPDATE user_skills SET description = ?, version = ?, scope_json = ?, updated_at = ? WHERE name = ?')
      .run(description, version, scopeToJson(scope), ts, name);
    this.emit('skill.updated', { name, fields: Object.keys(patch) });
    const out = this.get(name);
    if (!out) throw new Error(`updateSkill: failed to read back "${name}"`);
    return out;
  }

  /** Read back the on-disk file, split into instructions/examples. */
  readSkillFileContent(name: string): { instructions: string; examples?: string } {
    const file = this.skillFilePath(name);
    if (!existsSync(file)) throw new SkillNotFoundError(`Skill file missing for "${name}"`);
    const raw = readFileSync(file, 'utf8');
    // Strip frontmatter.
    const body = raw.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
    const exIdx = body.indexOf('## Examples');
    if (exIdx === -1) return { instructions: body };
    return {
      instructions: body.slice(0, exIdx).trim(),
      examples: body.slice(exIdx + '## Examples'.length).trim() || undefined,
    };
  }

  /** Delete a skill entirely: DB record + on-disk file. */
  deleteSkill(name: string, deletedBy: string): void {
    const rec = this.get(name);
    if (!rec) throw new SkillNotFoundError(`Unknown skill: "${name}"`);
    if (rec.status === 'active') {
      throw new SkillStateError(`Disable skill "${name}" before deleting it.`);
    }
    const dir = join(this.skillsDir, name);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    this.db.prepare('DELETE FROM user_skills WHERE name = ?').run(name);
    this.emit('skill.deleted', { name, deletedBy });
  }

  /**
   * Reconcile draft proposals against the governance approval store: an
   * approved card auto-materializes the proposal (as disabled); a
   * denied/expired card rejects it. Called on review-queue reads so the
   * inbox approval path needs no background poller.
   */
  reconcileDrafts(
    getApprovalStatus: (approvalId: string) => 'pending' | 'approved' | 'denied' | 'expired' | undefined,
    actor = 'system',
  ): { materialized: string[]; rejected: string[] } {
    const materialized: string[] = [];
    const rejected: string[] = [];
    for (const draft of this.list({ status: 'draft' })) {
      if (!draft.approvalId) continue;
      let status: 'pending' | 'approved' | 'denied' | 'expired' | undefined;
      try {
        status = getApprovalStatus(draft.approvalId);
      } catch {
        continue;
      }
      if (status === 'approved') {
        this.materializeProposal(draft.name, actor);
        materialized.push(draft.name);
      } else if (status === 'denied' || status === 'expired') {
        this.rejectProposal(draft.name, actor);
        rejected.push(draft.name);
      }
    }
    return { materialized, rejected };
  }
}

// ---------------------------------------------------------------------------
// Agent tools
// ---------------------------------------------------------------------------

/** Minimal approval-card hooks the host wires from its governance gateway. */
export interface SkillApprovalHooks {
  requestApproval(
    toolName: string,
    args: Record<string, unknown>,
    ctx: { sessionId: string; botId: string; actor: string },
  ): string;
}

export interface SkillAuthoringToolOptions {
  store: UserSkillStore;
  /** Approval hooks for the learn_skill proposal card. Without them the
   * proposal is still created as a draft (reviewable in the queue), but no
   * inbox card is raised. */
  approval?: SkillApprovalHooks;
}

const SCOPE_SCHEMA = {
  oneOf: [
    { type: 'string', enum: ['global'] },
    { type: 'array', items: { type: 'string' }, maxItems: 50 },
  ],
  description: 'Who may use the skill once enabled: "global" (default) or a list of bot ids.',
};

function asScope(value: unknown): SkillScope {
  if (value === undefined) return { type: 'global' };
  return parseSkillScope(value);
}

/**
 * Agent-facing skill authoring tools. Both are registered like any other
 * registry tool, so deny-by-default governance applies; the default policy
 * auto-allows them because their outputs are inert until a human acts
 * (create_skill → disabled; learn_skill → draft proposal + approval card).
 */
export function createSkillAuthoringTools(opts: SkillAuthoringToolOptions): ToolDefinition[] {
  const { store, approval } = opts;

  const createSkill: ToolDefinition = {
    name: 'create_skill',
    description:
      'Author a new skill (a reusable bundle of instructions for a task or domain) and save it to the local skill store. ' +
      'The skill is saved DISABLED: no bot can use it until a human explicitly enables it in Marketplace → Skills. ' +
      'Use this when the user asks you to create/save a skill. Prefer learn_skill when you noticed a reusable pattern yourself.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name: 3-64 chars, lowercase letters/digits/hyphens (e.g. "pdf-triage").' },
        description: { type: 'string', description: 'One-line summary shown in the skill list (max 500 chars).' },
        instructions: { type: 'string', description: 'The full skill instructions (the SKILL.md body).' },
        examples: { type: 'string', description: 'Optional usage examples, appended under "## Examples".' },
        version: { type: 'string', description: 'Semver version, default "1.0.0".' },
        scope: SCOPE_SCHEMA,
      },
      required: ['name', 'description', 'instructions'],
      additionalProperties: false,
    },
    mutating: true,
    handler: async (args, ctx: ToolContext) => {
      const rec = store.createSkill({
        name: args['name'] as string,
        description: args['description'] as string,
        instructions: args['instructions'] as string,
        examples: args['examples'] as string | undefined,
        version: args['version'] as string | undefined,
        scope: asScope(args['scope']),
        source: 'agent-created',
        createdByBot: ctx.botId,
      });
      return {
        ok: true,
        name: rec.name,
        status: rec.status,
        message:
          `Skill "${rec.name}" created and saved DISABLED. It cannot be used by any bot until a human enables ` +
          `it (Marketplace → Skills → Enable). Tell the user it is ready for review.`,
      };
    },
  };

  const learnSkill: ToolDefinition = {
    name: 'learn_skill',
    description:
      'Propose a new skill learned from a successful multi-step interaction you just completed. ' +
      'This does NOT save a skill: it creates a DRAFT proposal for human review and raises an approval card. ' +
      'Only after a human approves is it saved — and even then it starts DISABLED until explicitly enabled. ' +
      'Use sparingly, only for genuinely reusable patterns.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name: 3-64 chars, lowercase letters/digits/hyphens.' },
        description: { type: 'string', description: 'One-line summary (max 500 chars).' },
        observedPattern: {
          type: 'string',
          description: 'What you observed: the multi-step pattern this skill captures (kept as a review note, not part of the skill).',
        },
        instructions: { type: 'string', description: 'The proposed full skill instructions.' },
        examples: { type: 'string', description: 'Optional usage examples.' },
        version: { type: 'string', description: 'Semver version, default "1.0.0".' },
        scope: SCOPE_SCHEMA,
      },
      required: ['name', 'description', 'observedPattern', 'instructions'],
      additionalProperties: false,
    },
    mutating: true,
    handler: async (args, ctx: ToolContext) => {
      const proposal = store.createProposal({
        name: args['name'] as string,
        description: args['description'] as string,
        observedPattern: args['observedPattern'] as string | undefined,
        instructions: args['instructions'] as string,
        examples: args['examples'] as string | undefined,
        version: args['version'] as string | undefined,
        scope: asScope(args['scope']),
        source: 'learned',
        createdByBot: ctx.botId,
      });
      let approvalId: string | undefined;
      if (approval) {
        try {
          approvalId = approval.requestApproval(
            'learn_skill',
            {
              proposal: proposal.name,
              description: proposal.description,
              proposedBy: ctx.botId,
              instructionsPreview: (args['instructions'] as string).slice(0, 2000),
            },
            { sessionId: ctx.sessionId, botId: ctx.botId, actor: ctx.botId },
          );
          store.attachApproval(proposal.name, approvalId);
        } catch {
          // A broker failure must not lose the proposal: it stays a draft
          // in the review queue.
          approvalId = undefined;
        }
      }
      return {
        ok: true,
        proposal: proposal.name,
        status: 'draft',
        ...(approvalId ? { approvalId } : {}),
        message:
          `Learned-skill proposal "${proposal.name}" saved as a DRAFT for human review` +
          (approvalId ? ' (approval card raised in the inbox).' : ' (no approval broker: review it in Marketplace → Skills).') +
          ' Nothing is usable until a human approves the proposal AND enables the skill.',
      };
    },
  };

  return [createSkill, learnSkill];
}

/** Narrow JSON view of a record for API/UI (never includes draft bodies by default). */
export function serializeUserSkill(rec: UserSkillRecord, opts: { includeDraft?: boolean } = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: rec.name,
    description: rec.description,
    version: rec.version,
    status: rec.status,
    scope: rec.scope,
    source: rec.source,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
  };
  if (rec.createdByBot) out.createdByBot = rec.createdByBot;
  if (rec.approvalId) out.approvalId = rec.approvalId;
  if (rec.reviewedAt) out.reviewedAt = rec.reviewedAt;
  if (rec.reviewedBy) out.reviewedBy = rec.reviewedBy;
  if (opts.includeDraft && rec.draftContent) out.draftContent = rec.draftContent;
  return out;
}

/** Unique id for proposal tracking in logs (not a secret). */
export function newProposalId(): string {
  return `skp_${randomUUID().slice(0, 8)}`;
}
