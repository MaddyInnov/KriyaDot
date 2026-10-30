// SPDX-License-Identifier: Apache-2.0
// Command implementations for the headless CLI. All I/O goes through the
// injected CommandDeps so the commands are unit-testable with a mocked API.
import { randomUUID } from 'node:crypto';
import {
  normalizeApiUrl,
  readLoopbackToken,
  isLoopbackUrl,
  saveConfigFile,
  configPath,
  configDir,
  tokenSource,
  getNamedSession,
  loadNamedSessions,
  saveNamedSession,
  deleteNamedSession,
  mostRecentNamedSession,
} from './config.js';
import type { CliConfig, NamedSession } from './config.js';
import { ApiError, KriyaDotApi } from './api.js';
import type { BotSummary, ChatEvent } from './api.js';
import { flagBool, flagString, requireFlag, validateCommand } from './args.js';
import type { OutputFormat, ParsedArgs } from './args.js';
import { HELP_TEXT, VERSION } from './help.js';
import { createReadlineSource, runRepl, runStreamingTurn } from './repl.js';
import type { ReplLineSource } from './repl.js';
import { EXIT_ERROR, EXIT_RESUMABLE, EXIT_USAGE } from './exits.js';
import { parseConfigOverrides, UsageError } from './overrides.js';
import type { ConfigOverrides } from './overrides.js';
import {
  COMPLETION_API_TIMEOUT_MS,
  bashCompletionScript,
  withTimeout,
  zshCompletionScript,
} from './completion.js';
import type { DynamicNames } from './completion.js';
import { runTapCommand } from './tap-commands.js';
import { runBridgeCommand } from './bridge-commands.js';
import { runLearningCommand } from './learning-commands.js';
import { runWorkflowCommand } from './workflow-commands.js';
import {
  enqueueInboxMessage,
  getDaemon,
  isDaemonAlive,
  listDaemons,
  runDaemonLoop,
  unregisterDaemon,
} from './daemon.js';
import { buildRepairMessage, parseSchemaFlag, validateReplyAgainstSpec, SchemaFlagError } from './json-schema.js';
import type { StructuredOutputSpec } from './json-schema.js';
import { defaultConfigTemplate, validateConfigObject } from './config-files.js';
import { createCliLogger, isLogLevel, LOG_LEVELS, resolveLogLevel } from './log.js';
import type { CliLogger } from './log.js';

/**
 * The CLI's own diagnostic logger (#181): level from the config file's
 * logLevel, overridden by KRIYADOT_LOG_LEVEL. Gates diagnostics (session
 * notes, daemon logs) — never chat output on stdout.
 */
function cliLogger(deps: CommandDeps): CliLogger {
  return createCliLogger((s) => deps.stderr.write(s), resolveLogLevel({ configLevel: deps.cfg.logLevel }));
}

export interface CommandDeps {
  cfg: CliConfig;
  api: KriyaDotApi;
  /** Build an API client for an arbitrary URL/token (used by `login`). */
  createApi: (apiUrl: string, token: string) => KriyaDotApi;
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  isTTY: boolean;
  readStdinAll: () => Promise<string>;
  prompt: (question: string) => Promise<string | null>;
  clearScreen: () => void;
  createLineSource: () => ReplLineSource;
}

function out(deps: CommandDeps, s: string): void {
  deps.stdout.write(s);
}
function err(deps: CommandDeps, s: string): void {
  deps.stderr.write(s);
}
function printJson(deps: CommandDeps, value: unknown): void {
  out(deps, `${JSON.stringify(value, null, 2)}\n`);
}

/** Resolve a bot by id (exact, then case-insensitive) or display name. */
async function resolveBot(deps: CommandDeps, ref: string): Promise<BotSummary> {
  const bots = await deps.api.listBots();
  const needle = ref.trim().toLowerCase();
  const hit =
    bots.find((b) => b.id === ref.trim()) ??
    bots.find((b) => b.id.toLowerCase() === needle) ??
    bots.find((b) => b.name.toLowerCase() === needle);
  if (!hit) {
    const ids = bots.map((b) => b.id).join(', ');
    throw new Error(`Unknown bot "${ref}". Available: ${ids || '(none)'}`);
  }
  return hit;
}

/** Message for chat/run: positional words, --message, or piped stdin. */
async function resolveMessage(deps: CommandDeps, p: ParsedArgs, words: string[]): Promise<string | null> {
  const fromFlag = flagString(p.flags, 'message');
  if (fromFlag) return fromFlag;
  if (words.length > 0) return words.join(' ');
  if (!deps.isTTY) {
    const piped = (await deps.readStdinAll()).trim();
    return piped || null;
  }
  return null;
}

interface ChatRunOpts {
  bot: BotSummary;
  message: string;
  sessionId: string;
  model?: string;
  providerId?: string;
  autoApprove: boolean;
  format: OutputFormat;
  /** Structured output (#108): forwarded as responseFormat + validated locally with one repair retry. */
  schema?: StructuredOutputSpec;
  /** Dotted `-c` overrides (#110) forwarded per-run. */
  configOverrides?: Record<string, unknown>;
}

/**
 * Serialize one chat event as a JSONL line. Unknown events forward their
 * raw payload so new server event types keep their original `type`.
 */
export function jsonlLine(ev: ChatEvent): string {
  if (ev.type === 'unknown') return JSON.stringify(ev.raw ?? ev);
  return JSON.stringify(ev);
}

/** Parse the --schema flag (chat/run); a bad value is a usage error. */
function resolveSchemaFlag(p: ParsedArgs): StructuredOutputSpec | undefined {
  const raw = flagString(p.flags, 'schema');
  if (!raw) return undefined;
  try {
    return parseSchemaFlag(raw);
  } catch (e) {
    if (e instanceof SchemaFlagError) throw new UsageError(e.message);
    throw e;
  }
}

