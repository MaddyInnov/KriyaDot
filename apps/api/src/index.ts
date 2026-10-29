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
import {
  AgentRuntime,
  SpanStore,
  createEmbedderFromEnv,
  discoverLocalTools,
  parseModelProfiles,
  resolveBotWorkspaceDir,
} from '@mvp/agent-runtime';
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
import { PauseRegistry, pauseGate, registerSystemPauseRoutes } from './system-pause.js';
import { createHubPhoneActionDispatcher, phoneActionPolicyRules, registerPhoneActionTools } from './phone-actions.js';
import {
  NotificationStore,
  NotificationTriageService,
  createRoutingNotificationTriage,
  registerNotificationRoutes,
} from './notification-triage.js';
import { resolveGithubSignalsSource } from './briefing-signals.js';
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
import { LazyMcpManager, PerBotMcpManager } from '@mvp/agent-runtime';
import { createSelfUpdateRouter } from './self-update-routes.js';
import { IdleAutoUpdater, SelfUpdateManager } from '@mvp/agent-runtime';
import { createFusionRouter, shutdownFusionRuns } from './fusion-routes.js';
import { FusionRunStore } from './fusion.js';
import { createEvalRouter, shutdownEvalRuns } from './eval-routes.js';
import { EvalRunStore, EvalSuiteStore } from './evals.js';
import { createSummarizer } from './summarizer.js';
import { createPeerApprovalRouter, createPeerApprovalBroker } from './peer-approval-routes.js';
import { PeerApprovalStore, createPeerApprovalGate } from '@mvp/agent-runtime';
import { createCredentialProposalRouter } from './credential-proposal-routes.js';
import {
  CredentialProposalStore,
  createRequestCredentialTool,
  OnBehalfOfLedger,
} from '@mvp/agent-runtime';
import { createMemoryUpkeepRouter, startMemoryUpkeep, aboutMeContext } from './memory-upkeep-routes.js';
import {
  TurnTracker,
  OrphanLedger,
  reconcileOnBoot,
  INTERRUPTED_NOTE,
} from './crash-recovery.js';
import { createSentinelRouter, startSentinel } from './sentinel.js';
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
import { ReactionAnswerService, SignInRequestStore } from './chat-ux.js';
import { CliAuthManager, type CliAuthId } from '@mvp/agent-runtime';
import { buildVoiceProviders } from './voice-call.js';
import {
  ChatterboxTTSProvider,
  ElevenLabsTTSProvider,
  FishTTSProvider,
  MockTTSProvider,
  SystemTTSProvider,
} from '@mvp/voice';
import { MessageReactionStore } from './message-reactions.js';
import { createAcpSessionsRouter } from './acp-sessions-routes.js';
import { installedEnginePath } from './engine-installs.js';
import { AcpSessionManager, AcpSessionStore } from '@mvp/agent-runtime';
import { createGroupChatsRouter } from './group-chats-routes.js';
import { PeopleStore, TeamInboxStore, createRelayToPersonTool } from '@mvp/agent-runtime';
import {
  applyBotOwners,
  createPeopleService,
  resolveExplicitPersonContext,
  resolvePersonContext,
} from './people.js';
import { createPeopleRouter } from './people-routes.js';
import { appendRosterImport, applyImportedBots, createBotRosterRouter } from './bot-roster-routes.js';
import { createBotSetupRouter } from './bot-setup-routes.js';
import { registerRoutineRoutes } from './bot-routines.js';
import { createRoutineWebhookRouter } from './webhooks.js';
import { RoutineHookStore, WebhookDeliveryWorker, createPublicHookRouter } from './routine-hooks.js';
import { createWorkflowN8nRouter } from './workflow-n8n.js';
import {
  interconnectionPolicyRules,
  registerInterconnectionTools,
} from './interconnect-tools.js';
import { publishPagePolicyRules, registerPublishTools } from './publish-tools.js';
import { registerPublicPageServing } from './public-pages.js';
import { registerWorktreeRoutes } from './worktrees-routes.js';
import { createWorktreeTools } from '@mvp/agent-runtime/dist/worktrees.js';
import { HookBus, loadPlugins } from '@mvp/agent-runtime/dist/hooks.js';
import { runAcpCli, runChatCli, runScanCli } from './cli.js';
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
// Sign-in code tool (W4b): enter_sign_in_code reads a fresh one-time code
// from the user's connected Gmail (Composio path) AFTER approval and types
// it into the bot's browser. The code value never reaches the model, a
// tool result, or an audit entry.
import { registerSignInCodeTools, signInCodePolicyRules } from './sign-in-code-tools.js';
// Approval-gated purchasing (W6): request_purchase tool + policy (always
// require-approval), purchase intent service with Stripe Link / browser
// executors, and the billing-area purchases routes (mounted via routes.ts).
import { createPurchaseWiring, purchasePolicyRules, registerPurchaseTools } from './purchases.js';
import { createMcpManageTool } from './mcp-manage-tool.js';
import { createScheduleTools } from './schedule-tools.js';
import { CostTracker, SpendCapStore } from '@mvp/billing';

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

