// SPDX-License-Identifier: Apache-2.0
// argv parsing for the headless CLI. Pure functions — no I/O — so the
// command table can be unit-tested without a server or a terminal.

export type OutputFormat = 'text' | 'json' | 'jsonl';

export interface GlobalFlags {
  api?: string;
  token?: string;
  format: OutputFormat;
  help: boolean;
  version: boolean;
  /** Raw `-c key=value` per-run config overrides (repeatable). */
  overrides: string[];
}

export interface ParsedArgs {
  /** Top-level command: chat, run, send, sessions, bots, threads, routines, team, serve, models, mcp, login, config, completion, help. */
  command: string;
  /** Second token for grouped commands (bots list, threads show, …). */
  subcommand: string;
  /** Remaining positional tokens after command/subcommand. */
  positional: string[];
  /** --key value / --key=value / --flag flags (command-local). */
  flags: Record<string, string | boolean>;
  global: GlobalFlags;
}

const GLOBAL_VALUE_FLAGS = new Set(['api', 'token', 'format']);
const GLOBAL_BOOL_FLAGS = new Set(['help', 'version']);

/**
 * Parse argv (without node/bin). The first non-flag token is the command,
 * the second (for grouped commands) is the subcommand; everything else
 * non-flag after that is positional.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const global: GlobalFlags = { format: 'text', help: false, version: false, overrides: [] };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = (eq === -1 ? a.slice(2) : a.slice(2, eq)).toLowerCase();
      let value: string | boolean | undefined;
      if (eq !== -1) value = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) value = argv[++i];
      else value = true;

      if (GLOBAL_VALUE_FLAGS.has(name) || GLOBAL_BOOL_FLAGS.has(name)) {
        if (name === 'api' && typeof value === 'string') global.api = value;
        else if (name === 'token' && typeof value === 'string') global.token = value;
        else if (name === 'format' && typeof value === 'string') {
          const f = value.toLowerCase();
          if (f !== 'text' && f !== 'json' && f !== 'jsonl') {
            throw new Error(`--format must be "text", "json" or "jsonl", got "${value}"`);
          }
          global.format = f;
        } else if (name === 'help') global.help = true;
        else if (name === 'version') global.version = true;
        continue;
      }
      flags[name] = value;
      continue;
    }
    if (a === '-c' || a.startsWith('-c=')) {
      // Repeatable per-run config override: -c key=value (or -c=key=value).
      if (a.startsWith('-c=')) {
        global.overrides.push(a.slice(3));
        continue;
      }
      if (i + 1 >= argv.length) throw new Error('-c needs a key=value argument, e.g. -c model=llama-3.3-70b');
      global.overrides.push(argv[++i]);
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      // Short flags: -h (help), -V (version). Anything else is an error —
      // single-dash long flags are a typo magnet in scripts.
      for (const ch of a.slice(1)) {
        if (ch === 'h') global.help = true;
        else if (ch === 'V') global.version = true;
        else throw new Error(`Unknown flag "-${ch}" (did you mean "--${ch}"?)`);
      }
      continue;
    }
    positional.push(a);
  }

  const [command = '', subcommand = '', ...rest] = positional;
  return { command: command.toLowerCase(), subcommand: subcommand.toLowerCase(), positional: rest, flags, global };
}

/** Read a string flag, throwing a usage error when missing/empty. */
export function requireFlag(flags: Record<string, string | boolean>, name: string, usage: string): string {
  const v = flags[name];
  if (typeof v !== 'string' || !v.trim()) throw new Error(`Missing --${name}. ${usage}`);
  return v.trim();
}

