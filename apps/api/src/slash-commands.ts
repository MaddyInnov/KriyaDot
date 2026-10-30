// SPDX-License-Identifier: Apache-2.0
// Custom slash commands — the `/work` pattern from Claude Code.
//
// In Claude Code, `/work` is not built-in; it is a USER-DEFINED command
// (a markdown instruction file). The platform feature is the slash-command
// system itself: users define named commands with a prompt template, then
// invoke them in chat as `/name args`. The template expands before the
// message reaches the agent.
//
// Storage: <dataDir>/slash-commands.json
//   { "<name>": { "description": "...", "prompt": "..." } }
// Template placeholders: {args} (text after the command), {message} (full
// original message).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  confineRealpath,
  expandShellInjections,
  generateInitInstructions,
  type ShellInjectionGate,
  type ShellInjectionRunner,
} from '@mvp/agent-runtime';

const COMMANDS_FILE = 'slash-commands.json';

export interface SlashCommand {
  description: string;
  prompt: string;
  /** CA-15 frontmatter v2: bot/agent this command pins, when set. */
  agent?: string;
  /** CA-15 frontmatter v2: model this command pins, when set. */
  model?: string;
  /** CA-15 frontmatter v2: run as an isolated subtask (delegate) when true. */
  subtask?: boolean;
}

export type SlashCommandMap = Record<string, SlashCommand>;

function commandsPath(dataDir: string): string {
  return path.join(dataDir, COMMANDS_FILE);
}

/**
 * Seed file shipped with the product (default commands like /work, /plan,
 * /reduce). Candidate locations, first existing wins:
 *  - <repo>/seed/ — this module lives at apps/api/src (or dist), so the
 *    repo seed dir is three levels up. (The old two-level path pointed
 *    at a nonexistent apps/seed, so the shipped defaults never loaded
 *    from a source checkout — found by the #42 closure tests.)
 *  - ../../seed — packaged layouts that ship seed beside apps/.
 */
function seedCommandsPaths(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.join(here, '..', '..', '..', 'seed', 'slash-commands.json'),
    path.join(here, '..', '..', 'seed', 'slash-commands.json'),
  ];
}

export function loadSlashCommands(dataDir: string): SlashCommandMap {  // Try the data dir first, then fall back to the seed file (shipped defaults).
  const candidates = [commandsPath(dataDir), ...seedCommandsPaths()];
  for (const p of candidates) {
    try {
      const raw = fs.readFileSync(p, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== 'object' || parsed === null) continue;
      const out: SlashCommandMap = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (/^[a-z0-9-]{1,32}$/.test(k) && typeof v === 'object' && v !== null) {
          const c = v as Record<string, unknown>;
          if (typeof c.prompt === 'string' && c.prompt.length > 0 && c.prompt.length <= 8000) {
            out[k] = {
              description: typeof c.description === 'string' ? c.description.slice(0, 200) : '',
              prompt: c.prompt,
              ...(typeof c.agent === 'string' && c.agent ? { agent: c.agent.slice(0, 100) } : {}),
              ...(typeof c.model === 'string' && c.model ? { model: c.model.slice(0, 100) } : {}),
              ...(c.subtask === true ? { subtask: true } : {}),
            };
          }
        }
      }
      if (Object.keys(out).length > 0) return out;
    } catch {
      continue;
    }
  }
  return {};
}

export function saveSlashCommand(dataDir: string, name: string, cmd: SlashCommand): SlashCommandMap {
  if (!/^[a-z0-9-]{1,32}$/.test(name)) {
    throw new Error('Command name must be 1-32 chars: lowercase letters, digits, hyphens.');
  }
  if (!cmd.prompt || cmd.prompt.length > 8000) {
    throw new Error('prompt is required (max 8000 chars).');
  }
  const all = loadSlashCommands(dataDir);
  all[name] = {
    description: (cmd.description ?? '').slice(0, 200),
    prompt: cmd.prompt,
    ...(cmd.agent ? { agent: cmd.agent.slice(0, 100) } : {}),
    ...(cmd.model ? { model: cmd.model.slice(0, 100) } : {}),
    ...(cmd.subtask === true ? { subtask: true } : {}),
  };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(commandsPath(dataDir), JSON.stringify(all, null, 2) + '\n', { mode: 0o600 });
  invalidateSlashCommandCache(dataDir);
  return all;
}

