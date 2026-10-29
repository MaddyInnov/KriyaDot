// SPDX-License-Identifier: Apache-2.0
// Pipe/JSON chat mode for the single binary (bun --compile):
//
//   echo "summarize this" | mvp-server chat --bot helper --json
//   mvp-server chat --bot coder --message "list the workspace" --provider groq
//
// Construction mirrors apps/api/src/index.ts boot() (config → seed →
// governance → tool registry → AgentRuntime), duplicated as small local
// helpers on purpose: boot() must not change behavior. The registry gets the
// full Phase 2 tool set (coding tools, memory tools, read_skill, delegate)
// via the shared tool-registry.ts and delegate-wiring.ts modules.
//
// Bun-compile safe: no dynamic requires; stdin via process.stdin.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AcpGovernanceGateway,
  AcpServer,
  AgentRuntime,
  SessionStore,
  createEmbedderFromEnv,
  parseModelProfiles,
  resolveBotWorkspaceDir,
} from '@mvp/agent-runtime';
import type { BotConfig, StreamEvent, StructuredOutputSpec, TokenUsage } from '@mvp/agent-runtime';
import { DEFAULT_POLICY, GovernanceGateway } from '@mvp/governance';
import { loadConfig } from './config.js';
import { GovernanceAdapter } from './governance-adapter.js';
import { SEED_FILES } from './generated/seed.js';
import { loadSeed } from './seed.js';
import type { SeedData } from './seed.js';
import { syncProviderKeysToEnv } from './providers.js';
import { buildToolRegistry } from './tool-registry.js';
import { registerDelegateTools } from './delegate-wiring.js';
import { createSummarizer } from './summarizer.js';
import { scanProject } from '@mvp/marketplace';
import type { ScanResult } from '@mvp/marketplace';

export const CHAT_USAGE = [
  'Usage: mvp-server chat --bot <id> [options]',
  '',
  'Read a prompt from stdin (pipe) or --message and run one chat turn.',
  '',
  'Options:',
  '  --bot <id>        Bot id from the seed data (default: helper)',
  '  --message <text>  Prompt text (alternative to piping stdin)',
  '  --provider <id>   Override the provider (default: the bot\'s)',
  '  --model <id>      Override the model (default: the bot\'s)',
  '  --json            Print a single JSON object: { content, usage, sessionId }',
  '  --schema <json>   Enforce structured output: a JSON Schema object (or {"type":"json_object"})',
  '  --pretty          Human output: content + usage line (default)',
  '  --help            Show this help',
  '',
  'Examples:',
  '  echo "hello" | mvp-server chat --bot helper --json',
  '  mvp-server chat --bot coder --message "list files" --pretty',
].join('\n');

export interface ParsedChatArgs {
  botId: string;
  message?: string;
  providerId?: string;
  model?: string;
  json: boolean;
  pretty: boolean;
  help: boolean;
  /** --schema: per-turn structured-output enforcement (Tier 1 #2). */
  responseFormat?: StructuredOutputSpec;
}

export class ChatArgError extends Error {}

/**
 * Parse a --schema value into a StructuredOutputSpec.
 * Accepts: '{"type":"json_object"}', a full json_schema spec
 * ('{"type":"json_schema","schema":{...}}'), or a bare JSON Schema
 * object (wrapped as json_schema with the default name).
 */
export function parseSchemaFlag(raw: string): StructuredOutputSpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ChatArgError('--schema needs a valid JSON value');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ChatArgError('--schema needs a JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.type === 'json_object') return { type: 'json_object' };
  if (obj.type === 'json_schema') {
    if (typeof obj.schema !== 'object' || obj.schema === null) {
      throw new ChatArgError('--schema json_schema needs a "schema" object');
    }
    return {
      type: 'json_schema',
      name: typeof obj.name === 'string' ? obj.name : undefined,
      schema: obj.schema as Record<string, unknown>,
      strict: obj.strict === true,
    };
  }
  // Bare JSON Schema → wrap it.
  return { type: 'json_schema', schema: obj };
}

