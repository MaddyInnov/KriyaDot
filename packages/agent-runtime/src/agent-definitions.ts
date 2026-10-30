// SPDX-License-Identifier: Apache-2.0
/**
 * Agent definition files (CA-5, coding-apps parity).
 *
 * Specialists can be defined as Markdown files with YAML frontmatter:
 *
 *   .kriyadot/agents/<name>.md
 *   ---
 *   name: Code Reviewer
 *   description: Reviews diffs for correctness and style
 *   model: llama-3.3-70b-versatile
 *   tools: [read_file, grep, git_diff]
 *   permissionMode: auto        # alias: approvalMode
 *   maxTurns: 12
 *   effort: high
 *   memory: project             # or { scope: project } / { projectId, roles }
 *   isolation: worktree
 *   ---
 *   You are a meticulous code reviewer. …   ← body = system prompt
 *
 * The loader scans a workspace dir (<workspace>/.kriyadot/agents/*.md)
 * and a user-level dir (<userDir>/.kriyadot/agents/*.md, or an explicit
 * agents dir), parses each file into an AgentDefinition, and converts
 * definitions into delegate profiles merged with the built-in
 * 155-profile library (subagent-profiles.ts): on a name/id collision
 * the FILE-defined agent wins (see mergeAgentDefinitions /
 * AgentDefinitionRegistry) — files are the user's explicit intent,
 * the library is the fallback catalog.
 *
 * `isolation: worktree` (or a per-spawn isolation option) makes the
 * delegate/background spawn run inside an auto-created git worktree
 * (worktrees.ts); the worktree is attached to the run/session record
 * and cleaned up on completion per the worktree manager's existing
 * rules (dirty worktrees are kept, the branch is always kept).
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import matter from 'gray-matter';
import type { SubagentProfile } from './subagent-profiles.js';
import { subagentProfiles } from './subagent-profiles.js';
import type { ApprovalMode } from './approval-modes.js';

export type AgentIsolation = 'worktree' | 'none';
export type AgentEffort = 'low' | 'medium' | 'high';

export interface AgentMemoryScope {
  /** Free-form scope label ('project', 'user', 'session', …) when given as a string. */
  scope?: string;
  projectId?: string;
  roles?: string[];
}

export interface AgentDefinition {
  /** Slug id (from `name`, or the file name). Unique within a merged registry. */
  id: string;
  name: string;
  description: string;
  specialty: string;
  /** The Markdown body: the specialist's system prompt. */
  systemPrompt: string;
  tools: string[];
  model?: string;
  providerId?: string;
  /** From `permissionMode` (preferred) or its alias `approvalMode`. */
  approvalMode?: ApprovalMode;
  maxTurns?: number;
  effort?: AgentEffort;
  memoryScope?: AgentMemoryScope;
  isolation?: AgentIsolation;
  /** Where the definition came from. */
  source: 'workspace' | 'user' | 'file';
  /** Absolute path of the defining file, when file-backed. */
  filePath?: string;
}

/** The ephemeral spawn shape the delegate/background hosts consume (extends the profile shape). */
export interface AgentEphemeral {
  name: string;
  systemPrompt: string;
  tools: string[];
  model?: string;
  providerId?: string;
  approvalMode?: ApprovalMode;
  maxTurns?: number;
  effort?: AgentEffort;
  memoryScope?: AgentMemoryScope;
  isolation?: AgentIsolation;
}

export function slugifyAgentId(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'agent';
}

function parseTools(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof raw === 'string') return raw.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

function parseMemoryScope(raw: unknown): AgentMemoryScope | undefined {
  if (typeof raw === 'string' && raw.trim()) return { scope: raw.trim() };
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    const scope: AgentMemoryScope = {};
    if (typeof o.scope === 'string' && o.scope) scope.scope = o.scope;
    if (typeof o.projectId === 'string' && o.projectId) scope.projectId = o.projectId;
    if (Array.isArray(o.roles)) scope.roles = o.roles.map(String).filter(Boolean);
    return Object.keys(scope).length > 0 ? scope : undefined;
  }
  return undefined;
}

function parseApprovalMode(raw: unknown): ApprovalMode | undefined {
  return raw === 'plan' || raw === 'auto' || raw === 'bypass' ? raw : undefined;
}

/**
 * Parse one agent-definition file's text. Returns the definition, or an
 * error string when the file cannot define an agent (empty body). Pure:
 * no filesystem access. `fallbackName` (usually the file basename)
 * supplies the name when frontmatter omits it; a file with NO
 * frontmatter at all is valid — the whole file is the system prompt.
 */