export function deleteSlashCommand(dataDir: string, name: string): boolean {
  const all = loadSlashCommands(dataDir);
  if (!(name in all)) return false;
  delete all[name];
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(commandsPath(dataDir), JSON.stringify(all, null, 2) + '\n', { mode: 0o600 });
  invalidateSlashCommandCache(dataDir);
  return true;
}

export interface ParsedCommand {
  name: string;
  args: string;
}

/** Parse a leading `/name args` from a chat message. Returns null if not a command. */
export function parseSlashCommand(message: string): ParsedCommand | null {
  const m = /^\/([a-z0-9-]{1,32})(?:\s+(.*))?$/s.exec(message.trim());
  if (!m) return null;
  return { name: m[1], args: (m[2] ?? '').trim() };
}

/**
 * Expand a message through the slash-command registry. If the message is a
 * known `/command`, returns the expanded prompt; otherwise returns the
 * message unchanged. Unknown `/command` → returns null so the caller can
 * surface a helpful error.
 */
/** Split a command's argument string into positional tokens (quote-aware). */
export function splitCommandArgs(args: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(args)) !== null) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

/**
 * Positional expansion (CA-15): `$ARGUMENTS` = the whole args string,
 * `$1`…`$n` = positional tokens (missing positions expand to empty).
 * Legacy `{args}` / `{message}` placeholders are handled by callers.
 */
export function expandPositional(template: string, args: string): string {
  const parts = splitCommandArgs(args);
  return template
    .replaceAll('$ARGUMENTS', args)
    .replace(/\$(\d+)/g, (_whole, n: string) => parts[Number(n) - 1] ?? '');
}

export function expandSlashCommand(
  message: string,
  commands: SlashCommandMap,
): { expanded: string; commandName: string } | { expanded: string; commandName: null } | null {
  const parsed = parseSlashCommand(message);
  if (!parsed) return { expanded: message, commandName: null };
  const cmd = commands[parsed.name];
  if (!cmd) return null; // unknown command
  const expanded = expandPositional(
    cmd.prompt.replaceAll('{args}', parsed.args).replaceAll('{message}', message.trim()),
    parsed.args,
  );
  return { expanded, commandName: parsed.name };
}

// ---------------------------------------------------------------------------
// CA-15 — frontmatter v2 expansion: @file refs + !`cmd` injection
// ---------------------------------------------------------------------------

export interface SlashExpandContext {
  /** Workspace root for @file confinement. Without it, @file refs are refused. */
  workspaceDir?: string;
  /** Governance gate for !`cmd` injection (must allow before anything runs). */
  shellGate?: ShellInjectionGate;
  /** Governed shell runner for !`cmd` injection. */
  shellRunner?: ShellInjectionRunner;
  /** Per-file cap for @file inlining (chars). Default 8000. */
  maxFileChars?: number;
}

export interface ExpandedCommandV2 {
  expanded: string;
  commandName: string;
  agent?: string;
  model?: string;
  subtask: boolean;
}

/** Inline `@path` file references, workspace-confined and size-capped. */
export function expandFileRefs(text: string, ctx: SlashExpandContext): string {
  return text.replace(/@((?:\.\.?\/)?[\w./-]+\.[a-zA-Z]{1,6})\b/g, (whole, ref: string) => {
    if (!ctx.workspaceDir) return `[file reference refused — no workspace: @${ref}]`;
    let abs: string;
    try {
      abs = confineRealpath(ctx.workspaceDir, ref);
    } catch {
      return `[file reference refused — outside the workspace: @${ref}]`;
    }
    let content: string;
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      return `[file not found: @${ref}]`;
    }
    const cap = ctx.maxFileChars ?? 8000;
    const body = content.length > cap ? `${content.slice(0, cap)}\n…[file truncated]` : content;
    return `\n\n[File: ${ref}]\n${body}\n[/File: ${ref}]\n\n`;
  });
}

/**
 * Full v2 expansion (CA-15): legacy {args}/{message} + $ARGUMENTS/$1…$n
 * positional expansion, then @file inlining, then governance-gated
 * !`cmd` shell injection. Returns the command's pinning fields
 * (agent/model/subtask) alongside the expanded prompt so the chat route
 * can honour them. Unknown command → null, like expandSlashCommand.
 */