// ACP server mode: `mvp-server acp --bot <id>` serves the bot as an ACP
// agent over stdio (Octomind parity). Parsed before boot() like chat —
// stdout is the protocol channel, so the HTTP server never starts.
if (process.argv[2] === 'acp') {
  const code = await runAcpCli(process.argv.slice(2));
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
  const { applyBotPersonas, applyBotAvatars } = await import('./bot-personas.js');
  applyBotPersonas(seed.bots, config.dataDir);
  // Bot avatars (chat polish): per-bot overlay from <dataDir>/bot-avatars.json.
  applyBotAvatars(seed.bots, config.dataDir);
  // Durable seed-bot deletion: ids recorded by the roster DELETE route in
  // <dataDir>/deleted-bots.json are filtered out of the seed roster at boot
  // (the seed file itself is read-only). The roster router appends through
  // recordDeletedBotId below.
  const deletedBotsFile = path.join(config.dataDir, 'deleted-bots.json');
  const readDeletedBotIds = (): string[] => {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(deletedBotsFile, 'utf8'));
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  };
  const recordDeletedBotId = (botId: string): void => {
    try {
      const ids = readDeletedBotIds();
      if (!ids.includes(botId)) {
        ids.push(botId);
        fs.writeFileSync(deletedBotsFile, JSON.stringify(ids, null, 2), 'utf8');
      }
    } catch {
      // Best-effort durability; the in-memory deletion already happened.
    }
  };
  {
    const deleted = new Set(readDeletedBotIds());
    if (deleted.size > 0) {
      for (let i = seed.bots.length - 1; i >= 0; i--) {
        if (deleted.has(seed.bots[i].id)) seed.bots.splice(i, 1);
      }
    }
  }
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
    rules: [...publishPagePolicyRules(), ...interconnectionPolicyRules(), ...computerUsePolicyRules(), ...museModuleToolPolicies(), ...composioToolPolicies(), ...signInCodePolicyRules(), ...purchasePolicyRules(), ...phoneActionPolicyRules(), ...DEFAULT_POLICY.rules],
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

  // Global pause (W14d): one persisted registry checked by chat, the
  // schedulers/pollers and the phone-action tools.
  const pauseRegistry = new PauseRegistry(config.dataDir);
  const isPaused = pauseGate(pauseRegistry);
  if (pauseRegistry.isPaused()) {
    console.log('[system] KriyaDot is PAUSED (persisted) — new work is on hold until resumed');
  }

  // Notification triage (W14b): phone notifications stream into this
  // store/service via the phone hub. The push dependency is attached
  // after the PushService exists (below) through notificationPushHolder.
  const notificationStore = new NotificationStore(config.dataDir);
  const notificationPushHolder: { svc?: import('./push.js').PushService } = {};
  const notificationService = new NotificationTriageService({
    store: notificationStore,
    triage: createRoutingNotificationTriage(),
    push: {
      notify: (req) =>
        notificationPushHolder.svc
          ? notificationPushHolder.svc.notify(req)
          : Promise.resolve({ attempted: 0, sent: 0 }),
    },
    audit: (action, fields) => governance.audit(action, fields),
  });
  phoneHub.setNotificationHandler((deviceId, n) => {
    void notificationService.ingest({ deviceId, ...n }).catch(() => {});
  });

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
    // W4: per-bot persistent browser profiles live under
    // <dataDir>/browser-profiles/<botId>/; wipes are audited (metadata only).
    dataDir: config.dataDir,
    onProfileWipe: (result) => {
      try {
        governance.audit('computer.browser_profile_wiped', {
          actor: 'user',
          toolName: 'computer',
          detail: { botId: result.botId, wiped: result.wiped, bytesFreed: result.bytesFreed },
        });
      } catch {
        // Audit must never break the wipe.
      }
    },
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

  // Approval-gated purchasing (W6): the purchase service owns intents,
  // hard blocks, spend-cap gating and execution. Its CostTracker /
  // SpendCapStore are separate connections onto the same billing.db the
  // billing routes use (WAL — the same multi-connection pattern as the
  // meter/ledger instances in routes.ts). Executors drive the calling
  // bot's own computer/browser surface; the Stripe Link reference stays
  // in the vault and never reaches bot context.
  const purchaseWiring = createPurchaseWiring({
    dataDir: config.dataDir,
    governance,
    costTracker: new CostTracker(path.join(config.dataDir, 'billing.db')),
    spendCaps: new SpendCapStore(path.join(config.dataDir, 'billing.db')),
    resolveOS: (botId: string) =>
      computerManager.getLayer(botId, { surface: botsById.get(botId)?.computerSurface }),
  });

  // Purpose-based model profiles (Octomind parity): optional
  // <dataDir>/model-profiles.json maps purposes (main / supervisor /
  // compression / reviewer / evaluate / …) to provider+model+knobs.
  // Absent or invalid → empty table; every consumer falls back to its
  // historical default. Loaded once at boot.
  const modelProfiles = (() => {
    try {
      return parseModelProfiles(fs.readFileSync(path.join(config.dataDir, 'model-profiles.json'), 'utf8'));
    } catch {
      return {};
    }
  })();

  // Per-bot workspace resolution shared by the runtime (project
  // instructions, validators) and governance (repo-local policy file).
  const workspaceDirForBotConfig = (bot: BotConfig): string =>
    resolveBotWorkspaceDir({
      botWorkspace: bot.workspace,
      globalWorkspaceDir: config.workspaceDir,
      dataDir: config.dataDir,
    });

  // Hindsight sink holder: the tiered memory store is constructed later
  // in this function; the runtime's retrospective sink writes through
  // this holder once it is filled (lessons before that are dropped —
  // hindsight is best-effort by design).
  const memorySinkHolder: {
    storeLesson?: (botId: string, lesson: string, sessionId: string) => void;
  } = {};

  const governanceAdapter = new GovernanceAdapter(governance, {
    getBotConfig: (id) => botsById.get(id),
    globalPolicy,
    getPreference: (botId, toolName) => preferenceStore.getPreference(botId, toolName)?.preference,
    // Guardrails as code: repo-local .kriyadot/policy.json per bot workspace.
    workspaceDirForBot: (botId) => {
      const bot = botsById.get(botId);
      return bot ? workspaceDirForBotConfig(bot) : undefined;
    },
    // W6: when evaluation mints the request_purchase approval, register
    // the pending purchase intent against it (one card per purchase).
    approvalObserver: purchaseWiring.onApprovalMinted,
  });

  const { registry: toolRegistry, connections: mcpConnections, mcpClientsByServer, userSkillStore, connectMcp, close: closeMcp } =
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
  // Per-bot private MCP servers (W9): a bot's OWN servers — separate
  // processes per bot, visible only to that bot, torn down on bot delete.
  // They are NOT synced into the shared registry; the runtime pulls them
  // per turn via extraToolsForBot (see AgentRuntime construction below).
  const perBotMcpManager = new PerBotMcpManager({
    dataDir: config.dataDir,
    pinDbPath: path.join(config.dataDir, 'mcp-pins.db'),
  });
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
  // Sign-in codes (W4b): enter_sign_in_code — approval-gated via
  // signInCodePolicyRules above (the approval card shows site + source;
  // no code exists until the handler runs). The handler searches the
  // user's connected Gmail through the same Composio path (key resolved
  // server-side, per-bot Gmail enablement enforced) and types the code
  // into the calling bot's own computer surface. Code values are never
  // returned, logged, or audited.
  registerSignInCodeTools({
    registry: toolRegistry,
    dataDir: config.dataDir,
    getApiKey: (userId: string) => {
      try {
        return new SecureVault(config.dataDir, userId, 'composio-tool').get(COMPOSIO_KEY_NAME)?.value;
      } catch {
        return undefined;
      }
    },
    resolveUserId: () => 'default-user',
    resolveOS: resolveBotComputerOS,
    audit: (action, fields) => governance.audit(action, fields),
  });
  // Phone-app operation (W14a): phone_* tools dispatch approved actions
  // to the paired phone over the phone hub and await its ack. Governance
  // forces require-approval (phoneActionPolicyRules above); the global
  // pause gate refuses dispatch while paused.
  {
    const { dispatcher, resolveDeviceId } = createHubPhoneActionDispatcher(phoneHub, phoneStore);
    registerPhoneActionTools(toolRegistry, {
      dispatcher,
      resolveDeviceId,
      audit: (action, fields) => governance.audit(action, fields),
      isPaused,
    });
  }
  // Approval-gated purchasing (W6): request_purchase — require-approval
  // ALWAYS via purchasePolicyRules above. The handler only records /
  // claims the purchase intent; execution runs solely after the human
  // approves the intent's card (see purchases.ts safety contract).
  registerPurchaseTools({ registry: toolRegistry, service: purchaseWiring.service });
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

  // Profile/credential proposal cards (OpenMausBot parity): the
  // `request_credential` agent tool mints a card here instead of failing
  // when a bot needs a credential it doesn't have. The user fulfills it in
  // the approvals inbox; the value lands in the vault; the turn resumes.
  const credentialProposalStore = new CredentialProposalStore(config.dataDir);
  toolRegistry.set('request_credential', createRequestCredentialTool());

  // W13 observability: one shared span/trace store (<dataDir>/spans.db).
  // The runtime auto-instruments provider + tool choke points into it;
  // the observability routes serve the same store to Activity → Runs.
  const spanStore = new SpanStore(`${config.dataDir}/spans.db`);

  // One platform embedder (Octomind parity): neural when EMBEDDING_MODEL
  // is configured, trigram offline fallback otherwise. Shared by the
  // runtime (semantic discovery) and the memory store (recall re-rank).
  const platformEmbedder = createEmbedderFromEnv();

  const agentRuntime = new AgentRuntime({
    dbPath: `${config.dataDir}/agent.db`,
    spanStore,
    skillsDir: path.join(seedDir, 'skills'),
    additionalSkillsDirs: [path.join(config.dataDir, 'skills')],
    // OpenMausBot parity P1 #20: disabled-by-default skill gate. Seed and
    // imported skills are unaffected; user-managed skills must be active
    // and in scope for the bot.
    skillUsabilityGate: (name, botId) =>
      userSkillStore.isUserSkill(name) ? userSkillStore.isUsable(name, botId) : true,
    peerApprovalGate,
    // W9: per-bot private MCP tools, scoped strictly to the owning bot.
    // Octomind parity: local project tools from the bot workspace's
    // .kriyadot/tools/ directory ride along (auto-registered per turn).
    extraToolsForBot: (botId) => {
      const bot = botsById.get(botId);
      const local = bot ? discoverLocalTools(workspaceDirForBotConfig(bot)).tools : [];
      return [...perBotMcpManager.toolDefinitions(botId), ...local];
    },
    governance: governanceAdapter,
    toolRegistry,
    hooks: hookBus,
    // Octomind parity wiring: per-bot workspace (project instructions +
    // turn-end validators), purpose-based model profiles, the platform
    // embedder (neural when configured, trigram offline fallback), and
    // the hindsight lesson sink into tiered memory.
    workspaceDirForBot: workspaceDirForBotConfig,
    modelProfiles,
    embedder: platformEmbedder,
    // Background specialist runs: roster lookup for delegate_background.
    resolveBot: (id) => botsById.get(id),
    retrospectiveSink: (info) => {
      memorySinkHolder.storeLesson?.(info.botId, info.lesson, info.sessionId);
    },
    // Phase 2: summarization auto-compaction replaces blind truncation once
    // sessions grow past the threshold; the last-100-messages floor stays.
    // Octomind parity: adaptive (token-computed) fold depth + background
    // folds; folded ranges are archived losslessly for the recall tool.
    sessionStoreOptions: {
      summarizer: createSummarizer(undefined, modelProfiles),
      adaptiveCompaction: true,
      backgroundCompaction: true,
    },
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

  // Lossless-compaction recall tool (Octomind parity): bots dereference
  // compaction archive ids from summary headers back to the original
  // messages. Registered after the runtime exists (it binds its store);
  // the registry Map is shared by reference, so the runtime sees it.
  for (const tool of agentRuntime.createRecallTools()) {
    toolRegistry.set(tool.name, tool);
  }
  // Background delegation tools (delegate_background / list / stop).
  for (const tool of agentRuntime.createBackgroundTools()) {
    toolRegistry.set(tool.name, tool);
  }
  // MCP management tool (Octomind parity): health/restart from inside a task.
  {
    const mcpManage = createMcpManageTool(lazyMcpManager);
    toolRegistry.set(mcpManage.name, mcpManage);
  }

  // Credential proposal host: the `request_credential` tool mints a card and
  // pauses the turn until the user fulfills/denies it in the approvals
  // inbox (the fulfill API writes the value to the vault, then releases the
  // waiter here).
  agentRuntime.setCredentialProposer({
    requestCredential: async (input) => {
      const card = credentialProposalStore.propose(input);
      const ok = await credentialProposalStore.awaitDecision(card.id);
      return ok ? { ok: true } : { ok: false, reason: 'The user did not provide the credential (denied or expired).' };
    },
  });

  // About-me context: the user's own profile rides into every bot turn.
  agentRuntime.addContextProvider(({ bot }) => aboutMeContext(config.dataDir, bot.id));

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

  // Multiplayer layer (W7): people directory + team inbox + human relay.
  // The default person ("You") is auto-seeded; persisted bot owners are
  // applied onto the roster. The push service is created later in boot,
  // so the service reaches it through a late-bound holder.
  applyBotOwners(seed.bots, config.dataDir);
  const peopleStore = new PeopleStore(config.dataDir);
  const teamInboxStore = new TeamInboxStore(config.dataDir);
  const peoplePushHolder: { svc?: import('./push.js').PushService } = {};
  const peopleService = createPeopleService({
    dataDir: config.dataDir,
    people: peopleStore,
    inbox: teamInboxStore,
    getBots: () => seed.bots,
    governance,
    ledger: new OnBehalfOfLedger(config.dataDir),
    getRuntime: () => ({
      runTurn: (opts) => agentRuntime.runTurn(opts as never),
      sessionStore: agentRuntime.sessionStore,
    }),
    getPush: () =>
      peoplePushHolder.svc
        ? {
            notify: async (req) => {
              await peoplePushHolder.svc!.notify({
                kind: req.kind,
                botId: req.botId,
                botName: req.botName,
                title: req.title,
                body: req.body,
              });
            },
          }
        : undefined,
  });
  // relay_to_person agent tool (approval-governed: no allow rule in the
  // default policy, so every relay needs a human approval first).
  const relayTool = createRelayToPersonTool({ people: peopleStore, relayService: peopleService.relayService });
  toolRegistry.set(relayTool.name, relayTool);

  // ── OMB+Octop parity build (2026-10-29): tool registrations ─────────────
  // Representative assistant (OMB §1.2): a person's Chief answers teammates'
  // factual questions under the person's own policy. One service instance
  // backs both the HTTP routes (mounted below) and the Chief tool.
  const { RepresentativeService, RepresentativeStore, createAnswerForPersonTool, botOwnerPersonId } =
    await import('@mvp/agent-runtime');
  const { PageStore } = await import('./pages.js');
  const { sharedNotesFromPages, botActivityFromTurnState } = await import('./representative-routes.js');
  const representativeStore = new RepresentativeStore(config.dataDir);
  const representativePageStore = new PageStore(config.dataDir);
  const representativeService = new RepresentativeService({
    people: peopleStore,
    store: representativeStore,
    inbox: teamInboxStore,
    getBots: () => seed.bots,
    getBotActivity: (botId) => {
      const bot = botsById.get(botId);
      if (!bot) return undefined;
      const facts = botActivityFromTurnState(agentRuntime.turnStates, seed.bots, botOwnerPersonId(bot));
      return facts.find((f) => f.botId === botId);
    },
    getSharedNotes: (personId) => {
      const person = peopleStore.getPerson(personId);
      return person ? sharedNotesFromPages(representativePageStore, person) : [];
    },
    audit: (action, fields) => governance.audit(action, fields),
  });
  {
    const answerTool = createAnswerForPersonTool({ people: peopleStore, representative: representativeService });
    toolRegistry.set(answerTool.name, answerTool);
  }
  // Managed knowledge bases (Octop §2.13): one KbStore backs the agent
  // tools here and the /api/kb routes mounted below.
  const { KbStore } = await import('./kb.js');
  const { createKbTools } = await import('./kb-tools.js');
  const kbStore = new KbStore(config.dataDir);
  for (const tool of createKbTools(kbStore)) {
    if (!toolRegistry.has(tool.name)) toolRegistry.set(tool.name, tool);
  }
  // Typed extraction (OMB §1.1): extract_values runs on the extraction
  // purpose profile via a host provider for the first bot's provider id.
  {
    const { createProvider, createExtractTools } = await import('@mvp/agent-runtime');
    const hostProviderId = seed.bots[0]?.provider ?? 'groq';
    try {
      for (const tool of createExtractTools({ provider: createProvider(hostProviderId) })) {
        toolRegistry.set(tool.name, tool);
      }
    } catch (err) {
      console.warn(`[tools] extract_values unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // Plugin system (Octop §2.4): third-party plugins (tool/skill/hook/UI/
  // channel kinds). Installs are deny-by-default: the approve hook mints a
  // governance approval and only an explicit human approval installs.
  const { PluginManager } = await import('@mvp/plugins');
  const { buildPluginTools, registerPluginHooks, registerPluginChannels } = await import('./plugin-routes.js');
  const pluginManager = new PluginManager({
    dataDir: config.dataDir,
    approveInstall: async (manifest, source) => {
      try {
        const approvalId = governance.requestApproval(
          'plugin_install',
          { plugin: manifest.name, version: manifest.version, kinds: manifest.kinds, source },
          { botId: 'system', sessionId: 'plugin-install', actor: 'user' },
        );
        const decision = await governance.awaitDecision(approvalId, 180_000);
        return decision === 'approved';
      } catch {
        return false;
      }
    },
  });
  await pluginManager.loadAll();
  for (const tool of await buildPluginTools(pluginManager)) {
    if (!toolRegistry.has(tool.name)) toolRegistry.set(tool.name, tool);
  }
  registerPluginHooks(pluginManager, hookBus);
  registerPluginChannels(pluginManager);
  // Connector + social tools (OMB §1.20 / Octop §2.x mop-up): X, Postiz,
  // Whop, HighLevel, OpenAlex/TickTick/Obsidian/Dify. All credential-gated
  // at call time (vault/env), deny-by-default under governance like every
  // registry tool.
  {
    const { registerXTools } = await import('./x-tools.js');
    const { registerPostizTools } = await import('./postiz-tools.js');
    const { registerWhopTools } = await import('./whop-tools.js');
    const { createHighLevelTools } = await import('./highlevel-tools.js');
    const { createConnectorTools } = await import('./connector-tools.js');
    registerXTools(toolRegistry);
    registerPostizTools(toolRegistry);
    registerWhopTools(toolRegistry);
    for (const tool of [...createHighLevelTools(), ...createConnectorTools()]) {
      if (!toolRegistry.has(tool.name)) toolRegistry.set(tool.name, tool);
    }
  }
  // MQTT channel (Octop §2.x): env-configured messaging provider; inert
  // unless MQTT_BROKER_URL is set (checked inside resolveMqttConfig).
  {
    const { registerMqttChannel } = await import('./mqtt-channel.js');
    registerMqttChannel();
  }
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

  // Public page publishing (W3): publish_page / unpublish_page /
  // page_publication_status agent tools (publish/unpublish require approval
  // via publishPagePolicyRules above).
  registerPublishTools({ registry: toolRegistry, dataDir: config.dataDir });

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
  // handled by the crash-recovery sweep below (reconcileOnBoot), which marks
  // them failed AND files orphan entries for one-click retry. The sweep
  // runs after governance/audit exist — see the "Automatic crash recovery"
  // block further down.
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
  // Limit-reset arming (W1): mutable holder filled once the scheduler
  // exists (below); the executor calls it when a run is limit-blocked.
  const limitResetHooks: {
    arm?: (args: { routine: import('./bot-routines.js').BotRoutine; error: unknown }) => void;
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
    onLimitBlocked: (args) => limitResetHooks.arm?.(args),
  });
  // Limit-reset resumes (W1): durable pending resumes for limit-blocked
  // routines, fired by the RoutineScheduler at the provider's reset time.
  const { LimitResetResumeStore } = await import('./limit-reset-resumes.js');
  const limitResetResumeStore = new LimitResetResumeStore(config.dataDir);
  // Connected-app event triggers (W2): durable poll cursors/seen-sets for
  // `event` routine schedules. The poller itself is started below, once
  // the routine store exists.
  const { EventTriggerStore } = await import('./routine-events.js');
  const routineEventStore = new EventTriggerStore(config.dataDir);
  const { routineStore, triggerStore: routineTriggerStore } = registerRoutineRoutes(
    routinesRouter,
    {
      dataDir: config.dataDir,
      getBots: () => seed.bots,
      hookStore: routineHookStore,
      getBaseUrls: () => ({ publicBaseUrl: config.publicBaseUrl, localPort: config.port }),
      runStore: routineRunStore,
      resumeStore: limitResetResumeStore,
      eventStore: routineEventStore,
    },
  );
  const routineWebhookRouter = createRoutineWebhookRouter({
    routineStore,
    triggerStore: routineTriggerStore,
    agentRuntime,
    getBots: () => seed.bots,
    runExecutor: routineRunExecutor,
  });
  // In-session schedule/monitor tools (Octomind parity): bots create
  // their own routines mid-conversation on this same store. The shared
  // registry Map means late registration is fine.
  for (const tool of createScheduleTools(routineStore)) {
    toolRegistry.set(tool.name, tool);
  }
  // Trigger tools from chat (OMB §1.1): create/list/delete routine triggers
  // over the same store as the schedule tools.
  {
    const { createTriggerTools } = await import('./trigger-tools.js');
    for (const tool of createTriggerTools(routineStore)) {
      if (!toolRegistry.has(tool.name)) toolRegistry.set(tool.name, tool);
    }
  }
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
    resumeStore: limitResetResumeStore,
    agentRuntime,
    getBots: () => seed.bots,
    renderPrompt: renderRoutinePrompt,
    onScheduleAutoPaused: (routine, streak) => notifyRoutinePaused?.(routine, streak),
    isPaused,
    // Idle triggers (Octomind parity): last message activity per bot
    // from the runtime's session store.
    lastBotActivityAt: (botId) => agentRuntime.lastBotActivityAt(botId),
    onLimitResetResume: (resume, routine) => {
      try {
        createTask({
          title: `Routine resumed after provider limit reset: ${routine.name}`,
          notes: `Limit-reset resume ${resume.id} fired for routine ${routine.id} (provider ${resume.providerId} reset at ${new Date(resume.resumeAt).toISOString()}).`,
          dueAt: null,
        });
        governance.audit('routine.limit_reset_resumed', {
          actor: 'system',
          sessionId: resume.id,
          detail: { routineId: routine.id, providerId: resume.providerId, resumeAt: resume.resumeAt },
        });
      } catch (err) {
        console.error('[routines] failed to record limit-reset resume:', err instanceof Error ? err.message : err);
      }
    },
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
  // Arm limit-reset resumes when a limit-blocked run settles: only
  // routines that opted in with a 'limit-reset' schedule auto-resume.
  limitResetHooks.arm = ({ routine, error }) => {
    if (routine.schedule?.kind !== 'limit-reset') return;
    try {
      const resume = routineScheduler.armLimitResetResume(routine, error);
      governance.audit('routine.limit_reset_armed', {
        actor: 'system',
        sessionId: resume.id,
        detail: { routineId: routine.id, providerId: resume.providerId, resumeAt: resume.resumeAt },
      });
    } catch (err) {
      console.error('[routines] failed to arm limit-reset resume:', err instanceof Error ? err.message : err);
    }
  };
  // Limit-reset resumes (W1): crash-orphaned resumes return to pending;
  // due ones fire on the scheduler's first tick.
  const limitResumes = routineScheduler.reconcileLimitResetResumes();
  if (limitResumes.recovered > 0 || limitResumes.due > 0) {
    console.log(
      `[routines] limit-reset resumes reconciled: ${limitResumes.recovered} recovered, ${limitResumes.due} due`,
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

  // Connected-app event triggers (W2): poll connected Composio apps for
  // routines with an `event` schedule and fire them through the same run
  // executor/history as every other trigger. Polling reuses the
  // server-side Composio execution path (vault key → account resolution →
  // per-bot enable gate → executeTool); cursors persist in
  // routine-event-triggers.db so items fire at most once across restarts,
  // and the first poll after boot catch-up-fires a bounded set of items
  // missed while down.
  const { EventTriggerPoller, createComposioEventExecutor } = await import('./routine-events.js');
  const eventTriggerPoller = new EventTriggerPoller({
    routineStore,
    eventStore: routineEventStore,
    executor: createComposioEventExecutor({ dataDir: config.dataDir }),
    runExecutor: routineRunExecutor,
    runStore: routineRunStore,
    agentRuntime,
    getBots: () => seed.bots,
    renderPrompt: renderRoutinePrompt,
    isPaused,
    onFire: (routine, result) => {
      try {
        governance.audit('routine.event_fired', {
          actor: 'system',
          detail: {
            routineId: routine.id,
            app: routine.schedule?.kind === 'event' ? routine.schedule.app : undefined,
            firedRuns: result.firedRunIds.length,
            skippedCatchUp: result.skippedCatchUp,
          },
        });
      } catch (err) {
        console.error('[routines] failed to audit event fire:', err instanceof Error ? err.message : err);
      }
    },
  });
  const eventReconcile = eventTriggerPoller.reconcileOnBoot();
  if (eventReconcile.cursors > 0) {
    console.log(`[routines] event triggers reconciled: ${eventReconcile.cursors} cursor(s) restored`);
  }
  eventTriggerPoller.start();

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
    // W14c GitHub signals (null when GitHub/repos are not configured —
    // the brief then simply has no Signals section) + W14b digest.
    signalsSource:
      resolveGithubSignalsSource({
        dataDir: config.dataDir,
        executor: createComposioEventExecutor({ dataDir: config.dataDir }),
      }) ?? undefined,
    notificationDigest: (since, now) => notificationStore.digestItems(since, now),
    isPaused,
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
  // Subpath serving (Octop §2.x deployment polish): when KRIYADOT_BASE_PATH
  // is set, the whole app is served under that prefix; the middleware
  // strips it before auth/routing so everything below sees normal paths.
  {
    const { createBasePathMiddleware, basePathFromEnv } = await import('./base-path.js');
    const basePath = basePathFromEnv();
    if (basePath) {
      app.use(createBasePathMiddleware(basePath));
      console.log(`[api] serving under base path ${basePath}`);
    }
  }
  app.use(cors({ origin: corsOriginFn }));
  app.use(requireLoopbackAuth(loopbackToken));
  // Token bootstrap for the browser UI (and other browser clients): returns
  // the token only when the Origin header is absent or allowlisted, so an
  // evil cross-origin page can never read it.
  app.get('/api/auth/bootstrap', createBootstrapHandler(loopbackToken));
  // L8: the global JSON body limit is 5mb — the old 150mb global limit let
  // EVERY route accept a 150MB body. The chat-attachment upload
  // (POST /api/files/upload, up to 100MB base64) is the only route that
  // needs more, so it gets its own larger parser mounted here BEFORE the
  // global one. body-parser sets req._body after parsing, so the global
  // parser skips requests the upload parser already handled.
  app.use('/api/files/upload', express.json({ limit: '150mb' }));
  app.use(express.json({ limit: '5mb' }));
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
  const tieredMemoryStore = new TieredMemoryStoreCtor(config.dataDir, {
    embedder: platformEmbedder,
    neuralEmbedder: platformEmbedder,
  });
  // Hindsight (Octomind parity): runtime retrospective lessons land as
  // memory atoms (deduped by the store; category inferred).
  memorySinkHolder.storeLesson = (botId, lesson, sessionId) => {
    try {
      tieredMemoryStore.storeAtom(botId, { fact: lesson, entities: [], confidence: 0.6 }, sessionId);
    } catch {
      // Hindsight is best-effort — a memory write must never break a turn.
    }
  };
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
        memoryContext = await tieredMemoryStore.recallForPromptNeural(bot.id, message) || undefined;
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
        memoryContext = await tieredMemoryStore.recallForPromptNeural(bot.id, message) || undefined;
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
  notificationPushHolder.svc = pushService;
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
  // Automatic crash recovery (OpenMausBot parity): boot-time reconciliation
  // sweep. In-flight records orphaned by the restart (routine runs, team
  // runs, group goals, chat turns) are marked `interrupted (server
  // restart)` and filed as orphan entries for one-click resume via
  // GET /api/recovery/orphans. Idempotent — only non-terminal records match.
  const turnTracker = new TurnTracker(config.dataDir);
  {
    const { TeamStore } = await import('@mvp/agent-runtime');
    const { GroupGoalStore } = await import('./group-goals.js');
    const teamStore = new TeamStore(config.dataDir);
    const groupGoalStore = new GroupGoalStore(config.dataDir);
    try {
      const summary = reconcileOnBoot({
        dataDir: config.dataDir,
        listStuckRoutineRuns: () =>
          routineRunStore.listStuckRuns().map((r) => ({ id: r.id, routineId: r.routineId, routineName: r.routineName })),
        reconcileRoutineRuns: () => routineRunStore.reconcileRunning(),
        listRunningTeamRuns: () => {
          const out: Array<{ runId: string; teamId: string; teamName: string; task: string }> = [];
          for (const t of teamStore.listTeams()) {
            for (const r of teamStore.listRuns(t.id)) {
              if (r.status === 'running') out.push({ runId: r.id, teamId: t.id, teamName: t.name, task: r.task });
            }
          }
          return out;
        },
        markTeamRunInterrupted: (runId) => {
          teamStore.updateRun(runId, { status: 'failed', error: INTERRUPTED_NOTE });
        },
        listRunningGroupGoals: () =>
          groupGoalStore
            .listGoals(1000)
            .filter((g) => g.status === 'running')
            .map((g) => ({ goalId: g.id, title: g.title })),
        markGroupGoalInterrupted: (goalId) => {
          // Park as blocked so the existing POST /:id/resume restarts it.
          groupGoalStore.updateGoal(goalId, {
            status: 'blocked',
            summary: `Interrupted: ${INTERRUPTED_NOTE}. Resume to continue.`,
          });
        },
        turnTracker,
        audit: (action, fields) => governance.audit(action, fields),
      });
      if (summary.orphans.length > 0) {
        console.log(`[recovery] reconciled ${summary.orphans.length} interrupted item(s): ${JSON.stringify(summary.counts)}`);
      }
    } finally {
      teamStore.close();
      groupGoalStore.close();
    }
  }

  // Memory upkeep schedulers (OpenMausBot parity): idle-time background
  // capture + nightly tidy. isIdle keeps capture off hot paths.
  const isIdle = (): boolean => turnTracker.listActive().length === 0;
  const memoryUpkeep = startMemoryUpkeep({
    dataDir: config.dataDir,
    tieredMemoryStore,
    getBots: () => seed.bots.map((b) => ({ id: b.id })),
    isIdle,
    audit: (action, fields) => governance.audit(action, fields),
  });
  void memoryUpkeep;

  // Sentinel health scanner (OpenMausBot parity): cheap scheduled
  // self-check; report at GET /api/health/detail.
  const sentinel = startSentinel({
    dataDir: config.dataDir,
    getBots: () => seed.bots.map((b) => ({ id: b.id, provider: b.provider })),
    audit: (action, fields) => governance.audit(action, fields),
  });
  void sentinel;

  // Chat UX pack (W8): pending sign-in requests settled by "done"
  // (chat route), and reactions-as-answers (reactions router below).
  // Reaction decisions go through the SAME paths as clicking a card:
  // governance.decide() on the real approval record (adapter id
  // resolution + preference learning, mirroring POST /api/approvals)
  // and WidgetCoordinator.settle() for question widgets.
  const chatUxSignInStore = new SignInRequestStore();
  const chatUxCliAuth = new CliAuthManager();
  const reactionAnswerService = new ReactionAnswerService({
    getApprovalStatus: (id) => governance.getApproval(governanceAdapter.resolveApprovalId(id))?.status,
    decideApproval: (id, decision, opts) => {
      const realId = governanceAdapter.resolveApprovalId(id);
      const existing = governance.getApproval(realId);
      governance.decide(realId, decision, { note: opts?.note });
      if (existing) {
        try {
          preferenceStore.recordDecision(existing.botId, existing.toolName, decision);
        } catch {
          // Preference learning must never break a decision.
        }
      }
    },
    getWidget: (id) => {
      const w = widgetStore.get(id);
      return w ? { status: w.status, kind: w.kind, interactive: w.interactive } : undefined;
    },
    settleWidget: (id, value) => {
      widgetCoordinator.settle(id, { answered: true, value });
    },
    audit: (action, fields) => governance.audit(action, fields),
  });

  // Nightly dreaming (OMB §1.1): a cheap-model pass over each bot's recent
  // memory episodes proposes ideas that surface in the morning briefing.
  // Host timer: an hourly check fires the dreamer once per day after
  // 03:00 local. Dreams land in DreamStore; the briefing reads them via
  // the dreamsSource dep below.
  const { DreamStore, NightlyDreamer, dreamBriefingItems } = await import('./dreaming.js');
  const dreamStore = new DreamStore(config.dataDir);
  {
    const { createProvider } = await import('@mvp/agent-runtime');
    const dreamer = new NightlyDreamer({
      store: dreamStore,
      episodesForBot: (botId) =>
        tieredMemoryStore
          .getAtoms(botId, 50)
          .map((a) => (a as { fact?: string }).fact ?? '')
          .filter((s) => s.trim().length > 0),
      model: async (prompt) => {
        const bot = seed.bots[0];
        const provider = createProvider(bot?.provider ?? 'groq');
        const res = await provider.chat([{ role: 'user', content: prompt }], [], {
          model: bot?.model ?? 'default',
        });
        return res.content ?? '';
      },
    });
    let lastDreamDay = '';
    const dreamTimer = setInterval(() => {
      try {
        const now = new Date();
        const day = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
        if (now.getHours() >= 3 && lastDreamDay !== day) {
          lastDreamDay = day;
          void dreamer
            .runForBots(seed.bots.map((b) => b.id))
            .catch(() => undefined);
        }
      } catch {
        // Dreaming must never break the server.
      }
    }, 3_600_000);
    if (typeof dreamTimer.unref === 'function') dreamTimer.unref();
  }

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
      turnTracker,
      mcpServer: platformMcpServer,
      mcpScopeStore,
      threadScheduleStore,
      checkpointStore,
      dotStore,
      preferenceStore,
      phone: { store: phoneStore, hub: phoneHub, adb: phoneAdb },
      // Global pause (W14d): the chat route refuses new turns while paused.
      pauseRegistry,
      briefingSignalsSource:
        resolveGithubSignalsSource({
          dataDir: config.dataDir,
          executor: createComposioEventExecutor({ dataDir: config.dataDir }),
        }) ?? undefined,
      briefingNotificationDigest: (since, now) => notificationStore.digestItems(since, now),
      // OMB+Octop parity build: MCP Apps resolve live MCP clients by server
      // name through this map (populated by connectMcp after listen).
      mcpClientsByServer,
      // Nightly dreaming: the briefing's dream section reads the store.
      dreamsSource: () => dreamBriefingItems(dreamStore),
      // First-reply rescue: a failed first turn lands in the owner's
      // needs-you inbox (team inbox, FYI kind, needs-you state).
      addNeedsYou: (item) => {
        try {
          teamInboxStore.addItem({
            personId: item.personId ?? peopleStore.listPeople()[0]?.id ?? 'default',
            kind: 'fyi',
            state: 'needs-you',
            title: item.title,
            summary: item.summary,
            botId: item.botId,
          });
        } catch {
          // The rescue path must never break chat.
        }
      },
      companion: { store: companionStore, hub: companionHub },
      // Remote screen viewing (phone -> PC, Codync parity): approval-gated.
      remoteScreen: { store: companionStore, service: remoteScreenService, loopbackToken },
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
      spanStore,
      omniStore,
      omniCollector,
      computerManager,
      // BYO VPS (OpenMausBot parity P1 #24).
      vpsPool,
      // Lazy MCP directory (OpenMausBot parity P1 #22).
      lazyMcpManager,
      refreshMcpStubs,
      // Per-bot private MCP servers (W9).
      perBotMcpManager,
      // Interactive widgets (OpenMausBot parity P1 #15): the chat route
      // passes this into runTurn so ask_user_question can pause for answers.
      widgetCoordinator,
      // Approval-gated purchasing (W6): purchases routes on the billing
      // router + approval-decision forwarding into the purchase service.
      purchaseWiring,
      // Chat UX pack (W8): "done" settles pending sign-in requests
      // (status re-checked via the cli-auth status path), and chat
      // voice replies synthesize through the bot's TTS provider
      // (zero-cost mock when a key-gated provider is unconfigured).
      signInRequests: chatUxSignInStore,
      checkCliSignIn: async (cliId) => {
        const status = await chatUxCliAuth.getStatus(cliId as CliAuthId);
        return { signedIn: status.signedIn };
      },
      chatTtsProvider: (bot) => {
        // Chat spoken replies use the bot's full TTS provider breadth
        // (OMB §1.1): voice-call providers via the call builder (vault
        // keys), the newer providers via @mvp/voice (env keys, synced
        // from providers.local.json at boot).
        try {
          const id = bot.voice?.ttsProvider ?? 'mock';
          switch (id) {
            case 'mock':
              return new MockTTSProvider();
            case 'groq':
            case 'openai':
              return buildVoiceProviders('mock', id, config.dataDir).tts;
            case 'elevenlabs':
              return new ElevenLabsTTSProvider();
            case 'fish':
              return new FishTTSProvider();
            case 'chatterbox':
              return new ChatterboxTTSProvider();
            case 'system':
              return new SystemTTSProvider();
            default:
              return undefined;
          }
        } catch {
          return undefined; // routes fall back to the mock TTS
        }
      },
    }),
  );
  // Multiplayer layer (W7): people directory, org/ownership, team inbox,
  // relays. Mounted on /api next to the main router (no new top-level
  // web destination — surfaces live in Bots → Teams and Activity).
  peoplePushHolder.svc = pushService;
  app.use(
    '/api',
    createPeopleRouter({
      dataDir: config.dataDir,
      service: peopleService,
      getBots: () => seed.bots,
      governance,
      listWidgets: () =>
        widgetStore.list().map((w) => ({
          id: w.id,
          botId: w.botId,
          status: w.status,
          title: w.title,
          payload: w.payload as { question?: string; title?: string },
          interactive: w.interactive,
          createdAt: w.createdAt,
          addresseePersonId: w.addresseePersonId,
        })),
      listSessions: (opts) => agentRuntime.sessionStore.listSessions(opts),
      audit: (action, fields) => governance.audit(action, fields),
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
      duplicateThread: (id) => agentRuntime.sessionStore.duplicateSession(id),
      deleteThread: (id) => agentRuntime.sessionStore.deleteSession(id),
      audit: (action, fields) => governance.audit(action, fields),
      titles: threadTitles,
      // W2: deleting a thread clears its circuit-breaker state so a
      // deleted session can't leak breaker/denial state into a recycled id.
      onThreadDeleted: (id) => agentRuntime.clearSessionCircuitState(id),
      // W7: when a person context is presented, list only that person's
      // private chats; no context → unchanged (all threads).
      resolvePersonId: (req) => resolveExplicitPersonContext(req as never),
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
  // ACP sessions (OpenMausBot parity P1 #26 — ACP completion): lifecycle,
  // streaming prompts, and tool-call bridging for external ACP agents
  // (OpenCode, Claude Code, Codex, …) over stdio JSON-RPC. The manager is
  // closed on shutdown so no child processes are orphaned.
  const acpSessionStore = new AcpSessionStore(config.dataDir);
  const acpSessionManager = new AcpSessionManager(acpSessionStore);
  app.use(
    '/api/acp',
    createAcpSessionsRouter({
      manager: acpSessionManager,
      workspaceDir: config.workspaceDir,
      governance,
      audit: (action, fields) => governance.audit(action, fields),
      // Standalone engine installs win over PATH copies in detection.
      standalonePath: (engineId) => installedEnginePath(config.dataDir, engineId),
    }),
  );
  process.on('SIGTERM', () => {
    try {
      acpSessionManager.closeAll();
    } catch {
      // ignore
    }
  });
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
      // W8b: 👍/👎 on a pending question/approval resolves it.
      reactionAnswers: reactionAnswerService,
    }),
  );
  app.use(
    '/api/bots',
    createBotRosterRouter({
      dataDir: config.dataDir,
      getBots: () => seed.bots,
      audit: (action, fields) => governance.audit(action, fields),
      // Durable deletion for seed bots: record the id so the boot-time
      // filter above keeps it deleted across restarts.
      recordDeletedBotId,
      // Teardown on delete: the bot's private MCP servers/processes and
      // its chat sessions (best-effort; the deletion itself already landed).
      onBotDeleted: async (botId) => {
        await perBotMcpManager.removeAllForBot(botId);
        try {
          for (const s of agentRuntime.sessionStore.listSessions({ botId })) {
            agentRuntime.sessionStore.deleteSession(s.id);
          }
        } catch {
          // Session cleanup must never fail a deletion.
        }
      },
    }),
  );
  // "Set me up" (W12a): one-sentence bot setup. /propose runs a setup turn
  // and returns an inert proposal; /apply (the approval action) creates
  // the bot + suggested routines. The setup turn uses the chief's
  // provider/model when a chief exists, else the first bot's.
  {
    const { createProvider, SkillLoader } = await import('@mvp/agent-runtime');
    app.use(
      '/api/bots/setup',
      createBotSetupRouter({
        dataDir: config.dataDir,
        getBots: () => seed.bots,
        toolNames: () => [...toolRegistry.keys()],
        mcpServerNames: () => Object.keys(seed.mcpServers ?? {}),
        skillNames: () => {
          try {
            return new SkillLoader(path.join(seedDir, 'skills')).list();
          } catch {
            return [];
          }
        },
        routineStore,
        resolveSetupProvider: () => {
          const chief = seed.bots.find((b) => b.chiefOfStaff) ?? seed.bots[0];
          if (!chief) throw new Error('No bot exists yet to run the setup turn.');
          return {
            provider: createProvider(chief.provider),
            model: chief.model,
            providerId: chief.provider,
          };
        },
        audit: (action, fields) => governance.audit(action, fields),
      }),
    );
  }
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
      // W7: @mentions of people in a room → team-inbox items + chief/push
      // fan-out for exactly the mentioned people.
      onPersonMentions: async ({ group, text, req }) => {
        await peopleService.handleRoomPersonMentions({
          groupId: group.id,
          groupName: group.name,
          text,
          authorPersonId: resolvePersonContext(req as never),
        });
      },
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
  // W12: "Apply updates when idle" (default OFF in update settings). The
  // idle applier polls every 30s and applies a pending update only after
  // 10 continuous idle minutes — idle = no live turns (turn-state
  // registry) and no routine runs in flight (routine scheduler). Any busy
  // poll resets the idle clock inside the applier.
  const idleUpdater = new IdleAutoUpdater({
    source: updater,
    isBusy: () => agentRuntime.turnStates.size > 0 || routineScheduler.inFlightCount() > 0,
    onApplied: (status) => {
      try {
        governance.audit('update.idle_applied', {
          actor: 'system',
          detail: { state: status.state, latest: status.latest?.tag ?? null },
        });
      } catch {
        // Audit must never break the applier.
      }
    },
  });
  idleUpdater.start();
  app.use('/api/updates', createSelfUpdateRouter(updater, { idleUpdater }));

  // Open-at-login (W12d): file-based OS autostart entry managed from
  // Settings. The exec path defaults to this server process; desktop
  // installs set KRIYADOT_EXEC_PATH to the app binary.
  {
    const { AutostartManager } = await import('./autostart.js');
    const { createAutostartRouter } = await import('./autostart-routes.js');
    app.use(
      '/api/autostart',
      createAutostartRouter(new AutostartManager(), (action, fields) =>
        governance.audit(action, fields),
      ),
    );
  }

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

  // Profile/credential proposal cards (OpenMausBot parity): the bot raises
  // a card instead of failing when it needs a credential it doesn't have.
  // Backstop sweep expires stale cards even when no waiter watches.
  app.use(
    '/api',
    createCredentialProposalRouter({
      store: credentialProposalStore,
      dataDir: config.dataDir,
      audit: (action, fields) => governance.audit(action, fields),
    }),
  );
  const credentialProposalSweep = setInterval(() => {
    try {
      const expired = credentialProposalStore.expireStale();
      for (const id of expired) governance.audit('credential-proposal.expired', { detail: { cardId: id } });
    } catch {
      // Sweeps must never break the server.
    }
  }, 60_000);
  if (typeof credentialProposalSweep.unref === 'function') credentialProposalSweep.unref();

  // Sentinel health scanner (OpenMausBot parity): GET /api/health/detail.
  app.use(
    '/api/health',
    createSentinelRouter({
      dataDir: config.dataDir,
      getBots: () => seed.bots.map((b) => ({ id: b.id, provider: b.provider })),
    }),
  );

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
      // W9: deleting a bot tears down its private MCP servers/processes.
      onBotDeleted: async (botId) => {
        await perBotMcpManager.removeAllForBot(botId);
      },
    }),
  );

  app.use('/api/routines', routinesRouter);
  app.use('/webhooks/routines', routineWebhookRouter);
  // Proactive account watching (W5): watch rules poll connected Composio
  // apps on their check interval, triage new items with the cheapest
  // routed helper model, and surface only flagged items as "needs you"
  // inbox entries + a push. Cursors/seen-sets persist in watch.db, so
  // the first poll after boot catch-up-checks a bounded set of items
  // missed while down. Execution reuses the W2 Composio path (vault key
  // → account resolution → per-bot enable gate) via the default
  // executor inside registerWatchRoutes.
  const { registerWatchRoutes } = await import('./watch-routes.js');
  const watchRouter = express.Router();
  const { watcher: watchWatcher } = registerWatchRoutes(watchRouter, {
    dataDir: config.dataDir,
    audit: (action, fields) => governance.audit(action, fields),
    getBots: () => seed.bots,
    chiefBotId:
      chiefWiring.store.getChiefConfig().chiefBotId ??
      seed.bots.find((b) => b.chiefOfStaff)?.id,
    push: pushService,
    agentRuntime,
    isPaused,
  });
  const watchReconcile = watchWatcher.reconcileOnBoot();
  if (watchReconcile.cursors > 0) {
    console.log(`[watch] watch rules reconciled: ${watchReconcile.cursors} cursor(s) restored`);
  }
  watchWatcher.start();
  app.use('/api', watchRouter);
  // Global pause (W14d): /api/system/pause|resume|pause-state (audited).
  {
    const systemRouter = express.Router();
    registerSystemPauseRoutes(systemRouter, {
      registry: pauseRegistry,
      audit: (action, fields) => governance.audit(action, fields),
    });
    app.use('/api', systemRouter);
  }
  // Notification triage (W14b): settings + needs-you inbox + digest.
  {
    const notificationRouter = express.Router();
    registerNotificationRoutes(notificationRouter, {
      store: notificationStore,
      service: notificationService,
      audit: (action, fields) => governance.audit(action, fields),
    });
    app.use('/api', notificationRouter);
  }
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
  // ── OMB+Octop parity build (2026-10-29): HTTP surface ───────────────────
  // Bridge federation (Octop §2.1): local admin + peer protocol. Inbound
  // peer routes are loopback-auth exempt (signed Ed25519 envelopes are
  // their auth); trust actions additionally require the loopback-authed
  // flag via authorizeLocal.
  {
    const { createFederationRouter } = await import('./federation-routes.js');
    app.use(
      '/api/federation',
      createFederationRouter({
        dataDir: config.dataDir,
        publicUrl: process.env.KRIYADOT_FEDERATION_URL,
        getBots: () => seed.bots,
        runtime: agentRuntime as never,
        audit: (action, fields) => governance.audit(action, fields),
        isPaused,
        authorizeLocal: (req) => (req as { loopbackAuthed?: boolean }).loopbackAuthed === true,
      }),
    );
  }
  // Representative assistant routes (OMB §1.2): policy/status/audit + ask.
  {
    const { createRepresentativeRouter } = await import('./representative-routes.js');
    app.use(
      '/api',
      createRepresentativeRouter({
        people: peopleStore,
        store: representativeStore,
        service: representativeService,
        audit: (action, fields) => governance.audit(action, fields),
      }),
    );
  }
  // Proactive care (Octop §2.19): scored memory episodes → capped check-ins
  // via needs-you inbox + push. Engine tick on a 15-minute host interval.
  {
    const { ProactiveCareStore, ProactiveCareEngine } = await import('./proactive-care.js');
    const { createProactiveCareRouter } = await import('./proactive-care-routes.js');
    const careStore = new ProactiveCareStore(config.dataDir);
    const careEngine = new ProactiveCareEngine({
      store: careStore,
      listBots: () =>
        seed.bots.map((b) => ({ id: b.id, name: b.name, ownerPersonId: botOwnerPersonId(b) })),
      getAtoms: (botId) => tieredMemoryStore.getAtoms(botId, 300),
      addInboxItem: (item) =>
        teamInboxStore.addItem({
          personId: item.personId,
          kind: 'fyi',
          state: 'needs-you',
          title: item.title,
          summary: item.summary,
          botId: item.botId,
          refId: item.refId,
        }),
      deliverChat: ({ botId, personId, text }) => {
        const sessionId = agentRuntime.sessionStore.createSession(botId, { ownerPersonId: personId });
        agentRuntime.sessionStore.appendMessage(sessionId, { role: 'assistant', content: text });
      },
      push: async ({ botId, botName, title, body }) => {
        await pushService.notify({ kind: 'needsInput', botId, botName, title, body });
      },
      isPaused,
      audit: (action, fields) => governance.audit(action, fields),
    });
    app.use(
      '/api',
      createProactiveCareRouter({
        store: careStore,
        engine: careEngine,
        getBotOwner: (botId) => {
          const bot = botsById.get(botId);
          return bot ? botOwnerPersonId(bot) : undefined;
        },
        audit: (action, fields) => governance.audit(action, fields),
      }),
    );
    const careTimer = setInterval(() => {
      void careEngine.tick().catch(() => undefined);
    }, 900_000);
    if (typeof careTimer.unref === 'function') careTimer.unref();
  }
  // Invocation decision model (Octop §2.5): routing/skill/tool/team
  // decision log + judgments.
  {
    const { createDecisionRouter } = await import('./decision-routes.js');
    app.use('/api', createDecisionRouter({ dataDir: config.dataDir, audit: (action, fields) => governance.audit(action, fields) }));
  }
  // Plugin system (Octop §2.4): marketplace/admin surface for the manager
  // constructed with the tool registrations above.
  {
    const { createPluginRouter } = await import('./plugin-routes.js');
    app.use('/api', createPluginRouter({ manager: pluginManager, audit: (action, fields) => governance.audit(action, fields) }));
  }
  // Enterprise SSO + login captcha (Octop §2.5): OIDC/LDAP/captcha surface.
  // Mounted under /api/auth/sso (loopback-exempt: pre-auth by design).
  {
    const { createAuthSsoRouter } = await import('./auth-sso-routes.js');
    app.use('/api/auth/sso', createAuthSsoRouter({ dataDir: config.dataDir, audit: (action, fields) => governance.audit(action, fields) }));
  }
  // Tenancy depth: role templates, groups+grants, audiences, quotas.
  {
    const { createTenancyDepthRouter } = await import('./tenancy-depth-routes.js');
    app.use('/api', createTenancyDepthRouter({ dataDir: config.dataDir, audit: (action, fields) => governance.audit(action, fields) }));
  }
  // Expert publishing + organization library + enterprise pack.
  {
    const { createPublishedBotsRouter } = await import('./published-bots-routes.js');
    app.use(
      '/api/published-bots',
      createPublishedBotsRouter({ dataDir: config.dataDir, getBots: () => seed.bots, audit: (action, fields) => governance.audit(action, fields) }),
    );
    const { createOrgLibraryRouter, OrgLibraryStore } = await import('./org-library.js');
    const { TeamLibraryService } = await import('./team-library-service.js');
    const { TeamStore } = await import('@mvp/agent-runtime');
    const orgLibraryStore = new OrgLibraryStore(config.dataDir);
    app.use(
      '/api/org-library',
      createOrgLibraryRouter({
        dataDir: config.dataDir,
        getBots: () => seed.bots,
        // Team-kind installs: persist the manifest as a library entry,
        // then instantiate it (bots + team) through the team-library
        // service, whose store reads are org-scoped — hence per-call
        // construction with the caller's org bound in.
        importTeamManifest: async (payload, orgId) => {
          const manifestName =
            (payload as { team?: { name?: string } } | null)?.team?.name ?? 'Imported team';
          const entry = orgLibraryStore.create({
            orgId,
            kind: 'team',
            name: manifestName,
            payload,
            author: 'api',
            visibility: 'org',
            allowedGroupIds: [],
          });
          const service = new TeamLibraryService({
            getEntry: (entryId) => orgLibraryStore.get(orgId, entryId),
            botExists: (botId) => botsById.has(botId),
            createBot: (bot) => {
              seed.bots.push(bot);
              botsById.set(bot.id, bot);
              appendRosterImport(bot, config.dataDir);
            },
            createTeam: (input) => {
              const store = new TeamStore(config.dataDir);
              try {
                const team = store.createTeam(input.name, input.coordinatorBotId, input.memberBotIds, {
                  enforceComposition: true,
                });
                store.setDelegationPolicy(team.id, input.delegationPolicy, input.delegationPolicyOverrides);
                return store.getTeam(team.id) ?? team;
              } finally {
                store.close();
              }
            },
            audit: (action, fields) => governance.audit(action, fields),
          });
          const result = await service.instantiate(entry.id);
          return { teamId: result.team.id };
        },
        audit: (action, fields) => governance.audit(action, fields),
      }),
    );
    const { createBrandRouter } = await import('./brand.js');
    app.use('/api/brand', createBrandRouter({ dataDir: config.dataDir, audit: (action, fields) => governance.audit(action, fields) }));
    const { createInstallationsRouter, registerSelfInstallation } = await import('./installations.js');
    try {
      registerSelfInstallation(config.dataDir, process.env.KRIYADOT_VERSION ?? '0.1.0');
    } catch {
      // Registration bookkeeping must never break boot.
    }
    app.use(
      '/api/installations',
      createInstallationsRouter({ dataDir: config.dataDir, audit: (action, fields) => governance.audit(action, fields) }),
    );
  }
  // Voice catalog (OMB §1.1): provider voice search for the bot picker.
  {
    const { createVoiceCatalogRouter } = await import('./voice-catalog-routes.js');
    app.use('/api', createVoiceCatalogRouter());
  }
  // Managed knowledge bases (Octop §2.13).
  app.use('/api/kb', await (async () => {
    const { createKbRouter } = await import('./kb-routes.js');
    return createKbRouter({ dataDir: config.dataDir, store: kbStore });
  })());
  // Pluggable workspace backends (Octop §2.9): admin surface, only when a
  // backend registry is configured via WORKSPACE_BACKENDS_JSON/_FILE.
  try {
    const { loadWorkspaceBackendsFromEnv } = await import('@mvp/agent-runtime/dist/workspace-backends.js');
    const parsedBackends = await loadWorkspaceBackendsFromEnv();
    if (parsedBackends) {
      const { createStorageAdminRouter } = await import('./storage-admin-routes.js');
      app.use(
        '/api/storage',
        createStorageAdminRouter({ backends: parsedBackends.backends, assignments: parsedBackends.assignments }),
      );
      console.log(`[storage] workspace backends registered: ${[...parsedBackends.backends.keys()].join(', ')}`);
    }
  } catch (err) {
    console.warn(`[storage] workspace backend registry failed to load: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Interactive API docs (Octop §2.x deployment polish): /api/docs + spec.
  {
    const { createApiDocsRouter } = await import('./api-docs.js');
    app.use('/api', createApiDocsRouter());
  }
  // Mid-turn steering + context budget (OMB §1.1).
  {
    const { createSteerRouter } = await import('./steer-routes.js');
    app.use(
      '/api',
      createSteerRouter({
        enqueueSteer: (id, text) => agentRuntime.enqueueSteer(id, text),
        isTurnRunning: (id) => agentRuntime.isTurnRunning(id),
      }),
    );
    const { createContextBudgetRouter } = await import('./context-budget-routes.js');
    app.use('/api', createContextBudgetRouter({ getContextBudget: (id) => agentRuntime.getContextBudget(id) }));
  }
  // Triggers calendar (OMB §1.1 routine depth).
  {
    const { createTriggersCalendarRouter } = await import('./triggers-calendar-routes.js');
    app.use('/api', createTriggersCalendarRouter({ routineStore, runStore: routineRunStore }));
  }
  // Chat polish (OMB §1.1/§1.2): pins/reactions/spoilers, bulk ops, thread
  // folders, departments, text assist, bot avatars.
  {
    const { createChatUxRouter } = await import('./chat-ux.js');
    app.use(
      '/api',
      createChatUxRouter({
        dataDir: config.dataDir,
        reactionStore: messageReactionStore,
        listThreadMessages: (id) =>
          agentRuntime.listThreadMessages(id) as unknown as Array<Record<string, unknown> & { id: unknown }>,
        audit: (action, fields) => governance.audit(action, fields),
      }),
    );
    const { createBulkRouter } = await import('./bulk-routes.js');
    app.use(
      '/api',
      createBulkRouter({
        deleteBot: async (id) => {
          const idx = seed.bots.findIndex((b) => b.id === id);
          if (idx < 0) return false;
          const [removed] = seed.bots.splice(idx, 1);
          botsById.delete(id);
          if (removed) recordDeletedBotId(id);
          await perBotMcpManager.removeAllForBot(id);
          return true;
        },
        deleteThread: (id) => agentRuntime.sessionStore.deleteSession(id),
        audit: (action, fields) => governance.audit(action, fields),
      }),
    );
    const { createThreadFoldersRouter } = await import('./thread-folders.js');
    app.use('/api', createThreadFoldersRouter({ dataDir: config.dataDir, audit: (action, fields) => governance.audit(action, fields) }));
    const { createDepartmentsRouter, DepartmentStore } = await import('./departments.js');
    app.use(
      '/api',
      createDepartmentsRouter({
        dataDir: config.dataDir,
        store: new DepartmentStore(config.dataDir),
        audit: (action, fields) => governance.audit(action, fields),
      }),
    );
    const { createTextAssistRouter } = await import('./text-assist-routes.js');
    const { createProvider, SkillLoader } = await import('@mvp/agent-runtime');
    const assistLoader = new SkillLoader(path.join(seedDir, 'skills'), {
      additionalDirs: [path.join(config.dataDir, 'skills')],
    });
    app.use(
      '/api',
      createTextAssistRouter({
        complete: async (text) => {
          const bot = seed.bots[0];
          const provider = createProvider(bot?.provider ?? 'groq');
          const res = await provider.chat(
            [
              { role: 'system', content: 'Polish the following draft: fix grammar and clarity, keep the meaning and tone. Return only the polished text.' },
              { role: 'user', content: text },
            ],
            [],
            { model: bot?.model ?? 'default' },
          );
          return res.content || text;
        },
        skills: async (skillId) => {
          try {
            const loaded = await assistLoader.load(skillId);
            return loaded ? { id: skillId, name: loaded.name, prompt: loaded.content } : undefined;
          } catch {
            return undefined;
          }
        },
        audit: (action, fields) => governance.audit(action, fields),
      }),
    );
    const { createBotAvatarRouter } = await import('./bot-personas.js');
    app.use('/api', createBotAvatarRouter({ dataDir: config.dataDir, bots: seed.bots }));
  }
  // Engine depth (OMB §1.3): standalone installs (approval-gated; shipped
  // manifest pins are fail-closed until a maintainer verifies digests) and
  // Claude account profiles + custom ACP engines.
  {
    const { createEngineInstallsRouter } = await import('./engine-installs.js');
    app.use(
      '/api',
      createEngineInstallsRouter({
        dataDir: config.dataDir,
        audit: (action, fields) => governance.audit(action, fields),
        approve: async (engineId) => {
          try {
            const approvalId = governance.requestApproval(
              'engine_install',
              { engine: engineId },
              { botId: 'system', sessionId: 'engine-install', actor: 'user' },
            );
            const decision = await governance.awaitDecision(approvalId, 180_000);
            return decision === 'approved';
          } catch {
            return false;
          }
        },
      }),
    );
    const { createEngineAccountsRouter } = await import('./engine-accounts-routes.js');
    app.use(
      '/api',
      createEngineAccountsRouter({
        dataDir: config.dataDir,
        bots: seed.bots,
        audit: (action, fields) => governance.audit(action, fields),
        workspaceDir: config.workspaceDir,
      }),
    );
  }
  // Skill ecosystem (Octop §2.x): SkillHub installs (same trust gates as
  // MCP installs), skill bench, key suggestions, per-person browser holds.
  {
    const { createSkillHubRouter } = await import('./skillhub.js');
    const { SkillCopyPolicyStore } = await import('./skill-copy-policy.js');
    app.use(
      '/api/skills',
      createSkillHubRouter({
        store: userSkillStore,
        copyPolicies: new SkillCopyPolicyStore(config.dataDir),
        audit: (action, fields) => governance.audit(action, fields),
      }),
    );
    const { createSkillBenchRouter } = await import('./skill-bench-routes.js');
    app.use(
      '/api/skills',
      createSkillBenchRouter({
        store: userSkillStore,
        getBot: (id) => botsById.get(id),
        runTurn: async (bot, req) => {
          const sessionId = agentRuntime.sessionStore.createSession(bot.id);
          await agentRuntime.runTurn({
            bot,
            sessionId,
            message: `${req.skillInstructions}\n\n${req.prompt}`,
            onEvent: () => undefined,
          });
          const messages = agentRuntime.listThreadMessages(sessionId);
          const last = [...messages].reverse().find((m) => m.role === 'assistant');
          return { response: typeof last?.content === 'string' ? last.content : '' };
        },
        audit: (action, fields) => governance.audit(action, fields),
      }),
    );
    const { createKeySuggestionsRouter } = await import('./key-suggestions.js');
    app.use('/api/settings/key-suggestions', createKeySuggestionsRouter());
    const { createBrowserHoldRouter } = await import('./browser-hold-routes.js');
    app.use('/api/browser', createBrowserHoldRouter({ audit: (action, fields) => governance.audit(action, fields) }));
  }
  // Platform extras (OMB §1.20): OS service manager + managed env admin.
  {
    const { ServiceManager, createServiceManagerRouter } = await import('./service-manager.js');
    app.use(
      '/api/service',
      createServiceManagerRouter({
        manager: new ServiceManager({ execPath: process.env.KRIYADOT_EXEC_PATH ?? process.execPath }),
        audit: (action, fields) => governance.audit(action, fields),
      }),
    );
    const { createEnvAdminRouter } = await import('./env-admin-routes.js');
    app.use('/api/admin/env', createEnvAdminRouter({ dataDir: config.dataDir, audit: (action, fields) => governance.audit(action, fields) }));
  }
  // ACME http-01 challenge serving (Octop §2.x TLS): mounted at the app
  // root — the CA fetches /.well-known/acme-challenge/<token> unauthenticated
  // (that path prefix is loopback-auth exempt by design).
  {
    const { AcmeChallengeStore, createAcmeChallengeRouter } = await import('./acme.js');
    app.use(createAcmeChallengeRouter(new AcmeChallengeStore()));
  }
  // Scheduled workspace backups with retention (Octop §2.x).
  try {
    const { BackupScheduler } = await import('./workspace-backup.js');
    const backupScheduler = new BackupScheduler({ dataDir: config.dataDir, workspaceDir: config.workspaceDir, appVersion: process.env.KRIYADOT_VERSION ?? '0.1.0' });
    backupScheduler.startAll();
  } catch (err) {
    console.warn(`[backup] scheduler failed to start: ${err instanceof Error ? err.message : String(err)}`);
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
  // Public page publishing (W3): GET /p/<slug> serves published pages with
  // NO auth (non-/api paths are loopback-auth exempt by design; unknown or
  // unpublished slugs 404). Mounted before the SPA fallback.
  registerPublicPageServing(app, { dataDir: config.dataDir });
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

  // Built-in TLS (Octop §2.x deployment polish): when KRIYADOT_TLS_* env
  // (or ACME-provisioned certs in the data dir) yields options, serve
  // HTTPS directly; otherwise plain HTTP as before.
  const { buildTlsOptionsFromEnv } = await import('./tls-options.js');
  const tlsOptions = buildTlsOptionsFromEnv();
  const onListening = () => {
    console.log(`[api] listening on http${tlsOptions ? 's' : ''}://127.0.0.1:${config.port}`);
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
  };
  const server = tlsOptions
    ? (await import('node:https')).createServer(tlsOptions, app).listen(config.port, '127.0.0.1', onListening)
    : app.listen(config.port, '127.0.0.1', onListening);

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
      await perBotMcpManager.close();
    } catch {
      // ignore per-bot MCP close errors on shutdown
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
      peopleStore.close();
      teamInboxStore.close();
    } catch {
      // ignore
    }
    try {
      updater.stopAutoCheck();
      idleUpdater.stop();
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
