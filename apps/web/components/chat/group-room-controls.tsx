// SPDX-License-Identifier: Apache-2.0
// Group room robustness controls (OpenMausBot parity): hold/halt/release,
// breaker status, queued messages, failed member turns with retry, and
// per-room settings (turn timeout, anti-spam budgets).
'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  clearRoomQueue,
  getRoomSettings,
  getRoomStatus,
  haltRoom,
  holdRoom,
  listRoomFailures,
  releaseRoom,
  retryRoomFailure,
  updateRoomSettings,
  type RoomFailure,
  type RoomRobustnessSettings,
  type RoomStatus,
} from '../../lib/group-chats';

interface Props {
  groupId: string;
  /** Refresh the transcript after actions that add system messages. */
  onTranscriptChanged: () => void;
}

const SETTING_FIELDS: Array<{
  key: keyof RoomRobustnessSettings;
  label: string;
  hint: string;
  min: number;
  max: number;
}> = [
  { key: 'turnTimeoutMin', label: 'Turn timeout (min)', hint: 'Abort a room turn after this long', min: 1, max: 1440 },
  { key: 'maxPostsPerMemberPerTurn', label: 'Max posts / member / turn', hint: 'Per-member post budget per room turn', min: 1, max: 100 },
  { key: 'postsPerMinute', label: 'Posts / minute / sender', hint: 'Sliding-window rate limit', min: 1, max: 600 },
  { key: 'duplicateRepeatLimit', label: 'Duplicate repeat limit', hint: 'Near-identical repeats before the breaker trips', min: 2, max: 20 },
  { key: 'maxHeld', label: 'Max queued messages', hint: 'Queue cap while held/halted', min: 1, max: 20 },
];

export function GroupRoomControls({ groupId, onTranscriptChanged }: Props) {
  const [status, setStatus] = useState<RoomStatus | null>(null);
  const [failures, setFailures] = useState<RoomFailure[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [draft, setDraft] = useState<Partial<RoomRobustnessSettings>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, f] = await Promise.all([getRoomStatus(groupId), listRoomFailures(groupId)]);
      setStatus(s);
      setFailures(f.filter((x) => !x.retried));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load room status.');
    }
  }, [groupId]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const act = async (fn: () => Promise<RoomStatus | void>) => {
    setBusy(true);
    setError(null);
    try {
      const s = await fn();
      if (s) setStatus(s);
      else await refresh();
      onTranscriptChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed.');
    } finally {
      setBusy(false);
    }
  };

  const openSettings = async () => {
    try {
      setDraft(await getRoomSettings(groupId));
      setShowSettings(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load settings.');
    }
  };

  const saveSettings = async () => {
    setBusy(true);
    setError(null);
    try {
      await updateRoomSettings(groupId, draft);
      setShowSettings(false);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save settings.');
    } finally {
      setBusy(false);
    }
  };

  const retry = async (f: RoomFailure) => {
    setBusy(true);
    setError(null);
    try {
      await retryRoomFailure(groupId, f.id);
      await refresh();
      onTranscriptChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Retry failed.');
    } finally {
      setBusy(false);
    }
  };

  const hold = status?.hold ?? 'active';
  const breaker = status?.breaker ?? null;
  const queue = status?.queue ?? [];

  return (
    <div className="room-controls">
      {breaker && (
        <div className="room-banner breaker" role="alert">
          🛡 Anti-spam breaker tripped ({breaker.reason}): {breaker.detail}. Room paused.
        </div>
      )}
      {hold === 'held' && !breaker && (
        <div className="room-banner held" role="status">
          ⏸ Room held — new messages queue until released.
        </div>
      )}
      {hold === 'halted' && (
        <div className="room-banner halted" role="alert">
          ⏹ Room halted — turn stopped, room paused.
        </div>
      )}
      {status?.turnInFlight && (
        <div className="small muted">● Room turn in flight…</div>
      )}

      <div className="room-controls-row">
        {hold === 'active' ? (
          <>
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => act(() => holdRoom(groupId))} title="Pause the room; new messages queue">
              ⏸ Hold
            </button>
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => act(() => haltRoom(groupId))} title="Stop the in-flight turn now and pause">
              ⏹ Halt
            </button>
          </>
        ) : (
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act(() => releaseRoom(groupId))} title="Resume and drain the queue in order">
            ▶ Release
          </button>
        )}
        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={openSettings} title="Turn timeout and anti-spam budgets">
          ⚙ Room settings
        </button>
        {queue.length > 0 && (
          <button
            className="btn btn-ghost btn-sm"
            disabled={busy}
            onClick={() => act(async () => { await clearRoomQueue(groupId); })}
            title="Discard queued messages without dispatching"
          >
            🗑 Clear queue ({queue.length})
          </button>
        )}
      </div>

      {queue.length > 0 && (
        <div className="room-queue">
          <div className="small muted">Queued ({queue.length}/{status?.maxHeld ?? 20}):</div>
          <ol className="queue-list">
            {queue.map((q, i) => (
              <li key={q.id} className="small">
                <span className="muted">#{i + 1}</span> {q.text.slice(0, 120)}
                {q.text.length > 120 ? '…' : ''}
                {q.attempts > 0 && <span className="muted"> (attempt {q.attempts + 1})</span>}
              </li>
            ))}
          </ol>
        </div>
      )}

      {failures.length > 0 && (
        <div className="room-failures">
          <div className="small muted">Failed member turns:</div>
          {failures.map((f) => (
            <div key={f.id} className="failure-row">
              <span className="small">
                ⚠ <strong>{f.botName}</strong> (round {f.round}): {f.error.slice(0, 100)}
              </span>
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => retry(f)} title="Re-run this member's turn">
                ↻ Retry
              </button>
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="error small" role="alert">
          {error}
        </div>
      )}

      {showSettings && (
        <div className="dialog-overlay" onClick={() => setShowSettings(false)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Room settings">
            <h3>⚙ Room robustness</h3>
            <p className="small muted">Per-room overrides. Empty values keep the global defaults.</p>
            {SETTING_FIELDS.map((f) => (
              <label key={f.key} className="field">
                <span>
                  {f.label} <span className="muted">({f.min}–{f.max})</span>
                </span>
                <input
                  className="input"
                  type="number"
                  min={f.min}
                  max={f.max}
                  value={draft[f.key] ?? ''}
                  placeholder={String(status?.settings[f.key] ?? '')}
                  onChange={(e) => {
                    const v = e.target.value === '' ? undefined : parseInt(e.target.value, 10);
                    setDraft((d) => ({ ...d, [f.key]: Number.isFinite(v) ? v : undefined }));
                  }}
                />
                <span className="small muted">{f.hint}</span>
              </label>
            ))}
            <div className="dialog-actions">
              <button className="btn btn-ghost" onClick={() => setShowSettings(false)}>
                Cancel
              </button>
              <button className="btn btn-primary" disabled={busy} onClick={saveSettings}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
