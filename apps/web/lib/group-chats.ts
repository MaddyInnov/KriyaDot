// SPDX-License-Identifier: Apache-2.0
// Client for the group chats (multi-bot rooms) API.
//
//   GET    /api/groups
//   POST   /api/groups
//   GET    /api/groups/:id
//   PATCH  /api/groups/:id
//   DELETE /api/groups/:id
//   POST   /api/groups/:id/members
//   GET    /api/groups/:id/messages
//   POST   /api/groups/:id/messages
//   POST   /api/groups/:id/stop

'use client';

import { authedFetch } from './api';

export interface GroupChat {
  id: string;
  name: string;
  description: string | null;
  memberBotIds: string[];
  createdAt: string;
}

export interface GroupMessage {
  id: string;
  groupId: string;
  authorType: 'user' | 'bot' | 'system';
  authorBotId: string | null;
  text: string;
  threadId: string | null;
  createdAt: string;
  /** Provenance note (P1 #13) on bot messages: origin + relay path. */
  provenance?: import('../components/provenance-chip').ProvenanceNoteDto;
}

export interface RoomTurnReply {
  botId: string;
  botName: string;
  text: string;
  messageId: string;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await authedFetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const json = (await res.json()) as { ok: boolean; error?: string } & T;
  if (!res.ok || !json.ok) {
    throw new Error(json.error || `Group API failed: ${res.status}`);
  }
  return json;
}

export async function listGroups(): Promise<GroupChat[]> {
  const r = await req<{ groups: GroupChat[] }>('/api/groups');
  return r.groups;
}

export async function createGroup(
  name: string,
  memberBotIds: string[],
  description?: string,
): Promise<{ group: GroupChat; created: boolean }> {
  const r = await req<{ group: GroupChat; created: boolean }>('/api/groups', {
    method: 'POST',
    body: JSON.stringify({ name, memberBotIds, description }),
  });
  return { group: r.group, created: r.created };
}

export async function getGroup(id: string): Promise<GroupChat> {
  const r = await req<{ group: GroupChat }>(`/api/groups/${id}`);
  return r.group;
}

