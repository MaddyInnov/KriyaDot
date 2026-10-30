// SPDX-License-Identifier: Apache-2.0
// CA-4 / CA-30 web-side checkpoint logic: wire types, a small client over
// the checkpoints API, and pure aggregation/formatting helpers shared by
// the RewindPanel and its tests. The client is injectable so components
// render in tests without a network.

export interface CheckpointInfo {
  id: string;
  sessionId: string;
  createdAt: number;
  files: Record<string, string | null>;
  historyLength: number;
  label: string;
}

export interface CheckpointPreviewFile {
  path: string;
  size: number;
  existed: boolean;
}

export interface SessionDiffFile {
  path: string;
  status: string;
  added: number;
  removed: number;
  touches: number;
}

export interface CheckpointClient {
  listCheckpoints(sessionId: string): Promise<CheckpointInfo[]>;
  restore(id: string, mode: 'code' | 'conversation' | 'both'): Promise<{ ok: boolean; restoredFiles: string[]; messagesRemoved: number }>;
  restoreSummarized(id: string, mode: 'conversation' | 'both'): Promise<{ ok: boolean; summary: string; messagesRemoved: number }>;
  restoreFile(id: string, path: string): Promise<{ ok: boolean; restoredFiles: string[] }>;
  sessionDiff(sessionId: string): Promise<{ files: SessionDiffFile[]; totals: { added: number; removed: number } }>;
}

/** Files touched by a checkpoint, with byte sizes (preview without contents). */
export function previewFiles(cp: CheckpointInfo): CheckpointPreviewFile[] {
  return Object.entries(cp.files)
    .map(([path, content]) => ({
      path,
      size: content === null ? 0 : new TextEncoder().encode(content).length,
      existed: content !== null,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatCheckpointTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** Default client over the web app's authed fetch (lib/api authedFetch). */
export function createCheckpointClient(
  fetchJson: (path: string, init?: RequestInit) => Promise<unknown>,
): CheckpointClient {
  const post = (path: string, body: unknown) =>
    fetchJson(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  return {
    async listCheckpoints(sessionId) {
      const r = (await fetchJson(`/api/sessions/${encodeURIComponent(sessionId)}/checkpoints`)) as {
        checkpoints: CheckpointInfo[];
      };
      return r.checkpoints ?? [];
    },
    async restore(id, mode) {
      return (await post(`/api/checkpoints/${encodeURIComponent(id)}/restore`, { mode })) as {
        ok: boolean;
        restoredFiles: string[];
        messagesRemoved: number;
      };
    },
    async restoreSummarized(id, mode) {
      return (await post(`/api/checkpoints/${encodeURIComponent(id)}/restore-summarized`, { mode })) as {
        ok: boolean;
        summary: string;
        messagesRemoved: number;
      };
    },
    async restoreFile(id, path) {
      return (await post(`/api/checkpoints/${encodeURIComponent(id)}/restore-file`, { path })) as {
        ok: boolean;
        restoredFiles: string[];
      };
    },
    async sessionDiff(sessionId) {
      const r = (await fetchJson(`/api/sessions/${encodeURIComponent(sessionId)}/diff`)) as {
        files: SessionDiffFile[];
        totals: { added: number; removed: number };
      };
      return { files: r.files ?? [], totals: r.totals ?? { added: 0, removed: 0 } };
    },
  };
}
