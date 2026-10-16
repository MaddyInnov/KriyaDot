// SPDX-License-Identifier: Apache-2.0
// OpenAI Realtime API bridge: a server-side WebSocket proxy to
// wss://api.openai.com/v1/realtime — the true speech-to-speech path
// (GPT-class live voice with native barge-in and server VAD), as opposed
// to the chunked STT → bot turn → TTS engine the call service drives
// itself.
//
// The bridge NEVER exposes the API key to clients: KriyaDot's server
// terminates the client socket, opens its own authenticated socket to
// OpenAI, and translates OpenAI's realtime events into KriyaDot's wire
// shapes ({t:'transcript'}, {t:'audio'}, {t:'barge_in'}, …).
//
// Protocol notes (OpenAI Realtime, beta):
//   - Connect: wss://api.openai.com/v1/realtime?model=<model> with
//     headers Authorization: Bearer <key> and OpenAI-Beta: realtime=v1.
//   - Client audio in: input_audio_buffer.append {audio: base64 PCM16 24kHz mono}.
//   - Server audio out: response.audio.delta {delta: base64 PCM16 24kHz mono}.
//   - Server VAD: turn_detection {type:'server_vad'} emits
//     input_audio_buffer.speech_started / speech_stopped — OpenAI natively
//     cancels its own response on interruption (true barge-in).
//   - Transcripts: input_audio_transcription {model:'whisper-1'} gives
//     conversation.item.input_audio_transcription.completed; response text
//     arrives as response.audio_transcript.delta / response.done.
//
// LIMITATION (honest): this bridge is written against the documented
// protocol and unit-tested with a fake socket, but it has NOT been
// live-fired against api.openai.com (no key in this environment). The
// chunked engine is the default; the passthrough engine activates only
// when the user selects it AND an OpenAI key resolves.

/** Realtime model ids known to work with the Realtime API. */
export const OPENAI_REALTIME_MODELS = [
  'gpt-4o-realtime-preview',
  'gpt-4o-realtime-preview-2024-10-01',
  'gpt-4o-mini-realtime-preview',
  'gpt-4o-mini-realtime-preview-2024-12-17',
] as const;
export const DEFAULT_OPENAI_REALTIME_MODEL = 'gpt-4o-realtime-preview';

/** Realtime endpoint (no trailing slash). */
export const OPENAI_REALTIME_WS_URL = 'wss://api.openai.com/v1/realtime';

/** PCM16 mono sample rate the Realtime API expects/produces. */
export const REALTIME_SAMPLE_RATE = 24000;

export interface OpenAIRealtimeOptions {
  apiKey: string;
  model?: string;
  /** Voice for the realtime session (alloy, echo, …). */
  voice?: string;
  /** System instructions (the bot persona). */
  instructions?: string;
  /** Inject a WebSocket implementation (tests use a fake). */
  wsImpl?: typeof WebSocket;
  baseUrl?: string;
  /** Optional initial event sink (also settable via .onEvent). */
  onEvent?: (e: RealtimeBridgeEvent) => void;
}

/** KriyaDot-normalized events emitted by the bridge. */
export type RealtimeBridgeEvent =
  | { type: 'session_ready' }
  | { type: 'user_speech_started' }
  | { type: 'user_speech_stopped' }
  | { type: 'user_transcript'; text: string }
  | { type: 'assistant_transcript_delta'; text: string }
  | { type: 'assistant_audio_delta'; pcm16Base64: string; sampleRate: number }
  | { type: 'assistant_turn_done'; transcript: string }
  | { type: 'error'; detail: string };

interface MinimalWs {
  send(data: string): void;
  close(code?: number): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
}

/**
 * Upsample 16kHz PCM16 → 24kHz PCM16 with linear interpolation.
 * The Realtime API requires 24kHz; KriyaDot's client captures 16kHz.
 */
export function upsample16kTo24k(pcm16k: Int16Array): Int16Array {
  if (pcm16k.length === 0) return new Int16Array(0);
  const outLen = Math.floor((pcm16k.length * 3) / 2);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcPos = (i * 2) / 3;
    const lo = Math.floor(srcPos);
    const hi = Math.min(lo + 1, pcm16k.length - 1);
    const frac = srcPos - lo;
    out[i] = Math.round(pcm16k[lo] * (1 - frac) + pcm16k[hi] * frac);
  }
  return out;
}

function int16ToBase64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let bin = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  // btoa may not exist in pure-node contexts; Buffer is the fallback.
  if (typeof btoa === 'function') return btoa(bin);
  return Buffer.from(bin, 'binary').toString('base64');
}

/**
 * OpenAIRealtimeBridge: authenticated WS to the Realtime API with
 * KriyaDot event translation. The caller (voice-realtime service) owns
 * the client-facing socket; the bridge owns the OpenAI socket.
 */