export async function expandSlashCommandV2(
  message: string,
  commands: SlashCommandMap,
  ctx: SlashExpandContext = {},
): Promise<ExpandedCommandV2 | { expanded: string; commandName: null } | null> {
  const parsed = parseSlashCommand(message);
  if (!parsed) return { expanded: message, commandName: null };
  const cmd = commands[parsed.name];
  if (!cmd) return null;
  let expanded = expandPositional(
    cmd.prompt.replaceAll('{args}', parsed.args).replaceAll('{message}', message.trim()),
    parsed.args,
  );
  expanded = expandFileRefs(expanded, ctx);
  if (expanded.includes('!`')) {
    expanded = await expandShellInjections(expanded, {
      ...(ctx.shellGate ? { gate: ctx.shellGate } : {}),
      ...(ctx.shellRunner ? { runner: ctx.shellRunner } : {}),
    });
  }
  return {
    expanded,
    commandName: parsed.name,
    ...(cmd.agent ? { agent: cmd.agent } : {}),
    ...(cmd.model ? { model: cmd.model } : {}),
    subtask: cmd.subtask === true,
  };
}

// ---------------------------------------------------------------------------
// CA-6 — /init: repo scan → starter instruction file
// ---------------------------------------------------------------------------

export interface InitCommandResult {
  ok: boolean;
  /** Workspace-relative file written (when ok). */
  file?: string;
  content?: string;
  error?: string;
  analysis?: ReturnType<typeof generateInitInstructions>['analysis'];
}

/** True when a chat message is the /init command. */
export function isInitCommand(message: string): boolean {
  return /^\/init(?:\s|$)/.test(message.trim());
}

/**
 * Execute `/init [--force]` for a workspace: analyse the repo and write
 * the generated starter AGENTS.md through the workspace-confined path.
 * Refuses to overwrite an existing instruction file (AGENTS.md,
 * KRIYADOT.md, or .kriyadot/instructions.md) unless --force is passed.
 */
export function executeInitCommand(message: string, opts: { workspaceDir: string }): InitCommandResult {
  const force = /(?:^|\s)--force(?:\s|$)/.test(message);
  const generated = generateInitInstructions(opts.workspaceDir);
  const existing = generated.analysis.existingInstructionFiles;
  if (existing.length > 0 && !force) {
    return {
      ok: false,
      error: `Instruction file already exists (${existing.join(', ')}). Re-run with /init --force to overwrite AGENTS.md.`,
      analysis: generated.analysis,
    };
  }
  let target: string;
  try {
    target = confineRealpath(opts.workspaceDir, generated.fileName);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), analysis: generated.analysis };
  }
  fs.writeFileSync(target, generated.content, 'utf8');
  return { ok: true, file: generated.fileName, content: generated.content, analysis: generated.analysis };
}

/**
 * Cached slash-command loader for hot paths (the chat route calls this on
 * every message). Caches per dataDir and invalidates when the data-dir
 * file's mtime/size changes. The seed fallback never changes at runtime;
 * if the data-dir file appears/disappears the stat mismatch triggers a
 * reload, so the cache stays correct.
 */
const slashCommandCache = new Map<string, { mtimeMs: number; size: number; commands: SlashCommandMap }>();

function statForCache(p: string): { mtimeMs: number; size: number } | null {
  try {
    const s = fs.statSync(p);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}

export function loadSlashCommandsCached(dataDir: string): SlashCommandMap {
  const cached = slashCommandCache.get(dataDir);
  const primary = statForCache(commandsPath(dataDir));
  const mtimeMs = primary?.mtimeMs ?? -1;
  const size = primary?.size ?? -1;
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
    return cached.commands;
  }
  const commands = loadSlashCommands(dataDir);
  slashCommandCache.set(dataDir, { mtimeMs, size, commands });
  return commands;
}

/** Drop the cached entry (called after save/delete). */
export function invalidateSlashCommandCache(dataDir?: string): void {
  if (dataDir) slashCommandCache.delete(dataDir);
  else slashCommandCache.clear();
}

// ---------------------------------------------------------------------------
// #42 — executable slash commands: `/run <name>` + the shipped `reduce`
// ---------------------------------------------------------------------------
//
// Prompt templates (above) only rewrite the user's message. `/run` is
// the executable form: `/run <name> [args]` EXECUTES a named target —
// a workflow, a bot layer pipeline, or (as a fallback) a prompt-template
// command — through host-provided executors. This module owns the
// parsing, target resolution, and dispatch; the host (routes/index)
// supplies the executors (workflow runner, layer runner) because it
// owns those registries. Dispatch is fail-visible: an unknown name or
// a target kind with no executor is an error, never a silent template
// expansion.

