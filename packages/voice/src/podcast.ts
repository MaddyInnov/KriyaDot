// SPDX-License-Identifier: Apache-2.0
// Podcast-style multi-voice audio generation (Muse parity audit
// §4.9, V-6): a script with named speakers goes in, a voiced episode
// comes out — one TTS call per segment, each speaker with their own
// voice (and optionally their own provider), segments concatenated
// into a single episode file when every segment is PCM WAV.
//
// Script format (the same "Name: text" convention as the TTS script
// tooling): an optional leading "# Episode title" line, then one
// segment per speaker turn. Lines without a "Name:" prefix continue
// the previous segment. Blank lines and lines starting with "//" are
// ignored.
//
// Built on the existing TTS machinery (./voice.ts): any TTSProvider
// works, so tests run entirely on MockTTSProvider — zero paid usage.
// Real episodes use whichever real provider the cast selects (Groq,
// OpenAI, ElevenLabs, Fish, Chatterbox, system).

import { prepareSpeechText } from './speech-text.js';
import type { TTSProvider, TTSResult } from './voice.js';

export interface PodcastSegmentInput {
  speaker: string;
  text: string;
}

export interface PodcastCastEntry {
  /** Voice id passed to the provider for this speaker. */
  voice?: string;
  /** Provider override for this speaker; default: the episode provider. */
  provider?: TTSProvider;
}

export type PodcastCast = Record<string, PodcastCastEntry>;

export interface PodcastSegmentResult extends PodcastSegmentInput {
  index: number;
  provider: string;
  voice?: string;
  audio: Uint8Array;
  mimeType: string;
  durationMs?: number;
  /** Offset of this segment inside the combined episode audio, when combined. */
  offsetMs?: number;
}

export interface PodcastEpisode {
  title: string;
  segments: PodcastSegmentResult[];
  speakers: string[];
  totalDurationMs: number;
  /**
   * All segments concatenated into one WAV, or null when the segments
   * are not all combinable PCM WAV (e.g. an MP3 provider was mixed in);
   * `combinedNote` then explains why per-segment audio is the output.
   */
  combinedAudio: Uint8Array | null;
  combinedMimeType?: string;
  combinedNote?: string;
}

/** Parse a "Name: text" podcast script into title + segments. */
export function parsePodcastScript(script: string): { title: string; segments: PodcastSegmentInput[] } {
  if (typeof script !== 'string' || !script.trim()) {
    throw new Error('podcast: script must be a non-empty string');
  }
  let title = 'Untitled episode';
  const segments: PodcastSegmentInput[] = [];
  let titleSeen = false;
  for (const rawLine of script.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('//')) continue;
    if (line.startsWith('#')) {
      if (!titleSeen) {
        const t = line.replace(/^#+\s*/, '').trim();
        if (t) title = t;
        titleSeen = true;
      }
      continue;
    }
    const m = /^([A-Za-z][A-Za-z0-9 .'-]{0,40}?)\s*:\s+(.+)$/.exec(line);
    if (m) {
      segments.push({ speaker: m[1].trim(), text: m[2].trim() });
    } else if (segments.length > 0) {
      // Continuation of the previous speaker's turn.
      const last = segments[segments.length - 1];
      last.text = `${last.text} ${line}`;
    } else {
      throw new Error(`podcast: line has no "Speaker:" prefix and no previous segment to continue: "${line.slice(0, 60)}"`);
    }
  }
  if (segments.length === 0) throw new Error('podcast: script contains no speaker segments');
  return { title, segments };
}

/** Validate + normalize structured segment input. */
export function validatePodcastSegments(segments: PodcastSegmentInput[]): PodcastSegmentInput[] {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error('podcast: at least one segment is required');
  }
  if (segments.length > 200) throw new Error('podcast: at most 200 segments per episode');
  return segments.map((s, i) => {
    const speaker = (s?.speaker ?? '').trim();
    const text = (s?.text ?? '').trim();
    if (!speaker) throw new Error(`podcast: segment ${i} has an empty speaker`);
    if (!text) throw new Error(`podcast: segment ${i} (${speaker}) has empty text`);
    return { speaker, text };
  });
}

// ---------------------------------------------------------------------------
// WAV concatenation (PCM only)
// ---------------------------------------------------------------------------

interface WavParts {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  data: Uint8Array;
}

/** Parse a PCM WAV buffer into its fmt parameters + raw sample data. */
export function parseWav(bytes: Uint8Array): WavParts {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (bytes.length < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') {
    throw new Error('podcast WAV concat: input is not a RIFF/WAVE file');
  }
  let fmt: { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number } | undefined;
  let data: Uint8Array | undefined;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunkId = tag(offset);
    const chunkSize = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (chunkId === 'fmt ') {
      fmt = {
        audioFormat: view.getUint16(start, true),
        channels: view.getUint16(start + 2, true),
        sampleRate: view.getUint32(start + 4, true),
        bitsPerSample: view.getUint16(start + 14, true),
      };
    } else if (chunkId === 'data') {
      data = bytes.subarray(start, Math.min(start + chunkSize, bytes.length));
    }
    offset = start + chunkSize + (chunkSize % 2);
  }
  if (!fmt || !data) throw new Error('podcast WAV concat: missing fmt or data chunk');
  if (fmt.audioFormat !== 1) throw new Error(`podcast WAV concat: only PCM (format 1) can be concatenated, got format ${fmt.audioFormat}`);
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, bitsPerSample: fmt.bitsPerSample, data };
}