export class OpenAIRealtimeBridge {
  private readonly opts: Required<Omit<OpenAIRealtimeOptions, 'wsImpl' | 'onEvent'>> & {
    wsImpl?: typeof WebSocket;
  };
  /** Event sink — assign before connect(). */
  onEvent: (e: RealtimeBridgeEvent) => void = () => {};
  private ws: MinimalWs | null = null;
  private assistantTranscript = '';
  private closed = false;

  constructor(opts: OpenAIRealtimeOptions) {
    if (!opts.apiKey) throw new Error('openai realtime: apiKey is required');
    this.opts = {
      apiKey: opts.apiKey,
      model: opts.model ?? DEFAULT_OPENAI_REALTIME_MODEL,
      voice: opts.voice ?? 'alloy',
      instructions: opts.instructions ?? 'You are a helpful voice assistant.',
      baseUrl: (opts.baseUrl ?? OPENAI_REALTIME_WS_URL).replace(/\/+$/, ''),
      wsImpl: opts.wsImpl,
    };
    if (opts.onEvent) this.onEvent = opts.onEvent;
  }

  get connected(): boolean {
    return this.ws !== null && !this.closed;
  }

  /** Open the authenticated socket and configure the session. */
  connect(): Promise<void> {
    if (this.ws) throw new Error('openai realtime: already connected');
    const WsCtor = this.opts.wsImpl ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    if (!WsCtor) throw new Error('openai realtime: no WebSocket implementation available');
    const url = `${this.opts.baseUrl}?model=${encodeURIComponent(this.opts.model)}`;
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WsCtor(url, {
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      } as never) as unknown as MinimalWs;
      this.ws = ws;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try {
            ws.close();
          } catch {
            // ignore
          }
          reject(new Error('openai realtime: connect timed out'));
        }
      }, 15000);
      ws.onopen = () => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        try {
          ws.send(
            JSON.stringify({
              type: 'session.update',
              session: {
                modalities: ['text', 'audio'],
                voice: this.opts.voice,
                instructions: this.opts.instructions,
                input_audio_format: 'pcm16',
                output_audio_format: 'pcm16',
                input_audio_transcription: { model: 'whisper-1' },
                turn_detection: { type: 'server_vad' },
              },
            }),
          );
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        resolve();
      };
      ws.onmessage = (ev) => this.handleOpenAIEvent(ev);
      ws.onerror = () => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(new Error('openai realtime: socket error during connect'));
        } else {
          this.onEvent({ type: 'error', detail: 'openai realtime socket error' });
        }
      };
      ws.onclose = () => {
        clearTimeout(timer);
        this.ws = null;
        if (!settled) {
          settled = true;
          reject(new Error('openai realtime: socket closed before connect'));
        }
      };
    });
  }

  /** Forward client mic audio (16kHz PCM16) to OpenAI (upsampled to 24kHz). */
  appendAudio(pcm16k: Int16Array): void {
    if (!this.ws || this.closed) return;
    const up = upsample16kTo24k(pcm16k);
    try {
      this.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: int16ToBase64(up) }));
    } catch {
      // socket gone; close() handles teardown
    }
  }

  /** Cancel the current assistant response (extra barge-in force). */
  cancelResponse(): void {
    if (!this.ws || this.closed) return;
    try {
      this.ws.send(JSON.stringify({ type: 'response.cancel' }));
    } catch {
      // ignore
    }
  }

  close(): void {
    this.closed = true;
    try {
      this.ws?.close(1000);
    } catch {
      // ignore
    }
    this.ws = null;
  }

  private handleOpenAIEvent(ev: { data: unknown }): void {
    let msg: { type?: unknown; [k: string]: unknown };
    try {
      msg = JSON.parse(String(ev.data)) as typeof msg;
    } catch {
      return;
    }
    switch (msg.type) {
      case 'session.created':
      case 'session.updated':
        this.onEvent({ type: 'session_ready' });
        break;
      case 'input_audio_buffer.speech_started':
        this.onEvent({ type: 'user_speech_started' });
        break;
      case 'input_audio_buffer.speech_stopped':
        this.onEvent({ type: 'user_speech_stopped' });
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (typeof msg.transcript === 'string' && msg.transcript) {
          this.onEvent({ type: 'user_transcript', text: msg.transcript });
        }
        break;
      case 'response.audio_transcript.delta':
        if (typeof msg.delta === 'string' && msg.delta) {
          this.assistantTranscript += msg.delta;
          this.onEvent({ type: 'assistant_transcript_delta', text: msg.delta });
        }
        break;
      case 'response.audio.delta':
        if (typeof msg.delta === 'string' && msg.delta) {
          this.onEvent({
            type: 'assistant_audio_delta',
            pcm16Base64: msg.delta,
            sampleRate: REALTIME_SAMPLE_RATE,
          });
        }
        break;
      case 'response.done': {
        const t = this.assistantTranscript;
        this.assistantTranscript = '';
        this.onEvent({ type: 'assistant_turn_done', transcript: t });
        break;
      }
      case 'error':
        this.onEvent({ type: 'error', detail: String((msg.error as { message?: unknown })?.message ?? 'openai realtime error') });
        break;
      default:
        break;
    }
  }
}
