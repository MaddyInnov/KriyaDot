// SPDX-License-Identifier: Apache-2.0
//
// Streaming chat TTS speech preparation: sentences are rewritten
// markdown→speech before synthesis (links become their text, code
// blocks a spoken placeholder) while the emitted audio_chunk events
// keep the original sentence text for the chat UI. The TTS provider is
// a recording fake — zero network, zero paid usage.

import { describe, expect, it } from 'vitest';
import type { TTSProvider, TTSResult } from '@mvp/voice';
import { StreamingTtsPipeline, type AudioChunkEvent } from '../src/chat-streaming-tts.js';

function recordingTts(): { tts: TTSProvider; seen: string[] } {
  const seen: string[] = [];
  const tts: TTSProvider = {
    name: 'recording-fake',
    async synthesize(text: string): Promise<TTSResult> {
      seen.push(text);
      return { audio: new Uint8Array([1, 2, 3]), mimeType: 'audio/wav' };
    },
  };
  return { tts, seen };
}

function collect(): { events: AudioChunkEvent[]; emit: (e: AudioChunkEvent) => void } {
  const events: AudioChunkEvent[] = [];
  return { events, emit: (e) => void events.push(e) };
}

describe('StreamingTtsPipeline speech-text preparation', () => {
  it('synthesizes the link text, not the markdown link syntax or URL', async () => {
    const { tts, seen } = recordingTts();
    const { events, emit } = collect();
    const pipe = new StreamingTtsPipeline({ tts, emit });
    pipe.push('Please read [the full guide](https://example.com/guide) before Friday. Then we ship it.');
    await pipe.finish();
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe('Please read the full guide before Friday.');
    expect(seen.join(' ')).not.toContain('https://');
    expect(seen.join(' ')).not.toContain('](');
    // The emitted chunk still carries the original sentence for the UI.
    expect(events[0]?.text).toContain('[the full guide](https://example.com/guide)');
    expect(events.map((e) => e.seq)).toEqual([0, 1]);
  });

  it('turns a fenced code block into the spoken placeholder and never speaks the code', async () => {
    const { tts, seen } = recordingTts();
    const { emit } = collect();
    const pipe = new StreamingTtsPipeline({ tts, emit });
    // No sentence terminator outside the block: the whole remainder is
    // flushed as one chunk at finish(), then rewritten for speech.
    pipe.push('Try this snippet:\n\n```ts\nconst secret = computeThing();\n```\n\nIt should just work');
    await pipe.finish();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('Code omitted.');
    expect(seen[0]).not.toContain('computeThing');
    expect(seen[0]).not.toContain('const');
  });

  it('strips emphasis and heading markers from synthesized text', async () => {
    const { tts, seen } = recordingTts();
    const { emit } = collect();
    const pipe = new StreamingTtsPipeline({ tts, emit });
    pipe.push('This is **really** important for the team. Please note it well.');
    await pipe.finish();
    expect(seen[0]).toBe('This is really important for the team.');
    expect(seen.join(' ')).not.toContain('*');
  });

  it('skips chunks that rewrite to nothing instead of synthesizing punctuation', async () => {
    const { tts, seen } = recordingTts();
    const { events, emit } = collect();
    const pipe = new StreamingTtsPipeline({ tts, emit });
    pipe.push('***');
    await pipe.finish();
    expect(seen).toEqual([]);
    expect(events).toEqual([]);
  });

  it('honours an injected prepareText override', async () => {
    const { tts, seen } = recordingTts();
    const { emit } = collect();
    const pipe = new StreamingTtsPipeline({ tts, emit, prepareText: (t) => t.replaceAll('cat', 'dog') });
    pipe.push('The cat sat on the mat today.');
    await pipe.finish();
    expect(seen).toEqual(['The dog sat on the mat today.']);
  });
});
