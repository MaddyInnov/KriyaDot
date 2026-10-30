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
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

// Plain-Node compatibility (QA 2026-10-30): the supported runtime is
// Bun, but the Docker image runs `node dist/index.js`. A number of
// modules across the api + agent-runtime use a lazy bare `require(...)`
// for builtins and optional deps (node:sqlite, node-pty, firebase-admin)
// — legal under Bun, a ReferenceError under Node ESM. All call sites are
// lazy (constructors/functions, never module top-level), so installing a
// global require here, before any of them run, makes the compiled server
// boot identically under Node. Under Bun this is a no-op guard.
if (typeof (globalThis as { require?: unknown }).require !== 'function') {
  (globalThis as { require?: unknown }).require = createRequire(import.meta.url);
}
import {
  AgentRuntime,
  SpanStore,
  SkillLoader,
  createCacheWarmerForBot,
  createMcpFacade,
  createProvider,
  createToolFacade,
  defaultElicitationRouter,
  discoverLocalTools,
  parseModelProfiles,
  resolveBotWorkspaceDir,
  selectDefaultEmbedder,
  toolTransportFromEnv,
} from '@mvp/agent-runtime';
import type { BotConfig, ToolDefinition } from '@mvp/agent-runtime';
import { DEFAULT_POLICY, GovernanceGateway, sanitizeTelemetry } from '@mvp/governance';
import { TelemetryCollector } from '@mvp/agent-runtime';
import { Scheduler, TriggerStore, WorkflowRunner, runEventsFromRun } from '@mvp/workflows';
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
import { phoneDataPolicyRules, registerPhoneDataTools } from './phone-data-tools.js';
import { phonePackagedPolicyRules, registerPhonePackagedTools } from './phone-packaged.js';
import { phoneBackgroundPolicyRules, registerPhoneBackgroundTools } from './phone-background.js';
import { CameraCaptureService, cameraCapturePolicyRules, registerCameraCaptureTools } from './camera-capture.js';
import {
  BindingConfigStore,
  BoundPersonalDataService,
  createKriyaDotProvider,
  createPhoneOsProvider,
  osBindingPolicyRules,
  registerOsBindingRoutes,
  registerOsBindingTools,
} from './os-data-binding.js';
import { WhatsappLocalStoreSearch, registerWhatsappLocalTools, whatsappLocalPolicyRules } from './whatsapp-local-store.js';
import { LanDiscoveryService, registerLanDiscoveryTools } from './lan-discovery.js';
import { HomeControlProxy, HostGrantStore, proxyTransport, registerHomeProxyRoutes, registerHomeProxyTools } from './home-control-proxy.js';
import { ShellyClient, registerShellyTools, shellyPolicyRules } from './shelly.js';
import { IppClient, ippPolicyRules, registerIppTools } from './ipp-print.js';
import { CalendarEventStore } from './tasks.js';
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
import {
  LazyMcpManager,
  PerBotMcpManager,
  BackgroundRunRegistry,
  FileBackgroundRunStore,
  SessionStandingRules,
  FileStandingRuleStore,
} from '@mvp/agent-runtime';
import { createSelfUpdateRouter } from './self-update-routes.js';
import { IdleAutoUpdater, SelfUpdateManager } from '@mvp/agent-runtime';
import { createFusionRouter, shutdownFusionRuns } from './fusion-routes.js';
import { FusionRunStore } from './fusion.js';
import { createUniversalRouter } from './universal-routes.js';
import { UniversalChatStore } from './universal.js';
import { createFrontdoorRouter, handoffPageHandler } from './handoff.js';
import { SyncHubStore } from './sync-hub.js';
import {
  PlacementStore,
  ReportingService,
  createPlacementRouter,
  hasActiveRunForBot,
  instanceRole,
  resolveRoutineAnchor,
  shouldExecuteForRole,
} from './placement.js';
import { createSyncRouter } from './sync-routes.js';
import { SyncClientEngine, readSyncTarget } from './sync-client.js';
import { createSyncApply } from './sync-apply.js';
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
import {
  registerPublicPageServing,
  PagePublicationStore,
  publicPathForSlug,
} from './public-pages.js';
import { renderTranscriptMarkdown } from './session-share.js';
import {
  loadRoutingRules,
  saveRoutingRules,
  promoteRule,
  retireRule,
  getSupervisorStats,
} from '@mvp/agent-runtime';
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
// Muse closure (Wave 1): consumer work panel (Activity §4.1), permissions
// pane + inspection tools (§4.7), file-lifecycle public serving (§4.8).
import { registerWorkPanelRoutes } from './work-panel.js';
import { registerPermissionsPaneRoutes } from './permissions-pane.js';
import { computerUsePaneSummary, createSetupAwareLocalLayer } from './computer-use-setup.js';
import { registerPermissionsTools } from './permissions-tools.js';
import { FileLinkService, registerFileLinkServing } from './file-links.js';
import { registerPageRecordPublicRoutes } from './page-records.js';
import { registerGatedPublicServing } from './publish-gate.js';
import { runTrashPurge } from './workspace-trash.js';
// Muse closure (Wave 2): capability awareness (ADD-2) + user guide (ADD-3).
import { resolvePrincipal } from './principal.js';
import { createCapabilityService, PRODUCT_FEATURES } from './capabilities.js';
import {
  registerGoogleWorkspaceProvider,
  registerGoogleWorkspaceTools,
  googleWorkspaceToolPolicies,
} from './google-workspace.js';
import { composioAppCapabilityFeatures, googleWorkspaceCapabilityFeature } from './composio-apps.js';
import {
  registerCapabilityTools,
  grantCapabilityToolsToBots,
  capabilityToolsPolicyRules,
} from './capability-tools.js';
import { createCapabilitiesRouter } from './capabilities-routes.js';
import { createGuideRouter } from './guide-routes.js';
import { listChannelIds } from './channel-config.js';
// Approval-gated purchasing (W6): request_purchase tool + policy (always
// require-approval), purchase intent service with Stripe Link / browser
// executors, and the billing-area purchases routes (mounted via routes.ts).
import { createPurchaseWiring, purchasePolicyRules, registerPurchaseTools } from './purchases.js';
import { outboundCallPolicyRules } from './outbound-calls.js';
import { phoneSmsPolicyRules } from './phone-sms.js';
import { createMcpManageTool } from './mcp-manage-tool.js';
import { createScheduleTools, GenericMonitorService } from './schedule-tools.js';
import { createWsElicitationBridge, registerCompanionElicitationSurface } from './elicitation-ws.js';
import { SessionOverlayStore } from './session-overlays.js';
import type { SessionCommandService } from './session-commands-routes.js';
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
function buildPlatformMcpServerOptions(opts: {
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
}): import('@mvp/agent-runtime').PlatformMcpServerOptions {
  const fallbackBot = opts.bots[0];
  let tools: ToolProvider = toolProviderFromRegistry(opts.toolRegistry);
  if (opts.connectionClass === 'read-only-assistant') {
    if (!opts.annotationStore) {
      throw new Error('read-only-assistant connection class requires an annotationStore');
    }
    tools = createReadOnlyAssistantProvider(tools, opts.annotationStore);
    console.log('[mcp] connection class: read-only-assistant (reads allowed, only annotations.append may write)');
  }
  return {
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
  };
}

