// SPDX-License-Identifier: Apache-2.0
// RewindPanel (CA-4) — the checkpoint drawer for a chat session: lists the
// session's checkpoints (time, trigger, files touched), previews one
// (file list + sizes), and restores code / conversation / both, restores a
// single file, or rewinds with everything after the checkpoint replaced by
// a summary ("summarize from here"). Data comes through an injectable
// CheckpointClient so the panel is testable without a network.

'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  formatBytes,
  formatCheckpointTime,
  previewFiles,
  type CheckpointClient,
  type CheckpointInfo,
} from './checkpoints';

export interface RewindPanelProps {
  sessionId: string;
  client: CheckpointClient;
  onClose?: () => void;
}

type RestoreMode = 'code' | 'conversation' | 'both';

export function RewindPanel({ sessionId, client, onClose }: RewindPanelProps) {
  const [checkpoints, setCheckpoints] = useState<CheckpointInfo[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const list = await client.listCheckpoints(sessionId);
      setCheckpoints(list);
      setSelectedId((prev) => prev ?? list[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setCheckpoints([]);
    }
  }, [client, sessionId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const selected = checkpoints?.find((c) => c.id === selectedId) ?? null;

  const run = useCallback(
    async (fn: () => Promise<string>) => {
      setBusy(true);
      setError('');
      setStatus('');
      try {
        setStatus(await fn());
        await reload();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [reload],
  );

  const restore = (mode: RestoreMode) => {
    if (!selected) return;
    void run(async () => {
      const r = await client.restore(selected.id, mode);
      return `Restored (${mode}): ${r.restoredFiles.length} file(s), ${r.messagesRemoved} message(s) removed.`;
    });
  };

  const restoreSummarized = (mode: 'conversation' | 'both') => {
    if (!selected) return;
    void run(async () => {
      const r = await client.restoreSummarized(selected.id, mode);
      return `Rewound with summary (${mode}): ${r.messagesRemoved} message(s) replaced by a summary.`;
    });
  };

  const restoreFile = (path: string) => {
    if (!selected) return;
    void run(async () => {
      const r = await client.restoreFile(selected.id, path);
      return `Restored file ${path} (${r.restoredFiles.length} written).`;
    });
  };

  return (
    <section className="rewind-panel" aria-label="Checkpoints — rewind this session">
      <header className="rewind-head">
        <strong>⏪ Checkpoints</strong>
        <span className="muted small">rewind code and/or conversation</span>
        <span className="spacer" style={{ flex: 1 }} />
        {onClose && (
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close checkpoints">
            ✕
          </button>
        )}
      </header>

      {checkpoints === null && <p className="muted small">Loading checkpoints…</p>}
      {checkpoints !== null && checkpoints.length === 0 && (
        <p className="muted small">No checkpoints yet — they are taken automatically before file edits.</p>
      )}

      {checkpoints !== null && checkpoints.length > 0 && (
        <div className="rewind-body">
          <ul className="rewind-list">
            {checkpoints.map((cp) => (
              <li key={cp.id}>
                <button
                  type="button"
                  className={`rewind-item${cp.id === selectedId ? ' active' : ''}`}
                  onClick={() => setSelectedId(cp.id)}
                  aria-pressed={cp.id === selectedId}
                >
                  <span className="rewind-time mono">{formatCheckpointTime(cp.createdAt)}</span>
                  <span className="rewind-label">{cp.label}</span>
                  <span className="muted small">
                    {Object.keys(cp.files).length} file(s)
                  </span>
                </button>
              </li>
            ))}
          </ul>

          {selected && (
            <div className="rewind-preview" aria-label={`Preview of checkpoint ${selected.id}`}>
              <p className="small">
                <strong>{selected.label}</strong> · {formatCheckpointTime(selected.createdAt)} · conversation length{' '}
                {selected.historyLength}
              </p>
              <ul className="rewind-files">
                {previewFiles(selected).map((f) => (
                  <li key={f.path} className="rewind-file">
                    <span className="mono">{f.path}</span>
                    <span className="muted small">{f.existed ? formatBytes(f.size) : 'did not exist'}</span>
                    <button type="button" className="btn btn-sm" disabled={busy} onClick={() => restoreFile(f.path)}>
                      Restore file
                    </button>
                  </li>
                ))}
              </ul>
              <div className="rewind-actions">
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => restore('code')}>
                  Restore code
                </button>
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => restore('conversation')}>
                  Restore conversation
                </button>
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => restore('both')}>
                  Restore both
                </button>
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => restoreSummarized('conversation')}>
                  Summarize from here
                </button>
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => restoreSummarized('both')}>
                  Summarize + restore code
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {status && (
        <p className="small" role="status">
          {status}
        </p>
      )}
      {error && (
        <p className="small" role="alert">
          ⚠ {error}
        </p>
      )}
    </section>
  );
}
