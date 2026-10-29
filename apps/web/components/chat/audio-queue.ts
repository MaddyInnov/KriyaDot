// SPDX-License-Identifier: Apache-2.0
// Gapless audio queue for streaming chat TTS (W8h).
//
// The server emits one `audio_chunk` per sentence (in sentence order)
// while the reply is still generating. This queue plays them back
// back-to-back: chunk N+1 starts the moment chunk N ends, so sentence
// 1 is heard while the model is still writing the rest.
//
// The player is deliberately thin: an injectable audio factory keeps
// the queue logic unit-testable without a real AudioContext.

/** Minimal playable-audio surface the queue needs (HTMLAudioElement fits). */
export interface PlayableAudio {
  play(): Promise<void> | void;
  pause(): void;
  onended: (() => void) | null;
  onerror: (() => void) | null;
}

export type AudioFactory = (src: string, mimeType: string) => PlayableAudio;

function defaultFactory(src: string): PlayableAudio {
  const audio = new Audio(src);
  return audio as unknown as PlayableAudio;
}

/** Decode a base64 audio chunk into an object URL the factory can play. */
export function chunkToObjectUrl(audioBase64: string, mimeType: string): string {
  const binary = atob(audioBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: mimeType || 'audio/wav' });
  return URL.createObjectURL(blob);
}

interface QueuedChunk {
  seq: number;
  src: string;
  mimeType: string;
}

export class GaplessAudioQueue {
  private readonly factory: AudioFactory;
  private readonly queue: QueuedChunk[] = [];
  private current: PlayableAudio | null = null;
  private playingSeqValue: number | null = null;
  private stopped = false;

  constructor(factory: AudioFactory = defaultFactory) {
    this.factory = factory;
  }

  /** Chunks waiting to play (excluding the one currently playing). */
  get pendingCount(): number {
    return this.queue.length;
  }

  /** Seq of the chunk currently playing, or null when idle. */
  get playingSeq(): number | null {
    return this.playingSeqValue;
  }

  get isPlaying(): boolean {
    return this.current !== null;
  }

  /** Enqueue one chunk (chunks must arrive in seq order, as the server emits them). */
  enqueue(chunk: { seq: number; audioBase64: string; mimeType: string }): void {
    if (this.stopped) return;
    const src = chunkToObjectUrl(chunk.audioBase64, chunk.mimeType);
    this.queue.push({ seq: chunk.seq, src, mimeType: chunk.mimeType });
    if (!this.current) this.playNext();
  }

  /** Stop playback and drop everything queued. */
  stop(): void {
    this.stopped = true;
    this.queue.length = 0;
    if (this.current) {
      try {
        this.current.pause();
      } catch {
        // ignore
      }
      this.current = null;
      this.playingSeqValue = null;
    }
  }

  private playNext(): void {
    if (this.stopped) return;
    const next = this.queue.shift();
    if (!next) {
      this.current = null;
      this.playingSeqValue = null;
      return;
    }
    const audio = this.factory(next.src, next.mimeType);
    this.current = audio;
    this.playingSeqValue = next.seq;
    const advance = (): void => {
      if (this.current === audio) {
        this.current = null;
        this.playingSeqValue = null;
        this.playNext();
      }
    };
    audio.onended = advance;
    audio.onerror = advance; // a bad chunk must not stall the queue
    try {
      void audio.play();
    } catch {
      advance();
    }
  }
}
