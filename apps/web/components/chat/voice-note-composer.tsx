// SPDX-License-Identifier: Apache-2.0
// Voice-note composer pieces (chat polish): record with MediaRecorder
// in the composer; the recording is uploaded as an attachment by the
// parent and rendered back as a playable audio bubble with duration.

'use client';

import React, { useEffect, useRef, useState } from 'react';

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Playable audio bubble with a duration label. */
export function AudioBubble({ src, durationMs, label }: { src: string; durationMs: number; label?: string }) {
  return (
    <div className="audio-bubble" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <span aria-hidden="true">🎙️</span>
      <audio controls src={src} aria-label={label ?? 'Voice note'} style={{ maxWidth: 260, height: 36 }} />
      <span className="small muted">{formatDuration(durationMs)}</span>
    </div>
  );
}

export interface VoiceNoteRecordButtonProps {
  disabled?: boolean;
  /** Fired with the recorded blob + measured duration; parent uploads it. */
  onRecorded: (blob: Blob, durationMs: number) => void;
  onError?: (message: string) => void;
}

/** Hold-free toggle recorder built on MediaRecorder (no new deps). */
export function VoiceNoteRecordButton({ disabled, onRecorded, onError }: VoiceNoteRecordButtonProps) {
  const [recording, setRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedRef = useRef(0);

  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => setElapsedMs(Date.now() - startedRef.current), 250);
    return () => clearInterval(t);
  }, [recording]);
  useEffect(() => () => { recRef.current?.stream?.getTracks().forEach((t) => t.stop()); }, []);

  const toggle = async () => {
    if (recording) { recRef.current?.stop(); return; }
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      onError?.('Voice recording is not supported in this browser.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      startedRef.current = Date.now();
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' });
        if (blob.size > 0) onRecorded(blob, Date.now() - startedRef.current);
      };
      recRef.current = rec;
      rec.start();
      setElapsedMs(0);
      setRecording(true);
    } catch {
      onError?.('Microphone access was denied.');
    }
  };

  return (
    <button type="button" className={`btn btn-icon${recording ? ' recording' : ''}`} disabled={disabled}
      onClick={() => void toggle()} aria-label={recording ? 'Stop recording' : 'Record a voice note'}
      title={recording ? 'Stop recording' : 'Record a voice note (uploads as an attachment)'}>
      {recording ? `⏺ ${formatDuration(elapsedMs)}` : '🎙️'}
    </button>
  );
}
