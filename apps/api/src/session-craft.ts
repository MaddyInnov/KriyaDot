// SPDX-License-Identifier: Apache-2.0

/**
 * Session craft (Octomind parity, Tier 3): /reply quoting + /context.
 *
 * /reply <ref> <text> — quote an earlier message in this session: the
 * referenced message (by `#<messageId>` or by 1-based position) is
 * wrapped as a quote block ahead of the user's text, so the bot sees
 * exactly what is being replied to — the chat equivalent of email's
 * quoted thread. Unknown refs are a usage error, never a silent send.
 *
 * /context (chat command) and GET /sessions/:id/context (endpoint) —
 * an honest inspector of what this session's history currently holds:
 * message counts by role, character/token estimates, and the lossless
 * compaction archives standing behind the summary. Estimates are
 * labeled as estimates (chars/4 heuristic), never dressed up as
 * provider-exact token counts.
 */

import express, { type Router } from 'express';
import type { AgentRuntime, IdentifiedMessage } from '@mvp/agent-runtime';

export interface ReplyCommand {
  ref: string;
  text: string;
}

/** Parse `/reply <ref> <text>`; null when the message is not a /reply. */
export function parseReplyCommand(message: string): ReplyCommand | null {
  const m = /^\/reply(?:\s+(\S+)(?:\s+([\s\S]+))?)?$/.exec(message.trim());
  if (!m) return null;
  return { ref: m[1] ?? '', text: (m[2] ?? '').trim() };
}

/** Resolve a /reply ref against the thread: `#<id>` = message id, `<n>` = 1-based position. */
export function resolveQuotedMessage(
  messages: IdentifiedMessage[],
  ref: string,
): IdentifiedMessage | undefined {
  if (ref.startsWith('#')) {
    const id = Number(ref.slice(1));
    return Number.isInteger(id) ? messages.find((msg) => msg.id === id) : undefined;
  }
  const pos = Number(ref);
  if (Number.isInteger(pos) && pos >= 1 && pos <= messages.length) return messages[pos - 1];
  // A bare number may also be a message id when positions don't reach it.
  return messages.find((msg) => msg.id === pos);
}

const QUOTE_EXCERPT_CHARS = 600;

/** Wrap user text with the quoted message; null when the ref doesn't resolve. */
export function buildQuotedReply(
  messages: IdentifiedMessage[],
  command: ReplyCommand,
): string | null {
  const quoted = resolveQuotedMessage(messages, command.ref);
  if (!quoted) return null;
  const excerpt =
    quoted.content.length > QUOTE_EXCERPT_CHARS
      ? `${quoted.content.slice(0, QUOTE_EXCERPT_CHARS)}…`
      : quoted.content;
  const quoteBlock = excerpt
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  return `[Replying to message #${quoted.id} (${quoted.role})]\n${quoteBlock}\n\n${command.text}`;
}

export interface ContextReport {
  sessionId: string;
  botId?: string;
  messages: number;
  byRole: Record<string, number>;
  historyChars: number;
  /** Rough estimate (chars / 4) — labeled, never provider-exact. */
  estimatedHistoryTokens: number;
  oldestAt?: string;
  newestAt?: string;
  compactionArchives: Array<{ id: string; messageCount: number; createdAt: string }>;
}

export function buildContextReport(
  sessionId: string,
  botId: string | undefined,
  messages: IdentifiedMessage[],
  archives: Array<{ id: string; messageCount: number; createdAt: string }>,
): ContextReport {
  const byRole: Record<string, number> = {};
  let chars = 0;
  for (const m of messages) {
    byRole[m.role] = (byRole[m.role] ?? 0) + 1;
    chars += m.content.length;
  }
  return {
    sessionId,
    ...(botId ? { botId } : {}),
    messages: messages.length,
    byRole,
    historyChars: chars,
    estimatedHistoryTokens: Math.round(chars / 4),
    ...(messages.length > 0
      ? { oldestAt: messages[0]!.ts, newestAt: messages[messages.length - 1]!.ts }
      : {}),
    compactionArchives: archives,
  };
}

/** One-line human summary of a context report (for the /context chat reply). */
export function formatContextSummary(report: ContextReport): string {
  const roles = Object.entries(report.byRole)
    .map(([role, n]) => `${n} ${role}`)
    .join(', ');
  const archives =
    report.compactionArchives.length > 0
      ? ` ${report.compactionArchives.length} compaction archive(s) hold the folded originals (recall_compacted_context can fetch them).`
      : '';
  return (
    `📚 Context for this session: ${report.messages} messages (${roles}), ` +
    `~${report.estimatedHistoryTokens} estimated history tokens (${report.historyChars} chars).${archives}`
  );
}

function errorBody(error: string, detail?: string): { error: string; detail?: string } {
  return detail ? { error, detail } : { error };
}

/** GET /sessions/:id/context — the context inspector endpoint. */
export function registerSessionContextRoute(router: Router, deps: { agentRuntime: AgentRuntime }): void {
  router.get('/sessions/:id/context', (req, res) => {
    const sessionId = req.params.id;
    try {
      const messages = deps.agentRuntime.listThreadMessages(sessionId);
      const archives = deps.agentRuntime
        .listCompactionArchives(sessionId)
        .map((a) => ({ id: a.id, messageCount: a.messageCount, createdAt: a.createdAt }));
      const report = buildContextReport(
        sessionId,
        deps.agentRuntime.getSessionBotId(sessionId),
        messages,
        archives,
      );
      res.json(report);
    } catch (err) {
      res.status(500).json(errorBody('Failed to build context report', err instanceof Error ? err.message : String(err)));
    }
  });
}

export { express };
