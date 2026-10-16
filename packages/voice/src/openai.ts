// SPDX-License-Identifier: Apache-2.0
// OpenAI voice providers: STT (Whisper) and TTS over OpenAI's REST audio
// endpoints:
//
//   STT: POST https://api.openai.com/v1/audio/transcriptions
//        (multipart: file, model, language?, response_format=json)
//   TTS: POST https://api.openai.com/v1/audio/speech
//        (JSON: model, input, voice, response_format)
//
// NOTE: these are the REST endpoints, not the OpenAI Realtime API — the
// call service drives its own turn loop (STT → bot turn → TTS) over its own
// WebSocket, so the transport stays provider-agnostic and BYOK.
//
// Key-gated by design: the key is read from OPENAI_API_KEY (or passed
// explicitly) and never logged. The mock providers in voice.ts remain the
// default — these only activate when VOICE_STT_PROVIDER/VOICE_TTS_PROVIDER
// is set to 'openai', or when a voice call explicitly selects the provider
// and a key resolves (vault secret `voice_openai_api_key` → env).

import type {
  STTProvider,
  STTResult,
  STTTranscribeOptions,
  TTSProvider,
  TTSResult,
  TTSSynthesizeOptions,
} from './voice.js';

/** OpenAI API base for audio endpoints. */
export const OPENAI_VOICE_BASE_URL = 'https://api.openai.com/v1';

/** Env var holding the OpenAI API key. */
export const OPENAI_API_KEY_ENV_VAR = 'OPENAI_API_KEY';

/** Whisper STT models. */
export const OPENAI_STT_MODELS = ['whisper-1'] as const;
export const DEFAULT_OPENAI_STT_MODEL = 'whisper-1';

/** TTS models served by OpenAI. */
export const OPENAI_TTS_MODELS = ['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts'] as const;
export const DEFAULT_OPENAI_TTS_MODEL = 'tts-1';
/** Built-in OpenAI TTS voices (user may also supply a custom voice id). */
export const OPENAI_TTS_VOICES = [
  'alloy',
  'echo',
  'fable',
  'onyx',
  'nova',
  'shimmer',
] as const;
export const DEFAULT_OPENAI_TTS_VOICE = 'alloy';

export interface OpenAIVoiceOptions {
  /** API key; falls back to OPENAI_API_KEY in env. Never logged or persisted. */
  apiKey?: string;
  /** Override for tests/proxies; defaults to OPENAI_VOICE_BASE_URL. */
  baseUrl?: string;
  /** STT model id; default 'whisper-1'. */
  sttModel?: string;
  /** TTS model id; default 'tts-1'. */
  ttsModel?: string;
  /** Default voice; overridable per call via TTSSynthesizeOptions.voice. */
  ttsVoice?: string;
  /** Env source; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

function resolveVoiceConfig(opts: OpenAIVoiceOptions): Required<Omit<OpenAIVoiceOptions, 'env'>> {
  const env = opts.env ?? process.env;
  const apiKey = opts.apiKey ?? env[OPENAI_API_KEY_ENV_VAR];
  if (!apiKey) {
    throw new Error(
      `openai voice: missing ${OPENAI_API_KEY_ENV_VAR}. Set the ${OPENAI_API_KEY_ENV_VAR} ` +
        `environment variable (or pass apiKey explicitly), or leave VOICE_*_PROVIDER unset to use the mock.`,
    );
  }
  return {
    apiKey,
    baseUrl: (opts.baseUrl ?? OPENAI_VOICE_BASE_URL).replace(/\/+$/, ''),
    sttModel: opts.sttModel ?? DEFAULT_OPENAI_STT_MODEL,
    ttsModel: opts.ttsModel ?? DEFAULT_OPENAI_TTS_MODEL,
    ttsVoice: opts.ttsVoice ?? DEFAULT_OPENAI_TTS_VOICE,
  };
}

async function openaiRequest(
  url: string,
  init: RequestInit,
  apiKey: string,
  label: string,
): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey}`, ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `${label} failed: ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 300)}` : ''}`,
    );
  }
  return res;
}

/**
 * OpenAI STT via the /audio/transcriptions endpoint (Whisper).
 * Key-gated; zero calls happen without OPENAI_API_KEY.
 */
export class OpenAISTTProvider implements STTProvider {
  readonly name = 'openai' as const;
  private readonly cfg: Required<Omit<OpenAIVoiceOptions, 'env'>>;

  constructor(opts: OpenAIVoiceOptions = {}) {
    this.cfg = resolveVoiceConfig(opts);
  }

  async transcribe(audio: Uint8Array, opts: STTTranscribeOptions = {}): Promise<STTResult> {
    if (!(audio instanceof Uint8Array) || audio.length === 0) {
      throw new Error('openai STT: audio must be a non-empty Uint8Array');
    }
    const form = new FormData();
    const bytes = new Uint8Array(audio);
    form.append(
      'file',
      new Blob([bytes.buffer as ArrayBuffer], { type: opts.mimeType ?? 'audio/webm' }),
      'audio.webm',
    );
    form.append('model', this.cfg.sttModel);
    form.append('response_format', 'json');
    if (opts.language) form.append('language', opts.language);
    const res = await openaiRequest(
      `${this.cfg.baseUrl}/audio/transcriptions`,
      { method: 'POST', body: form },
      this.cfg.apiKey,
      'openai STT',
    );
    const data = (await res.json()) as { text?: unknown };
    if (typeof data.text !== 'string' || !data.text) {
      throw new Error('openai STT: unexpected response shape (missing text)');
    }
    return { text: data.text, language: opts.language };
  }
}

/**
 * OpenAI TTS via the /audio/speech endpoint.
 * Key-gated; zero calls happen without OPENAI_API_KEY.
 */
export class OpenAITTSProvider implements TTSProvider {
  readonly name = 'openai' as const;
  private readonly cfg: Required<Omit<OpenAIVoiceOptions, 'env'>>;

  constructor(opts: OpenAIVoiceOptions = {}) {
    this.cfg = resolveVoiceConfig(opts);
  }

  async synthesize(text: string, opts: TTSSynthesizeOptions = {}): Promise<TTSResult> {
    const trimmed = text.trim();
    if (!trimmed) throw new Error('openai TTS: text must be non-empty');
    const format = opts.format ?? 'mp3';
    if (format !== 'wav' && format !== 'mp3') {
      throw new Error(`openai TTS: unsupported format "${format}" (supported: wav, mp3)`);
    }
    const res = await openaiRequest(
      `${this.cfg.baseUrl}/audio/speech`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.cfg.ttsModel,
          input: trimmed,
          voice: opts.voice ?? this.cfg.ttsVoice,
          response_format: format,
        }),
      },
      this.cfg.apiKey,
      'openai TTS',
    );
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length === 0) throw new Error('openai TTS: empty audio response');
    return {
      audio: buf,
      mimeType: format === 'mp3' ? 'audio/mpeg' : 'audio/wav',
    };
  }
}
