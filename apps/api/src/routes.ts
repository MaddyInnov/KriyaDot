// SPDX-License-Identifier: Apache-2.0
// HTTP routes for the MVP API. Mounted at /api by src/index.ts.
//
// Package wiring:
// - @mvp/governance (real class) serves the approvals/audit endpoints.
// - @mvp/agent-runtime drives chat via a GovernanceAdapter (see
//   governance-adapter.ts), which bridges the runtime's expected governance
//   surface to the real gateway — including the runtime-generated approval
//   id → real approval id translation.

import express from 'express';
import { BotMemoryStore, SpaceStore, getProviderPreset, isFreeModel, listProviderPresets, readModelsDevCache, resolveApiKey, resolveBotWorkspaceDir, routeMessage } from '@mvp/agent-runtime';
import type { AgentRuntime, BotConfig, StreamEvent, TokenUsage, WidgetCoordinator } from '@mvp/agent-runtime';
import type { PerBotComputerManager } from '@mvp/agent-runtime';
import type { VpsConnectionPool } from '@mvp/agent-runtime';
import type { LazyMcpManager } from '@mvp/agent-runtime';
// pricing.ts is not re-exported from the agent-runtime index (index untouched);
// import the built subpath directly.
import { priceOfModel } from '@mvp/agent-runtime/dist/pricing.js';
import type { ApprovalStatus, GovernanceGateway } from '@mvp/governance';
import { EgressGate } from '@mvp/governance';
import type { TieredItem } from '@mvp/governance';
import type { WorkflowRun, WorkflowRunner } from '@mvp/workflows';
import { createHealthScoring, registerHealthRoutes } from './health-routes.js';
import { registerOmniRoutes } from './omni-routes.js';
import type { OmniCollector, OmniStore } from './omni.js';
import { registerBriefingRoutes } from './briefing-routes.js';
import type { RunHealthStore } from '@mvp/run-health';
import type { AppConfig } from './config.js';
import type { GovernanceAdapter } from './governance-adapter.js';
import type { McpConnection } from './tool-registry.js';
import { rememberAllowedTool, saveBotPolicy } from './bot-policies.js';
import { registerComputerSurfaceRoutes } from './computer-surface-routes.js';
import { registerVpsRoutes } from './vps-routes.js';
import {
  deleteSlashCommand,
  expandSlashCommand,
  loadSlashCommands,
  loadSlashCommandsCached,
  saveSlashCommand,
} from './slash-commands.js';
import { ThreadScheduler, ThreadScheduleStore } from './thread-scheduler.js';
import { CheckpointStore } from './checkpoints.js';
import { DotStore, dotWakePrompt } from './dots.js';
import { EnvironmentManager } from './environments.js';
import { confineFile, listWorkspaceFiles, readWorkspaceFile } from './files.js';
import { saveBotWorkspace } from './bot-workspaces.js';
import { PreferenceStore } from './preferences.js';
import { RecordingStore, recordingToWorkflow } from './recordings.js';
import { registerComputerRecordRoutes } from './computer-record-routes.js';
import { ChatQueueStore } from './chat-queue.js';
import {
  createPullRequest,
  isGitHubConfigured,
  listPullRequests,
  submitReview,
} from './github.js';
// Phase 3: connected apps (OAuth), messaging gateway, notes, tasks/calendar.
import { registerOAuthRoutes } from './oauth.js';
import { registerMcpOAuthRoutes } from './mcp-oauth.js';
import { registerMcpDirectoryRoutes } from './mcp-directory-routes.js';
import { registerModelsDevRoutes } from './models-dev-routes.js';
import type { McpServerConfig } from './seed.js';
import { registerMessagingRoutes } from './messaging.js';
import { registerNotesRoutes } from './notes.js';
import { registerAnnotationRoutes } from './annotations.js';
import { registerKnowledgeRoutes } from './knowledge.js';
// Feature interconnection (P2-E): notes/pages attachable to bot context,
// Inbound-webhook → bot-routine triggers live in bot-routines.ts (mounted in
// index.ts at /api/routines + /webhooks/routines); peer approval for
// delegation is handled by the runtime delegate gate + teams-routes policy
// (single implementation — the duplicate modules were removed).
import { attachNoteContextProvider, registerNoteAttachmentRoutes } from './note-attachments.js';
import { attachSpendCapGate } from './spend-caps.js';
import { registerTasksRoutes } from './tasks.js';
import { registerPagesRoutes } from './pages.js';
import { registerTerminalRoutes } from './terminal-routes.js';
import { registerTeamRoutes } from './teams-routes.js';
import { registerGroupGoalRoutes } from './group-goal-routes.js';
import { registerSpaceRoutes, resolveSpaceForRun, SpaceHttpError, type SpaceRunContext } from './spaces-routes.js';
import { registerPhoneRoutes } from './phone-routes.js';
import type { AdbPhoneProvider } from './phone-adb.js';
import type { PhoneSessionHub, PhoneStore } from './phone.js';
import { getLanIp, registerCompanionRoutes } from './companion-routes.js';
import type { CompanionHub, CompanionStore } from './companion.js';
import { createRemoteScreenRouter } from './remote-screen-routes.js';
import { createVoiceCallRouter } from './voice-call-routes.js';
import { createRealtimeVoiceRouter } from './voice-realtime-routes.js';
import { saveBotVoice } from './bot-voice.js';
import { saveBotApprovalModeForBot } from './bot-approval-modes.js';
import { buildBotChatFn, saveBotMemorySettings, wireMemoryDistillers } from './memory-fabric.js';
import { createMemoryFabricRouter } from './memory-fabric-routes.js';
import { TieredMemoryStore } from '@mvp/agent-runtime';
import { PERSONAS, MBTI_TYPES, QUIZ_QUESTIONS, scoreQuiz, resolvePersona } from '@mvp/agent-runtime';
import { saveBotPersona } from './bot-personas.js';
import { saveBotModel } from './bot-models.js';
// Phase 4: marketplace + billing + tenancy/vault + protocols/voice + muse modules.
import { registerMarketplaceRoutes } from './marketplace.js';
import { registerBillingRoutes } from './billing.js';
import { registerTenancyRoutes } from './tenancy.js';
import { registerVaultRoutes } from './vault.js';
import { registerComposioRoutes } from './composio.js';
import { registerComposioAccountRoutes } from './composio-accounts.js';
import { registerDatabasesRoutes } from './databases.js';
import { registerNotionImportRoutes } from './notion-import.js';
import { registerProtocolRoutes } from './protocols.js';
import { registerVoiceRoutes } from './voice.js';
import { registerMuseModuleRoutes } from './muse-modules.js';
import { registerEntityTraceRoutes } from './entities.js';
import { MarketplaceRegistry, MarketplaceInstaller, RevenueLedger } from '@mvp/marketplace';
import { UsageMeter, BillingLedger, MockBillingProvider, CostTracker } from '@mvp/billing';
import type { McpScopeStore, PlatformToolDef } from '@mvp/agent-runtime';
import { registerMcpToolScopeRoutes } from './mcp-tools-routes.js';
import { registerProcessingRuleRoutes } from './processing-rules-routes.js';
import { registerRedteamRoutes } from './redteam-routes.js';
// Feature #4 (learning-from-corrections routing) + feature #9 (prompt
// overrides): mounted below so corrections and stage-prompt overrides are
// real HTTP surface, not dead modules.
import { registerRoutingLearnRoutes } from './routing-learn-routes.js';
import { registerPromptRoutes } from './prompts-routes.js';
import { loadRoutingRules, logActivePromptOverrides } from '@mvp/agent-runtime';
import type { LearnedRoutingRule } from '@mvp/agent-runtime';
// The marketplace registry ships inside the compiled binary via this JSON
// import (resolveJsonModule); it is seeded into the data dir at boot.
import marketplaceRegistryJson from '@mvp/marketplace/registry/registry.json' with { type: 'json' };
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, createReadStream } from 'node:fs';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { botWorkspacePath } from './bot-workspace-alloc.js';
import {
  connectBridge,
  disconnectBridge,
  isKnownProviderId,
  listProviders,
  removeProviderKey,
  saveProviderKey,
  syncProviderKeysToEnv,
} from './providers.js';
import type {
  ApiError,
  ChatRequestBody,
  DecideApprovalBody,
  DryRunBody,
  PolicySimulateBody,
  ProviderKeyBody,
  RunWorkflowBody,
} from './types.js';
import { extractDocumentText, detectDocKind } from './document-extract.js';

export interface RouteDeps {
  config: AppConfig;
  bots: BotConfig[];
  agentRuntime: AgentRuntime;
  /** Real governance gateway (approvals/audit endpoints). */
  governance: GovernanceGateway;
  /** Adapter bridging the runtime's governance surface to the real gateway. */
  governanceAdapter: GovernanceAdapter;
  workflowRunner: WorkflowRunner;
  mcpConnections: McpConnection[];
  /**
   * Phase 3: two-way MCP server bridge (set by index.ts when MCP_SERVER_PORT
   * is configured). Lets the approvals inbox close the loop on approvals
   * that originated from external MCP clients. listToolDefs() feeds the
   * MCP tool scope settings API.
   */
  mcpServer?: {
    decideApproval(approvalId: string, decision: 'approved' | 'denied'): void;
    listToolDefs(): Promise<PlatformToolDef[]>;
  };
  /**
   * Per-tool MCP scope toggles (mcp-scopes.ts). Shared with the platform
   * MCP server, which enforces them in the tools/call path.
   */
  mcpScopeStore?: McpScopeStore;
  /** Thread automation store (shared with the ThreadScheduler in index.ts). */
  threadScheduleStore: ThreadScheduleStore;
  /** Checkpoint store for rewind (shared with the runtime hook in index.ts). */
  checkpointStore: CheckpointStore;
  /** Dots store (always-on background agents). */
  dotStore: DotStore;
  /** Preference store (learning loop). */
  preferenceStore: PreferenceStore;
  /** Recording store (teach-by-recording). */
  recordingStore: RecordingStore;
  /** Chat message queue (queue-at-boundary steering). */
  chatQueueStore: ChatQueueStore;
  /** MCP server configs (for OAuth-protected servers). */
  mcpServers: Record<string, McpServerConfig>;
  /** Tiered memory store (L0 events → L2 atoms → L3 entity pages). */
  tieredMemoryStore: TieredMemoryStore;
  /** Run health scores + metric samples (features #2/#5). */
  runHealth: RunHealthStore;
  /** Omni rolling-summary store (Omni panel backend, <dataDir>/omni.db). */
  omniStore: OmniStore;
  /** Omni collector (feeds the store from audit/approvals/workflow runs). */
  omniCollector: OmniCollector;
  /**
   * Lazy MCP directory manager (OpenMausBot parity P1 #22). Created by
   * index.ts; installed servers connect on first tool call, never at boot.
   */
  lazyMcpManager?: LazyMcpManager;
  /** Re-sync lazy MCP stubs into the tool registry (owned by index.ts). */
  refreshMcpStubs?: () => void;
  /**
   * Per-bot computers (OpenMausBot parity P1 #14). Created by index.ts; the
   * computer-surface routes (computer-surface-routes.ts) read instance
   * status and change surfaces through it.
   */
  computerManager: PerBotComputerManager;
  /**
   * BYO VPS connection pool (OpenMausBot parity P1 #24). Created by index.ts;
   * the VPS routes (vps-routes.ts) manage profiles and connections through it.
   */
  vpsPool: VpsConnectionPool;
  /**
   * Remote-phone control module (Workspace → Phone tab). Created by index.ts
   * so the WebSocket upgrade handler shares the same hub instance as the
   * REST routes. Optional: omitted in tests that don't exercise phone.
   */
  phone?: {
    store: PhoneStore;
    hub: PhoneSessionHub;
    adb: AdbPhoneProvider;
  };
  /**
   * Companion app module (phone → PC remote control). Created by index.ts
   * so the WebSocket upgrade handler shares the same hub instance as the
   * REST routes. Optional: omitted in tests that don't exercise companion.
   */
  companion?: {
    store: CompanionStore;
    hub: CompanionHub;
  };
  /**
   * Encrypted push notifications (Codync parity). Optional: omitted in tests
   * that don't exercise push; created by index.ts otherwise.
   */
  push?: import('./push.js').PushService;
  /**
   * Remote screen viewing (phone -> PC, Codync parity). Optional: omitted in
   * tests that don't exercise it; created by index.ts otherwise. The WS
   * endpoint (/api/remote-screen/ws) is wired in index.ts's upgrade handler.
   */
  remoteScreen?: {
    store: CompanionStore;
    service: import('./remote-screen.js').RemoteScreenService;
  };
  /**
   * Realtime voice calls with bots (Codync parity). Optional: omitted in
   * tests that don't exercise it; created by index.ts otherwise. The WS
   * endpoint (/api/voice/calls/ws) is wired in index.ts's upgrade handler.
   */
  voiceCall?: {
    service: import('./voice-call.js').VoiceCallService;
  };
  /**
   * Native realtime (speech-to-speech) voice calls (OpenMausBot parity).
   * Optional like voiceCall; the WS endpoint (/api/voice/realtime/ws) is
   * wired in index.ts's upgrade handler.
   */
  realtimeVoice?: {
    service: import('./voice-realtime.js').RealtimeVoiceService;
  };
  /**
   * Group goals (OpenMausBot parity P1 #11): routine-as-goal hook. index.ts
   * passes a mutable holder; registerGroupGoalRoutes fills in
   * `startGroupGoal` once the engine exists, and index.ts forwards it to
   * the RoutineRunExecutor so goal-mode routines start group goals.
   */
  groupGoalHooks?: {
    startGroupGoal?: (args: {
      routine: { id: string; name: string; botId: string };
      prompt: string;
    }) => Promise<string>;
  };
  /**
   * Interactive widgets (OpenMausBot parity P1 #15). Created by index.ts;
   * the chat route passes it into runTurn so `ask_user_question` can pause
   * the turn for a human answer. Optional: omitted in tests that don't
   * exercise widgets.
   */
  widgetCoordinator?: WidgetCoordinator;
}

