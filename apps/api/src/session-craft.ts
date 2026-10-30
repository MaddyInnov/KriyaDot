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

// ---------------------------------------------------------------------------
// #88 /schedule command + #172 /copy segment selectors (Octomind parity)
// ---------------------------------------------------------------------------

export interface ScheduleCommand {
  name: string;
  prompt: string;
  whenText: string;
}

/** Parse `/schedule <when...> :: <prompt>` or `/schedule <name> <prompt>` (fallback shape). */
export function parseScheduleCommand(message: string): ScheduleCommand | null {
  const m = /^\/schedule(?:\s+([\s\S]+))?$/.exec(message.trim());
  if (!m) return null;
  const rest = (m[1] ?? '').trim();
  if (!rest) return { name: '', prompt: '', whenText: '' };
  const sep = rest.indexOf('::');
  if (sep >= 0) {
    return { whenText: rest.slice(0, sep).trim(), name: rest.slice(0, sep).trim(), prompt: rest.slice(sep + 2).trim() };
  }
  const firstSpace = rest.indexOf(' ');
  if (firstSpace < 0) return { name: rest, prompt: '', whenText: rest };
  return { name: rest.slice(0, firstSpace).trim(), whenText: rest.slice(0, firstSpace).trim(), prompt: rest.slice(firstSpace + 1).trim() };
}

export type CopySegment = 'last' | 'assistant' | 'user' | 'all';

/**
 * Select the conversation text for /copy (#172). Returns the text the
 * CLIENT puts on the clipboard (the server never touches a clipboard).
 *  last      → the most recent message of any role
 *  assistant → every assistant message, blank-line separated
 *  user      → every user message
 *  all       → the whole transcript, role-labelled
 */
export function selectCopySegment(messages: IdentifiedMessage[], segment: CopySegment): string {
  if (segment === 'last') return messages[messages.length - 1]?.content ?? '';
  if (segment === 'assistant') return messages.filter((m) => m.role === 'assistant').map((m) => m.content).join('\n\n');
  if (segment === 'user') return messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n\n');
  return messages.map((m) => `${m.role}: ${m.content}`).join('\n\n');
}

// ---------------------------------------------------------------------------
// #37 — answer-part-of-a-reply: fragment (selection) replies
// ---------------------------------------------------------------------------
//
// The web chat lets the user select a fragment of one message and reply
// to just that fragment (apps/web/lib/octomind-web.ts buildFragmentReply).
// This is the API side of the same mechanic, in the SAME wire format:
//
//   <!-- quotedFragment -->
//   [Replying to a selection from message #<id> (<role>)]
//   > <fragment lines>
//
//   <the user's response>
//
// - buildFragmentReply (here) composes that message server-side and is
//   FAIL-CLOSED: the fragment must be a literal substring of the source
//   message's content, so a client cannot quote text the bot never said.
// - parseFragmentReply recognises/parses a composed fragment message
//   (e.g. one sent by the web client) back into its parts, so the chat
//   route can validate it against the session history the same way.
// - isFragmentReplyMessage is the cheap marker check for routing.

/** Marker line that opens a fragment reply (identical to the web client's). */
export const QUOTED_FRAGMENT_MARKER = '<!-- quotedFragment -->';

export interface FragmentReplyCommand {
  ref: string;
  /** The selected fragment — must occur verbatim in the source message. */
  fragment: string;
  text: string;
}

/**
 * Compose a fragment reply; null when the ref doesn't resolve OR the
 * fragment is not a verbatim substring of the source message.
 */
export function buildFragmentReply(
  messages: IdentifiedMessage[],
  command: FragmentReplyCommand,
): string | null {
  const source = resolveQuotedMessage(messages, command.ref);
  if (!source) return null;
  const fragment = command.fragment.trim();
  if (!fragment || !source.content.includes(fragment)) return null;
  const quoteBlock = fragment
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  const header = `[Replying to a selection from message #${source.id} (${source.role})]`;
  const body = command.text.trim();
  const quoted = `${QUOTED_FRAGMENT_MARKER}\n${header}\n${quoteBlock}`;
  return body ? `${quoted}\n\n${body}` : quoted;
}

/** True when a composed chat message is a #37 fragment reply. */
export function isFragmentReplyMessage(message: string): boolean {
  return message.trimStart().startsWith(QUOTED_FRAGMENT_MARKER);
}

export interface ParsedFragmentReply {
  messageId: number;
  role: string;
  fragment: string;
  text: string;
}

/** Parse a composed fragment reply back into its parts; null when malformed. */
export function parseFragmentReply(message: string): ParsedFragmentReply | null {
  const trimmed = message.trim();
  if (!trimmed.startsWith(QUOTED_FRAGMENT_MARKER)) return null;
  const rest = trimmed.slice(QUOTED_FRAGMENT_MARKER.length).replace(/^\n/, '');
  const header = /^\[Replying to a selection from message #(\d+) \(([^)]+)\)\]\n/.exec(rest);
  if (!header) return null;
  const lines = rest.slice(header[0].length).split('\n');
  const quoteLines: string[] = [];
  let i = 0;
  while (i < lines.length && lines[i]!.startsWith('> ')) {
    quoteLines.push(lines[i]!.slice(2));
    i += 1;
  }
  if (quoteLines.length === 0) return null;
  const text = lines.slice(i).join('\n').replace(/^\n+/, '').trim();
  return {
    messageId: Number(header[1]),
    role: header[2]!,
    fragment: quoteLines.join('\n'),
    text,
  };
}

/**
 * Validate a composed fragment reply against the session history:
 * the source message must exist and the quoted fragment must be a
 * verbatim substring of it. Returns the parsed reply when valid.
 */
export function validateFragmentReply(
  messages: IdentifiedMessage[],
  message: string,
): ParsedFragmentReply | null {
  const parsed = parseFragmentReply(message);
  if (!parsed) return null;
  const source = messages.find((m) => m.id === parsed.messageId);
  if (!source || source.role !== parsed.role) return null;
  if (!source.content.includes(parsed.fragment)) return null;
  return parsed;
}

export { express };
