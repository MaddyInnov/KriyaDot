// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import {
  MockSTTProvider,
  MockTTSProvider,
  VoiceSession,
  makeMockWav,
  selectSTTProvider,
  selectTTSProvider,
} from '../src/voice.js';

function isWav(bytes: Uint8Array): boolean {
  const tag = (o: number, s: string) =>
    [...s].every((ch, i) => bytes[o + i] === ch.charCodeAt(0));
  return tag(0, 'RIFF') && tag(8, 'WAVE') && tag(12, 'fmt ');
}

describe('MockSTTProvider', () => {
  it('transcribes deterministically from the input bytes', async () => {
    const stt = new MockSTTProvider();
    const audio = new Uint8Array([1, 2, 3, 4]);
    const a = await stt.transcribe(audio);
    const b = await stt.transcribe(new Uint8Array([1, 2, 3, 4]));
    const c = await stt.transcribe(new Uint8Array([9, 9, 9]));
    expect(a.text).toBe(b.text);
    expect(a.text).not.toBe(c.text);
    expect(a.confidence).toBe(1);
    expect(a.language).toBe('en');
  });

  it('rejects empty audio', async () => {
    await expect(new MockSTTProvider().transcribe(new Uint8Array(0))).rejects.toThrow(
      /non-empty/,
    );
  });
});

describe('MockTTSProvider', () => {
  it('returns valid WAV bytes', async () => {
    const tts = new MockTTSProvider();
    const res = await tts.synthesize('hello world');
    expect(res.mimeType).toBe('audio/wav');
    expect(isWav(res.audio)).toBe(true);
    expect(res.audio.length).toBeGreaterThan(44);
    expect(res.durationMs).toBeGreaterThan(0);
  });

  it('is deterministic per input text', async () => {
    const tts = new MockTTSProvider();
    const a = await tts.synthesize('same text');
    const b = await tts.synthesize('same text');
    const c = await tts.synthesize('different text');
    expect(a.audio).toEqual(b.audio);
    expect(a.audio).not.toEqual(c.audio);
  });

  it('validates input', async () => {
    const tts = new MockTTSProvider();
    await expect(tts.synthesize('   ')).rejects.toThrow(/non-empty/);
    await expect(tts.synthesize('x'.repeat(5001))).rejects.toThrow(/too long/);
    await expect(tts.synthesize('hi', { format: 'ogg' as never })).rejects.toThrow(
      /unsupported format/,
    );
  });
});

describe('makeMockWav', () => {
  it('builds a parseable WAV header', () => {
    const wav = makeMockWav('seed', 500);
    expect(isWav(wav)).toBe(true);
    const view = new DataView(wav.buffer);
    expect(view.getUint32(24, true)).toBe(8000); // sample rate
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
  });
});

describe('provider selection', () => {
  it('defaults to mock providers', () => {
    expect(selectSTTProvider({}).name).toBe('mock');
    expect(selectTTSProvider({}).name).toBe('mock');
  });

  it('rejects unknown provider ids with a clear error', () => {
    expect(() => selectSTTProvider({ VOICE_STT_PROVIDER: 'deepgram' })).toThrow(
      /unknown STT provider/,
    );
    expect(() => selectTTSProvider({ VOICE_TTS_PROVIDER: 'azure' })).toThrow(
      /unknown TTS provider/,
    );
  });
});

describe('VoiceSession', () => {
  it('runs a full turn: listen → respond → speak', async () => {
    const session = new VoiceSession(new MockSTTProvider(), new MockTTSProvider());
    const { transcript, replyText, replyAudio } = await session.turn(
      new Uint8Array([7, 7, 7]),
      async (t) => `you said: ${t.slice(0, 20)}`,
    );
    expect(transcript).toContain('mock microphone');
    expect(replyText.startsWith('you said:')).toBe(true);
    expect(isWav(replyAudio.audio)).toBe(true);

    const turns = session.turnsList();
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ transcript, replyText });
    expect(turns[0]?.replyAudioBytes).toBe(replyAudio.audio.length);
  });

  it('listen and speak work standalone', async () => {
    const session = new VoiceSession(new MockSTTProvider('canned'), new MockTTSProvider());
    const stt = await session.listen(new Uint8Array([1]));
    expect(stt.text).toContain('canned');
    const tts = await session.speak('hi');
    expect(isWav(tts.audio)).toBe(true);
    expect(session.turnsList()).toHaveLength(0); // standalone calls don't record turns
  });
});