function buildPlatformMcpServer(
  opts: Parameters<typeof buildPlatformMcpServerOptions>[0],
): PlatformMcpServer {
  return new PlatformMcpServer(buildPlatformMcpServerOptions(opts));
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
  // Per-bot layer pipelines (Octomind parity #41): overlay from
  // <dataDir>/bot-layers.json.
  const { applyBotLayers } = await import('./bot-layers.js');
  applyBotLayers(seed.bots, config.dataDir);
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
    rules: [...publishPagePolicyRules(), ...interconnectionPolicyRules(), ...computerUsePolicyRules(), ...museModuleToolPolicies(), ...composioToolPolicies(), ...signInCodePolicyRules(), ...purchasePolicyRules(), ...phoneActionPolicyRules(), ...phoneDataPolicyRules(), ...phonePackagedPolicyRules(), ...phoneBackgroundPolicyRules(), ...cameraCapturePolicyRules(), ...osBindingPolicyRules(), ...whatsappLocalPolicyRules(), ...shellyPolicyRules(), ...ippPolicyRules(), ...outboundCallPolicyRules(), ...phoneSmsPolicyRules(), ...googleWorkspaceToolPolicies(), ...capabilityToolsPolicyRules(), ...DEFAULT_POLICY.rules],
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
    // ADD-5: the local layer is setup-aware — until the user completes
    // the first-run setup flow, local computer tools answer with the
    // setup prompt (never a silent mock); once enabled, the real
    // verified adapter serves, with post-action screenshot verification
    // records audited here.
    localLayerFor: (botId: string) =>
      createSetupAwareLocalLayer({
        dataDir: config.dataDir,
        userId: botsById.get(botId)?.ownerId ?? 'you',
        onVerification: (rec) => {
          try {
            governance.audit('tool.computer_verify', { actor: botId, toolName: rec.step, detail: rec });
          } catch {
            // Audit must never break input.
          }
        },
      }),
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

  // CA-25: MCP channel hub — server-pushed events gated by governance
  // (synthetic tool mcp_channel_event; anything but an explicit allow
  // denies — no human sits in a push path) and injected into the bound
  // live session's steer queue with external-source framing.
  {
    const { McpChannelHub, channelGateFromClassifier } = await import('@mvp/agent-runtime');
    const { setMcpChannelHub } = await import('./mcp-channel-hub.js');
    setMcpChannelHub(
      new McpChannelHub({
        inject: ({ sessionId, text }) => {
          agentRuntime.enqueueSteer(sessionId, text);
        },
        gate: channelGateFromClassifier(async (info) => {
          const decision = await governance.evaluate('mcp_channel_event', {}, {
            botId: 'mcp-channel',
            sessionId: info.sessionId,
            actor: info.channel.serverLabel,
          });
          return decision.effect === 'allow' ? 'allow' : 'deny';
        }),
      }),
    );
  }

  // Platform embedder (Octomind parity #13): probed ONCE at boot —
  // neural (configured endpoint) > onnx seam > trigram hash fallback —
  // and shared by the tool registry, the runtime, tiered memory and
  // discovery so every surface embeds identically.
  const platformEmbedder = (await selectDefaultEmbedder()).embedder;

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
      embedder: platformEmbedder,
    });

  // Lazy MCP directory (OpenMausBot parity P1 #22): installed servers are
  // registered as lazy stubs in the tool registry. Nothing spawns at boot;
  // the server process starts on the first tool call. Disabled servers never
  // spawn.
  const lazyMcpManager = new LazyMcpManager({
    dataDir: config.dataDir,
    pinDbPath: path.join(config.dataDir, 'mcp-pins.db'),
    // Per-server config overrides (Octomind parity #54):
    // <dataDir>/mcp-overrides/<serverId>.json wins over the directory
    // entry field-by-field. Malformed override files fail loud by design.
    overrideConfigDir: path.join(config.dataDir, 'mcp-overrides'),
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
  // Capability awareness (Muse closure ADD-2): a GENERATED registry over
  // the live catalogs (bots, tools, skills, workflows, plugins, channels +
  // product features). discover_capabilities is granted to every bot; the
  // Chief + Universal anchor also get the compact summary in their prompt
  // (chief-wiring consumes the service below). Getters are lazy — the
  // registry builds on first use, after all catalogs exist.
  const capabilityService = createCapabilityService({
    bots: () => seed.bots,
    tools: () => [...toolRegistry.values()],
    skills: () => {
      try {
        const loader = new SkillLoader(path.join(seedDir, 'skills'));
        return loader.list().map((name) => ({ name, description: '' }));
      } catch {
        return [];
      }
    },
    workflows: () => seed.workflows,
    plugins: () => {
      try {
        return pluginManager.list();
      } catch {
        return [];
      }
    },
    channels: () => listChannelIds().map((id) => ({ id })),
    // CN-4..CN-8 + CN-3: verified Composio app capabilities and the
    // first-party Google Workspace entry join the curated feature table.
    features: [...PRODUCT_FEATURES, ...composioAppCapabilityFeatures(), googleWorkspaceCapabilityFeature()],
  });
  registerCapabilityTools({ registry: toolRegistry, service: capabilityService });
  // CN-3: first-party Google Workspace tools (Gmail/Calendar/Drive) on
  // the existing OAuth framework — fail closed until the founder's
  // Google OAuth credentials are configured.
  registerGoogleWorkspaceTools(toolRegistry, { dataDir: config.dataDir });
  grantCapabilityToolsToBots(seed.bots);
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
  // Permissions inspection tools (Muse closure §4.7, P-17): read-only
  // pending-approvals / active-grants / allowances lookups for agents.
  registerPermissionsTools({
    registry: toolRegistry,
    dataDir: config.dataDir,
    listApprovals: (status) => governance.listApprovals(status),
    bots: seed.bots,
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
    // Phone DATA tools (calendar/contacts/messages/location) — built in
    // an earlier wave but never host-registered; registered here with
    // the DV-4 health-sync ingest loop closed (samples → health store).
    const { createHubPhoneDataDispatcher } = await import('./phone-data-tools.js');
    const { HealthSyncStore } = await import('./health-sync.js');
    const healthSyncStore = new HealthSyncStore(config.dataDir);
    const dataDispatcher = createHubPhoneDataDispatcher(phoneHub, phoneStore);
    registerPhoneDataTools(toolRegistry, {
      dispatcher: dataDispatcher.dispatcher,
      resolveDeviceId: dataDispatcher.resolveDeviceId,
      audit: (action, fields) => governance.audit(action, fields),
      isPaused,
      onHealthSync: (deviceId, samples) => healthSyncStore.ingest(deviceId, samples),
    });
  }
  // §4.14 devices & home rails (Wave 6): packaged phone commands (DV-3),
  // background-control report (DV-6), desktop camera (DV-7), OS data
  // binding (DV-9), WhatsApp desktop-store search (DV-10), LAN discovery
  // (DV-12), home-control proxy (DV-13) with Shelly (DV-15) + IPP
  // printing (DV-16) riding its per-host grants. DV-14 Lutron/HAP tools
  // stay unregistered until a paired session transport exists.
  const wave6PhoneDispatcher = {
    dispatchAction: (d: string, a: string, p: Record<string, unknown>, t?: number) => phoneHub.dispatchAction(d, a, p, t),
    dispatchDataQuery: (d: string, q: string, p: Record<string, unknown>, t?: number) => phoneHub.dispatchDataQuery(d, q as never, p, t),
    isOnline: (d: string) => phoneHub.isOnline(d),
  };
  const wave6ResolveDeviceId = (requested?: string) =>
    requested ?? phoneStore.listDevices().find((d) => phoneHub.isOnline(d.id))?.id;
  registerPhonePackagedTools(toolRegistry, {
    actionDispatcher: wave6PhoneDispatcher,
    dataDispatcher: wave6PhoneDispatcher,
    resolveDeviceId: wave6ResolveDeviceId,
    audit: (action, fields) => governance.audit(action, fields),
    isPaused,
  });
  registerPhoneBackgroundTools(toolRegistry, {
    dataDispatcher: wave6PhoneDispatcher,
    resolveDeviceId: wave6ResolveDeviceId,
    audit: (action, fields) => governance.audit(action, fields),
    isPaused,
  });
  registerCameraCaptureTools(toolRegistry, {
    service: new CameraCaptureService({ dataDir: config.dataDir }),
    audit: (action, fields) => governance.audit(action, fields),
    isPaused,
  });
  const osBindingConfig = new BindingConfigStore(config.dataDir);
  const boundData = new BoundPersonalDataService(
    {
      os: createPhoneOsProvider({ dispatcher: wave6PhoneDispatcher, resolveDeviceId: wave6ResolveDeviceId }),
      kriyadot: createKriyaDotProvider({
        listLocalEvents: () =>
          new CalendarEventStore(config.dataDir)
            .list()
            .map((e) => ({ title: e.title, startsAt: e.startsAt, endsAt: e.endsAt })),
      }),
    },
    osBindingConfig,
  );
  registerOsBindingTools(toolRegistry, {
    service: boundData,
    audit: (action, fields) => governance.audit(action, fields),
    isPaused,
  });
  registerWhatsappLocalTools(toolRegistry, {
    search: new WhatsappLocalStoreSearch(),
    audit: (action, fields) => governance.audit(action, fields),
    isPaused,
  });
  registerLanDiscoveryTools(toolRegistry, { service: new LanDiscoveryService() });
  const hostGrantStore = new HostGrantStore(config.dataDir);
  const homeProxy = new HomeControlProxy(hostGrantStore, undefined, (action, fields) => governance.audit(action, fields));
  registerHomeProxyTools(toolRegistry, {
    proxy: homeProxy,
    audit: (action, fields) => governance.audit(action, fields),
    isPaused,
  });
  registerShellyTools(toolRegistry, {
    createClient: (host) => new ShellyClient({ host, transport: proxyTransport(homeProxy) }),
    audit: (action, fields) => governance.audit(action, fields),
    isPaused,
  });
  const ippTransportViaProxy = async (url: string, body: Buffer) => {
    const res = await proxyTransport(homeProxy)({
      method: 'POST',
      url,
      headers: { 'Content-Type': 'application/ipp' },
      body: body.toString('latin1'),
    });
    return Buffer.from(res.bodyText, 'latin1');
  };
  registerIppTools(toolRegistry, {
    client: new IppClient(ippTransportViaProxy),
    audit: (action, fields) => governance.audit(action, fields),
    isPaused,
  });
  // Approval-gated purchasing (W6): request_purchase — require-approval
  // ALWAYS via purchasePolicyRules above. The handler only records /
  // claims the purchase intent; execution runs solely after the human
  // approves the intent's card (see purchases.ts safety contract).
  registerPurchaseTools({ registry: toolRegistry, service: purchaseWiring.service });
  // §4.10 calls, texts & proactive delivery (CT-1..CT-12): packaged
  // outbound calling (brief → governance approval → provider call →
  // report in chat), phone SMS commands, proactive editions + pacing.
  // Tools are require-approval via the policy rules added above; dialing
  // re-checks the linked approval inside the service (purchases pattern).
  const { OutboundCallService, OutboundCallStore, registerOutboundCallTools } = await import('./outbound-calls.js');
  const { createOutboundCallRouter } = await import('./outbound-call-routes.js');
  const { selectTelephonyProvider } = await import('./telephony.js');
  const telephonyProvider = selectTelephonyProvider(process.env.TELEPHONY_PROVIDER, process.env);
  const outboundCalls = new OutboundCallService({
    store: new OutboundCallStore(config.dataDir),
    provider: telephonyProvider,
    raiseApproval: (brief) =>
      governance.requestApproval(
        'request_outbound_call',
        {
          briefId: brief.id,
          counterpartyName: brief.counterpartyName,
          number: brief.number,
          purpose: brief.purpose,
          maxDurationSec: brief.maxDurationSec,
        },
        { sessionId: 'outbound-calls', botId: brief.botId, actor: brief.botId },
      ),
    approvalStatus: (id) => governance.getApproval(id)?.status,
    deliverChat: ({ botId, text }) => {
      const sessionId = agentRuntime.sessionStore.createSession(botId);
      agentRuntime.sessionStore.appendMessage(sessionId, { role: 'assistant', content: text });
    },
    audit: (action, fields) => governance.audit(action, { actor: 'outbound-calls', detail: fields }),
    isPaused,
    botName: (botId) => seed.bots.find((b) => b.id === botId)?.name,
  });
  registerOutboundCallTools(toolRegistry, { service: outboundCalls });
  // CT-2: scheduled calls tick — authorization is re-checked at fire time
  // inside the service, so a still-pending approval blocks, never dials.
  const scheduledCallTimer = setInterval(() => {
    void outboundCalls.tickScheduled().catch(() => undefined);
  }, 60_000);
  scheduledCallTimer.unref();
  const { PhoneSmsService, PhoneSmsStore, registerPhoneSmsTools } = await import('./phone-sms.js');
  const { createPhoneSmsRouter } = await import('./phone-sms-routes.js');
  const phoneSmsService = new PhoneSmsService({
    store: new PhoneSmsStore(config.dataDir),
    dispatcher: {
      dispatchAction: (d, a, p, t) => phoneHub.dispatchAction(d, a, p, t),
      dispatchDataQuery: (d, q, p, t) => phoneHub.dispatchDataQuery(d, q as never, p, t),
      isOnline: (d) => phoneHub.isOnline(d),
    },
    resolveDeviceId: (requested) =>
      requested ?? phoneStore.listDevices().find((d) => phoneHub.isOnline(d.id))?.id,
    audit: (action, fields) => governance.audit(action, { actor: 'api', detail: fields }),
    isPaused,
  });
  registerPhoneSmsTools(toolRegistry, { service: phoneSmsService });
  const { ProactiveEditionService, ProactiveEditionStore } = await import('./proactive-editions.js');
  const { createProactiveEditionRouter } = await import('./proactive-edition-routes.js');
  const proactiveEditions = new ProactiveEditionService({
    store: new ProactiveEditionStore(config.dataDir),
    deliver: async ({ text }) => {
      // Editions land as a needs-you inbox item + a push (the proactive
      // fan-out); the full text rides the inbox summary.
      try {
        teamInboxStore.addItem({
          personId: peopleStore.listPeople()[0]?.id ?? 'default',
          kind: 'fyi',
          state: 'needs-you',
          title: 'Proactive edition',
          summary: text.slice(0, 4000),
        });
      } catch {
        // Inbox delivery must never break the edition pipeline.
      }
      await pushService.notify({
        kind: 'needsInput',
        botId: seed.bots[0]?.id ?? 'system',
        botName: seed.bots[0]?.name ?? 'KriyaDot',
        title: 'Proactive edition',
        body: text.slice(0, 300),
      });
    },
    audit: (action, fields) => governance.audit(action, { actor: 'proactive-editions', detail: fields }),
    isPaused,
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

  // (platformEmbedder is selected once, before buildToolRegistry above,
  // via selectDefaultEmbedder — neural > onnx seam > trigram hash.)

  // CA-5: file-defined agents (.kriyadot/agents/*.md in the workspace and
  // the user's home) — delegate/background profile resolution checks these
  // BEFORE the built-in profile library. Loaded once at boot.
  const { loadAgentDefinitions } = await import('@mvp/agent-runtime');
  const agentDefinitions = loadAgentDefinitions({
    workspaceDir: config.workspaceDir,
    userDir: os.homedir(),
  }).definitions;
  if (agentDefinitions.length > 0) {
    console.log(`[agents] loaded ${agentDefinitions.length} file-defined agent(s)`);
  }
  const agentRuntime: AgentRuntime = new AgentRuntime({
    dbPath: `${config.dataDir}/agent.db`,
    agentDefinitions,
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
    extraToolsForBot: (botId): ToolDefinition[] => {
      const bot = botsById.get(botId);
      const local = bot ? discoverLocalTools(workspaceDirForBotConfig(bot)).tools : [];
      // Octomind parity #59: read_spilled_result must actually be
      // registered — the spill preview directs the model to call it.
      // The tool is bound to THIS bot's spill store, so it rides the
      // per-bot extras channel (agentRuntime is initialized by the time
      // any turn runs; same late-binding pattern as the worktree hook).
      const spill: ToolDefinition[] = bot ? agentRuntime.createSpillTools(bot) : [];
      return [...perBotMcpManager.toolDefinitions(botId), ...local, ...spill];
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
    // Closure #44: background runs persist to a JSON file store so a
    // restart never loses run history (the runtime default is in-memory).
    backgroundRuns: new BackgroundRunRegistry({
      store: new FileBackgroundRunStore(path.join(config.dataDir, 'background-runs.json')),
    }),
    // Closure #46: session standing rules, file-persisted like the
    // background runs so rules survive restarts.
    standingRules: new SessionStandingRules({
      store: new FileStandingRuleStore(path.join(config.dataDir, 'standing-rules.json')),
    }),
    // Closure #139: the installed-MCP catalog feeds deterministic
    // auto-activation; activated servers contribute their lazy stub
    // tools (already synced into the shared registry).
    mcpCatalog: () =>
      lazyMcpManager
        .list()
        .filter((s) => s.enabled)
        .map((s) => ({
          kind: 'mcp' as const,
          id: s.id,
          name: s.label,
          description: `Installed MCP server "${s.label}"`,
        })),
    toolsForMcpServer: (serverId: string) => {
      const server = lazyMcpManager.list().find((s) => s.id === serverId);
      if (!server) return [];
      const prefix = `mcp:${server.label}:`;
      return [...toolRegistry.entries()]
        .filter(([name]) => name.startsWith(prefix))
        .map(([, def]) => def);
    },
    // Closure #15: the bot roster feeds discover_specialists.
    discoverableItems: () =>
      [...botsById.values()].map((b) => ({
        kind: 'bot' as const,
        id: b.id,
        name: b.name,
        description: b.description ?? '',
      })),
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
  // Named ephemeral agents (closure #18): register / list / invoke tools
  // over a host-owned registry, seeded from <dataDir>/named-agents.json
  // when present. Invocation dispatches through the same background-run
  // path as delegate_background.
  {
    const { NamedAgentRegistry, createNamedAgentTools } = await import('@mvp/agent-runtime');
    let seedProfiles: import('@mvp/agent-runtime').SubagentProfile[] = [];
    try {
      const raw = fs.readFileSync(path.join(config.dataDir, 'named-agents.json'), 'utf8');
      const parsed = JSON.parse(raw) as {
        profiles?: import('@mvp/agent-runtime').SubagentProfile[];
      };
      if (Array.isArray(parsed.profiles)) seedProfiles = parsed.profiles;
    } catch {
      // No persisted named agents yet — start empty.
    }
    const namedAgents = new NamedAgentRegistry(seedProfiles);
    for (const tool of createNamedAgentTools({
      namedAgents,
      startBackgroundRun: (input) => agentRuntime.startBackgroundRun(input),
    })) {
      toolRegistry.set(tool.name, tool);
    }
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

  // CA-17: output styles — one shared file-backed store: the /style
  // session command writes selections through it (sessionCommandDeps
  // below) and this provider appends the selected style's prompt to
  // every turn's system context.
  const { OutputStyleStore, buildStylePrompt } = await import('./session-craft.js');
  const outputStyleStore = OutputStyleStore.forDataDir(config.dataDir);
  agentRuntime.addContextProvider(({ sessionId }) =>
    sessionId ? buildStylePrompt(outputStyleStore.getSessionStyle(sessionId)) : '',
  );

  // Script hooks (Octomind parity #67/#101): bots whose config carries
  // shell `hooks` entries get them registered on the shared HookBus as
  // real script handlers (the production call site for
  // createScriptHookHandler — plugin-routes.ts).
  {
    const { registerScriptHooksFromConfigs } = await import('./plugin-routes.js');
    const scriptHooks = registerScriptHooksFromConfigs(hookBus, seed.bots);
    if (scriptHooks.registered > 0) {
      console.log(`[hooks] registered ${scriptHooks.registered} script hook(s) from bot configs`);
    }
  }

  // CA-1: HTTP + prompt config hooks from bot configs (script entries are
  // registered by the block above, so only the new kinds are installed
  // here — no double-firing). Prompt hooks evaluate through the bot's own
  // provider via the cheapest evaluate profile; every handler fails open
  // except explicit gate blocks, and no hook can approve anything.
  {
    const { hooksFromConfig, registerHookConfig, providerPromptEvaluator } = await import('@mvp/agent-runtime');
    let installed = 0;
    for (const bot of seed.bots) {
      try {
        const { entries } = hooksFromConfig(bot as { hooks?: unknown });
        const nonScript = entries.filter((e) => e.kind === 'http' || e.kind === 'prompt');
        if (nonScript.length === 0) continue;
        const { registered } = registerHookConfig(hookBus, nonScript, {
          evaluator: providerPromptEvaluator(createProvider(bot.provider), { profiles: modelProfiles }),
        });
        installed += registered;
      } catch (err) {
        console.warn(`[hooks] config hooks for bot "${bot.id}" failed to install:`, (err as Error).message);
      }
    }
    if (installed > 0) {
      console.log(`[hooks] registered ${installed} http/prompt hook(s) from bot configs`);
    }
  }

  // Prompt-cache warmers (Octomind parity #137): one warmer per bot
  // that opted in via BotConfig.cacheWarm AND uses a cache-capable
  // (Anthropic-class) provider. Instances are stopped on shutdown.
  const cacheWarmers: Array<{ stop(): void }> = [];
  for (const bot of seed.bots) {
    try {
      const warmer = createCacheWarmerForBot(bot, { provider: () => createProvider(bot.provider) });
      if (warmer) {
        warmer.start();
        cacheWarmers.push(warmer);
        console.log(`[cache] warmer started for bot "${bot.id}" (provider ${bot.provider})`);
      }
    } catch (err) {
      console.warn(`[cache] warmer for bot "${bot.id}" failed to start:`, (err as Error).message);
    }
  }

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
    // Delegate children resolve purpose profiles + get a summarizer too.
    modelProfiles,
    // CA-5/CA-1: file-defined agents win profile resolution; the shared
    // bus lets subagent.start/stop + worktree hooks observe spawns.
    agentDefinitions,
    hooks: hookBus,
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
    capabilityService,
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
  // Front-door (Parts 3–5): placement store, sync hub store, and the
  // reporting service are created here — before the routine routes (the
  // anchor resolver reads placement) and the scheduler (the executor
  // gate + reporting hooks read them). The reporting notifier is a holder
  // filled once the PushService exists, exactly like notifyRoutinePaused.
  const frontdoorRole = instanceRole();
  const placementStore = new PlacementStore(config.dataDir);
  const syncHubStore = new SyncHubStore(config.dataDir);
  const reportingPushHolder: { svc?: import('./push.js').PushService } = {};
  const reportingService = new ReportingService(config.dataDir, {
    syncStore: syncHubStore,
    notify: (notice) =>
      reportingPushHolder.svc
        ? reportingPushHolder.svc.notify({
            kind: notice.kind,
            botId: notice.botId,
            botName: notice.botName,
            title: notice.title,
            body: notice.body,
          })
        : Promise.resolve({ attempted: 0, sent: 0 }),
  });
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
  // SCH-13: routine self-pause on durable blocks. The policy is built
  // once the routine store exists (below); the executor wrap is applied
  // after registerRoutineRoutes returns — see the self-pause block
  // further down.
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
      // Anchor resolution (Part 5): time-based schedules default to the
      // cloud when one is connected. The operative "cloud connected"
      // signal is a configured sync target (a deployed, paired instance);
      // manual/webhook-only routines follow their bot's placement side.
      resolveAnchor: ({ schedule, botId, explicitAnchor }) =>
        resolveRoutineAnchor({
          schedule,
          explicitAnchor,
          botPlacement: placementStore.getBot(botId).placement,
          cloudConnected: readSyncTarget(config.dataDir) !== null,
        }),
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
  // Generic monitors (#91) with ORIGIN-session binding (#88): a monitor
  // started inside a session steers its digest back into THAT session
  // (GenericMonitorService.originOf, bound by the monitor_start tool
  // from the tool-call ctx); monitors with no origin log instead.
  const monitorService = new GenericMonitorService({
    onDigest: (monitorId, digest) => {
      const origin = monitorService.originOf(monitorId);
      if (origin) {
        agentRuntime.enqueueSteer(origin, digest);
      } else {
        console.log(`[monitor ${monitorId}]`, digest);
      }
    },
  });
  for (const tool of createScheduleTools(routineStore, { monitors: monitorService })) {
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

  // SCH-13: wrap the executor so EVERY settled run passes the
  // self-pause policy (durable blocks pause on first failure; transient
  // failures at 3 consecutive). The policy + its router are shared with
  // the Wave-6 mount block below.
  const { RoutineSelfPausePolicy, createSelfPauseSettler } = await import('./routine-self-pause.js');
  const selfPausePolicy = new RoutineSelfPausePolicy(config.dataDir, {
    routines: routineStore,
    runs: routineRunStore,
    failureThreshold: 3,
  });
  {
    const settler = createSelfPauseSettler(
      selfPausePolicy,
      (runId) => routineRunStore.get(runId)?.routineId,
      routineRunStore,
    );
    const originalExecute = routineRunExecutor.execute.bind(routineRunExecutor);
    routineRunExecutor.execute = (opts) =>
      originalExecute({
        ...opts,
        onSettled: (result) => {
          try {
            settler(result);
          } catch {
            // Self-pause must never break a run's settle path.
          }
          opts.onSettled?.(result);
        },
      });
  }

  // Companion app (phone → PC remote control). The hub is created here (not
  // in routes.ts) so the WebSocket upgrade handler below shares the same
  // instance as the REST routes. Approval lifecycle events raised anywhere
  // (web chat, workflows, MCP) are pushed live to connected phones; the app
  // refetches the full list on push.
  const { CompanionStore, CompanionHub } = await import('./companion.js');
  const companionStore = new CompanionStore(config.dataDir);
  // CompanionHub is a value here (dynamic import); name its instance type.
  let companionHub!: InstanceType<typeof CompanionHub>;

  // Companion session commands (#96) + elicitation answers (#51):
  // - turnAbortRegistry is shared with the chat router (createRouter
  //   deps below) so WS 'cancel' aborts the very turn the chat route is
  //   running, and 'prompt' steers into the session's turn queue.
  // - The SessionCommandService is built lazily (its full deps — incl.
  //   tiered memory for /done distillation — exist later in boot); the
  //   holder is filled in the mounts block below.
  // - The WS elicitation bridge is registered on the shared default
  //   router's 'ws' surface; client answers return via elicitationResolve.
  const turnAbortRegistry = new Map<string, { controller: AbortController; botId: string; startedAt: number }>();
  const sessionOverlays = new SessionOverlayStore(config.dataDir);
  const sessionCommandServiceHolder: { service?: SessionCommandService } = {};
  const elicitationBridge = createWsElicitationBridge((frame) => {
    companionHub.broadcast(frame as never);
  });
  registerCompanionElicitationSurface(defaultElicitationRouter, elicitationBridge);

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
      // Session commands over WS (#96): slash frames dispatch through
      // the same SessionCommandService as the HTTP surface; prompt
      // steers into the session; cancel aborts via the shared registry;
      // model has no per-session override store on this host and says so.
      onSessionCommand: async (cmd) => {
        const sessionId = cmd.sessionId ?? '';
        if (cmd.type === 'prompt') {
          if (!sessionId || !cmd.text) return { handled: false, reason: 'prompt needs sessionId and text' };
          return { handled: true, steer: agentRuntime.enqueueSteer(sessionId, cmd.text) };
        }
        if (cmd.type === 'cancel') {
          const live = sessionId ? turnAbortRegistry.get(sessionId) : undefined;
          if (!live) return { handled: false, reason: 'no live turn for that session' };
          live.controller.abort('cancelled from companion app');
          return { handled: true };
        }
        if (cmd.type === 'model') {
          return { handled: false, reason: 'per-session model override is not supported on this host' };
        }
        const service = sessionCommandServiceHolder.service;
        if (!service) return { handled: false, reason: 'session commands are still starting up' };
        if (!sessionId || !cmd.text) return { handled: false, reason: 'slash needs sessionId and text' };
        const botId = agentRuntime.sessionStore.getSession(sessionId)?.botId ?? seed.bots[0]?.id ?? '';
        return service.execute(sessionId, botId, cmd.text);
      },
      // Elicitation answers from companion clients (#51).
      elicitationResolve: elicitationBridge.resolveByFrame,
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
  const platformMcpServerOptions = buildPlatformMcpServerOptions({
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
  const platformMcpServer = new PlatformMcpServer(platformMcpServerOptions);

  // Built-in MCP server suite (Octomind parity #52): with
  // KRIYADOT_MCP_SUITE=1 the platform ALSO serves five focused servers
  // (core / orchestration / runtime / agent / local — per-tool filters,
  // chat only on 'agent', telemetry only on 'runtime') alongside the
  // single full-surface server above, which stays the routes dep.
  // Suite servers are served on MCP_SERVER_PORT+1..+5 when HTTP serving
  // is on (see the serve block below); construction is inert otherwise.
  const { createPlatformMcpServerSuite } = await import('@mvp/agent-runtime');
  const platformMcpSuite =
    process.env.KRIYADOT_MCP_SUITE === '1'
      ? createPlatformMcpServerSuite(platformMcpServerOptions)
      : null;
  if (platformMcpSuite) {
    console.log(`[mcp] built-in server suite enabled: ${platformMcpSuite.ids().join(', ')}`);
  }

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
    // Executor gate (Part 5): this server fires a routine only when its
    // anchor matches this server's role ('cloud' instance vs local).
    shouldExecute: (routine) => shouldExecuteForRole(routine.anchor, frontdoorRole),
    // Reporting (Part 5): settled runs go through the ReportingService —
    // sync activity record + instant notice via the same PushService
    // holder pattern as notifyRoutinePaused, quiet hours respected.
    onRunReported: (info) => {
      void reportingService
        .reportRun({ routine: info.routine, ok: info.ok, error: info.error, at: info.at })
        .catch(() => {});
    },
    // Per-tick reporting upkeep: flush notices deferred by quiet hours,
    // and on the cloud role compose the once-a-day digest of anchored
    // automation runs (stored as sync activity + a local record).
    onSchedulerTick: (now) => {
      void reportingService.flushPending(now).catch(() => {});
      if (frontdoorRole === 'cloud') {
        try {
          // The digest summarizes a COMPLETED day: compose yesterday's
          // digest (once — the service dedupes by date) from its runs.
          const dayStart = new Date(now);
          dayStart.setHours(0, 0, 0, 0);
          const yStart = dayStart.getTime() - 24 * 60 * 60 * 1000;
          const date = new Date(yStart).toISOString().slice(0, 10);
          const runs: Array<{ routineId: string; routineName: string; status: string; error?: string | null }> = [];
          for (const r of routineStore.list()) {
            for (const run of routineRunStore.listByRoutine(r.id, 50)) {
              if (run.createdAt >= yStart && run.createdAt < dayStart.getTime() && run.status !== 'queued' && run.status !== 'running') {
                runs.push({ routineId: r.id, routineName: r.name, status: run.status, error: run.error });
              }
            }
          }
          reportingService.maybeCreateDailyDigest({ date, runs, now });
        } catch {
          // Digest composition must never break the scheduler tick.
        }
      }
    },
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
    // Suite partitions (#52) on the following ports, when enabled.
    if (platformMcpSuite) {
      let offset = 0;
      for (const id of platformMcpSuite.ids()) {
        offset += 1;
        try {
          const served = await platformMcpSuite.get(id).serveHttp({ port: mcpPort + offset });
          console.log(`[mcp] suite server "${id}" on ${served.url}`);
        } catch (err) {
          console.warn(`[mcp] suite server "${id}" failed to serve:`, (err as Error).message);
        }
      }
    }
  }

  // MCP-native tool transport (Octomind parity #48, OPT-IN):
  // KRIYADOT_TOOL_TRANSPORT=mcp routes built-in tool calls through an
  // in-process MCP facade — a real protocol round-trip over a loopback
  // transport pair — instead of direct handler invocation. The facade
  // is built from a SNAPSHOT of the registry (its server side dispatches
  // to the original handlers; wrapping the live map would recurse).
  // Default stays 'direct'. Known limits of the mcp mode: the facade
  // server invokes handlers with a fixed ToolContext
  // ({ sessionId: 'mcp-facade', botId: 'mcp-facade' }) because MCP has
  // no caller-context channel — per-bot workspace/session-scoped tools
  // degrade there, while runtime governance (evaluated before the
  // handler choke point) still sees the real caller; results round-trip
  // the MCP wire format; tools registered after this point (runtime
  // plugin loads) keep direct handlers.
  let mcpFacade: Awaited<ReturnType<typeof createMcpFacade>> | null = null;
  if (toolTransportFromEnv() === 'mcp') {
    try {
      mcpFacade = await createMcpFacade([...toolRegistry.values()], {
        pinDbPath: path.join(config.dataDir, 'mcp-pins.db'),
      });
      const facadeNames = new Set((await mcpFacade.listTools()).map((t) => t.name));
      let wrapped = 0;
      for (const [name, def] of toolRegistry) {
        if (!facadeNames.has(name)) continue;
        const facade = mcpFacade;
        toolRegistry.set(name, {
          ...def,
          handler: (args, ctx) => facade.callTool(name, args, ctx),
        });
        wrapped += 1;
      }
      console.log(`[mcp] tool transport: mcp facade (${wrapped} built-in tools routed through the protocol path)`);
    } catch (err) {
      console.warn('[mcp] facade failed to start; falling back to direct tool transport:', (err as Error).message);
      mcpFacade = null;
    }
  }

  // 4. HTTP layer. API routes first, then the frontend.
  const app = express();
  // §4.10 routers (services constructed with the tool registrations
  // above): outbound calls, phone SMS, proactive editions.
  app.use('/api/calls', createOutboundCallRouter({ service: outboundCalls, provider: telephonyProvider }));
  app.use('/api/phone-sms', createPhoneSmsRouter({ service: phoneSmsService }));
  app.use('/api/proactive', createProactiveEditionRouter({ service: proactiveEditions }));
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
  // serverBasePath is kept for the WebSocket upgrade handler at the end of
  // boot(): upgrade requests bypass Express, so the handler strips the
  // prefix itself (QA 2026-10-30: WS endpoints were unreachable under a
  // base path because the upgrade switch only matched unprefixed paths).
  let serverBasePath = '';
  {
    const { createBasePathMiddleware, basePathFromEnv } = await import('./base-path.js');
    serverBasePath = basePathFromEnv();
    if (serverBasePath) {
      app.use(createBasePathMiddleware(serverBasePath));
      console.log(`[api] serving under base path ${serverBasePath}`);
    }
  }
  app.use(cors({ origin: corsOriginFn }));
  app.use(
    requireLoopbackAuth(loopbackToken, {
      // A paired phone may call POST /api/chat directly with its companion
      // device token; the chat handler re-validates + audits it (routes.ts).
      isCompanionChatToken: (bearer) => companionStore.findDeviceByToken(bearer) !== undefined,
    }),
  );
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
    // CA-37: incognito sessions never write to long-term memory.
    if (sessionId && !agentRuntime.sessionAllowsMemoryWrite(sessionId)) return;
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
      let voicePack: import('@mvp/agent-runtime').MemoryPack | undefined;
      try {
        voicePack = await tieredMemoryStore.buildMemoryPackNeural(bot.id, message, {
          tokenBudget: 512,
          // #74: project/role-scoped recall when the bot declares a scope.
          scope: bot.memoryScope,
        });
        memoryContext = tieredMemoryStore.renderMemoryPack(voicePack) || undefined;
      } catch {
        voicePack = undefined;
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
      // #78: credit material use after the completed turn, mirroring
      // the chat route — atom usage feeds retention/promotion.
      try {
        if (voicePack) tieredMemoryStore.creditPackUse(voicePack.id, voicePack.atomIds);
      } catch {
        // Crediting must never break calls.
      }
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
      let voicePack: import('@mvp/agent-runtime').MemoryPack | undefined;
      try {
        voicePack = await tieredMemoryStore.buildMemoryPackNeural(bot.id, message, {
          tokenBudget: 512,
          // #74: project/role-scoped recall when the bot declares a scope.
          scope: bot.memoryScope,
        });
        memoryContext = tieredMemoryStore.renderMemoryPack(voicePack) || undefined;
      } catch {
        voicePack = undefined;
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
      // #78: credit material use after the completed turn, mirroring
      // the chat route — atom usage feeds retention/promotion.
      try {
        if (voicePack) tieredMemoryStore.creditPackUse(voicePack.id, voicePack.atomIds);
      } catch {
        // Crediting must never break calls.
      }
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
  reportingPushHolder.svc = pushService;
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
  // Wave-5 shared stores (memory/goals finishes + ideas loops below).
  const wave5Mdb = new ModuleDb(path.join(config.dataDir, 'muse-modules.db'));
  const { GoalFinishesStore } = await import('@mvp/muse-modules');
  const goalFinishesStore = new GoalFinishesStore(wave5Mdb);
  const { ReflectionStore, reflectionBriefingItems } = await import('./reflective-dreaming.js');
  const reflectionStore = new ReflectionStore(config.dataDir);
  // SI-2 / SI-1 / SI-3 named routines: the schedule + visibility surface.
  // The deterministic loop executors run from host timers (dreamer block
  // + the loop timers further below) — never both paths for one loop.
  {
    const { ensureReflectionRoutine } = await import('./reflective-dreaming.js');
    const { ensureGoalStudyRoutine, ensureSkillAuditRoutine } = await import('./idea-loops.js');
    for (const bot of seed.bots) {
      try {
        ensureReflectionRoutine(routineStore, bot.id);
        ensureGoalStudyRoutine(routineStore, bot.id);
        ensureSkillAuditRoutine(routineStore, bot.id);
      } catch {
        // Routine registration must never break boot.
      }
    }
  }
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
    // SI-2 reflective dreaming: nightly synthesis (worked / ruptured /
    // becoming + repair threads) chained after the idea dreamer.
    const { ReflectiveDreamer } = await import('./reflective-dreaming.js');
    const reflectiveDreamer = new ReflectiveDreamer({
      store: reflectionStore,
      episodesForBot: (botId) =>
        tieredMemoryStore
          .getAtoms(botId, 50)
          .map((a) => (a as { fact?: string }).fact ?? '')
          .filter((s) => s.trim().length > 0),
      outcomesForBot: () => [],
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
          void (async () => {
            await dreamer.runForBots(seed.bots.map((b) => b.id)).catch(() => undefined);
            // SI-2 reflection, then I-6: fresh dreams are curated into
            // the Ideas tab, stale ideas expire, due goal briefings run.
            if (!pauseRegistry.isPaused()) {
              await reflectiveDreamer.runForBots(seed.bots.map((b) => b.id)).catch(() => undefined);
              try {
                const { runDreamCuration } = await import('./ideas-ext-routes.js');
                runDreamCuration({
                  mdb: wave5Mdb,
                  dreamCandidates: () => dreamStore.list(undefined, 20),
                  isPaused: () => pauseRegistry.isPaused(),
                });
                const { IdeaStore } = await import('@mvp/muse-modules');
                new IdeaStore(wave5Mdb).expireStale();
                goalFinishesStore.generateDueBriefings();
              } catch {
                // Curation/expiry must never break the nightly chain.
              }
            }
          })();
        }
      } catch {
        // Dreaming must never break the server.
      }
    }, 3_600_000);
    if (typeof dreamTimer.unref === 'function') dreamTimer.unref();
  }

  // SI-1 daily goal study (07:00) + SI-3 weekly skill audit (Mon ~04:00)
  // — host timers invoking the deterministic loop executors (the named
  // routines registered above are the schedule/visibility surface only).
  {
    const { DailyGoalStudyLoop, GoalStudyStore, SkillAuditLoop, QuietMomentSweep } = await import('./idea-loops.js');
    const { CommitmentStore } = await import('@mvp/muse-modules');
    const goalStudy = new DailyGoalStudyLoop({
      mdb: wave5Mdb,
      store: new GoalStudyStore(config.dataDir),
      research: async (goal) => {
        const bot = seed.bots[0];
        const provider = createProvider(bot?.provider ?? 'groq');
        const res = await provider.chat(
          [
            {
              role: 'user',
              content: `Write one short research-briefing paragraph for the goal "${goal.title}" (${goal.description ?? ''}). Recent progress: ${goal.progress}%. Focus on the next concrete step and one relevant fact.`,
            },
          ],
          [],
          { model: bot?.model ?? 'default' },
        );
        return res.content ?? '';
      },
      signals: () => {
        const out: string[] = [];
        try {
          for (const c of new CommitmentStore(wave5Mdb).list()) {
            const t = (c as { title?: string }).title;
            if (t) out.push(t);
          }
        } catch {
          // Signals are best-effort.
        }
        try {
          for (const a of tieredMemoryStore.getAtoms(seed.bots[0]?.id ?? '', 20)) {
            const f = (a as { fact?: string }).fact;
            if (f) out.push(f);
          }
        } catch {
          // Signals are best-effort.
        }
        return out;
      },
      isPaused: () => pauseRegistry.isPaused(),
    });
    const skillAudit = new SkillAuditLoop({ dataDir: config.dataDir, isPaused: () => pauseRegistry.isPaused() });
    let lastStudyDay = '';
    let lastAuditWeek = '';
    const loopTimer = setInterval(() => {
      try {
        const now = new Date();
        const day = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
        if (now.getHours() >= 7 && lastStudyDay !== day) {
          lastStudyDay = day;
          void goalStudy.run().catch(() => undefined);
        }
        const week = `${now.getFullYear()}-w${Math.floor(now.getDate() / 7)}-${now.getMonth()}`;
        if (now.getDay() === 1 && now.getHours() >= 4 && lastAuditWeek !== week) {
          lastAuditWeek = week;
          skillAudit.run();
        }
      } catch {
        // Loop timers must never break the server.
      }
    }, 3_600_000);
    loopTimer.unref();
    // SI-4 quiet-moment internalisation sweep: bounded memory capture
    // after inactivity. Activity is approximated from live turns.
    const { MemoryJournal, capturePass } = await import('@mvp/agent-runtime');
    const quietJournal = new MemoryJournal(config.dataDir);
    const quietSweep = new QuietMomentSweep({
      idleMs: 20 * 60 * 1000,
      maxPerSweep: 25,
      internalise: async (limit) => {
        let processed = 0;
        const perBot = Math.max(1, Math.ceil(limit / Math.max(1, seed.bots.length)));
        for (const bot of seed.bots) {
          try {
            processed += capturePass(tieredMemoryStore, quietJournal, bot.id, { maxEvents: perBot }).eventsScanned;
          } catch {
            // Per-bot capture failures are isolated.
          }
        }
        return processed;
      },
      isPaused: () => pauseRegistry.isPaused(),
    });
    const quietTimer = setInterval(() => {
      try {
        if (turnTracker.listActive().length > 0) quietSweep.noteActivity();
        quietSweep.tick();
      } catch {
        // The sweep must never break the server.
      }
    }, 60_000);
    quietTimer.unref();
  }

  // ---- Wave-6 surfaces (§4.14 devices/home, §4.15 platform, ADD-5,
  // ADD-7 leftovers) — mounted before the main router like Wave 5. ----
  {
    const audit = (action: string, fields: Record<string, unknown>) => governance.audit(action, fields as never);
    // DV-9 binding settings + DV-13 grant management (user surfaces).
    const osBindingRouter = express.Router();
    registerOsBindingRoutes(osBindingRouter, { config: osBindingConfig, audit });
    app.use('/api/os-binding', osBindingRouter);
    const homeProxyRouter = express.Router();
    registerHomeProxyRoutes(homeProxyRouter, { proxy: homeProxy, store: hostGrantStore });
    app.use('/api/home-proxy', homeProxyRouter);
    // DV-17/18/19 network connector + DV-4 health sync.
    const { TailscaleConnector } = await import('./tailscale-connector.js');
    const { TailnetApprovalStore } = await import('./tailnet-tcp.js');
    const { registerNetworkRoutes } = await import('./network-routes.js');
    const networkRouter = express.Router();
    registerNetworkRoutes(networkRouter, {
      connector: new TailscaleConnector({ stateDir: path.join(config.dataDir, 'network'), audit }),
      approvals: new TailnetApprovalStore(path.join(config.dataDir, 'network')),
      audit,
    });
    app.use('/api/network', networkRouter);
    const { registerHealthSyncRoutes } = await import('./health-sync-routes.js');
    const healthSyncRouter = express.Router();
    registerHealthSyncRoutes(healthSyncRouter, {
      store: new (await import('./health-sync.js')).HealthSyncStore(config.dataDir),
      audit,
    });
    app.use('/api/health-sync', healthSyncRouter);
    // DA-1 data export (FL-7 link rail) + DA-2 full reset (real
    // active-turn counter — reset refuses mid-turn unless forced).
    const { createDataExportRouter } = await import('./data-export.js');
    const { FileLinkService } = await import('./file-links.js');
    app.use(
      '/api',
      createDataExportRouter({
        dataDir: config.dataDir,
        workspaceDir: config.workspaceDir,
        fileLinks: new FileLinkService(config.dataDir),
      }),
    );
    const { createFullResetRouter } = await import('./full-reset.js');
    app.use(
      '/api',
      createFullResetRouter({
        dataDir: config.dataDir,
        workspaceDir: config.workspaceDir,
        activeTurns: () => turnTracker.listActive().length,
      }),
    );
    // SCH-13 pauses surface (policy + executor wrap live further up).
    const { createRoutineSelfPauseRouter } = await import('./routine-self-pause.js');
    app.use('/api', createRoutineSelfPauseRouter({ policy: selfPausePolicy }));
    // SCH-14 hook lifecycle: registry + routes. Bot-config script hooks
    // are registered as managed records (start disabled, secret-scanned);
    // their existing unmanaged bus installs keep firing unchanged —
    // lifecycle management is opt-in per the registry's own surface.
    const { HookLifecycleRegistry, createHookLifecycleRouter } = await import('./hook-lifecycle.js');
    const hookLifecycle = new HookLifecycleRegistry(config.dataDir, { maxConsecutiveFailures: 3 });
    try {
      const { hooksFromConfig } = await import('@mvp/agent-runtime');
      const scriptEntries = seed.bots.flatMap((bot) => {
        try {
          return hooksFromConfig(bot as { hooks?: unknown }).entries.filter(
            (e) => (e as { kind?: string }).kind === 'script' || typeof (e as { command?: unknown }).command === 'string',
          );
        } catch {
          return [];
        }
      });
      if (scriptEntries.length > 0) hookLifecycle.registerScriptHooks(scriptEntries as never);
    } catch {
      // Lifecycle registration is best-effort at boot.
    }
    app.use('/api', createHookLifecycleRouter({ registry: hookLifecycle }));
    // SCH-5 supervised services: real handles only; no restart seams
    // exist in-process, so the panel honestly shows "restarts with the
    // app" for every entry.
    const { SupervisedServiceRegistry, SUPERVISED_SERVICE_IDS, createSupervisedServicesRouter } = await import('./supervised-services.js');
    const supervisedServices = new SupervisedServiceRegistry({});
    supervisedServices.register({
      id: SUPERVISED_SERVICE_IDS.routines,
      name: 'Routines engine',
      description: 'Fires scheduled routines and webhook triggers.',
      probe: () => ({
        status: 'running',
        detail: `${routineStore.list().filter((r) => r.enabled).length} routines enabled`,
      }),
    });
    supervisedServices.register({
      id: SUPERVISED_SERVICE_IDS.dreamer,
      name: 'Dreamer',
      description: 'Nightly dreaming + reflective synthesis and idea curation.',
      probe: () => ({ status: 'running', detail: `${dreamStore.list(undefined, 500).length} dreams stored` }),
    });
    supervisedServices.register({
      id: SUPERVISED_SERVICE_IDS.connectors,
      name: 'Connector sync',
      description: 'Per-connector background sync gates + reauth surfacing.',
      probe: () => ({ status: 'running', detail: 'sync engine mounted; toggles in the Permissions pane' }),
    });
    supervisedServices.register({
      id: SUPERVISED_SERVICE_IDS.sync,
      name: 'Account sync',
      description: 'History sync through the user\'s own instance (front-door build).',
      probe: () => ({ status: 'running', detail: 'sync endpoints mounted on this instance' }),
    });
    app.use('/api', createSupervisedServicesRouter({ registry: supervisedServices }));
    // ADD-5: computer-use setup flow routes (explainer → OS checks →
    // self-test → enable). Grants no standing allow.
    const { registerComputerUseSetupRoutes } = await import('./computer-use-setup.js');
    registerComputerUseSetupRoutes(app, { dataDir: config.dataDir, audit, loopbackToken });
    // CA-31 projects + CA-36 analysis (router + bot tool).
    const { createProjectsRouter } = await import('./projects.js');
    app.use(
      '/api/projects',
      createProjectsRouter({
        dataDir: config.dataDir,
        bindSession: (sessionId, projectId) => agentRuntime.sessionStore.setSessionProject(sessionId, projectId),
      }),
    );
    const { createAnalysisRouter, createAnalysisTool } = await import('./analysis.js');
    app.use('/api', createAnalysisRouter({}));
    const analysisTool = createAnalysisTool({});
    if (!toolRegistry.has(analysisTool.name)) toolRegistry.set(analysisTool.name, analysisTool as never);
    // CA-34 folder sessions (export/validate/plan; materialize seam
    // intentionally unbound — plans are produced, host stores apply).
    const { registerFolderSessionRoutes } = await import('./folder-session.js');
    const folderSessionRouter = express.Router();
    registerFolderSessionRoutes(folderSessionRouter, { allowedRoot: config.workspaceDir, audit });
    app.use('/api/folder-sessions', folderSessionRouter);
    // CA-24 plugin UI contributions (default OFF; manifest + CSP gate).
    const { registerPluginUiRoutes } = await import('./plugin-ui-routes.js');
    const { pluginManifestToUnified } = await import('@mvp/plugins');
    const pluginUiRouter = express.Router();
    registerPluginUiRoutes(pluginUiRouter, {
      enabled: process.env.PLUGIN_UI_ENABLED,
      resolveContribution: (pluginId) => {
        const plugin = pluginManager.list().find((p) => p.id === pluginId && p.enabled);
        if (!plugin) return undefined;
        let unified;
        try {
          unified = pluginManifestToUnified(plugin.manifest as never);
        } catch {
          return undefined;
        }
        if (!unified.uiContribution) return undefined;
        const entryPath = path.join(plugin.dir, unified.uiContribution.entry);
        if (!entryPath.startsWith(plugin.dir)) return undefined;
        try {
          return { contribution: unified.uiContribution, html: fs.readFileSync(entryPath, 'utf8') };
        } catch {
          return undefined;
        }
      },
      audit,
    });
    app.use('/api/plugin-ui', pluginUiRouter);
    // CA-33 .mcpb import: same governance prompt as directory installs
    // (deny-by-default when no approval is granted).
    const { importMcpbBundle } = await import('@mvp/agent-runtime');
    const mcpbRouter = express.Router();
    mcpbRouter.post('/import-mcpb', async (req, res) => {
      try {
        const base64 = typeof req.body?.bundleBase64 === 'string' ? req.body.bundleBase64 : '';
        if (!base64) {
          res.status(400).json({ error: 'bundleBase64 is required' });
          return;
        }
        const result = await importMcpbBundle(Buffer.from(base64, 'base64'), {
          approve: async (info) => {
            const approvalId = governance.requestApproval(
              'mcp_install',
              { label: info.label, manifest: info.manifest as never },
              { sessionId: 'mcpb-import', botId: 'mcpb-import', actor: 'user' },
            );
            const verdict = await governance.awaitDecision(approvalId, 120_000);
            return verdict === 'approved';
          },
          store: lazyMcpManager.store,
          audit,
        });
        res.json({ ok: true, bundle: result.bundle, installed: result.installed ?? null });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });
    app.use('/api/mcp-directory', mcpbRouter);
  }
  {
    const audit = (action: string, fields: Record<string, unknown>) => governance.audit(action, fields as never);
    // CA-22 GitHub-native agent: signed comment webhooks → governed
    // routine runs; reviews post only under an explicit policy allow
    // for the synthetic tool github_submit_review (approval-gated by
    // default — the webhook flow never bypasses governance).
    const { registerGithubAgentRoutes } = await import('./github-agent.js');
    const { submitReview } = await import('./github.js');
    const ghAgentRouter = express.Router();
    registerGithubAgentRoutes(ghAgentRouter, {
      secret: process.env.GITHUB_WEBHOOK_SECRET ?? '',
      dispatchRun: async ({ repo, number, task }) => {
        const bot = seed.bots[0];
        if (!bot) throw new Error('no bot configured for GitHub agent runs');
        const routine = routineStore.create({
          name: `GitHub ${repo}#${number}`,
          botId: bot.id,
          promptTemplate: task,
        });
        const runId = await routineRunExecutor.execute({ routine, trigger: 'webhook', message: task });
        return { runId };
      },
      reviewPullRequest: async ({ repo, number, instruction }) => {
        const bot = seed.bots[0];
        if (!bot) throw new Error('no bot configured for GitHub reviews');
        let out = '';
        await agentRuntime.runTurn({
          bot,
          sessionId: `github-review-${repo.replace(/\//g, '-')}-${number}-${Date.now()}`,
          message:
            `You are reviewing pull request ${repo}#${number} on GitHub. The maintainer's instruction: ${instruction}\n\n` +
            'You do not have the diff in this flow — review the request itself: state what you would check, any risks you can identify from the instruction, and finish with exactly one verdict line: "VERDICT: COMMENT", "VERDICT: APPROVE", or "VERDICT: REQUEST_CHANGES".',
          onEvent: async (event) => {
            if (event.type === 'token') out += event.content;
          },
        });
        const verdict = /VERDICT:\s*(APPROVE|REQUEST_CHANGES|COMMENT)/.exec(out)?.[1] ?? 'COMMENT';
        return { body: out.replace(/VERDICT:\s*(APPROVE|REQUEST_CHANGES|COMMENT)/, '').trim(), event: verdict as 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES' };
      },
      postReview: async ({ repo, number, body, event }) => {
        const decision = await governance.evaluate('github_submit_review', { repo, number }, { botId: 'github-agent', sessionId: 'github-agent', actor: 'github-agent' });
        if (decision.effect !== 'allow') {
          throw new Error(
            'posting GitHub reviews is approval-gated: add an allow rule for github_submit_review or post reviews from the app',
          );
        }
        const [owner, repoName] = repo.split('/');
        return submitReview({ owner: owner ?? '', repo: repoName ?? '', number, body, event });
      },
      audit,
    });
    app.use('/api/github-agent', ghAgentRouter);
    // CA-32 artifact model calls: host-brokered (artifacts never hold a
    // key), per-user vault key when configured, daily spend cap via the
    // shared cost ledger, fail-closed. NOTE: public artifact pages keep
    // their script-less CSP — the bridge is for app-side surfaces; the
    // public-page CSP amendment is deliberately NOT taken in this build.
    const { registerArtifactModelRoutes } = await import('./artifact-model.js');
    const { PagePublicationStore } = await import('./public-pages.js');
    const { SecureVault } = await import('@mvp/vault');
    const { CostTracker } = await import('@mvp/billing');
    const artifactCostTracker = new CostTracker(path.join(config.dataDir, 'billing.db'));
    const artifactRouter = express.Router();
    const pagePublications = new PagePublicationStore(config.dataDir);
    registerArtifactModelRoutes(
      artifactRouter,
      {
        findPublication: (slug) => pagePublications.getBySlug(slug),
        resolveProviderKey: (userId) => {
          try {
            return new SecureVault(config.dataDir).get(`artifact-provider-key-${userId}`)?.value;
          } catch {
            return undefined;
          }
        },
        callProvider: async ({ apiKey, prompt, system, maxOutputTokens }) => {
          const bot = seed.bots[0];
          const provider = createProvider(bot?.provider ?? 'groq', apiKey ? { apiKey } : undefined);
          const res = await provider.chat(
            [
              ...(system ? [{ role: 'system' as const, content: system }] : []),
              { role: 'user' as const, content: prompt },
            ],
            [],
            { model: bot?.model ?? 'default', maxTokens: maxOutputTokens },
          );
          const usage = (res.usage ?? {}) as { inputTokens?: number; outputTokens?: number; promptTokens?: number; completionTokens?: number };
          const inputTokens = usage.inputTokens ?? usage.promptTokens ?? 0;
          const outputTokens = usage.outputTokens ?? usage.completionTokens ?? 0;
          return {
            text: res.content ?? '',
            model: bot?.model ?? 'default',
            inputTokens,
            outputTokens,
            costCents: Math.max(1, Math.round((inputTokens + outputTokens) / 1000)),
          };
        },
        checkCap: ({ userId }) => {
          const budget = Number(process.env.ARTIFACT_MODEL_DAILY_BUDGET_CENTS ?? 500);
          const startOfDay = new Date();
          startOfDay.setHours(0, 0, 0, 0);
          const spent = artifactCostTracker.spentCents({ since: startOfDay.getTime(), until: Date.now(), botId: userId });
          return spent < budget
            ? { allowed: true }
            : { allowed: false, message: `artifact model daily budget reached (${spent}/${budget} cents)` };
        },
        recordCost: (e) =>
          artifactCostTracker.record({
            feature: 'artifact-model',
            step: e.slug,
            botId: e.userId,
            model: e.model,
            inputTokens: e.inputTokens,
            outputTokens: e.outputTokens,
            costCents: e.costCents,
          }),
        audit,
      },
      (req) => resolvePrincipal(req as never, { dataDir: config.dataDir, loopbackToken })?.userId ?? '',
    );
    app.use('/api/artifacts', artifactRouter);
  }

  // CN-3: widen the google OAuth preset to the core-suite scopes BEFORE
  // the OAuth routes inside the main router serve connect flows.
  registerGoogleWorkspaceProvider();
  // PUR-6: filled in when the browser suite mounts (after this router).
  const browserTakeoverHolder: { manager?: import('./browser-takeover.js').BrowserTakeoverManager } = {};

  // ---- Wave-5 surfaces (mounted BEFORE the main router so specific
  // paths — /ideas/ranked, /why, /library — are never shadowed) ----
  {
    const { createMemoryGoalsRouter } = await import('./memory-goals-routes.js');
    const { ChannelSideChatStore } = await import('./channel-side-chats.js');
    const { listTrackedItems } = await import('@mvp/muse-modules');
    const { TaskStore } = await import('./tasks.js');
    app.use(
      '/api/memory-goals',
      createMemoryGoalsRouter({
        dataDir: config.dataDir,
        memory: tieredMemoryStore,
        searchMessages: (q, opts) => agentRuntime.sessionStore.searchMessages(q, opts),
        // Same SQLite file the WhatsApp parity wiring writes (read-side
        // store instance; the parity handle keeps the write side).
        sideChats: new ChannelSideChatStore(config.dataDir),
        audit: (action, fields) => governance.audit(action, fields),
        goalFinishes: goalFinishesStore,
        listTrackedItems: (opts) =>
          listTrackedItems(wave5Mdb, {
            tasks: () => new TaskStore(config.dataDir).list(),
            kind: opts.kind as never,
            status: opts.status as never,
            goalId: opts.goalId,
          }),
      }).router,
    );
  }
  {
    const { createIdeasExtRouter } = await import('./ideas-ext-routes.js');
    const { createWhyRouter } = await import('./why-routes.js');
    app.use(
      '/api',
      createIdeasExtRouter({
        mdb: wave5Mdb,
        dreamCandidates: () => dreamStore.list(undefined, 20),
        memoryContext: () =>
          tieredMemoryStore
            .getAtoms(seed.bots[0]?.id ?? '', 50)
            .map((a) => (a as { fact?: string }).fact ?? '')
            .filter((s) => s.trim().length > 0),
        isPaused: () => pauseRegistry.isPaused(),
      }),
    );
    app.use(
      '/api',
      createWhyRouter({
        dataDir: config.dataDir,
        mdb: wave5Mdb,
        auditSearch: (q) =>
          governance
            .listAudit(500)
            .filter((e) => JSON.stringify(e).toLowerCase().includes(q.toLowerCase()))
            .map((e) => ({
              action: e.action,
              actor: (e as { actor?: string }).actor,
              detail: (e as { detail?: unknown }).detail,
              ts: typeof (e as { ts?: unknown }).ts === 'number' ? (e as { ts: number }).ts : undefined,
            })),
      }),
    );
  }
  {
    // §4.5 chat surfaces: Library (C-15/FL-11/FL-14), share intake
    // (C-11), provider conversations (C-5), per-message share/delete
    // (C-12/C-9), bot avatars (C-16), iOS readiness (C-13 source prep).
    const { createLibraryRouter } = await import('./library-routes.js');
    const { ArtifactStore, SlideDeckStore, resolveMediaProvider } = await import('@mvp/muse-modules');
    app.use(
      '/api',
      createLibraryRouter({
        dataDir: config.dataDir,
        workspaceDir: config.workspaceDir,
        artifacts: new ArtifactStore(wave5Mdb),
        decks: new SlideDeckStore(wave5Mdb),
        media: () => [],
        audit: (action, fields) => governance.audit(action, fields),
      }),
    );
    const { ShareIntakeStore, createShareIntakeRouter } = await import('./share-intake.js');
    app.use('/api', createShareIntakeRouter({ store: new ShareIntakeStore(config.dataDir) }));
    const { createProviderConversationsRouter } = await import('./provider-conversations.js');
    const { ChannelSideChatStore } = await import('./channel-side-chats.js');
    app.use('/api', createProviderConversationsRouter({ store: new ChannelSideChatStore(config.dataDir) }));
    const { createMessageShareRouter } = await import('./message-share.js');
    const { MessageDeletionStore, createMessageDeleteRouter, filterDeletedMessages } = await import('./message-delete.js');
    const messageDeletions = new MessageDeletionStore(config.dataDir);
    app.use(
      '/api',
      createMessageShareRouter({
        dataDir: config.dataDir,
        listThreadMessages: (id) => filterDeletedMessages(messageDeletions, id, agentRuntime.listThreadMessages(id)),
      }),
    );
    const { resolvePrincipal } = await import('./principal.js');
    app.use(
      '/api',
      createMessageDeleteRouter({
        store: messageDeletions,
        listThreadMessages: (id) => agentRuntime.listThreadMessages(id),
        sessionOwnerId: (id) => agentRuntime.sessionStore.getSession(id)?.ownerPersonId ?? null,
        requesterId: (req) => resolvePrincipal(req as never, { dataDir: config.dataDir, loopbackToken })?.userId ?? 'you',
        audit: (action, fields) => governance.audit(action, fields),
      }),
    );
    const { BotAvatarStore, createBotAvatarRouter } = await import('./bot-avatar-media.js');
    app.use(
      '/api',
      createBotAvatarRouter({
        store: new BotAvatarStore(config.dataDir),
        provider: resolveMediaProvider(),
        getBot: (id) => botsById.get(id) ?? null,
        audit: (action, fields) => governance.audit(action, fields),
      }),
    );
    const { createIosReadinessRouter } = await import('./ios-readiness.js');
    app.use(
      '/api',
      createIosReadinessRouter({
        facts: () => ({
          apsEnvironment: 'development',
          hasDevelopmentTeam: Boolean(process.env.IOS_DEVELOPMENT_TEAM),
          bundleId: 'com.kriyadot.companion',
        }),
      }),
    );
  }
  {
    // CN-3 status surface + CN-10 sync routes + CN-2 mailbox settings.
    const { registerGoogleWorkspaceRoutes } = await import('./google-workspace.js');
    registerGoogleWorkspaceRoutes(app, { dataDir: config.dataDir });
    const { ConnectorSyncEngine, registerConnectorSyncRoutes } = await import('./connector-sync.js');
    const connectorSyncEngine = new ConnectorSyncEngine({ dataDir: config.dataDir });
    void connectorSyncEngine;
    registerConnectorSyncRoutes(app, {
      dataDir: config.dataDir,
      engine: connectorSyncEngine,
      bots: seed.bots.map((b) => ({ id: b.id })),
      loopbackToken,
    });
    const { registerMailboxSettingsRoutes } = await import('./mailbox-settings.js');
    registerMailboxSettingsRoutes(app, { dataDir: config.dataDir, loopbackToken });
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
      // Shared with the companion WS hub: WS 'cancel' aborts live chat
      // turns through this very registry (routes.ts uses it as its
      // activeTurns map when provided).
      turnAbortRegistry,
      // Per-session /role + /skill overlays (session commands write,
      // the chat route applies them per turn).
      sessionOverlays,
      mcpServer: platformMcpServer,
      mcpScopeStore,
      threadScheduleStore,
      checkpointStore,
      dotStore,
      preferenceStore,
      phone: { store: phoneStore, hub: phoneHub, adb: phoneAdb },
      // Global pause (W14d): the chat route refuses new turns while paused.
      pauseRegistry,
      // PUR-6: lazy BR-9 takeover manager for purchase takeover.
      browserTakeoverHolder,
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
      // SI-2: reflective-dreaming items ride the same briefing section.
      dreamsSource: () => [...dreamBriefingItems(dreamStore), ...reflectionBriefingItems(reflectionStore)],
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
      // Cloud-only gate (Part 5): per-bot chat refuses locally when the
      // bot's placement is cloud-only and this is not the cloud instance.
      isCloudOnlyBot: (botId) => frontdoorRole !== 'cloud' && placementStore.isCloudOnly(botId),
      // Per-boot loopback token: the companion /chat/send proxy presents it
      // on its inner call to /api/chat (the proxy itself is device-authed).
      loopbackToken,
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
  // ---------------------------------------------------------------------
  // Octomind closure mounts (2026-10-30): routers built by the closure
  // workstreams, wired here. All sit behind the loopback auth middleware
  // mounted earlier (none of these paths is auth-exempt).
  {
    const { createSessionCommandService, createSessionCommandsRouter } = await import('./session-commands-routes.js');
    const { createWorkflowSurfaceRouter } = await import('./workflow-surface-routes.js');
    const { createTapRouter } = await import('./tap-routes.js');
    const { createDiscoveryRouter, createIntentSearchTool } = await import('./discovery-routes.js');
    const { createDaemonInjectRouter, NamedSessionRegistry } = await import('./daemon-inject-routes.js');
    const { createLogLevelRouter } = await import('./log-level.js');
    const { createEvolutionRouter } = await import('./evolution-routes.js');
    const { createCloudLightningRouter } = await import('./cloud-routes.js');
    const { VaultCloudSecretStore, LIGHTNING_USER_ID_SECRET } = await import('./cloud-lightning.js');
    const { createScriptWebhookRouter } = await import('./webhooks.js');
    const { scriptHooksFromConfig } = await import('./hooks-config.js');
    const { runStartupBootstrap } = await import('./boot-bootstrap.js');
    const { MarketplaceRegistry, MarketplaceInstaller } = await import('@mvp/marketplace');
    const { SkillLoader } = await import('@mvp/agent-runtime');

    const audit = (action: string, fields: { actor?: string; detail?: unknown }): void => {
      governance.audit(action, fields as never);
    };

    // -- Session commands (#114 + /role /skill overlays, /done #135) ----
    // usageForSession aggregates this host's cost events for the session
    // (the billing CostTracker has no session filter, so events are
    // post-filtered from a bounded window — the same billing.db the
    // billing routes read, via the established WAL multi-connection
    // pattern). Cache figures are not tracked per cost event → null.
    const usageCostTracker = new CostTracker(path.join(config.dataDir, 'billing.db'));
    const sessionCommandDeps = {
      getMessages: (sessionId: string) => agentRuntime.sessionStore.listThreadMessages(sessionId),
      getBotId: (sessionId: string) => agentRuntime.sessionStore.getSession(sessionId)?.botId,
      listArchives: (sessionId: string) =>
        agentRuntime.sessionStore.listArchives(sessionId).map((a) => ({
          id: a.id,
          messageCount: a.messageCount,
          createdAt: a.createdAt,
        })),
      compactNow: (sessionId: string) => agentRuntime.sessionStore.compactNow(sessionId),
      createSession: (botId: string) => agentRuntime.sessionStore.createSession(botId),
      // /done runs the REAL distill pipeline (#77 machinery: grounded
      // verbatim quotes, session citation, reflection kickoff when a
      // chat fn is available — here the pipeline runs without one, so
      // reflection is skipped and the result says so).
      runDistillPipeline: (botId: string, sessionId: string) => {
        // CA-37: incognito sessions are never distilled (memory-only).
        if (!agentRuntime.sessionAllowsMemoryWrite(sessionId)) {
          return Promise.resolve({
            botId,
            sessionId,
            turns: 0,
            stored: 0,
            rejected: 0,
            atomIds: [],
            reflection: null,
          });
        }
        return tieredMemoryStore.runDistillPipeline(botId, sessionId);
      },
      // CA-17: /style — backed by the shared OutputStyleStore (the same
      // instance the turn context provider reads selections from).
      sessionStyle: {
        list: (userId: string) => outputStyleStore.list(userId),
        get: (userId: string, name: string) => outputStyleStore.get(userId, name),
        getSession: (sessionId: string) => outputStyleStore.getSessionStyle(sessionId),
        setSession: (sessionId: string, userId: string, styleName: string | null) =>
          outputStyleStore.setSessionStyle(sessionId, userId, styleName),
      },
      // /share (closure #114): publish the session transcript as a
      // public page — same store + renderer as the REST share routes.
      shareSession: (sessionId: string) => {
        const rendered = renderTranscriptMarkdown(agentRuntime, sessionId);
        if (!rendered) throw new Error('Nothing to share yet — the session has no messages.');
        const pub = new PagePublicationStore(config.dataDir).publishArtifact({
          title: rendered.title,
          content: rendered.markdown,
          contentKind: 'markdown',
        });
        return { slug: pub.slug, path: publicPathForSlug(pub.slug) };
      },
      // /learning (closure #114): tiered-memory atoms back list / show /
      // delete / clear; evolution acts on the persisted learned routing
      // rules (approve = promote shadow → active; reject and rollback =
      // retire, the routing module's documented rollback state).
      learning: {
        list: (botId: string) =>
          tieredMemoryStore.getAtoms(botId, 200).map((a) => ({
            id: a.id,
            category: a.category,
            fact: a.fact,
            pinned: a.pinned,
          })),
        show: (botId: string, id: string) => tieredMemoryStore.getAtom(botId, id) ?? null,
        remove: (botId: string, id: string) => tieredMemoryStore.deleteAtom(botId, id),
        clear: (botId: string) => {
          let removed = 0;
          for (const atom of tieredMemoryStore.getAtoms(botId, 5000, { includeInactive: true })) {
            if (tieredMemoryStore.deleteAtom(botId, atom.id)) removed += 1;
          }
          return removed;
        },
        evolution: (action: 'approve' | 'reject' | 'rollback', id: string) => {
          let rules = loadRoutingRules(config.dataDir);
          if (!rules.some((r) => r.id === id)) {
            throw new Error(`No learned routing rule "${id}".`);
          }
          rules = action === 'approve' ? promoteRule(rules, id) : retireRule(rules, id);
          saveRoutingRules(config.dataDir, rules);
          return rules.find((r) => r.id === id) ?? null;
        },
      },
      usageForSession: (sessionId: string) => {
        const events = usageCostTracker
          .listEvents({ limit: 5000 })
          .filter((e) => e.sessionId === sessionId);
        return {
          promptTokens: events.reduce((s, e) => s + e.inputTokens, 0),
          completionTokens: events.reduce((s, e) => s + e.outputTokens, 0),
          totalTokens: events.reduce((s, e) => s + e.inputTokens + e.outputTokens, 0),
          costUsd: events.reduce((s, e) => s + e.costCents, 0) / 100,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          requests: events.slice(0, 50) as unknown as Array<Record<string, unknown>>,
        };
      },
      statusAggregate: () => ({
        bots: seed.bots.length,
        sessions: agentRuntime.sessionStore.listSessions({ limit: 1000 }).length,
        pendingApprovals: governance.listApprovals('pending').length,
        activeTurns: turnAbortRegistry.size,
      }),
      scheduleIntoSession: (
        sessionId: string,
        botId: string,
        cmd: { name: string; prompt: string; whenText: string },
      ) => {
        // Conservative whenText grammar: 5-field cron, "every <N>m|h|d",
        // "in <N>m|h|d", "daily HH:MM", or an ISO datetime. Anything else
        // is rejected loudly rather than silently mis-scheduled.
        const base = { timezone: 'UTC', enabled: true, overlap: 'skip' as const };
        const w = cmd.whenText.trim();
        let schedule: Record<string, unknown>;
        const every = /^every\s+(\d+)\s*([mhd])$/i.exec(w);
        const inMatch = /^in\s+(\d+)\s*([mhd])$/i.exec(w);
        const daily = /^daily\s+(\d{1,2}):(\d{2})$/i.exec(w);
        const toMinutes = (n: string, unit: string): number =>
          Number(n) * (unit.toLowerCase() === 'h' ? 60 : unit.toLowerCase() === 'd' ? 1440 : 1);
        if (every) {
          schedule = { ...base, kind: 'interval', everyMinutes: toMinutes(every[1]!, every[2]!) };
        } else if (inMatch) {
          schedule = {
            ...base,
            kind: 'once',
            runAt: new Date(Date.now() + toMinutes(inMatch[1]!, inMatch[2]!) * 60_000).toISOString(),
          };
        } else if (daily) {
          schedule = {
            ...base,
            kind: 'daily',
            time: `${daily[1]!.padStart(2, '0')}:${daily[2]}`,
            weekdays: [0, 1, 2, 3, 4, 5, 6],
          };
        } else if (/^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/.test(w)) {
          schedule = { ...base, kind: 'cron', expression: w };
        } else if (!Number.isNaN(Date.parse(w))) {
          schedule = { ...base, kind: 'once', runAt: new Date(Date.parse(w)).toISOString() };
        } else {
          throw new Error(
            `Cannot parse schedule "${cmd.whenText}" — use a 5-field cron, "every 30m", "in 2h", "daily 09:00", or an ISO datetime.`,
          );
        }
        const routine = routineStore.create({
          sessionId,
          name: cmd.name || 'Session schedule',
          botId,
          promptTemplate: cmd.prompt,
          schedule: schedule as never,
        });
        return { routineId: routine.id, schedule };
      },
      sessionRole: {
        get: (sessionId: string) => sessionOverlays.getRole(sessionId),
        set: (sessionId: string, role: string | null) => sessionOverlays.setRole(sessionId, role),
      },
      sessionSkills: {
        list: (sessionId: string) => sessionOverlays.listSkills(sessionId),
        pin: (sessionId: string, skillName: string) => sessionOverlays.pinSkill(sessionId, skillName),
        unpin: (sessionId: string, skillName: string) => sessionOverlays.unpinSkill(sessionId, skillName),
        known: () => new SkillLoader(path.join(seedDir, 'skills')).list(),
      },
    };
    const sessionCommandService = createSessionCommandService(sessionCommandDeps);
    sessionCommandServiceHolder.service = sessionCommandService;
    app.use('/api', createSessionCommandsRouter(sessionCommandDeps));

    // -- Supervisor stats (#180): the deep-agent accumulator counters
    // (steers, vetoes, relevance checks) as a read-only surface.
    app.get('/api/supervisor/stats', (_req, res) => {
      res.json({ stats: getSupervisorStats() });
    });

    // -- Workflow file surface (#143/#151) + taps (#153/#171) ------------
    // User-saved workflow definitions persist in
    // <dataDir>/user-workflows.json and register into the same runner
    // the seed workflows use.
    const userWorkflowsPath = path.join(config.dataDir, 'user-workflows.json');
    const loadUserWorkflows = (): void => {
      try {
        const parsed = JSON.parse(fs.readFileSync(userWorkflowsPath, 'utf8')) as {
          workflows?: Array<Record<string, unknown>>;
        };
        for (const def of parsed.workflows ?? []) {
          try {
            workflowRunner.register(def as never);
          } catch (err) {
            console.warn('[workflows] saved definition failed validation, skipping:', (err as Error).message);
          }
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.warn('[workflows] user-workflows.json unreadable:', (err as Error).message);
        }
      }
    };
    const persistUserWorkflow = (def: { id: string }): void => {
      let all: Array<Record<string, unknown>> = [];
      try {
        all = (JSON.parse(fs.readFileSync(userWorkflowsPath, 'utf8')) as { workflows?: Array<Record<string, unknown>> })
          .workflows ?? [];
      } catch {
        all = [];
      }
      const idx = all.findIndex((d) => d.id === def.id);
      if (idx >= 0) all[idx] = def as Record<string, unknown>;
      else all.push(def as Record<string, unknown>);
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(userWorkflowsPath, JSON.stringify({ workflows: all }, null, 2) + '\n', 'utf8');
    };
    loadUserWorkflows();
    const saveWorkflow = (def: { id: string }): unknown => {
      workflowRunner.register(def as never);
      persistUserWorkflow(def);
      return def;
    };
    app.use(
      '/api',
      createWorkflowSurfaceRouter({
        getWorkflow: (id) => workflowRunner.getWorkflow(id) as never,
        saveWorkflow: saveWorkflow as never,
        // #152: run-history reads (dry-run reports + /workflows/runs).
        getRun: (id) => workflowRunner.getRun(id) as never,
        getRunEvents: (run) => runEventsFromRun(run as never) as never,
      }),
    );
    const marketplaceInstaller = new MarketplaceInstaller(path.join(config.dataDir, 'marketplace'));
    app.use(
      '/api',
      createTapRouter({
        installer: marketplaceInstaller,
        dataDir: config.dataDir,
        saveWorkflow: saveWorkflow as never,
      }),
    );

    // -- Discovery / intent search (#166) --------------------------------
    const discoveryDeps = {
      embedder: platformEmbedder,
      items: async () => {
        const items: Array<{ kind: 'bot' | 'skill' | 'mcp' | 'capability'; id: string; name: string; description: string }> = [];
        for (const bot of seed.bots) {
          items.push({ kind: 'bot', id: bot.id, name: bot.name, description: bot.description });
        }
        const skillLoader = new SkillLoader(path.join(seedDir, 'skills'));
        for (const name of skillLoader.list()) {
          const summary = await skillLoader.getSummary(name).catch(() => null);
          items.push({ kind: 'skill', id: name, name, description: summary?.description ?? '' });
        }
        for (const name of Object.keys(seed.mcpServers)) {
          items.push({ kind: 'mcp', id: name, name, description: `MCP server ${name}` });
        }
        try {
          const registry = MarketplaceRegistry.fromFile(path.join(config.dataDir, 'marketplace-registry.json'));
          for (const entry of registry.list({ kind: 'capability' as never })) {
            items.push({ kind: 'capability', id: entry.id, name: entry.name, description: entry.description });
          }
        } catch {
          // No registry file yet (first run) — capabilities are simply absent.
        }
        return items;
      },
    };
    app.use('/api', createDiscoveryRouter(discoveryDeps));
    const intentTool = createIntentSearchTool(discoveryDeps);
    if (!toolRegistry.has(intentTool.name)) toolRegistry.set(intentTool.name, intentTool);

    // -- Daemon inject (#102/#109) ---------------------------------------
    app.use(
      '/api',
      createDaemonInjectRouter({
        registry: new NamedSessionRegistry(),
        enqueueSteer: (sessionId, text) => agentRuntime.enqueueSteer(sessionId, text),
        isTurnRunning: (sessionId) => turnAbortRegistry.has(sessionId),
      }),
    );

    // -- Runtime log level (#181) ----------------------------------------
    app.use('/api', createLogLevelRouter({ audit }));

    // -- Routing evolution reject (#83, reject-only on this host) --------
    app.use('/api/routing', createEvolutionRouter({ dataDir: config.dataDir, only: ['reject'] }));

    // -- Lightning cloud layer (per-user accounts; mock-tested) ----------
    app.use(
      '/api',
      createCloudLightningRouter({
        secretStore: new VaultCloudSecretStore(config.dataDir),
        studioName: 'kriyadot',
        tier: 'free',
        dataDir: config.dataDir,
        loopbackToken,
      }),
    );

    // -- Script webhooks (#67/#101 ingress) -------------------------------
    // Auth model (platform-consistent): non-/api paths are exempt from
    // the loopback token by design (see loopback-auth.ts — the same
    // treatment /api/hooks gets), and the server binds loopback only.
    // The router additionally enforces a per-hook `x-webhook-secret`
    // whenever the host supplies one in `secrets`; bot-config hook
    // entries carry no secret field today, so the record is empty and
    // named hooks are reachable from local processes only.
    app.use(
      '/webhooks',
      createScriptWebhookRouter({
        hooks: () =>
          seed.bots.flatMap(
            (bot) => scriptHooksFromConfig({ hooks: (bot as unknown as { hooks?: unknown }).hooks }).entries,
          ),
        secrets: {},
      }),
    );

    // -- Standalone status (#178) -----------------------------------------
    const bootStartedAt = Date.now();
    app.get('/api/status', (_req, res) => {
      let cloudConnected = false;
      try {
        cloudConnected =
          new VaultCloudSecretStore(config.dataDir).get('default-user', LIGHTNING_USER_ID_SECRET) !== undefined;
      } catch {
        cloudConnected = false;
      }
      res.json({
        ok: true,
        version: '0.1.0',
        uptimeSeconds: Math.round((Date.now() - bootStartedAt) / 1000),
        bots: seed.bots.length,
        sessions: agentRuntime.sessionStore.listSessions({ limit: 1000 }).length,
        pendingApprovals: governance.listApprovals('pending').length,
        activeTurns: turnAbortRegistry.size,
        toolTransport: toolTransportFromEnv(),
        mcpSuite: platformMcpSuite ? platformMcpSuite.ids() : [],
        cloud: { connected: cloudConnected },
      });
    });

    // -- First-run startup bootstrap (#156) -------------------------------
    // The main router above has (re)written marketplace-registry.json by
    // now; the bootstrap consumes the same registry + installer and
    // starts any planned MCP servers not already in the lazy directory.
    try {
      const report = runStartupBootstrap({
        dataDir: config.dataDir,
        registry: MarketplaceRegistry.fromFile(path.join(config.dataDir, 'marketplace-registry.json')),
        installer: marketplaceInstaller,
        startMcpServer: (entry) => {
          const e = entry as {
            label: string;
            command: string;
            args?: string[];
            env?: Record<string, string>;
            enabled?: boolean;
          };
          if (lazyMcpManager.list().some((s) => s.label === e.label)) return;
          const installed = lazyMcpManager.installCustom(e.label, {
            kind: 'stdio',
            command: e.command,
            args: e.args ?? [],
            env: e.env ?? {},
          });
          if (e.enabled === false) lazyMcpManager.setEnabled(installed.id, false);
          refreshMcpStubs();
        },
        audit,
      });
      if (report.mcpStarted.length > 0) {
        console.log(`[bootstrap] started MCP server(s): ${report.mcpStarted.join(', ')}`);
      }
      if (report.blockers.length > 0) {
        console.log(`[bootstrap] blockers: ${report.blockers.join('; ')}`);
      }
    } catch (err) {
      console.warn('[bootstrap] startup bootstrap failed:', (err as Error).message);
    }
  }

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
      // CA-37: incognito threads — content stays memory-only and the
      // session is dropped entirely on close.
      createIncognitoThread: (botId) => agentRuntime.sessionStore.createSession(botId, { incognito: true }),
      closeIncognitoThread: (id) => agentRuntime.sessionStore.closeIncognitoSession(id),
      audit: (action, fields) => governance.audit(action, fields),
      titles: threadTitles,
      // W2: deleting a thread clears its circuit-breaker state so a
      // deleted session can't leak breaker/denial state into a recycled id.
      // CA-13: it also kills the session's background processes.
      onThreadDeleted: (id) => {
        agentRuntime.clearSessionCircuitState(id);
        void import('@mvp/agent-runtime')
          .then((m) => m.defaultProcessRegistry.disposeSession(id))
          .catch(() => undefined);
      },
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
  // §4.6 channel parity (CH-1/2/3/5/6/7/8/9/10): durable WhatsApp side
  // chats (own store, never the main chat), structured button approvals
  // (free text has NO decision path), tappable action cards, unified
  // secure connect flow, reaction bridging into the shared store above.
  {
    const { createChannelParityRouter } = await import('./channel-parity-routes.js');
    const { createWhatsAppTransport } = await import('./whatsapp-cloud.js');
    const { resolveWhatsAppToken, resolveWhatsAppPhoneNumberId } = await import('./messaging.js');
    const { saveProviderKey, removeProviderKey } = await import('./providers.js');
    const channelParity = createChannelParityRouter({
      dataDir: config.dataDir,
      governance,
      audit: (action, fields) => governance.audit(action, fields),
      saveKey: (ref, input) => saveProviderKey(config.dataDir, ref, input),
      removeKey: (ref) => removeProviderKey(config.dataDir, ref),
      reactionStore: messageReactionStore,
      onMessage: async (info) => {
        // Same guarded pattern as the legacy onMention wiring: the turn
        // carries external/relayed provenance, so approvals it mints can
        // never be approved. Reply goes back out over the Cloud transport.
        const defaultBotId = process.env.MESSAGING_DEFAULT_BOT;
        const bot =
          (defaultBotId ? seed.bots.find((b) => b.id === defaultBotId) : undefined) ?? seed.bots[0];
        if (!bot) return;
        let reply = '';
        try {
          await agentRuntime.runTurn({
            bot,
            message: info.text,
            sessionId: `mention-whatsapp-${info.chatId}`,
            provenance: {
              origin: 'external',
              relayPath: ['whatsapp'],
              relayNames: ['whatsapp'],
              timestamp: new Date().toISOString(),
              relayed: true,
            },
            onEvent: async (event) => {
              if (event.type === 'token') reply += event.content;
            },
          });
        } catch (err) {
          console.error('[messaging] whatsapp parity turn failed:', err instanceof Error ? err.message : err);
          return;
        }
        const trimmed = reply.trim();
        if (!trimmed) return;
        try {
          const transport = createWhatsAppTransport({
            token: resolveWhatsAppToken(config.dataDir),
            phoneNumberId: resolveWhatsAppPhoneNumberId(),
          });
          await transport.sendText(info.chatId, trimmed.slice(0, 4000));
        } catch (err) {
          console.error('[messaging] whatsapp parity reply failed:', err instanceof Error ? err.message : err);
        }
      },
    });
    app.use('/api/messaging', channelParity.router);
  }
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

  // Universal Chat: the bot-less front door. One well-known per-user
  // thread anchored on the Chief (or first bot); messages route
  // automatically — direct / specialist / fusion split — through the
  // shared runtime, so governance is identical to per-bot chat.
  app.use(
    '/api/universal',
    createUniversalRouter({
      dataDir: config.dataDir,
      getBots: () => seed.bots,
      getChiefBotId: () => chiefWiring.store.getChiefConfig().chiefBotId,
      agentRuntime,
      audit: (action, fields) => governance.audit(action, fields),
      loopbackToken,
      store: new UniversalChatStore(config.dataDir),
      fusionStore,
      // Front-door Part 5: cloud-only gate + per-task cloud proxying.
      placementStore,
      instanceRole: frontdoorRole,
    }),
  );

  // Front door (Parts 3–5): handoff exchange + frontdoor link, the sync
  // hub + client engine, and placement. The /handoff page lives at the
  // app root (the front door redirects to <instanceUrl>/handoff#t=…);
  // /api/handoff and /api/sync are loopback-exempt because their own
  // credentials (signed handoff token / sync link token / principal) are
  // enforced inside the routers.
  app.get('/handoff', handoffPageHandler);
  app.use('/api', createFrontdoorRouter({ dataDir: config.dataDir, loopbackToken }));
  // Apply-on-receive (front-door Parts 4+5): definitions that arrive via
  // sync become live on this server only where it is their executor —
  // cloud-anchored routines import into the scheduler, pushed bots join
  // the roster; echoes of own definitions are ignored.
  const syncApply = createSyncApply({
    dataDir: config.dataDir,
    store: syncHubStore,
    routineStore,
    bots: seed.bots,
    role: frontdoorRole,
  });
  const syncClientEngine = new SyncClientEngine({
    dataDir: config.dataDir,
    store: syncHubStore,
    sessionStore: agentRuntime.sessionStore,
    getBots: () => seed.bots,
    placementStore,
    getRoutines: () => routineStore.list(),
    origin: frontdoorRole === 'cloud' ? 'cloud' : 'local',
    applyPulled: (items) => {
      syncApply.applyPull(items);
    },
  });
  // Daily digest (Part 5): on the cloud role, once per day, compose the
  // digest of the day's settled automation runs as sync activity (kind
  // 'daily-digest') so it reaches every surface. Checked shortly after
  // boot and on a slow timer; maybeCreateDailyDigest no-ops when the
  // digest already exists for today or nothing ran.
  if (frontdoorRole === 'cloud') {
    const runDailyDigestCheck = (): void => {
      try {
        const now = new Date();
        const pad = (n: number): string => String(n).padStart(2, '0');
        const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
        const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const runs: Array<{ routineId: string; routineName: string; status: string; error?: string | null }> = [];
        for (const r of routineStore.list()) {
          for (const run of routineRunStore.listByRoutine(r.id, 100)) {
            const at = run.endedAt ?? run.startedAt ?? 0;
            if (at >= dayStart && run.status !== 'queued' && run.status !== 'running') {
              runs.push({ routineId: run.routineId, routineName: run.routineName, status: run.status, error: run.error });
            }
          }
        }
        reportingService.maybeCreateDailyDigest({ date: today, runs });
      } catch {
        /* the digest is best-effort */
      }
    };
    setTimeout(runDailyDigestCheck, 20_000).unref?.();
    setInterval(runDailyDigestCheck, 60_000).unref?.();
  }
  app.use(
    '/api',
    createSyncRouter({
      dataDir: config.dataDir,
      store: syncHubStore,
      engine: syncClientEngine,
      loopbackToken,
      applyPush: (payload) => {
        syncApply.applyPush(payload);
      },
      getLocalSessions: () => {
        const out = new Map<string, { sessionId: string; botId: string; messageCount: number; lastMessageTs: string | null }>();
        for (const s of agentRuntime.sessionStore.listSessions({ limit: 200 })) {
          out.set(s.id, { sessionId: s.id, botId: s.botId, messageCount: s.messageCount, lastMessageTs: s.lastMessageTs });
        }
        return [...out.values()];
      },
    }),
  );
  app.use(
    '/api',
    createPlacementRouter({
      dataDir: config.dataDir,
      store: placementStore,
      loopbackToken,
      getBots: () => seed.bots,
      getRoutinesForBot: (botId) => routineStore.list().filter((r) => r.botId === botId),
      hasActiveRunForBot: (botId) =>
        hasActiveRunForBot({
          routines: routineStore.list(),
          listRunsByRoutine: (id, limit) => routineRunStore.listByRoutine(id, limit),
          botId,
        }),
      isSyncConfigured: () => readSyncTarget(config.dataDir) !== null,
      pushPlacement: async ({ botId, bot, placement, executorHere, routines }) => {
        await syncClientEngine.pushPayloadNow({
          bots: [
            {
              botId,
              config: (bot ?? { id: botId }) as Record<string, unknown>,
              placement,
              executorHere,
            },
          ],
          routines: routines.map((r) => ({
            routineId: r.id,
            def: r as unknown as Record<string, unknown>,
            ...(r.anchor ? { anchor: r.anchor } : {}),
          })),
        });
      },
      role: frontdoorRole,
    }),
  );
  syncClientEngine.start();

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
  // Consumer work panel (Muse closure §4.1): live status sentence,
  // day-grouped plain-language work list, run summary, permissions summary.
  {
    const workRouter = express.Router();
    registerWorkPanelRoutes(workRouter, {
      spanStore,
      listRoutineRuns: (limit) => {
        const all: ReturnType<typeof routineRunStore.listByRoutine> = [];
        for (const r of routineStore.list()) {
          for (const run of routineRunStore.listByRoutine(r.id, limit)) all.push(run);
        }
        return all
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, limit) as never;
      },
      listBackgroundRuns: () => agentRuntime.backgroundRuns.list() as never,
      getFirstUserMessage: (sessionId) => {
        try {
          const msg = agentRuntime.sessionStore
            .listThreadMessages(sessionId)
            .find((m) => m.role === 'user');
          if (!msg) return undefined;
          const c: unknown = (msg as { content?: unknown }).content;
          if (typeof c === 'string') return c;
          if (Array.isArray(c)) {
            const text = c
              .map((p) =>
                p && typeof p === 'object' && 'text' in p
                  ? String((p as { text?: unknown }).text ?? '')
                  : '',
              )
              .join(' ')
              .trim();
            return text || undefined;
          }
          return undefined;
        } catch {
          return undefined;
        }
      },
      bots: () => seed.bots,
      dataDir: config.dataDir,
      countPendingApprovals: () => governance.listApprovals('pending').length,
    });
    app.use('/api', workRouter);
  }
  // Permissions & identity pane (Muse closure §4.7): overview/reset,
  // per-connector action trees, allowances, per-item overrides, protocols.
  {
    const permissionsRouter = express.Router();
    registerPermissionsPaneRoutes(permissionsRouter, {
      dataDir: config.dataDir,
      bots: seed.bots,
      audit: (action, fields) => governance.audit(action, fields),
      listApprovals: (status) => governance.listApprovals(status),
      // ADD-5: computer-use setup state rides the single pane.
      computerUseStatus: (userId) => computerUsePaneSummary(config.dataDir, userId),
    });
    app.use('/api', permissionsRouter);
  }
  // Capability registry endpoint (Muse closure ADD-2) + user guide (ADD-3).
  app.use('/api/capabilities', createCapabilitiesRouter({ service: capabilityService }));
  app.use(
    '/api/guide',
    createGuideRouter({
      ...(seed.bots[0]
        ? {
            askLlm: async (prompt: string) => {
              let out = '';
              await agentRuntime.runTurn({
                bot: seed.bots[0],
                message: prompt,
                sessionId: `guide-${Date.now()}`,
                onEvent: async (event) => {
                  if (event.type === 'token') out += event.content;
                },
              });
              return out;
            },
          }
        : {}),
      getCapabilities: () =>
        capabilityService
          .getRegistry()
          .entries.map((e) => ({
            id: e.id,
            name: e.name,
            description: e.whatItDoes,
            whenToUse: e.whenToUse,
          })),
    }),
  );
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
        // CT-12: care sends count toward the proactive daily pacing cap.
        try {
          proactiveEditions.recordExternalSend('proactive-care');
        } catch {
          // Pacing bookkeeping must never break a care send.
        }
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
    app.use('/api', createTenancyDepthRouter({ dataDir: config.dataDir, loopbackToken, audit: (action, fields) => governance.audit(action, fields) }));
  }
  // Expert publishing + organization library + enterprise pack.
  {
    const { createPublishedBotsRouter } = await import('./published-bots-routes.js');
    app.use(
      '/api/published-bots',
      createPublishedBotsRouter({ dataDir: config.dataDir, getBots: () => seed.bots, loopbackToken, audit: (action, fields) => governance.audit(action, fields) }),
    );
    const { createOrgLibraryRouter, OrgLibraryStore } = await import('./org-library.js');
    const { TeamLibraryService } = await import('./team-library-service.js');
    const { TeamStore } = await import('@mvp/agent-runtime');
    const orgLibraryStore = new OrgLibraryStore(config.dataDir);
    app.use(
      '/api/org-library',
      createOrgLibraryRouter({
        dataDir: config.dataDir,
        loopbackToken,
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
    app.use('/api/brand', createBrandRouter({ dataDir: config.dataDir, loopbackToken, audit: (action, fields) => governance.audit(action, fields) }));
    const { createInstallationsRouter, registerSelfInstallation } = await import('./installations.js');
    try {
      registerSelfInstallation(config.dataDir, process.env.KRIYADOT_VERSION ?? '0.1.0');
    } catch {
      // Registration bookkeeping must never break boot.
    }
    app.use(
      '/api/installations',
      createInstallationsRouter({ dataDir: config.dataDir, loopbackToken, audit: (action, fields) => governance.audit(action, fields) }),
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
    return createKbRouter({ dataDir: config.dataDir, store: kbStore, loopbackToken });
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
  // Muse closure §4.8: publish-gated serving (FL-6) replaces plain serving —
  // gated pages serve their approved snapshot; legacy-published pages keep
  // live-content behaviour. Plus expiring file links (FL-7, GET /f/:token)
  // and mini-app public record reads (FL-5).
  const closureFileLinks = new FileLinkService(config.dataDir, { governance });
  registerGatedPublicServing(app, { dataDir: config.dataDir, governance });
  registerFileLinkServing(app, {
    dataDir: config.dataDir,
    workspaceRoot: config.workspaceDir,
    service: closureFileLinks,
  });
  registerPageRecordPublicRoutes(app, { dataDir: config.dataDir });
  // §4.11 browser finishes (BR-7..BR-13): permission suite, takeover +
  // handback, size-classified file grants, question cards into the
  // originating chat (real WidgetCoordinator), protected artifacts on
  // the FL-7 service above, one-checkout-per-window leases, and the
  // BR-8 CAPTCHA policy surface (defensible shape only — pause +
  // takeover; no solver exists to wire). The composed action gate is
  // exposed on the suite handle for the browser runner seams.
  const { createBrowserSuite } = await import('./browser-suite-routes.js');
  const browserSuite = createBrowserSuite({
    dataDir: config.dataDir,
    widgets: widgetCoordinator,
    fileLinks: closureFileLinks,
    workspaceRoot: config.workspaceDir,
    audit: (action, fields) => governance.audit(action, fields),
    config: process.env,
  });
  void browserSuite;
  // PUR-6: purchase takeover routes resolve the BR-9 manager lazily.
  browserTakeoverHolder.manager = browserSuite.takeover;
  app.use('/api/browser', browserSuite.router);
  // Workspace trash (FL-13): purge entries past the 30-day retention daily.
  {
    const purgeTrash = () => {
      try {
        runTrashPurge(config.dataDir);
      } catch {
        // Purge must never break boot or the server loop.
      }
    };
    setTimeout(purgeTrash, 60_000).unref();
    setInterval(purgeTrash, 24 * 60 * 60 * 1000).unref();
  }
  // Checkpoints (CA-4/CA-30): summarize-restore, per-file restore, the
  // session-changes diff endpoint, and the retention sweep (daily).
  {
    const { createCheckpointsRouter } = await import('./checkpoints-routes.js');
    const { createSummarizer } = await import('./summarizer.js');
    const summarize = createSummarizer(undefined, modelProfiles);
    app.use(
      '/api',
      createCheckpointsRouter({
        checkpointStore,
        rewindSession: (sid, keep) => agentRuntime.rewindSession(sid, keep),
        listMessages: (sid) =>
          agentRuntime.listThreadMessages(sid).map((m) => ({ role: m.role, content: m.content })),
        appendMessage: (sid, msg) =>
          agentRuntime.sessionStore.appendMessage(sid, { role: 'user', content: msg.content }),
        summarize: (messages) => summarize(messages as never),
        audit: (action, fields) => governance.audit(action, fields as never),
      }),
    );
    const { runCheckpointRetention } = await import('./checkpoints.js');
    const sweepCheckpoints = () => {
      try {
        runCheckpointRetention(checkpointStore);
      } catch {
        // Retention must never break boot or the server loop.
      }
    };
    setTimeout(sweepCheckpoints, 90_000).unref();
    setInterval(sweepCheckpoints, 24 * 60 * 60 * 1000).unref();
  }
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

  // Built-in TLS (Octop §2.x deployment polish): when TLS_CERT_PATH +
  // TLS_KEY_PATH (or ACME-provisioned certs via ACME_STORE_DIR) yield
  // options, serve HTTPS directly; otherwise plain HTTP as before. An
  // explicitly configured but unreadable static cert/key throws here
  // instead of silently downgrading to HTTP (see tls-options.ts).
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
    let path = req.url?.split('?')[0];
    // Subpath deployments: the client connects to <base>/api/... — strip
    // the prefix before matching (upgrades never pass through the Express
    // base-path middleware).
    if (serverBasePath && path && (path === serverBasePath || path.startsWith(`${serverBasePath}/`))) {
      path = path.slice(serverBasePath.length) || '/';
    }
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
    // Octomind closure resources: cache warmers, generic monitors, the
    // opt-in MCP tool facade, and the MCP suite partitions.
    for (const warmer of cacheWarmers) {
      try {
        warmer.stop();
      } catch {
        // ignore
      }
    }
    try {
      monitorService.stopAll();
    } catch {
      // ignore
    }
    if (mcpFacade) {
      try {
        await mcpFacade.close();
      } catch {
        // ignore
      }
    }
    if (platformMcpSuite) {
      try {
        await platformMcpSuite.closeAll();
      } catch {
        // ignore
      }
    }
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
      // CA-13: no background shell process outlives the server.
      const { defaultProcessRegistry } = await import('@mvp/agent-runtime');
      defaultProcessRegistry.disposeAll();
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
