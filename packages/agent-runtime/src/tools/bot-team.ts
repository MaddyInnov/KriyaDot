// SPDX-License-Identifier: Apache-2.0
// Bot-to-bot collaboration tools (Codync parity: the `team` MCP server).
//
//   list_bots   — discover the other visible bots (id, name, description, agent)
//   ask_bot     — synchronous request/reply: ask another bot, wait for its reply
//   message_bot — fire-and-forget: send another bot a message, get confirmation now
//
// Every exchange is recorded by the host (recordExchange) so conversation
// sheets can show the pair's whole history. Handoff chains are tracked per
// session by the host (getChain): a chain longer than MAX_HANDOFFS, or one
// that would revisit a bot, is rejected with a clear error instead of
// running (Codync: 8-handoff limit, wait-graph cycle rejection).
//
// Governance: these are ordinary registry tools — they pass through the same
// deny-by-default approval flow as every other tool. The recipient runs its
// own turn under its own policy; only the request text is passed, never the
// requester's transcript.

import type { BotConfig, ToolContext, ToolDefinition } from '../types.js';

export const BOT_TEAM_TOOL_NAMES = {
  listBots: 'list_bots',
  askBot: 'ask_bot',
  messageBot: 'message_bot',
} as const;

/** Maximum bot-to-bot handoffs in one chain (Codync: 8). */
export const MAX_BOT_HANDOFFS = 8;

/** Default wait for ask_bot, including queue + approval time (Codync: 10 min; ours is shorter). */
export const DEFAULT_ASK_TIMEOUT_MS = 120_000;

export type BotExchangeType = 'ask' | 'message';
export type BotExchangeStatus = 'pending' | 'completed' | 'failed';

export interface BotExchange {
  id: string;
  sourceBotId: string;
  targetBotId: string;
  type: BotExchangeType;
  /** The request text. */
  text: string;
  /** ask_bot reply (completed) — at most 4000 chars like Codync. */
  reply?: string;
  status: BotExchangeStatus;
  /** Failure/cancellation detail. */
  detail?: string;
  createdAt: string;
  completedAt?: string;
}

export interface BotSummary {
  id: string;
  name: string;
  description: string;
  agent?: string;
}

export interface CreateBotTeamToolsOptions {
  /** Resolve a bot id to its config (validates targets). */
  getBotConfig: (botId: string) => BotConfig | undefined;
  /** Visible bots for list_bots (excludes the caller). */
  listBots: () => BotSummary[];
  /**
   * Run one target-bot turn and return its final text. The host wires this
   * to agentRuntime.runTurn with a fresh session; `chain` is the handoff
   * chain INCLUDING the target (for nested ask_bot/message_bot calls).
   */
  runBotTurn: (
    bot: BotConfig,
    message: string,
    opts: { chain: string[]; timeoutMs?: number },
  ) => Promise<{ text: string }>;
  /**
   * Current handoff chain for a session (bot ids, requester first).
   * Defaults to [ctx.botId] when the host has no record.
   */
  getChain: (sessionId: string) => string[];
  /** Persist an exchange; returns it with id + createdAt filled in. */
  recordExchange: (
    exchange: Omit<BotExchange, 'id' | 'createdAt'>,
  ) => BotExchange;
  /** Update an exchange (status/reply/detail/completedAt). */
  updateExchange: (id: string, updates: Partial<BotExchange>) => void;
  /** Ask timeout override (ms). */
  askTimeoutMs?: number;
}

const BOT_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function cleanBotId(raw: unknown): string {
  const id = typeof raw === 'string' ? raw.trim() : '';
  if (!id || !BOT_ID_RE.test(id)) {
    throw new Error('bot_id must be a non-empty bot id ([a-zA-Z0-9_-], max 64 chars)');
  }
  return id;
}

function cleanText(raw: unknown, maxLen: number): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) throw new Error('message must be a non-empty string');
  return text.length > maxLen ? text.slice(0, maxLen) : text;
}

/**
 * Validate a handoff: no self-talk, no cycles, chain within the hop limit.
 * Returns the new chain (parent chain + target).
 */
export function checkHandoff(
  chain: string[],
  sourceBotId: string,
  targetBotId: string,
): string[] {
  if (targetBotId === sourceBotId) {
    throw new Error(`Cannot message yourself ("${sourceBotId}"). Pick a different bot.`);
  }
  if (chain.includes(targetBotId)) {
    throw new Error(
      `Bot handoff cycle detected: ${[...chain, targetBotId].join(' → ')}. ` +
        'The recipient should reply directly instead of messaging back.',
    );
  }
  if (chain.length >= MAX_BOT_HANDOFFS) {
    throw new Error(
      `Bot handoff chain limit reached (${MAX_BOT_HANDOFFS} hops: ${chain.join(' → ')}). ` +
        'Start a new user turn for a fresh chain.',
    );
  }
  return [...chain, targetBotId];
}

