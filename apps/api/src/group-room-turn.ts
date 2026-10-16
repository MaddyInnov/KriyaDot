// SPDX-License-Identifier: Apache-2.0
// Group chat room-turn orchestration (Codync's model: host/src/chat/group.rs).
//
// When the user sends a message to a group, a *room turn* starts:
//   - Up to 3 rounds, 10 replies total per room turn.
//   - Who answers each round: members @-mentioned in the message (full name,
//     name without spaces, or first word; @all / @everyone), or everyone if
//     no mentions.
//   - Members speak one at a time, sequentially. Each round starts one
//     member later (rotation), so @all rooms don't always start with the
//     same bot.
//   - Each member runs in its OWN session (history unified across chats),
//     told who's in the room and what was said since it last spoke, framed
//     as `[Group chat: "<name>" - with ...]`. Its final reply is the one
//     message the room sees. A reply of exactly `(pass)` means "say nothing".
//   - A round where nobody speaks ends the room turn early.
//
// Design notes:
//   - Sequential, not parallel: simple and robust. Parallel fan-out is a
//     future optimization (members don't depend on each other's replies
//     within a round, but ordering + approval flows are simpler sequential).
//   - Each member's turn goes through the normal agentRuntime.runTurn path,
//     so approvals, queueing, telemetry and governance all apply unchanged.
//   - A new user message starts a new room turn; callers should cancel any
//     in-flight turn for the group first (see routes: the `stop` flag).

import type { BotConfig, StreamEvent, TokenUsage } from '@mvp/agent-runtime';
import type { GroupChat, GroupChatStore, GroupMessage } from './group-chats.js';

export const MAX_ROOM_ROUNDS = 3;
export const MAX_ROOM_REPLIES = 10;
/** A member reply of exactly this (case-insensitive, trimmed) says nothing. */
export const PASS_REPLY = '(pass)';

export interface RoomTurnDeps {
  store: GroupChatStore;
  /** Resolve a bot id to its config (seed roster + imports). */
  getBot: (botId: string) => BotConfig | undefined;
  /**
   * Run one member's turn. Implementations should call
   * agentRuntime.runTurn({ bot, message, onEvent }) and collect the final
   * text from token events, exactly like the delegate tool does.
   */
  runMemberTurn: (bot: BotConfig, prompt: string) => Promise<{ text: string; usage?: TokenUsage }>;
  /** Persist a bot reply to the group's transcript. */
  onReply?: (msg: GroupMessage) => void;
  /** Optional per-speaker callback (for SSE streaming to clients). */
  onSpeakerStart?: (botId: string, round: number) => void;
  /** Abort signal: when true, stop before the next speaker. */
  isCancelled?: () => boolean;
}

export interface RoomTurnResult {
  replies: Array<{ botId: string; botName: string; text: string; messageId: string }>;
  roundsCompleted: number;
  stoppedEarly: boolean;
  /** True when a round produced zero replies (natural end). */
  quietRound: boolean;
}

/**
 * Parse @mentions from message text.
 *
 * Returns the matched member bot ids, in roster order. Matching rules
 * (Codync's: full name, name without spaces, or first word):
 *   - `@all` / `@everyone` → all members
 *   - `@<name>` → case-insensitive match against bot name, name with
 *     spaces removed, or first word of the name; prefix match allowed
 *     (e.g. `@cod` matches "Coder")
 *   - No mentions → [] (caller treats as "everyone replies")
 */
export function parseMentions(text: string, members: BotConfig[]): BotConfig[] {
  const mentionRe = /@([A-Za-z0-9_.-]+)/g;
  const tokens = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = mentionRe.exec(text)) !== null) {
    tokens.add(m[1].toLowerCase());
  }
  if (tokens.size === 0) return [];
  if (tokens.has('all') || tokens.has('everyone')) return [...members];

  const matched: BotConfig[] = [];
  const seen = new Set<string>();
  for (const bot of members) {
    const nameLower = bot.name.toLowerCase();
    const noSpaces = nameLower.replace(/\s+/g, '');
    const firstWord = nameLower.split(/\s+/)[0];
    const idLower = bot.id.toLowerCase();
    for (const token of tokens) {
      if (
        token === nameLower ||
        token === noSpaces ||
        token === firstWord ||
        token === idLower ||
        nameLower.startsWith(token) ||
        noSpaces.startsWith(token) ||
        idLower.startsWith(token)
      ) {
        if (!seen.has(bot.id)) {
          matched.push(bot);
          seen.add(bot.id);
        }
        break;
      }
    }
  }
  return matched;
}

