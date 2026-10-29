// SPDX-License-Identifier: Apache-2.0
// Streaming TTS for chat voice replies (W8h).
//
// Wires the sentence-chunked TTS pipeline from realtime voice calls
// (voice-realtime.ts `extractSentences`) into a chat turn: as assistant
// tokens stream in, complete sentences are cut and synthesized IN
// ORDER through the turn's TTS provider, and each sentence's audio is
// emitted as an `audio_chunk` stream event — sentence 1's audio goes
// out while the model is still generating the rest of the reply.
//
// Synthesis is serialized through a promise chain so chunks always
// emit in sentence order even though synthesis is async. A failing
// sentence is skipped (audited by the caller via onError) and never
// breaks the turn or the ordering of the remaining sentences.

import { prepareSpeechText, type TTSProvider } from '@mvp/voice';
import { extractSentences } from './voice-realtime.js';

export interface AudioChunkEvent {
  type: 'audio_chunk';
  seq: number;
  text: string;
  mimeType: string;
  audioBase64: string;
}

export interface StreamingTtsPipelineDeps {
  tts: TTSProvider;
  emit: (event: AudioChunkEvent) => void | Promise<void>;
  /** Sentence synthesis failure observer (never throws into the pipeline). */
  onError?: (err: unknown, sentence: string) => void;
  voice?: string;
  /**
   * Markdown→speech rewrite applied to each sentence before synthesis
   * (links become their text, code blocks a spoken placeholder, …).
   * Defaults to prepareSpeechText from @mvp/voice; injectable for tests.
   * The emitted event keeps the ORIGINAL sentence as its `text` (that
   * is what the chat UI renders) — only the synthesized audio uses the
   * rewritten text.
   */
  prepareText?: (text: string) => string;
}

/** Cap on buffered unsynthesized text — a runaway reply stops feeding TTS. */
const MAX_BUFFER_CHARS = 20_000;

export class StreamingTtsPipeline {
  private buffer = '';
  private seq = 0;
  private chain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly deps: StreamingTtsPipelineDeps) {}

  /** Number of audio chunks emitted (or queued) so far. */
  get chunksEmitted(): number {
    return this.seq;
  }

  /** Feed one streamed token. Complete sentences are queued for synthesis. */
  push(token: string): void {
    if (this.closed || !token) return;
    this.buffer += token;
    if (this.buffer.length > MAX_BUFFER_CHARS) {
      // Flush what we have as one final chunk rather than growing forever.
      const text = this.buffer.trim();
      this.buffer = '';
      if (text) this.enqueue(text);
      return;
    }
    const { sentences, rest } = extractSentences(this.buffer);
    this.buffer = rest;
    for (const s of sentences) this.enqueue(s);
  }

  /**
   * End of turn: synthesize whatever partial sentence remains and wait
   * until every queued chunk has been emitted. Call before the stream
   * closes so trailing audio isn't lost.
   */
  async finish(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      const rest = this.buffer.trim();
      this.buffer = '';
      if (rest) this.enqueue(rest);
    }
    await this.chain;
  }

  private enqueue(sentence: string): void {
    const text = sentence.trim();
    if (!text) return;
    const seq = this.seq;
    this.seq += 1;
    this.chain = this.chain.then(async () => {
      try {
        // Speak the rewritten text, display the original sentence.
        const spoken = (this.deps.prepareText ?? prepareSpeechText)(text);
        if (!spoken.trim()) return; // e.g. a sentence of pure markdown punctuation
        const res = await this.deps.tts.synthesize(spoken, this.deps.voice ? { voice: this.deps.voice } : {});
        await this.deps.emit({
          type: 'audio_chunk',
          seq,
          text,
          mimeType: res.mimeType,
          audioBase64: Buffer.from(res.audio).toString('base64'),
        });
      } catch (err) {
        try {
          this.deps.onError?.(err, text);
        } catch {
          // Observers never break the pipeline.
        }
      }
    });
  }
}
