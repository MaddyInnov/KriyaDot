// SPDX-License-Identifier: Apache-2.0
// VAD unit tests with synthetic audio: silence vs tone frames at known
// amplitudes. No microphone, no DOM.

import { describe, expect, it } from 'vitest';
import { VadDetector, sensitivityToThreshold, synthFrame, type VadEvent } from './vad';

function runVad(amplitudes: number[], opts: ConstructorParameters<typeof VadDetector>[1] = {}): VadEvent[] {
  const events: VadEvent[] = [];
  const vad = new VadDetector((e) => events.push(e), opts);
  for (const a of amplitudes) vad.feed(synthFrame(1024, a));
  return events;
}

describe('sensitivityToThreshold', () => {
  it('is monotonic: higher sensitivity → lower threshold', () => {
    expect(sensitivityToThreshold(10)).toBeLessThan(sensitivityToThreshold(1));
    expect(sensitivityToThreshold(5)).toBeGreaterThan(0);
  });

  it('clamps out-of-range input', () => {
    expect(sensitivityToThreshold(0)).toBe(sensitivityToThreshold(1));
    expect(sensitivityToThreshold(99)).toBe(sensitivityToThreshold(10));
  });
});

describe('VadDetector', () => {
  it('stays silent on pure silence', () => {
    expect(runVad(new Array(60).fill(0))).toEqual([]);
  });

  it('fires speechstart then speechend around a tone burst', () => {
    const events = runVad([
      ...new Array(10).fill(0),
      ...new Array(20).fill(0.5),
      ...new Array(40).fill(0), // hangover (600ms @30fps = 18 frames)
    ]);
    expect(events).toEqual(['speechstart', 'speechend']);
  });

  it('ignores sub-threshold noise at low sensitivity', () => {
    // 0.05 amplitude ≈ 0.035 RMS — below the sensitivity-1 threshold (0.062).
    const events = runVad(new Array(40).fill(0.05), { sensitivity: 1 });
    expect(events).toEqual([]);
  });

  it('detects the same noise at max sensitivity', () => {
    // sensitivity-10 threshold is 0.008 RMS — 0.035 RMS exceeds it.
    const events = runVad(
      [...new Array(5).fill(0), ...new Array(20).fill(0.05), ...new Array(40).fill(0)],
      { sensitivity: 10 },
    );
    expect(events[0]).toBe('speechstart');
    expect(events[events.length - 1]).toBe('speechend');
  });

  it('requires minSpeechMs before firing (debounces clicks)', () => {
    // Two frames of tone is below the 120ms minimum (~4 frames).
    const events = runVad([0, 0.5, 0.5, 0, 0, 0, 0, 0, 0, 0]);
    expect(events).toEqual([]);
  });

  it('holds through brief dropouts (hangover)', () => {
    const events = runVad([
      ...new Array(10).fill(0.5),
      ...new Array(3).fill(0), // 100ms dropout < 600ms hangover
      ...new Array(10).fill(0.5),
      ...new Array(40).fill(0),
    ]);
    expect(events).toEqual(['speechstart', 'speechend']);
  });

  it('reports isSpeaking and frameEnergy honestly', () => {
    const vad = new VadDetector(() => {});
    expect(vad.isSpeaking).toBe(false);
    expect(vad.frameEnergy(new Float32Array(0))).toBe(0);
    expect(vad.frameEnergy(synthFrame(1024, 0))).toBe(0);
    expect(vad.frameEnergy(synthFrame(1024, 1))).toBeGreaterThan(0.5);
  });
});