/** One-shot turn shared by `chat`, `run`, `bots run` and `send`. */
async function oneShotTurn(deps: CommandDeps, o: ChatRunOpts): Promise<number> {
  const json = o.format === 'json';
  const jsonl = o.format === 'jsonl';
  const askApproval = async (toolName: string): Promise<boolean> => {
    err(deps, `[headless] denied approval for "${toolName}" (re-run with --auto-approve to allow)\n`);
    return false;
  };
  const turnIo = { api: deps.api, out: (s: string) => deps.stdout.write(s), err: (s: string) => deps.stderr.write(s) };
  const turnOpts = {
    botId: o.bot.id,
    sessionId: o.sessionId,
    ...(o.model ? { model: o.model } : {}),
    ...(o.providerId ? { providerId: o.providerId } : {}),
    autoApprove: o.autoApprove,
    ...(o.schema ? { responseFormat: o.schema } : {}),
    ...(o.configOverrides ? { configOverrides: o.configOverrides } : {}),
    ...(jsonl
      ? {
          onEvent: (ev: ChatEvent) => {
            out(deps, `${jsonlLine(ev)}\n`);
          },
        }
      : {}),
  };
  // With --schema the reply is validated before anything is printed, so
  // tokens are buffered instead of streamed; the (possibly repaired)
  // final content is what reaches stdout.
  let result = await runStreamingTurn(
    turnIo,
    { ...turnOpts, message: o.message },
    askApproval,
    (t) => {
      if (!json && !jsonl && !o.schema) deps.stdout.write(t);
    },
  );
  if (o.schema && !result.failed && !jsonl) {
    let errors = validateReplyAgainstSpec(result.content, o.schema);
    if (errors.length > 0) {
      err(deps, `[schema] reply failed validation (${errors.length} problem(s)); asking for one repair\n`);
      const repaired = await runStreamingTurn(
        turnIo,
        { ...turnOpts, message: buildRepairMessage(o.schema, errors) },
        askApproval,
        () => undefined,
      );
      if (!repaired.failed) {
        result = repaired;
        errors = validateReplyAgainstSpec(result.content, o.schema);
      }
    }
    if (errors.length > 0) {
      err(deps, `[schema] reply still invalid after one repair retry:\n${errors.map((e) => `  - ${e}`).join('\n')}\n`);
      if (json) {
        printJson(deps, { ok: false, bot: o.bot.id, sessionId: o.sessionId, error: 'schema validation failed', schemaErrors: errors, content: result.content });
      }
      return EXIT_ERROR;
    }
    if (!json) deps.stdout.write(result.content);
  }
  if (jsonl) {
    // stdout is the pure event stream; diagnostics stay on stderr.
    if (result.failed) err(deps, `[error] ${result.error ?? 'turn failed'}\n`);
    return result.failed ? (result.resumable ? EXIT_RESUMABLE : EXIT_ERROR) : 0;
  }
  if (!json) {
    deps.stdout.write('\n');
    if (result.failed) err(deps, `[error] ${result.error ?? 'turn failed'}\n`);
  }
  if (json) {
    printJson(
      deps,
      result.failed
        ? {
            ok: false,
            bot: o.bot.id,
            sessionId: o.sessionId,
            error: result.error ?? 'turn failed',
            ...(result.resumable ? { resumable: true } : {}),
          }
        : {
            ok: true,
            bot: o.bot.id,
            sessionId: o.sessionId,
            content: result.content,
            usage: result.usage ?? null,
          },
    );
  }
  return result.failed ? (result.resumable ? EXIT_RESUMABLE : EXIT_ERROR) : 0;
}

function printPauseState(
  deps: CommandDeps,
  state: { paused: boolean; pausedAt?: number | null; pausedBy?: string | null; reason?: string | null },
  format: OutputFormat,
): void {
  if (format === 'json') {
    printJson(deps, state);
    return;
  }
  if (state.paused) {
    const at = state.pausedAt ? new Date(state.pausedAt).toISOString() : 'unknown time';
    out(deps, `paused (since ${at}${state.pausedBy ? `, by ${state.pausedBy}` : ''}${state.reason ? ` — ${state.reason}` : ''})\n`);
  } else {
    out(deps, 'not paused — KriyaDot is running normally\n');
  }
}

/** `kriyadot pause [status]` / `kriyadot resume` / `kriyadot status` (W14d). */
async function doPauseCommand(deps: CommandDeps, p: ParsedArgs): Promise<number> {
  if (p.command === 'resume') {
    printPauseState(deps, await deps.api.resumeSystem(), p.global.format);
    return 0;
  }
  if (p.command === 'status' || p.subcommand === 'status') {
    printPauseState(deps, await deps.api.getPauseState(), p.global.format);
    return 0;
  }
  printPauseState(deps, await deps.api.pauseSystem(), p.global.format);
  return 0;
}

/** Apply a `-c apiUrl=` override by swapping in a client for that URL. */
function withApiOverride(deps: CommandDeps, ov: ConfigOverrides): CommandDeps {
  if (!ov.apiUrl || ov.apiUrl === deps.cfg.apiUrl) return deps;
  return { ...deps, api: deps.createApi(ov.apiUrl, deps.cfg.token) };
}

/**
 * Resolve the session for a run/chat invocation:
 *  - `--daemon <name>`: reuse the named session's id (creating the record
 *    on first use) so the conversation can be continued by name later.
 *  - `--session <name>`: when the value names a recorded session, use its
 *    sessionId (and note a bot mismatch); otherwise it is a raw session id.
 *  - otherwise: the caller's default (a fresh random id).
 * Returns the sessionId plus the daemon record to persist, if any.
 */
function resolveSessionFlags(
  deps: CommandDeps,
  p: ParsedArgs,
  bot: BotSummary,
  fallbackSessionId: string,
): { sessionId: string; daemonName?: string } {
  const daemonName = flagString(p.flags, 'daemon');
  if (daemonName) {
    const existing = getNamedSession(daemonName);
    if (existing) {
      if (existing.botId !== bot.id) {
        err(
          deps,
          `[session] "${daemonName}" was recorded for bot ${existing.botId}; starting a fresh session for ${bot.id}\n`,
        );
        return { sessionId: randomUUID(), daemonName };
      }
      return { sessionId: existing.sessionId, daemonName };
    }
    return { sessionId: fallbackSessionId, daemonName };
  }
  const sessionFlag = flagString(p.flags, 'session');
  if (sessionFlag) {
    const named = getNamedSession(sessionFlag);
    if (named) {
      if (named.botId !== bot.id) {
        err(deps, `[session] "${sessionFlag}" belongs to bot ${named.botId}, not ${bot.id} — using it anyway\n`);
      }
      return { sessionId: named.sessionId };
    }
    return { sessionId: sessionFlag };
  }
  return { sessionId: fallbackSessionId };
}