function buildWav(parts: WavParts, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(44 + data.length);
  const view = new DataView(out.buffer);
  const writeAscii = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  const bytesPerSample = parts.bitsPerSample / 8;
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + data.length, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, parts.channels, true);
  view.setUint32(24, parts.sampleRate, true);
  view.setUint32(28, parts.sampleRate * parts.channels * bytesPerSample, true);
  view.setUint16(32, parts.channels * bytesPerSample, true);
  view.setUint16(34, parts.bitsPerSample, true);
  writeAscii(36, 'data');
  view.setUint32(40, data.length, true);
  out.set(data, 44);
  return out;
}

/** Duration of a parsed WAV in ms, from its sample count. */
export function wavDurationMs(parts: WavParts): number {
  const bytesPerFrame = (parts.bitsPerSample / 8) * parts.channels;
  return Math.round((parts.data.length / bytesPerFrame / parts.sampleRate) * 1000);
}

/**
 * Concatenate PCM WAV buffers that share sample rate / channels / bit
 * depth into one WAV. Throws when formats differ — mixing providers
 * with different WAV layouts must be re-encoded, never silently joined.
 */
export function concatWavSegments(buffers: Uint8Array[]): Uint8Array {
  if (buffers.length === 0) throw new Error('podcast WAV concat: no buffers');
  const parsed = buffers.map(parseWav);
  const first = parsed[0];
  for (const p of parsed) {
    if (p.sampleRate !== first.sampleRate || p.channels !== first.channels || p.bitsPerSample !== first.bitsPerSample) {
      throw new Error(
        `podcast WAV concat: mismatched WAV formats (${first.sampleRate}Hz/${first.channels}ch/${first.bitsPerSample}bit vs ${p.sampleRate}Hz/${p.channels}ch/${p.bitsPerSample}bit)`,
      );
    }
  }
  const total = parsed.reduce((s, p) => s + p.data.length, 0);
  const data = new Uint8Array(total);
  let at = 0;
  for (const p of parsed) {
    data.set(p.data, at);
    at += p.data.length;
  }
  return buildWav(first, data);
}

// ---------------------------------------------------------------------------
// Episode generation
// ---------------------------------------------------------------------------

export interface GeneratePodcastOptions {
  /** Script text ("# Title" + "Name: text" lines) — or pass `segments`. */
  script?: string;
  /** Structured segments — or pass `script`. Exactly one source. */
  segments?: PodcastSegmentInput[];
  /** Episode title override (wins over the script's "# …" line). */
  title?: string;
  /** Default TTS provider for speakers without a cast override. */
  provider: TTSProvider;
  /** Per-speaker voice/provider assignments. */
  cast?: PodcastCast;
  /** Run segment text through prepareSpeechText first (default true). */
  cleanSpeechText?: boolean;
}

