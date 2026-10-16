// SPDX-License-Identifier: Apache-2.0
// Client-side voice activity detection for voice calls.
//
// Pure signal logic (no DOM): feed it time-domain float32 samples from an
// AnalyserNode and it emits speechstart/speechend with hangover, so the
// call panel can auto-segment utterances for push-free ("auto VAD") mode.
// Energy threshold scales with the 1–10 sensitivity setting (higher =
// more sensitive). Unit-tested with synthetic audio in vad.test.ts.

/** Map a 1–10 sensitivity to an RMS energy threshold. */
export function sensitivityToThreshold(sensitivity: number): number {
  const s = Math.min(10, Math.max(1, Math.round(sensitivity)));
  // 10 (most sensitive) → 0.008 RMS; 1 (least) → 0.06 RMS.
  return 0.068 - s * 0.006;
}

export interface VadOptions {
  /** 1–10; default 5. */
  sensitivity?: number;
  /** Sample rate of the fed frames (informational; default 48000). */
  sampleRate?: number;
  /** ms of trailing silence before speechend (default 600). */
  hangoverMs?: number;
  /** ms of speech required before speechstart fires (default 120). */
  minSpeechMs?: number;
}

export type VadEvent = 'speechstart' | 'speechend';

/**
 * Frame-based energy VAD. Call `feed()` with each analyser frame
 * (Float32Array of time-domain samples, any length); the `onEvent`
 * callback fires on transitions.
 */
export class VadDetector {
  private readonly threshold: number;
  private readonly hangoverFrames: number;
  private readonly minSpeechFrames: number;
  private readonly onEvent: (e: VadEvent) => void;
  private speaking = false;
  private speechFrames = 0;
  private silenceFrames = 0;
  /** Frames per second assumed when frames arrive without timestamps. */
  private readonly fps: number;

  constructor(onEvent: (e: VadEvent) => void, opts: VadOptions = {}) {
    this.onEvent = onEvent;
    this.threshold = sensitivityToThreshold(opts.sensitivity ?? 5);
    // AnalyserNode.getFloatTimeDomainData is typically polled at ~30fps.
    this.fps = 30;
    this.hangoverFrames = Math.max(1, Math.round(((opts.hangoverMs ?? 600) / 1000) * this.fps));
    this.minSpeechFrames = Math.max(1, Math.round(((opts.minSpeechMs ?? 120) / 1000) * this.fps));
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  /** RMS energy of a frame — exported for tests and the level meter. */
  frameEnergy(frame: Float32Array): number {
    if (frame.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    return Math.sqrt(sum / frame.length);
  }

  feed(frame: Float32Array): void {
    const energy = this.frameEnergy(frame);
    const active = energy >= this.threshold;
    if (active) {
      this.silenceFrames = 0;
      this.speechFrames++;
      if (!this.speaking && this.speechFrames >= this.minSpeechFrames) {
        this.speaking = true;
        this.onEvent('speechstart');
      }
    } else {
      this.speechFrames = 0;
      if (this.speaking) {
        this.silenceFrames++;
        if (this.silenceFrames >= this.hangoverFrames) {
          this.speaking = false;
          this.silenceFrames = 0;
          this.onEvent('speechend');
        }
      }
    }
  }

  reset(): void {
    this.speaking = false;
    this.speechFrames = 0;
    this.silenceFrames = 0;
  }
}

/** Build a synthetic frame: sine tone at `amplitude`, or silence. */
export function synthFrame(length: number, amplitude: number, phase = 0): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = amplitude * Math.sin(phase + (i / length) * Math.PI * 4);
  return out;
}