export function parseAgentDefinition(
  content: string,
  opts: { fallbackName?: string; source?: AgentDefinition['source']; filePath?: string } = {},
): { definition?: AgentDefinition; error?: string } {
  let data: Record<string, unknown> = {};
  let body = content;
  try {
    const parsed = matter(content);
    data = (parsed.data ?? {}) as Record<string, unknown>;
    body = parsed.content;
  } catch {
    // Malformed frontmatter: treat the whole file as the prompt body.
    data = {};
    body = content;
  }
  const systemPrompt = body.trim();
  if (!systemPrompt) return { error: 'agent definition has an empty system prompt (file body)' };
  const rawName =
    typeof data.name === 'string' && data.name.trim()
      ? data.name.trim()
      : typeof opts.fallbackName === 'string' && opts.fallbackName.trim()
        ? opts.fallbackName.trim()
        : undefined;
  if (!rawName) return { error: 'agent definition needs a name (frontmatter "name" or a file name)' };
  const id =
    typeof data.id === 'string' && data.id.trim() ? slugifyAgentId(data.id) : slugifyAgentId(rawName);
  const maxTurnsRaw = typeof data.maxTurns === 'number' ? data.maxTurns : Number(data.maxTurns);
  const effort = data.effort === 'low' || data.effort === 'medium' || data.effort === 'high' ? data.effort : undefined;
  const isolation = data.isolation === 'worktree' ? 'worktree' : data.isolation === 'none' ? 'none' : undefined;
  const definition: AgentDefinition = {
    id,
    name: rawName,
    description: typeof data.description === 'string' ? data.description : '',
    specialty: typeof data.specialty === 'string' ? data.specialty : '',
    systemPrompt,
    tools: parseTools(data.tools ?? data.suggestedTools),
    ...(typeof data.model === 'string' && data.model ? { model: data.model } : {}),
    ...(typeof data.provider === 'string' && data.provider
      ? { providerId: data.provider }
      : typeof data.providerId === 'string' && data.providerId
        ? { providerId: data.providerId }
        : {}),
    ...(parseApprovalMode(data.permissionMode ?? data.approvalMode)
      ? { approvalMode: parseApprovalMode(data.permissionMode ?? data.approvalMode) }
      : {}),
    ...(Number.isFinite(maxTurnsRaw) && maxTurnsRaw > 0 ? { maxTurns: Math.floor(maxTurnsRaw) } : {}),
    ...(effort ? { effort } : {}),
    ...(parseMemoryScope(data.memory ?? data.memoryScope) ? { memoryScope: parseMemoryScope(data.memory ?? data.memoryScope) } : {}),
    ...(isolation ? { isolation } : {}),
    source: opts.source ?? 'file',
    ...(opts.filePath ? { filePath: opts.filePath } : {}),
  };
  return { definition };
}

/** Convert a file definition into the library's profile shape. */
export function agentDefinitionToProfile(def: AgentDefinition): SubagentProfile {
  return {
    id: def.id,
    name: def.name,
    specialty: def.specialty,
    description: def.description,
    systemPrompt: def.systemPrompt,
    suggestedTools: [...def.tools],
  };
}

/** Convert a file definition into the extended ephemeral spawn shape. */
export function agentDefinitionToEphemeral(def: AgentDefinition): AgentEphemeral {
  return {
    name: def.name,
    systemPrompt: def.systemPrompt,
    tools: [...def.tools],
    ...(def.model ? { model: def.model } : {}),
    ...(def.providerId ? { providerId: def.providerId } : {}),
    ...(def.approvalMode ? { approvalMode: def.approvalMode } : {}),
    ...(def.maxTurns !== undefined ? { maxTurns: def.maxTurns } : {}),
    ...(def.effort ? { effort: def.effort } : {}),
    ...(def.memoryScope ? { memoryScope: def.memoryScope } : {}),
    ...(def.isolation ? { isolation: def.isolation } : {}),
  };
}

export interface LoadAgentDefinitionsOptions {
  /** Workspace root: reads `<workspaceDir>/.kriyadot/agents/*.md`. */
  workspaceDir?: string;
  /** User-level root: reads `<userDir>/.kriyadot/agents/*.md`. */
  userDir?: string;
  /** Explicit agents directories (read directly, source 'file'). */
  agentDirs?: string[];
}

export interface LoadAgentDefinitionsReport {
  definitions: AgentDefinition[];
  errors: Array<{ file: string; error: string }>;
  /** Directories actually scanned (existing only). */
  scannedDirs: string[];
}

