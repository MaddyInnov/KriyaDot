// SPDX-License-Identifier: Apache-2.0
// Host wiring for the bot-team tools (`list_bots`, `ask_bot`, `message_bot`).
//
// The tools are ordinary registry tools (deny-by-default approval flow).
// runBotTurn executes the target bot via agentRuntime.runTurn in a fresh
// session; the handoff chain (bot ids, requester first) is tracked per
// session id so nested ask_bot/message_bot calls see the full chain and the
// cycle / hop-limit guards in bot-team.ts hold.
//
// Exchanges are persisted in bot-conversations.db (BotConversationStore) so
// the conversation-sheet API can serve pair history.

import type {
  AgentRuntime,
  BotConfig,
  ProvenanceNote,
  StreamEvent,
  TokenUsage,
  ToolDefinition,
} from '@mvp/agent-runtime';
import { registerBotTeamTools } from '@mvp/agent-runtime';
import type { GovernanceAdapter } from './governance-adapter.js';
import { BotConversationStore } from './bot-conversations.js';

export interface BotTeamWiringOpts {
  registry: Map<string, ToolDefinition>;
  agentRuntime: AgentRuntime;
  dataDir: string;
  governanceAdapter: GovernanceAdapter;
  getBotConfig: (botId: string) => BotConfig | undefined;
  getBots: () => BotConfig[];
  audit: (
    action: string,
    fields: { actor?: string; sessionId?: string; toolName?: string; decision?: string; detail?: unknown },
  ) => void;
  askTimeoutMs?: number;
}

function newTeamSessionId(): string {
  return `bt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Register list_bots / ask_bot / message_bot. Returns the conversation
 * store (for the sheet API) — the caller owns its lifecycle.
 */
export function registerBotTeamToolsWiring(opts: BotTeamWiringOpts): BotConversationStore {
  const store = new BotConversationStore(opts.dataDir);

  /** sessionId → handoff chain (bot ids, requester first, target last). */
  const chains = new Map<string, string[]>();

  const runBotTurn = async (
    bot: BotConfig,
    message: string,
    turnOpts: { chain: string[]; timeoutMs?: number; provenance?: ProvenanceNote },
  ): Promise<{ text: string; usage?: TokenUsage }> => {
    const sessionId = newTeamSessionId();
    chains.set(sessionId, turnOpts.chain);
    let text = '';
    let usage: TokenUsage | undefined;
    const onEvent = async (e: StreamEvent): Promise<void> => {
      if (e.type === 'token' && typeof e.content === 'string') text += e.content;
      else if (e.type === 'done') usage = e.usage;
    };
    try {
      const returned = await opts.agentRuntime.runTurn({
        bot,
        message,
        sessionId,
        taskType: 'chat',
        // P1 #13: the target turn sees the relay's origin note — its message
        // is fenced as untrusted peer content and the consent rule applies.
        provenance: turnOpts.provenance,
        onEvent,
      });
      usage = usage ?? returned;
    } finally {
      chains.delete(sessionId);
    }
    return { text: text.trim(), usage };
  };

  const audit = (type: string, detail: unknown): void => {
    try {
      opts.audit(type, { actor: 'bot-team', detail });
    } catch {
      // Audit failures must never break bot collaboration.
    }
  };

  registerBotTeamTools(opts.registry, {
    getBotConfig: opts.getBotConfig,
    listBots: () =>
      opts.getBots().map((b) => ({
        id: b.id,
        name: b.name,
        description: b.description ?? '',
        agent: (b as { agent?: string }).agent,
      })),
    runBotTurn: async (bot, message, turnOpts) => {
      audit('bot-team.turn.start', { botId: bot.id, chain: turnOpts.chain });
      try {
        const result = await runBotTurn(bot, message, turnOpts);
        audit('bot-team.turn.done', { botId: bot.id, chain: turnOpts.chain });
        return result;
      } catch (err) {
        audit('bot-team.turn.failed', {
          botId: bot.id,
          chain: turnOpts.chain,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
    getChain: (sessionId: string) => chains.get(sessionId) ?? [],
    recordExchange: (exchange) => {
      const recorded = store.record(exchange);
      audit('bot-team.exchange', {
        id: recorded.id,
        type: recorded.type,
        from: recorded.sourceBotId,
        to: recorded.targetBotId,
      });
      return recorded;
    },
    updateExchange: (id, updates) => {
      store.update(id, updates);
    },
    askTimeoutMs: opts.askTimeoutMs,
  });

  return store;
}