/**
 * Most-recent session resolution for `--continue` (#32): prefer the
 * SERVER's most recent thread for the bot (its id + server-side title),
 * falling back to the local named-session store when the server is
 * unreachable or has no thread. Returns null when neither knows one.
 */
export async function resolveMostRecentSession(
  deps: CommandDeps,
  botId: string,
): Promise<{ sessionId: string; label: string; source: 'server' | 'local' } | null> {
  try {
    const threads = await deps.api.listThreads({ botId });
    if (threads.length > 0) {
      const sorted = [...threads].sort((a, b) => String(b.lastMessageTs ?? '').localeCompare(String(a.lastMessageTs ?? '')));
      const t = sorted[0]!;
      return { sessionId: t.id, label: t.title ?? t.id, source: 'server' };
    }
  } catch {
    // server unreachable — fall through to the local store
  }
  const local = mostRecentNamedSession();
  if (local && local.botId === botId) return { sessionId: local.sessionId, label: local.name, source: 'local' };
  return null;
}

/** Persist a daemon record and announce it on stderr (stdout stays clean). */
function recordDaemonSession(deps: CommandDeps, name: string, sessionId: string, botId: string): void {
  const record: NamedSession = { name, sessionId, botId, updatedAt: Date.now() };
  saveNamedSession(record);
  cliLogger(deps).info(`[session] "${name}" → ${sessionId} (bot ${botId}) — continue with: kriyadot send ${name} "…"`);
}

async function doChat(deps0: CommandDeps, p: ParsedArgs, ov: ConfigOverrides): Promise<number> {
  const deps = withApiOverride(deps0, ov);
  const format = ov.format ?? p.global.format;
  // `chat <bot> [message...]` — subcommand slot holds the bot ref.
  let botRef = ov.bot ?? p.subcommand;
  if (!botRef && deps.isTTY) {
    const bots = await deps.api.listBots();
    if (bots.length === 0) throw new Error('No bots configured on this server.');
    err(deps, 'Available bots:\n');
    for (const b of bots) err(deps, `  ${b.id} — ${b.name}\n`);
    const answer = await deps.prompt('Bot id: ');
    if (!answer?.trim()) throw new Error('No bot selected.');
    botRef = answer.trim();
  }
  if (!botRef) throw new Error('Usage: kriyadot chat <bot> [message]');
  const bot = await resolveBot(deps, botRef);
  const message = await resolveMessage(deps, p, p.positional);
  const model = ov.model ?? flagString(p.flags, 'model');
  const provider = ov.provider ?? flagString(p.flags, 'provider');

  if (message === null) {
    if (!deps.isTTY) throw new Error('No message given and stdin is not a pipe. Usage: kriyadot chat <bot> [message]');
    // Interactive REPL. --daemon names the REPL session too; --continue
    // resumes the most recent session (#32).
    let sess = resolveSessionFlags(deps, p, bot, randomUUID());
    if (flagBool(p.flags, 'continue')) {
      const recent = await resolveMostRecentSession(deps, bot.id);
      if (!recent) throw new Error('No recent session to continue for this bot.');
      err(deps, `[session] continuing ${recent.source} session "${recent.label}" (${recent.sessionId})\n`);
      sess = { sessionId: recent.sessionId };
    }
    if (sess.daemonName) recordDaemonSession(deps, sess.daemonName, sess.sessionId, bot.id);
    return runRepl(
      {
        api: deps.api,
        botName: bot.name,
        out: (s) => deps.stdout.write(s),
        err: (s) => deps.stderr.write(s),
        lines: deps.createLineSource(),
        clearScreen: deps.clearScreen,
      },
      { botId: bot.id, sessionId: sess.sessionId, ...(model ? { model } : {}) },
    );
  }

  let sess = resolveSessionFlags(deps, p, bot, randomUUID());
  if (flagBool(p.flags, 'continue')) {
    const recent = await resolveMostRecentSession(deps, bot.id);
    if (!recent) throw new Error('No recent session to continue for this bot.');
    err(deps, `[session] continuing ${recent.source} session "${recent.label}" (${recent.sessionId})\n`);
    sess = { sessionId: recent.sessionId };
  }
  if (sess.daemonName) recordDaemonSession(deps, sess.daemonName, sess.sessionId, bot.id);
  return oneShotTurn(deps, {
    bot,
    message,
    sessionId: sess.sessionId,
    ...(model ? { model } : {}),
    ...(provider ? { providerId: provider } : {}),
    autoApprove: flagBool(p.flags, 'auto-approve') || flagBool(p.flags, 'autoapprove'),
    format,
    ...(resolveSchemaFlag(p) ? { schema: resolveSchemaFlag(p)! } : {}),
    ...(ov.nested ? { configOverrides: ov.nested } : {}),
  });
}

async function doRun(deps0: CommandDeps, p: ParsedArgs, ov: ConfigOverrides): Promise<number> {
  const deps = withApiOverride(deps0, ov);
  const botRef = ov.bot ?? requireFlag(p.flags, 'bot', 'Example: kriyadot run --bot coder --message "hi"');
  const bot = await resolveBot(deps, botRef);
  const message = await resolveMessage(deps, p, p.positional);
  if (message === null) throw new Error('No message given. Pass --message or pipe stdin.');
  let sess = resolveSessionFlags(deps, p, bot, randomUUID());
  if (flagBool(p.flags, 'continue')) {
    const recent = await resolveMostRecentSession(deps, bot.id);
    if (!recent) throw new Error('No recent session to continue for this bot.');
    err(deps, `[session] continuing ${recent.source} session "${recent.label}" (${recent.sessionId})\n`);
    sess = { sessionId: recent.sessionId };
  }
  if (sess.daemonName) recordDaemonSession(deps, sess.daemonName, sess.sessionId, bot.id);
  const model = ov.model ?? flagString(p.flags, 'model');
  const provider = ov.provider ?? flagString(p.flags, 'provider');
  return oneShotTurn(deps, {
    bot,
    message,
    sessionId: sess.sessionId,
    ...(model ? { model } : {}),
    ...(provider ? { providerId: provider } : {}),
    autoApprove: flagBool(p.flags, 'auto-approve') || flagBool(p.flags, 'autoapprove'),
    format: ov.format ?? p.global.format,
    ...(resolveSchemaFlag(p) ? { schema: resolveSchemaFlag(p)! } : {}),
    ...(ov.nested ? { configOverrides: ov.nested } : {}),
  });
}