export async function updateGroup(
  id: string,
  updates: { name?: string; description?: string | null; memberBotIds?: string[] },
): Promise<GroupChat> {
  const r = await req<{ group: GroupChat }>(`/api/groups/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
  return r.group;
}

export async function deleteGroup(id: string): Promise<void> {
  await req(`/api/groups/${id}`, { method: 'DELETE' });
}

export async function updateGroupMembers(
  id: string,
  add?: string[],
  remove?: string[],
): Promise<GroupChat> {
  const r = await req<{ group: GroupChat }>(`/api/groups/${id}/members`, {
    method: 'POST',
    body: JSON.stringify({ add, remove }),
  });
  return r.group;
}

export async function listGroupMessages(id: string, limit = 200): Promise<GroupMessage[]> {
  const r = await req<{ messages: GroupMessage[] }>(`/api/groups/${id}/messages?limit=${limit}`);
  return r.messages;
}

export async function sendGroupMessage(
  id: string,
  text: string,
  opts: { queue?: boolean; timeoutMin?: number } = {},
): Promise<{
  userMessage: GroupMessage;
  replies: RoomTurnReply[];
  roundsCompleted: number;
  stoppedEarly: boolean;
  queued?: boolean;
  position?: number;
  timedOut?: boolean;
  failures?: MemberFailure[];
  breakerTripped?: { reason: string; detail: string } | null;
}> {
  const q = new URLSearchParams();
  if (opts.queue) q.set('queue', '1');
  if (opts.timeoutMin) q.set('timeoutMin', String(opts.timeoutMin));
  const qs = q.toString();
  const r = await req<{
    userMessage: GroupMessage;
    replies: RoomTurnReply[];
    roundsCompleted: number;
    stoppedEarly: boolean;
    queued?: boolean;
    position?: number;
    timedOut?: boolean;
    failures?: MemberFailure[];
    breakerTripped?: { reason: string; detail: string } | null;
  }>(`/api/groups/${id}/messages${qs ? `?${qs}` : ''}`, {
    method: 'POST',
    body: JSON.stringify({ text }),
  });
  return {
    userMessage: r.userMessage,
    replies: r.replies ?? [],
    roundsCompleted: r.roundsCompleted ?? 0,
    stoppedEarly: r.stoppedEarly ?? false,
    queued: r.queued,
    position: r.position,
    timedOut: r.timedOut,
    failures: r.failures,
    breakerTripped: r.breakerTripped,
  };
}

export async function stopGroupTurn(id: string): Promise<boolean> {
  const r = await req<{ stopped: boolean }>(`/api/groups/${id}/stop`, { method: 'POST' });
  return r.stopped;
}

// ---- room robustness (OpenMausBot parity) ------------------------------------

export interface RoomRobustnessSettings {
  turnTimeoutMin: number;
  maxPostsPerMemberPerTurn: number;
  postsPerMinute: number;
  duplicateRepeatLimit: number;
  maxHeld: number;
}

export interface QueuedRoomMessage {
  id: string;
  groupId: string;
  messageId: string;
  text: string;
  timeoutMin: number | null;
  createdAt: string;
  attempts: number;
}

export interface MemberFailure {
  botId: string;
  botName: string;
  round: number;
  error: string;
  failureId: string | null;
}

export interface RoomFailure extends MemberFailure {
  id: string;
  groupId: string;
  prompt: string;
  userText: string;
  createdAt: string;
  retried: boolean;
  resolvedMessageId: string | null;
}

export interface RoomStatus {
  groupId: string;
  hold: 'active' | 'held' | 'halted';
  turnInFlight: boolean;
  turnStartedAt: string | null;
  queue: QueuedRoomMessage[];
  queueDepth: number;
  maxHeld: number;
  breaker: { reason: string; detail: string; at: string; botId?: string } | null;
  locks: Array<{ botId: string; turnId: string }>;
  settings: RoomRobustnessSettings;
  overrides: Record<string, number | null>;
}

export async function getRoomStatus(id: string): Promise<RoomStatus> {
  const r = await req<{ status: RoomStatus }>(`/api/groups/${id}/status`);
  return r.status;
}

export async function getRoomSettings(id: string): Promise<RoomRobustnessSettings> {
  const r = await req<{ settings: RoomRobustnessSettings }>(`/api/groups/${id}/settings`);
  return r.settings;
}

export async function updateRoomSettings(
  id: string,
  patch: Partial<RoomRobustnessSettings>,
): Promise<RoomRobustnessSettings> {
  const r = await req<{ settings: RoomRobustnessSettings }>(`/api/groups/${id}/settings`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  });
  return r.settings;
}

export async function holdRoom(id: string): Promise<RoomStatus> {
  const r = await req<{ status: RoomStatus }>(`/api/groups/${id}/hold`, { method: 'POST' });
  return r.status;
}

export async function haltRoom(id: string): Promise<RoomStatus> {
  const r = await req<{ status: RoomStatus }>(`/api/groups/${id}/halt`, { method: 'POST' });
  return r.status;
}

export async function releaseRoom(id: string): Promise<RoomStatus> {
  const r = await req<{ status: RoomStatus }>(`/api/groups/${id}/release`, { method: 'POST' });
  return r.status;
}

export async function listRoomQueue(id: string): Promise<QueuedRoomMessage[]> {
  const r = await req<{ queue: QueuedRoomMessage[] }>(`/api/groups/${id}/queue`);
  return r.queue;
}

export async function clearRoomQueue(id: string): Promise<number> {
  const r = await req<{ cleared: number }>(`/api/groups/${id}/queue`, { method: 'DELETE' });
  return r.cleared;
}

export async function listRoomFailures(id: string): Promise<RoomFailure[]> {
  const r = await req<{ failures: RoomFailure[] }>(`/api/groups/${id}/failures`);
  return r.failures;
}

export async function retryRoomFailure(id: string, failureId: string): Promise<GroupMessage> {
  const r = await req<{ message: GroupMessage }>(`/api/groups/${id}/failures/${failureId}/retry`, {
    method: 'POST',
  });
  return r.message;
}

/** Render @mentions with highlighting. Returns React-safe segments. */
export function renderWithMentions(
  text: string,
  memberNames: string[],
): Array<{ text: string; isMention: boolean }> {
  const lower = new Set(memberNames.map((n) => n.toLowerCase()));
  const parts: Array<{ text: string; isMention: boolean }> = [];
  const re = /@([A-Za-z0-9_.-]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index), isMention: false });
    const token = m[1].toLowerCase();
    const isMember =
      lower.has(token) ||
      token === 'all' ||
      token === 'everyone' ||
      [...lower].some((n) => n.startsWith(token) || n.replace(/\s+/g, '').startsWith(token));
    parts.push({ text: m[0], isMention: isMember });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), isMention: false });
  return parts;
}
