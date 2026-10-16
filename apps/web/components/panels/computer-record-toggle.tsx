// SPDX-License-Identifier: Apache-2.0
'use client';

// Teach-by-recording control for the per-bot computer view (workstream A).
//
// MOUNT POINT (workstream A): render this inside the computer panel once it
// lands, next to the screenshot view:
//
//   import { ComputerRecordToggle } from '../panels/computer-record-toggle';
//   <ComputerRecordToggle botId={bot.id} />
//
// Behavior: "Record" opens a recording (POST /api/computer/record/start);
// the computer panel itself streams the user's click/type input as events to
// POST /api/computer/record/:id/events while recording (see the event
// contract in apps/api/src/computer-record-routes.ts). "Stop" ends the
// capture and shows the event count; "Save as workflow" compiles the
// recording into a reusable workflow (POST .../convert) that appears in the
// Workflows destination.

import { useCallback, useState } from 'react';
import { authedFetch } from '../../lib/api';

interface RecordingPayload {
  id: string;
  name: string;
  status: string;
  events: unknown[];
}

const api = (path: string, init?: RequestInit): Promise<any> =>
  authedFetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  }).then(async (res) => {
    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new Error(`API ${res.status}: ${detail || res.statusText}`);
    }
    return res.json();
  });

export function ComputerRecordToggle({
  botId,
  onRecordingChange,
}: {
  botId?: string;
  /** Called with the active recording id (or null) whenever it changes. */
  onRecordingChange?: (recordingId: string | null) => void;
}) {
  const [recording, setRecording] = useState<RecordingPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedWorkflowId, setSavedWorkflowId] = useState<string | null>(null);

  const start = useCallback(async () => {
    setBusy(true);
    setError(null);
    setSavedWorkflowId(null);
    try {
      const data = await api('/api/computer/record/start', {
        method: 'POST',
        body: JSON.stringify({ botId }),
      });
      const rec = data.recording as RecordingPayload;
      setRecording(rec);
      onRecordingChange?.(rec.status === 'recording' ? rec.id : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [botId, onRecordingChange]);

  const stop = useCallback(async () => {
    if (!recording) return;
    setBusy(true);
    setError(null);
    try {
      const data = await api(`/api/computer/record/${recording.id}/stop`, { method: 'POST' });
      setRecording(data.recording as RecordingPayload);
      onRecordingChange?.(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [recording, onRecordingChange]);

  const convert = useCallback(async () => {
    if (!recording) return;
    setBusy(true);
    setError(null);
    try {
      const data = await api(`/api/computer/record/${recording.id}/convert`, { method: 'POST' });
      setSavedWorkflowId(data.workflowId as string);
      setRecording(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [recording]);

  const isRecording = recording?.status === 'recording';
  const isStopped = recording && !isRecording;

  return (
    <div className="computer-record-toggle">
      {!recording && !savedWorkflowId && (
        <button type="button" onClick={start} disabled={busy}>
          {busy ? 'Starting…' : '● Record'}
        </button>
      )}
      {isRecording && (
        <>
          <button type="button" onClick={stop} disabled={busy}>
            {busy ? 'Stopping…' : '■ Stop'}
          </button>
          <span>Recording… interact with the computer view</span>
        </>
      )}
      {isStopped && (
        <>
          <span>{recording.events.length} events captured</span>
          <button type="button" onClick={convert} disabled={busy}>
            {busy ? 'Saving…' : 'Save as workflow'}
          </button>
          <button type="button" onClick={() => setRecording(null)} disabled={busy}>
            Discard
          </button>
        </>
      )}
      {savedWorkflowId && <span>Saved as workflow {savedWorkflowId} — see Workflows</span>}
      {error && <span className="error">{error}</span>}
    </div>
  );
}