/**
 * Generate a voiced episode: synthesize each segment with its speaker's
 * voice/provider (sequentially — provider rate limits are real), then
 * concatenate when every segment came back as combinable PCM WAV.
 */
export async function generatePodcastEpisode(opts: GeneratePodcastOptions): Promise<PodcastEpisode> {
  if ((opts.script === undefined) === (opts.segments === undefined)) {
    throw new Error('podcast: pass exactly one of "script" or "segments"');
  }
  if (!opts.provider) throw new Error('podcast: a default TTS provider is required');
  const parsed = opts.script !== undefined ? parsePodcastScript(opts.script) : { title: 'Untitled episode', segments: opts.segments! };
  const title = (opts.title ?? parsed.title).trim() || 'Untitled episode';
  const inputs = validatePodcastSegments(parsed.segments);
  const cast = opts.cast ?? {};
  const clean = opts.cleanSpeechText ?? true;

  const segments: PodcastSegmentResult[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    const entry = cast[input.speaker];
    const provider = entry?.provider ?? opts.provider;
    const text = clean ? prepareSpeechText(input.text) || input.text : input.text;
    const result: TTSResult = await provider.synthesize(text, {
      ...(entry?.voice ? { voice: entry.voice } : {}),
      format: 'wav',
    });
    segments.push({
      ...input,
      index: i,
      provider: provider.name,
      ...(entry?.voice ? { voice: entry.voice } : {}),
      audio: result.audio,
      mimeType: result.mimeType,
      ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
    });
  }

  // Durations: prefer the WAV truth when a segment is WAV; else the
  // provider's reported duration; else 0 (unknown, stated honestly).
  let totalDurationMs = 0;
  for (const seg of segments) {
    let dur = seg.durationMs ?? 0;
    if (seg.mimeType === 'audio/wav') {
      try {
        dur = wavDurationMs(parseWav(seg.audio));
      } catch {
        /* keep the provider-reported duration */
      }
    }
    seg.durationMs = dur;
    seg.offsetMs = totalDurationMs;
    totalDurationMs += dur;
  }

  let combinedAudio: Uint8Array | null = null;
  let combinedNote: string | undefined;
  if (segments.every((s) => s.mimeType === 'audio/wav')) {
    try {
      combinedAudio = concatWavSegments(segments.map((s) => s.audio));
    } catch (err) {
      combinedNote = `segments were not concatenated: ${err instanceof Error ? err.message : String(err)}`;
      for (const seg of segments) delete seg.offsetMs;
    }
  } else {
    combinedNote = 'segments were not concatenated: not every segment is WAV (mixed/non-WAV provider output); per-segment audio is the deliverable';
    for (const seg of segments) delete seg.offsetMs;
  }

  return {
    title,
    segments,
    speakers: [...new Set(inputs.map((s) => s.speaker))],
    totalDurationMs,
    combinedAudio,
    ...(combinedAudio ? { combinedMimeType: 'audio/wav' } : {}),
    ...(combinedNote ? { combinedNote } : {}),
  };
}

/** Serializable episode manifest (no audio bytes): titles, speakers, timing map. */
export function podcastEpisodeManifest(episode: PodcastEpisode): {
  title: string;
  speakers: string[];
  totalDurationMs: number;
  combined: boolean;
  combinedNote?: string;
  segments: { index: number; speaker: string; voice?: string; provider: string; text: string; durationMs?: number; offsetMs?: number; audioBytes: number }[];
} {
  return {
    title: episode.title,
    speakers: episode.speakers,
    totalDurationMs: episode.totalDurationMs,
    combined: episode.combinedAudio !== null,
    ...(episode.combinedNote ? { combinedNote: episode.combinedNote } : {}),
    segments: episode.segments.map((s) => ({
      index: s.index,
      speaker: s.speaker,
      ...(s.voice ? { voice: s.voice } : {}),
      provider: s.provider,
      text: s.text,
      ...(s.durationMs !== undefined ? { durationMs: s.durationMs } : {}),
      ...(s.offsetMs !== undefined ? { offsetMs: s.offsetMs } : {}),
      audioBytes: s.audio.length,
    })),
  };
}
