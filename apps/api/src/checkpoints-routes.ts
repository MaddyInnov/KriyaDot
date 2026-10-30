// SPDX-License-Identifier: Apache-2.0
// Checkpoint surfaces beyond the core list/restore routes (CA-4 / CA-30).
//
// The core list + restore endpoints live in routes.ts; this register-style
// module adds the pieces that file does not carry:
//   POST /checkpoints/:id/restore-summarized  — rewind the conversation to
//        the checkpoint, replacing everything after it with one summary
//        message (mode "conversation" or "both"; "both" also restores code)
//   POST /checkpoints/:id/restore-file        — restore ONE file from a
//        checkpoint (per-file granularity the files map already supports)
//   POST /checkpoints/retention/run           — run the CA-4 retention sweep
//   GET  /sessions/:sessionId/diff            — CA-30 session-changes review:
//        per-file +/- aggregate over the session's checkpoints vs disk
//
// HOST WIRING (index.ts — this module is not mounted by itself):
//   import { createCheckpointsRouter } from './checkpoints-routes.js';
//   app.use('/api', createCheckpointsRouter({
//     checkpointStore,
//     rewindSession: (sid, keep) => agentRuntime.rewindSession(sid, keep),
//     listMessages: (sid) => agentRuntime.listThreadMessages(sid),
//     appendMessage: (sid, msg) => agentRuntime.appendSessionMessage(sid, msg),
//     summarize: createSummarizer(undefined, modelProfiles),
//     audit: (action, fields) => governance.audit(action, fields),
//   }));
// `appendSessionMessage` is a thin host adapter over SessionStore.appendMessage
// (the runtime store the host already owns); when it is omitted the
// summarize-restore endpoint still rewinds and returns the summary in its
// response instead of appending it.

import express, { type Router } from 'express';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

import {
  aggregateSessionDiff,
  previewCheckpoint,
  runCheckpointRetention,
  type CheckpointStore,
} from './checkpoints.js';

export interface CheckpointRouteMessage {
  role: string;
  content: string;
}

export interface CheckpointsRouteDeps {
  checkpointStore: CheckpointStore;
  /** Truncate a session's history to `keepCount` messages; returns removed count. */
  rewindSession: (sessionId: string, keepCount: number) => number;
  /** Full verbatim message log for a session, oldest first. */
  listMessages: (sessionId: string) => CheckpointRouteMessage[];
  /** Append one message to a session (optional — see header note). */
  appendMessage?: (sessionId: string, msg: { role: 'user'; content: string }) => void;
  /** Summarizer over the runtime's ChatMessage shape (createSummarizer). */
  summarize?: (messages: Array<{ role: string; content: string }>) => Promise<string>;
  /** Read a file's current content for the diff endpoint; default: node:fs. */
  readCurrentFile?: (path: string) => string | null;
  audit?: (action: string, fields: { actor?: string; sessionId?: string; detail?: unknown }) => void;
}

function errorBody(message: string, detail?: string): Record<string, unknown> {
  return { ok: false, error: message, ...(detail ? { detail } : {}) };
}

/** Extractive fallback summary (no model needed): head + tail of the range. */
export function extractiveSummary(messages: CheckpointRouteMessage[]): string {
  const render = (m: CheckpointRouteMessage) => `${m.role}: ${m.content.slice(0, 280)}`;
  const head = messages.slice(0, 2).map(render).join('\n');
  const tail = messages.slice(-3).map(render).join('\n');
  return [
    `[summary of ${messages.length} message(s) after the checkpoint — extractive fallback]`,
    head,
    messages.length > 5 ? '…' : '',
    tail,
  ]
    .filter(Boolean)
    .join('\n');
}

/** The single message that replaces the rewound range. */
export function buildSummaryMessage(summary: string, removedCount: number): string {
  return `[Rewound to checkpoint — the ${removedCount} message(s) that followed are summarized here]\n\n${summary}`;
}

function defaultReadCurrent(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, 'utf-8') : null;
  } catch {
    return null;
  }
}

