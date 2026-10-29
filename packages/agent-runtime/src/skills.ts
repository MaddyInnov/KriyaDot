// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import type { SchemaDriftApprovalBroker } from './mcp.js';
import type { ToolDefinition, TurnValidatorSpec } from './types.js';
import { parseValidatorSpecs } from './validators.js';

// vitest (Vite 5.4.21) cannot statically resolve the `node:sqlite` specifier,
// so load it at runtime via the builtin-module API instead of a top-level import.
import { openDb } from './sqlite.js';
import type { DatabaseSync } from 'node:sqlite';
type DatabaseSyncType = DatabaseSync;

/**
 * Progressive disclosure: the system prompt carries only name+description
 * summaries (cheap); the model pulls full skill content on demand through
 * the `read_skill` tool (see createSkillTools). Full loads are TOFU-pinned:
 * the content hash is pinned at first load and later drift is gated behind
 * a human approval — same pattern Phase 1 used for MCP schema pinning.
 */

export interface SkillSummary {
  name: string;
  description: string;
}

export interface LoadedSkill {
  name: string;
  description: string;
  content: string;
  /** sha256 of the trimmed content, for provenance pinning. */
  sha256: string;
  /** End-of-turn validators declared in frontmatter (Octomind parity). */
  validators?: TurnValidatorSpec[];
}

export interface SkillPin {
  name: string;
  contentSha256: string;
  pinnedAt: string;
}

/**
 * Thrown when a skill exists but must not be used: disabled/draft/rejected
 * status, or out of scope for the requesting bot. The runtime treats this
 * like a missing skill (skips disclosure); `read_skill` surfaces it as a
 * clear error.
 */
export class SkillNotUsableError extends Error {}

export interface SkillLoaderOptions {
  /**
   * SQLite path for the TOFU pin store (`<dataDir>/skill-pins.db`). When
   * set, skill content is pinned at first loadFull and drift is gated
   * behind approval. When unset, pinning is disabled and behaviour is
   * unchanged from before.
   */
  pinDbPath?: string;
  /** Broker used to request human approval on skill drift. Without one, drifted skills fail closed. */
  approvalBroker?: SchemaDriftApprovalBroker;
  /** Identity attached to drift approval records. */
  sessionId?: string;
  botId?: string;
  actor?: string;
  /** Timeout for awaiting a drift approval decision; broker default applies when unset. */
  approvalTimeoutMs?: number;
  /**
   * Extra skill directories searched after `skillsDir` (e.g. user-imported
   * skills under `<dataDir>/skills`). Name collisions resolve to the primary
   * `skillsDir` first. Additive and backward compatible.
   */
  additionalDirs?: string[];
  /**
   * Usability gate (OpenMausBot parity P1 #20, disabled-by-default skills).
   * Called with the skill name and the requesting bot id; return false to
   * make the skill invisible (getSummary skips, loadFull/load throw
   * SkillNotUsableError). Unset → every found skill is usable (previous
   * behaviour). The host wires e.g.
   * `(name, botId) => store.isUserSkill(name) ? store.isUsable(name, botId) : true`
   * so seed/imported skills keep working while user-managed skills are
   * gated on active status + scope.
   */
  usabilityGate?: (name: string, botId?: string) => boolean;
}

/** SQLite TOFU pin store for skill content hashes (one row per skill name). */
export class SkillPinStore {
  private readonly db: DatabaseSyncType;

