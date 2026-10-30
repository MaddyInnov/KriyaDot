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

const COMMANDS_FILE = 'slash-commands.json';

export interface SlashCommand {
  description: string;
  prompt: string;
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
export function expandSlashCommand(
  message: string,
  commands: SlashCommandMap,
): { expanded: string; commandName: string } | { expanded: string; commandName: null } | null {
  const parsed = parseSlashCommand(message);
  if (!parsed) return { expanded: message, commandName: null };
  const cmd = commands[parsed.name];
  if (!cmd) return null; // unknown command
  const expanded = cmd.prompt
    .replaceAll('{args}', parsed.args)
    .replaceAll('{message}', message.trim());
  return { expanded, commandName: parsed.name };
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