const TERMINAL_RUN_STATUSES: ReadonlySet<WorkflowRun['status']> = new Set(['succeeded', 'failed']);
const VALID_APPROVAL_STATUSES: ReadonlySet<string> = new Set(['pending', 'approved', 'denied', 'expired']);

function errorBody(error: string, detail?: string): ApiError {
  return detail ? { error, detail } : { error };
}



function isConfiguredSafe(providerId: string): boolean {
  try {
    return Boolean(resolveApiKey(providerId));
  } catch {
    return false;
  }
}

/** Serialize a StreamEvent for SSE. Never throws; never leaks non-JSON values. */
function serializeEvent(event: StreamEvent): string {
  try {
    return JSON.stringify(event);
  } catch {
    return JSON.stringify({ type: 'error', message: 'Failed to serialize agent event' });
  }
}

function sseHeaders(res: express.Response): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
}

/** Normalize an optional model override: empty string falls back to undefined. */
export function createRouter(deps: RouteDeps): express.Router {
  const router = express.Router();
  const { config, bots, agentRuntime, governance, governanceAdapter, workflowRunner, threadScheduleStore, checkpointStore, dotStore, preferenceStore, recordingStore, chatQueueStore, mcpServers, tieredMemoryStore, runHealth, mcpServer, mcpScopeStore, omniStore, omniCollector } = deps;

  // Feature interconnection (P2-E): attached notes/pages land in bot
  // context on every turn (chat, thread wakes, workflow bot-turns).
  // Idempotent — safe if createRouter is called more than once.
  attachNoteContextProvider(agentRuntime, { dataDir: config.dataDir });

  // ---- Run health scoring + regressions (features #2/#5) -------------------
  // Helpers shared by the workflow run payloads below and the /chat turn
  // hook; the /api/health/* routes are registered by registerHealthRoutes.
  const { scoreAndPersistRun, recordTurnHealth } = createHealthScoring(runHealth);

  // Cost dashboard metering (feature #8): ONE shared CostTracker for the
  // whole router — the chat turn hook below records a cost event per turn
  // and the billing routes serve GET /api/usage/breakdown from the same
  // store. Declared up front so the chat route closure can reach it.
  const costTracker = new CostTracker(join(config.dataDir, 'billing.db'));

  // Spend-cap enforcement (OpenMausBot parity P1 #21): attach the default
  // gate factory to the runtime so every runTurn (chat, group rooms,
  // routines, fusion) is hard-stopped BEFORE a provider call that would
  // exceed a global/per-bot daily/monthly cap. Returns the shared store
  // for the billing config routes below.
  const spendCapStore = attachSpendCapGate(agentRuntime, { dataDir: config.dataDir, costTracker });

  // Learning-from-corrections routing (feature #4): learned rules are
  // loaded fresh per chat request (cheap JSON read) and fed into
  // runTurn({ routingRules }); a corrupt/missing file degrades to no
  // learned rules rather than breaking chat.
  const loadChatRoutingRules = (): LearnedRoutingRule[] => {
    try {
      return loadRoutingRules(config.dataDir);
    } catch {
      return [];
    }
  };

  // Mid-turn interruption (Claude Code-style steering): at most one live turn
  // per session. A new message on a session aborts the previous turn — the
  // runtime withdraws its pending approvals fail-closed and emits
  // 'interrupted' on the old stream.
  //
  // The companion app (phone → PC) reads this map for its run list and can
  // abort turns through it (see the runControls passed to the companion
  // routes below); the hub itself never mutates it.
  const activeTurns = new Map<string, { controller: AbortController; botId: string; startedAt: number }>();

  // Resolve a bot's effective workspace root (Octop-style per-bot isolation).
  // Bots without a workspace use the global workspaceDir.
  const botWorkspaceRoot = (botId: string): string => {
    const bot = bots.find((b) => b.id === botId);
    if (!bot) throw new Error(`Unknown bot "${botId}"`);
    return resolveBotWorkspaceDir({
      botWorkspace: bot.workspace,
      globalWorkspaceDir: config.workspaceDir,
      dataDir: config.dataDir,
    });
  };

  router.get('/health', (_req, res) => {
    res.json({
      ok: true,
      groqConfigured: isConfiguredSafe('groq'),
      openRouterConfigured: isConfiguredSafe('openrouter'),
    });
  });

  router.get('/bots', (_req, res) => {
    // Bot configs carry no secrets (system prompts are content, not keys).
    // Include the resolved workspacePath for each bot (Codync parity:
    // auto-allocated per-bot workspaces).
    res.json(
      bots.map((bot) => ({
        ...bot,
        workspacePath: botWorkspacePath(bot, config.dataDir),
      })),
    );
  });

  // ---- Per-bot governance policy ------------------------------------------
  // PUT body: { rules: [{ id, toolPattern, effect: 'allow'|'deny'|'require-approval', reason? }] }.
  // Persisted to <dataDir>/bot-policies.json and applied to the in-memory
  // bot immediately; also applied at boot (see bot-policies.ts).
  router.put('/bots/:id/policy', (req, res) => {
    const body = (req.body ?? {}) as { rules?: unknown };
    try {
      const policy = saveBotPolicy(config.dataDir, bots, req.params.id, body.rules);
      res.json({ ok: true, botId: req.params.id, policy });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.startsWith('Unknown bot') ? 404 : 400;
      res.status(status).json(errorBody('Failed to save bot policy', message));
    }
  });

  // "Always allow this tool" (approval "remember" / "skip approve").
  // Appends a persistent allow rule for one tool to the bot's policy so
  // future calls never raise an approval card. The user clicks it on the
  // approval card itself.
  router.post('/bots/:id/allow-tool', (req, res) => {
    const body = (req.body ?? {}) as { tool?: unknown };
    const tool = typeof body.tool === 'string' ? body.tool.trim() : '';
    if (!tool || !/^[a-zA-Z0-9_:.-]{1,64}$/.test(tool)) {
      res.status(400).json(errorBody('tool is required (1-64 chars: letters, digits, _ : . -)'));
      return;
    }
    try {
      const policy = rememberAllowedTool(config.dataDir, bots, req.params.id, tool);
      res.json({ ok: true, botId: req.params.id, tool, policy });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.startsWith('Unknown bot') ? 404 : 400;
      res.status(status).json(errorBody('Failed to remember tool', message));
    }
  });

  // ---- Per-bot "Works on" computer surfaces (OpenMausBot parity P1 #14) --
  registerComputerSurfaceRoutes(router, {
    bots,
    dataDir: config.dataDir,
    computerManager: deps.computerManager,
    errorBody,
  });

  // ---- BYO VPS (OpenMausBot parity P1 #24) -------------------------------
  registerVpsRoutes(router, {
    bots,
    dataDir: config.dataDir,
    pool: deps.vpsPool,
    audit: (action, fields) => governance.audit(action, fields),
    errorBody,
  });

  // ---- Custom slash commands --------------------------------------------
  // User-defined `/name` commands (the `/work` pattern). A message starting
  // with `/` is expanded through the registry before reaching the agent.
  router.get('/slash-commands', (_req, res) => {
    res.json({ ok: true, commands: loadSlashCommands(config.dataDir) });
  });

  router.post('/slash-commands', (req, res) => {
    const body = (req.body ?? {}) as { name?: unknown; description?: unknown; prompt?: unknown };
    try {
      const commands = saveSlashCommand(config.dataDir, String(body.name ?? ''), {
        description: typeof body.description === 'string' ? body.description : '',
        prompt: typeof body.prompt === 'string' ? body.prompt : '',
      });
      res.json({ ok: true, commands });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json(errorBody('Failed to save slash command', message));
    }
  });

  router.delete('/slash-commands/:name', (req, res) => {
    const ok = deleteSlashCommand(config.dataDir, req.params.name);
    if (!ok) {
      res.status(404).json(errorBody(`Unknown slash command "${req.params.name}"`));
      return;
    }
    res.json({ ok: true, deleted: req.params.name });
  });

  // ---- Thread automations -------------------------------------------------
  // Codex-style "wake this conversation on a schedule": a cron + wake prompt
  // bound to a session. When due, the scheduler runs an agent turn on the
  // session so the agent continues with full conversation context.
  // (Store instance is shared with the ThreadScheduler started in index.ts.)
  const threadSchedules = threadScheduleStore;

  router.get('/thread-schedules', (_req, res) => {
    res.json({ ok: true, schedules: threadSchedules.list() });
  });

  router.post('/thread-schedules', (req, res) => {
    const body = (req.body ?? {}) as {
      botId?: unknown;
      sessionId?: unknown;
      cron?: unknown;
      prompt?: unknown;
      kind?: unknown;
      workflowId?: unknown;
      workflowInput?: unknown;
    };
    try {
      const botId = typeof body.botId === 'string' ? body.botId : '';
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
      if (!bots.find((b) => b.id === botId)) {
        throw new Error(`Unknown bot "${botId}"`);
      }
      if (!sessionId.trim()) throw new Error('sessionId is required');
      // Routines → workflows link: kind 'workflow' starts a workflow run on
      // schedule instead of waking a chat thread.
      const kind = body.kind === 'workflow' ? 'workflow' : 'bot-turn';
      let workflowId: string | undefined;
      if (kind === 'workflow') {
        workflowId = typeof body.workflowId === 'string' ? body.workflowId.trim() : '';
        if (!workflowId) throw new Error('workflowId is required for workflow schedules');
        try {
          workflowRunner.getWorkflow(workflowId);
        } catch {
          throw new Error(`Unknown workflow "${workflowId}"`);
        }
      }
      const s = threadSchedules.create({
        botId,
        sessionId: sessionId.trim(),
        cron: typeof body.cron === 'string' ? body.cron : '',
        prompt: typeof body.prompt === 'string' ? body.prompt : '',
        kind,
        workflowId,
        workflowInput: body.workflowInput,
      });
      res.json({ ok: true, schedule: s });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json(errorBody('Failed to create thread schedule', message));
    }
  });

  router.patch('/thread-schedules/:id', (req, res) => {
    const body = (req.body ?? {}) as { enabled?: unknown };
    const s = threadSchedules.setEnabled(req.params.id, body.enabled !== false);
    if (!s) {
      res.status(404).json(errorBody(`Unknown thread schedule "${req.params.id}"`));
      return;
    }
    res.json({ ok: true, schedule: s });
  });

  router.delete('/thread-schedules/:id', (req, res) => {
    if (!threadSchedules.remove(req.params.id)) {
      res.status(404).json(errorBody(`Unknown thread schedule "${req.params.id}"`));
      return;
    }
    res.json({ ok: true, deleted: req.params.id });
  });

  // ---- Checkpoints / rewind ------------------------------------------------
  // Claude Code Esc+Esc style: snapshots are taken automatically before file
  // mutations (see onBeforeFileMutate in index.ts). Restore modes:
  // 'code' (files only), 'conversation' (history only), 'both'.
  router.get('/sessions/:sessionId/checkpoints', (req, res) => {
    res.json({ ok: true, checkpoints: checkpointStore.list(req.params.sessionId) });
  });

  router.post('/checkpoints/:id/restore', (req, res) => {
    const body = (req.body ?? {}) as { mode?: unknown };
    const mode = body.mode === 'code' || body.mode === 'conversation' || body.mode === 'both' ? body.mode : 'both';
    const cp = checkpointStore.get(req.params.id);
    if (!cp) {
      res.status(404).json(errorBody(`Unknown checkpoint "${req.params.id}"`));
      return;
    }
    const restoredFiles: string[] = [];
    const errors: string[] = [];
    if (mode === 'code' || mode === 'both') {
      const fs = require('node:fs') as typeof import('node:fs');
      for (const [filePath, content] of Object.entries(cp.files)) {
        try {
          if (content === null) {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
          } else {
            fs.writeFileSync(filePath, content, 'utf-8');
          }
          restoredFiles.push(filePath);
        } catch (err) {
          errors.push(`${filePath}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    let messagesRemoved = 0;
    if (mode === 'conversation' || mode === 'both') {
      try {
        messagesRemoved = agentRuntime.rewindSession(cp.sessionId, cp.historyLength);
      } catch (err) {
        errors.push(`history: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    res.json({
      ok: errors.length === 0,
      checkpointId: cp.id,
      mode,
      restoredFiles,
      messagesRemoved,
      errors,
    });
  });

  // ---- Dots (always-on background agents) ---------------------------------
  // A Dot has a responsibility, not a one-off prompt. It wakes on its cron
  // via a backing thread schedule, works in its session, and reports back.
  router.get('/dots', (_req, res) => {
    res.json({ ok: true, dots: dotStore.list() });
  });

  router.post('/dots', (req, res) => {
    const body = (req.body ?? {}) as {
      name?: unknown; responsibility?: unknown; instructions?: unknown;
      botId?: unknown; sessionId?: unknown; cron?: unknown;
    };
    try {
      const botId = typeof body.botId === 'string' ? body.botId : '';
      if (!bots.find((b) => b.id === botId)) {
        throw new Error(`Unknown bot "${botId}"`);
      }
      const dot = dotStore.create({
        name: typeof body.name === 'string' ? body.name : '',
        responsibility: typeof body.responsibility === 'string' ? body.responsibility : '',
        instructions: typeof body.instructions === 'string' ? body.instructions : '',
        botId,
        sessionId: typeof body.sessionId === 'string' ? body.sessionId : '',
        cron: typeof body.cron === 'string' ? body.cron : '',
      });
      // Backing wake mechanism: a thread schedule that fires the Dot's
      // check-in prompt on its session.
      const schedule = threadScheduleStore.create({
        botId: dot.botId,
        sessionId: dot.sessionId,
        cron: dot.cron,
        prompt: dotWakePrompt(dot),
      });
      dotStore.setThreadScheduleId(dot.id, schedule.id);
      res.json({ ok: true, dot: { ...dot, threadScheduleId: schedule.id } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json(errorBody('Failed to create Dot', message));
    }
  });

  router.patch('/dots/:id', (req, res) => {
    const body = (req.body ?? {}) as { enabled?: unknown };
    const dot = dotStore.setEnabled(req.params.id, body.enabled !== false);
    if (!dot) {
      res.status(404).json(errorBody(`Unknown Dot "${req.params.id}"`));
      return;
    }
    if (dot.threadScheduleId) {
      threadScheduleStore.setEnabled(dot.threadScheduleId, dot.enabled);
    }
    res.json({ ok: true, dot });
  });

  router.delete('/dots/:id', (req, res) => {
    const dot = dotStore.get(req.params.id);
    if (!dot) {
      res.status(404).json(errorBody(`Unknown Dot "${req.params.id}"`));
      return;
    }
    if (dot.threadScheduleId) {
      threadScheduleStore.remove(dot.threadScheduleId);
    }
    dotStore.remove(req.params.id);
    res.json({ ok: true, deleted: req.params.id });
  });

  // ---- Dot persistent environments ----------------------------------------
  // Each Dot's "own computer": a long-lived E2B sandbox. The user can
  // inspect/take over via these routes; the Dot's own turns run inside it.
  const envManager = new EnvironmentManager(dotStore);

  router.get('/dots/:id/environment', (req, res) => {
    try {
      res.json({ ok: true, ...envManager.status(req.params.id) });
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      res.status(status).json(errorBody('Failed to get environment status', err instanceof Error ? err.message : String(err)));
    }
  });

  router.post('/dots/:id/environment/exec', async (req, res) => {
    const body = (req.body ?? {}) as { command?: unknown; timeoutMs?: unknown };
    if (typeof body.command !== 'string' || !body.command.trim()) {
      res.status(400).json(errorBody('command is required'));
      return;
    }
    try {
      const result = await envManager.exec(
        req.params.id,
        body.command,
        typeof body.timeoutMs === 'number' && body.timeoutMs > 0 ? Math.min(body.timeoutMs, 300_000) : undefined,
      );
      res.json({ ok: true, ...result });
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      res.status(status).json(errorBody('Environment exec failed', err instanceof Error ? err.message : String(err)));
    }
  });

  router.get('/dots/:id/environment/files', async (req, res) => {
    const path = typeof req.query.path === 'string' && req.query.path ? req.query.path : '/';
    try {
      const files = await envManager.listFiles(req.params.id, path);
      res.json({ ok: true, path, files });
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      res.status(status).json(errorBody('Failed to list environment files', err instanceof Error ? err.message : String(err)));
    }
  });

  router.post('/dots/:id/environment/stop', async (req, res) => {
    try {
      await envManager.stop(req.params.id);
      res.json({ ok: true, stopped: req.params.id });
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      res.status(status).json(errorBody('Failed to stop environment', err instanceof Error ? err.message : String(err)));
    }
  });

  // ---- File browser -------------------------------------------------------
  // Read-only view into config.workspaceDir — where the agent's write_file /
  // edit_file tools land. Powers the Workspace "Files" tab and chat diffs.
  // Paths are workspace-relative; traversal outside the root is rejected.
  router.get('/files', (_req, res) => {
    try {
      res.json({ ok: true, root: config.workspaceDir, files: listWorkspaceFiles(config.workspaceDir) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json(errorBody('Failed to list files', message));
    }
  });

  router.get('/files/content', (req, res) => {
    const rel = typeof req.query.path === 'string' ? req.query.path : '';
    if (!rel || rel.length > 512) {
      res.status(400).json(errorBody('query param "path" is required (workspace-relative)'));
      return;
    }
    try {
      // Validate confinement before reading.
      confineFile(config.workspaceDir, rel);
      const file = readWorkspaceFile(config.workspaceDir, rel);
      res.json({ ok: true, path: rel, ...file });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.includes('escapes') ? 403 : message.includes('Not a file') ? 404 : message.includes('Binary file') ? 422 : 500;
      res.status(status).json(errorBody('Failed to read file', message));
    }
  });

  // ---- Learned preferences ------------------------------------------------
  // The preference learning loop watches approval decisions. When a user
  // consistently denies (or approves) a tool, a preference is learned and
  // future evaluations respect it.
  router.get('/preferences', (req, res) => {
    const botId = typeof req.query.botId === 'string' ? req.query.botId : undefined;
    res.json({ ok: true, preferences: preferenceStore.list(botId) });
  });

  router.delete('/preferences/:id', (req, res) => {
    if (!preferenceStore.remove(req.params.id)) {
      res.status(404).json(errorBody(`Unknown preference "${req.params.id}"`));
      return;
    }
    res.json({ ok: true, deleted: req.params.id });
  });

  // ---- Teach-by-recording -------------------------------------------------
  // Record UI interactions, convert to a workflow. The frontend captures
  // click/input/navigate events while recording.
  router.post('/recordings', (req, res) => {
    const body = (req.body ?? {}) as { name?: unknown };
    const rec = recordingStore.start(typeof body.name === 'string' ? body.name : '');
    res.json({ ok: true, recording: rec });
  });

  router.get('/recordings', (_req, res) => {
    res.json({ ok: true, recordings: recordingStore.list() });
  });

  router.post('/recordings/:id/events', (req, res) => {
    const body = (req.body ?? {}) as { events?: unknown };
    if (!Array.isArray(body.events)) {
      res.status(400).json(errorBody('events must be an array'));
      return;
    }
    const rec = recordingStore.addEvents(req.params.id, body.events as any);
    if (!rec) {
      res.status(404).json(errorBody(`Unknown or stopped recording "${req.params.id}"`));
      return;
    }
    res.json({ ok: true, recording: rec });
  });

  router.post('/recordings/:id/stop', (req, res) => {
    const rec = recordingStore.stop(req.params.id);
    if (!rec) {
      res.status(404).json(errorBody(`Unknown or stopped recording "${req.params.id}"`));
      return;
    }
    res.json({ ok: true, recording: rec });
  });

  router.post('/recordings/:id/convert', (req, res) => {
    const rec = recordingStore.get(req.params.id);
    if (!rec) {
      res.status(404).json(errorBody(`Unknown recording "${req.params.id}"`));
      return;
    }
    if (rec.status === 'recording') {
      res.status(400).json(errorBody('Stop the recording before converting'));
      return;
    }
    const workflow = recordingToWorkflow(rec);
    // TODO: persist via workflowRunner when it supports ad-hoc definitions.
    // For now, return the definition for the UI to save.
    recordingStore.markConverted(rec.id, `recording-${rec.id}`);
    res.json({ ok: true, workflow });
  });

  // ---- Teach-by-recording: computer view ----------------------------------
  // Mount point for the /api/computer/record/* namespace. The computer view
  // (workstream A) POSTs coordinate input events here while the user
  // demonstrates a task; /convert compiles them into a reusable workflow
  // registered with the workflow runner (visible in the Workflows
  // destination). Start/stop/convert are audit-logged inside the factory.
  registerComputerRecordRoutes(router, { recordingStore, workflowRunner, governance });

  // ---- GitHub / PR integration --------------------------------------------
  // Codex-style loop: the agent writes code (write_file/edit_file), reviews
  // (git_status/git_diff), commits (git_commit, approval-gated), pushes
  // (git_push, approval-gated), then opens a PR here. PR creation and reviews
  // are network-mutating, so they go through a governance approval: the
  // endpoint mints an approval, waits for the user's decision in the inbox,
  // and only then calls the GitHub API. Requires GITHUB_TOKEN.
  router.get('/github/status', (_req, res) => {
    res.json({ ok: true, configured: isGitHubConfigured() });
  });

  /** Mint an approval and wait for the user's decision. Returns true if approved. */
  async function requireApproval(
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs = 120_000,
  ): Promise<boolean> {
    const approvalId = governance.requestApproval(toolName, args, {
      sessionId: 'api',
      botId: 'api',
      actor: 'api',
    });
    try {
      const verdict = await governance.awaitDecision(approvalId, timeoutMs);
      return verdict === 'approved';
    } catch {
      return false; // timeout or error → fail closed
    }
  }

  router.post('/github/pr', async (req, res) => {
    const body = (req.body ?? {}) as {
      owner?: unknown; repo?: unknown; title?: unknown;
      head?: unknown; base?: unknown; body?: unknown; draft?: unknown;
    };
    const input = {
      owner: typeof body.owner === 'string' ? body.owner : '',
      repo: typeof body.repo === 'string' ? body.repo : '',
      title: typeof body.title === 'string' ? body.title : '',
      head: typeof body.head === 'string' ? body.head : '',
      base: typeof body.base === 'string' ? body.base : '',
      body: typeof body.body === 'string' ? body.body : '',
      draft: body.draft === true,
    };
    if (!input.owner || !input.repo || !input.title || !input.head || !input.base) {
      res.status(400).json(errorBody('owner, repo, title, head, and base are required'));
      return;
    }
    // Approval gate: the user must approve in the inbox before the PR opens.
    const approved = await requireApproval('github.create_pr', {
      owner: input.owner, repo: input.repo, title: input.title,
      head: input.head, base: input.base,
    });
    if (!approved) {
      res.status(403).json(errorBody('PR creation was not approved'));
      return;
    }
    try {
      const pr = await createPullRequest(input);
      res.json({ ok: true, pr });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.includes('GITHUB_TOKEN') ? 503 : 502;
      res.status(status).json(errorBody('Failed to create PR', message));
    }
  });

  router.get('/github/prs', async (req, res) => {
    const owner = typeof req.query.owner === 'string' ? req.query.owner : '';
    const repo = typeof req.query.repo === 'string' ? req.query.repo : '';
    const state = req.query.state === 'closed' || req.query.state === 'all' ? req.query.state : 'open';
    if (!owner || !repo) {
      res.status(400).json(errorBody('query params "owner" and "repo" are required'));
      return;
    }
    try {
      const prs = await listPullRequests(owner, repo, state);
      res.json({ ok: true, prs });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.includes('GITHUB_TOKEN') ? 503 : 502;
      res.status(status).json(errorBody('Failed to list PRs', message));
    }
  });

  router.post('/github/pr/:number/review', async (req, res) => {
    const body = (req.body ?? {}) as {
      owner?: unknown; repo?: unknown; event?: unknown; body?: unknown;
    };
    const number = Number(req.params.number);
    const input = {
      owner: typeof body.owner === 'string' ? body.owner : '',
      repo: typeof body.repo === 'string' ? body.repo : '',
      number,
      event: body.event as 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT',
      body: typeof body.body === 'string' ? body.body : '',
    };
    if (!input.owner || !input.repo || !input.event) {
      res.status(400).json(errorBody('owner, repo, and event (APPROVE|REQUEST_CHANGES|COMMENT) are required'));
      return;
    }
    // Approval gate: reviewing as a teammate mutates the PR.
    const approved = await requireApproval('github.submit_review', {
      owner: input.owner, repo: input.repo, number: input.number, event: input.event,
    });
    if (!approved) {
      res.status(403).json(errorBody('PR review was not approved'));
      return;
    }
    try {
      const review = await submitReview(input);
      res.json({ ok: true, review });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.includes('GITHUB_TOKEN') ? 503 : 502;
      res.status(status).json(errorBody('Failed to submit review', message));
    }
  });

  // ---- Per-bot persistent memory ----------------------------------------
  // Phase 2: each bot's long-term memory lives at <dataDir>/memories/<botId>.md
  // (see BotMemoryStore). The bots also maintain it themselves via the
  // memory_recall / memory_store tools; these endpoints back the Workspace UI.
  router.get('/bots/:id/memory', (req, res) => {
    const bot = bots.find((b) => b.id === req.params.id);
    if (!bot) {
      res.status(404).json(errorBody('Unknown bot', req.params.id));
      return;
    }
    res.json({ botId: bot.id, content: new BotMemoryStore(config.dataDir).read(bot.id) });
  });

  router.put('/bots/:id/memory', (req, res) => {
    const bot = bots.find((b) => b.id === req.params.id);
    if (!bot) {
      res.status(404).json(errorBody('Unknown bot', req.params.id));
      return;
    }
    const body = (req.body ?? {}) as { content?: unknown };
    if (typeof body.content !== 'string') {
      res.status(400).json(errorBody('Body must be { content: string }'));
      return;
    }
    new BotMemoryStore(config.dataDir).replace(bot.id, body.content);
    res.json({ ok: true, botId: bot.id });
  });

  // ---- Tiered memory (L0 events → L2 atom cards → L3 entity pages) --------
  // Octop parity: distilled durable facts per bot, with keyword recall.
  router.get('/memory/atoms', (req, res) => {
    const botId = typeof req.query.botId === 'string' ? req.query.botId : '';
    if (!botId) {
      res.status(400).json(errorBody('query param "botId" is required'));
      return;
    }
    try {
      res.json({ ok: true, botId, atoms: tieredMemoryStore.getAtoms(botId) });
    } catch (err) {
      res.status(500).json(errorBody('Failed to list memory atoms', err instanceof Error ? err.message : String(err)));
    }
  });

  router.get('/memory/entities', (req, res) => {
    const botId = typeof req.query.botId === 'string' ? req.query.botId : '';
    if (!botId) {
      res.status(400).json(errorBody('query param "botId" is required'));
      return;
    }
    try {
      res.json({ ok: true, botId, entities: tieredMemoryStore.getEntities(botId) });
    } catch (err) {
      res.status(500).json(errorBody('Failed to list entity pages', err instanceof Error ? err.message : String(err)));
    }
  });

  router.delete('/memory/atoms/:id', (req, res) => {
    const botId = typeof req.query.botId === 'string' ? req.query.botId : '';
    if (!botId) {
      res.status(400).json(errorBody('query param "botId" is required'));
      return;
    }
    try {
      if (!tieredMemoryStore.deleteAtom(botId, req.params.id)) {
        res.status(404).json(errorBody(`Unknown atom "${req.params.id}"`));
        return;
      }
      res.json({ ok: true, deleted: req.params.id });
    } catch (err) {
      res.status(500).json(errorBody('Failed to delete atom', err instanceof Error ? err.message : String(err)));
    }
  });

  // ---- Engram parity: pin/unpin, FTS search, session summaries ----------

  router.post('/memory/atoms/:id/pin', (req, res) => {
    const botId = typeof req.query.botId === 'string' ? req.query.botId : '';
    if (!botId) {
      res.status(400).json(errorBody('query param "botId" is required'));
      return;
    }
    try {
      if (!tieredMemoryStore.pinAtom(botId, req.params.id)) {
        res.status(404).json(errorBody(`Unknown atom "${req.params.id}"`));
        return;
      }
      res.json({ ok: true, pinned: req.params.id });
    } catch (err) {
      res.status(500).json(errorBody('Failed to pin atom', err instanceof Error ? err.message : String(err)));
    }
  });

  router.post('/memory/atoms/:id/unpin', (req, res) => {
    const botId = typeof req.query.botId === 'string' ? req.query.botId : '';
    if (!botId) {
      res.status(400).json(errorBody('query param "botId" is required'));
      return;
    }
    try {
      if (!tieredMemoryStore.unpinAtom(botId, req.params.id)) {
        res.status(404).json(errorBody(`Unknown atom "${req.params.id}"`));
        return;
      }
      res.json({ ok: true, unpinned: req.params.id });
    } catch (err) {
      res.status(500).json(errorBody('Failed to unpin atom', err instanceof Error ? err.message : String(err)));
    }
  });

  router.get('/memory/search', (req, res) => {
    const botId = typeof req.query.botId === 'string' ? req.query.botId : '';
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    if (!botId || !q) {
      res.status(400).json(errorBody('query params "botId" and "q" are required'));
      return;
    }
    const limit = Math.min(Math.max(parseInt(typeof req.query.limit === 'string' ? req.query.limit : '20', 10) || 20, 1), 100);
    try {
      res.json({ ok: true, botId, query: q, results: tieredMemoryStore.searchAtoms(botId, q, limit) });
    } catch (err) {
      res.status(500).json(errorBody('Failed to search memories', err instanceof Error ? err.message : String(err)));
    }
  });

  router.post('/memory/summaries', (req, res) => {
    const body = (req.body ?? {}) as { botId?: unknown; sessionId?: unknown; summary?: unknown };
    if (typeof body.botId !== 'string' || typeof body.sessionId !== 'string' || typeof body.summary !== 'string') {
      res.status(400).json(errorBody('Body must be { botId: string, sessionId: string, summary: string }'));
      return;
    }
    try {
      const id = tieredMemoryStore.saveSessionSummary(body.botId, body.sessionId, body.summary);
      res.json({ ok: true, id });
    } catch (err) {
      res.status(500).json(errorBody('Failed to save session summary', err instanceof Error ? err.message : String(err)));
    }
  });

  // ---- Memory fabric (Atomic parity): links, conflicts, reflection -------
  // Typed links between atoms, contradiction conflicts with voting, and
  // the on-demand reflection pass live in their own router (testable in
  // isolation); the per-bot settings overlay stays next to the other
  // /bots/:id/* settings routes below.
  router.use(
    '/memory',
    createMemoryFabricRouter({
      tieredMemoryStore,
      findBot: (id: string) => bots.find((b) => b.id === id),
    }),
  );

  // ---- MBTI personas --------------------------------------------------------
  // Octop parity: 16 personality templates shaping bot tone/working style.
  router.get('/personas', (_req, res) => {
    res.json({
      ok: true,
      personas: MBTI_TYPES.map((t) => {
        const p = PERSONAS[t];
        return { type: p.type, name: p.name, traits: p.traits, communicationStyle: p.communicationStyle };
      }),
      quiz: QUIZ_QUESTIONS,
    });
  });

  router.post('/personas/quiz', (req, res) => {
    const body = (req.body ?? {}) as { answers?: unknown };
    const answers = (body.answers ?? {}) as Partial<Record<'energy' | 'information' | 'decisions' | 'lifestyle', 0 | 1>>;
    for (const [k, v] of Object.entries(answers)) {
      if (!['energy', 'information', 'decisions', 'lifestyle'].includes(k) || (v !== 0 && v !== 1)) {
        res.status(400).json(errorBody('answers must map question id → 0 or 1'));
        return;
      }
    }
    const type = scoreQuiz(answers);
    const persona = PERSONAS[type];
    res.json({
      ok: true,
      type,
      persona: { type: persona.type, name: persona.name, traits: persona.traits, communicationStyle: persona.communicationStyle },
    });
  });

  router.put('/bots/:id/persona', (req, res) => {
    const body = (req.body ?? {}) as { persona?: unknown };
    try {
      const persona = saveBotPersona(config.dataDir, bots, req.params.id, body.persona);
      const template = resolvePersona(persona);
      res.json({
        ok: true,
        botId: req.params.id,
        persona,
        name: template?.name ?? null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.startsWith('Unknown bot') ? 404 : 400;
      res.status(status).json(errorBody('Failed to save persona', message));
    }
  });

  // ---- Per-bot workspace (Octop-style isolation) ---------------------------
  // PUT body: { workspace: string | null }. Empty/null clears → the bot uses
  // the global workspaceDir. Relative values resolve against
  // <dataDir>/workspaces; absolute paths must be inside dataDir.
  // Persisted to <dataDir>/bot-workspaces.json and applied to the in-memory
  // bot immediately; also applied at boot (see bot-workspaces.ts).
  router.put('/bots/:id/workspace', (req, res) => {
    const body = (req.body ?? {}) as { workspace?: unknown };
    try {
      const workspace = saveBotWorkspace(config.dataDir, bots, req.params.id, body.workspace);
      let root: string | null = null;
      try {
        root = botWorkspaceRoot(req.params.id);
      } catch { /* resolution creates the dir; ignore errors here */ }
      res.json({ ok: true, botId: req.params.id, workspace: workspace || null, root });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.startsWith('Unknown bot') ? 404 : 400;
      res.status(status).json(errorBody('Failed to save workspace', message));
    }
  });

  // ---- Per-bot model + options (Codync parity: model picker) ---------------
  // PUT body: { model?: string, modelOptions?: ModelOptions }.
  // Persisted to <dataDir>/bot-models.json and applied to the in-memory
  // bot immediately; also applied at boot (see bot-models.ts).
  router.put('/bots/:id/model', (req, res) => {
    const body = (req.body ?? {}) as { model?: unknown; modelOptions?: unknown };
    try {
      const sel = saveBotModel(config.dataDir, bots, req.params.id, body.model, body.modelOptions);
      res.json({ ok: true, botId: req.params.id, ...sel });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.startsWith('Unknown bot') ? 404 : 400;
      res.status(status).json(errorBody('Failed to save model', message));
    }
  });

  // ---- Per-bot voice-call settings (Codync parity: realtime voice calls) --
  // PUT body: { voice?: VoiceSettings }.
  // Persisted to <dataDir>/bot-voice.json and applied to the in-memory bot
  // immediately; also applied at boot (see bot-voice.ts).
  router.put('/bots/:id/voice', (req, res) => {
    const body = (req.body ?? {}) as { voice?: unknown };
    try {
      const voice = saveBotVoice(config.dataDir, bots, req.params.id, body.voice);
      res.json({ ok: true, botId: req.params.id, voice });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.startsWith('Unknown bot') ? 404 : 400;
      res.status(status).json(errorBody('Failed to save voice settings', message));
    }
  });

  // ---- Per-bot approval modes (Atomic parity: plan/auto/bypass) ---------
  // PUT body: { approvalMode?: 'plan'|'auto'|'bypass' }.
  // Persisted to <dataDir>/bot-approval-modes.json and applied to the
  // in-memory bot immediately; also applied at boot (see
  // bot-approval-modes.ts). 'bypass' is dangerous: the UI must confirm
  // explicitly before sending it.
  router.put('/bots/:id/approval-mode', (req, res) => {
    const body = (req.body ?? {}) as { approvalMode?: unknown };
    try {
      const mode = saveBotApprovalModeForBot(config.dataDir, bots, req.params.id, body.approvalMode);
      res.json({ ok: true, botId: req.params.id, approvalMode: mode });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.startsWith('Unknown bot') ? 404 : 400;
      res.status(status).json(errorBody('Failed to save approval mode', message));
    }
  });

  router.get('/bots/:id/approval-mode', (req, res) => {
    const bot = bots.find((b) => b.id === req.params.id);
    if (!bot) {
      res.status(404).json(errorBody(`Unknown bot "${req.params.id}"`));
      return;
    }
    res.json({ ok: true, botId: bot.id, approvalMode: bot.approvalMode ?? 'auto' });
  });

  // ---- Per-bot memory fabric settings (Atomic parity) ----------------------
  // PUT body: { memoryReflection?: boolean, memoryLiveDistill?: boolean }.
  // Persisted to <dataDir>/bot-memory-settings.json and applied to the
  // in-memory bot immediately (live distiller is re-wired without a
  // restart); also applied at boot (see memory-fabric.ts).
  router.put('/bots/:id/memory-settings', (req, res) => {
    try {
      const settings = saveBotMemorySettings(config.dataDir, bots, req.params.id, req.body ?? {});
      wireMemoryDistillers(bots, tieredMemoryStore);
      res.json({ ok: true, botId: req.params.id, settings });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.startsWith('Unknown bot') ? 404 : 400;
      res.status(status).json(errorBody('Failed to save memory settings', message));
    }
  });

  router.get('/bots/:id/memory-settings', (req, res) => {
    const bot = bots.find((b) => b.id === req.params.id);
    if (!bot) {
      res.status(404).json(errorBody(`Unknown bot "${req.params.id}"`));
      return;
    }
    res.json({
      ok: true,
      botId: bot.id,
      settings: {
        memoryReflection: bot.memoryReflection === true,
        memoryLiveDistill: bot.memoryLiveDistill === true,
      },
    });
  });

  // Read-only file browser scoped to a bot's workspace.
  router.get('/bots/:id/files', (req, res) => {
    try {
      const root = botWorkspaceRoot(req.params.id);
      res.json({ ok: true, botId: req.params.id, root, files: listWorkspaceFiles(root) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.startsWith('Unknown bot') ? 404 : 500;
      res.status(status).json(errorBody('Failed to list bot files', message));
    }
  });

  router.get('/bots/:id/files/content', (req, res) => {
    const rel = typeof req.query.path === 'string' ? req.query.path : '';
    if (!rel || rel.length > 512) {
      res.status(400).json(errorBody('query param "path" is required (workspace-relative)'));
      return;
    }
    try {
      const root = botWorkspaceRoot(req.params.id);
      confineFile(root, rel);
      const file = readWorkspaceFile(root, rel);
      res.json({ ok: true, botId: req.params.id, path: rel, ...file });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.startsWith('Unknown bot')
        ? 404
        : message.includes('escapes')
          ? 403
          : message.includes('Not a file')
            ? 404
            : message.includes('Binary file')
              ? 422
              : 500;
      res.status(status).json(errorBody('Failed to read bot file', message));
    }
  });

  // ---- Chat (SSE) -------------------------------------------------------
  // The stream stays open while approvals are pending: the agent loop awaits
  // governance decisions, and the client decides via POST /api/approvals/:id.
  // Heartbeat comment every 15s keeps proxies from closing idle streams.
  //
  // Steering modes (queueMode):
  // - 'interrupt' (default): abort any in-flight turn on this session, start now.
  // - 'queue': if a turn is in-flight, persist the message and return
  //   { queued: true } immediately; it runs automatically when the current
  //   turn completes (queue-at-boundary). If no turn is in-flight, runs now.
  router.post('/chat', async (req, res) => {
    const body = (req.body ?? {}) as Partial<ChatRequestBody>;
    // Companion app (phone → PC): optional device-token auth. Requests
    // without an Authorization header behave exactly as before; a Bearer
    // token is validated against the companion store when the module is
    // configured, and rejected with 401 when invalid. The action is
    // audit-logged (metadata only, never the message content).
    let companionDevice: { id: string; name: string } | null = null;
    const authHeader = req.headers.authorization;
    if (deps.companion && typeof authHeader === 'string' && /^Bearer\s+/i.test(authHeader)) {
      const presented = authHeader.replace(/^Bearer\s+/i, '').trim();
      const device = presented ? deps.companion.store.findDeviceByToken(presented) : undefined;
      if (!device) {
        res.status(401).json(errorBody('Invalid companion device token'));
        return;
      }
      deps.companion.store.touchDevice(device.id);
      companionDevice = { id: device.id, name: device.name };
    }
    if (typeof body.botId !== 'string' || !body.botId) {
      res.status(400).json(errorBody('botId is required'));
      return;
    }
    if (typeof body.message !== 'string' || !body.message.trim()) {
      res.status(400).json(errorBody('message is required'));
      return;
    }
    const bot = bots.find((b) => b.id === body.botId);
    if (!bot) {
      res.status(404).json(errorBody(`Unknown bot "${body.botId}"`));
      return;
    }
    const chatMessage0 = body.message;
    const sessionId0 = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : null;
    if (companionDevice) {
      governance.audit('companion.chat_send', {
        actor: 'api',
        toolName: 'companion',
        detail: {
          deviceId: companionDevice.id,
          botId: bot.id,
          sessionId: sessionId0,
          messageLength: chatMessage0.length,
          via: 'chat-direct',
        },
      });
    }

    // Spaces: resolve the active space from the `X-KriyaDot-Space` header or
    // the `spaceId` body field. Unknown → 404, paused → 423 (new runs are
    // rejected while a space is paused).
    let spaceCtx: SpaceRunContext | undefined;
    const spaceId = typeof body.spaceId === 'string' && body.spaceId.trim() ? body.spaceId.trim() : undefined;
    try {
      spaceCtx = resolveSpaceForRun({ req, spaceStore, dataDir: config.dataDir, spaceId });
    } catch (err) {
      const status = err instanceof SpaceHttpError ? err.status : 500;
      res.status(status).json(errorBody(err instanceof Error ? err.message : 'Failed to resolve space'));
      return;
    }

    const sessionKey = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : null;
    const queueMode = body.queueMode === 'queue' ? 'queue' : 'interrupt';

    // Custom slash commands: expand `/name args` before the agent sees it.
    // Done before the queue check so queued messages are stored expanded.
    // Unknown `/command` → 400 with the list of known commands.
    let chatMessage = body.message;
    if (chatMessage.trim().startsWith('/')) {
      const expanded = expandSlashCommand(chatMessage, loadSlashCommandsCached(config.dataDir));
      if (expanded === null) {
        const known = Object.keys(loadSlashCommandsCached(config.dataDir));
        res.status(400).json(
          errorBody(
            `Unknown slash command. Known: ${known.length ? known.map((k) => `/${k}`).join(', ') : '(none yet)'}`,
          ),
        );
        return;
      }
      chatMessage = expanded.expanded;
    }

    // Queue-at-boundary: a turn is already running on this session, so
    // persist the (slash-expanded) message instead of aborting. Returns JSON (not SSE).
    if (queueMode === 'queue' && sessionKey && activeTurns.has(sessionKey)) {
      const taskType =
        body.taskType === 'code' || body.taskType === 'chat' || body.taskType === 'reasoning' || body.taskType === 'simple-qa'
          ? body.taskType
          : undefined;
      const { id, position } = chatQueueStore.enqueue({
        sessionId: sessionKey,
        botId: bot.id,
        message: chatMessage,
        provider: typeof body.provider === 'string' && body.provider.trim() ? body.provider.trim() : undefined,
        model: typeof body.model === 'string' && body.model.trim() ? body.model.trim() : undefined,
        reasoningEffort: body.reasoningEffort === 'low' || body.reasoningEffort === 'medium' || body.reasoningEffort === 'high' ? body.reasoningEffort : undefined,
        fileIds: Array.isArray(body.fileIds) ? body.fileIds.filter((x): x is string => typeof x === 'string') : undefined,
        taskType,
        autoApprove: body.autoApprove === true,
        planMode: body.planMode === true,
        maxBudgetUsd: typeof body.maxBudgetUsd === 'number' && body.maxBudgetUsd >= 0 ? body.maxBudgetUsd : undefined,
        sandboxMode: body.sandboxMode === 'read-only' || body.sandboxMode === 'workspace-write' || body.sandboxMode === 'danger-full-access' ? body.sandboxMode : undefined,
      });
      res.json({ ok: true, queued: true, id, position, sessionId: sessionKey });
      return;
    }

    // Companion run controls: a session paused from the phone rejects new
    // turns with 423 until resumed (same pattern as paused Spaces). Queued
    // messages are unaffected — they simply wait for the resume.
    if (sessionKey && deps.companion?.store.isSessionPaused(sessionKey)) {
      res
        .status(423)
        .json(
          errorBody(
            `Session "${sessionKey}" is paused from the companion app — resume it before starting new turns`,
          ),
        );
      return;
    }

    sseHeaders(res);
    let closed = false;
    let terminalEmitted = false;
    const heartbeat = setInterval(() => {
      if (!closed) res.write(': ping\n\n');
    }, 15000);
    const finish = () => {
      clearInterval(heartbeat);
      if (!closed) {
        closed = true;
        res.end();
      }
    };
    // NOTE: listen on the RESPONSE, not the request: under Bun's node:http
    // compat layer req 'close' can fire as soon as the request body is
    // consumed, which would wrongly kill long-lived SSE streams.
    // Client disconnect (Stop button / tab closed / navigation): abort the
    // in-flight turn so it doesn't keep spending tokens in the background.
    // turnController is assigned below; the closure sees the final value.
    let turnController: AbortController | null = null;
    // Tiered-memory per-turn accumulators (reset in runOneTurn).
    let turnAssistantText = '';
    let turnToolCalls: string[] = [];
    res.on('close', () => {
      closed = true;
      clearInterval(heartbeat);
      turnController?.abort('client disconnected');
    });

    // One-line human summary of an approval request for push notifications.
    // Never includes secrets — only the tool name and a short arg hint.
    const summarizeApprovalCall = (call: { name: string; args?: Record<string, unknown> } | undefined): string => {
      if (!call) return 'wants to run a tool';
      const argHint = (() => {
        const a = call.args ?? {};
        for (const k of ['command', 'path', 'file', 'url', 'query', 'text']) {
          const v = a[k];
          if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 120);
        }
        return '';
      })();
      return argHint ? `wants to run ${call.name} (${argHint})` : `wants to run ${call.name}`;
    };

    // Set when a 'spend_cap_reached' push goes out, so the 'error' event
    // the runtime emits right after doesn't double-notify. Declared per
    // chat request (outside onEvent) so it survives across events.
    let spendCapPushSent = false;

    const onEvent = async (event: StreamEvent): Promise<void> => {
      if (closed) return;
      if (event.type === 'done' || event.type === 'error' || event.type === 'interrupted') terminalEmitted = true;
      // Tiered memory: accumulate this turn's assistant text + tool calls for L0.
      if (event.type === 'token') turnAssistantText += event.content;
      else if (event.type === 'tool_call') turnToolCalls.push(event.call.name);
      // Encrypted push (Codync parity): "needs you" on approval requests,
      // "done"/"failed" on terminal turn outcomes. Best-effort, never blocks.
      if (deps.push) {
        const push = deps.push;
        const bId = bot.id;
        const bName = bot.name;
        const chatId = sessionKey ?? undefined;
        if (event.type === 'approval_required') {
          const toolName = typeof event.call?.name === 'string' ? event.call.name : 'tool';
          const summary = summarizeApprovalCall(event.call);
          void push.notifyApprovalNeeded(bId, bName, event.approvalId, toolName, summary).catch(() => {});
        } else if (event.type === 'spend_cap_reached') {
          // Spend-cap hard stop (OpenMausBot parity P1 #21): dedicated
          // push with the cap details; the following 'error' event must
          // not send a second, generic push for the same stop.
          spendCapPushSent = true;
          void push
            .notify({
              kind: 'failed',
              botId: bId,
              botName: bName,
              title: `${bName} — Spend cap reached`,
              body: event.message.slice(0, 400),
              chatId,
            })
            .catch(() => {});
        } else if (event.type === 'done') {
          void push.notifyTurnDone(bId, bName, turnAssistantText, chatId).catch(() => {});
        } else if (event.type === 'error') {
          if (spendCapPushSent) {
            // The dedicated spend-cap push above already covered this stop.
          } else {
            const msg = typeof (event as { message?: unknown }).message === 'string'
              ? (event as { message: string }).message
              : 'The run failed.';
            void push.notifyTurnFailed(bId, bName, msg, chatId).catch(() => {});
          }
        }
      }
      res.write(`data: ${serializeEvent(event)}\n\n`);
    };

    // Abort any in-flight turn on this session before starting the new one.
    // (queueMode 'queue' with an active turn returned early above, so reaching
    // here means interrupt mode or no active turn.)
    turnController = new AbortController();
    if (sessionKey) {
      const prev = activeTurns.get(sessionKey);
      if (prev) prev.controller.abort('superseded by a newer message');
      activeTurns.set(sessionKey, { controller: turnController, botId: bot.id, startedAt: Date.now() });
    }

    // Helper: run one turn's agent loop on this SSE stream.
    const runOneTurn = async (turnMessage: string, turnOpts: {
      providerId?: string; model?: string; taskType?: 'code' | 'chat' | 'reasoning' | 'simple-qa';
      autoApprove?: boolean; planMode?: boolean; maxBudgetUsd?: number;
      sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
      reasoningEffort?: 'low' | 'medium' | 'high';
      fileIds?: string[];
    }): Promise<void> => {
      terminalEmitted = false;
      // Tiered memory: reset per-turn accumulators; recall relevant atoms.
      turnAssistantText = '';
      turnToolCalls = [];
      // Inject attached file contents into the message.
      let messageWithFiles = turnMessage;
      if (turnOpts.fileIds && turnOpts.fileIds.length > 0) {
        const fileSections: string[] = [];
        for (const fid of turnOpts.fileIds) {
          if (!/^[0-9a-f-]{36}$/.test(fid)) continue;
          try {
            const files = readdirSync(join(config.dataDir, 'uploads'));
            const match = files.find((f) => f.startsWith(`${fid}-`) && !f.endsWith('.meta.json'));
            if (!match) continue;
            const filePath = join(config.dataDir, 'uploads', match);
            const metaPath = `${filePath}.meta.json`;
            let name = match;
            let mimeType = 'application/octet-stream';
            try {
              const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { name?: string; mimeType?: string };
              if (meta.name) name = meta.name;
              if (meta.mimeType) mimeType = meta.mimeType;
            } catch {
              // ignore
            }
            // Text-extracted documents (PDF/DOCX/XLSX/PPTX/text): inject
            // extracted content (up to 100KB). Others: note presence.
            const extractedPath = `${filePath}.extracted.txt`;
            let extractedText: string | null = null;
            try {
              extractedText = readFileSync(extractedPath, 'utf8');
            } catch {
              // no cached extraction
            }
            if (extractedText) {
              let meta: { extracted?: { units?: number; unitLabel?: string; truncated?: boolean } } = {};
              try {
                meta = JSON.parse(readFileSync(metaPath, 'utf8'));
              } catch {
                // ignore
              }
              const unitInfo = meta.extracted?.units
                ? ` (${meta.extracted.units} ${meta.extracted.unitLabel ?? 'units'})`
                : '';
              const truncNote = meta.extracted?.truncated ? '\n[Content truncated to 100KB]' : '';
              fileSections.push(`[Attached file: ${name}${unitInfo}]\n${extractedText}${truncNote}`);
            } else if (mimeType.startsWith('text/') || /\.(txt|md|json|js|ts|py|csv|log)$/i.test(name)) {
              const content = readFileSync(filePath, 'utf8').slice(0, 100_000);
              fileSections.push(`[Attached file: ${name}]\n${content}`);
            } else {
              fileSections.push(`[Attached file: ${name} (${mimeType}) — preview not available, use read_file tool to access if needed]`);
            }
          } catch {
            // ignore unreadable files
          }
        }
        if (fileSections.length > 0) {
          messageWithFiles = `${fileSections.join('\n\n')}\n\n${turnMessage}`;
        }
      }
      let memoryContext: string | undefined;
      try {
        memoryContext = tieredMemoryStore.recallForPrompt(bot.id, turnMessage) || undefined;
      } catch {
        memoryContext = undefined; // memory must never break chat
      }
      // Run-health turn telemetry (features #2/#5): latency, tokens, errors
      // are recorded for health scoring + regression detection. The
      // try/finally guarantees a sample even when the turn throws, and the
      // inner try/catch guarantees metrics never break chat.
      const turnStart = Date.now();
      let turnUsage: TokenUsage | null = null;
      let turnError: string | null = null;
      // Privacy-egress choke point: the provider call below is a cloud egress
      // (except fully local providers like Ollama). Memory recall already
      // filters to cloud-ok tiers and attached files are the user's explicit
      // content (cloud-ok) — but a space vault secret tagged local-only must
      // never ride a third-party cloud route. Same-service use (the secret IS
      // this provider's own key, byte-identical to its configured key) and
      // fully local providers are allowed. Denials throw fail-closed with an
      // audit entry before any network I/O (see runtime provider.chat).
      const turnProviderId = turnOpts.providerId ?? bot.provider ?? 'groq';
      const turnPreset = getProviderPreset(turnProviderId);
      const egressGate = new EgressGate((action, detail) => {
        try {
          governance.audit(action, { actor: bot.id, sessionId: body.sessionId, ...detail });
        } catch {
          // Audit must never break chat.
        }
      });
      const egressItems: TieredItem[] = [{ id: 'memory', tier: 'cloud-ok' }];
      for (const fid of turnOpts.fileIds ?? []) egressItems.push({ id: `file:${fid}`, tier: 'cloud-ok' });
      if (spaceCtx?.apiKeyOverride && spaceCtx.apiKeyTier === 'local-only' && turnPreset?.local !== true) {
        let sameService = false;
        try {
          sameService = resolveApiKey(turnProviderId) === spaceCtx.apiKeyOverride;
        } catch {
          sameService = false;
        }
        if (!sameService) {
          egressItems.push({ id: `vault:${spaceCtx.apiKeyRef ?? 'secret'}`, tier: 'local-only' });
        }
      }
      try {
        turnUsage = await agentRuntime.runTurn({
          bot,
          message: messageWithFiles,
          sessionId: body.sessionId,
          // Per-bot computers (P1 #14): this chat's conversation id, so a
          // pinned "Works on" surface for this conversation applies.
          conversationId: body.sessionId,
          providerId: turnOpts.providerId,
          // Spaces: an explicit call-site model wins; otherwise the space's
          // model override applies (bot pin / smart routing as before when unset).
          model: turnOpts.model ?? spaceCtx?.space.modelOverride,
          taskType: turnOpts.taskType,
          signal: turnController!.signal,
          autoApprove: turnOpts.autoApprove,
          planMode: turnOpts.planMode,
          maxBudgetUsd: turnOpts.maxBudgetUsd,
          sandboxMode: turnOpts.sandboxMode,
          reasoningEffort: turnOpts.reasoningEffort,
          memoryContext,
          privacyGate: egressGate,
          egressItems,
          // Learning-from-corrections routing (feature #4): stored rules
          // reloaded per turn so a recorded correction changes routing.
          routingRules: loadChatRoutingRules(),
          // Spaces: per-turn workspace + API-key overrides.
          workspaceOverride: spaceCtx?.space.workspaceOverride,
          apiKeyOverride: spaceCtx?.apiKeyOverride,
          // Interactive widgets (OpenMausBot parity P1 #15): lets
          // ask_user_question pause the turn for a human answer.
          widgetCoordinator: deps.widgetCoordinator,
          onEvent,
        });
      } catch (err) {
        turnError = err instanceof Error ? err.message : String(err);
        throw err;
      } finally {
        try {
          recordTurnHealth({
            botId: bot.id,
            sessionId: sessionKey ?? undefined,
            latencyMs: Date.now() - turnStart,
            totalTokens: turnUsage?.totalTokens ?? 0,
            errored: turnError !== null,
            ...(turnError ? { errorMessage: turnError } : {}),
            emptyResponse:
              turnError === null && turnAssistantText.trim().length === 0 && turnToolCalls.length === 0,
          });
        } catch {
          // Metrics must never break chat.
        }
        // Cost dashboard metering (feature #8): one cost event per turn so
        // GET /api/usage/breakdown shows real spend. Cost in USD cents is
        // auto-estimated from tokens by CostTracker (local price config,
        // no paid APIs). Metering must never break chat.
        if (turnUsage) {
          try {
            costTracker.record({
              feature: 'chat',
              step: 'turn',
              model: turnOpts.model ?? turnOpts.providerId ?? bot.model ?? 'auto',
              inputTokens: turnUsage.promptTokens,
              outputTokens: turnUsage.completionTokens,
              sessionId: sessionKey ?? undefined,
              botId: bot.id,
            });
          } catch {
            // Metering must never break chat.
          }
        }
      }
      // Tiered memory: ingest this turn (L0 events + async L2 distillation).
      // Fire-and-forget by design — ingestTurn never throws into the caller.
      // The keeper is per-bot toggleable (bot.memoryKeeper, default true).
      if (bot.memoryKeeper !== false) {
        tieredMemoryStore.ingestTurn(bot.id, sessionKey ?? 'default', turnMessage, turnAssistantText, turnToolCalls);
      }
      // Memory fabric: periodic reflection pass (opt-in per bot via
      // memoryReflection). Every 50 turns the bot's own model reviews its
      // memories in the background — lessons, procedures, contradictions.
      // Fire-and-forget; memory must never break chat.
      if (bot.memoryReflection === true) {
        try {
          if (tieredMemoryStore.noteTurnForReflection(bot.id)) {
            const chat = buildBotChatFn(bot);
            if (chat) {
              void tieredMemoryStore.runReflectionPass(bot.id, chat).catch(() => undefined);
            }
          }
        } catch {
          // reflection bookkeeping must never break chat
        }
      }
      // The runtime should emit done/error itself; emit a terminal event only
      // if it resolved without one so clients never hang.
      if (!terminalEmitted && !closed) {
        res.write(`data: ${JSON.stringify({ type: 'done', usage: null })}\n\n`);
      }
    };

    // Phase 3: pass the RAW explicit values (no bot-default merging here).
    // runTurn applies bot defaults, then smart model routing when nothing
    // is pinned; taskType selects the routing profile.
    const rawTaskType = body.taskType;
    const taskType =
      rawTaskType === 'code' || rawTaskType === 'chat' || rawTaskType === 'reasoning' || rawTaskType === 'simple-qa'
        ? rawTaskType
        : undefined;
    const firstTurnOpts = {
      providerId: typeof body.provider === 'string' && body.provider.trim() ? body.provider.trim() : undefined,
      model: typeof body.model === 'string' && body.model.trim() ? body.model.trim() : undefined,
      reasoningEffort: body.reasoningEffort === 'low' || body.reasoningEffort === 'medium' || body.reasoningEffort === 'high' ? body.reasoningEffort : undefined,
      fileIds: Array.isArray(body.fileIds) ? body.fileIds.filter((x): x is string => typeof x === 'string') : undefined,
      taskType,
      autoApprove: body.autoApprove === true,
      planMode: body.planMode === true,
      maxBudgetUsd: typeof body.maxBudgetUsd === 'number' && body.maxBudgetUsd >= 0 ? body.maxBudgetUsd : undefined,
      sandboxMode: body.sandboxMode === 'read-only' || body.sandboxMode === 'workspace-write' || body.sandboxMode === 'danger-full-access' ? body.sandboxMode : undefined,
    };

    try {
      await runOneTurn(chatMessage, firstTurnOpts);

      // Queue-at-boundary: drain queued messages FIFO on this same SSE stream.
      // Each queued turn runs to completion before the next starts. Stops if
      // the client disconnected or the turn was aborted (Stop/interrupt).
      while (sessionKey && !closed && !turnController.signal.aborted) {
        const next = chatQueueStore.nextForSession(sessionKey);
        if (!next) break;
        chatQueueStore.markStarted(next.id);
        if (!closed) {
          res.write(`data: ${JSON.stringify({ type: 'queued_turn_start', queueId: next.id, message: next.message.slice(0, 200) })}\n\n`);
        }
        // Slash commands in queued messages are expanded at enqueue time
        // (they were already expanded when first received), so run as-is.
        await runOneTurn(next.message, {
          providerId: next.provider,
          model: next.model,
          taskType: next.taskType,
          autoApprove: next.autoApprove,
          planMode: next.planMode,
          maxBudgetUsd: next.maxBudgetUsd,
          sandboxMode: next.sandboxMode,
        });
      }
    } catch (err) {
      if (!terminalEmitted && !closed) {
        const message = err instanceof Error ? err.message : String(err);
        res.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`);
      }
    } finally {
      if (sessionKey && activeTurns.get(sessionKey)?.controller === turnController) {
        activeTurns.delete(sessionKey);
      }
      finish();
    }
  });

  // ---- Chat queue ---------------------------------------------------------
  // Queue-at-boundary steering: list and remove queued messages.
  router.get('/chat/queue', (req, res) => {
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
    res.json({ ok: true, queue: chatQueueStore.list(sessionId) });
  });

  router.delete('/chat/queue/:id', (req, res) => {
    if (!chatQueueStore.remove(req.params.id)) {
      res.status(404).json(errorBody(`Unknown queued message "${req.params.id}"`));
      return;
    }
    res.json({ ok: true, removed: req.params.id });
  });

  // ---- Approvals ----------------------------------------------------------
  // :id accepts either the runtime-issued approval id (from the chat SSE
  // `approval_required` event) or the real gateway id (from the inbox) —
  // the adapter translates.
  router.get('/approvals', (req, res) => {
    try {
      const statusParam = typeof req.query.status === 'string' ? req.query.status : undefined;
      if (statusParam && !VALID_APPROVAL_STATUSES.has(statusParam)) {
        res.status(400).json(
          errorBody(`Invalid status "${statusParam}" — expected pending|approved|denied|expired`),
        );
        return;
      }
      res.json(governance.listApprovals(statusParam as ApprovalStatus | undefined));
    } catch (err) {
      res.status(500).json(errorBody('Failed to list approvals', err instanceof Error ? err.message : String(err)));
    }
  });

  router.post('/approvals/:id', (req, res) => {
    const body = (req.body ?? {}) as Partial<DecideApprovalBody>;
    if (body.decision !== 'approved' && body.decision !== 'denied') {
      res.status(400).json(errorBody('decision must be "approved" or "denied"'));
      return;
    }
    try {
      const realId = governanceAdapter.resolveApprovalId(req.params.id);
      const existing = governance.getApproval(realId);
      if (!existing) {
        res.status(404).json(errorBody(`Unknown approval "${req.params.id}"`));
        return;
      }
      if (existing.status !== 'pending') {
        res.status(409).json(errorBody(`Approval "${req.params.id}" is already ${existing.status}`));
        return;
      }
      const decided = governance.decide(realId, body.decision, { note: body.note });
      // Preference learning: record the decision. If the user consistently
      // denies (or approves) a tool, a preference is learned.
      try {
        const learned = preferenceStore.recordDecision(existing.botId, existing.toolName, body.decision);
        if (learned) {
          console.log(`[preferences] learned ${learned.preference} for ${existing.botId}/${existing.toolName} (${learned.observations} observations)`);
        }
      } catch {
        // Preference recording must never break approval decisions.
      }
      // Phase 3: close the loop for approvals that originated from external
      // MCP clients — the platform MCP server holds the pending call and
      // mints the single-use grant on decision.
      if (deps.mcpServer) {
        try {
          deps.mcpServer.decideApproval(realId, body.decision);
        } catch {
          // The approval wasn't an MCP-server one (or was already consumed);
          // the gateway decision above is authoritative.
        }
      }
      res.json(decided);
    } catch (err) {
      res.status(500).json(errorBody('Failed to decide approval', err instanceof Error ? err.message : String(err)));
    }
  });

  // ---- Audit --------------------------------------------------------------
  router.get('/audit', (req, res) => {
    const rawLimit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 100;
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 1000) : 100;
    try {
      res.json(governance.listAudit(limit));
    } catch (err) {
      res.status(500).json(errorBody('Failed to list audit entries', err instanceof Error ? err.message : String(err)));
    }
  });

  // ---- Models -------------------------------------------------------------
  // Flat model catalog with free flags and (estimated) per-1M prices.
  // ?freeOnly=1 filters to free models (powers the web UI "Free only" toggle).
  // Prices are public-list-price estimates, not live billing — see pricing.ts.
  router.get('/models', (_req, res) => {
    try {
      const freeOnly = _req.query.freeOnly === '1' || _req.query.freeOnly === 'true';
      const models: Array<{
        providerId: string;
        id: string;
        name: string;
        contextLength?: number;
        free: boolean;
        inputPer1M?: number;
        outputPer1M?: number;
        estimated: boolean;
        /** 'catalog' (shipped presets) or 'models.dev' (refreshed catalog). */
        source: 'catalog' | 'models.dev';
      }> = [];
      const seen = new Set<string>();
      for (const preset of listProviderPresets()) {
        for (const m of preset.models) {
          const free = isFreeModel(preset.id, m.id);
          if (freeOnly && !free) continue;
          const price = priceOfModel(preset.id, m.id);
          seen.add(`${preset.id}:${m.id}`);
          models.push({
            providerId: preset.id,
            id: m.id,
            name: m.name,
            contextLength: m.contextLength,
            free,
            inputPer1M: price?.inputPer1M,
            outputPer1M: price?.outputPer1M,
            estimated: price ? price.estimate : true,
            source: 'catalog',
          });
        }
      }
      // models.dev catalog refresh (OpenMausBot parity P1 #23): merge cached
      // models.dev models the shipped catalog does not already have. Marked
      // with their source so the picker can show it; failures just skip.
      try {
        const cached = readModelsDevCache(config.dataDir);
        if (cached && !freeOnly) {
          for (const provider of cached.providers) {
            for (const m of provider.models) {
              const key = `${provider.id}:${m.id}`;
              if (seen.has(key)) continue;
              seen.add(key);
              models.push({
                providerId: provider.id,
                id: m.id,
                name: m.name,
                contextLength: m.contextLength,
                free: false,
                inputPer1M: m.inputPer1M,
                outputPer1M: m.outputPer1M,
                estimated: false,
                source: 'models.dev',
              });
            }
          }
        }
      } catch {
        // models.dev merge must never break /api/models
      }
      res.json(models);
    } catch (err) {
      res.status(500).json(errorBody('Failed to list models', err instanceof Error ? err.message : String(err)));
    }
  });

  // ---- Providers ----------------------------------------------------------
  router.get('/providers', async (_req, res) => {
    try {
      res.json(await listProviders(config.dataDir));
    } catch (err) {
      res.status(500).json(errorBody('Failed to list providers', err instanceof Error ? err.message : String(err)));
    }
  });

  router.post('/providers/keys', (req, res) => {
    const body = (req.body ?? {}) as Partial<ProviderKeyBody>;
    if (typeof body.providerId !== 'string' || !body.providerId) {
      res.status(400).json(errorBody('providerId is required'));
      return;
    }
    if (typeof body.apiKey !== 'string' || !body.apiKey) {
      res.status(400).json(errorBody('apiKey is required'));
      return;
    }
    if (body.headers !== undefined && (typeof body.headers !== 'object' || body.headers === null)) {
      res.status(400).json(errorBody('headers must be an object'));
      return;
    }
    try {
      if (!isKnownProviderId(body.providerId)) {
        res.status(400).json(
          errorBody(`Unknown provider "${body.providerId}". Use a catalog provider or a "custom-*" id.`),
        );
        return;
      }
      // Never log the key: only the provider id is safe to mention.
      saveProviderKey(config.dataDir, body.providerId, {
        apiKey: body.apiKey,
        baseUrl: body.baseUrl,
        headers: body.headers,
      });
      // Sync the new key into process.env immediately so it works without a restart.
      syncProviderKeysToEnv(config.dataDir);
      console.log(`[providers] stored key for provider "${body.providerId}"`);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json(errorBody('Failed to store provider key', err instanceof Error ? err.message : String(err)));
    }
  });

  router.delete('/providers/keys/:providerId', (req, res) => {
    try {
      const removed = removeProviderKey(config.dataDir, req.params.providerId);
      if (!removed) {
        if (isConfiguredSafe(req.params.providerId)) {
          res.status(400).json(errorBody(`Provider "${req.params.providerId}" is configured via environment, not the local file`));
          return;
        }
        res.status(404).json(errorBody(`No stored key for provider "${req.params.providerId}"`));
        return;
      }
      console.log(`[providers] removed key for provider "${req.params.providerId}"`);
      // Sync removal into process.env immediately.
      syncProviderKeysToEnv(config.dataDir);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json(errorBody('Failed to remove provider key', err instanceof Error ? err.message : String(err)));
    }
  });

  // ---- File uploads (chat attachments) ------------------------------------
  // POST /api/files/upload { name, mimeType, data (base64) } → { id, name, size, mimeType }
  // Files are stored under <dataDir>/uploads and can be attached to chat messages.
  const uploadsDir = join(config.dataDir, 'uploads');
  try {
    mkdirSync(uploadsDir, { recursive: true });
  } catch {
    // ignore
  }

  router.post('/files/upload', async (req, res) => {
    const body = (req.body ?? {}) as { name?: unknown; mimeType?: unknown; data?: unknown };
    if (typeof body.name !== 'string' || !body.name.trim()) {
      res.status(400).json(errorBody('name is required'));
      return;
    }
    if (typeof body.data !== 'string' || !body.data) {
      res.status(400).json(errorBody('data (base64) is required'));
      return;
    }
    // 100MB limit (base64 inflates ~33%)
    if (body.data.length > 140_000_000) {
      res.status(400).json(errorBody('File too large (max 100MB)'));
      return;
    }
    const id = randomUUID();
    const safeName = basename(body.name).slice(0, 100) || 'file';
    const storedName = `${id}-${safeName}`;
    const filePath = join(uploadsDir, storedName);
    try {
      const buffer = Buffer.from(body.data, 'base64');
      // Re-check decoded size: base64 whitespace is ignored on decode, so the
      // string-length check above is approximate. 100 MB hard cap on bytes.
      if (buffer.length > 100 * 1024 * 1024) {
        res.status(400).json(errorBody('File too large (max 100MB)'));
        return;
      }
      writeFileSync(filePath, buffer);
      const mimeType = typeof body.mimeType === 'string' ? body.mimeType : 'application/octet-stream';
      // Local document text extraction (best-effort, never blocks upload).
      let extracted: { units?: number; unitLabel?: string; truncated?: boolean; charCount?: number } | undefined;
      let extractFailed = false;
      try {
        const kind = detectDocKind(mimeType, safeName);
        if (kind !== 'unsupported') {
          const result = await extractDocumentText(filePath, mimeType, safeName);
          if (result.text) {
            writeFileSync(`${filePath}.extracted.txt`, result.text, 'utf8');
            extracted = {
              units: result.units,
              unitLabel: result.unitLabel,
              truncated: result.truncated || undefined,
              charCount: result.text.length,
            };
          } else {
            extractFailed = true;
          }
        }
      } catch {
        extractFailed = true;
      }
      const meta = {
        id,
        name: safeName,
        size: buffer.length,
        mimeType,
        uploadedAt: new Date().toISOString(),
        extracted,
        extractFailed: extractFailed || undefined,
      };
      writeFileSync(`${filePath}.meta.json`, JSON.stringify(meta));
      res.json(meta);
    } catch (err) {
      res.status(500).json(errorBody('Failed to save file', err instanceof Error ? err.message : String(err)));
    }
  });

  router.get('/files/:id', (req, res) => {
    const id = req.params.id;
    if (!/^[0-9a-f-]{36}$/.test(id)) {
      res.status(400).json(errorBody('Invalid file id'));
      return;
    }
    try {
      const files = readdirSync(uploadsDir);
      const match = files.find((f) => f.startsWith(`${id}-`) && !f.endsWith('.meta.json'));
      if (!match) {
        res.status(404).json(errorBody('File not found'));
        return;
      }
      const filePath = join(uploadsDir, match);
      const metaPath = `${filePath}.meta.json`;
      let mimeType = 'application/octet-stream';
      let name = match;
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { mimeType?: string; name?: string };
        if (meta.mimeType) mimeType = meta.mimeType;
        if (meta.name) name = meta.name;
      } catch {
        // ignore
      }
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"`);
      createReadStream(filePath).pipe(res);
    } catch (err) {
      res.status(500).json(errorBody('Failed to read file', err instanceof Error ? err.message : String(err)));
    }
  });

  router.delete('/files/:id', (req, res) => {
    const id = req.params.id;
    if (!/^[0-9a-f-]{36}$/.test(id)) {
      res.status(400).json(errorBody('Invalid file id'));
      return;
    }
    try {
      const files = readdirSync(uploadsDir);
      const match = files.find((f) => f.startsWith(`${id}-`) && !f.endsWith('.meta.json'));
      if (!match) {
        res.status(404).json(errorBody('File not found'));
        return;
      }
      const filePath = join(uploadsDir, match);
      unlinkSync(filePath);
      try {
        unlinkSync(`${filePath}.meta.json`);
      } catch {
        // ignore
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json(errorBody('Failed to delete file', err instanceof Error ? err.message : String(err)));
    }
  });

  // ---- Subscription/CLI bridges (MausBot parity) ---------------------------
  // Consent-gated reuse of the user's own Claude Code / Codex CLI logins.
  // No credential bytes are stored: consent lives in memory only.
  router.post('/providers/bridges/:bridgeId/connect', (req, res) => {
    try {
      connectBridge(req.params.bridgeId);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json(errorBody('Failed to connect bridge', err instanceof Error ? err.message : String(err)));
    }
  });

  router.delete('/providers/bridges/:bridgeId/disconnect', (req, res) => {
    try {
      const was = disconnectBridge(req.params.bridgeId);
      if (!was) {
        res.status(404).json(errorBody(`Bridge "${req.params.bridgeId}" is not connected`));
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json(errorBody('Failed to disconnect bridge', err instanceof Error ? err.message : String(err)));
    }
  });

  // ---- Workflows ----------------------------------------------------------
  router.get('/workflows', (_req, res) => {
    try {
      res.json(workflowRunner.listWorkflows());
    } catch (err) {
      res.status(500).json(errorBody('Failed to list workflows', err instanceof Error ? err.message : String(err)));
    }
  });

  router.post('/workflows/:id/run', async (req, res) => {
    const body = (req.body ?? {}) as Partial<RunWorkflowBody>;
    try {
      try {
        workflowRunner.getWorkflow(req.params.id);
      } catch {
        res.status(404).json(errorBody(`Unknown workflow "${req.params.id}"`));
        return;
      }
      // The runner dedupes idempotency keys internally.
      const run = await workflowRunner.startRun(req.params.id, body.input, {
        idempotencyKey: body.idempotencyKey,
      });
      deps.governance.audit('workflow.run_requested', {
        actor: 'api',
        sessionId: run.id,
        detail: { workflowId: req.params.id, idempotencyKey: body.idempotencyKey ?? null },
      });
      res.json({ runId: run.id });
    } catch (err) {
      res.status(500).json(errorBody('Failed to start workflow run', err instanceof Error ? err.message : String(err)));
    }
  });

  router.get('/workflows/runs', (_req, res) => {
    try {
      const runs = workflowRunner.listRuns();
      const sorted = [...runs].sort((a, b) => b.createdAt - a.createdAt);
      // Health chips for the Activity feed / runs table. Scores are cached
      // after the first computation; terminal runs also feed regression
      // history (see scoreAndPersistRun).
      res.json(sorted.map((run) => ({ ...run, healthScore: scoreAndPersistRun(run).score })));
    } catch (err) {
      res.status(500).json(errorBody('Failed to list workflow runs', err instanceof Error ? err.message : String(err)));
    }
  });

  router.get('/workflows/runs/:runId', (req, res) => {
    try {
      const run = workflowRunner.getRun(req.params.runId);
      if (!run) {
        res.status(404).json(errorBody(`Unknown run "${req.params.runId}"`));
        return;
      }
      res.json({ ...run, health: scoreAndPersistRun(run) });
    } catch (err) {
      res.status(500).json(errorBody('Failed to get workflow run', err instanceof Error ? err.message : String(err)));
    }
  });

  router.get('/workflows/runs/:runId/stream', (req, res) => {
    try {
      const runId = req.params.runId;
      const initial = workflowRunner.getRun(runId);
      if (!initial) {
        res.status(404).json(errorBody(`Unknown run "${runId}"`));
        return;
      }
      sseHeaders(res);
      let closed = false;
      const heartbeat = setInterval(() => {
        if (!closed) res.write(': ping\n\n');
      }, 15000);
      const finish = () => {
        clearInterval(heartbeat);
        if (!closed) {
          closed = true;
          res.end();
        }
      };
      const send = (run: WorkflowRun) => {
        if (!closed) res.write(`data: ${JSON.stringify(run)}\n\n`);
      };
      // onRunUpdate is global — filter to this run.
      const unsubscribe = workflowRunner.onRunUpdate((run) => {
        if (run.id !== runId || closed) return;
        send(run);
        if (TERMINAL_RUN_STATUSES.has(run.status)) finish();
      });
      res.on('close', () => {
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
      });
      send(initial);
      if (TERMINAL_RUN_STATUSES.has(initial.status)) finish();
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json(errorBody('Failed to stream workflow run', err instanceof Error ? err.message : String(err)));
      }
    }
  });

  // ---- Run health (features #2/#5): scores + written fixes + regressions ----
  // Standalone module (testable without the full router): scores persist
  // with the run records; terminal runs/turns also append metric samples
  // that feed the 7-day regression detector.
  registerHealthRoutes(router, { workflowRunner, runHealth });

  // ---- Omni rolling summary (Omni panel backend) --------------------------
  // Four temporal layers + pins + time-travel versions; the store is fed by
  // the OmniCollector (wired in index.ts). Empty store → 404, which the web
  // panel maps to its empty state via optionalJson.
  registerOmniRoutes(router, { omni: omniStore, collector: omniCollector });

  // ---- Daily briefing -------------------------------------------------------
  // Standalone module (testable without the full router): assembles the
  // overnight digest from the governance audit log, the platform calendar,
  // pending approvals, and the run-health regression detector; the summary
  // prefers a local Ollama model with a deterministic template fallback.
  // The web UI's briefing panel is coded against GET /api/briefing.
  // Feature interconnection: the digest also pulls from notes and recent
  // workflow runs (the live runner satisfies the structural source type).
  registerBriefingRoutes(router, { dataDir: config.dataDir, governance, runHealth, workflowSource: workflowRunner });

  // Learning-from-corrections routing (feature #4): corrections recorded
  // here are learned locally (pattern → rule template) and reloaded by the
  // chat route on every turn, so corrections actually update routing.
  const routingLearnRouter = express.Router();
  registerRoutingLearnRoutes(routingLearnRouter, { dataDir: config.dataDir });
  router.use('/routing', routingLearnRouter);

  // Stage-prompt overrides (feature #9): boot log of which overrides are
  // live (the summarizer stage resolves through the same store, so edits
  // under ~/.kriyadot/prompts/*.md hot-reload without a restart).
  logActivePromptOverrides();
  registerPromptRoutes(router);

  // ---- Dry run ------------------------------------------------------------
  router.post('/dry-run', async (req, res) => {
    const body = (req.body ?? {}) as Partial<DryRunBody>;
    if (typeof body.botId !== 'string' || !body.botId) {
      res.status(400).json(errorBody('botId is required'));
      return;
    }
    if (typeof body.message !== 'string' || !body.message.trim()) {
      res.status(400).json(errorBody('message is required'));
      return;
    }
    const bot = bots.find((b) => b.id === body.botId);
    if (!bot) {
      res.status(404).json(errorBody(`Unknown bot "${body.botId}"`));
      return;
    }
    try {
      const report = await agentRuntime.previewTurn(bot, body.message);
      res.json(report);
    } catch (err) {
      res.status(500).json(errorBody('Dry run failed', err instanceof Error ? err.message : String(err)));
    }
  });

  // ---- Policy simulator (P3-B: open-dots parity) -------------------------
  // Side-effect-free dry-run of the policy engine: returns the decision
  // the gateway WOULD make for a proposed tool call (effect, matched rule,
  // hard-floor/denylist hits, whether a live call would mint an approval)
  // WITHOUT creating approvals or writing audit entries. Lets policy
  // authors test rules safely before they govern real runs.
  router.post('/policy/simulate', async (req, res) => {
    const body = (req.body ?? {}) as Partial<PolicySimulateBody>;
    if (typeof body.toolName !== 'string' || !body.toolName.trim()) {
      res.status(400).json(errorBody('toolName is required'));
      return;
    }
    if (body.args !== undefined && (typeof body.args !== 'object' || body.args === null || Array.isArray(body.args))) {
      res.status(400).json(errorBody('args must be an object'));
      return;
    }
    const botId = typeof body.botId === 'string' && body.botId ? body.botId : 'global';
    if (body.botId && !bots.find((b) => b.id === body.botId)) {
      res.status(404).json(errorBody(`Unknown bot "${body.botId}"`));
      return;
    }
    try {
      const result = await governanceAdapter.simulatePolicy(
        botId,
        body.toolName.trim(),
        (body.args ?? {}) as Record<string, unknown>,
      );
      res.json({ toolName: body.toolName.trim(), botId, ...result });
    } catch (err) {
      res.status(500).json(errorBody('Policy simulation failed', err instanceof Error ? err.message : String(err)));
    }
  });

  // ---- Action registry (P3-B: open-dots parity) --------------------------
  // Read-only listing of every registered tool (the action registry the
  // agent can call): name, description, and parameter schema. Lets the web
  // UI, external clients, and the policy simulator enumerate available
  // actions without executing anything.
  router.get('/tools', async (_req, res) => {
    try {
      const defs = mcpServer ? await mcpServer.listToolDefs() : [];
      res.json({
        tools: defs.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      });
    } catch (err) {
      res.status(500).json(errorBody('Failed to list tools', err instanceof Error ? err.message : String(err)));
    }
  });

  // ---- Phase 3: connected apps (OAuth) + messaging gateway ---------------
  // Both modules register relative paths on the main router, so they land
  // under /api/oauth/... and /api/messaging/....
  registerOAuthRoutes(router, { config, governance });
  registerMcpOAuthRoutes(router, { config, governance, mcpServers });
  // Lazy MCP directory (OpenMausBot parity P1 #22) + models.dev catalog
  // refresh (P1 #23). Both are optional deps so older index.ts callers and
  // tests keep working.
  if (deps.lazyMcpManager) {
    registerMcpDirectoryRoutes(router, {
      manager: deps.lazyMcpManager,
      governance,
      refreshStubs: deps.refreshMcpStubs ?? (() => undefined),
    });
  }
  registerModelsDevRoutes(router, { dataDir: config.dataDir });
  // Inbound bot mentions (Discord/Slack) run an agent turn through the chat
  // pipeline and reply in the channel. The turn uses the default bot; the
  // session is scoped per (provider, channel) so the bot keeps context.
  registerMessagingRoutes(router, {
    config,
    governance,
    onMention: async (info) => {
      // Bot picker for inbound mentions: an explicit MESSAGING_DEFAULT_BOT
      // always wins (manual override). Otherwise the fast message router
      // (packages/agent-runtime/src/message-router.ts — pure keyword/topic
      // heuristics, no LLM call) picks the best-fit bot from the message
      // text. Set MESSAGE_ROUTER_ENABLED=0 to restore the legacy first-bot
      // fallback. See docs/message-router.md.
      const defaultBotId = process.env.MESSAGING_DEFAULT_BOT;
      let bot = defaultBotId ? bots.find((b) => b.id === defaultBotId) : undefined;
      if (!bot && process.env.MESSAGE_ROUTER_ENABLED !== '0') {
        const routed = routeMessage(
          info.text,
          bots.map((b) => ({
            id: b.id,
            name: b.name,
            description: b.description,
            keywords: b.routeKeywords,
          })),
        );
        bot = bots.find((b) => b.id === routed.botId);
      }
      bot ??= bots[0];
      if (!bot) return undefined;
      let reply = '';
      try {
        await agentRuntime.runTurn({
          bot,
          message: info.text,
          sessionId: `mention-${info.providerId}-${info.chatId}`,
          // Learning-from-corrections routing (feature #4): inbound mentions
          // honor the same learned rules as the chat route.
          routingRules: loadChatRoutingRules(),
          onEvent: async (event) => {
            if (event.type === 'token') reply += event.content;
          },
        });
      } catch (err) {
        console.error(
          `[messaging] mention turn failed (${info.providerId}):`,
          err instanceof Error ? err.message : err,
        );
        return undefined;
      }
      const trimmed = reply.trim();
      return trimmed ? trimmed.slice(0, 4000) : undefined;
    },
  });

  // ---- Phase 3: user notes + tasks/calendar ------------------------------
  // Notes live on a sub-router mounted at /api/notes; tasks registers
  // /api/tasks and /api/events on the main router itself.
  // Knowledge routes (graph/search/tags/daily/backlinks) must be registered
  // BEFORE registerNotesRoutes so they aren't swallowed by /:id.
  const notesRouter = express.Router();
  registerKnowledgeRoutes(notesRouter, { dataDir: config.dataDir });
  registerNotesRoutes(notesRouter, { dataDir: config.dataDir });
  router.use('/notes', notesRouter);
  registerTasksRoutes(router, { dataDir: config.dataDir });

  // ---- Feature interconnection (P2-E) -------------------------------------
  // Notes/pages attachable to bot context (API surface; the context
  // provider is wired on agentRuntime at the top of createRouter).
  const noteAttachmentsRouter = express.Router();
  registerNoteAttachmentRoutes(noteAttachmentsRouter, { dataDir: config.dataDir });
  router.use('/note-attachments', noteAttachmentsRouter);

  // ---- External-assistant annotations (human review queue) ----------------
  // Separate router at /api/annotations, structurally apart from every
  // telemetry endpoint: read-only-assistant MCP connections may only APPEND
  // here (see mcp-annotations.ts); humans approve/dismiss. Annotation
  // records are labeled `record: 'annotation'` and never join telemetry
  // responses, so assistant notes can never be mistaken for measurements.
  const annotationsRouter = express.Router();
  registerAnnotationRoutes(annotationsRouter, { dataDir: config.dataDir });
  router.use('/annotations', annotationsRouter);

  // ---- Collaborative Pages --------------------------------------------------
  // ChatGPT "Space" Pages parity: humans + agents co-edit live markdown docs
  // with comments, @mentions (bot mentions trigger agent turns), version
  // history, and SSE live updates.
  const pagesRouter = express.Router();
  registerPagesRoutes(pagesRouter, {
    dataDir: config.dataDir,
    agentRuntime,
    getBots: () => bots,
  });
  router.use('/pages', pagesRouter);

  // ---- MCP tool scopes (settings API for the sibling web panel) --------
  if (mcpServer && mcpScopeStore) {
    registerMcpToolScopeRoutes(router, { mcpServer, mcpScopeStore, governance });
  }

  // ---- Processing rules + firing log -------------------------------------
  registerProcessingRuleRoutes(router, { dataDir: config.dataDir, governance });

  // ---- Red-team robustness suite (defensive testing harness) --------------
  registerRedteamRoutes(router, { dataDir: config.dataDir, agentRuntime, bots });

  // ---- Phase 4: marketplace + billing ---------------------------------
  // The registry JSON is bundled into the binary; seed it into the data dir
  // on first boot (or when the bundled copy changes) so fromFile works
  // identically in dev and in the single-file binary.
  const marketplaceRouter = express.Router();
  const registrySeedPath = join(config.dataDir, 'marketplace-registry.json');
  const registrySeedText = JSON.stringify(marketplaceRegistryJson);
  if (!existsSync(registrySeedPath) || readFileSync(registrySeedPath, 'utf8') !== registrySeedText) {
    writeFileSync(registrySeedPath, registrySeedText);
  }
  registerMarketplaceRoutes(marketplaceRouter, {
    config,
    governance,
    dataDir: config.dataDir,
    registry: MarketplaceRegistry.fromFile(registrySeedPath),
    installer: new MarketplaceInstaller(join(config.dataDir, 'marketplace')),
    revenue: new RevenueLedger(join(config.dataDir, 'marketplace.db')),
  });
  router.use('/marketplace', marketplaceRouter);

  const billingRouter = express.Router();
  registerBillingRoutes(billingRouter, {
    dataDir: config.dataDir,
    meter: new UsageMeter(join(config.dataDir, 'billing.db')),
    ledger: new BillingLedger(join(config.dataDir, 'billing.db')),
    // MVP: mock billing provider only — real Stripe keys are the founder's step.
    provider: new MockBillingProvider(),
    // Cost dashboard: per-feature/per-step token + spend breakdown and
    // monthly feature caps (shares billing.db with the meter/ledger; the
    // same instance the chat route records turn cost events into).
    // Plus spend caps (global/per-bot daily/monthly, hard-stop enforced
    // by the runtime gate) and the usage ledger + CSV export.
    costTracker,
    spendCaps: spendCapStore,
  });
  router.use('/billing', billingRouter);

  // ---- Phase 4: tenancy + vault (mounted at /api) ----------------------
  registerTenancyRoutes(router, { config, governance });
  registerVaultRoutes(router, { config, governance });
  // Composio connector: platform API key in the vault, per-bot app toggles.
  registerComposioRoutes(router, { config, governance, bots });
  // Composio connected accounts: OAuth connect links, account list/labels,
  // disconnect, and per-account tool browsers.
  registerComposioAccountRoutes(router, { config, governance, bots });
  // Notion parity: databases/table view + Notion HTML/ZIP import.
  {
    const databasesRouter = express.Router();
    registerDatabasesRoutes(databasesRouter, { dataDir: config.dataDir });
    router.use('/databases', databasesRouter);
    const notionRouter = express.Router();
    registerNotionImportRoutes(notionRouter, { dataDir: config.dataDir });
    router.use('/notion', notionRouter);
  }

  // ---- Phase 4: protocols + voice --------------------------------------
  const protocolsRouter = express.Router();
  registerProtocolRoutes(protocolsRouter, {});
  router.use('/protocols', protocolsRouter);

  const voiceRouter = express.Router();
  registerVoiceRoutes(voiceRouter, {});
  router.use('/voice', voiceRouter);

  // Realtime voice calls with bots (Codync parity): session REST + the
  // utterance WebSocket (/api/voice/calls/ws, wired in index.ts).
  if (deps.voiceCall) {
    router.use('/voice', createVoiceCallRouter({ service: deps.voiceCall.service }));
  }

  // Native realtime (speech-to-speech) voice calls (OpenMausBot parity):
  // session REST at /api/voice/realtime/* + the full-duplex WebSocket
  // (/api/voice/realtime/ws, wired in index.ts).
  if (deps.realtimeVoice) {
    router.use('/voice/realtime', createRealtimeVoiceRouter({ service: deps.realtimeVoice.service }));
  }

  // ---- Phase 4: muse-parity modules -------------------------------------
  const modulesRouter = express.Router();
  registerMuseModuleRoutes(modulesRouter, deps);
  router.use('/modules', modulesRouter);

  // ---- Entity tracing (coherence-lite): GET /api/entities/trace?q=... ----
  const entitiesRouter = express.Router();
  registerEntityTraceRoutes(entitiesRouter, {
    dataDir: config.dataDir,
    memoryStore: deps.tieredMemoryStore,
  });
  router.use('/entities', entitiesRouter);

  // ---- Octop parity: interactive terminal + agent teams --------------------
  const terminalRouter = express.Router();
  registerTerminalRoutes(terminalRouter, {
    workspaceDir: config.workspaceDir,
    agentRuntime,
    getBots: () => bots,
    governance,
  });
  router.use('/terminal', terminalRouter);

  const teamsRouter = express.Router();
  registerTeamRoutes(teamsRouter, {
    dataDir: config.dataDir,
    agentRuntime,
    getBots: () => bots,
    // Peer-delegation approval broker (workstream C): the teams API gates
    // bot→bot delegation on user approval through the approvals inbox.
    delegationBroker: deps.governanceAdapter,
    audit: (action, fields) => deps.governance.audit(action, fields),
  });
  router.use('/teams', teamsRouter);

  // Group goals (OpenMausBot parity P1 #11): bounded multi-turn
  // coordinator/worker runs with explicit completion decisions. Mounted
  // next to teams (no new top-level API surface beyond /group-goals).
  const groupGoalsRouter = express.Router();
  registerGroupGoalRoutes(groupGoalsRouter, {
    dataDir: config.dataDir,
    agentRuntime,
    getBots: () => bots,
    // Same peer-approval broker as teams: coordinator delegations ask the
    // user in the approvals inbox ('always-ask' semantics for ad-hoc goals).
    delegationBroker: deps.governanceAdapter,
    push: deps.push,
    audit: (action, fields) => governance.audit(action, fields),
    groupGoalHooks: deps.groupGoalHooks,
  });
  router.use('/group-goals', groupGoalsRouter);

  // Spaces: user-level contexts (Work/Personal, ...) with per-space model /
  // API-key / workspace overrides and pause/resume.
  const spaceStore = new SpaceStore(config.dataDir);
  const spacesRouter = express.Router();
  registerSpaceRoutes(spacesRouter, { spaceStore, dataDir: config.dataDir });
  router.use('/spaces', spacesRouter);

  // Remote-phone control v1 (Workspace → Phone tab). REST only — the live
  // WebSocket endpoint (/api/phone/ws) is wired to the HTTP server's
  // 'upgrade' event in index.ts, sharing deps.phone.hub.
  if (deps.phone) {
    const phoneRouter = express.Router();
    registerPhoneRoutes(phoneRouter, {
      store: deps.phone.store,
      hub: deps.phone.hub,
      adb: deps.phone.adb,
      audit: (action, fields) => governance.audit(action, fields),
    });
    router.use('/phone', phoneRouter);
  }

  // Companion app (phone → PC remote control). REST only — the live
  // WebSocket endpoint (/api/companion/ws) is wired to the HTTP server's
  // 'upgrade' event in index.ts, sharing deps.companion.hub.
  if (deps.companion) {
    const companionRouter = express.Router();
    registerCompanionRoutes(companionRouter, {
      store: deps.companion.store,
      hub: deps.companion.hub,
      audit: (action, fields) => governance.audit(action, fields),
      lanIp: getLanIp(),
      port: config.port,
      publicBaseUrl: config.publicBaseUrl,
      version: '0.1.0',
      localChatUrl: `http://127.0.0.1:${config.port}/api/chat`,
      governance,
      idResolver: governanceAdapter,
      workflowRunner,
      workflowLabel: (workflowId: string) => {
        try {
          return workflowRunner.getWorkflow(workflowId).name;
        } catch {
          return undefined;
        }
      },
      chatQueueStore,
      omniStore,
      dataDir: config.dataDir,
      getBots: () => bots,
      runControls: {
        activeTurns: () =>
          [...activeTurns.entries()].map(([sessionId, t]) => ({
            sessionId,
            botId: t.botId,
            startedAt: t.startedAt,
          })),
        abortTurn: (sessionId: string) => {
          const t = activeTurns.get(sessionId);
          if (!t) return false;
          t.controller.abort('cancelled from companion app');
          return true;
        },
      },
      mcpServer: deps.mcpServer,
      recordPreference: (botId, toolName, decision) => {
        try {
          const learned = preferenceStore.recordDecision(botId, toolName, decision);
          if (learned) {
            console.log(
              `[preferences] learned ${learned.preference} for ${botId}/${toolName} (${learned.observations} observations)`,
            );
          }
        } catch {
          // Preference recording must never break approval decisions.
        }
      },
    });
    router.use('/companion', companionRouter);

    // Remote screen viewing (phone -> PC, Codync parity). REST only — the
    // live frame WebSocket (/api/remote-screen/ws) is wired to the HTTP
    // server's 'upgrade' event in index.ts, sharing deps.remoteScreen.
    if (deps.remoteScreen) {
      router.use(
        '/remote-screen',
        createRemoteScreenRouter({
          store: deps.remoteScreen.store,
          service: deps.remoteScreen.service,
          audit: (action, fields) => governance.audit(action, fields),
        }),
      );
    }

    // Live run-status pushes to connected companion phones.
    workflowRunner.onRunUpdate((run) => {
      try {
        deps.companion?.hub.broadcast({
          type: 'run-status',
          run: { id: run.id, workflowId: run.workflowId, state: run.status },
        });
      } catch {
        // Pushes must never break the workflow runner.
      }
    });
  }

  return router;
}
