// SPDX-License-Identifier: Apache-2.0
// API entry point. Boot sequence:
//   1. load config (port/paths) and seed data (bots, workflows, MCP servers)
//   2. construct the real GovernanceGateway, wrap it in a GovernanceAdapter
//      for the agent runtime, and build the tool registry (built-ins + MCP)
//   3. construct AgentRuntime and WorkflowRunner, register workflows
//   4. mount /api routes, then the static frontend (single-binary serving)
//   5. listen
//
// Run: `bun --watch src/index.ts` (dev) / `bun src/index.ts` (prod).
// The Tauri sidecar spawns this with `--port 4567` and DATA_DIR set to the
// desktop app-data dir.

import cors from 'cors';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentRuntime } from '@mvp/agent-runtime';
import type { BotConfig } from '@mvp/agent-runtime';
import { DEFAULT_POLICY, GovernanceGateway, sanitizeTelemetry } from '@mvp/governance';
import { TelemetryCollector } from '@mvp/agent-runtime';
import { Scheduler, TriggerStore, WorkflowRunner } from '@mvp/workflows';
import type { WorkflowRun } from '@mvp/workflows';
import { loadConfig } from './config.js';
import { GovernanceAdapter } from './governance-adapter.js';
import { SEED_FILES } from './generated/seed.js';
import { loadSeed } from './seed.js';
import { syncProviderKeysToEnv } from './providers.js';
import { applyBotPolicies } from './bot-policies.js';
import { buildToolRegistry } from './tool-registry.js';
import { registerDelegateTools } from './delegate-wiring.js';
import { createSummarizer } from './summarizer.js';
import { createRouter } from './routes.js';
import { renderSarviqMeter } from './sarviq-meter.js';
import { createWebhookRouter } from './webhooks.js';
import { mountWebAssets } from './web-assets.js';
// Parity workstreams (OpenMausBot/n8n/Notion/Dots/Groq/OpenCode/Laya/Boosthis/Muse):
// each module exports a factory; mounted below without touching other wiring.
import { createComputerView } from './computer-view.js';
import { createChatThreadsRouter } from './chat-threads-routes.js';
import { applyImportedBots, createBotRosterRouter } from './bot-roster-routes.js';
import { registerRoutineRoutes } from './bot-routines.js';
import { createRoutineWebhookRouter } from './webhooks.js';
import { createWorkflowN8nRouter } from './workflow-n8n.js';
import {
  interconnectionPolicyRules,
  registerInterconnectionTools,
} from './interconnect-tools.js';
import { registerWorktreeRoutes } from './worktrees-routes.js';
import { createWorktreeTools } from '@mvp/agent-runtime/dist/worktrees.js';
import { HookBus, loadPlugins } from '@mvp/agent-runtime/dist/hooks.js';
import { selectComputerSandbox } from '@mvp/agent-runtime/dist/tools/computer-sandbox.js';
import { runChatCli, runScanCli } from './cli.js';
// Phase 3: scheduled workflows create tasks; the platform also serves its
// own tools as an MCP server (two-way MCP).
import { makeTaskCreator } from './tasks.js';
import { McpScopeStore, PlatformMcpServer, toolProviderFromRegistry } from '@mvp/agent-runtime';
import type { ToolProvider } from '@mvp/agent-runtime';
import { AnnotationStore } from './annotations.js';
import { createReadOnlyAssistantProvider } from './mcp-annotations.js';
import type { McpConnectionClass } from './mcp-annotations.js';
// Phase 4: computer-use + muse-module agent tools, policy rules, protocols,
// and the reminders module (scheduler routing). The computer.ts subpath is
// imported directly (not re-exported from the agent-runtime index — index
// untouched), following the pricing.ts precedent in routes.ts.
import { computerUsePolicyRules, registerComputerUseTool } from '@mvp/agent-runtime/dist/tools/computer.js';
// Real foreground OS layer (opt-in via COMPUTER_USE_REAL=1; mock by default).
// Same direct-dist-subpath import pattern as computer.js above.
// (Kept for reference; the live path now goes through selectComputerSandbox.)
import {
  ModuleDb,
  ReminderStore,
  fireReminder,
  registerMuseModuleTools,
  museModuleToolPolicies,
} from '@mvp/muse-modules';
import { defaultAgentCard } from '@mvp/protocols';
import type { Policy } from '@mvp/governance';

// Pipe/JSON chat mode: `mvp-server chat --bot <id> [--json]`. Parsed at the
// very top, before boot(), so `chat` never starts the HTTP server.
// runChatCli returns the exit code; index.ts owns process.exit.
if (process.argv[2] === 'chat') {
  const code = await runChatCli(process.argv.slice(2));
  process.exit(code);
}

