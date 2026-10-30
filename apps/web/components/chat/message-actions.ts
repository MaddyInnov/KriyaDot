// SPDX-License-Identifier: Apache-2.0
// Per-message action helpers (Muse parity §4.5 C-9 / C-12).
// Pure logic shared by the chat page's message menu: C-12 share/export
// payloads and the C-9 "can I delete this?" affordance. The SERVER is
// the authority for both (message-share.ts / message-delete.ts) — these
// helpers only decide what the UI offers and how exports are named.

export type MessageRole = 'user' | 'assistant' | 'tool' | 'system';

export interface ActionableMessage {
  role: MessageRole;
  content: string;
}

/** C-12: share/export is offered for user + assistant utterances only. */
export function canShareMessage(m: ActionableMessage): boolean {
  return (m.role === 'user' || m.role === 'assistant') && m.content.trim().length > 0;
}

/** C-9: delete is offered only on the user's own messages (server re-checks). */
export function canDeleteOwnMessage(m: ActionableMessage): boolean {
  return m.role === 'user';
}

/** Text handed to the clipboard / Web Share API for "Share as text". */
export function buildMessageShareText(m: ActionableMessage): string {
  return m.content;
}

export function messageExportFileName(sessionId: string, messageId: number | string, format: 'text' | 'markdown' | 'json'): string {
  const ext = format === 'json' ? 'json' : format === 'markdown' ? 'md' : 'txt';
  return `message-${sessionId.slice(0, 8)}-${messageId}.${ext}`;
}

/** API paths for the per-message actions (mounted per the WIRING note). */
export function messageSharePath(sessionId: string, messageId: number | string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(String(messageId))}/share`;
}
export function messageExportPath(sessionId: string, messageId: number | string, format: 'text' | 'markdown' | 'json'): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(String(messageId))}/export?format=${format}`;
}
export function messageDeletePath(sessionId: string, messageId: number | string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(String(messageId))}`;
}
