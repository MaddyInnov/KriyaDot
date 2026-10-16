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
import {
  corsOriginFn,
  createBootstrapHandler,
  ensureLoopbackToken,
  isOriginAllowed,
  requireLoopbackAuth,
} from './loopback-auth.js';
import { GovernanceAdapter } from './governance-adapter.js';
import { SEED_FILES } from './generated/seed.js';
import { loadSeed } from './seed.js';
import { syncProviderKeysToEnv } from './providers.js';
import { applyBotPolicies } from './bot-policies.js';
import { buildToolRegistry } from './tool-registry.js';
import { registerDelegateTools } from './delegate-wiring.js';
import { registerBotTeamToolsWiring } from './bot-team-wiring.js';
import { applyChiefOverlays, registerChiefToolsWiring } from './chief-wiring.js';
import { createChiefRouter } from './chief-routes.js';
import { createBotConversationsRouter } from './bot-conversations-routes.js';
import { createAgentDetectRouter } from './agent-detect-routes.js';
import { createCliAuthRouter } from './cli-auth-routes.js';
import { createAgentImportRouter } from './agent-import-routes.js';
import { createAnalyticsRouter } from './analytics-routes.js';
import { createLocalLlmRouter } from './local-llm-routes.js';
import { LocalLlmManager } from '@mvp/agent-runtime';
import { LazyMcpManager } from '@mvp/agent-runtime';
import { createSelfUpdateRouter } from './self-update-routes.js';
import { SelfUpdateManager } from '@mvp/agent-runtime';
import { createFusionRouter, shutdownFusionRuns } from './fusion-routes.js';
import { FusionRunStore } from './fusion.js';
import { createEvalRouter, shutdownEvalRuns } from './eval-routes.js';
import { EvalRunStore, EvalSuiteStore } from './evals.js';
import { createSummarizer } from './summarizer.js';
import { createPeerApprovalRouter, createPeerApprovalBroker } from './peer-approval-routes.js';
import { PeerApprovalStore, createPeerApprovalGate } from '@mvp/agent-runtime';
import { createWidgetRouter, sweepWidgets } from './widget-routes.js';
import { WidgetCoordinator, WidgetStore } from '@mvp/agent-runtime';
import { createRouter } from './routes.js';
import { renderKriyaDotMeter } from './kriyadot-meter.js';
import { createWebhookRouter } from './webhooks.js';
import { mountWebAssets } from './web-assets.js';
// Parity workstreams (OpenMausBot/n8n/Notion/Dots/Groq/OpenCode/Laya/Boosthis/Muse):
// each module exports a factory; mounted below without touching other wiring.
import { createComputerView } from './computer-view.js';
import { createChatThreadsRouter, ThreadTitleStore } from './chat-threads-routes.js';
import { createMessageSearchRouter } from './message-search-routes.js';
import { createWorkspaceBackupRouter } from './workspace-backup-routes.js';
import { createMessageThreadsRouter } from './message-threads-routes.js';
import { createMessageReactionsRouter } from './message-reactions-routes.js';
import { MessageReactionStore } from './message-reactions.js';
import { createGroupChatsRouter } from './group-chats-routes.js';
import { applyImportedBots, createBotRosterRouter } from './bot-roster-routes.js';
import { registerRoutineRoutes } from './bot-routines.js';
import { createRoutineWebhookRouter } from './webhooks.js';
import { RoutineHookStore, WebhookDeliveryWorker, createPublicHookRouter } from './routine-hooks.js';
import { createWorkflowN8nRouter } from './workflow-n8n.js';
import {
  interconnectionPolicyRules,
  registerInterconnectionTools,
} from './interconnect-tools.js';
import { registerWorktreeRoutes } from './worktrees-routes.js';
import { createWorktreeTools } from '@mvp/agent-runtime/dist/worktrees.js';
import { HookBus, loadPlugins } from '@mvp/agent-runtime/dist/hooks.js';
import { runChatCli, runScanCli } from './cli.js';
// (selectComputerSandbox import removed: per-bot computers (P1 #14) replaced
// the single shared sandbox with a PerBotComputerManager; see below.)
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
// Per-bot computers + "Works on" surface selection (OpenMausBot parity P1
// #14): each bot gets its own computer instance instead of one shared
// sandbox. Same direct-dist-subpath import pattern as computer.js above.
import {
  PerBotComputerManager,
  type ComputerSurface,
} from '@mvp/agent-runtime/dist/tools/computer-surfaces.js';
import {
  applyComputerSurfacePins,
  applyComputerSurfaces,
} from './computer-surfaces.js';
import { registerComputerSurfaceRoutes } from './computer-surface-routes.js';
// BYO VPS (OpenMausBot parity P1 #24): per-bot SSH connection profiles.
// Same direct-dist-subpath import pattern as computer.js above.
import {
  VpsComputerLayer,
  VpsConnectionPool,
  VpsNotConfiguredError,
} from '@mvp/agent-runtime/dist/tools/vps.js';
import { resolveVpsProfile } from './vps-profiles.js';
import { registerVpsRoutes } from './vps-routes.js';
// Password-safe login typing (type_login): resolves the vault password
// server-side inside the handler; the model plane never sees values.
// Same direct-dist-subpath import pattern as computer.js above.
import { registerTypeLoginTool } from '@mvp/agent-runtime/dist/tools/type-login.js';
import { SecureVault } from '@mvp/vault';
// Real foreground OS layer (opt-in via COMPUTER_USE_REAL=1; mock by default).
// Same direct-dist-subpath import pattern as computer.js above.
// (Per-bot computers (P1 #14) resolve layers lazily per bot via the
// PerBotComputerManager above; there is no shared sandbox anymore.)
import {
  ModuleDb,
  ReminderStore,
  fireReminder,
  registerMuseModuleTools,
  museModuleToolPolicies,
} from '@mvp/muse-modules';
import { defaultAgentCard } from '@mvp/protocols';
import type { Policy } from '@mvp/governance';
// Composio execution bridge (OpenMausBot parity): connected-account OAuth
// (composio-accounts.ts) + composio_call / composio_list_actions agent tools
// with governance policy rules. The API key is resolved server-side from the
// encrypted vault inside the tool handlers — it never reaches the model.
import { applyComposioToolGrants, COMPOSIO_KEY_NAME } from './composio.js';
import { composioToolPolicies, registerComposioTools } from './composio-tools.js';

