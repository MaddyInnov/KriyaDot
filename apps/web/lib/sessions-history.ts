// SPDX-License-Identifier: Apache-2.0
// Session-history model for the minimal shell sidebar (2026-10-31 redesign).
//
// The chat page persists conversations in localStorage:
//   mvp:convos:v1       Record<botId, Conversation[]>  (id === server sessionId)
//   mvp:activeConvo:v1  Record<botId, convoId>
//   mvp:blocks:<convoId> ChatBlock[] (each block carries a `ts`)
// Bots carry an optional `workspace` (directory isolation); bots without one
// live in the default workspace. This module turns those raw shapes into the
// sidebar's workspace list + recency-sorted session history. Pure functions
// first (testable); the storage reader is a thin guarded wrapper.

export interface HistoryBot {
  id: string;
  name: string;
  workspace?: string;
}

export interface HistoryConvo {
  id: string;
  title: string;
  createdAt: number;
  pinned?: boolean;
  hidden?: boolean;
}

export interface SessionHistoryEntry {
  botId: string;
  botName: string;
  convoId: string;
  title: string;
  /** ms epoch of the last block in the conversation, else createdAt. */
  lastActivity: number;
  pinned: boolean;
  /** Bot workspace path, or null for the default workspace. */
  workspace: string | null;
}

export interface WorkspaceEntry {
  /** Workspace path, or null for the default workspace. */
  id: string | null;
  label: string;
  sessionCount: number;
}

export const DEFAULT_WORKSPACE_LABEL = 'Default workspace';

/** Short relative time in the harness style: "now", "5m", "22h", "1d", "4d", else a date. */
export function relativeTime(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function workspaceLabel(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

/**
 * Build the recency-sorted session history. `lastBlockTs` resolves a
 * conversation's last activity (the sidebar passes a localStorage reader;
 * tests pass a stub). Hidden conversations are excluded. Pinned entries
 * sort first, then by last activity descending.
 */
export function buildSessionHistory(
  bots: HistoryBot[],
  convos: Record<string, HistoryConvo[]>,
  lastBlockTs: (convoId: string) => number | null,
): SessionHistoryEntry[] {
  const botById = new Map(bots.map((b) => [b.id, b]));
  const entries: SessionHistoryEntry[] = [];
  for (const [botId, list] of Object.entries(convos)) {
    const bot = botById.get(botId);
    for (const c of list ?? []) {
      if (c.hidden) continue;
      const last = lastBlockTs(c.id);
      entries.push({
        botId,
        botName: bot?.name ?? botId,
        convoId: c.id,
        title: c.title || 'Untitled session',
        lastActivity: typeof last === 'number' && last > 0 ? last : c.createdAt,
        pinned: Boolean(c.pinned),
        workspace: bot?.workspace ?? null,
      });
    }
  }
  entries.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.lastActivity - a.lastActivity;
  });
  return entries;
}

/** Workspace switcher entries: default workspace first, then named ones A–Z. */
export function buildWorkspaceList(
  bots: HistoryBot[],
  history: SessionHistoryEntry[],
): WorkspaceEntry[] {
  const counts = new Map<string | null, number>();
  for (const e of history) counts.set(e.workspace, (counts.get(e.workspace) ?? 0) + 1);
  const named = new Map<string, string>();
  for (const b of bots) {
    if (b.workspace && !named.has(b.workspace)) named.set(b.workspace, workspaceLabel(b.workspace));
  }
  for (const key of counts.keys()) {
    if (key && !named.has(key)) named.set(key, workspaceLabel(key));
  }
  const out: WorkspaceEntry[] = [
    { id: null, label: DEFAULT_WORKSPACE_LABEL, sessionCount: counts.get(null) ?? 0 },
  ];
  for (const [id, label] of [...named.entries()].sort((a, b) => a[1].localeCompare(b[1]))) {
    out.push({ id, label, sessionCount: counts.get(id) ?? 0 });
  }
  return out;
}

/** Filter history to one workspace (or all when `workspace` is undefined). */
export function filterHistoryByWorkspace(
  history: SessionHistoryEntry[],
  workspace: string | null | undefined,
): SessionHistoryEntry[] {
  if (workspace === undefined) return history;
  return history.filter((e) => e.workspace === workspace);
}

/** Case-insensitive title/bot search over history entries. */
export function searchHistory(history: SessionHistoryEntry[], query: string): SessionHistoryEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return history;
  return history.filter(
    (e) => e.title.toLowerCase().includes(q) || e.botName.toLowerCase().includes(q),
  );
}

// ---------------------------------------------------------------------------
// Browser storage reader (thin, guarded — never throws)
// ---------------------------------------------------------------------------

export interface StoredHistory {
  convos: Record<string, HistoryConvo[]>;
  activeConvo: Record<string, string>;
}

export function readStoredConvos(): StoredHistory {
  try {
    const raw = localStorage.getItem('mvp:convos:v1');
    const rawActive = localStorage.getItem('mvp:activeConvo:v1');
    return {
      convos: raw ? (JSON.parse(raw) as Record<string, HistoryConvo[]>) : {},
      activeConvo: rawActive ? (JSON.parse(rawActive) as Record<string, string>) : {},
    };
  } catch {
    return { convos: {}, activeConvo: {} };
  }
}

/** Last block timestamp for a conversation, or null when unavailable. */
export function readLastBlockTs(convoId: string): number | null {
  try {
    const raw = localStorage.getItem(`mvp:blocks:${convoId}`);
    if (!raw) return null;
    const blocks = JSON.parse(raw) as Array<{ ts?: number }>;
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (typeof blocks[i]?.ts === 'number') return blocks[i].ts as number;
    }
    return null;
  } catch {
    return null;
  }
}