/**
 * `kriyadot send <name> "follow-up"` — post a message to a named daemon
 * session recorded by `run --daemon <name>`, continuing that conversation.
 */
async function doSend(deps: CommandDeps, p: ParsedArgs): Promise<number> {
  // `send --continue "…"` (#32): the most recent named session, no name needed.
  let name = p.subcommand;
  if (flagBool(p.flags, 'continue') && !getNamedSession(name)) {
    const recent = mostRecentNamedSession();
    if (!recent) throw new Error('No named sessions to continue. Start one with: kriyadot run --bot <id> --daemon <name> --message "…"');
    name = recent.name;
  }
  const named = getNamedSession(name);
  if (!named) {
    throw new Error(
      `No named session "${name}". Start one with: kriyadot run --bot <id> --daemon ${name} --message "…"`,
    );
  }
  const bot = await resolveBot(deps, named.botId);
  const message = await resolveMessage(deps, p, p.positional);
  if (message === null) throw new Error(`Usage: kriyadot send ${name} "message"`);
  // Live-daemon delivery (#102): when a daemon process holds this session,
  // inject instead of starting a new turn — API inject endpoint first
  // (steer into the live session), local inbox as the fallback channel.
  const daemon = getDaemon(configDir(), name);
  if (isDaemonAlive(daemon) || flagBool(p.flags, 'inject')) {
    try {
      const res = await deps.api.request<{ ok: boolean; delivery?: string }>(
        `/daemon/sessions/${encodeURIComponent(name)}/inject`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: message }),
        },
      );
      out(deps, `Injected into live daemon "${name}" (${res.delivery ?? 'queued'}).\n`);
      saveNamedSession({ ...named, updatedAt: Date.now() });
      return 0;
    } catch (e) {
      if (isDaemonAlive(daemon)) {
        enqueueInboxMessage(configDir(), name, message);
        out(deps, `Queued in the local inbox of live daemon "${name}" (API inject unavailable: ${e instanceof Error ? e.message : String(e)}).\n`);
        saveNamedSession({ ...named, updatedAt: Date.now() });
        return 0;
      }
      if (flagBool(p.flags, 'inject')) throw e;
      // not live after all — fall through to the classic new-turn send
    }
  }
  const code = await oneShotTurn(deps, {
    bot,
    message,
    sessionId: named.sessionId,
    ...(flagString(p.flags, 'model') ? { model: flagString(p.flags, 'model')! } : {}),
    ...(flagString(p.flags, 'provider') ? { providerId: flagString(p.flags, 'provider')! } : {}),
    autoApprove: flagBool(p.flags, 'auto-approve') || flagBool(p.flags, 'autoapprove'),
    format: p.global.format,
  });
  saveNamedSession({ ...named, updatedAt: Date.now() });
  return code;
}

/** `kriyadot sessions [list]` / `delete <name>` / `rename <name> <title>`. */
async function doSessions(deps: CommandDeps, p: ParsedArgs): Promise<number> {
  if (p.subcommand === 'delete') {
    const name = p.positional[0];
    if (!name || !deleteNamedSession(name)) throw new Error(`No named session "${name}".`);
    if (p.global.format === 'json') {
      printJson(deps, { ok: true, deleted: name });
      return 0;
    }
    out(deps, `Deleted named session "${name}"\n`);
    return 0;
  }
  if (p.subcommand === 'rename') {
    // Local title write (#32): the API exposes server-side thread titles
    // for reading but has no title-write endpoint for plain sessions, so
    // the rename is stored locally and server titles win on read.
    const [name, ...titleWords] = p.positional;
    const title = titleWords.join(' ').trim();
    const existing = name ? getNamedSession(name) : null;
    if (!existing || !title) throw new Error('Usage: kriyadot sessions rename <name> <title>');
    saveNamedSession({ ...existing, title, updatedAt: Date.now() });
    out(deps, `Renamed "${name}" → "${title}" (local title; server thread titles take precedence when present)\n`);
    return 0;
  }
  const sessions = loadNamedSessions();
  // Server-side titles (#32): when the server is reachable, a thread's
  // title is the session's shared name — merge it over the local record.
  let serverTitles = new Map<string, string>();
  try {
    const threads = await deps.api.listThreads({});
    serverTitles = new Map(threads.filter((t) => t.title).map((t) => [t.id, t.title as string]));
  } catch {
    // offline: local names only
  }
  const merged = sessions.map((s) => {
    const title = serverTitles.get(s.sessionId) ?? s.title;
    return title ? { ...s, title } : s;
  });
  if (p.global.format === 'json') {
    printJson(deps, merged);
    return 0;
  }
  if (merged.length === 0) {
    out(deps, 'No named sessions. Start one with: kriyadot run --bot <id> --daemon <name> --message "…"\n');
    return 0;
  }
  for (const s of merged) {
    const when = s.updatedAt ? new Date(s.updatedAt).toISOString() : '—';
    out(deps, `${s.name}\tbot:${s.botId}\t${s.sessionId}\t${when}${s.title ? `\t"${s.title}"` : ''}\n`);
  }
  return 0;
}

/**
 * `kriyadot daemon start|list|stop <name>` (#102/#109): start runs the
 * foreground daemon loop (holds the session, heartbeats, drains the
 * inject inbox); list shows the local registry with liveness; stop
 * signals the recorded pid and unregisters.
 */
