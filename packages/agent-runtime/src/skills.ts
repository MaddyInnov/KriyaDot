// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import type { SchemaDriftApprovalBroker } from './mcp.js';
import type { ToolDefinition, TurnValidatorSpec } from './types.js';
import { parseValidatorSpecs } from './validators.js';
import { expandShellInjections, type ShellInjectionGate, type ShellInjectionRunner } from './dynamic-context.js';

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
 *
 * Environment gating (#123): frontmatter `requiredEnv: [KEY_A, KEY_B]`
 * declares env keys the skill needs. A skill whose keys are missing is
 * SKIPPED at load/activation (getSummary/loadFull throw
 * SkillNotUsableError; the reason is recorded in getSkippedSkills()) —
 * it never surfaces as a call-time failure mid-workflow.
 */

export interface SkillSummary {
  name: string;
  description: string;
}

/**
 * Invocation control (CA-16): who may activate a skill.
 *  - 'user'  — only when the user explicitly invokes it (frontmatter
 *              `invocation: user`, or `disable-model-invocation: true`).
 *              Model auto-activation paths (declarative rules, semantic
 *              matching) must skip it.
 *  - 'model' — model-only; hidden from user invocation lists.
 *  - 'both'  — default: either side may activate it.
 */
export type SkillInvocation = 'user' | 'model' | 'both';

/** Execution context (CA-16): inline in the current turn, or forked. */
export type SkillContext = 'inline' | 'fork';

export function parseSkillInvocation(data: Record<string, unknown>): SkillInvocation {
  const raw = data['invocation'];
  if (raw === 'user' || raw === 'model' || raw === 'both') return raw;
  if (data['disable-model-invocation'] === true || data['disableModelInvocation'] === true) return 'user';
  return 'both';
}

export function parseSkillContext(data: Record<string, unknown>): SkillContext {
  return data['context'] === 'fork' ? 'fork' : 'inline';
}

export interface LoadedSkill {
  name: string;
  description: string;
  content: string;
  /** sha256 of the trimmed content, for provenance pinning. */
  sha256: string;
  /** End-of-turn validators declared in frontmatter (Octomind parity). */
  validators?: TurnValidatorSpec[];
  /** Env keys the skill requires (frontmatter `requiredEnv`, #123). */
  requiredEnv?: string[];
  /** Declarative activation rules from frontmatter `activation:` (#163). */
  activation?: SkillActivationRules;
  /** Invocation control (CA-16). Default 'both'. */
  invocation?: SkillInvocation;
  /** Execution context (CA-16): 'fork' runs via delegate, isolated. */
  context?: SkillContext;
}

/** A skill skipped at load/activation because required env is missing (#123). */
export interface SkippedSkill {
  name: string;
  missingEnv: string[];
  reason: string;
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
  /**
   * Env source for `requiredEnv` gating (#123). Defaults to
   * `process.env`; injectable so hosts/tests can evaluate skills
   * against a specific environment.
   */
  env?: Record<string, string | undefined>;
  /**
   * Dynamic context injection (CA-16): when set, `` !`cmd` `` markers in
   * a skill body are expanded at loadFull time through this governed
   * shell path (see dynamic-context.ts). The gate MUST allow a command
   * before the runner sees it. Unset → markers degrade to explicit
   * not-run notes, never to execution.
   */
  dynamicContext?: { gate: ShellInjectionGate; runner: ShellInjectionRunner };
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
  /** Env keys required by frontmatter `requiredEnv` (#123). */
  requiredEnv: string[];
  /** Declarative activation rules from frontmatter `activation:` (#163). */
  activation: SkillActivationRules;
  /** Invocation control (CA-16). */
  invocation: SkillInvocation;
  /** Execution context (CA-16). */
  context: SkillContext;
}

/**
 * Declarative skill activation rules (Octomind parity #163).
 *
 * A skill may declare in frontmatter WHEN it should auto-activate,
 * evaluated deterministically per user message — no LLM involved:
 *
 * ```yaml
 * activation:
 *   keywords: [deploy, release]      # any keyword (case-insensitive substring)
 *   patterns: ["\\bship it\\b"]       # any regex (case-insensitive)
 *   exclude: [rollback, undo]        # any hit vetoes activation
 * ```
 *
 * A rule set matches when it declares at least one positive condition
 * (keyword or pattern), at least one positive condition hits, and no
 * `exclude` entry hits. A skill with NO activation block never matches
 * through this path (embedding-based activation, #139, is separate).
 * Invalid regexes are dropped at parse time (fail-safe: they simply
 * never match) rather than throwing at load.
 */
export interface SkillActivationRules {
  keywords: string[];
  patterns: string[];
  exclude: string[];
}

/** Normalize a frontmatter `activation:` value into rule lists. */
export function parseActivationRules(value: unknown): SkillActivationRules {
  const empty: SkillActivationRules = { keywords: [], patterns: [], exclude: [] };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return empty;
  const rec = value as Record<string, unknown>;
  const list = (v: unknown): string[] =>
    parseRequiredEnv(v).map((s) => s.toLowerCase());
  const patterns = parseRequiredEnv(rec.patterns).filter((p) => {
    try {
      new RegExp(p, 'i');
      return true;
    } catch {
      return false; // invalid regex: dropped, never matches
    }
  });
  return { keywords: list(rec.keywords), patterns, exclude: list(rec.exclude) };
}

/** True when `rules` declare at least one positive condition. */
export function hasActivationRules(rules: SkillActivationRules): boolean {
  return rules.keywords.length > 0 || rules.patterns.length > 0;
}

/**
 * Evaluate declarative activation rules against one user message.
 * Pure + deterministic. Empty rule sets never match.
 */
export function evaluateActivationRules(rules: SkillActivationRules, message: string): boolean {
  if (!hasActivationRules(rules)) return false;
  const text = message.toLowerCase();
  for (const veto of rules.exclude) {
    if (veto && text.includes(veto)) return false;
  }
  for (const kw of rules.keywords) {
    if (kw && text.includes(kw)) return true;
  }
  for (const pattern of rules.patterns) {
    try {
      if (new RegExp(pattern, 'i').test(message)) return true;
    } catch {
      // Already filtered at parse; a hand-built rule set stays fail-safe.
    }
  }
  return false;
}

/** One entry of a skill pack's resource catalog (#162). */
export interface SkillResourceCatalogEntry {
  name: string;
  kind: 'scripts' | 'references' | 'assets';
  /** Path relative to the pack directory, e.g. `scripts/check.mjs`. */
  path: string;
  sizeBytes: number;
}

/**
 * A skill pack's resource catalog (#162): the manifest of every
 * scripts/ + references/ + assets/ file a directory skill ships, so
 * hosts can surface pack contents via tool/API/UI instead of the
 * enumeration being invisible. Single-file skills have an empty catalog.
 */
export interface SkillResourceCatalog {
  skill: string;
  isPack: boolean;
  scripts: SkillResourceCatalogEntry[];
  references: SkillResourceCatalogEntry[];
  assets: SkillResourceCatalogEntry[];
  totalFiles: number;
}

/** Normalize a frontmatter `requiredEnv` value: string or string array. */
export function parseRequiredEnv(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return [...new Set(raw.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean))];
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
  private readonly summaryCache = new Map<
    string,
    { mtimeMs: number; size: number; summary: SkillSummary; requiredEnv: string[] }
  >();
  /** #123: skills skipped for missing env, with the recorded reason. */
  private readonly skipped = new Map<string, SkippedSkill>();

  constructor(
    private readonly skillsDir: string,
    private readonly options: SkillLoaderOptions = {},
  ) {
    this.pinStore = options.pinDbPath ? new SkillPinStore(options.pinDbPath) : null;
  }

  /** Env source used for requiredEnv gating (#123). */
  private env(): Record<string, string | undefined> {
    return this.options.env ?? process.env;
  }

  /** Missing required env keys for a raw skill under the loader env. */
  private missingEnv(raw: RawSkill): string[] {
    const env = this.env();
    return raw.requiredEnv.filter((k) => {
      const v = env[k];
      return typeof v !== 'string' || v.trim() === '';
    });
  }

  /**
   * Enforce `requiredEnv` (#123): a skill whose required env keys are
   * missing is SKIPPED at load/activation — never disclosed, never
   * loaded — with the reason recorded in `getSkippedSkills()`. Throws
   * SkillNotUsableError, which the runtime already treats as "skip
   * this skill" (same channel as the usability gate).
   */
  private assertEnvSatisfied(raw: RawSkill): void {
    const missing = this.missingEnv(raw);
    if (missing.length === 0) {
      this.skipped.delete(raw.name);
      return;
    }
    const reason =
      `Skill "${raw.name}" skipped: required env ${missing.join(', ')} not set ` +
      `(declared via requiredEnv frontmatter). Set the missing key(s) to enable this skill.`;
    this.skipped.set(raw.name, { name: raw.name, missingEnv: missing, reason });
    throw new SkillNotUsableError(reason);
  }

  /** Skills skipped so far for missing env, with reasons (#123). */
  getSkippedSkills(): SkippedSkill[] {
    return [...this.skipped.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Names from list() that are env-satisfied right now. Evaluating a
   * skill records its skip reason when it is gated out.
   */
  listAvailable(): string[] {
    const available: string[] = [];
    for (const name of this.list()) {
      try {
        const raw = this.readSkill(name);
        this.assertEnvSatisfied(raw);
        available.push(name);
      } catch (err) {
        if (!(err instanceof SkillNotUsableError)) throw err;
      }
    }
    return available;
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
          // Env gating is evaluated per call, never cached away (#123).
          this.assertEnvSatisfied({
            name: cached.summary.name,
            description: cached.summary.description,
            content: '',
            validators: [],
            requiredEnv: cached.requiredEnv,
            activation: { keywords: [], patterns: [], exclude: [] },
            invocation: 'both',
            context: 'inline',
          });
          return cached.summary;
        }
        const raw = this.readSkillFile(file, name);
        this.assertUsable(raw.name, botId);
        this.assertEnvSatisfied(raw);
        const summary = { name: raw.name, description: raw.description };
        this.summaryCache.set(name, { mtimeMs: s.mtimeMs, size: s.size, summary, requiredEnv: raw.requiredEnv });
        return summary;
      } catch (err) {
        // SkillNotUsableError must propagate (it is the gate — disabled
        // or env-gated skills are skipped, #123); anything else falls
        // through to the uncached path below.
        if (err instanceof SkillNotUsableError) throw err;
      }
    }
    const raw = this.readSkill(name);
    this.assertUsable(raw.name, botId);
    this.assertEnvSatisfied(raw);
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
    // #123: env-gated skills are skipped at activation, before pinning
    // or content disclosure — a missing key is a skip, not a call-time
    // failure inside the skill's workflow.
    this.assertEnvSatisfied(raw);
    const sha256 = createHash('sha256').update(raw.content, 'utf8').digest('hex');
    await this.checkPin(raw.name, sha256);
    // CA-16: dynamic context injection — expand !`cmd` markers through
    // the governed shell path when the host wired one; otherwise the
    // markers degrade to explicit not-run notes (never execution).
    let content = raw.content;
    if (content.includes('!`')) {
      content = await expandShellInjections(content, this.options.dynamicContext ?? {});
    }
    return { ...raw, content, sha256 };
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
      requiredEnv: parseRequiredEnv(data.requiredEnv),
      activation: parseActivationRules(data.activation),
      invocation: parseSkillInvocation(data),
      context: parseSkillContext(data),
    };
  }

  /** Invocation + context metadata for a skill (CA-16), gate-free read. */
  getSkillMeta(name: string): { invocation: SkillInvocation; context: SkillContext } {
    try {
      const raw = this.readSkill(name);
      return { invocation: raw.invocation, context: raw.context };
    } catch {
      return { invocation: 'both', context: 'inline' };
    }
  }

  /** True when the MODEL may auto-activate / invoke this skill (CA-16). */
  canModelInvoke(name: string): boolean {
    return this.getSkillMeta(name).invocation !== 'user';
  }

  /** True when the USER may explicitly invoke this skill (CA-16). */
  canUserInvoke(name: string): boolean {
    return this.getSkillMeta(name).invocation !== 'model';
  }

  /** Filter a candidate list down to model-invocable skills (CA-16). */
  filterModelInvocable(names: string[]): string[] {
    return names.filter((n) => this.canModelInvoke(n));
  }

  /**
   * Validators a skill declares in its frontmatter (`validators:`),
   * parsed into turn-validator specs. The runtime runs these at end of
   * turn for bots that loaded the skill. Sync + gate-free by design: it
   * only reads the declarations, never the gated content path.
   * Env-gated skills (#123) contribute NO validators — a skipped skill
   * must not run checks at end of turn.
   */
  getValidators(name: string): TurnValidatorSpec[] {
    try {
      const raw = this.readSkill(name);
      if (this.missingEnv(raw).length > 0) return [];
      return raw.validators;
    } catch {
      return [];
    }
  }

  /**
   * Activation rules a skill declares in frontmatter (`activation:`,
   * #163), parsed into keyword/pattern/exclude lists. Env-gated skills
   * (#123) contribute NO rules — a skipped skill must never activate.
   */
  getActivationRules(name: string): SkillActivationRules {
    try {
      const raw = this.readSkill(name);
      if (this.missingEnv(raw).length > 0) return { keywords: [], patterns: [], exclude: [] };
      return raw.activation;
    } catch {
      return { keywords: [], patterns: [], exclude: [] };
    }
  }

  /**
   * Skills whose declarative frontmatter rules match this user message
   * (#163). Deterministic, no LLM. HOST WIRING (runtime.ts, fenced for
   * this workstream): call per turn with the user's message and union
   * the result with the embedding-based auto-activation set (#139)
   * before disclosure.
   */
  skillsMatchingMessage(message: string, candidates?: string[]): string[] {
    const names = candidates ?? this.list();
    const matched: string[] = [];
    for (const name of names) {
      // CA-16: user-only skills never auto-activate from a message match.
      if (!this.canModelInvoke(name)) continue;
      if (evaluateActivationRules(this.getActivationRules(name), message)) matched.push(name);
    }
    return matched.sort();
  }

  /**
   * The resource catalog of a skill pack (#162): every scripts/,
   * references/ and assets/ file with its size, as one manifest.
   * Single-file skills return an empty, non-pack catalog.
   */
  getResourceCatalog(name: string): SkillResourceCatalog {
    const resources = this.listPackResources(name);
    const dir = this.getPackDir(name);
    const toEntries = (kind: 'scripts' | 'references' | 'assets'): SkillResourceCatalogEntry[] =>
      resources[kind].map((fileName) => {
        let sizeBytes = 0;
        if (dir) {
          try {
            sizeBytes = statSync(join(dir, kind, fileName)).size;
          } catch {
            sizeBytes = 0;
          }
        }
        return { name: fileName, kind, path: `${kind}/${fileName}`, sizeBytes };
      });
    const scripts = toEntries('scripts');
    const references = toEntries('references');
    const assets = toEntries('assets');
    return {
      skill: name,
      isPack: dir !== null,
      scripts,
      references,
      assets,
      totalFiles: scripts.length + references.length + assets.length,
    };
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
 * A prepared skill execution (CA-16). For `context: fork` skills the
 * execution is isolated: the host runs it through the delegate path
 * (createDelegateTools / a background subagent) with `prompt` as the
 * delegate task, so the skill's work happens in a fresh context and
 * only its result returns to the session. For inline skills the host
 * simply injects `prompt` into the current turn.
 *
 * WIRING: the delegate seam is this descriptor — runtime/host code that
 * activates a skill calls prepareSkillExecution() and, when mode is
 * 'fork', dispatches `delegateTask` through its existing delegate tool
 * instead of inlining the skill body.
 */
export interface PreparedSkillExecution {
  mode: SkillContext;
  skill: string;
  /** Inline mode: text to inject into the current turn. */
  prompt: string;
  /** Fork mode: the isolated task handed to the delegate path. */
  delegateTask?: string;
}

export function prepareSkillExecution(skill: LoadedSkill, userRequest: string): PreparedSkillExecution {
  const body = `Skill: ${skill.name}\n${skill.description ? `${skill.description}\n` : ''}\n${skill.content}`;
  if (skill.context === 'fork') {
    return {
      mode: 'fork',
      skill: skill.name,
      prompt: body,
      delegateTask:
        `Execute the following skill in isolation and report only the result back.\n\n${body}\n\n---\nUser request: ${userRequest}`,
    };
  }
  return { mode: 'inline', skill: skill.name, prompt: body };
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
          // Pack resource catalog (#162): empty for single-file skills.
          resources: skillLoader.getResourceCatalog(skill.name),
        };
      },
    },
  ];
}
