// SPDX-License-Identifier: Apache-2.0
// H8: finalizeRecording must read the chunk array at onstop-time —
// MediaRecorder fires the final ondataavailable AFTER stop() is called, so
// resetting the ref before stop() drops every utterance (empty blob).
import { describe, expect, it } from 'vitest';
import { finalizeRecording } from './CallPanel';

interface FakeRecorder {
  mimeType: string;
  onstop: ((ev: Event) => void) | null;
  onerror: ((ev: Event) => void) | null;
  stop(): void;
}

/** Behaves like a real MediaRecorder: final data lands during stop(). */
function makeFakeRecorder(chunksRef: { current: Blob[] }, opts: { fail?: boolean } = {}): FakeRecorder {
  return {
    mimeType: 'audio/webm',
    onstop: null,
    onerror: null,
    stop() {
      if (opts.fail) {
        this.onerror?.({} as Event);
        return;
      }
      // The final ondataavailable fires after stop() is invoked — this is
      // the chunk the old code dropped by resetting chunksRef too early.
      chunksRef.current.push(new Blob(['audio-data'], { type: 'audio/webm' }));
      this.onstop?.({} as Event);
    },
  };
}

describe('finalizeRecording (H8)', () => {
  it('includes audio delivered by the final dataavailable during stop()', async () => {
    const chunksRef = { current: [] as Blob[] };
    const blob = await finalizeRecording(makeFakeRecorder(chunksRef), chunksRef);
    expect(blob.size).toBeGreaterThan(0);
    expect(await blob.text()).toBe('audio-data');
  });

  it('resets the chunk array after building the blob', async () => {
    const chunksRef = { current: [new Blob(['old'])] as Blob[] };
    await finalizeRecording(makeFakeRecorder(chunksRef), chunksRef);
    expect(chunksRef.current).toEqual([]);
  });

  it('rejects and resets when the recorder errors', async () => {
    const chunksRef = { current: [new Blob(['partial'])] as Blob[] };
    await expect(finalizeRecording(makeFakeRecorder(chunksRef, { fail: true }), chunksRef)).rejects.toThrow(
      'recording failed',
    );
    expect(chunksRef.current).toEqual([]);
  });
});