export function createBotTeamTools(opts: CreateBotTeamToolsOptions): ToolDefinition[] {
  const askTimeoutMs = opts.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;

  const listBotsTool: ToolDefinition = {
    name: BOT_TEAM_TOOL_NAMES.listBots,
    description: [
      'List the other bots you can collaborate with.',
      'Returns each bot\'s id, name, description and agent backend.',
      'Use ask_bot to get a synchronous answer, message_bot to send a',
      'fire-and-forget message.',
    ].join('\n'),
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (_args, ctx: ToolContext) => {
      return {
        bots: opts.listBots().filter((b) => b.id !== ctx.botId),
      };
    },
  };

  const askBotTool: ToolDefinition = {
    name: BOT_TEAM_TOOL_NAMES.askBot,
    description: [
      'Ask another bot a question and wait for its reply (synchronous).',
      'The recipient runs in its own session with its own folder, tools,',
      'memory and permission policy; only your request text is passed, not',
      'your transcript. Its reply is returned to you — incorporate it into',
      'your answer. The recipient should answer directly, not message back.',
      '',
      'Args:',
      '- bot_id (string, required): the target bot\'s id (see list_bots).',
      '- message (string, required): self-contained request with all context',
      '  the recipient needs.',
      '',
      `Waits up to ${Math.round(askTimeoutMs / 1000)}s. Handoff chains are limited`,
      `to ${MAX_BOT_HANDOFFS} hops and cycles are rejected.`,
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        bot_id: {
          type: 'string',
          description: 'Target bot id (from list_bots).',
        },
        message: {
          type: 'string',
          description: 'Self-contained request for the target bot.',
        },
      },
      required: ['bot_id', 'message'],
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>, ctx: ToolContext) => {
      const targetId = cleanBotId(args.bot_id);
      const message = cleanText(args.message, 8000);
      const target = opts.getBotConfig(targetId);
      if (!target) throw new Error(`ask_bot: unknown bot "${targetId}" (see list_bots)`);
      const parentChain = opts.getChain(ctx.sessionId);
      const newChain = checkHandoff(
        parentChain.length > 0 ? parentChain : [ctx.botId],
        ctx.botId,
        targetId,
      );

      const exchange = opts.recordExchange({
        sourceBotId: ctx.botId,
        targetBotId: targetId,
        type: 'ask',
        text: message,
        status: 'pending',
      });

      const run = opts.runBotTurn(target, message, { chain: newChain, timeoutMs: askTimeoutMs });
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('ask_bot timed out waiting for a reply')), askTimeoutMs),
      );
      try {
        const { text } = await Promise.race([run, timeout]);
        const reply = text.trim().slice(0, 4000);
        if (!reply) throw new Error('ask_bot: the recipient returned an empty reply');
        opts.updateExchange(exchange.id, {
          status: 'completed',
          reply,
          completedAt: new Date().toISOString(),
        });
        return {
          reply,
          exchangeId: exchange.id,
          notice: {
            type: 'ask',
            sourceBotId: ctx.botId,
            targetBotId: targetId,
            text: message,
            reply,
            status: 'completed',
          },
        };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        opts.updateExchange(exchange.id, {
          status: 'failed',
          detail,
          completedAt: new Date().toISOString(),
        });
        throw new Error(`ask_bot to "${targetId}" failed: ${detail}`);
      }
    },
  };

  const messageBotTool: ToolDefinition = {
    name: BOT_TEAM_TOOL_NAMES.messageBot,
    description: [
      'Send another bot a message without waiting (fire-and-forget).',
      'The recipient processes it in its own session and reports in its own',
      'chat; you get an immediate confirmation. Its reply appears in the',
      'pair\'s conversation sheet (not in your chat).',
      '',
      'Args:',
      '- bot_id (string, required): the target bot\'s id (see list_bots).',
      '- message (string, required): self-contained message with all context',
      '  the recipient needs.',
      '',
      `Handoff chains are limited to ${MAX_BOT_HANDOFFS} hops and cycles are rejected.`,
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        bot_id: {
          type: 'string',
          description: 'Target bot id (from list_bots).',
        },
        message: {
          type: 'string',
          description: 'Self-contained message for the target bot.',
        },
      },
      required: ['bot_id', 'message'],
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>, ctx: ToolContext) => {
      const targetId = cleanBotId(args.bot_id);
      const message = cleanText(args.message, 8000);
      const target = opts.getBotConfig(targetId);
      if (!target) throw new Error(`message_bot: unknown bot "${targetId}" (see list_bots)`);
      const parentChain = opts.getChain(ctx.sessionId);
      const newChain = checkHandoff(
        parentChain.length > 0 ? parentChain : [ctx.botId],
        ctx.botId,
        targetId,
      );

      const exchange = opts.recordExchange({
        sourceBotId: ctx.botId,
        targetBotId: targetId,
        type: 'message',
        text: message,
        status: 'pending',
      });

      // Fire-and-forget: don't await. Record the outcome when it settles.
      void opts
        .runBotTurn(target, message, { chain: newChain })
        .then(({ text }) => {
          opts.updateExchange(exchange.id, {
            status: 'completed',
            reply: text.trim().slice(0, 4000) || undefined,
            completedAt: new Date().toISOString(),
          });
        })
        .catch((err: unknown) => {
          opts.updateExchange(exchange.id, {
            status: 'failed',
            detail: err instanceof Error ? err.message : String(err),
            completedAt: new Date().toISOString(),
          });
        });

      return {
        queued: true,
        exchangeId: exchange.id,
        notice: {
          type: 'message',
          sourceBotId: ctx.botId,
          targetBotId: targetId,
          text: message,
          status: 'pending',
        },
      };
    },
  };

  return [listBotsTool, askBotTool, messageBotTool];
}

/** Register the bot-team tools in a registry (delegate-tool pattern). */
export function registerBotTeamTools(
  registry: Map<string, ToolDefinition>,
  opts: CreateBotTeamToolsOptions,
): void {
  for (const tool of createBotTeamTools(opts)) {
    if (!registry.has(tool.name)) {
      registry.set(tool.name, tool);
    }
  }
}