async function doDaemon(deps: CommandDeps, p: ParsedArgs): Promise<number> {
  const dir = configDir();
  if (p.subcommand === 'list' || p.subcommand === '') {
    const daemons = listDaemons(dir);
    if (p.global.format === 'json') {
      printJson(deps, daemons.map((d) => ({ ...d, alive: isDaemonAlive(d) })));
      return 0;
    }
    if (daemons.length === 0) {
      out(deps, 'No daemons registered. Start one with: kriyadot daemon start <name> --bot <id>\n');
      return 0;
    }
    for (const d of daemons) {
      out(deps, `${d.name}\tpid:${d.pid}\t${isDaemonAlive(d) ? 'alive' : 'stale'}\tbot:${d.botId}\t${d.sessionId}\n`);
    }
    return 0;
  }
  if (p.subcommand === 'stop') {
    const name = p.positional[0];
    if (!name) throw new Error('Usage: kriyadot daemon stop <name>');
    const rec = getDaemon(dir, name);
    if (!rec) throw new Error(`No daemon named "${name}".`);
    try {
      process.kill(rec.pid, 'SIGTERM');
    } catch {
      // already gone — unregistering is still the right cleanup
    }
    unregisterDaemon(dir, name);
    try {
      await deps.api.request(`/daemon/sessions/${encodeURIComponent(name)}`, { method: 'DELETE' });
    } catch {
      // API may not have the registration; local cleanup already done
    }
    out(deps, `Stopped daemon "${name}" (pid ${rec.pid}).\n`);
    return 0;
  }
  if (p.subcommand === 'start') {
    const name = p.positional[0];
    if (!name) throw new Error('Usage: kriyadot daemon start <name> --bot <id>');
    const existing = getDaemon(dir, name);
    if (existing && isDaemonAlive(existing)) {
      throw new Error(`Daemon "${name}" is already running (pid ${existing.pid}).`);
    }
    const named = getNamedSession(name);
    const botRef = flagString(p.flags, 'bot') ?? named?.botId;
    if (!botRef) throw new Error(`Usage: kriyadot daemon start ${name} --bot <id> (or record the session first with run --daemon)`);
    const bot = await resolveBot(deps, botRef);
    const sessionId = named && named.botId === bot.id ? named.sessionId : randomUUID();
    saveNamedSession({ name, sessionId, botId: bot.id, updatedAt: Date.now() });
    const pollRaw = flagString(p.flags, 'poll-ms');
    const pollMs = pollRaw !== undefined ? Number(pollRaw) : undefined;
    await runDaemonLoop({
      dir,
      record: { name, sessionId, botId: bot.id, pid: process.pid, startedAt: Date.now(), heartbeatAt: Date.now() },
      log: (m) => cliLogger(deps).info(m),
      ...(pollMs !== undefined && Number.isFinite(pollMs) && pollMs > 0 ? { pollMs } : {}),
      apiRegister: async () => {
        await deps.api.request('/daemon/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, sessionId, pid: process.pid }),
        });
      },
      apiHeartbeat: async () => {
        await deps.api.request(`/daemon/sessions/${encodeURIComponent(name)}/heartbeat`, { method: 'POST' });
      },
      apiUnregister: async () => {
        await deps.api.request(`/daemon/sessions/${encodeURIComponent(name)}`, { method: 'DELETE' });
      },
      runTurn: async (message) => {
        const result = await runStreamingTurn(
          { api: deps.api, out: (s) => deps.stdout.write(s), err: (s) => deps.stderr.write(s) },
          { botId: bot.id, message, sessionId, autoApprove: false },
          async () => false,
          (t) => deps.stdout.write(t),
        );
        if (result.failed) err(deps, `[daemon] turn failed: ${result.error ?? 'unknown'}\n`);
        saveNamedSession({ name, sessionId, botId: bot.id, updatedAt: Date.now() });
      },
    });
    return 0;
  }
  throw new Error('Usage: kriyadot daemon <start|list|stop>.');
}

/**
 * `kriyadot completion [bash|zsh]` — print a shell completion script.
 * Bot/workflow names are baked in from the API when it answers quickly;
 * otherwise the script silently covers the static surface only.
 */
async function doCompletion(deps: CommandDeps, p: ParsedArgs): Promise<number> {
  let dynamic: DynamicNames = { bots: [], workflows: [] };
  try {
    const [bots, routines] = await withTimeout(
      Promise.all([deps.api.listBots(), deps.api.listRoutines()]),
      COMPLETION_API_TIMEOUT_MS,
    );
    dynamic = { bots: bots.map((b) => b.id), workflows: routines.map((r) => r.id) };
  } catch {
    // API unreachable or too slow — static fallback, by design.
  }
  if (p.subcommand === 'bash') {
    out(deps, bashCompletionScript(dynamic));
    return 0;
  }
  if (p.subcommand === 'zsh') {
    out(deps, zshCompletionScript(dynamic));
    return 0;
  }
  out(deps, `# ==== bash ====\n${bashCompletionScript(dynamic)}`);
  out(deps, `# ==== zsh ====\n${zshCompletionScript(dynamic)}`);
  return 0;
}

async function doBots(deps: CommandDeps, p: ParsedArgs): Promise<number> {
  if (p.subcommand === 'list') {
    const bots = await deps.api.listBots();
    if (p.global.format === 'json') {
      printJson(deps, bots);
      return 0;
    }
    if (bots.length === 0) {
      out(deps, 'No bots configured.\n');
      return 0;
    }
    for (const b of bots) out(deps, `${b.id}\t${b.name}${b.model ? `\t${b.model}` : ''}\n`);
    return 0;
  }
  // bots run <bot> "task..."
  const [botRef, ...taskWords] = p.positional;
  const bot = await resolveBot(deps, botRef);
  const message = await resolveMessage(deps, p, taskWords);
  if (message === null) throw new Error('Usage: kriyadot bots run <bot> "task"');
  return oneShotTurn(deps, {
    bot,
    message,
    sessionId: flagString(p.flags, 'session') ?? randomUUID(),
    autoApprove: flagBool(p.flags, 'auto-approve') || flagBool(p.flags, 'autoapprove'),
    format: p.global.format,
  });
}

