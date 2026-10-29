// SPDX-License-Identifier: Apache-2.0
// Command implementations for the headless CLI. All I/O goes through the
// injected CommandDeps so the commands are unit-testable with a mocked API.
import { randomUUID } from 'node:crypto';
import { normalizeApiUrl, readLoopbackToken, isLoopbackUrl, saveConfigFile, configPath, tokenSource } from './config.js';
import type { CliConfig } from './config.js';
import { ApiError, KriyaDotApi } from './api.js';
import type { BotSummary } from './api.js';
import { flagBool, flagString, requireFlag, validateCommand } from './args.js';
import type { OutputFormat, ParsedArgs } from './args.js';
import { HELP_TEXT, VERSION } from './help.js';
import { createReadlineSource, runRepl, runStreamingTurn } from './repl.js';
import type { ReplLineSource } from './repl.js';

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
}

/** One-shot turn shared by `chat`, `run` and `bots run`. */
async function oneShotTurn(deps: CommandDeps, o: ChatRunOpts): Promise<number> {
  const json = o.format === 'json';
  const askApproval = async (toolName: string): Promise<boolean> => {
    err(deps, `[headless] denied approval for "${toolName}" (re-run with --auto-approve to allow)\n`);
    return false;
  };
  const result = await runStreamingTurn(
    { api: deps.api, out: (s) => deps.stdout.write(s), err: (s) => deps.stderr.write(s) },
    {
      botId: o.bot.id,
      message: o.message,
      sessionId: o.sessionId,
      ...(o.model ? { model: o.model } : {}),
      autoApprove: o.autoApprove,
    },
    askApproval,
    (t) => {
      if (!json) deps.stdout.write(t);
    },
  );
  if (!json) {
    deps.stdout.write('\n');
    if (result.failed) err(deps, `[error] ${result.error ?? 'turn failed'}\n`);
  }
  if (json) {
    printJson(
      deps,
      result.failed
        ? { ok: false, bot: o.bot.id, sessionId: o.sessionId, error: result.error ?? 'turn failed' }
        : {
            ok: true,
            bot: o.bot.id,
            sessionId: o.sessionId,
            content: result.content,
            usage: result.usage ?? null,
          },
    );
  }
  return result.failed ? 1 : 0;
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

async function doChat(deps: CommandDeps, p: ParsedArgs): Promise<number> {
  // `chat <bot> [message...]` — subcommand slot holds the bot ref.
  let botRef = p.subcommand;
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

  if (message === null) {
    if (!deps.isTTY) throw new Error('No message given and stdin is not a pipe. Usage: kriyadot chat <bot> [message]');
    // Interactive REPL.
    return runRepl(
      {
        api: deps.api,
        botName: bot.name,
        out: (s) => deps.stdout.write(s),
        err: (s) => deps.stderr.write(s),
        lines: deps.createLineSource(),
        clearScreen: deps.clearScreen,
      },
      { botId: bot.id, ...(flagString(p.flags, 'model') ? { model: flagString(p.flags, 'model')! } : {}) },
    );
  }

  return oneShotTurn(deps, {
    bot,
    message,
    sessionId: flagString(p.flags, 'session') ?? randomUUID(),
    ...(flagString(p.flags, 'model') ? { model: flagString(p.flags, 'model')! } : {}),
    ...(flagString(p.flags, 'provider') ? { providerId: flagString(p.flags, 'provider')! } : {}),
    autoApprove: flagBool(p.flags, 'auto-approve') || flagBool(p.flags, 'autoapprove'),
    format: p.global.format,
  });
}

async function doRun(deps: CommandDeps, p: ParsedArgs): Promise<number> {
  const botId = requireFlag(p.flags, 'bot', 'Example: kriyadot run --bot coder --message "hi"');
  const bot = await resolveBot(deps, botId);
  const message = await resolveMessage(deps, p, p.positional);
  if (message === null) throw new Error('No message given. Pass --message or pipe stdin.');
  return oneShotTurn(deps, {
    bot,
    message,
    sessionId: flagString(p.flags, 'session') ?? randomUUID(),
    ...(flagString(p.flags, 'model') ? { model: flagString(p.flags, 'model')! } : {}),
    ...(flagString(p.flags, 'provider') ? { providerId: flagString(p.flags, 'provider')! } : {}),
    autoApprove: flagBool(p.flags, 'auto-approve') || flagBool(p.flags, 'autoapprove'),
    format: p.global.format,
  });
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
    out(deps, `file    ${configPath()}\n`);
    return 0;
  }
  if (p.subcommand === 'path') {
    out(deps, `${configPath()}\n`);
    return 0;
  }
  if (p.subcommand === 'get') {
    const key = p.positional[0]?.toLowerCase();
    if (key === 'api' || key === 'apiurl') out(deps, `${cfg.apiUrl}\n`);
    else if (key === 'token') out(deps, cfg.token ? `${masked}\n` : '(not set)\n');
    else throw new Error('Usage: kriyadot config get <api|token>');
    return 0;
  }
  if (p.subcommand === 'set') {
    const key = p.positional[0]?.toLowerCase();
    const value = p.positional[1];
    if (!key || value === undefined) throw new Error('Usage: kriyadot config set <api|token> <value>');
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
    throw new Error('Usage: kriyadot config set <api|token> <value>');
  }
  throw new Error('Usage: kriyadot config [get|set|path]');
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
    return 1;
  }
  try {
    switch (p.command) {
      case 'chat':
        return await doChat(deps, p);
      case 'run':
        return await doRun(deps, p);
      case 'bots':
        return await doBots(deps, p);
      case 'threads':
        return await doThreads(deps, p);
      case 'routines':
        return await doRoutines(deps, p);
      case 'team':
        return await doTeam(deps, p);
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
        return 1;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Hint at the token source when auth fails, without ever printing it.
    const hint = /401/.test(msg) ? ` (token from ${tokenSource({ token: p.global.token })})` : '';
    err(deps, `kriyadot: ${msg}${hint}\n`);
    return 1;
  }
}