/** Read an optional string flag. */
export function flagString(flags: Record<string, string | boolean>, name: string): string | undefined {
  const v = flags[name];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** True when a boolean flag was passed (or --flag=true). */
export function flagBool(flags: Record<string, string | boolean>, name: string): boolean {
  const v = flags[name];
  return v === true || v === 'true' || v === '1';
}

const GROUPED = new Set(['bots', 'threads', 'routines', 'team']);

/**
 * Validate the parsed command against the known command table. Returns a
 * usage error message, or null when the invocation looks valid. `--help`
 * and `--version` short-circuit before this runs.
 */
export function validateCommand(p: ParsedArgs): string | null {
  const usage = (s: string) => `Invalid usage. ${s}\nRun "kriyadot help" for the full command list.`;
  switch (p.command) {
    case 'chat':
      if (!p.subcommand && p.positional.length === 0 && !flagString(p.flags, 'message')) {
        // bare `kriyadot chat` with no bot is still fine — REPL asks for one
        return null;
      }
      return null;
    case 'run':
      if (flagString(p.flags, 'daemon') && flagString(p.flags, 'session')) {
        return usage('kriyadot run takes only one of --daemon <name> and --session <name>.');
      }
      if (!flagString(p.flags, 'bot') && !p.global.overrides.some((o) => o.startsWith('bot='))) {
        return usage('kriyadot run needs --bot <id> (or -c bot=<id>).');
      }
      return null;
    case 'send':
      if (!p.subcommand && !flagBool(p.flags, 'continue')) {
        return usage('kriyadot send <name> "message" — name a session from "kriyadot sessions" (or --continue for the most recent).');
      }
      return null;
    case 'sessions':
      if (p.subcommand === '' || p.subcommand === 'list') return null;
      if (p.subcommand === 'delete') {
        if (p.positional.length === 0) return usage('kriyadot sessions delete <name>.');
        return null;
      }
      if (p.subcommand === 'rename') {
        if (p.positional.length < 2) return usage('kriyadot sessions rename <name> <title>.');
        return null;
      }
      return usage('kriyadot sessions [list|delete <name>|rename <name> <title>].');
    case 'bridge':
      if (['', 'invite', 'link', 'list', 'peers', 'experts', 'chat', 'unlink'].includes(p.subcommand)) return null;
      return usage('kriyadot bridge <invite|link|list|peers|experts|chat|unlink>.');
    case 'learning':
      if (['', 'list', 'show', 'delete', 'clear', 'evolution'].includes(p.subcommand)) return null;
      return usage('kriyadot learning <list|show|delete|clear|evolution>.');
    case 'workflows':
      if (['', 'list'].includes(p.subcommand)) return null;
      if (p.subcommand === 'dry-run') {
        if (p.positional.length === 0) return usage('kriyadot workflows dry-run <id>.');
        return null;
      }
      if (p.subcommand === 'run') {
        if (p.positional.length === 0) return usage('kriyadot workflows run <name|id>.');
        return null;
      }
      return usage('kriyadot workflows <list|dry-run <id>|run <name|id>>.');
    case 'daemon':
      if (['', 'start', 'list', 'stop'].includes(p.subcommand)) return null;
      return usage('kriyadot daemon <start|list|stop>.');
    case 'completion':
      if (p.subcommand === '' || p.subcommand === 'bash' || p.subcommand === 'zsh') return null;
      return usage('kriyadot completion [bash|zsh].');
    case 'bots':
      if (p.subcommand === 'list') return null;
      if (p.subcommand === 'run') {
        if (p.positional.length === 0) return usage('kriyadot bots run <bot> "task".');
        return null;
      }
      return usage('kriyadot bots <list|run>.');
    case 'threads':
      if (p.subcommand === 'list' || p.subcommand === 'show' || p.subcommand === 'branch' || p.subcommand === 'delete') return null;
      return usage('kriyadot threads <list|show|branch|delete>.');
    case 'routines':
      if (p.subcommand === 'list' || p.subcommand === 'run' || p.subcommand === 'runs') return null;
      return usage('kriyadot routines <list|run|runs>.');
    case 'team':
      if (p.subcommand === 'apply' || p.subcommand === 'export') return null;
      return usage('kriyadot team <apply|export>.');
    case 'tap':
      if (p.subcommand === '') return null;
      if (p.subcommand === 'init') {
        if (p.positional.length === 0) return usage('kriyadot tap init <dir> --kind <bot|workflow|capability|skill|tap>.');
        return null;
      }
      if (p.subcommand === 'install') {
        if (p.positional.length === 0) return usage('kriyadot tap install <ref>.');
        return null;
      }
      if (p.subcommand === 'validate') {
        if (p.positional.length === 0) return usage('kriyadot tap validate <dir>.');
        return null;
      }
      return usage('kriyadot tap <init|install|validate>.');
    case 'serve':
      return null;
    case 'models':
    case 'mcp':
      if (p.subcommand === 'list') return null;
      return usage(`kriyadot ${p.command} list.`);
    case 'login':
      return null;
    case 'pause':
      if (p.subcommand === '' || p.subcommand === 'status') return null;
      return usage('kriyadot pause [status].');
    case 'resume':
    case 'status':
      if (p.subcommand === '') return null;
      return usage(`kriyadot ${p.command}.`);
    case 'config':
      if (['', 'get', 'set', 'path', 'validate', 'init'].includes(p.subcommand)) return null;
      return usage('kriyadot config [get|set|path|validate|init].');
    case 'help':
    case '':
      return null;
    default:
      if (!GROUPED.has(p.command)) return usage(`Unknown command "${p.command}".`);
      return null;
  }
}

export function isGroupedCommand(command: string): boolean {
  return GROUPED.has(command);
}