async function doThreads(deps: CommandDeps, p: ParsedArgs): Promise<number> {
  if (p.subcommand === 'list') {
    const limitRaw = flagString(p.flags, 'limit');
    const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;
    if (limitRaw !== undefined && !Number.isSafeInteger(limit)) throw new Error('--limit must be an integer');
    const threads = await deps.api.listThreads({
      ...(flagString(p.flags, 'bot') ? { botId: flagString(p.flags, 'bot')! } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    if (p.global.format === 'json') {
      printJson(deps, threads);
      return 0;
    }
    if (threads.length === 0) {
      out(deps, 'No threads yet.\n');
      return 0;
    }
    for (const t of threads) {
      out(deps, `${t.id}\t${t.botId}\t${t.title ?? '(untitled)'}\t${t.messageCount} msgs\n`);
    }
    return 0;
  }
  if (p.subcommand === 'show') {
    const id = p.positional[0];
    if (!id) throw new Error('Usage: kriyadot threads show <id> [--limit n]');
    const limitRaw = flagString(p.flags, 'limit');
    let messages = await deps.api.threadMessages(id);
    if (limitRaw !== undefined) {
      const limit = Number(limitRaw);
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer');
      messages = messages.slice(-limit);
    }
    if (p.global.format === 'json') {
      printJson(deps, messages);
      return 0;
    }
    for (const m of messages) {
      const role = m.role === 'user' ? 'you' : m.role;
      out(deps, `[${m.id}] ${role}: ${m.content}\n`);
    }
    return 0;
  }
  if (p.subcommand === 'delete') {
    const id = p.positional[0];
    if (!id) throw new Error('Usage: kriyadot threads delete <id> [--yes]');
    if (!flagBool(p.flags, 'yes')) {
      throw new Error(`Refusing to delete thread "${id}" without --yes.`);
    }
    await deps.api.deleteThread(id);
    if (p.global.format === 'json') {
      printJson(deps, { ok: true, deleted: id });
      return 0;
    }
    out(deps, `Deleted thread ${id}\n`);
    return 0;
  }
  // threads branch <id> --from <msgId> [--title t]
  const id = p.positional[0];
  if (!id) throw new Error('Usage: kriyadot threads branch <id> --from <msgId> [--title t]');
  const fromRaw = requireFlag(p.flags, 'from', 'Pass the message id from "threads show <id>".');
  const fromMessageId = Number(fromRaw);
  if (!Number.isSafeInteger(fromMessageId) || fromMessageId < 1) throw new Error('--from must be a positive message id');
  const title = flagString(p.flags, 'title');
  const thread = await deps.api.branchThread(id, { fromMessageId, ...(title ? { title } : {}) });
  if (p.global.format === 'json') {
    printJson(deps, { ok: true, thread });
    return 0;
  }
  out(deps, `Branched to ${thread.id} ("${thread.title}")\n`);
  return 0;
}

async function doRoutines(deps: CommandDeps, p: ParsedArgs): Promise<number> {
  if (p.subcommand === 'list') {
    const routines = await deps.api.listRoutines();
    if (p.global.format === 'json') {
      printJson(deps, routines);
      return 0;
    }
    if (routines.length === 0) {
      out(deps, 'No routines configured.\n');
      return 0;
    }
    for (const r of routines) {
      out(deps, `${r.id}\t${r.name}\tbot:${r.botId}${r.enabled === false ? '\t(disabled)' : ''}\n`);
    }
    return 0;
  }
  // routines run <id>
  if (p.subcommand === 'run') {
    const id = p.positional[0];
    if (!id) throw new Error('Usage: kriyadot routines run <id>');
    const runId = await deps.api.runRoutineNow(id);
    if (p.global.format === 'json') {
      printJson(deps, { ok: true, routineId: id, runId });
      return 0;
    }
    out(deps, `Run started: ${runId}\n`);
    return 0;
  }
  // routines runs <id> [--limit n]
  if (p.subcommand === 'runs') {
    const id = p.positional[0];
    if (!id) throw new Error('Usage: kriyadot routines runs <id> [--limit n]');
    const limitRaw = flagString(p.flags, 'limit');
    const limit = limitRaw !== undefined ? Number(limitRaw) : 20;
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer');
    const runs = await deps.api.listRoutineRuns(id, limit);
    if (p.global.format === 'json') {
      printJson(deps, runs);
      return 0;
    }
    if (runs.length === 0) {
      out(deps, 'No runs yet.\n');
      return 0;
    }
    for (const r of runs) {
      const when = r.startedAt ? new Date(r.startedAt).toISOString() : '—';
      out(deps, `${r.id}\t${r.status}\t${when}\n`);
    }
    return 0;
  }
  throw new Error('Usage: kriyadot routines <list|run|runs>.');
}

/**
 * team apply <file> — applies a kriyadot.team.json manifest or a markdown
 * team doc (.md) via the API. team export <teamId> [--markdown] prints the
 * team (manifest JSON by default, markdown with --markdown).
 */
async function doTeam(deps: CommandDeps, p: ParsedArgs): Promise<number> {
  const { readFileSync } = await import('node:fs');
  if (p.subcommand === 'apply') {
    const file = p.positional[0];
    if (!file) throw new Error('Usage: kriyadot team apply <file.json|file.md>');
    const text = readFileSync(file, 'utf8');
    if (file.endsWith('.md')) {
      const team = await deps.api.importTeamMarkdown(text);
      if (p.global.format === 'json') {
        printJson(deps, { ok: true, team });
        return 0;
      }
      out(deps, `Team imported: ${team.name} (${team.id})\n`);
      return 0;
    }
    let manifest: unknown;
    try {
      manifest = JSON.parse(text);
    } catch {
      throw new Error(`"${file}" is not valid JSON and does not end in .md`);
    }
    const team = await deps.api.importTeamManifest(manifest);
    if (p.global.format === 'json') {
      printJson(deps, { ok: true, team });
      return 0;
    }
    out(deps, `Team applied: ${team.name} (${team.id})\n`);
    return 0;
  }
  if (p.subcommand === 'export') {
    const teamId = p.positional[0];
    if (!teamId) throw new Error('Usage: kriyadot team export <teamId> [--markdown]');
    if (flagBool(p.flags, 'markdown')) {
      out(deps, `${await deps.api.exportTeamMarkdown(teamId)}\n`);
      return 0;
    }
    // JSON export: fetch the team via the API manifest surface.
    const team = await deps.api.request<{ ok: boolean; team: unknown }>(
      `/teams/${encodeURIComponent(teamId)}`,
    );
    printJson(deps, team.team);
    return 0;
  }
  throw new Error('Usage: kriyadot team <apply|export>.');
}

/**
 * serve --port N — starts the API server in the foreground for headless/CI
 * use. Resolves the API entry the same way the desktop shell does: the
 * workspace's @mvp/api dist when present, else the installed package.
 */
async function doServe(deps: CommandDeps, p: ParsedArgs): Promise<number> {
  const { spawn } = await import('node:child_process');
  const { existsSync } = await import('node:fs');
  const { dirname, join, resolve } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const portRaw = flagString(p.flags, 'port');
  const port = portRaw !== undefined ? Number(portRaw) : 3000;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('--port must be 1-65535');

  // The CLI ships inside the workspace next to apps/api; resolve its dist
  // entry. Fall back to a node_modules-installed @mvp/api.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '..', '..', 'apps', 'api', 'dist', 'index.js'),
    resolve(here, '..', 'node_modules', '@mvp', 'api', 'dist', 'index.js'),
  ];
  const entry = candidates.find((c) => existsSync(c));
  if (!entry) {
    throw new Error('Could not find the API server entry (apps/api/dist/index.js). Build the API first.');
  }
  out(deps, `Starting API server on port ${port} (${entry})…\n`);
  // The API resolves its port from `--port <n>` → PORT env → 4000, so pass
  // the flag explicitly (the desktop sidecar does the same).
  const child = spawn(process.execPath, [entry, '--port', String(port)], {
    env: { ...process.env, PORT: String(port) },
    stdio: 'inherit',
  });
  await new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`API server exited with code ${code}`));
    });
  });
  return 0;
}