function restoreFilesToDisk(files: Record<string, string | null>, onlyPath?: string): { restored: string[]; errors: string[] } {
  const restored: string[] = [];
  const errors: string[] = [];
  for (const [filePath, content] of Object.entries(files)) {
    if (onlyPath !== undefined && filePath !== onlyPath) continue;
    try {
      if (content === null) {
        if (existsSync(filePath)) unlinkSync(filePath);
      } else {
        writeFileSync(filePath, content, 'utf-8');
      }
      restored.push(filePath);
    } catch (err) {
      errors.push(`${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { restored, errors };
}

export function createCheckpointsRouter(deps: CheckpointsRouteDeps): Router {
  const router = express.Router();
  const readCurrent = deps.readCurrentFile ?? defaultReadCurrent;

  // CA-30: session-changes review aggregate.
  router.get('/sessions/:sessionId/diff', (req, res) => {
    const checkpoints = deps.checkpointStore.listChronological(req.params.sessionId);
    const files = aggregateSessionDiff(checkpoints, readCurrent);
    res.json({
      ok: true,
      sessionId: req.params.sessionId,
      checkpointCount: checkpoints.length,
      files,
      totals: {
        added: files.reduce((n, f) => n + f.added, 0),
        removed: files.reduce((n, f) => n + f.removed, 0),
      },
    });
  });

  // Checkpoint preview (file list + sizes, no contents).
  router.get('/checkpoints/:id/preview', (req, res) => {
    const preview = previewCheckpointSafe(deps, req.params.id);
    if (!preview) {
      res.status(404).json(errorBody(`Unknown checkpoint "${req.params.id}"`));
      return;
    }
    res.json({ ok: true, preview });
  });

  // Per-file restore (the checkpoint files map is per-file by construction).
  router.post('/checkpoints/:id/restore-file', (req, res) => {
    const body = (req.body ?? {}) as { path?: unknown };
    const path = typeof body.path === 'string' ? body.path : '';
    if (!path) {
      res.status(400).json(errorBody('Body must be { path: string }'));
      return;
    }
    const cp = deps.checkpointStore.get(req.params.id);
    if (!cp) {
      res.status(404).json(errorBody(`Unknown checkpoint "${req.params.id}"`));
      return;
    }
    const entry = deps.checkpointStore.fileContent(cp.id, path);
    if (!entry.found) {
      res.status(404).json(errorBody(`Checkpoint "${cp.id}" has no snapshot for "${path}"`));
      return;
    }
    const { restored, errors } = restoreFilesToDisk({ [path]: entry.content });
    deps.audit?.('checkpoint.file_restored', { actor: 'user', sessionId: cp.sessionId, detail: { checkpointId: cp.id, path } });
    res.json({ ok: errors.length === 0, checkpointId: cp.id, restoredFiles: restored, errors });
  });

  // Summarize-from-here rewind: everything after the checkpoint is replaced
  // by a single summary message. mode "both" also restores the code.
  router.post('/checkpoints/:id/restore-summarized', async (req, res) => {
    const body = (req.body ?? {}) as { mode?: unknown };
    const mode = body.mode === 'both' ? 'both' : 'conversation';
    const cp = deps.checkpointStore.get(req.params.id);
    if (!cp) {
      res.status(404).json(errorBody(`Unknown checkpoint "${req.params.id}"`));
      return;
    }
    const all = deps.listMessages(cp.sessionId);
    const after = all.slice(cp.historyLength);
    let summary: string;
    try {
      summary = deps.summarize ? await deps.summarize(after) : extractiveSummary(after);
    } catch {
      summary = extractiveSummary(after);
    }
    if (!summary.trim()) summary = extractiveSummary(after);

    const errors: string[] = [];
    let restoredFiles: string[] = [];
    if (mode === 'both') {
      const r = restoreFilesToDisk(cp.files);
      restoredFiles = r.restored;
      errors.push(...r.errors);
    }
    const messagesRemoved = deps.rewindSession(cp.sessionId, cp.historyLength);
    const summaryMessage = buildSummaryMessage(summary, after.length);
    let appended = false;
    if (deps.appendMessage && after.length > 0) {
      try {
        deps.appendMessage(cp.sessionId, { role: 'user', content: summaryMessage });
        appended = true;
      } catch (err) {
        errors.push(`summary append: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    deps.audit?.('checkpoint.restore_summarized', {
      actor: 'user',
      sessionId: cp.sessionId,
      detail: { checkpointId: cp.id, mode, messagesRemoved },
    });
    res.json({
      ok: errors.length === 0,
      checkpointId: cp.id,
      mode,
      summary,
      summaryMessage,
      appended,
      messagesRemoved,
      restoredFiles,
      errors,
    });
  });

  // CA-4 retention sweep trigger.
  router.post('/checkpoints/retention/run', (_req, res) => {
    const result = runCheckpointRetention(deps.checkpointStore);
    deps.audit?.('checkpoint.retention_run', { actor: 'user', detail: result });
    res.json({ ok: true, ...result });
  });

  return router;
}

function previewCheckpointSafe(deps: CheckpointsRouteDeps, id: string) {
  const cp = deps.checkpointStore.get(id);
  return cp ? previewCheckpoint(cp) : undefined;
}