function scanAgentsDir(dir: string, source: AgentDefinition['source'], report: LoadAgentDefinitionsReport): void {
  if (!existsSync(dir)) return;
  report.scannedDirs.push(dir);
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  } catch (err) {
    report.errors.push({ file: dir, error: err instanceof Error ? err.message : String(err) });
    return;
  }
  for (const file of files) {
    const path = join(dir, file);
    try {
      const { definition, error } = parseAgentDefinition(readFileSync(path, 'utf8'), {
        fallbackName: basename(file, '.md'),
        source,
        filePath: path,
      });
      if (definition) report.definitions.push(definition);
      else report.errors.push({ file: path, error: error ?? 'unparseable agent definition' });
    } catch (err) {
      report.errors.push({ file: path, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

/**
 * Load agent definitions from the workspace and user-level
 * `.kriyadot/agents/` directories (plus any explicit dirs). Missing
 * directories are not errors. Within one call, later sources override
 * earlier ones on id collision (explicit dirs > workspace > user is
 * NOT the order — user loads first, workspace second, explicit last,
 * so the most local definition wins).
 */
export function loadAgentDefinitions(opts: LoadAgentDefinitionsOptions = {}): LoadAgentDefinitionsReport {
  const report: LoadAgentDefinitionsReport = { definitions: [], errors: [], scannedDirs: [] };
  const all: AgentDefinition[] = [];
  const collect = (r: LoadAgentDefinitionsReport) => {
    all.push(...r.definitions);
    report.errors.push(...r.errors);
    report.scannedDirs.push(...r.scannedDirs);
  };
  if (opts.userDir) {
    const r: LoadAgentDefinitionsReport = { definitions: [], errors: [], scannedDirs: [] };
    scanAgentsDir(join(opts.userDir, '.kriyadot', 'agents'), 'user', r);
    collect(r);
  }
  if (opts.workspaceDir) {
    const r: LoadAgentDefinitionsReport = { definitions: [], errors: [], scannedDirs: [] };
    scanAgentsDir(join(opts.workspaceDir, '.kriyadot', 'agents'), 'workspace', r);
    collect(r);
  }
  for (const dir of opts.agentDirs ?? []) {
    const r: LoadAgentDefinitionsReport = { definitions: [], errors: [], scannedDirs: [] };
    scanAgentsDir(dir, 'file', r);
    collect(r);
  }
  // Dedupe by id: the LAST definition wins (most local source).
  const byId = new Map<string, AgentDefinition>();
  for (const d of all) byId.set(d.id, d);
  report.definitions = [...byId.values()];
  return report;
}

/**
 * Merge file definitions into the built-in profile library as plain
 * SubagentProfiles. FILE-DEFINED AGENTS WIN on id collision (the
 * library entry is replaced) — noted here per CA-5: a user's
 * `.kriyadot/agents/reviewer.md` deliberately shadows a built-in
 * profile of the same id.
 */
export function mergeAgentDefinitions(
  builtins: SubagentProfile[],
  definitions: AgentDefinition[],
): SubagentProfile[] {
  const byId = new Map<string, SubagentProfile>(builtins.map((p) => [p.id, p]));
  for (const def of definitions) byId.set(def.id, agentDefinitionToProfile(def));
  return [...byId.values()];
}

/**
 * Resolution registry for delegate/background spawns: file definitions
 * (rich, extended shape) layered over the built-in profile library.
 * Lookups accept a profile id OR an agent name.
 */
export class AgentDefinitionRegistry {
  private readonly definitions = new Map<string, AgentDefinition>();
  private readonly builtins: SubagentProfile[];

  constructor(definitions: AgentDefinition[] = [], builtins: SubagentProfile[] = subagentProfiles.list()) {
    this.builtins = builtins;
    for (const d of definitions) this.definitions.set(d.id, d);
  }

  /** Register/replace a file definition at runtime. */
  add(def: AgentDefinition): void {
    this.definitions.set(def.id, def);
  }

  getDefinition(idOrName: string): AgentDefinition | undefined {
    return (
      this.definitions.get(idOrName) ??
      this.definitions.get(slugifyAgentId(idOrName)) ??
      [...this.definitions.values()].find((d) => d.name === idOrName)
    );
  }

  /** Merged profile list (file-defined win on collision). */
  listProfiles(): SubagentProfile[] {
    return mergeAgentDefinitions(this.builtins, [...this.definitions.values()]);
  }

  /**
   * Extended ephemeral for a spawn: file definitions return their rich
   * shape (model/effort/isolation/…); built-ins fall back to the plain
   * profile shape. Undefined when neither knows the id/name.
   */
  ephemeralFor(idOrName: string): (AgentEphemeral & { id: string }) | undefined {
    const def = this.getDefinition(idOrName);
    if (def) return { id: def.id, ...agentDefinitionToEphemeral(def) };
    const builtin =
      this.builtins.find((p) => p.id === idOrName) ?? this.builtins.find((p) => p.name === idOrName);
    if (!builtin) return undefined;
    return { id: builtin.id, name: builtin.name, systemPrompt: builtin.systemPrompt, tools: [...builtin.suggestedTools] };
  }

  get size(): number {
    return this.listProfiles().length;
  }
}

/**
 * One-call profile resolution for the delegate tool and background
 * spawns: file definitions (when the caller supplies them — loaded via
 * loadAgentDefinitions by the host) win over the built-in library.
 * Without definitions this is exactly the old library lookup.
 */
export function resolveDelegateProfile(
  profileId: string,
  definitions?: AgentDefinition[],
): (AgentEphemeral & { id: string }) | undefined {
  if (definitions && definitions.length > 0) {
    const registry = new AgentDefinitionRegistry(definitions);
    const found = registry.ephemeralFor(profileId);
    if (found) return found;
  }
  const e = subagentProfiles.ephemeralFor(profileId);
  if (!e) return undefined;
  return { id: profileId, name: e.name, systemPrompt: e.systemPrompt, tools: e.tools };
}