export interface RunCommand {
  name: string;
  args: string;
}

/** Parse `/run <name> [args]`; null when the message is not a /run. */
export function parseRunCommand(message: string): RunCommand | null {
  const m = /^\/run(?:\s+(\S+)(?:\s+([\s\S]+))?)?$/.exec(message.trim());
  if (!m) return null;
  return { name: m[1] ?? '', args: (m[2] ?? '').trim() };
}

export type RunTargetKind = 'workflow' | 'layer' | 'command';

export interface RunTarget {
  kind: RunTargetKind;
  name: string;
}

/**
 * Resolve a /run name against the host's registries. Workflows win
 * over layers, layers over prompt-template commands (execution beats
 * expansion when a name exists in both). Null when nothing matches.
 */
export function resolveRunTarget(
  name: string,
  registries: { workflows?: string[]; layers?: string[]; commands?: SlashCommandMap },
): RunTarget | null {
  if (!name) return null;
  if (registries.workflows?.includes(name)) return { kind: 'workflow', name };
  if (registries.layers?.includes(name)) return { kind: 'layer', name };
  if (registries.commands && name in registries.commands) return { kind: 'command', name };
  return null;
}

export interface RunExecutors {
  runWorkflow?: (name: string, args: string) => Promise<unknown> | unknown;
  runLayer?: (name: string, args: string) => Promise<unknown> | unknown;
  /** Prompt-template commands available for the command fallback. */
  commands?: SlashCommandMap;
  workflows?: string[];
  layers?: string[];
}

export interface RunResult {
  target: RunTarget;
  /** For kind 'command': the expanded prompt (the caller sends it as the turn). */
  expanded?: string;
  /** For workflow/layer kinds: whatever the executor returned. */
  output?: unknown;
}

/**
 * Execute a parsed /run command through the host executors.
 * Throws Error with a user-facing message on unknown targets and on
 * target kinds the host has not wired an executor for.
 */
export async function executeRunCommand(command: RunCommand, executors: RunExecutors): Promise<RunResult> {
  const target = resolveRunTarget(command.name, executors);
  if (!target) {
    const known = [
      ...(executors.workflows ?? []),
      ...(executors.layers ?? []),
      ...Object.keys(executors.commands ?? {}),
    ];
    throw new Error(
      `Unknown /run target "${command.name}". Known: ${known.length ? known.join(', ') : '(none registered)'}`,
    );
  }
  if (target.kind === 'workflow') {
    if (!executors.runWorkflow) throw new Error(`/run: workflow execution is not wired on this host (target "${target.name}")`);
    return { target, output: await executors.runWorkflow(target.name, command.args) };
  }
  if (target.kind === 'layer') {
    if (!executors.runLayer) throw new Error(`/run: layer execution is not wired on this host (target "${target.name}")`);
    return { target, output: await executors.runLayer(target.name, command.args) };
  }
  const expanded = expandSlashCommand(`/${target.name}${command.args ? ` ${command.args}` : ''}`, executors.commands ?? {});
  if (!expanded) throw new Error(`/run: command "${target.name}" could not be expanded`);
  return { target, expanded: expanded.expanded };
}

/**
 * The shipped `reduce` command (#42): a prompt-template command (in the
 * seed file) that reduces the conversation so far to a compact state
 * summary — the manual counterpart of compaction. Kept as a named
 * constant so tests can assert the seed file actually ships it.
 */
export const REDUCE_COMMAND_NAME = 'reduce';

// ---------------------------------------------------------------------------
// #164 — env force-load for skills
// ---------------------------------------------------------------------------
//
// `KRIYADOT_FORCE_SKILLS=name1,name2` force-loads skills for EVERY turn
// on the host, regardless of per-bot/per-session selection — the env
// counterpart of the /skill session command. The chat route merges
// these names into the turn's skill list (deduplicated, order-stable:
// forced skills first). Parsing is total: empty/blank entries drop out.

export const FORCE_SKILLS_ENV = 'KRIYADOT_FORCE_SKILLS';

/** Parse the force-load env value into skill names (trimmed, deduped). */
export function envForcedSkills(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env[FORCE_SKILLS_ENV];
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const name = part.trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** Merge forced skills ahead of a turn's selected skills (deduped, stable). */
export function mergeForcedSkills(selected: string[], forced: string[]): string[] {
  const out = [...forced];
  for (const name of selected) if (!out.includes(name)) out.push(name);
  return out;
}