/** Parse `argv` where argv[0] === 'chat' (index.ts passes process.argv.slice(2)). */
export function parseChatArgs(argv: string[]): ParsedChatArgs {
  const args: ParsedChatArgs = {
    botId: 'helper',
    json: false,
    pretty: true,
    help: false,
  };
  const rest = argv[0] === 'chat' ? argv.slice(1) : argv;
  const takeValue = (flag: string, i: number): string => {
    const v = rest[i + 1];
    if (v === undefined || v.startsWith('--')) {
      throw new ChatArgError(`flag ${flag} needs a value`);
    }
    return v;
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    switch (a) {
      case '--bot':
        args.botId = takeValue(a, i++);
        break;
      case '--message':
        args.message = takeValue(a, i++);
        break;
      case '--provider':
        args.providerId = takeValue(a, i++);
        break;
      case '--model':
        args.model = takeValue(a, i++);
        break;
      case '--schema':
        args.responseFormat = parseSchemaFlag(takeValue(a, i++));
        break;
      case '--json':
        args.json = true;
        args.pretty = false;
        break;
      case '--pretty':
        args.pretty = true;
        args.json = false;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        throw new ChatArgError(`unknown flag "${a}"\n\n${CHAT_USAGE}`);
    }
  }
  return args;
}

/** Read a piped prompt. Returns '' when stdin is a TTY (nothing piped). */
export async function readPipedPrompt(): Promise<string> {
  if (process.stdin.isTTY) return '';
  process.stdin.setEncoding('utf8');
  let data = '';
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data;
}

export interface ChatCliTurnResult {
  usage: TokenUsage;
  sessionId: string;
}

export interface ChatCliRuntime {
  runTurn(opts: {
    bot: BotConfig;
    message: string;
    providerId?: string;
    model?: string;
    responseFormat?: StructuredOutputSpec;
    onEvent: (e: StreamEvent) => void | Promise<void>;
    approvalTimeoutMs?: number;
  }): Promise<ChatCliTurnResult>;
  close(): void | Promise<void>;
}

export const SCAN_USAGE = [
  'Usage: mvp-server scan [dir] [options]',
  '',
  'kriyadot scan: walk a project folder and recommend marketplace kits',
  '(bots, skills, workflows, MCP servers) that fit the project.',
  'Fully offline — no account, no key, no network call.',
  '',
  'Arguments:',
  '  [dir]           Project folder to scan (default: current directory)',
  '',
  'Options:',
  '  --json          Print a single JSON object with signals + recommendations',
  '  --pretty        Human output: detected signals + recommended kits (default)',
  '  --help          Show this help',
  '',
  'Examples:',
  '  mvp-server scan',
  '  mvp-server scan ~/projects/my-api --json',
].join('\n');

export interface ParsedScanArgs {
  dir?: string;
  json: boolean;
  pretty: boolean;
  help: boolean;
}

export class ScanArgError extends Error {}

/** Parse `argv` where argv[0] === 'scan' (index.ts passes process.argv.slice(2)). */
export function parseScanArgs(argv: string[]): ParsedScanArgs {
  const args: ParsedScanArgs = { json: false, pretty: true, help: false };
  const rest = argv[0] === 'scan' ? argv.slice(1) : argv;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    switch (a) {
      case '--json':
        args.json = true;
        args.pretty = false;
        break;
      case '--pretty':
        args.pretty = true;
        args.json = false;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        if (a.startsWith('--')) {
          throw new ScanArgError(`unknown flag "${a}"\n\n${SCAN_USAGE}`);
        }
        if (args.dir !== undefined) {
          throw new ScanArgError(`unexpected argument "${a}" (only one dir allowed)\n\n${SCAN_USAGE}`);
        }
        args.dir = a;
    }
  }
  return args;
}

export interface ScanCliDeps {
  scan?: (dir: string) => ScanResult;
  cwd?: () => string;
}

