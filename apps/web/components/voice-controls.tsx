// SPDX-License-Identifier: Apache-2.0
'use client';

// Minimal voice controls for the MVP web client. The UI workstream places
// this component (e.g. beside the chat input); it is fully self-contained.
//
// Two input paths:
//   1. Browser Web Speech API (SpeechRecognition) when available — live
//      on-device transcription, no audio upload.
//   2. Fallback: MediaRecorder captures mic audio and POSTs it to
//      /api/voice/stt (the mock provider returns canned text in the MVP).
//
// The speaker button POSTs text to /api/voice/tts and plays the returned
// audio (mock: a short WAV tone, not real speech, until a real TTS provider
// is wired via VOICE_TTS_PROVIDER).

import { useCallback, useEffect, useRef, useState } from 'react';
import { authedFetch } from '../lib/api';

export interface VoiceControlsProps {
  /** Called with each finalized transcript. */
  onTranscript?: (text: string) => void;
  /** Text to synthesize when the speaker button is pressed. */
  speakText?: string;
  /** BCP-47 language hint for STT. */
  language?: string;
}

type MicState = 'idle' | 'listening' | 'working' | 'error';


export default function VoiceControls({ onTranscript, speakText, language = 'en' }: VoiceControlsProps) {
  const [micState, setMicState] = useState<MicState>('idle');
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [webSpeech, setWebSpeech] = useState(false);
  const recognitionRef = useRef<{ stop(): void } | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const w = window as unknown as {
      SpeechRecognition?: new () => unknown;
      webkitSpeechRecognition?: new () => unknown;
    };
    setWebSpeech(Boolean(w.SpeechRecognition ?? w.webkitSpeechRecognition));
    return () => {
      try {
        recognitionRef.current?.stop();
      } catch {
        /* already stopped */
      }
      try {
        recorderRef.current?.stream.getTracks().forEach((t) => t.stop());
      } catch {
        /* nothing recording */
      }
    };
  }, []);

  const postStt = useCallback(
    async (audioBase64: string, mimeType?: string) => {
      const res = await authedFetch('/api/voice/stt', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ audioBase64, mimeType, language }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `STT failed (${res.status})`);
      }
      return (await res.json()) as { text: string };
    },
    [language],
  );

  const stopAll = useCallback(() => {
    try {
      recognitionRef.current?.stop();
    } catch {
      /* noop */
    }
    recognitionRef.current = null;
    const rec = recorderRef.current;
    recorderRef.current = null;
    if (rec && rec.state !== 'inactive') {
      try {
        rec.stop();
      } catch {
        /* noop */
      }
    }
    setMicState('idle');
  }, []);

  const startWebSpeech = useCallback(() => {
    const w = window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) return false;
    const rec = new Ctor();
    rec.lang = language;
    rec.interimResults = false;
    rec.onresult = (ev: SpeechRecognitionEventLike) => {
      const text = Array.from(ev.results)
        .map((r) => r[0]?.transcript ?? '')
        .join(' ')
        .trim();
      if (text) onTranscript?.(text);
      stopAll();
    };
    rec.onerror = () => {
      setError('Microphone transcription failed; try the audio-upload fallback.');
      setMicState('error');
    };
    rec.onend = () => setMicState((s) => (s === 'listening' ? 'idle' : s));
    recognitionRef.current = rec;
    rec.start();
    setMicState('listening');
    setError(null);
    return true;
  }, [language, onTranscript, stopAll]);

  const startRecorderFallback = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const chunks: Blob[] = [];
    const rec = new MediaRecorder(stream);
    recorderRef.current = rec;
    rec.ondataavailable = (ev) => {
      if (ev.data.size > 0) chunks.push(ev.data);
    };
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      setMicState('working');
      try {
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
        const buffer = await blob.arrayBuffer();
        const base64 = btoa(
          Array.from(new Uint8Array(buffer))
            .map((b) => String.fromCharCode(b))
            .join(''),
        );
        const { text } = await postStt(base64, blob.type);
        onTranscript?.(text);
        setMicState('idle');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Transcription failed');
        setMicState('error');
      }
    };
    rec.start();
    setMicState('listening');
    setError(null);
  }, [onTranscript, postStt]);

  const toggleMic = useCallback(async () => {
    if (micState === 'listening') {
      stopAll();
      return;
    }
    try {
      if (webSpeech && startWebSpeech()) return;
      await startRecorderFallback();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not access the microphone');
      setMicState('error');
    }
  }, [micState, webSpeech, startWebSpeech, startRecorderFallback, stopAll]);

  const speak = useCallback(async () => {
    const text = (speakText ?? '').trim();
    if (!text || speaking) return;
    setSpeaking(true);
    setError(null);
    try {
      const res = await authedFetch('/api/voice/tts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, format: 'wav' }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `TTS failed (${res.status})`);
      }
      const { audioBase64, mimeType } = (await res.json()) as {
        audioBase64: string;
        mimeType: string;
      };
      const bytes = Uint8Array.from(atob(audioBase64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => {
        URL.revokeObjectURL(url);
        setSpeaking(false);
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        setSpeaking(false);
        setError('Could not play the synthesized audio');
      };
      await audio.play();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Speech synthesis failed');
      setSpeaking(false);
    }
  }, [speakText, speaking]);

  const micLabel =
    micState === 'listening' ? 'Stop' : micState === 'working' ? 'Working…' : 'Speak';

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <button
        type="button"
        onClick={toggleMic}
        disabled={micState === 'working'}
        aria-label={micState === 'listening' ? 'Stop listening' : 'Start voice input'}
        title={webSpeech ? 'Transcribe with on-device speech recognition' : 'Record audio and transcribe via /api/voice/stt'}
        style={{
          padding: '6px 12px',
          borderRadius: 8,
          border: '1px solid #ccc',
          background: micState === 'listening' ? '#f66' : '#fff',
          color: micState === 'listening' ? '#fff' : '#000',
          cursor: micState === 'working' ? 'wait' : 'pointer',
        }}
      >
        🎙 {micLabel}
      </button>
      <button
        type="button"
        onClick={speak}
        disabled={!speakText?.trim() || speaking}
        aria-label="Read the reply aloud"
        title="Synthesize via /api/voice/tts and play"
        style={{
          padding: '6px 12px',
          borderRadius: 8,
          border: '1px solid #ccc',
          background: '#fff',
          cursor: !speakText?.trim() || speaking ? 'not-allowed' : 'pointer',
        }}
      >
        🔊 {speaking ? 'Playing…' : 'Listen'}
      </button>
      {error && (
        <span role="alert" style={{ color: '#c00', fontSize: 12 }}>
          {error}
        </span>
      )}
    </div>
  );
}

// Minimal structural types for the Web Speech API (avoids lib.dom gaps).
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
interface SpeechRecognitionEventLike {
  results: ArrayLike<ArrayLike<{ transcript?: string }>>;
}
