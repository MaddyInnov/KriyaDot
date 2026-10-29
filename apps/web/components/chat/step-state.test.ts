// SPDX-License-Identifier: Apache-2.0
// W8a/W8h web helpers: step-line reducer, Now-card line, gapless audio queue.

import { describe, expect, it, vi } from 'vitest';
import { applyStepEvent, formatElapsed, nowCardLine, stepCounter } from './step-state';
import { GaplessAudioQueue, type PlayableAudio } from './audio-queue';
import type { CurrentTurnState } from '../../lib/api';

// jsdom in this repo may not implement URL.createObjectURL.
if (typeof URL.createObjectURL !== 'function') {
  URL.createObjectURL = () => 'blob:mock';
}

describe('step line state (W8a)', () => {
  it('folds step events into step-line state', () => {
    const s = applyStepEvent(undefined, {
      type: 'step',
      botId: 'b1',
      sessionId: 's1',
      step: 'Running read_file',
      stepIndex: 2,
      stepTotal: 8,
      startedAt: 1000,
      elapsedMs: 4200,
    });
    expect(s.step).toBe('Running read_file');
    expect(stepCounter(s)).toBe('step 2 of 8');
    expect(formatElapsed(s.elapsedMs)).toBe('4s');
  });

  it('counter is undefined without an index; elapsed formats minutes', () => {
    expect(stepCounter({ stepIndex: undefined })).toBeUndefined();
    expect(stepCounter({ stepIndex: 3 })).toBe('step 3');
    expect(formatElapsed(125_000)).toBe('2m 05s');
  });

  it('nowCardLine composes step, counter and elapsed', () => {
    const turn: CurrentTurnState = {
      botId: 'b1',
      botName: 'Coder',
      sessionId: 's1',
      step: 'Thinking',
      stepIndex: 1,
      stepTotal: 8,
      startedAt: 0,
      updatedAt: 0,
      elapsedMs: 41_000,
    };
    expect(nowCardLine(turn)).toBe('Thinking · step 1 of 8 · 41s');
  });
});

class FakeAudio implements PlayableAudio {
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  played = false;
  paused = false;
  constructor(readonly src: string) {}
  play(): void {
    this.played = true;
  }
  pause(): void {
    this.paused = true;
  }
  end(): void {
    this.onended?.();
  }
}

describe('GaplessAudioQueue (W8h)', () => {
  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

  it('plays chunks back-to-back in seq order', () => {
    const made: FakeAudio[] = [];
    const queue = new GaplessAudioQueue((src) => {
      const a = new FakeAudio(src);
      made.push(a);
      return a;
    });
    queue.enqueue({ seq: 0, audioBase64: b64('one'), mimeType: 'audio/wav' });
    queue.enqueue({ seq: 1, audioBase64: b64('two'), mimeType: 'audio/wav' });
    expect(queue.playingSeq).toBe(0);
    expect(queue.pendingCount).toBe(1);
    expect(made).toHaveLength(1);
    made[0]!.end();
    expect(queue.playingSeq).toBe(1);
    expect(made).toHaveLength(2);
    made[1]!.end();
    expect(queue.playingSeq).toBeNull();
    expect(queue.isPlaying).toBe(false);
  });

  it('a chunk error advances the queue instead of stalling it', () => {
    const made: FakeAudio[] = [];
    const queue = new GaplessAudioQueue((src) => {
      const a = new FakeAudio(src);
      made.push(a);
      return a;
    });
    queue.enqueue({ seq: 0, audioBase64: b64('bad'), mimeType: 'audio/wav' });
    queue.enqueue({ seq: 1, audioBase64: b64('good'), mimeType: 'audio/wav' });
    made[0]!.onerror?.();
    expect(queue.playingSeq).toBe(1);
  });

  it('stop() pauses the current chunk and drops the queue', () => {
    const made: FakeAudio[] = [];
    const queue = new GaplessAudioQueue((src) => {
      const a = new FakeAudio(src);
      made.push(a);
      return a;
    });
    queue.enqueue({ seq: 0, audioBase64: b64('one'), mimeType: 'audio/wav' });
    queue.enqueue({ seq: 1, audioBase64: b64('two'), mimeType: 'audio/wav' });
    queue.stop();
    expect(made[0]!.paused).toBe(true);
    expect(queue.pendingCount).toBe(0);
    expect(queue.playingSeq).toBeNull();
    void vi;
  });
});