export interface ChatCliDeps {
  findBot?: (botId: string) => Promise<BotConfig | undefined>;
  listBots?: () => Promise<BotConfig[]>;
  buildRuntime?: () => Promise<ChatCliRuntime>;
  readPipedPrompt?: () => Promise<string>;
}

function printScanPretty(result: ScanResult): void {
  const s = result.signals;
  console.log(`kriyadot scan: ${result.dir}`);
  console.log(`catalog: ${result.catalogSource} (${result.catalogSize} kits)`);
  console.log('');
  console.log('Detected');
  const line = (label: string, value: string) => console.log(`  ${label}: ${value}`);
  line('languages', s.languages.length > 0 ? s.languages.join(', ') : 'none');
  if (s.typescript) line('typescript', 'yes');
  if (s.apiServer) line('api server', 'yes');
  if (s.frontend) line('frontend', 'yes');
  if (s.hasDockerfile) line('docker', s.hasCompose ? 'Dockerfile + compose' : 'Dockerfile');
  else if (s.hasCompose) line('docker', 'compose only');
  if (s.hasCI) line('ci', 'yes');
  if (s.hasGit) line('git', 'yes');
  line('tests', s.hasTests ? 'yes' : 'no');
  line('docs', s.hasDocs ? 'yes' : 'no');
  if (s.hasDatabase) line('database', 'yes');
  if (s.hasCsv) line('csv data', 'yes');
  if (s.hasMakefile) line('makefile', 'yes');
  console.log('');
  if (result.recommendations.length === 0) {
    console.log('No kit recommendations — nothing recognizable in this folder.');
  } else {
    console.log('Recommended kits');
    for (const r of result.recommendations) {
      console.log(`  • ${r.id} (${r.kind}) — ${r.reason}`);
    }
  }
  console.log('');
  console.log('(offline scan: no account, no key, no network call)');
}

/**
 * Run the `scan` subcommand. Returns the process exit code (0 = success);
 * index.ts calls process.exit with it. Never calls process.exit itself, so
 * tests can invoke it directly with injected deps.
 */