async function doModels(deps: CommandDeps, p: ParsedArgs): Promise<number> {  const models = await deps.api.listModels();
  if (p.global.format === 'json') {
    printJson(deps, models);
    return 0;
  }
  if (models.length === 0) {
    out(deps, 'No models available.\n');
    return 0;
  }
  for (const m of models) out(deps, `${m.providerId}/${m.id}\t${m.name}${m.free ? '\t(free)' : ''}\n`);
  return 0;
}

async function doMcp(deps: CommandDeps, p: ParsedArgs): Promise<number> {
  const servers = await deps.api.listMcpServers();
  if (p.global.format === 'json') {
    printJson(deps, servers);
    return 0;
  }
  if (servers.length === 0) {
    out(deps, 'No MCP servers installed.\n');
    return 0;
  }
  for (const s of servers) {
    const health = typeof s.health?.status === 'string' ? s.health.status : 'unknown';
    out(deps, `${s.id}\t${s.label ?? ''}\t${s.enabled === false ? 'disabled' : 'enabled'}\t${health}\n`);
  }
  return 0;
}

async function verifyAndSaveLogin(deps: CommandDeps, apiUrl: string, token: string): Promise<number> {
  const api = deps.createApi(apiUrl, token);
  if (!(await api.health())) {
    throw new Error(`Cannot reach KriyaDot API at ${apiUrl} — is the server running?`);
  }
  try {
    await api.listBots();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      throw new Error('Token rejected (401). Re-run with a valid token: kriyadot login --token <token>');
    }
    throw e;
  }
  saveConfigFile({ apiUrl, token });
  out(deps, `Logged in to ${apiUrl} (config saved to ${configPath()}).\n`);
  return 0;
}

async function doLogin(deps: CommandDeps, p: ParsedArgs): Promise<number> {
  const apiUrl = p.global.api ?? deps.cfg.apiUrl;
  let token = p.global.token ?? deps.cfg.token;
  if (!token && isLoopbackUrl(apiUrl)) token = readLoopbackToken() ?? '';
  if (!token) {
    if (!deps.isTTY) {
      throw new Error(
        'No token found. For a remote API pass --token <token> or set KRIYADOT_TOKEN (run interactively to paste one).',
      );
    }
    const pasted = await deps.prompt('Paste the API token (from the desktop app settings): ');
    if (!pasted?.trim()) throw new Error('No token given.');
    token = pasted.trim();
  }
  return verifyAndSaveLogin(deps, apiUrl, token);
}