// Pipe/JSON chat mode: `mvp-server chat --bot <id> [--json]`. Parsed at the
// very top, before boot(), so `chat` never starts the HTTP server.
// runChatCli returns the exit code; index.ts owns process.exit.
if (process.argv[2] === 'chat') {
  const code = await runChatCli(process.argv.slice(2));
  process.exit(code);
}

// kriyadot scan: one-command offline project scanner — `mvp-server scan [dir]`.
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
  /** Runtime telemetry collector → read-only kriyadot://telemetry/* resources. */
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
  // Per-boot loopback bearer token (C1): minted once at startup, persisted
  // to <dataDir>/.api-token for local clients (TUI/scripts), served to
  // browser clients via GET /api/auth/bootstrap (Origin-gated).
  const loopbackToken = ensureLoopbackToken(config.dataDir);
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
  // Per-bot "Works on" computer surfaces (P1 #14): overlay from
  // <dataDir>/computer-surfaces.json. Unset → 'auto'.
  applyComputerSurfaces(seed.bots, config.dataDir);
  // MBTI personas: per-bot overlay from <dataDir>/bot-personas.json.
  const { applyBotPersonas } = await import('./bot-personas.js');
  applyBotPersonas(seed.bots, config.dataDir);
  // Per-bot workspaces (Octop-style isolation): overlay from
  // <dataDir>/bot-workspaces.json. Unset → global workspaceDir.
  const { applyBotWorkspaces } = await import('./bot-workspaces.js');
  applyBotWorkspaces(seed.bots, config.dataDir);
  // Per-bot model + options (Codync parity: model picker): overlay from
  // <dataDir>/bot-models.json.
  const { applyBotModels } = await import('./bot-models.js');
  applyBotModels(seed.bots, config.dataDir);
  // Per-bot voice-call settings (Codync parity: realtime voice calls):
  // overlay from <dataDir>/bot-voice.json.
  const { applyBotVoice } = await import('./bot-voice.js');
  applyBotVoice(seed.bots, config.dataDir);
  // Per-bot skill lists (OpenMausBot parity P1 #20: skill review): overlay
  // from <dataDir>/bot-skills.json.
  const { applyBotSkills } = await import('./bot-skills.js');
  applyBotSkills(seed.bots, config.dataDir);
  // Per-bot approval modes (Atomic parity: plan/auto/bypass): overlay from
  // <dataDir>/bot-approval-modes.json.
  const { applyBotApprovalModes } = await import('./bot-approval-modes.js');
  applyBotApprovalModes(seed.bots, config.dataDir);
  // Per-bot memory fabric settings (Atomic parity: reflection + live
  // distiller flags): overlay from <dataDir>/bot-memory-settings.json.
  const { applyBotMemorySettings, wireMemoryDistillers } = await import('./memory-fabric.js');
  applyBotMemorySettings(seed.bots, config.dataDir);
  // Chat branching / roster import: overlay previously imported bots.
  applyImportedBots(seed.bots, config.dataDir);
  // Chief of Staff: restore chief flag + sections, approved field overrides,
  // and deleted ids from chief-teams.db.
  applyChiefOverlays(seed.bots, config.dataDir);
  // Auto-allocated per-bot workspaces (Codync parity): every bot gets
  // <dataDir>/bots/<botId>/workspace unless it already has an explicit
  // workspace configured.
  const { allocateBotWorkspaces } = await import('./bot-workspace-alloc.js');
  allocateBotWorkspaces(seed.bots, config.dataDir);
  const botsById = new Map<string, BotConfig>(seed.bots.map((b) => [b.id, b]));
  // Composio bridge: bots with ≥1 enabled Composio app gain the
  // composio_call / composio_list_actions tools (derived from the
  // composio-enables.json files, so grants survive restarts).
  applyComposioToolGrants(seed.bots, config.dataDir);

  // 2. Governance + tools.
  // Phase 4: prepend approval-gating rules for the new agent tools
  // (computer use, browser automation). First match wins; these are
  // require-approval — strictly stronger than the defaults they precede,
  // so deny-by-default is preserved and extended.
  const globalPolicy: Policy = {
    ...DEFAULT_POLICY,
    rules: [...interconnectionPolicyRules(), ...computerUsePolicyRules(), ...museModuleToolPolicies(), ...composioToolPolicies(), ...DEFAULT_POLICY.rules],
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

  // Per-bot computers (OpenMausBot parity P1 #14): every bot gets its OWN
  // computer instance (own display state, own serialized input queue) plus
  // a "Works on" surface choice (auto/local/docker/browser/vps/off), instead of
  // one shared sandbox. Instances are created lazily on first computer-tool
  // use, dropped when the surface changes or the bot is deleted, and reaped
  // after 30 min idle. Created before the computer view so the viewer's
  // createLayer resolves to the same instance the bot's tools drive.
  //
  // BYO VPS (OpenMausBot parity P1 #24): the connection pool lives here so
  // the 'vps' computer surface and the VPS REST routes share connections.
  // Private keys resolve from the SecureVault ('default-user' namespace, like
  // provider keys); passwords are never stored and only travel inside the
  // connect request body.
  const vpsPool = new VpsConnectionPool({
    resolvePrivateKey: (ref: string) => {
      try {
        return new SecureVault(config.dataDir, 'default-user', 'vps').get(ref)?.value;
      } catch {
        return undefined;
      }
    },
  });
  const auditComputerAction = (action: string, detail: unknown): void => {
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
  };
  const computerManager = new PerBotComputerManager({
    onRealAction: auditComputerAction,
    vpsLayerFor: (botId: string) => {
      const profile = resolveVpsProfile(config.dataDir, botId);
      if (!profile) throw new VpsNotConfiguredError(botId);
      const conn = vpsPool.getOrCreate(`bot:${botId}`, profile);
      return new VpsComputerLayer(conn, { onRealAction: auditComputerAction });
    },
  });
  applyComputerSurfacePins(computerManager, config.dataDir);
  // Idle sweep every 5 minutes (reaps computers idle > 30 min by default).
  const computerIdleTimer = setInterval(() => {
    computerManager.idleSweep().catch((err) => {
      console.warn('[computer-surfaces] idle sweep failed:', (err as Error).message);
    });
  }, 5 * 60 * 1000);
  if (typeof computerIdleTimer.unref === 'function') computerIdleTimer.unref();

  // Per-bot computer view (OpenMausBot parity): live screen stream + user
  // input per bot. The hub is created here so the WS upgrade handler below
  // shares the instance with the REST routes.
  const computerView = createComputerView({
    audit: (action, fields) => governance.audit(action, fields),
    listAudit: (limit) => governance.listAudit(limit),
    loopbackToken,
    // The viewer shows the same per-bot instance the bot's tools drive.
    createLayer: (botId: string) =>
      computerManager.getLayer(botId, {
        surface: botsById.get(botId)?.computerSurface,
      }),
  });

  const governanceAdapter = new GovernanceAdapter(governance, {
    getBotConfig: (id) => botsById.get(id),
    globalPolicy,
    getPreference: (botId, toolName) => preferenceStore.getPreference(botId, toolName)?.preference,
  });

  const { registry: toolRegistry, connections: mcpConnections, userSkillStore, connectMcp, close: closeMcp } =
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

  // Lazy MCP directory (OpenMausBot parity P1 #22): installed servers are
  // registered as lazy stubs in the tool registry. Nothing spawns at boot;
  // the server process starts on the first tool call. Disabled servers never
  // spawn.
  const lazyMcpManager = new LazyMcpManager({
    dataDir: config.dataDir,
    pinDbPath: path.join(config.dataDir, 'mcp-pins.db'),
  });
  lazyMcpManager.syncRegistry(toolRegistry);
  const refreshMcpStubs = (): void => {
    try {
      lazyMcpManager.syncRegistry(toolRegistry);
    } catch (err) {
      console.warn('[mcp] lazy stub re-sync failed:', (err as Error).message);
    }
  };

  // Phase 4: computer-use tools (sandboxed GUI automation; mutating actions
  // are approval-gated via computerUsePolicyRules above; the default OS
  // layer is the mock — no real input) and Muse-module tools (research_deep,
  // browser_action — browser_action approval-gated via museModuleToolPolicies).
  // Per-bot computers (OpenMausBot parity P1 #14): the tools no longer share
  // one sandbox. Each handler resolves its OS layer per tool call from the
  // calling bot's "Works on" surface (BotConfig.computerSurface, default
  // 'auto' → docker if COMPUTER_USE_DOCKER=1, playwright if
  // COMPUTER_USE_PLAYWRIGHT=1, else local mock/real via COMPUTER_USE_REAL=1;
  // see docs/computer-use-playwright.md). The approval gate applies
  // identically either way — governance evaluates before the handler runs.
  const resolveBotComputerOS = computerManager.resolveOSFor(
    (botId: string): ComputerSurface | undefined => botsById.get(botId)?.computerSurface,
  );
  registerComputerUseTool(toolRegistry, {
    resolveOS: resolveBotComputerOS,
  });
  // type_login (Codync parity): the handler resolves the vault password
  // server-side — the model plane only ever sees the loginId. Vault is
  // per x-user-id; tool turns run as the local single user, so the
  // 'default-user' namespace matches what the Settings UI writes.
  // No verifySite is injected here: the bot must assert expectedSite, which
  // must match the login's stored site; the human approval gate is the
  // real protection (the approval card names the login and site).
  registerTypeLoginTool(toolRegistry, {
    // Per-bot computers (P1 #14): type onto the calling bot's own surface.
    resolveOS: resolveBotComputerOS,
    getLogin: (loginId: string) => {
      const vault = new SecureVault(config.dataDir, 'default-user', 'type-login-tool');
      const rec = vault.getLogin(loginId);
      return rec ? { name: rec.name, site: rec.site, username: rec.username, password: rec.password } : undefined;
    },
  });
  // Composio execution bridge (OpenMausBot parity): composio_call executes
  // one action on a connected account (approval-gated + per-bot app
  // enablement enforced in the handler); composio_list_actions is read-only
  // discovery. The API key is resolved server-side from the encrypted vault
  // per tool call — never in args, results, or logs. Tool turns run as the
  // local single user ('default-user' namespace, matching the Settings UI).
  registerComposioTools(toolRegistry, {
    dataDir: config.dataDir,
    getApiKey: (userId: string) => {
      try {
        return new SecureVault(config.dataDir, userId, 'composio-tool').get(COMPOSIO_KEY_NAME)?.value;
      } catch {
        return undefined;
      }
    },
    resolveUserId: () => 'default-user',
    audit: (action, fields) => governance.audit(action, fields),
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
  // platform MCP server (read-only kriyadot://telemetry/* resources), and
  // the /_kriyadot/ meter page.
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

  // Peer approval cards (OpenMausBot parity): per-action Allow / Deny /
  // Always-allow for bot→bot calls (ask_bot / message_bot / delegate),
  // 15-minute expiry, persisted per-pair grants. The gate is consulted by
  // the runtime BEFORE governance; a peer-allowed call does not raise a
  // second generic tool card (no double-prompting).
  const peerApprovalStore = new PeerApprovalStore(config.dataDir);
  // "Needs you" push for peer cards is wired after the PushService exists
  // below (best-effort; never blocks card minting).
  let peerCardPush: ((card: { senderBotId: string; senderBotName: string; targetBotName: string; actionType: string; id: string }) => void) | undefined;
  const peerApprovalBroker = createPeerApprovalBroker(peerApprovalStore, {
    audit: (action, fields) => governance.audit(action, fields),
    onCard: (card) => {
      try {
        peerCardPush?.(card);
      } catch {
        // Push must never break card minting.
      }
    },
  });
  const peerApprovalGate = createPeerApprovalGate({
    store: peerApprovalStore,
    broker: peerApprovalBroker,
    getBotName: (id) => botsById.get(id)?.name ?? id,
    isBypassMode: (botId) => botsById.get(botId)?.approvalMode === 'bypass',
    audit: (type, detail) => {
      try {
        governance.audit(type, { actor: 'peer-approval-gate', detail });
      } catch {
        // Audit failures must never break the gate.
      }
    },
  });

  // Interactive widgets + AskUserQuestion (OpenMausBot parity P1 #15):
  // WidgetStore persists widget cards in widgets.db; the coordinator holds
  // in-flight waiters and fails them closed on expiry. The chat route passes
  // the coordinator into runTurn so ask_user_question can pause for answers.
  const widgetStore = new WidgetStore(config.dataDir);
  const widgetCoordinator = new WidgetCoordinator(widgetStore, {
    audit: (type, detail) => {
      try {
        governance.audit(type, { actor: 'widget-coordinator', detail });
      } catch {
        // Audit failures must never break widgets.
      }
    },
  });

  const agentRuntime = new AgentRuntime({
    dbPath: `${config.dataDir}/agent.db`,
    skillsDir: path.join(seedDir, 'skills'),
    additionalSkillsDirs: [path.join(config.dataDir, 'skills')],
    // OpenMausBot parity P1 #20: disabled-by-default skill gate. Seed and
    // imported skills are unaffected; user-managed skills must be active
    // and in scope for the bot.
    skillUsabilityGate: (name, botId) =>
      userSkillStore.isUserSkill(name) ? userSkillStore.isUsable(name, botId) : true,
    peerApprovalGate,
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

  // Bot-to-bot collaboration tools (Codync team parity): list_bots, ask_bot,
  // message_bot. Exchanges persist to bot-conversations.db for the sheet API.
  const botConversationStore = registerBotTeamToolsWiring({
    registry: toolRegistry,
    agentRuntime,
    dataDir: config.dataDir,
    governanceAdapter,
    getBotConfig: (id) => botsById.get(id),
    getBots: () => seed.bots,
    audit: (action, fields) => governance.audit(action, fields),
  });

  // Chief of Staff (OpenMausBot parity): chief-only coordination tools,
  // incidents/escalations inbox, team-setup proposals, and the per-turn
  // chief prompt section. State persists in chief-teams.db.
  const chiefWiring = registerChiefToolsWiring({
    registry: toolRegistry,
    agentRuntime,
    dataDir: config.dataDir,
    getBotConfig: (id) => botsById.get(id),
    getBots: () => seed.bots,
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
  const routineHookStore = new RoutineHookStore(config.dataDir);
  // Routine run lifecycle (OpenMausBot parity P0 #7): every routine fire
  // leaves a run record in routine-runs.db. The executor is shared by the
  // scheduler, the webhook ingress router, and the public-hook delivery
  // worker so all trigger paths record the same way.
  const { RoutineRunStore, RoutineRunExecutor } = await import('./routine-runs.js');
  const routineRunStore = new RoutineRunStore(config.dataDir);
  // Restart recovery: runs stuck queued/running when the server died are
  // marked failed ("server restarted") instead of lingering forever.
  const recoveredRuns = routineRunStore.reconcileRunning();
  if (recoveredRuns > 0) {
    console.log(`[routines] marked ${recoveredRuns} interrupted run(s) as failed (server restart)`);
  }
  const { renderRoutinePrompt: renderRoutinePromptForRuns } = await import('./webhooks.js');
  // Group goals (OpenMausBot parity P1 #11): mutable hook holder filled by
  // registerGroupGoalRoutes inside createRouter (below); the routine
  // executor forwards goal-mode routine fires to the goal engine.
  const groupGoalHooks: {
    startGroupGoal?: (args: {
      routine: { id: string; name: string; botId: string };
      prompt: string;
    }) => Promise<string>;
  } = {};
  const routineRunExecutor = new RoutineRunExecutor({
    runStore: routineRunStore,
    agentRuntime,
    getBots: () => seed.bots,
    renderPrompt: renderRoutinePromptForRuns,
    startGroupGoal: (args) => {
      const hook = groupGoalHooks.startGroupGoal;
      if (!hook) throw new Error('group-goal engine not initialized');
      return hook(args);
    },
  });
  const { routineStore, triggerStore: routineTriggerStore } = registerRoutineRoutes(
    routinesRouter,
    {
      dataDir: config.dataDir,
      getBots: () => seed.bots,
      hookStore: routineHookStore,
      getBaseUrls: () => ({ publicBaseUrl: config.publicBaseUrl, localPort: config.port }),
      runStore: routineRunStore,
    },
  );
  const routineWebhookRouter = createRoutineWebhookRouter({
    routineStore,
    triggerStore: routineTriggerStore,
    agentRuntime,
    getBots: () => seed.bots,
    runExecutor: routineRunExecutor,
  });
  // Public webhook ingress (Codync parity): per-routine URL + secret with
  // HMAC verification and a queued delivery worker. The router is created
  // here; it mounts on `app` before the global express.json() parser below
  // because it needs the raw request body for signature verification.
  const routinePublicHookRouter = createPublicHookRouter({ routineStore, hookStore: routineHookStore });
  const hookDeliveryWorker = new WebhookDeliveryWorker({
    routineStore,
    hookStore: routineHookStore,
    agentRuntime,
    getBots: () => seed.bots,
    runExecutor: routineRunExecutor,
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
    // (kriyadot://telemetry/*): connected assistants diagnose from real
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

  // Routine schedules (OpenMausBot parity): timezone-aware once/daily/
  // cron/interval schedules on bot routines. Each scheduled fire runs the
  // routine's bot turn; overlap policy ('skip' | 'queue') is per schedule.
  // Assigned after the PushService exists (below); invoked on the failure
  // streak auto-pause path.
  let notifyRoutinePaused:
    | ((routine: import('./bot-routines.js').BotRoutine, streak: number) => void)
    | undefined;
  const { RoutineScheduler } = await import('./routine-schedules.js');
  const { renderRoutinePrompt } = await import('./webhooks.js');
  const routineScheduler = new RoutineScheduler({
    routineStore,
    runStore: routineRunStore,
    runExecutor: routineRunExecutor,
    agentRuntime,
    getBots: () => seed.bots,
    renderPrompt: renderRoutinePrompt,
    onScheduleAutoPaused: (routine, streak) => notifyRoutinePaused?.(routine, streak),
    onFire: ({ routine, at, ok, error, skipped }) => {
      try {
        createTask({
          title: skipped
            ? `Routine skipped (overlap): ${routine.name}`
            : ok
              ? `Routine fired on schedule: ${routine.name}`
              : `Routine schedule failed: ${routine.name}`,
          notes: skipped
            ? `Schedule for routine ${routine.id} fired at ${new Date(at).toISOString()} but the previous run was still in flight (overlap: skip).`
            : ok
              ? `Schedule for routine ${routine.id} fired at ${new Date(at).toISOString()}.`
              : `Schedule for routine ${routine.id} failed at ${new Date(at).toISOString()}: ${error ?? 'unknown error'}`,
          dueAt: null,
        });
      } catch (err) {
        console.error('[tasks] failed to record routine fire:', err instanceof Error ? err.message : err);
      }
    },
  });
  // Boot: occurrences missed while the server was down become 'missed'
  // run records; catchUp:true schedules get a bounded backfill (max 3).
  const missedRuns = await routineScheduler.reconcileMissedRuns();
  if (missedRuns.missed > 0) {
    console.log(
      `[routines] marked ${missedRuns.missed} missed run(s) across ${missedRuns.routines} routine(s); ` +
        `${missedRuns.catchUpRuns} catch-up run(s) started`,
    );
  }
  routineScheduler.start();

  // Routine run history API (OpenMausBot parity P0 #7): run records,
  // manual run-now / cancel / retry. Same router as the routine routes.
  const { registerRoutineRunRoutes } = await import('./routine-run-routes.js');
  registerRoutineRunRoutes(routinesRouter, {
    routineStore,
    runStore: routineRunStore,
    scheduler: routineScheduler,
  });

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
  // Public routine webhook ingress (Codync parity): mounted BEFORE the
  // global express.json() parser because HMAC signature verification needs
  // the raw request body. express.raw() sets req._body so the JSON parser
  // skips these requests. Reachability note: the API binds to 127.0.0.1 —
  // external senders (GitHub etc.) need a tunnel (Tailscale/cloudflared/ngrok)
  // plus KRIYADOT_PUBLIC_URL; LAN senders use the local URL.
  app.use('/api/hooks', express.raw({ type: '*/*', limit: '64kb' }), routinePublicHookRouter);
  // Loopback auth (C1): the API binds to 127.0.0.1, which any website in the
  // user's browser can reach. Enforce a per-boot bearer token on every route
  // except the exempt prefixes (companion/remote-screen have device-token
  // auth, /api/hooks is HMAC-verified, /api/health and /.well-known are
  // public, /api/auth/bootstrap issues the token itself under Origin gating).
  // CORS allowlist keeps evil origins from reading responses; the bearer
  // token is the actual auth (CORS is never auth).
  app.use(cors({ origin: corsOriginFn }));
  app.use(requireLoopbackAuth(loopbackToken));
  // Token bootstrap for the browser UI (and other browser clients): returns
  // the token only when the Origin header is absent or allowlisted, so an
  // evil cross-origin page can never read it.
  app.get('/api/auth/bootstrap', createBootstrapHandler(loopbackToken));
  app.use(express.json({ limit: '150mb' })); // 100MB file uploads (base64 +33%)
  // Phase 4: A2A agent-card discovery (spec-correct location).
  app.get('/.well-known/agent-card.json', (_req, res) => {
    res.json(defaultAgentCard(`http://127.0.0.1:${config.port}/api/protocols/a2a`));
  });
  // Remote screen viewing (phone -> PC, Codync parity): approval-gated live
  // screen frames over a WebSocket frame channel (MJPEG-style, not raw
  // WebRTC — see remote-screen.ts). REST at /api/remote-screen via routes.ts;
  // the WS upgrade is handled in the switch below, sharing this instance.
  const { RemoteScreenService } = await import('./remote-screen.js');
  const { createRemoteScreenUpgrade } = await import('./remote-screen-routes.js');
  const remoteScreenService = new RemoteScreenService({
    requestApproval: (toolName, args, ctx) => governance.requestApproval(toolName, args, ctx),
    awaitDecision: (approvalId, timeoutMs) => governance.awaitDecision(approvalId, timeoutMs),
    audit: (action, fields) => governance.audit(action, fields),
  });
  const remoteScreenUpgrade = createRemoteScreenUpgrade({
    store: companionStore,
    service: remoteScreenService,
    audit: (action, fields) => governance.audit(action, fields),
  });
  // Realtime voice calls with bots (Codync parity): the service owns the
  // STT → bot turn → TTS loop; utterances stream over
  // /api/voice/calls/ws (upgrade branch below). The bot turn reuses the
  // agent runtime with the bot's memory recall; approvals raised mid-call
  // surface as WS events and resolve through the normal Approvals inbox.
  // The tiered memory store is hoisted here so both the call service and
  // the router deps share one instance.
  const { TieredMemoryStore: TieredMemoryStoreCtor } = await import('@mvp/agent-runtime');
  const tieredMemoryStore = new TieredMemoryStoreCtor(config.dataDir);
  // Memory fabric: install the live (model) distiller for bots that opted
  // in via memoryLiveDistill; everyone else keeps the zero-cost heuristic.
  wireMemoryDistillers(seed.bots, tieredMemoryStore);
  const { VoiceCallService } = await import('./voice-call.js');
  const { createVoiceCallUpgrade } = await import('./voice-call-routes.js');
  const voiceCallService = new VoiceCallService({
    dataDir: config.dataDir,
    findBot: (botId: string) => (seed.bots as Array<{ id: string }>).find((b) => b.id === botId) as
      | import('@mvp/agent-runtime').BotConfig
      | undefined,
    runBotTurn: async ({ bot, message, sessionId, signal, onText, onApproval }) => {
      let memoryContext: string | undefined;
      try {
        memoryContext = tieredMemoryStore.recallForPrompt(bot.id, message) || undefined;
      } catch {
        memoryContext = undefined; // memory must never break calls
      }
      await agentRuntime.runTurn({
        bot,
        message,
        sessionId,
        signal,
        memoryContext,
        onEvent: (e) => {
          if (e.type === 'token') onText(e.content);
          else if (e.type === 'approval_required') onApproval(e.approvalId, e.call.name);
        },
      });
    },
    audit: (action, fields) => governance.audit(action, fields),
  });
  const voiceCallUpgrade = createVoiceCallUpgrade({ service: voiceCallService, loopbackToken });
  // Native realtime (speech-to-speech) voice calls (OpenMausBot parity
  // P0 #9): full-duplex WS at /api/voice/realtime/ws with server-side VAD,
  // barge-in, and sentence-chunked TTS — plus an OpenAI Realtime
  // passthrough engine when the user selects it and a key resolves.
  const { RealtimeVoiceService } = await import('./voice-realtime.js');
  const { createRealtimeVoiceUpgrade } = await import('./voice-realtime-routes.js');
  const realtimeVoiceService = new RealtimeVoiceService({
    dataDir: config.dataDir,
    findBot: (botId: string) => (seed.bots as Array<{ id: string }>).find((b) => b.id === botId) as
      | import('@mvp/agent-runtime').BotConfig
      | undefined,
    runBotTurn: async ({ bot, message, sessionId, signal, onText, onApproval }) => {
      let memoryContext: string | undefined;
      try {
        memoryContext = tieredMemoryStore.recallForPrompt(bot.id, message) || undefined;
      } catch {
        memoryContext = undefined; // memory must never break calls
      }
      await agentRuntime.runTurn({
        bot,
        message,
        sessionId,
        signal,
        memoryContext,
        onEvent: (e) => {
          if (e.type === 'token') onText(e.content);
          else if (e.type === 'approval_required') onApproval(e.approvalId, e.call.name);
        },
      });
    },
    audit: (action, fields) => governance.audit(action, fields),
  });
  const realtimeVoiceUpgrade = createRealtimeVoiceUpgrade({ service: realtimeVoiceService, loopbackToken });
  // Phase 2: workflow webhook triggers (shared-secret authenticated).
  app.use('/webhooks', createWebhookRouter({ runner: workflowRunner, triggerStore }));
  // Encrypted push notifications (Codync parity): FCM fan-out to paired
  // devices, sealed per device. No-op when FCM isn't configured.
  // Built before the router so peer-approval "needs you" pushes
  // (OpenMausBot parity) can hook in, best-effort.
  const pushService = new (await import('./push.js')).PushService({
    listPushDevices: () => companionStore.listPushDevices(),
    getBotPref: (botId) => {
      const bot = (seed.bots as Array<{ id: string; notifications?: 'all' | 'approvals' | 'none' }>).find(
        (b) => b.id === botId,
      );
      return bot?.notifications ?? 'all';
    },
  });
  peerCardPush = (card) => {
    void pushService
      .notifyApprovalNeeded(
        card.senderBotId,
        card.senderBotName,
        card.id,
        `peer:${card.actionType}`,
        `${card.senderBotName} wants to ${card.actionType === 'delegate' ? 'delegate a subtask to' : card.actionType} ${card.targetBotName}`,
      )
      .catch(() => {});
  };
  // Failure-streak auto-pause (routine run lifecycle, OpenMausBot parity
  // P0 #7): "routine X failing repeatedly, paused" — a task for the UI
  // badge plus a "needs you"-style push.
  notifyRoutinePaused = (routine, streak) => {
    try {
      createTask({
        title: `Routine auto-paused after ${streak} failures: ${routine.name}`,
        notes:
          `Routine "${routine.name}" failed ${streak} times in a row, so its schedule was auto-paused. ` +
          `Check the run history for the errors, fix the cause, then re-enable the schedule.`,
        dueAt: null,
      });
    } catch (err) {
      console.error('[tasks] failed to record routine auto-pause:', err instanceof Error ? err.message : err);
    }
    const bot = (seed.bots as Array<{ id: string; name: string }>).find((b) => b.id === routine.botId);
    void pushService
      .notify({
        kind: 'failed',
        botId: routine.botId,
        botName: bot?.name ?? routine.botId,
        title: `${routine.name} — paused after failures`,
        body: `Routine "${routine.name}" failed ${streak} times in a row and its schedule was paused. Open KriyaDot to investigate.`,
      })
      .catch(() => {});
  };
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
      // Remote screen viewing (phone -> PC, Codync parity): approval-gated.
      remoteScreen: { store: companionStore, service: remoteScreenService },
      // Realtime voice calls with bots (Codync parity): STT → bot turn →
      // TTS over /api/voice/calls (REST) + /api/voice/calls/ws.
      voiceCall: { service: voiceCallService },
      // Native realtime speech-to-speech (OpenMausBot parity P0 #9).
      realtimeVoice: { service: realtimeVoiceService },
      push: pushService,
      // Group goals (OpenMausBot parity P1 #11): routine-as-goal hook.
      groupGoalHooks,
      recordingStore,
      chatQueueStore,
      mcpServers: seed.mcpServers,
      tieredMemoryStore,
      runHealth,
      omniStore,
      omniCollector,
      computerManager,
      // BYO VPS (OpenMausBot parity P1 #24).
      vpsPool,
      // Lazy MCP directory (OpenMausBot parity P1 #22).
      lazyMcpManager,
      refreshMcpStubs,
      // Interactive widgets (OpenMausBot parity P1 #15): the chat route
      // passes this into runTurn so ask_user_question can pause for answers.
      widgetCoordinator,
    }),
  );
  // Parity workstreams: routers. All factories; none of these existed before.
  // Per-bot computer view (WS at /api/computer/ws is handled in the upgrade
  // switch below; REST here).
  app.use('/api/computer', computerView.router);
  // Chat branching + bot roster import/export.
  // The title store is shared with message search so result snippets can
  // show thread titles.
  const threadTitles = new ThreadTitleStore(config.dataDir);
  app.use(
    '/api/chat/threads',
    createChatThreadsRouter({
      dataDir: config.dataDir,
      listThreads: (opts) => agentRuntime.sessionStore.listSessions(opts ?? {}),
      branchSession: (id, msgId, opts) => agentRuntime.branchSession(id, msgId, opts),
      listThreadMessages: (id) => agentRuntime.listThreadMessages(id),
      audit: (action, fields) => governance.audit(action, fields),
      titles: threadTitles,
    }),
  );
  // Full-text message search (OpenMausBot parity): FTS5 over chat sessions.
  app.use(
    '/api/search/messages',
    createMessageSearchRouter({
      searchMessages: (q, opts) => agentRuntime.sessionStore.searchMessages(q, opts),
      rebuildSearchIndex: () => agentRuntime.sessionStore.rebuildSearchIndex(),
      getThreadTitle: (id) => threadTitles.getTitle(id),
      audit: (action, fields) => governance.audit(action, fields),
    }),
  );
  // Workspace backup / restore / rollback (OpenMausBot parity P1 #19).
  // Secrets are never in a backup — the engine blocklists the vault,
  // wallet, provider keys, machine key, OAuth caches and any
  // token/secret/credential-looking filename.
  app.use(
    '/api/workspace',
    createWorkspaceBackupRouter({
      dataDir: config.dataDir,
      workspaceDir: config.workspaceDir,
      audit: (action, fields) => governance.audit(action, fields),
    }),
  );
  // Slack-style reply threads on chat messages (flat, one level).
  app.use(
    '/api/chat/:sessionId/message-threads',
    createMessageThreadsRouter({
      dataDir: config.dataDir,
      branchSession: (id, msgId, opts) => agentRuntime.branchSession(id, msgId, opts),
      listThreadMessages: (id) => agentRuntime.listThreadMessages(id),
      audit: (action, fields) => governance.audit(action, fields),
    }),
  );
  // Message reactions (Codync parity): emoji reactions on chat messages.
  const messageReactionStore = new MessageReactionStore(config.dataDir);
  app.use(
    '/api/chat/:sessionId/messages',
    createMessageReactionsRouter({
      store: messageReactionStore,
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
  // Group chats (multi-bot rooms): roster rows with room-turn orchestration.
  app.use(
    '/api/bots',
    createBotConversationsRouter({
      store: botConversationStore,
      getBots: () => seed.bots,
    }),
  );
  app.use(
    '/api/groups',
    createGroupChatsRouter({
      dataDir: config.dataDir,
      getBots: () => seed.bots,
      runMemberTurn: async (bot, prompt) => {
        let content = '';
        await agentRuntime.runTurn({
          bot,
          message: prompt,
          taskType: 'chat',
          // P1 #13: group member turns are bot-originated (their prompt
          // carries fenced peer content) — the consent rule applies, so
          // their tool approvals always go to the human.
          provenance: {
            origin: 'bot',
            originBotId: bot.id,
            originBotName: bot.name,
            relayPath: [bot.id],
            relayNames: [bot.name],
            timestamp: new Date().toISOString(),
          },
          onEvent: (e) => {
            if (e.type === 'token' && typeof e.content === 'string') content += e.content;
          },
        });
        return { text: content };
      },
      audit: (action, fields) => governance.audit(action, fields),
    }),
  );
  // Bot routines: management API + signed inbound webhook triggers.
  // (Stores are created once above and shared by both routers.)
  // Agent auto-detection (Codync parity: detected coding CLIs + install hints).
  app.use('/api/agents', createAgentDetectRouter());
  // In-app subscription sign-in for native CLI drivers (OpenMausBot parity):
  // start the CLI's OAuth login, capture the authorize URL, poll for completion.
  app.use('/api/cli-auth', createCliAuthRouter());
  // Opt-in product analytics (off by default; local-first privacy posture).
  app.use('/api/analytics', createAnalyticsRouter({ dataDir: config.dataDir }));
  // Managed local LLM (Atomic Agent parity): zero-config llama.cpp binary +
  // model management + local server lifecycle. Created once and shared with
  // the shutdown path below.
  const localLlm = new LocalLlmManager(config.dataDir);
  app.use('/api/local-llm', createLocalLlmRouter(localLlm));
  // Fusion mode (Atomic Agent parity): planner + parallel workers + fused
  // synthesis. Store created once; background runs are tracked in-memory.
  const fusionStore = new FusionRunStore(config.dataDir);
  app.use(
    '/api/fusion',
    createFusionRouter({
      store: fusionStore,
      getBot: (id) => seed.bots.find((b) => b.id === id),
      agentRuntime,
    }),
  );

  // Eval harnesses (Atomic Agent parity): rubric-scored test suites run the
  // bot in isolated sessions. Stores created once; background runs tracked
  // in-memory.
  const evalRunStore = new EvalRunStore(config.dataDir);
  const evalSuiteStore = new EvalSuiteStore(config.dataDir);
  app.use(
    '/api/evals',
    createEvalRouter({
      runStore: evalRunStore,
      suiteStore: evalSuiteStore,
      getBot: (id) => seed.bots.find((b) => b.id === id),
      agentRuntime,
      memoryStore: tieredMemoryStore,
    }),
  );

  // Self-update (Atomic Agent parity): check official GitHub releases, download
  // the platform installer with explicit consent, launch it. The manager's
  // auto-check timer uses unref() so it never keeps the process alive.
  const updater = new SelfUpdateManager({
    dataDir: config.dataDir,
    currentVersion: process.env.KRIYADOT_VERSION ?? '0.1.0',
  });
  app.use('/api/updates', createSelfUpdateRouter(updater));

  // Peer approval cards (OpenMausBot parity): per-action Allow / Deny /
  // Always-allow for bot→bot calls, 15-minute expiry, revokable per-pair
  // grants. Backstop sweep expires stale cards even when no waiter watches.
  app.use(
    '/api',
    createPeerApprovalRouter({
      store: peerApprovalStore,
      broker: peerApprovalBroker,
      audit: (action, fields) => governance.audit(action, fields),
      getBotName: (id) => botsById.get(id)?.name,
    }),
  );
  const peerApprovalSweep = setInterval(() => {
    try {
      const expired = peerApprovalStore.expireStale();
      for (const id of expired) {
        peerApprovalBroker.settle(id, 'expired');
        governance.audit('peer-approval.expired', { detail: { cardId: id } });
      }
    } catch {
      // Sweeps must never break the server.
    }
  }, 60_000);
  if (typeof peerApprovalSweep.unref === 'function') peerApprovalSweep.unref();

  // Interactive widgets (OpenMausBot parity P1 #15): answer inbox for
  // ask_user_question + display-widget listing. Backstop sweep expires
  // stale widgets even when no waiter watches.
  app.use(
    '/api',
    createWidgetRouter({
      store: widgetStore,
      coordinator: widgetCoordinator,
      audit: (action, fields) => governance.audit(action, fields),
    }),
  );

  // User skill lifecycle (OpenMausBot parity P1 #20): authoring, learning
  // proposals, review queue, enable/disable, scoping, per-bot attachment.
  {
    const { createSkillStoreRouter } = await import('./skill-store-routes.js');
    const { getBotSkills, setBotSkills } = await import('./bot-skills.js');
    const { SkillLoader } = await import('@mvp/agent-runtime');
    // Seed skill names for the read-only section of the skills UI.
    let seedSkillLoader: { list(): string[] } | undefined;
    try {
      seedSkillLoader = new SkillLoader(path.join(seedDir, 'skills'));
    } catch {
      seedSkillLoader = undefined;
    }
    app.use(
      '/api/skills',
      createSkillStoreRouter({
        store: userSkillStore,
        audit: (action, fields) => governance.audit(action, fields),
        getApprovalStatus: (id) => governance.getApproval(id)?.status,
        decideApproval: (id, decision) => governance.decide(id, decision),
        getBot: (id) => botsById.get(id),
        getBotSkills: (id) => getBotSkills(seed.bots, id),
        setBotSkills: (id, skills) => setBotSkills(config.dataDir, seed.bots, id, skills),
        seedSkillNames: () => seedSkillLoader?.list() ?? [],
      }),
    );
  }
  const widgetSweep = setInterval(() => {
    try {
      sweepWidgets(widgetCoordinator, (action, fields) => governance.audit(action, fields));
    } catch {
      // Sweeps must never break the server.
    }
  }, 60_000);
  if (typeof widgetSweep.unref === 'function') widgetSweep.unref();

  // Chief of Staff (OpenMausBot parity): chief assignment, managed
  // sections, team-setup proposals, incidents/escalations inbox. The store
  // instance comes from registerChiefToolsWiring above.
  app.use(
    '/api/teams',
    createChiefRouter({
      dataDir: config.dataDir,
      getBots: () => seed.bots,
      store: chiefWiring.store,
      retryDelegation: chiefWiring.retryDelegation,
      audit: (action, fields) => governance.audit(action, fields),
    }),
  );

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
  // Import from other AI agents (Atomic parity): skills/memory/sessions/bots.
  app.use(
    '/api/agent-import',
    createAgentImportRouter({
      dataDir: config.dataDir,
      getBots: () => seed.bots,
      tieredMemoryStore,
      sessionStore: agentRuntime.sessionStore,
      audit: (action, fields) => governance.audit(action, fields),
    }),
  );
  // Unknown /api paths → JSON 404 (before the SPA fallback claims them).
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Unknown API route' });
  });
  // Live runtime meter ("eyes for your AI"): human-readable, server-rendered,
  // dependency-free health page — queue depth, latencies, error rates,
  // per-bot activity. Mounted outside /api (it is not one of the app's nav
  // destinations) and before the SPA fallback so the path isn't claimed.
  // Counts and normalized names only — never secrets or message bodies.
  app.get('/_kriyadot/', (_req, res) => {
    try {
      res.type('html').send(
        renderKriyaDotMeter({
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
    // Public webhook delivery worker (Codync parity): drains the queued
    // routine-hook deliveries. Started after listen like the MCP warmup.
    hookDeliveryWorker.start();
    console.log('[routine-hooks] delivery worker started');
  });

  // Remote-phone control: WebSocket endpoint for live sessions at
  // /api/phone/ws (REST routes live under /api/phone via routes.ts).
  // Companion app: push channel at /api/companion/ws (REST under
  // /api/companion). Unknown upgrade paths are destroyed so nothing else
  // hijacks upgrades.
  server.on('upgrade', (req, socket, head) => {
    // Origin validation on every WS upgrade: browsers on evil origins always
    // send Origin; a non-allowlisted one destroys the socket before any
    // handshake. Non-browser clients (phones, TUI, curl) send no Origin and
    // proceed to the in-protocol auth of each endpoint.
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin.length > 0 && !isOriginAllowed(origin)) {
      socket.destroy();
      return;
    }
    const path = req.url?.split('?')[0];
    if (path === '/api/phone/ws') {
      phoneHub.handleUpgrade(req, socket, head);
    } else if (path === '/api/companion/ws') {
      companionHub.handleUpgrade(req, socket, head);
    } else if (path === '/api/computer/ws') {
      computerView.handleUpgrade(req, socket, head);
    } else if (path === '/api/remote-screen/ws') {
      remoteScreenUpgrade.handleUpgrade(req, socket, head);
    } else if (path === '/api/voice/calls/ws') {
      voiceCallUpgrade.handleUpgrade(req, socket, head);
    } else if (path === '/api/voice/realtime/ws') {
      realtimeVoiceUpgrade.handleUpgrade(req, socket, head);
    } else {
      socket.destroy();
    }
  });

  const shutdown = async () => {
    console.log('[api] shutting down…');
    server.close();
    scheduler.stop();
    hookDeliveryWorker.stop();
    await closeMcp();
    try {
      await lazyMcpManager.close();
    } catch {
      // ignore lazy MCP close errors on shutdown
    }
    try {
      // Tear down every per-bot computer instance (P1 #14).
      for (const bot of seed.bots) {
        await computerManager.removeBot(bot.id);
      }
    } catch {
      // ignore
    }
    try {
      // Close all VPS SSH connections (P1 #24).
      await vpsPool.closeAll();
    } catch {
      // ignore
    }
    try {
      await localLlm.stop();
    } catch {
      // ignore
    }
    try {
      agentRuntime.close();
    } catch {
      // ignore
    }
    try {
      remoteScreenService.close();
    } catch {
      // ignore
    }
    try {
      shutdownFusionRuns();
    } catch {
      // ignore
    }
    try {
      shutdownEvalRuns();
    } catch {
      // ignore
    }
    try {
      clearInterval(peerApprovalSweep);
    } catch {
      // ignore
    }
    try {
      clearInterval(widgetSweep);
    } catch {
      // ignore
    }
    try {
      peerApprovalStore.close();
    } catch {
      // ignore
    }
    try {
      widgetStore.close();
    } catch {
      // ignore
    }
    try {
      updater.stopAutoCheck();
    } catch {
      // ignore
    }
    try {
      routineScheduler.stop();
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