// sarviq scan: one-command offline project scanner — `mvp-server scan [dir]`.
// Parsed at the very top, before boot(), so `scan` never starts the HTTP
// server, loads no config, and makes no network calls.
if (process.argv[2] === 'scan') {
  const code = await runScanCli(process.argv.slice(2));
  process.exit(code);
}

/**
 * Resolve the seed directory. Single-file binaries (bun --compile) ship with
 * embedded seed data: when SEED_DIR does not exist on disk, the embedded
 * files are extracted to a temp dir so bots/skills/workflows still load.
 */
function resolveSeedDir(configured: string): string {
  if (fs.existsSync(configured)) return configured;
  const entries = Object.entries(SEED_FILES);
  if (entries.length === 0) return configured; // let loadSeed() warn
  const dir = path.join(os.tmpdir(), 'mvp-seed-embedded');
  for (const [rel, content] of entries) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!fs.existsSync(target)) fs.writeFileSync(target, content, 'utf8');
  }
  console.log(`[seed] SEED_DIR not found — extracted ${entries.length} embedded seed file(s) to ${dir}`);
  return dir;
}

/**
 * Phase 3: build the platform's own MCP server (two-way MCP) over the real
 * tool registry. External clients (Claude Code, etc.) can list/call our
 * tools and chat with a bot; the governance approval policy still applies —
 * require-approval tools never execute silently (see mcp-server.ts).
 */
function buildPlatformMcpServer(opts: {
  toolRegistry: Map<string, import('@mvp/agent-runtime').ToolDefinition>;
  /** The GovernanceAdapter (runtime governance surface), not the raw gateway. */
  governance: import('@mvp/agent-runtime').GovernanceGateway;
  agentRuntime: AgentRuntime;
  bots: BotConfig[];
  /** Per-tool scope toggles; enforced in the tools/call path (mcp-scopes.ts). */
  scopes: import('@mvp/agent-runtime').McpScopeStore;
  /**
   * Connection class for external MCP clients (see mcp-annotations.ts).
   * 'standard' (default) exposes the full tool surface; 'read-only-assistant'
   * wraps the provider so clients can read telemetry freely but may only
   * APPEND annotations (quarantined for human review) — every other
   * write/egress tool is denied before governance runs.
   */
  connectionClass?: McpConnectionClass;
  /** Annotation store backing `annotations.append` (required for read-only-assistant). */
  annotationStore?: AnnotationStore;
  /** Runtime telemetry collector → read-only sarviq://telemetry/* resources. */
  telemetry: import('@mvp/agent-runtime').TelemetryCollector;
}): PlatformMcpServer {
  const fallbackBot = opts.bots[0];
  let tools: ToolProvider = toolProviderFromRegistry(opts.toolRegistry);
  if (opts.connectionClass === 'read-only-assistant') {
    if (!opts.annotationStore) {
      throw new Error('read-only-assistant connection class requires an annotationStore');
    }
    tools = createReadOnlyAssistantProvider(tools, opts.annotationStore);
    console.log('[mcp] connection class: read-only-assistant (reads allowed, only annotations.append may write)');
  }
  return new PlatformMcpServer({
    tools,
    governance: opts.governance,
    botId: 'mcp-gateway',
    scopes: opts.scopes,
    telemetry: opts.telemetry,
    chat: fallbackBot
      ? {
          description: `Chat with the "${fallbackBot.id}" bot (one turn).`,
          handler: async (message: string) => {
            let content = '';
            await opts.agentRuntime.runTurn({
              bot: fallbackBot,
              message: String(message),
              taskType: 'chat',
              onEvent: (e) => {
                if (e.type === 'token' && typeof e.content === 'string') content += e.content;
              },
            });
            return content;
          },
        }
      : undefined,
  });
}

