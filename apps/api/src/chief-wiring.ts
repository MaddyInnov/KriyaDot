// SPDX-License-Identifier: Apache-2.0
// Host wiring for the chief-of-staff tools (coordinate_bots,
// propose_team_setup, create_bot, propose_bot_deletion, raise_escalation,
// retry_thread).
//
// - The tools are ordinary registry tools (deny-by-default approval flow);
//   every handler also checks that the caller is the configured chief.
// - runBotTurn executes the target bot via agentRuntime.runTurn in a fresh
//   `chief_<…>` session.
// - A TurnContextProvider injects the chief section (live roster between
//   the fenced markers) into the system prompt of any bot flagged
//   `chiefOfStaff`, every turn — no modification of runtime.ts's
//   buildSystemPrompt.
// - The chief bot's in-memory tool list is extended with the six chief
//   tool names plus list_bots/ask_bot/message_bot (seed files untouched).

import type {
  AgentRuntime,
  BotConfig,
  StreamEvent,
  TokenUsage,
  ToolDefinition,
} from '@mvp/agent-runtime';
import {
  buildChiefSection,
  CHIEF_TOOL_NAMES,
  MAX_DELEGATION_RETRIES,
  registerChiefTools,
  shouldEscalate,
  type ChiefIncident,
} from '@mvp/agent-runtime';
import { ChiefTeamsStore } from './chief-teams.js';

export interface ChiefWiringOpts {
  registry: Map<string, ToolDefinition>;
  agentRuntime: AgentRuntime;
  dataDir: string;
  getBotConfig: (botId: string) => BotConfig | undefined;
  getBots: () => BotConfig[];
  audit: (
    action: string,
    fields: { actor?: string; sessionId?: string; toolName?: string; decision?: string; detail?: unknown },
  ) => void;
}

/** Chief tools plus the bot-team collaboration tools the chief needs. */
const CHIEF_REQUIRED_TOOLS = [
  CHIEF_TOOL_NAMES.coordinateBots,
  CHIEF_TOOL_NAMES.proposeTeamSetup,
  CHIEF_TOOL_NAMES.createBot,
  CHIEF_TOOL_NAMES.proposeBotDeletion,
  CHIEF_TOOL_NAMES.raiseEscalation,
  CHIEF_TOOL_NAMES.retryThread,
  'list_bots',
  'ask_bot',
  'message_bot',
];