/** Strip @mention tokens from text for cleaner prompts (keeps readability). */
export function stripMentions(text: string): string {
  return text.replace(/@([A-Za-z0-9_.-]+)/g, '$1').trim();
}

function memberNames(members: BotConfig[]): string {
  return members.map((b) => b.name).join(', ');
}

/**
 * Build the prompt for one member's turn in the room.
 *
 * The member is told who's in the room, what the user said, and what other
 * members have said so far this turn — framed as a group chat so the model
 * understands it's one voice among several.
 */
export function buildMemberPrompt(args: {
  group: GroupChat;
  members: BotConfig[];
  userText: string;
  priorReplies: Array<{ botName: string; text: string }>;
  round: number;
}): string {
  const { group, members, userText, priorReplies, round } = args;
  const lines: string[] = [
    `[Group chat: "${group.name}" — with ${memberNames(members)}]`,
  ];
  if (group.description) {
    lines.push(`Room purpose: ${group.description}`);
  }
  lines.push('', `The user said: ${stripMentions(userText)}`);
  if (priorReplies.length > 0) {
    lines.push('', 'Other members have said so far:');
    for (const r of priorReplies) {
      lines.push(`- ${r.botName}: ${r.text}`);
    }
  }
  lines.push(
    '',
    `Reply as yourself in this group chat (round ${round}). Be concise and additive — ` +
      `don't repeat what others already said. If you have nothing to add, reply with exactly: ${PASS_REPLY}`,
  );
  return lines.join('\n');
}

function isPass(text: string): boolean {
  return text.trim().toLowerCase() === PASS_REPLY;
}

/**
 * Run a room turn: the user message has already been persisted; now each
 * responding member speaks in turn. Replies are persisted via store and
 * returned in order.
 */
export async function runRoomTurn(
  group: GroupChat,
  userText: string,
  deps: RoomTurnDeps,
): Promise<RoomTurnResult> {
  const members = group.memberBotIds
    .map((id) => deps.getBot(id))
    .filter((b): b is BotConfig => b !== undefined);
  if (members.length === 0) {
    return { replies: [], roundsCompleted: 0, stoppedEarly: false, quietRound: true };
  }

  // Who answers: @-mentioned members, or everyone when no mentions.
  const mentioned = parseMentions(userText, members);
  const speakers = mentioned.length > 0 ? mentioned : members;

  const replies: RoomTurnResult['replies'] = [];
  const priorReplies: Array<{ botName: string; text: string }> = [];
  let roundsCompleted = 0;
  let stoppedEarly = false;
  let quietRound = false;

  // Rotation offset: each round starts one member later in the speaker list.
  for (let round = 1; round <= MAX_ROOM_ROUNDS; round++) {
    if (replies.length >= MAX_ROOM_REPLIES) break;
    if (deps.isCancelled?.()) {
      stoppedEarly = true;
      break;
    }
    const offset = (round - 1) % speakers.length;
    const ordered = [...speakers.slice(offset), ...speakers.slice(0, offset)];
    let roundReplies = 0;

    for (const bot of ordered) {
      if (replies.length >= MAX_ROOM_REPLIES) break;
      if (deps.isCancelled?.()) {
        stoppedEarly = true;
        break;
      }
      deps.onSpeakerStart?.(bot.id, round);
      const prompt = buildMemberPrompt({
        group,
        members,
        userText,
        priorReplies,
        round,
      });
      let text: string;
      try {
        const result = await deps.runMemberTurn(bot, prompt);
        text = (result.text ?? '').trim();
      } catch {
        // A member that errors skips its turn; the room continues.
        continue;
      }
      if (!text || isPass(text)) continue;

      const msg = deps.store.addMessage(group.id, 'bot', text, bot.id);
      replies.push({ botId: bot.id, botName: bot.name, text, messageId: msg.id });
      priorReplies.push({ botName: bot.name, text });
      roundReplies++;
      deps.onReply?.(msg);
    }

    roundsCompleted = round;
    if (roundReplies === 0) {
      quietRound = true;
      break;
    }
  }

  return { replies, roundsCompleted, stoppedEarly, quietRound };
}

/** Re-exported for tests: resolve which members speak for a message. */
export function resolveSpeakers(userText: string, members: BotConfig[]): BotConfig[] {
  const mentioned = parseMentions(userText, members);
  return mentioned.length > 0 ? mentioned : members;
}