async function doConfig(deps: CommandDeps, p: ParsedArgs): Promise<number> {
  const cfg = deps.cfg;
  const masked = cfg.token ? '***set***' : '(not set)';
  if (p.subcommand === '' || p.subcommand === undefined) {
    out(deps, `apiUrl  ${cfg.apiUrl}\n`);
    out(deps, `token   ${masked}\n`);
    out(deps, `logLevel  ${resolveLogLevel({ configLevel: cfg.logLevel })}\n`);
    out(deps, `file    ${configPath()}\n`);
    return 0;
  }
  if (p.subcommand === 'path') {
    out(deps, `${configPath()}\n`);
    return 0;
  }
  if (p.subcommand === 'init') {
    // #111: write the commented default config (JSONC). Refuses to
    // clobber an existing file without --force.
    const { existsSync, writeFileSync, mkdirSync } = await import('node:fs');
    if (existsSync(configPath()) && !flagBool(p.flags, 'force')) {
      throw new Error(`Config already exists at ${configPath()} — pass --force to overwrite it.`);
    }
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(configPath(), defaultConfigTemplate(), { mode: 0o600 });
    out(deps, `Wrote default config to ${configPath()} (edit it, then run: kriyadot config validate)\n`);
    return 0;
  }
  if (p.subcommand === 'validate') {
    // #111: validate the on-disk config (drop-ins merged, migrations
    // applied by the loader) — unknown keys are warnings, bad types are
    // errors. Exit 1 when invalid so scripts can gate on it.
    const { existsSync, readFileSync } = await import('node:fs');
    if (!existsSync(configPath())) {
      out(deps, `No config file at ${configPath()} — defaults apply. Run "kriyadot config init" to create one.\n`);
      return 0;
    }
    let parsed: unknown;
    try {
      const { parseConfigText } = await import('./config-files.js');
      parsed = parseConfigText(readFileSync(configPath(), 'utf8'), 'json');
    } catch (e) {
      err(deps, `config INVALID: ${e instanceof Error ? e.message : String(e)}\n`);
      return EXIT_ERROR;
    }
    const v = validateConfigObject(parsed);
    if (p.global.format === 'json') {
      printJson(deps, v);
      return v.valid ? 0 : EXIT_ERROR;
    }
    for (const w of v.warnings) err(deps, `warning: ${w}\n`);
    for (const e of v.errors) err(deps, `error: ${e}\n`);
    out(deps, v.valid ? `Config is valid${v.warnings.length ? ` (${v.warnings.length} warning(s))` : ''}: ${configPath()}\n` : `Config is INVALID: ${configPath()}\n`);
    return v.valid ? 0 : EXIT_ERROR;
  }
  if (p.subcommand === 'get') {
    const key = p.positional[0]?.toLowerCase();
    if (key === 'api' || key === 'apiurl') out(deps, `${cfg.apiUrl}\n`);
    else if (key === 'token') out(deps, cfg.token ? `${masked}\n` : '(not set)\n');
    else if (key === 'loglevel') out(deps, `${resolveLogLevel({ configLevel: cfg.logLevel })}\n`);
    else throw new Error('Usage: kriyadot config get <api|token|logLevel>');
    return 0;
  }
  if (p.subcommand === 'set') {
    const key = p.positional[0]?.toLowerCase();
    const value = p.positional[1];
    if (!key || value === undefined) throw new Error('Usage: kriyadot config set <api|token|logLevel> <value>');
    if (key === 'api' || key === 'apiurl') {
      const next = { ...cfg, apiUrl: normalizeApiUrl(value) };
      saveConfigFile(next);
      deps.cfg = next;
      out(deps, `apiUrl → ${next.apiUrl}\n`);
      return 0;
    }
    if (key === 'token') {
      const next = { ...cfg, token: value.trim() };
      saveConfigFile(next);
      deps.cfg = next;
      out(deps, 'token saved.\n');
      return 0;
    }
    if (key === 'loglevel') {
      // #181: persisted level for the CLI's own diagnostics.
      const level = value.trim().toLowerCase();
      if (!isLogLevel(level)) throw new Error(`logLevel must be one of ${LOG_LEVELS.join(', ')}, got "${value}"`);
      const next = { ...cfg, logLevel: level };
      saveConfigFile(next);
      deps.cfg = next;
      out(deps, `logLevel → ${level} (KRIYADOT_LOG_LEVEL overrides per process)\n`);
      return 0;
    }
    throw new Error('Usage: kriyadot config set <api|token|logLevel> <value>');
  }
  throw new Error('Usage: kriyadot config [get|set|path|validate|init]');
}

/** Dispatch a parsed invocation. Returns the process exit code. */
export async function runCommand(p: ParsedArgs, deps: CommandDeps): Promise<number> {
  if (p.global.version) {
    out(deps, `kriyadot ${VERSION}\n`);
    return 0;
  }
  if (p.global.help || p.command === '' || p.command === 'help') {
    out(deps, `${HELP_TEXT}\n`);
    return 0;
  }
  const invalid = validateCommand(p);
  if (invalid) {
    err(deps, `${invalid}\n`);
    return EXIT_USAGE;
  }
  // Per-run `-c key=value` overrides (chat/run only): parsed before any
  // API call, applied in memory only, never persisted. A bad key or value
  // is a usage error (exit 2).
  let overrides: ConfigOverrides = {};
  if ((p.command === 'chat' || p.command === 'run') && p.global.overrides.length > 0) {
    try {
      overrides = parseConfigOverrides(p.global.overrides);
    } catch (e) {
      if (e instanceof UsageError) {
        err(deps, `kriyadot: ${e.message}\n`);
        return EXIT_USAGE;
      }
      throw e;
    }
  }
  try {
    switch (p.command) {
      case 'chat':
        return await doChat(deps, p, overrides);
      case 'run':
        return await doRun(deps, p, overrides);
      case 'send':
        return await doSend(deps, p);
      case 'sessions':
        return await doSessions(deps, p);
      case 'completion':
        return await doCompletion(deps, p);
      case 'bots':
        return await doBots(deps, p);
      case 'threads':
        return await doThreads(deps, p);
      case 'routines':
        return await doRoutines(deps, p);
      case 'team':
        return await doTeam(deps, p);
      case 'tap':
        return await runTapCommand(p, deps);
      case 'bridge':
        return await runBridgeCommand(p, deps);
      case 'learning':
        return await runLearningCommand(p, deps);
      case 'workflows':
        return await runWorkflowCommand(p, deps);
      case 'daemon':
        return await doDaemon(deps, p);
      case 'serve':
        return await doServe(deps, p);
      case 'models':
        return await doModels(deps, p);
      case 'mcp':
        return await doMcp(deps, p);
      case 'login':
        return await doLogin(deps, p);
      case 'pause':
      case 'resume':
      case 'status':
        return await doPauseCommand(deps, p);
      case 'config':
        return await doConfig(deps, p);
      default:
        err(deps, `Unknown command "${p.command}". Run "kriyadot help".\n`);
        return EXIT_USAGE;
    }
  } catch (e) {
    if (e instanceof UsageError) {
      err(deps, `kriyadot: ${e.message}\n`);
      return EXIT_USAGE;
    }
    const msg = e instanceof Error ? e.message : String(e);
    // Hint at the token source when auth fails, without ever printing it.
    const hint = /401/.test(msg) ? ` (token from ${tokenSource({ token: p.global.token })})` : '';
    err(deps, `kriyadot: ${msg}${hint}\n`);
    return EXIT_ERROR;
  }
}
