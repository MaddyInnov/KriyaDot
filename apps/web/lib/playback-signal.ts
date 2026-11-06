// SPDX-License-Identifier: Apache-2.0
// Multi-source assistant-playback signal.
//
// Assistant speech reaches the speakers through more than one code path
// (the gapless streaming-TTS queue in chat, the one-shot TTS button in
// voice-controls, …). Each path reports its own play state here under a
// stable source name; the pet/avatar layer only needs one question —
// "is the assistant speaking right now?" — which is true while ANY
// source is active. User-recorded voice notes are NOT assistant speech
// and must never report here.

'use client';

import { useSyncExternalStore } from 'react';

/** Known playback source names (any string is accepted; these are the wired ones). */
export type PlaybackSource = 'chat-tts-queue' | 'voice-controls' | (string & {});

const activeSources = new Set<string>();
const listeners = new Set<() => void>();

function notify(): void {
  // Snapshot the listener set: a listener may unsubscribe while notifying.
  for (const listener of [...listeners]) listener();
}

/**
 * Report one source's playback state. Idempotent per source: reporting
 * the same state twice is a no-op (no listener churn).
 */
export function reportPlayback(source: string, active: boolean): void {
  const wasActive = activeSources.has(source);
  if (active === wasActive) return;
  if (active) activeSources.add(source);
  else activeSources.delete(source);
  notify();
}

/** True while any playback source is active. */
export function isAssistantSpeaking(): boolean {
  return activeSources.size > 0;
}

/** Names of the currently-active sources (diagnostics / tests). */
export function activePlaybackSources(): string[] {
  return [...activeSources];
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getServerSnapshot(): boolean {
  return false;
}

/** React hook: re-renders when assistant speaking state flips. */
export function useAssistantSpeaking(): boolean {
  // getSnapshot returns a boolean primitive, which is inherently cached —
  // useSyncExternalStore's change detection (Object.is) is exact here.
  return useSyncExternalStore(subscribe, isAssistantSpeaking, getServerSnapshot);
}