async function boot(): Promise<void> {
  const config = loadConfig();
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.workspaceDir, { recursive: true });

  // The agent-runtime resolves provider keys via env vars first. It cannot
  // read the encrypted providers.local.json envelope itself (only the
  // providers module holds the machine key), so mirror the decrypted file
  // into process.env here at boot — and after every save/remove via the
  // Providers API. Fail-closed: a tampered/unreadable key file aborts boot
  // loudly instead of running keyless.
  if (!process.env.PROVIDERS_FILE) {
    process.env.PROVIDERS_FILE = path.join(config.dataDir, 'providers.local.json');
  }
  syncProviderKeysToEnv(config.dataDir);

  const seedDir = resolveSeedDir(config.seedDir);
  const seed = loadSeed(seedDir);

  // Phase 2: per-bot policy overrides persisted in <dataDir>/bot-policies.json
  // are applied onto the in-memory bot configs before anything else reads them.
  applyBotPolicies(seed.bots, config.dataDir);
  // MBTI personas: per-bot overlay from <dataDir>/bot-personas.json.
  const { applyBotPersonas } = await import('./bot-personas.js');
  applyBotPersonas(seed.bots, config.dataDir);
  // Per-bot workspaces (Octop-style isolation): overlay from
  // <dataDir>/bot-workspaces.json. Unset → global workspaceDir.
  const { applyBotWorkspaces } = await import('./bot-workspaces.js');
  applyBotWorkspaces(seed.bots, config.dataDir);
  // Chat branching / roster import: overlay previously imported bots.
  applyImportedBots(seed.bots, config.dataDir);
  const botsById = new Map<string, BotConfig>(seed.bots.map((b) => [b.id, b]));

  // 2. Governance + tools.
  // Phase 4: prepend approval-gating rules for the new agent tools
  // (computer use, browser automation). First match wins; these are
  // require-approval — strictly stronger than the defaults they precede,
  // so deny-by-default is preserved and extended.
  const globalPolicy: Policy = {
    ...DEFAULT_POLICY,
    rules: [...interconnectionPolicyRules(), ...computerUsePolicyRules(), ...museModuleToolPolicies(), ...DEFAULT_POLICY.rules],
  };
  const governance = new GovernanceGateway({
    dbPath: `${config.dataDir}/governance.db`,
    policy: globalPolicy,
  });
  // The runtime expects its own governance surface (agent-runtime documents
  // it as a local interface); the adapter bridges it to the real gateway.
  // Tool executions are audited by the runtime itself through this adapter
  // (tool.denied / tool.approval_requested / tool.approval_decided /
  // tool.executed), so no extra hooks are registered here — they would
  // double-log. Phase 2: getBotConfig lets the adapter evaluate per-bot
  // policy overrides (bot rules prepended, first match wins).
  const { PreferenceStore } = await import('./preferences.js');
  const preferenceStore = new PreferenceStore(config.dataDir);

  // Remote-phone control v1 (Workspace → Phone tab). The hub is created here
  // (not in routes.ts) so the WebSocket upgrade handler below shares the
  // same instance as the REST routes.
  const { PhoneStore, PhoneSessionHub } = await import('./phone.js');
  const { AdbPhoneProvider } = await import('./phone-adb.js');
  const phoneStore = new PhoneStore(config.dataDir);
  const phoneHub = new PhoneSessionHub(phoneStore, (action, fields) => governance.audit(action, fields));
  const phoneAdb = new AdbPhoneProvider();

  // Per-bot computer view (OpenMausBot parity): live screen stream + user
  // input per bot. The hub is created here so the WS upgrade handler below
  // shares the instance with the REST routes.
  const computerView = createComputerView({
    audit: (action, fields) => governance.audit(action, fields),
    listAudit: (limit) => governance.listAudit(limit),
  });

  const governanceAdapter = new GovernanceAdapter(governance, {
    getBotConfig: (id) => botsById.get(id),
    globalPolicy,
    getPreference: (botId, toolName) => preferenceStore.getPreference(botId, toolName)?.preference,
  });

  const { registry: toolRegistry, connections: mcpConnections, connectMcp, close: closeMcp } =
    await buildToolRegistry({
      workspaceDir: config.workspaceDir,
      dataDir: config.dataDir,
      skillsDir: path.join(seedDir, 'skills'),
      mcpServers: seed.mcpServers,
      // GovernanceGateway satisfies SchemaDriftApprovalBroker structurally:
      // MCP schema drift at (re)connect raises a human approval here.
      approvalBroker: governance,
      // Per-bot workspaces: file/shell/git tools resolve the calling bot's
      // workspace per tool-call (Octop-style isolation).
      getBotConfig: (id) => botsById.get(id),
    });

  // Phase 4: computer-use tools (sandboxed GUI automation; mutating actions
  // are approval-gated via computerUsePolicyRules above; the default OS
  // layer is the mock — no real input) and Muse-module tools (research_deep,
  // browser_action — browser_action approval-gated via museModuleToolPolicies).
  // selectOSLayer() returns the Playwright browser layer when
  // COMPUTER_USE_PLAYWRIGHT=1 (see docs/computer-use-playwright.md), the
  // REAL foreground layer when COMPUTER_USE_REAL=1; otherwise the safe mock.
  // The approval gate applies identically either way — governance evaluates
  // before the handler runs.
  // Pluggable computer sandbox (Dots parity): selectComputerSandbox() returns
  // the Docker container backend when COMPUTER_USE_DOCKER=1, the Playwright
  // browser layer when COMPUTER_USE_PLAYWRIGHT=1, the REAL foreground layer
  // when COMPUTER_USE_REAL=1; otherwise the safe mock. LocalComputerSandbox
  // delegates to the previous selectOSLayer() path, so behavior is unchanged
  // by default. The approval gate applies identically either way.
  const computerSandbox = selectComputerSandbox({
    onRealAction: (action, detail) => {
      console.log(`[computer-real] ${action}`, JSON.stringify(detail));
      try {
        governance.audit('tool.computer_real_action', {
          actor: 'agent',
          toolName: `computer_${action}`,
          detail,
        });
      } catch {
        // Audit must never break input.
      }
    },
  });
  await computerSandbox.launch(); // no-op for local; starts the container for docker
  registerComputerUseTool(toolRegistry, {
    os: computerSandbox,
  });
  // OpenCode parity: git worktree tools (per-session isolated checkouts).
  // Workspace resolves per-session: a session with an attached worktree
  // operates inside it, otherwise in the default workspace. The closure runs
  // at tool-call time, after boot, so agentRuntime is initialized.
  for (const tool of createWorktreeTools({
    workspaceDir: (ctx) =>
      agentRuntime.sessionStore.getWorktree(ctx.sessionId) ?? config.workspaceDir,
  })) {
    if (!toolRegistry.has(tool.name)) toolRegistry.set(tool.name, tool);
  }
  registerMuseModuleTools(toolRegistry, { dataDir: config.dataDir });

  // 3. Agent runtime + workflows.
  const { CheckpointStore } = await import('./checkpoints.js');
  const checkpointStore = new CheckpointStore(config.dataDir);

  // Runtime telemetry ("eyes for your AI"): in-memory, metadata-tier only.
  // Every ingestion passes through the privacy-tiers guard — payloads
  // carrying bodies/headers/cookies/query values are dropped with a
  // warning and never stored; route/screen/bot names are normalized to
  // id-templates. Shared by the agent runtime, the workflow runner, the
  // platform MCP server (read-only sarviq://telemetry/* resources), and
  // the /_sarviq/ meter page.
  const telemetry = new TelemetryCollector({
    guard: (payload) =>
      sanitizeTelemetry(payload, (message, detail) =>
        console.warn(`[telemetry-guard] ${message}`, detail),
      ),
  });

  const { DotStore } = await import('./dots.js');
  const dotStore = new DotStore(config.dataDir);

  const { RecordingStore } = await import('./recordings.js');
  const recordingStore = new RecordingStore(config.dataDir);

  const { ChatQueueStore } = await import('./chat-queue.js');
  const chatQueueStore = new ChatQueueStore(config.dataDir);
  // Reset any 'started' rows left by a crashed turn back to queued for retry.
  chatQueueStore.resetStarted();

  // OpenCode parity: plugin/hook bus. Hosts can drop .js/.mjs plugins with an
  // `activate(bus)` export into <dataDir>/plugins to extend the runtime.
  const hookBus = new HookBus();
  try {
    await loadPlugins(path.join(config.dataDir, 'plugins'), hookBus);
  } catch (err) {
    console.error('[hooks] plugin load failed:', err instanceof Error ? err.message : err);
  }
  const agentRuntime = new AgentRuntime({
    dbPath: `${config.dataDir}/agent.db`,
    skillsDir: path.join(seedDir, 'skills'),
    governance: governanceAdapter,
    toolRegistry,
    hooks: hookBus,
    // Phase 2: summarization auto-compaction replaces blind truncation once
    // sessions grow past the threshold; the last-100-messages floor stays.
    sessionStoreOptions: { summarizer: createSummarizer() },
    // Checkpoints: snapshot files before mutation (Claude Code rewind).
    // One checkpoint per (session, tool call) — files accumulate per call.
    onBeforeFileMutate: async (info) => {
      checkpointStore.create({
        sessionId: info.sessionId,
        files: { [info.path]: info.contentBefore },
        historyLength: info.historyLength,
        label: `before ${info.toolName} ${info.path}`,
      });
    },
    // Runtime telemetry ("eyes for your AI"): per-step latency, error/retry
    // rates, and token cost per bot turn. Metadata-tier only, guarded.
    telemetry,
  });

  // Phase 2: `delegate` subagent tool. The child runs under the same
  // governance policy; parent/child records + audit events land in
  // subagents.db and the audit log (visible in Audit/Activity).
  registerDelegateTools({
    registry: toolRegistry,
    dataDir: config.dataDir,
    skillsDir: path.join(seedDir, 'skills'),
    workspaceDir: config.workspaceDir,
    governanceAdapter,
    getBotConfig: (id) => botsById.get(id),
    audit: (action, fields) => governance.audit(action, fields),
  });

  const workflowRunner = new WorkflowRunner({
    dbPath: `${config.dataDir}/workflows.db`,
    agentRuntime,
    governance,
    tools: toolRegistry,
    bots: botsById,
    // Runtime telemetry: one guarded record per workflow run + per-node steps.
    telemetry,
  });

  // Interconnection (bot↔workflow↔notes): agent tools workflow_start,
  // notes_save/read/search + governance rules for them.
  registerInterconnectionTools({
    registry: toolRegistry,
    workflowRunner,
    dataDir: config.dataDir,
  });

  // Bot routines (OpenMausBot parity): scheduled bot tasks + signed inbound
  // webhook triggers that fire a bot turn. One store instance serves both
  // the management API and the webhook ingress (shared SQLite). The routers
  // are mounted on `app` in the HTTP section below.
  const routinesRouter = express.Router();
  const { routineStore, triggerStore: routineTriggerStore } = registerRoutineRoutes(
    routinesRouter,
    { dataDir: config.dataDir, getBots: () => seed.bots },
  );
  const routineWebhookRouter = createRoutineWebhookRouter({
    routineStore,
    triggerStore: routineTriggerStore,
    agentRuntime,
    getBots: () => seed.bots,
  });

  // Companion app (phone → PC remote control). The hub is created here (not
  // in routes.ts) so the WebSocket upgrade handler below shares the same
  // instance as the REST routes. Approval lifecycle events raised anywhere
  // (web chat, workflows, MCP) are pushed live to connected phones; the app
  // refetches the full list on push.
  const { CompanionStore, CompanionHub } = await import('./companion.js');
  const companionStore = new CompanionStore(config.dataDir);
  // CompanionHub is a value here (dynamic import); name its instance type.
  let companionHub!: InstanceType<typeof CompanionHub>;
  companionHub = new CompanionHub(
    companionStore,
    (action, fields) => {
      governance.audit(action, fields);
      try {
        if (action === 'approval.created' || action === 'approval.decided') {
          companionHub.broadcast({
            type: 'approval',
            event: action === 'approval.created' ? 'created' : 'decided',
            approval: {},
          });
        } else if (action.startsWith('companion.')) {
          companionHub.broadcast({ type: 'activity', summary: action });
        }
      } catch {
        // Pushes must never break auditing.
      }
    },
    {
      snapshot: () => {
        try {
          return {
            pendingApprovals: governance.listApprovals('pending').length,
            activeRuns: workflowRunner
              .listRuns()
              .filter((r) => r.status === 'running' || r.status === 'paused').length,
          };
        } catch {
          return {};
        }
      },
    },
  );
  // Run health scoring + regression detection (features #2/#5): persisted
  // scores and metric samples in <dataDir>/run-health.db.
  const { RunHealthStore } = await import('@mvp/run-health');
  const runHealth = new RunHealthStore(`${config.dataDir}/run-health.db`);
  for (const def of seed.workflows) {
    try {
      workflowRunner.register(def);
    } catch (err) {
      console.warn(
        `[seed] workflow "${def.id}" failed validation, skipping: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  // Audit workflow lifecycle (paused for approval, terminal states) so the
  // audit trail covers workflow runs end to end.
  const auditedRuns = new Set<string>();
  workflowRunner.onRunUpdate((run) => {
    if (run.status === 'paused' && !auditedRuns.has(`${run.id}:paused`)) {
      auditedRuns.add(`${run.id}:paused`);
      governance.audit('workflow.paused', {
        actor: 'system',
        sessionId: run.id,
        detail: { workflowId: run.workflowId },
      });
    }
    if ((run.status === 'succeeded' || run.status === 'failed') && !auditedRuns.has(run.id)) {
      auditedRuns.add(run.id);
      governance.audit(`workflow.${run.status}`, {
        actor: 'system',
        sessionId: run.id,
        detail: { workflowId: run.workflowId },
      });
    }
  });

  // Per-tool MCP scopes (mcp-scopes.ts): one store shared by the platform
  // MCP server (enforced in the tools/call path) and the settings REST API.
  // The server object is built unconditionally — it is inert until served —
  // so GET /api/mcp/tools works even when no MCP transport is configured.
  const mcpScopeStore = new McpScopeStore(path.join(config.dataDir, 'mcp-scopes.db'));
  const platformMcpServer = buildPlatformMcpServer({
    toolRegistry,
    governance: governanceAdapter,
    agentRuntime,
    bots: seed.bots,
    scopes: mcpScopeStore,
    // Runtime telemetry ("eyes for your AI") as READ-ONLY MCP resources
    // (sarviq://telemetry/*): connected assistants diagnose from real
    // measurements instead of guessing. No mutation surface.
    telemetry,
    // Operators serving external assistants over MCP can flip the whole
    // server to the read-only-assistant connection class:
    //   MCP_CONNECTION_CLASS=read-only-assistant mvp-server
    // Reads stay open; the only permitted write is annotations.append
    // (quarantined for human review). Default: standard (unchanged).
    connectionClass:
      process.env.MCP_CONNECTION_CLASS === 'read-only-assistant' ? 'read-only-assistant' : 'standard',
    annotationStore: new AnnotationStore(config.dataDir),
  });

  // Phase 3: two-way MCP over stdio — serve the platform's tools to an
  // external MCP client on stdin/stdout instead of starting HTTP.
  // Usage: mvp-server --mcp-stdio
  if (process.argv.includes('--mcp-stdio')) {
    await platformMcpServer.serveStdio();
    return;
  }

  // Phase 2: crash-resume — incomplete runs from a previous (crashed)
  // process resume from their last checkpoint before anything new fires.
  // Then start the trigger scheduler (cron) and mount webhook triggers.
  const recovered = await workflowRunner.recover();
  if (recovered.length > 0) {
    console.log(`[workflows] recovered ${recovered.length} interrupted run(s): ${recovered.join(', ')}`);
  }
  const triggerStore = new TriggerStore(path.join(config.dataDir, 'triggers.db'));
  const scheduler = new Scheduler();
  // Phase 4: route muse-reminder:* triggers to the reminders module instead
  // of the workflow runner (their workflowId is a reminder id, not a
  // registered workflow). fireReminder is idempotent; the onFire callback
  // below still records a task so the reminder is visible in Activity.
  const reminderStore = new ReminderStore(new ModuleDb(path.join(config.dataDir, 'muse-modules.db')));
  const schedulerRunner = {
    getRunByIdempotencyKey: (key: string) => workflowRunner.getRunByIdempotencyKey(key),
    startRun: async (
      workflowId: string,
      input: unknown,
      opts?: { idempotencyKey?: string },
    ): Promise<WorkflowRun> => {
      if (workflowId.startsWith('muse-reminder:')) {
        const reminderId = workflowId.slice('muse-reminder:'.length);
        fireReminder(reminderStore, reminderId);
        return { id: `reminder:${reminderId}:${Date.now()}` } as WorkflowRun;
      }
      return workflowRunner.startRun(workflowId, input, opts);
    },
  } as unknown as WorkflowRunner;
  // Phase 3: every scheduled workflow run leaves a task so the user can see
  // what ran and when (wired via the tasks module; failures never break the
  // scheduler tick).
  const createTask = makeTaskCreator({ dataDir: config.dataDir });
  scheduler.start(schedulerRunner, triggerStore, (trigger, runId) => {
    try {
      createTask({
        title: `Scheduled workflow ran: ${trigger.workflowId}`,
        notes: `Trigger ${trigger.id} (${trigger.kind}) fired — run ${runId}.`,
        dueAt: null,
      });
    } catch (err) {
      console.error(
        `[tasks] failed to record scheduled run ${runId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  });

  // Thread automations: wake chat threads on a schedule (Codex-style).
  // Each wake leaves a task so the user can see what the agent did.
  const { ThreadScheduleStore, ThreadScheduler } = await import('./thread-scheduler.js');
  const threadScheduleStore = new ThreadScheduleStore(config.dataDir);
  const threadScheduler = new ThreadScheduler({
    store: threadScheduleStore,
    agentRuntime,
    getBots: () => seed.bots,
    getPersistentSandboxId: (sessionId) => dotStore.getBySessionId(sessionId)?.environmentId,
    // Interconnection: routines can also fire workflow runs.
    startWorkflow: (workflowId, input) =>
      workflowRunner.startRun(workflowId, input).then((run) => ({ id: run.id })),
    onWake: ({ schedule, ok, error }) => {
      try {
        createTask({
          title: ok
            ? `Thread woke on schedule: ${schedule.sessionId}`
            : `Thread wake failed: ${schedule.sessionId}`,
          notes: ok
            ? `Schedule ${schedule.id} fired — agent checked in on session ${schedule.sessionId}.`
            : `Schedule ${schedule.id} failed: ${error ?? 'unknown error'}`,
          dueAt: null,
        });
      } catch (err) {
        console.error('[tasks] failed to record thread wake:', err instanceof Error ? err.message : err);
      }
    },
  });
  threadScheduler.start();

  // Omni rolling summary (Omni panel backend): the collector feeds the
  // store from the governance audit log, pending approvals, and workflow
  // runs; the scheduler refreshes the live layers hourly and runs the
  // nightly/weekly compression rollups on day/week boundaries.
  const { OmniStore, OmniCollector, OmniScheduler } = await import('./omni.js');
  const omniStore = new OmniStore(config.dataDir);
  const omniCollector = new OmniCollector(omniStore, {
    listApprovals: (status) => governance.listApprovals(status),
    listAudit: (limit, offset) => governance.listAudit(limit, offset),
    listRuns: () => workflowRunner.listRuns(),
  });
  const omniScheduler = new OmniScheduler(omniStore, {
    collector: omniCollector,
    ollamaEnhance: process.env.OMNI_OLLAMA_ENHANCE === '1',
  });
  omniScheduler.start();
  // First pass shortly after boot so the panel has data on first load.
  omniScheduler.tick().catch((err) => console.error('[omni] initial collect failed:', err));

  // Daily briefing: background digest generation at the configured local
  // time (default 07:00). Unlike ThreadScheduler — which wakes chat threads
  // with an agent turn — the briefing is a pure background data-assembly
  // job (audit log + calendar + approvals + regressions + local-Ollama
  // summary) that needs no bot or chat session, so it runs on its own
  // minute-tick scheduler that follows the ThreadScheduler pattern
  // (interval tick + per-day dedup persisted in SQLite). Delivery time and
  // the enabled flag are configurable via PUT /api/briefing/config.
  const { BriefingScheduler } = await import('./briefing.js');
  const briefingScheduler = new BriefingScheduler({
    dataDir: config.dataDir,
    governance,
    runHealth,
    // Interconnection: briefing pulls recent workflow runs + note changes.
    workflowSource: workflowRunner,
  });
  briefingScheduler.start();

  // Phase 3: two-way MCP over HTTP+SSE on a separate port when configured.
  // External clients connect to http://127.0.0.1:<port>/sse.
  const mcpPort = Number(process.env.MCP_SERVER_PORT ?? 0);
  if (Number.isFinite(mcpPort) && mcpPort > 0) {
    const { url } = await platformMcpServer.serveHttp({ port: mcpPort });
    console.log(`[mcp] platform MCP server on ${url}`);
  }

  // 4. HTTP layer. API routes first, then the frontend.
  const app = express();
  // Trust one reverse-proxy hop (nginx in hosted deployments): express then
  // honors X-Forwarded-Proto / X-Forwarded-Host / X-Forwarded-For for
  // req.protocol, req.hostname and req.ip, so the companion pairing and
  // WebSocket upgrade paths behave correctly behind TLS termination.
  // Direct (non-proxied) clients can still reach the server; the companion
  // and phone pairing rate limiters read X-Forwarded-For themselves and are
  // unaffected by this setting either way.
  app.set('trust proxy', 1);
  // MVP: allow any origin — the Tauri webview calls the sidecar API
  // cross-origin (http://127.0.0.1:4567). Revisit with an allowlist when
  // auth/multi-user ships.
  app.use(cors({ origin: '*' }));
  app.use(express.json({ limit: '15mb' }));
  // Phase 4: A2A agent-card discovery (spec-correct location).
  app.get('/.well-known/agent-card.json', (_req, res) => {
    res.json(defaultAgentCard(`http://127.0.0.1:${config.port}/api/protocols/a2a`));
  });
  // Phase 2: workflow webhook triggers (shared-secret authenticated).
  app.use('/webhooks', createWebhookRouter({ runner: workflowRunner, triggerStore }));
  app.use(
    '/api',
    createRouter({
      config,
      bots: seed.bots,
      agentRuntime,
      governance,
      governanceAdapter,
      workflowRunner,
      mcpConnections,
      mcpServer: platformMcpServer,
      mcpScopeStore,
      threadScheduleStore,
      checkpointStore,
      dotStore,
      preferenceStore,
      phone: { store: phoneStore, hub: phoneHub, adb: phoneAdb },
      companion: { store: companionStore, hub: companionHub },
      recordingStore,
      chatQueueStore,
      mcpServers: seed.mcpServers,
      tieredMemoryStore: new (await import('@mvp/agent-runtime')).TieredMemoryStore(config.dataDir),
      runHealth,
      omniStore,
      omniCollector,
    }),
  );
  // Parity workstreams: routers. All factories; none of these existed before.
  // Per-bot computer view (WS at /api/computer/ws is handled in the upgrade
  // switch below; REST here).
  app.use('/api/computer', computerView.router);
  // Chat branching + bot roster import/export.
  app.use(
    '/api/chat/threads',
    createChatThreadsRouter({
      dataDir: config.dataDir,
      branchSession: (id, msgId, opts) => agentRuntime.branchSession(id, msgId, opts),
      listThreadMessages: (id) => agentRuntime.listThreadMessages(id),
      audit: (action, fields) => governance.audit(action, fields),
    }),
  );
  app.use(
    '/api/bots',
    createBotRosterRouter({
      dataDir: config.dataDir,
      getBots: () => seed.bots,
      audit: (action, fields) => governance.audit(action, fields),
    }),
  );
  // Bot routines: management API + signed inbound webhook triggers.
  // (Stores are created once above and shared by both routers.)
  app.use('/api/routines', routinesRouter);
  app.use('/webhooks/routines', routineWebhookRouter);
  // n8n workflow import/export.
  app.use('/api', createWorkflowN8nRouter({ workflowRunner }));
  // Git worktrees (OpenCode parity).
  {
    const worktreesRouter = express.Router();
    registerWorktreeRoutes(worktreesRouter, {
      workspaceDir: config.workspaceDir,
      worktreeRoot: path.join(config.workspaceDir, '.worktrees'),
      sessionStore: agentRuntime.sessionStore,
    });
    app.use('/worktrees', worktreesRouter);
  }
  // Unknown /api paths → JSON 404 (before the SPA fallback claims them).
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Unknown API route' });
  });
  // Live runtime meter ("eyes for your AI"): human-readable, server-rendered,
  // dependency-free health page — queue depth, latencies, error rates,
  // per-bot activity. Mounted outside /api (it is not one of the app's nav
  // destinations) and before the SPA fallback so the path isn't claimed.
  // Counts and normalized names only — never secrets or message bodies.
  app.get('/_sarviq/', (_req, res) => {
    try {
      res.type('html').send(
        renderSarviqMeter({
          version: '0.1.0',
          queueDepth: chatQueueStore.list().length,
          telemetry,
        }),
      );
    } catch (err) {
      res.status(500).type('text').send(`meter error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  mountWebAssets(app, config.webOutDir);

  const server = app.listen(config.port, '127.0.0.1', () => {
    console.log(`[api] listening on http://127.0.0.1:${config.port}`);
    console.log(
      `[api] data dir: ${config.dataDir} | bots: ${seed.bots.length} | ` +
        `workflows: ${seed.workflows.length} | tools: ${toolRegistry.size} | ` +
        `mcp: warming up in background`,
    );
    // MCP servers connect AFTER listen so a slow/failing server never
    // delays boot. The shared mcpConnections array fills in as they land.
    void connectMcp()
      .catch((err) => console.error('[tools] MCP warmup crashed:', err))
      .finally(() => {
        console.log(
          `[tools] MCP warmup done: ${mcpConnections.filter((c) => c.ok).length}/${mcpConnections.length} connected`,
        );
      });
  });

  // Remote-phone control: WebSocket endpoint for live sessions at
  // /api/phone/ws (REST routes live under /api/phone via routes.ts).
  // Companion app: push channel at /api/companion/ws (REST under
  // /api/companion). Unknown upgrade paths are destroyed so nothing else
  // hijacks upgrades.
  server.on('upgrade', (req, socket, head) => {
    const path = req.url?.split('?')[0];
    if (path === '/api/phone/ws') {
      phoneHub.handleUpgrade(req, socket, head);
    } else if (path === '/api/companion/ws') {
      companionHub.handleUpgrade(req, socket, head);
    } else if (path === '/api/computer/ws') {
      computerView.handleUpgrade(req, socket, head);
    } else {
      socket.destroy();
    }
  });

  const shutdown = async () => {
    console.log('[api] shutting down…');
    server.close();
    scheduler.stop();
    await closeMcp();
    try {
      await computerSandbox.kill();
    } catch {
      // ignore
    }
    try {
      agentRuntime.close();
    } catch {
      // ignore
    }
    try {
      workflowRunner.close();
    } catch {
      // ignore
    }
    try {
      governance.close();
    } catch {
      // ignore
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

boot().catch((err) => {
  console.error('[api] fatal boot error:', err);
  process.exit(1);
});
