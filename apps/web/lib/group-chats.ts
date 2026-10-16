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

import { getApiBase } from './api';

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
  authorType: 'user' | 'bot';
  authorBotId: string | null;
  text: string;
  threadId: string | null;
  createdAt: string;
}

export interface RoomTurnReply {
  botId: string;
  botName: string;
  text: string;
  messageId: string;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${getApiBase()}${path}`, {
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
): Promise<{ userMessage: GroupMessage; replies: RoomTurnReply[]; roundsCompleted: number; stoppedEarly: boolean }> {
  const r = await req<{
    userMessage: GroupMessage;
    replies: RoomTurnReply[];
    roundsCompleted: number;
    stoppedEarly: boolean;
  }>(`/api/groups/${id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ text }),
  });
  return {
    userMessage: r.userMessage,
    replies: r.replies,
    roundsCompleted: r.roundsCompleted,
    stoppedEarly: r.stoppedEarly,
  };
}

export async function stopGroupTurn(id: string): Promise<boolean> {
  const r = await req<{ stopped: boolean }>(`/api/groups/${id}/stop`, { method: 'POST' });
  return r.stopped;
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
