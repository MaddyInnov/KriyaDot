// SPDX-License-Identifier: Apache-2.0
/**
 * System template variables (Octomind parity #40).
 *
 * Prompt assembly (system prompts, skill prompts, layer prompts) can
 * reference a small, FIXED set of system variables written
 * `{{NAME}}` — the working directory, the bot's role, the git tree
 * state, the session id, the model in use, the current date. Before
 * this module the only substitutions anywhere were ad-hoc (`{args}`,
 * `{{payload}}`, workflow `{{input}}`); there was no system variable
 * set and no way to inspect what a variable would resolve to.
 *
 * Design rules:
 *   - Pure and synchronous. Callers supply the context (including the
 *     git-tree text — the host runs `git status` once per turn if it
 *     wants `{{GIT_TREE}}` live); this module never shells out.
 *   - Unknown `{{VARS}}` are left untouched, so literal braces in a
 *     prompt (JSON examples, workflow syntax) survive.
 *   - `inspectTemplateVariables()` is the data function behind a
 *     `vars` inspector surface: it returns every variable's resolved
 *     value (or its absence) for a given context, without rendering.
 *
 * Integration points (fenced surfaces, see the closure report):
 * prompt assembly in runtime.ts should run system prompts through
 * `resolveTemplateVariables` with a per-turn context, and the API/CLI
 * `vars` inspector should render `inspectTemplateVariables(ctx)`.
 */

export interface TemplateVarContext {
  /** Working directory of the bot/session ({{CWD}}, {{WORKSPACE}}). */
  cwd?: string;
  /** The bot's role/persona label ({{ROLE}}). */
  role?: string;
  /** The bot's display name ({{BOT_NAME}}) and id ({{BOT_ID}}). */
  botName?: string;
  botId?: string;
  /** Session id ({{SESSION_ID}}). */
  sessionId?: string;
  /** Model id in use ({{MODEL}}) and provider id ({{PROVIDER}}). */
  model?: string;
  providerId?: string;
  /**
   * Git tree state text ({{GIT_TREE}}) — typically the host's
   * `git status --porcelain` output, or a one-line summary such as
   * "clean" / "3 modified files". Supplied by the caller; never
   * computed here.
   */
  gitTree?: string;
  /** Clock override (tests). Defaults to `new Date()`. */
  now?: Date;
}

export interface TemplateVariableInfo {
  /** Variable name as written between the braces, e.g. `CWD`. */
  name: string;
  /** What the variable means (inspector display). */
  description: string;
  /** Resolved value for the inspected context, or undefined. */
  value?: string;
}

interface VarDef {
  name: string;
  description: string;
  resolve: (ctx: TemplateVarContext) => string | undefined;
}

function datePart(now: Date, part: 'date' | 'time'): string {
  // ISO slices are timezone-stable (UTC) — deliberate: an inspector on
  // any surface shows the same value the prompt received.
  const iso = now.toISOString();
  return part === 'date' ? iso.slice(0, 10) : iso.slice(11, 19);
}

const VAR_DEFS: readonly VarDef[] = [
  { name: 'CWD', description: 'Working directory of the session', resolve: (c) => c.cwd },
  { name: 'WORKSPACE', description: 'Alias of CWD (the bot workspace directory)', resolve: (c) => c.cwd },
  { name: 'ROLE', description: "The bot's role / persona label", resolve: (c) => c.role },
  { name: 'BOT_NAME', description: "The bot's display name", resolve: (c) => c.botName },
  { name: 'BOT_ID', description: "The bot's id", resolve: (c) => c.botId },
  { name: 'SESSION_ID', description: 'The current session id', resolve: (c) => c.sessionId },
  { name: 'MODEL', description: 'The model id serving the turn', resolve: (c) => c.model },
  { name: 'PROVIDER', description: 'The provider id serving the turn', resolve: (c) => c.providerId },
  { name: 'GIT_TREE', description: 'Git tree state (host-supplied `git status` text/summary)', resolve: (c) => c.gitTree },
  { name: 'DATE', description: 'Current date (UTC, YYYY-MM-DD)', resolve: (c) => datePart(c.now ?? new Date(), 'date') },
  { name: 'TIME', description: 'Current time (UTC, HH:MM:SS)', resolve: (c) => datePart(c.now ?? new Date(), 'time') },
];

const VAR_BY_NAME = new Map(VAR_DEFS.map((d) => [d.name, d]));

/** The supported system variable names, in inspector order. */
export function listTemplateVariables(): string[] {
  return VAR_DEFS.map((d) => d.name);
}

/**
 * Resolve every `{{VAR}}` in `text` against `ctx`. Variables with no
 * value in the context, and unknown variable names, are left exactly
 * as written — a prompt must never lose text to a missing variable.
 */
export function resolveTemplateVariables(text: string, ctx: TemplateVarContext): string {
  return text.replace(/\{\{\s*([A-Z][A-Z0-9_]*)\s*\}\}/g, (whole, name: string) => {
    const def = VAR_BY_NAME.get(name);
    if (!def) return whole;
    const value = def.resolve(ctx);
    return value === undefined ? whole : value;
  });
}

/** Names of the `{{VARS}}` a text references (supported or not). */
export function findTemplateVariables(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\{\{\s*([A-Z][A-Z0-9_]*)\s*\}\}/g)) {
    if (!out.includes(m[1]!)) out.push(m[1]!);
  }
  return out;
}

/**
 * Vars-inspector data function (#40): every supported variable with
 * its description and the value it resolves to under `ctx`
 * (undefined = would be left untouched in a prompt).
 */
export function inspectTemplateVariables(ctx: TemplateVarContext): TemplateVariableInfo[] {
  return VAR_DEFS.map((d) => ({ name: d.name, description: d.description, value: d.resolve(ctx) }));
}