export async function runScanCli(argv: string[], deps: ScanCliDeps = {}): Promise<number> {
  let args: ParsedScanArgs;
  try {
    args = parseScanArgs(argv);
  } catch (err) {
    console.error(`[scan] ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (args.help) {
    console.log(SCAN_USAGE);
    return 0;
  }

  const dir = args.dir ?? (deps.cwd ?? process.cwd)();
  const resolved = path.isAbsolute(dir) ? dir : path.resolve((deps.cwd ?? process.cwd)(), dir);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    if (args.json) console.log(JSON.stringify({ error: `not a directory: ${dir}` }));
    else console.error(`[scan] not a directory: ${dir}`);
    return 1;
  }

  const result = (deps.scan ?? scanProject)(resolved);
  if (args.json) {
    console.log(JSON.stringify(result));
  } else {
    printScanPretty(result);
  }
  return 0;
}

/**
 * Local copy of index.ts's resolveSeedDir: single-file binaries ship
 * embedded seed data; extract it when SEED_DIR is missing on disk.
 * (Duplicated rather than imported so boot() stays untouched.)
 */
function resolveSeedDir(configured: string): string {
  if (fs.existsSync(configured)) return configured;
  const entries = Object.entries(SEED_FILES);
  if (entries.length === 0) return configured;
  const dir = path.join(os.tmpdir(), 'mvp-seed-embedded');
  for (const [rel, content] of entries) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!fs.existsSync(target)) fs.writeFileSync(target, content, 'utf8');
  }
  return dir;
}

async function defaultFindBot(botId: string): Promise<BotConfig | undefined> {
  return loadSeedCached().bots.find((b) => b.id === botId);
}

async function defaultListBots(): Promise<BotConfig[]> {
  return loadSeedCached().bots;
}

/** Seed is loaded once per process (loadSeed logs on every call). */
let seedCache: SeedData | undefined;
function loadSeedCached(): SeedData {
  if (!seedCache) {
    const config = loadConfig();
    seedCache = loadSeed(resolveSeedDir(config.seedDir));
  }
  return seedCache;
}

/**
 * Default runtime construction — same pieces as boot(), minus the HTTP
 * server. Memory tools are registered (self-contained, Phase 2 workstream
 * A); `delegate` is intentionally NOT wired here — the host adds it to
 * tool-registry.ts as a follow-up.
 */
async function defaultBuildRuntime(): Promise<ChatCliRuntime> {
  const config = loadConfig();
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.workspaceDir, { recursive: true });

  if (!process.env.PROVIDERS_FILE) {
    process.env.PROVIDERS_FILE = path.join(config.dataDir, 'providers.local.json');
  }
  syncProviderKeysToEnv(config.dataDir);

  const seedDir = resolveSeedDir(config.seedDir);
  const seed = loadSeedCached();

  const governance = new GovernanceGateway({
    dbPath: `${config.dataDir}/governance.db`,
    policy: DEFAULT_POLICY,
  });
  const governanceAdapter = new GovernanceAdapter(governance);

  const {
    registry,
    close: closeMcp,
  } = await buildToolRegistry({
    workspaceDir: config.workspaceDir,
    dataDir: config.dataDir,
    skillsDir: path.join(seedDir, 'skills'),
    mcpServers: seed.mcpServers,
    approvalBroker: governance,
  });


  // Octomind parity wiring (mirrors the server boot): purpose-based
  // model profiles from <dataDir>/model-profiles.json ({} when absent).
  const modelProfiles = (() => {
    try {
      return parseModelProfiles(fs.readFileSync(path.join(config.dataDir, 'model-profiles.json'), 'utf8'));
    } catch {
      return {};
    }
  })();
  const sessions = new SessionStore(`${config.dataDir}/agent.db`);
  const runtime = new AgentRuntime({
    dbPath: `${config.dataDir}/agent.db`,
    skillsDir: path.join(seedDir, 'skills'),
    governance: governanceAdapter,
    toolRegistry: registry,
    sessionStoreOptions: { summarizer: createSummarizer(undefined, modelProfiles), adaptiveCompaction: true, backgroundCompaction: true },
    modelProfiles,
    embedder: createEmbedderFromEnv(),
    workspaceDirForBot: (bot) =>
      resolveBotWorkspaceDir({
        botWorkspace: bot.workspace,
        globalWorkspaceDir: config.workspaceDir,
        dataDir: config.dataDir,
      }),
  });

  // Phase 2 host wiring: `delegate` subagent tool (same wiring as the server).
  const botsById = new Map<string, BotConfig>(seed.bots.map((b) => [b.id, b]));
  registerDelegateTools({
    registry,
    dataDir: config.dataDir,
    skillsDir: path.join(seedDir, 'skills'),
    governanceAdapter,
    getBotConfig: (id) => botsById.get(id),
    workspaceDir: config.workspaceDir,
    audit: (action, fields) => governance.audit(action, fields),
  });

  return {
    async runTurn(opts): Promise<ChatCliTurnResult> {
      const sessionId = sessions.createSession(opts.bot.id);
      const usage = await runtime.runTurn({ ...opts, sessionId });
      return { usage, sessionId };
    },
    async close(): Promise<void> {
      await closeMcp();
      try {
        runtime.close();
      } catch {
        // ignore
      }
      try {
        sessions.close();
      } catch {
        // ignore
      }
      try {
        governance.close();
      } catch {
        // ignore
      }
    },
  };
}

function printResult(args: ParsedChatArgs, content: string, usage: TokenUsage, sessionId: string): void {
  if (args.json) {
    console.log(JSON.stringify({ content, usage, sessionId }));
    return;
  }
  console.log(content);
  console.log(
    `\n— ${usage.totalTokens} tokens (in ${usage.promptTokens} / out ${usage.completionTokens}) · session ${sessionId}`,
  );
}

function printError(args: ParsedChatArgs | undefined, message: string): void {
  if (args?.json) {
    console.log(JSON.stringify({ error: message }));
  } else {
    console.error(`[chat] ${message}`);
  }
}

/**
 * Run one chat turn from CLI args. Returns the process exit code (0 =
 * success); index.ts calls process.exit with it. Never calls process.exit
 * itself, so tests can invoke it directly with injected deps.
 */
export async function runChatCli(argv: string[], deps: ChatCliDeps = {}): Promise<number> {
  let args: ParsedChatArgs;
  try {
    args = parseChatArgs(argv);
  } catch (err) {
    console.error(`[chat] ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (args.help) {
    console.log(CHAT_USAGE);
    return 0;
  }

  try {
    const prompt =
      args.message ?? (await (deps.readPipedPrompt ?? readPipedPrompt)());
    if (!prompt.trim()) {
      printError(args, 'no prompt: pipe one via stdin or pass --message "<text>"');
      return 1;
    }

    const bot = await (deps.findBot ?? defaultFindBot)(args.botId);
    if (!bot) {
      const bots = await (deps.listBots ?? defaultListBots)();
      printError(
        args,
        `unknown bot "${args.botId}" (available: ${bots.map((b) => b.id).join(', ') || 'none'})`,
      );
      return 1;
    }

    const runtime = await (deps.buildRuntime ?? defaultBuildRuntime)();
    try {
      let content = '';
      const { usage, sessionId } = await runtime.runTurn({
        bot,
        message: prompt,
        providerId: args.providerId,
        model: args.model,
        responseFormat: args.responseFormat,
        // Non-interactive mode: approvals wait a bounded 60s then deny.
        approvalTimeoutMs: 60_000,
        onEvent: (e) => {
          if (e.type === 'token') content += e.content;
          else if (e.type === 'approval_required') {
            console.error(
              `[chat] approval requested for tool "${e.call.name}" — ` +
                'non-interactive mode, waiting up to 60s (denied on timeout)',
            );
          } else if (e.type === 'error') {
            console.error(`[chat] turn error: ${e.message}`);
          }
        },
      });
      printResult(args, content, usage, sessionId);
      return 0;
    } finally {
      await runtime.close();
    }
  } catch (err) {
    printError(args, err instanceof Error ? err.message : String(err));
    return 1;
  }
}

// ---------------------------------------------------------------------------
// ACP server mode (Octomind parity): `mvp-server acp --bot <id>` serves the
// bot as an ACP agent over stdio for ACP clients (Zed et al.). Approvals
// become session/request_permission round-trips to the client. Delegate
// tools are not registered in this mode (editor-hosted sessions are
// single-bot); coding/memory/skill tools come from buildToolRegistry.
// ---------------------------------------------------------------------------

export const ACP_USAGE = [
  'Usage: mvp-server acp --bot <id>',
  '',
  'Serve a bot as an ACP (Agent Client Protocol) agent over stdio.',
  'The ACP client spawns this process; JSON-RPC flows on stdin/stdout,',
  'diagnostics on stderr.',
  '',
  'Options:',
  '  --bot <id>   Bot id from the seed data (default: helper)',
  '  --help       Show this help',
].join('\n');

export interface ParsedAcpArgs {
  botId: string;
  help?: boolean;
}

/** Parse `argv` where argv[0] === 'acp'. */
export function parseAcpArgs(argv: string[]): ParsedAcpArgs {
  const rest = argv[0] === 'acp' ? argv.slice(1) : argv;
  let botId = 'helper';
  let help = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    switch (arg) {
      case '--bot':
        botId = rest[++i] ?? botId;
        break;
      case '--help':
      case '-h':
        help = true;
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }
  return { botId, help };
}

export interface AcpCliRuntime {
  runtime: AgentRuntime;
  bridge: { server?: AcpServer };
  createSessionId: () => string;
  close: () => Promise<void>;
}

export interface AcpCliDeps {
  findBot?: (botId: string) => Promise<BotConfig | undefined>;
  buildRuntime?: (bot: BotConfig) => Promise<AcpCliRuntime>;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

async function defaultBuildAcpRuntime(bot: BotConfig): Promise<AcpCliRuntime> {
  const config = loadConfig();
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.workspaceDir, { recursive: true });
  if (!process.env.PROVIDERS_FILE) {
    process.env.PROVIDERS_FILE = path.join(config.dataDir, 'providers.local.json');
  }
  syncProviderKeysToEnv(config.dataDir);

  const seedDir = resolveSeedDir(config.seedDir);
  const seed = loadSeedCached();

  const governance = new GovernanceGateway({
    dbPath: `${config.dataDir}/governance.db`,
    policy: DEFAULT_POLICY,
  });
  const bridge: { server?: AcpServer } = {};
  const governanceGateway = new AcpGovernanceGateway(bridge);

  const { registry, close: closeMcp } = await buildToolRegistry({
    workspaceDir: config.workspaceDir,
    dataDir: config.dataDir,
    skillsDir: path.join(seedDir, 'skills'),
    mcpServers: seed.mcpServers,
    approvalBroker: governance,
  });


  // Octomind parity wiring (mirrors the server boot): purpose-based
  // model profiles from <dataDir>/model-profiles.json ({} when absent).
  const modelProfiles = (() => {
    try {
      return parseModelProfiles(fs.readFileSync(path.join(config.dataDir, 'model-profiles.json'), 'utf8'));
    } catch {
      return {};
    }
  })();
  const sessions = new SessionStore(`${config.dataDir}/agent.db`);
  const runtime = new AgentRuntime({
    dbPath: `${config.dataDir}/agent.db`,
    skillsDir: path.join(seedDir, 'skills'),
    governance: governanceGateway,
    toolRegistry: registry,
    sessionStoreOptions: { summarizer: createSummarizer(undefined, modelProfiles), adaptiveCompaction: true, backgroundCompaction: true },
    modelProfiles,
    embedder: createEmbedderFromEnv(),
    workspaceDirForBot: (b) =>
      resolveBotWorkspaceDir({
        botWorkspace: b.workspace,
        globalWorkspaceDir: config.workspaceDir,
        dataDir: config.dataDir,
      }),
  });

  return {
    runtime,
    bridge,
    createSessionId: () => sessions.createSession(bot.id),
    close: async () => {
      await closeMcp();
      try {
        runtime.close();
      } catch {
        // ignore
      }
      try {
        sessions.close();
      } catch {
        // ignore
      }
      try {
        governance.close();
      } catch {
        // ignore
      }
    },
  };
}

/**
 * Run the `acp` subcommand: serve until the client closes stdin.
 * Returns the process exit code; never calls process.exit itself.
 */
export async function runAcpCli(argv: string[], deps: AcpCliDeps = {}): Promise<number> {
  let args: ParsedAcpArgs;
  try {
    args = parseAcpArgs(argv);
  } catch (err) {
    console.error(`[acp] ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  if (args.help) {
    console.log(ACP_USAGE);
    return 0;
  }
  const findBot = deps.findBot ?? defaultFindBot;
  const bot = await findBot(args.botId);
  if (!bot) {
    console.error(`[acp] unknown bot "${args.botId}"`);
    return 1;
  }
  const built = await (deps.buildRuntime ?? defaultBuildAcpRuntime)(bot);
  const input = deps.input ?? process.stdin;
  const output = deps.output ?? process.stdout;
  const server = new AcpServer({
    runtime: built.runtime,
    bot,
    input,
    output,
    createSessionId: built.createSessionId,
    log: (m) => console.error(m),
  });
  built.bridge.server = server;
  server.start();
  try {
    // Serve until the client hangs up (stdin end/close).
    await new Promise<void>((resolve) => {
      input.once('end', () => resolve());
      input.once('close', () => resolve());
    });
  } finally {
    await server.stop();
    await built.close();
  }
  return 0;
}
