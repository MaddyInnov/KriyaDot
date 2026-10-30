// SPDX-License-Identifier: Apache-2.0
// V-6 podcast generation tests — MockTTSProvider + stubs only.
// Zero network, zero keys, zero paid usage.
import { describe, it, expect } from 'vitest';
import { MockTTSProvider, makeMockWav, type TTSProvider, type TTSResult } from '../src/voice.js';
import {
  parsePodcastScript,
  validatePodcastSegments,
  parseWav,
  wavDurationMs,
  concatWavSegments,
  generatePodcastEpisode,
  podcastEpisodeManifest,
} from '../src/podcast.js';

describe('parsePodcastScript', () => {
  it('parses title, speaker turns, continuations; skips blanks/comments', () => {
    const { title, segments } = parsePodcastScript(
      ['# The Lighthouse Show', '', '// a note to self', 'Host: Welcome back.', 'Today we dive in.', 'Guest: Thanks for having me.'].join('\n'),
    );
    expect(title).toBe('The Lighthouse Show');
    expect(segments).toEqual([
      { speaker: 'Host', text: 'Welcome back. Today we dive in.' },
      { speaker: 'Guest', text: 'Thanks for having me.' },
    ]);
  });

  it('defaults the title and rejects leaderless/empty scripts', () => {
    expect(parsePodcastScript('Host: hi').title).toBe('Untitled episode');
    expect(() => parsePodcastScript('   ')).toThrow(/non-empty/);
    expect(() => parsePodcastScript('no speaker here')).toThrow(/no "Speaker:" prefix/);
    expect(() => parsePodcastScript('# Only a title')).toThrow(/no speaker segments/);
  });

  it('validatePodcastSegments trims and bounds input', () => {
    expect(validatePodcastSegments([{ speaker: ' A ', text: ' hi ' }])).toEqual([{ speaker: 'A', text: 'hi' }]);
    expect(() => validatePodcastSegments([])).toThrow(/at least one/);
    expect(() => validatePodcastSegments([{ speaker: '', text: 'x' }])).toThrow(/empty speaker/);
  });
});

describe('WAV concatenation', () => {
  it('parseWav + wavDurationMs read the mock WAV layout', () => {
    const parts = parseWav(makeMockWav('seed', 500));
    expect(parts.sampleRate).toBe(8000);
    expect(parts.channels).toBe(1);
    expect(parts.bitsPerSample).toBe(16);
    expect(wavDurationMs(parts)).toBe(500);
  });

  it('concatWavSegments sums durations and stays one valid WAV', () => {
    const joined = concatWavSegments([makeMockWav('a', 400), makeMockWav('b', 600), makeMockWav('c', 200)]);
    const parts = parseWav(joined);
    expect(wavDurationMs(parts)).toBe(1200);
    expect(joined.length).toBe(44 + 8000 * 2 * 1.2);
  });

  it('rejects non-WAV input and mismatched formats honestly', () => {
    expect(() => concatWavSegments([new Uint8Array([1, 2, 3])])).toThrow(/not a RIFF\/WAVE/);
    // A WAV with a different sample rate (patch the header of a mock wav).
    const other = new Uint8Array(makeMockWav('x', 100));
    new DataView(other.buffer).setUint32(24, 16000, true);
    expect(() => concatWavSegments([makeMockWav('a', 100), other])).toThrow(/mismatched WAV formats/);
  });
});

describe('generatePodcastEpisode (V-6)', () => {
  it('voices a two-speaker script with per-speaker voices and combines the episode', async () => {
    const seen: { text: string; voice?: string }[] = [];
    const recording: TTSProvider = {
      name: 'recording',
      synthesize: async (text, opts): Promise<TTSResult> => {
        seen.push({ text, voice: opts?.voice });
        const base = await new MockTTSProvider().synthesize(text, opts);
        return base;
      },
    };
    const episode = await generatePodcastEpisode({
      script: '# Demo Cast\nHost: Hello **everyone**, welcome.\nGuest: Glad to be here.',
      provider: recording,
      cast: { Host: { voice: 'host-voice' }, Guest: { voice: 'guest-voice' } },
    });
    expect(episode.title).toBe('Demo Cast');
    expect(episode.speakers).toEqual(['Host', 'Guest']);
    expect(episode.segments).toHaveLength(2);
    expect(seen.map((s) => s.voice)).toEqual(['host-voice', 'guest-voice']);
    // Speech-text cleaning stripped the markdown emphasis before synthesis.
    expect(seen[0].text).not.toContain('**');
    // Combined into a single WAV whose length is the sum of the segments.
    expect(episode.combinedAudio).not.toBeNull();
    expect(episode.combinedMimeType).toBe('audio/wav');
    const segTotal = episode.segments.reduce((s, x) => s + x.audio.length - 44, 0);
    expect(episode.combinedAudio!.length).toBe(44 + segTotal);
    expect(episode.totalDurationMs).toBeGreaterThan(0);
    expect(episode.segments[1].offsetMs).toBe(episode.segments[0].durationMs);

    const manifest = podcastEpisodeManifest(episode);
    expect(manifest.combined).toBe(true);
    expect(manifest.segments.map((s) => s.speaker)).toEqual(['Host', 'Guest']);
    expect(manifest.segments[0].audioBytes).toBeGreaterThan(44);
  });

  it('per-speaker provider override is honored', async () => {
    const alt: TTSProvider = {
      name: 'alt-tts',
      synthesize: async (text) => new MockTTSProvider().synthesize(text),
    };
    const episode = await generatePodcastEpisode({
      segments: [
        { speaker: 'Host', text: 'intro' },
        { speaker: 'Guest', text: 'answer' },
      ],
      provider: new MockTTSProvider(),
      cast: { Guest: { provider: alt } },
    });
    expect(episode.segments.map((s) => s.provider)).toEqual(['mock', 'alt-tts']);
  });

  it('mixed non-WAV output is delivered per-segment with an honest note, not a fake combine', async () => {
    const mp3ish: TTSProvider = {
      name: 'mp3ish',
      synthesize: async (): Promise<TTSResult> => ({ audio: new Uint8Array([0xff, 0xfb, 1, 2]), mimeType: 'audio/mpeg', durationMs: 100 }),
    };
    const episode = await generatePodcastEpisode({
      segments: [{ speaker: 'Solo', text: 'monologue' }],
      provider: mp3ish,
    });
    expect(episode.combinedAudio).toBeNull();
    expect(episode.combinedNote).toMatch(/not every segment is WAV/);
    expect(episode.segments[0].audio.length).toBe(4);
    expect(podcastEpisodeManifest(episode).combined).toBe(false);
  });

  it('requires exactly one input source and a provider', async () => {
    await expect(generatePodcastEpisode({ provider: new MockTTSProvider() })).rejects.toThrow(/exactly one of/);
    await expect(
      generatePodcastEpisode({ provider: new MockTTSProvider(), script: 'A: x', segments: [{ speaker: 'A', text: 'x' }] }),
    ).rejects.toThrow(/exactly one of/);
  });
});