  constructor(dbPath: string) {
    this.db = openDb(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skill_pins (
        skill_name TEXT PRIMARY KEY,
        content_sha256 TEXT NOT NULL,
        pinned_at TEXT NOT NULL
      );
    `);
  }

  getPin(name: string): SkillPin | undefined {
    const row = this.db
      .prepare('SELECT skill_name, content_sha256, pinned_at FROM skill_pins WHERE skill_name = ?')
      .get(name) as
      | { skill_name: string; content_sha256: string; pinned_at: string }
      | undefined;
    if (!row) return undefined;
    return { name: row.skill_name, contentSha256: row.content_sha256, pinnedAt: row.pinned_at };
  }

  /** Insert a new pin or replace the existing one (first pin and approved drift). */
  upsertPin(name: string, sha256: string): void {
    this.db
      .prepare(
        `INSERT INTO skill_pins (skill_name, content_sha256, pinned_at)
         VALUES (?, ?, ?)
         ON CONFLICT(skill_name) DO UPDATE SET content_sha256 = excluded.content_sha256, pinned_at = excluded.pinned_at`,
      )
      .run(name, sha256, new Date().toISOString());
  }

  close(): void {
    this.db.close();
  }
}

interface RawSkill {
  name: string;
  description: string;
  content: string;
  /** End-of-turn validators declared in frontmatter (Octomind parity). */
  validators: TurnValidatorSpec[];
}

/**
 * Loads skill definitions from a directory. A skill is either
 * `<skillsDir>/<name>.md` or `<skillsDir>/<name>/SKILL.md`,
 * with YAML frontmatter (name, description) parsed via gray-matter.
 */
export class SkillLoader {
  private readonly pinStore: SkillPinStore | null;
  /**
   * Summary cache: skill name → { mtimeMs, size, summary }. getSummary is
   * called per skill per turn; without this it's 2+ sync file ops per skill
   * per turn. Invalidated on mtime/size change.
   */
  private readonly summaryCache = new Map<string, { mtimeMs: number; size: number; summary: SkillSummary }>();

  constructor(
    private readonly skillsDir: string,
    private readonly options: SkillLoaderOptions = {},
  ) {
    this.pinStore = options.pinDbPath ? new SkillPinStore(options.pinDbPath) : null;
  }

  /** Release the pin-store SQLite connection (no-op when pinning is off). */
  close(): void {
    this.pinStore?.close();
  }

  list(): string[] {
    const names = new Set<string>();
    for (const dir of [this.skillsDir, ...(this.options.additionalDirs ?? [])]) {
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.md')) {
          names.add(entry.name.slice(0, -3));
        } else if (entry.isDirectory() && existsSync(join(dir, entry.name, 'SKILL.md'))) {
          names.add(entry.name);
        }
      }
    }
    return [...names].sort();
  }

  /**
   * Cheap summary for system-prompt disclosure: name + description only,
   * no full content. (The file is still read for frontmatter — "cheap"
   * means nothing but the summary enters the prompt.)
   *
   * When a usabilityGate is configured and the skill is not usable for
   * `botId` (disabled or out of scope), this throws SkillNotUsableError so
   * the caller can skip disclosure — disabled skills never reach a prompt.
   */
  async getSummary(name: string, botId?: string): Promise<SkillSummary> {
    const file = this.skillFile(name);
    if (file) {
      try {
        const s = statSync(file);
        const cached = this.summaryCache.get(name);
        if (cached && cached.mtimeMs === s.mtimeMs && cached.size === s.size) {
          this.assertUsable(cached.summary.name, botId);
          return cached.summary;
        }
        const raw = this.readSkillFile(file, name);
        this.assertUsable(raw.name, botId);
        const summary = { name: raw.name, description: raw.description };
        this.summaryCache.set(name, { mtimeMs: s.mtimeMs, size: s.size, summary });
        return summary;
      } catch (err) {
        // SkillNotUsableError must propagate (it is the gate); anything
        // else falls through to the uncached path below.
        if (err instanceof SkillNotUsableError) throw err;
      }
    }
    const raw = this.readSkill(name);
    this.assertUsable(raw.name, botId);
    return { name: raw.name, description: raw.description };
  }

  /** Enforce the usability gate; throws SkillNotUsableError when blocked. */
  private assertUsable(resolvedName: string, botId?: string): void {
    const gate = this.options.usabilityGate;
    if (gate && !gate(resolvedName, botId)) {
      throw new SkillNotUsableError(
        `Skill "${resolvedName}" is not usable${botId ? ` for bot "${botId}"` : ''} (disabled, not yet reviewed, or out of scope).`,
      );
    }
  }

  /**
   * Full skill load with TOFU provenance pinning. First load pins the
   * content hash; later drift requests human approval through the injected
   * broker — approved drift re-pins, denied/timed-out/broker-less drift
   * fails closed (throws).
   *
   * The usability gate applies first: disabled/out-of-scope skills throw
   * SkillNotUsableError before any content is returned.
   */
  async loadFull(name: string, botId?: string): Promise<LoadedSkill> {
    const raw = this.readSkill(name);
    this.assertUsable(raw.name, botId);
    const sha256 = createHash('sha256').update(raw.content, 'utf8').digest('hex');
    await this.checkPin(raw.name, sha256);
    return { ...raw, sha256 };
  }

  /**
   * Backward-compatible full load. Delegates to loadFull (so pinning
   * applies when a pin store is configured); the returned sha256 is new
   * but purely additive for existing callers.
   */
  async load(name: string, botId?: string): Promise<LoadedSkill> {
    return this.loadFull(name, botId);
  }

  private readSkill(name: string): RawSkill {
    const file = this.skillFile(name);
    if (!file) throw new Error(`Skill not found: "${name}" (looked in ${this.skillsDir})`);
    return this.readSkillFile(file, name);
  }

  /** Resolve the skill file path without reading it (for cache validation). */
  private skillFile(name: string): string | null {
    for (const dir of [this.skillsDir, ...(this.options.additionalDirs ?? [])]) {
      const candidates = [join(dir, name, 'SKILL.md'), join(dir, `${name}.md`)];
      const found = candidates.find((c) => existsSync(c));
      if (found) return found;
    }
    return null;
  }

  private readSkillFile(file: string, name: string): RawSkill {
    const parsed = matter(readFileSync(file, 'utf8'));
    const data = parsed.data as Record<string, unknown>;
    return {
      name: typeof data.name === 'string' && data.name ? data.name : name,
      description: typeof data.description === 'string' ? data.description : '',
      content: parsed.content.trim(),
      validators: parseValidatorSpecs(data.validators),
    };
  }

  /**
   * Validators a skill declares in its frontmatter (`validators:`),
   * parsed into turn-validator specs. The runtime runs these at end of
   * turn for bots that loaded the skill. Sync + gate-free by design: it
   * only reads the declarations, never the gated content path.
   */
  getValidators(name: string): TurnValidatorSpec[] {
    try {
      return this.readSkill(name).validators;
    } catch {
      return [];
    }
  }

  /**
   * Skill packs (Octomind parity): a directory skill (`<name>/SKILL.md`)
   * may carry `scripts/`, `references/` and `assets/` subdirectories.
   * Returns the pack directory (null for single-file skills) so hosts
   * can resolve pack resources.
   */
  getPackDir(name: string): string | null {
    const file = this.skillFile(name);
    if (!file || !file.endsWith('SKILL.md')) return null;
    return join(file, '..');
  }

  /** List a pack's resource files by kind (empty for single-file skills). */
  listPackResources(name: string): { scripts: string[]; references: string[]; assets: string[] } {
    const out = { scripts: [] as string[], references: [] as string[], assets: [] as string[] };
    const dir = this.getPackDir(name);
    if (!dir) return out;
    for (const kind of ['scripts', 'references', 'assets'] as const) {
      const sub = join(dir, kind);
      try {
        out[kind] = readdirSync(sub, { withFileTypes: true })
          .filter((e) => e.isFile())
          .map((e) => e.name)
          .sort();
      } catch {
        // Missing subdir = no resources of that kind.
      }
    }
    return out;
  }

  private async checkPin(name: string, sha256: string): Promise<void> {
    if (!this.pinStore) return; // pinning disabled: behaviour unchanged
    const pin = this.pinStore.getPin(name);
    if (!pin) {
      this.pinStore.upsertPin(name, sha256);
      return;
    }
    if (pin.contentSha256 === sha256) return;

    // Drift: the skill file changed since it was pinned.
    const broker = this.options.approvalBroker;
    if (!broker) {
      throw new Error(
        `Skill "${name}" changed since it was pinned (drift) and no approval broker is configured — failing closed. ` +
          `Approve the change via the pin store or delete the pin to re-pin at next load.`,
      );
    }
    const ctx = {
      sessionId: this.options.sessionId ?? 'skill-pinning',
      botId: this.options.botId ?? 'system',
      actor: this.options.actor ?? 'system',
    };
    const approvalId = broker.requestApproval(
      `skill:${name}`,
      { skill: name, pinnedSha256: pin.contentSha256, currentSha256: sha256 },
      ctx,
    );
    let verdict: 'approved' | 'denied';
    try {
      verdict = await broker.awaitDecision(approvalId, this.options.approvalTimeoutMs);
    } catch {
      verdict = 'denied'; // timeout / broker error: fail closed
    }
    if (verdict !== 'approved') {
      throw new Error(
        `Skill "${name}" changed since it was pinned and the change was not approved — failing closed.`,
      );
    }
    this.pinStore.upsertPin(name, sha256);
  }
}

/**
 * On-demand skill disclosure tool. The host wires the returned definitions
 * into the tool registry (top-coordinator wiring); the runtime mentions
 * `read_skill` in the system prompt when it is registered, so the model
 * pulls full skill content only when it needs it.
 *
 * Governance note: under the default deny-by-default policy this tool
 * requires human approval like any non-read tool; add a `^read_skill$`
 * allow rule (global or per-bot) if you want it to auto-run. Skill files
 * are local, human-authored content — tool results still carry the
 * untrusted-output tags per the Phase 1 injection floor.
 */
export function createSkillTools(skillLoader: SkillLoader): ToolDefinition[] {
  return [
    {
      name: 'read_skill',
      description:
        'Read the full content of a skill by name. Skill summaries (name + description) are ' +
        'listed in your system prompt; call this tool to load a skill\u2019s full instructions ' +
        'before relying on it.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Skill name, exactly as shown in the system prompt summaries.',
          },
        },
        required: ['name'],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const name = args['name'];
        if (typeof name !== 'string' || !name.trim()) {
          throw new Error('read_skill: "name" is required');
        }
        // P1 #20: disabled/out-of-scope skills fail closed here too — the
        // usability gate throws SkillNotUsableError before content loads.
        const skill = await skillLoader.loadFull(name.trim(), ctx?.botId);
        return {
          name: skill.name,
          description: skill.description,
          content: skill.content,
          sha256: skill.sha256,
        };
      },
    },
  ];
}