function newChiefSessionId(): string {
  return `chief_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

interface RetryResult {
  incidentId: string;
  attempts: number;
  text?: string;
  exhausted?: boolean;
}

export type ChiefRetryDelegation = (threadId: string) => Promise<RetryResult | undefined>;

export interface ChiefWiringResult {
  /** Chief state store (for the /api/teams routes). */
  store: ChiefTeamsStore;
  /** Retry a failed delegation by thread id (for POST /incidents/:id/retry). */
  retryDelegation: ChiefRetryDelegation;
}

function storedBrief(detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  try {
    const parsed = JSON.parse(detail) as { brief?: unknown };
    return typeof parsed.brief === 'string' && parsed.brief.trim() ? parsed.brief : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Apply persisted chief state onto the in-memory bot list. Call at boot
 * (index.ts, after applyImportedBots): restores the chief flag + managed
 * sections from chief_config, applies approved field overrides to seed
 * bots, and removes bots deleted by approved proposals. Never touches
 * seed files.
 */
export function applyChiefOverlays(bots: BotConfig[], dataDir: string): void {
  const store = new ChiefTeamsStore(dataDir);
  try {
    const overrides = store.getBotOverrides();
    for (const bot of bots) {
      const patch = overrides[bot.id];
      if (!patch) continue;
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'id') continue;
        (bot as unknown as Record<string, unknown>)[key] = value;
      }
    }
    const deleted = new Set(store.getDeletedBotIds());
    for (let i = bots.length - 1; i >= 0; i--) {
      if (deleted.has(bots[i].id)) bots.splice(i, 1);
    }
    const config = store.getChiefConfig();
    if (config.chiefBotId) {
      const chief = bots.find((b) => b.id === config.chiefBotId);
      if (chief) {
        chief.chiefOfStaff = true;
        chief.managedSections = config.managedSections;
        for (const name of CHIEF_REQUIRED_TOOLS) {
          if (!chief.tools.includes(name)) chief.tools.push(name);
        }
      }
    }
  } finally {
    store.close();
  }
}

/**
 * Register the chief tools and the chief context provider. Returns the
 * store and the retry hook — the caller owns their lifecycle.
 */
export function registerChiefToolsWiring(opts: ChiefWiringOpts): ChiefWiringResult {
  const store = new ChiefTeamsStore(opts.dataDir);

  const audit = (type: string, detail: unknown): void => {
    try {
      opts.audit(type, { actor: 'chief', detail });
    } catch {
      // Audit failures must never break chief coordination.
    }
  };

  const runBotTurn = async (bot: BotConfig, message: string): Promise<{ text: string; usage?: TokenUsage }> => {
    const sessionId = newChiefSessionId();
    let text = '';
    let usage: TokenUsage | undefined;
    const onEvent = async (e: StreamEvent): Promise<void> => {
      if (e.type === 'token' && typeof e.content === 'string') text += e.content;
      else if (e.type === 'done') usage = e.usage;
    };
    // P1 #13: chief → member briefs are bot-to-bot relays — the member's
    // turn carries the chief's origin note.
    const chiefId = store.getChiefConfig().chiefBotId;
    const chiefName = chiefId ? opts.getBotConfig(chiefId)?.name : undefined;
    try {
      const returned = await opts.agentRuntime.runTurn({
        bot,
        message,
        sessionId,
        taskType: 'chat',
        provenance: chiefId
          ? {
              origin: 'bot' as const,
              originBotId: chiefId,
              originBotName: chiefName,
              relayPath: [chiefId, bot.id],
              relayNames: [chiefName ?? chiefId, bot.name],
              timestamp: new Date().toISOString(),
            }
          : undefined,
        onEvent,
      });
      usage = usage ?? returned;
    } finally {
      audit('chief.turn', { botId: bot.id, sessionId });
    }
    return { text: text.trim(), usage };
  };

  const reportIncidentHost = (
    incident: Parameters<ChiefTeamsStore['reportIncident']>[0],
  ): ChiefIncident => {
    const created = store.reportIncident(incident);
    audit('chief.incident', { id: created.id, kind: created.kind, target: created.targetBotId });
    return created;
  };

  const retryDelegation = async (threadId: string): Promise<RetryResult | undefined> => {
    const incident = store.getIncidentByThread(threadId);
    if (!incident) return undefined;
    const attempts = incident.attempts + 1;
    const brief = storedBrief(incident.detail);
    const target = incident.targetBotId ? opts.getBotConfig(incident.targetBotId) : undefined;
    if (!brief || !target) {
      // Nothing to re-run with: mark it triaged so a human looks at it.
      const updated = store.updateIncident(incident.id, { status: 'triaged', attempts });
      audit('chief.retry.no-brief', { incidentId: incident.id, attempts });
      return updated ? { incidentId: updated.id, attempts: updated.attempts, exhausted: true } : undefined;
    }
    try {
      const { text } = await runBotTurn(target, brief);
      const updated = store.updateIncident(incident.id, {
        status: 'resolved',
        attempts,
        detail: JSON.stringify({ brief, result: text.slice(0, 4000) }),
      });
      audit('chief.retry.done', { incidentId: incident.id, attempts });
      return { incidentId: incident.id, attempts, text: text.slice(0, 4000) };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (shouldEscalate(attempts)) {
        // Budget spent: triage the incident and file an escalation so the
        // user sees it in the escalations inbox.
        store.updateIncident(incident.id, {
          status: 'triaged',
          attempts,
          detail: JSON.stringify({ brief, error }),
        });
        reportIncidentHost({
          kind: 'escalation',
          chiefBotId: incident.chiefBotId,
          targetBotId: incident.targetBotId,
          targetBotName: incident.targetBotName,
          threadId: incident.threadId,
          summary: `Delegation to ${incident.targetBotName ?? incident.targetBotId ?? 'specialist'} failed ${attempts} times — needs your decision: ${error}`.slice(0, 500),
          attempts,
        });
        audit('chief.retry.exhausted', { incidentId: incident.id, attempts });
        return { incidentId: incident.id, attempts, exhausted: true };
      }
      store.updateIncident(incident.id, {
        attempts,
        detail: JSON.stringify({ brief, error }),
      });
      audit('chief.retry.failed', { incidentId: incident.id, attempts });
      return { incidentId: incident.id, attempts };
    }
  };

  registerChiefTools(opts.registry, {
    isChief: (id) => store.getChiefConfig().chiefBotId === id,
    getBotConfig: opts.getBotConfig,
    runBotTurn,
    sendMessage: async (bot, message) => {
      // The host maps fire-and-forget onto the message_bot path semantics:
      // own session, confirmation now. message_bot itself is registered on
      // the registry, so run it as a background turn.
      const sessionId = newChiefSessionId();
      void runBotTurn(bot, message).catch(() => undefined);
      audit('chief.notify', { botId: bot.id, sessionId });
      return { queued: true };
    },
    createProposal: (proposal) => {
      const created = store.createProposal(proposal);
      audit('chief.proposal', { id: created.id, kind: created.kind });
      return created;
    },
    reportIncident: (incident) => reportIncidentHost({ ...incident, kind: 'incident' }),
    reportEscalation: (escalation) => reportIncidentHost({ ...escalation, kind: 'escalation' }),
    retryDelegation,
    wouldCreateSecondChief: (operations) => {
      const currentChiefId = store.getChiefConfig().chiefBotId;
      const demoted = new Set(
        operations
          .filter((op) => op.action === 'update' && (op.fields as Record<string, unknown> | undefined)?.chiefOfStaff === false)
          .map((op) => op.botId),
      );
      const createsChief = operations.some((op) => {
        if (op.action !== 'create') return false;
        return (op.fields as Record<string, unknown> | undefined)?.chiefOfStaff === true;
      });
      if (!createsChief || !currentChiefId) return false;
      return !demoted.has(currentChiefId);
    },
  });

  // Fresh roster injection every turn for the chief bot.
  opts.agentRuntime.addContextProvider((info) => {
    if (!info.bot.chiefOfStaff) return undefined;
    return buildChiefSection(info.bot, opts.getBots());
  });

  // The chief needs its tools on the in-memory config (seed files untouched).
  const chiefId = store.getChiefConfig().chiefBotId;
  if (chiefId) {
    const chief = opts.getBotConfig(chiefId);
    if (chief) {
      chief.chiefOfStaff = true;
      chief.managedSections = store.getChiefConfig().managedSections;
      for (const name of CHIEF_REQUIRED_TOOLS) {
        if (!chief.tools.includes(name)) chief.tools.push(name);
      }
    }
  }

  return { store, retryDelegation };
}
