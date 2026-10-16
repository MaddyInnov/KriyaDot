// SPDX-License-Identifier: Apache-2.0
// Realtime voice-call panel: a live voice call with a bot.
//
// Transport: the server owns the turn loop (STT → real bot turn → TTS)
// and streams progress over the /api/voice/calls WebSocket (see
// lib/voice-call-client.ts). Two mic modes:
//   - tap-to-talk (default): tap the mic to start/stop an utterance.
//   - auto VAD: client-side voice activity detection (lib/vad.ts)
//     auto-segments utterances.
// A live transcript, call timer, provider pickers (only configured BYOK
// providers are selectable), and approval notices round out the panel.

'use client';

import React from 'react';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../lib/i18n';
import { bytesToBase64 } from '../../lib/voice-http';
import { browserCaptureDeps, type CaptureDeps } from '../../lib/voice-notes';
import { VadDetector } from '../../lib/vad';
import {
  VoiceCallClient,
  getVoiceCallProviders,
  type CallClientEvent,
  type VoiceCallProviderInfo,
  type VoiceCallTurn,
} from '../../lib/voice-call-client';
import {
  RealtimeAudioPlayer,
  RealtimeCallClient,
  downsampleToRate,
  floatToPcm16,
  getRealtimeEngines,
  type AudioContextLike,
  type RealtimeClientEvent,
  type RealtimeEngineInfo,
  type RealtimeUsage,
} from '../../lib/realtime-call-client';

export interface CallPanelProps {
  botId: string;
  botName?: string;
  language?: string;
  /** Injectable capture deps (tests). Defaults to the real browser. */
  captureDeps?: CaptureDeps;
  /** Injectable client factory (tests). */
  clientFactory?: (onEvent: (e: CallClientEvent) => void) => VoiceCallClient;
}

type Phase = 'idle' | 'connecting' | 'live' | 'error';
type MicState = 'quiet' | 'recording' | 'thinking' | 'speaking';

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Resolve with the recorded utterance blob once the recorder stops.
 *
 * Reads the shared chunk array at onstop-time (MediaRecorder fires the
 * final ondataavailable AFTER stop() is called) and resets it afterwards.
 * Resetting chunksRef BEFORE stop() drops that final data event — with
 * start() and no timeslice, ALL audio arrives in it, yielding an empty blob.
 * Exported for unit tests.
 */
export function finalizeRecording(
  recorder: {
    stop(): void;
    readonly mimeType: string;
    onstop: ((ev: Event) => unknown) | null;
    onerror: ((ev: ErrorEvent) => unknown) | null;
  },
  chunksRef: { current: Blob[] },
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    recorder.onstop = () => {
      const chunks = chunksRef.current;
      chunksRef.current = [];
      resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
    };
    recorder.onerror = () => {
      chunksRef.current = [];
      reject(new Error('recording failed'));
    };
    try {
      recorder.stop();
    } catch (err) {
      chunksRef.current = [];
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function fmtTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function fmtUsd(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Realtime (speech-to-speech) call view.
// ---------------------------------------------------------------------------

interface RealtimeMessage {
  id: string;
  role: 'you' | 'bot';
  text: string;
  at: number;
}

let rtMsgSeq = 0;

interface RealtimeCallViewProps {
  botId: string;
  botName?: string;
  engine: 'chunked' | 'openai-realtime';
  sttProvider?: string;
  ttsProvider?: string;
  onExit: () => void;
}

/**
 * Full-duplex realtime call: continuous mic capture (16kHz PCM) with
 * browser echoCancellation, server-side VAD, barge-in (interrupting the
 * bot stops its audio instantly), live latency + cost ticker.
 */
function RealtimeCallView({ botId, botName, engine, sttProvider, ttsProvider, onExit }: RealtimeCallViewProps) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<'connecting' | 'live' | 'error'>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<RealtimeMessage[]>([]);
  const [userSpeaking, setUserSpeaking] = useState(false);
  const [interrupted, setInterrupted] = useState(false);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [usage, setUsage] = useState<RealtimeUsage | null>(null);
  const [approvalNotice, setApprovalNotice] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [maxMs, setMaxMs] = useState(15 * 60 * 1000);
  const [path, setPath] = useState('');

  const clientRef = useRef<RealtimeCallClient | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const playerRef = useRef<RealtimeAudioPlayer | null>(null);
  const procRef = useRef<ScriptProcessorNode | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const callStartRef = useRef(0);
  const mountedRef = useRef(true);
  const interruptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const teardown = useCallback(async () => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (interruptTimerRef.current) clearTimeout(interruptTimerRef.current);
    timerRef.current = null;
    interruptTimerRef.current = null;
    try {
      procRef.current?.disconnect();
    } catch {
      // ignore
    }
    try {
      streamRef.current?.getTracks().forEach((tr) => tr.stop());
    } catch {
      // ignore
    }
    try {
      playerRef.current?.stopAll();
    } catch {
      // ignore
    }
    try {
      await audioCtxRef.current?.close();
    } catch {
      // ignore
    }
    procRef.current = null;
    streamRef.current = null;
    audioCtxRef.current = null;
    playerRef.current = null;
    const client = clientRef.current;
    clientRef.current = null;
    if (client) await client.end().catch(() => {});
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      void teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pushMessage = useCallback((role: 'you' | 'bot', text: string) => {
    const id = `rtm_${Date.now().toString(36)}_${rtMsgSeq++}`;
    if (mountedRef.current) {
      setMessages((prev) => [...prev, { id, role, text, at: Date.now() }]);
    }
    return id;
  }, []);

  const appendToLastBot = useCallback(
    (text: string) => {
      if (!mountedRef.current) return;
      setMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last && last.role === 'bot') {
          next[next.length - 1] = { ...last, text: last.text + text };
        } else {
          next.push({ id: `rtm_${Date.now().toString(36)}_${rtMsgSeq++}`, role: 'bot', text, at: Date.now() });
        }
        return next;
      });
    },
    [],
  );

  const handleEvent = useCallback(
    (e: RealtimeClientEvent) => {
      if (!mountedRef.current) return;
      switch (e.type) {
        case 'connected':
          setPhase('live');
          setPath(e.path);
          setMaxMs(e.maxCallMs || 15 * 60 * 1000);
          callStartRef.current = Date.now();
          timerRef.current = setInterval(() => {
            if (mountedRef.current) setElapsed(Date.now() - callStartRef.current);
          }, 1000);
          break;
        case 'speech_started':
          setUserSpeaking(true);
          break;
        case 'speech_stopped':
          setUserSpeaking(false);
          break;
        case 'transcript':
          pushMessage('you', e.text);
          break;
        case 'reply_delta':
          appendToLastBot(e.text);
          break;
        case 'audio': {
          const player = playerRef.current;
          if (!player) break;
          if (e.sentence) appendToLastBot(e.sentence + ' ');
          if (e.pcm16) player.playPcm16(e.data, e.sampleRate ?? 24000);
          else void player.playEncoded(e.data, e.turnId);
          break;
        }
        case 'barge_in':
          // Stop the bot's audio instantly — the core of barge-in.
          try {
            playerRef.current?.stopAll();
          } catch {
            // ignore
          }
          setInterrupted(true);
          if (interruptTimerRef.current) clearTimeout(interruptTimerRef.current);
          interruptTimerRef.current = setTimeout(() => {
            if (mountedRef.current) setInterrupted(false);
          }, 2500);
          break;
        case 'latency':
          setLatencyMs(e.ms);
          break;
        case 'usage':
          setUsage(e.usage);
          break;
        case 'approval_required':
          setApprovalNotice(true);
          break;
        case 'turn_done':
          break;
        case 'error':
          setError(e.detail);
          setPhase('error');
          void teardown();
          break;
        case 'ended':
          void teardown().then(() => {
            if (mountedRef.current) onExit();
          });
          break;
      }
    },
    [appendToLastBot, pushMessage, teardown, onExit],
  );

  const startRealtime = useCallback(async () => {
    setError(null);
    setPhase('connecting');
    try {
      // echoCancellation is the client-side half of echo suppression; the
      // server never feeds its own output back into STT by construction.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (!mountedRef.current) {
        stream.getTracks().forEach((tr) => tr.stop());
        return;
      }
      streamRef.current = stream;
      const AC =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) throw new Error('Web Audio is not available in this browser');
      const ctx = new AC();
      try {
        await ctx.resume();
      } catch {
        // ignore
      }
      audioCtxRef.current = ctx;
      playerRef.current = new RealtimeAudioPlayer(ctx as unknown as AudioContextLike);

      // Continuous capture: ScriptProcessor is deprecated but universally
      // supported; chunks are downsampled to the 16kHz the server expects.
      const src = ctx.createMediaStreamSource(stream);
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      const inputRate = ctx.sampleRate;
      let pending = new Float32Array(0);
      proc.onaudioprocess = (ev: AudioProcessingEvent) => {
        const input = ev.inputBuffer.getChannelData(0);
        const down = downsampleToRate(input, inputRate, 16000);
        const merged = new Float32Array(pending.length + down.length);
        merged.set(pending, 0);
        merged.set(down, pending.length);
        pending = merged;
        const client = clientRef.current;
        // ~100ms PCM16 chunks to the server.
        while (pending.length >= 1600 && client) {
          try {
            client.sendPcm16(floatToPcm16(pending.slice(0, 1600)));
          } catch {
            break;
          }
          pending = pending.slice(1600);
        }
        // Safety: never let an unsent backlog grow unbounded.
        if (pending.length > 16000 * 5) pending = pending.slice(pending.length - 16000 * 5);
      };
      src.connect(proc);
      // ScriptProcessor only fires when connected downstream; a zero-gain
      // node keeps it alive without audible feedback.
      const mute = ctx.createGain();
      mute.gain.value = 0;
      proc.connect(mute);
      mute.connect(ctx.destination);
      procRef.current = proc;

      const client = new RealtimeCallClient(handleEvent);
      clientRef.current = client;
      await client.start(botId, {
        engine,
        ...(sttProvider ? { sttProvider } : {}),
        ...(ttsProvider ? { ttsProvider } : {}),
      });
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
      setPhase('error');
      await teardown();
    }
  }, [botId, engine, sttProvider, ttsProvider, handleEvent, teardown]);

  useEffect(() => {
    void startRealtime();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const timeLeft = Math.max(0, maxMs - elapsed);

  return (
    <div className="call-panel card" role="region" aria-label={t('call.title')}>
      <div className="row-between">
        <h3 style={{ margin: 0 }}>
          ⚡ {t('call.modeRealtime')}
          {botName ? <span className="small muted"> · {botName}</span> : null}
        </h3>
        <button type="button" className="btn btn-danger btn-sm" onClick={() => void teardown().then(onExit)}>
          {t('call.end')}
        </button>
      </div>

      <p className="small muted" style={{ marginTop: 8 }}>
        {t('call.realtimeJustTalk')}
        {path ? <span> · <code>{path}</code></span> : null}
      </p>

      <div className="call-status" aria-live="polite">
        <span className={`call-dot phase-${phase === 'live' ? (userSpeaking ? 'recording' : 'speaking') : 'quiet'}`} aria-hidden="true" />
        <strong>
          {phase === 'connecting'
            ? t('call.connecting')
            : interrupted
              ? t('call.realtimeInterrupted')
              : userSpeaking
                ? t('call.realtimeUserSpeaking')
                : t('call.realtimeWaiting')}
        </strong>
        <span className="small muted" style={{ marginLeft: 8 }}>
          {t('call.timeLeftLabel')}: {fmtDuration(timeLeft)}
        </span>
        {latencyMs !== null && (
          <span className="small muted" style={{ marginLeft: 8 }}>
            {t('call.latencyLabel')}: {latencyMs} ms
          </span>
        )}
        {usage && (
          <span className="small muted" style={{ marginLeft: 8 }} title={t('call.costLabel')}>
            {t('call.costLabel')}: {fmtUsd(usage.usdApprox)}
          </span>
        )}
      </div>

      {approvalNotice && (
        <div className="notice-box" role="status">
          {t('call.realtimeApproval')}
        </div>
      )}

      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      <div className="call-transcript" aria-label={t('voice.transcript')}>
        {messages.length === 0 && <p className="small muted">{t('call.empty')}</p>}
        {messages.map((m) => (
          <div key={m.id} className={`call-line ${m.role === 'you' ? 'you' : 'bot'}`}>
            <span className="call-speaker">{m.role === 'you' ? t('call.you') : (botName ?? t('call.bot'))}</span>
            <span className="call-text">{m.text}</span>
            <span className="call-time small muted">{fmtTime(m.at)}</span>
          </div>
        ))}
      </div>

      <p className="small muted" style={{ marginTop: 8 }}>
        {t('call.realtimeMaxed')}
      </p>
    </div>
  );
}

/** Play base64 audio; resolves when playback ends. */
function playAudio(data: string, mimeType: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const bin = atob(data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeType }));
    const el = new Audio(url);
    el.onended = () => {
      URL.revokeObjectURL(url);
      resolve();
    };
    el.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('call: audio playback failed'));
    };
    el.play().catch(reject);
  });
}

export default function CallPanel({ botId, botName, language, captureDeps, clientFactory }: CallPanelProps) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>('idle');
  const [mic, setMic] = useState<MicState>('quiet');
  const [turns, setTurns] = useState<VoiceCallTurn[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [providers, setProviders] = useState<VoiceCallProviderInfo[]>([]);
  const [sttProvider, setSttProvider] = useState('');
  const [ttsProvider, setTtsProvider] = useState('');
  const [autoVad, setAutoVad] = useState(false);
  const [approvalNotice, setApprovalNotice] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [mode, setMode] = useState<'standard' | 'realtime'>('standard');
  const [realtimeActive, setRealtimeActive] = useState(false);
  const [engines, setEngines] = useState<RealtimeEngineInfo[]>([]);
  const [engine, setEngine] = useState<'chunked' | 'openai-realtime'>('chunked');

  const clientRef = useRef<VoiceCallClient | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const vadRef = useRef<VadDetector | null>(null);
  const vadTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioQueueRef = useRef<Array<{ data: string; mimeType: string }>>([]);
  const playingRef = useRef(false);
  const callStartRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);
  const phaseRef = useRef<Phase>('idle');
  phaseRef.current = phase;
  const autoVadRef = useRef(false);
  autoVadRef.current = autoVad;
  const micRef = useRef<MicState>('quiet');
  micRef.current = mic;

  useEffect(() => {
    mountedRef.current = true;
    getVoiceCallProviders()
      .then((list) => {
        if (mountedRef.current) setProviders(list);
      })
      .catch(() => {
        // Providers are optional pre-call info; the start call will surface errors.
      });
    getRealtimeEngines()
      .then((list) => {
        if (mountedRef.current) setEngines(list);
      })
      .catch(() => {
        // Realtime engines are optional; standard mode still works.
      });
    return () => {
      mountedRef.current = false;
      void teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const teardown = useCallback(async () => {
    if (vadTimerRef.current) clearInterval(vadTimerRef.current);
    if (timerRef.current) clearInterval(timerRef.current);
    vadTimerRef.current = null;
    timerRef.current = null;
    try {
      recorderRef.current?.stream.getTracks().forEach((tr) => tr.stop());
    } catch {
      // ignore
    }
    try {
      streamRef.current?.getTracks().forEach((tr) => tr.stop());
    } catch {
      // ignore
    }
    try {
      await audioCtxRef.current?.close();
    } catch {
      // ignore
    }
    recorderRef.current = null;
    streamRef.current = null;
    analyserRef.current = null;
    audioCtxRef.current = null;
    vadRef.current = null;
    audioQueueRef.current = [];
    playingRef.current = false;
    const client = clientRef.current;
    clientRef.current = null;
    if (client) await client.end().catch(() => {});
  }, []);

  const pumpAudioQueue = useCallback(async () => {
    if (playingRef.current) return;
    const next = audioQueueRef.current.shift();
    if (!next) {
      if (mountedRef.current && phaseRef.current === 'live') setMic('quiet');
      return;
    }
    playingRef.current = true;
    if (mountedRef.current) setMic('speaking');
    try {
      await playAudio(next.data, next.mimeType);
    } catch {
      // Playback failure shouldn't kill the call.
    } finally {
      playingRef.current = false;
      void pumpAudioQueue();
    }
  }, []);

  const handleEvent = useCallback(
    (e: CallClientEvent) => {
      if (!mountedRef.current) return;
      switch (e.type) {
        case 'connected':
          setPhase('live');
          setMic('quiet');
          callStartRef.current = Date.now();
          timerRef.current = setInterval(() => {
            if (mountedRef.current) setElapsed(Date.now() - callStartRef.current);
          }, 1000);
          break;
        case 'transcript':
          setMic('thinking');
          setTurns((prev) => [
            ...prev,
            { id: VoiceCallClient.nextTurnId(), at: Date.now(), transcript: e.text, replyText: '' },
          ]);
          break;
        case 'reply':
          setTurns((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last) next[next.length - 1] = { ...last, replyText: e.text };
            return next;
          });
          break;
        case 'audio':
          audioQueueRef.current.push({ data: e.data, mimeType: e.mimeType });
          void pumpAudioQueue();
          break;
        case 'approval_required':
          setApprovalNotice(true);
          setTurns((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last) next[next.length - 1] = { ...last, approvalId: e.approvalId };
            return next;
          });
          break;
        case 'turn_done':
          if (phaseRef.current === 'live' && !playingRef.current) setMic('quiet');
          break;
        case 'error':
          setError(e.detail);
          void teardown();
          break;
        case 'ended':
          setPhase('idle');
          setMic('quiet');
          void teardown();
          break;
      }
    },
    [pumpAudioQueue, teardown],
  );

  /** Stop the current recorder and send the utterance to the server. */
  const stopAndSend = useCallback(async () => {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (!recorder) {
      setMic('quiet');
      return;
    }
    setMic('thinking');
    try {
      // finalizeRecording reads the chunk array at onstop-time; see its doc.
      const blob: Blob = await finalizeRecording(recorder, chunksRef);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (bytes.length === 0) {
        setMic('quiet');
        return;
      }
      clientRef.current?.sendUtterance(bytesToBase64(bytes), blob.type || 'audio/webm');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setMic('quiet');
    }
  }, []);

  /** Start a fresh recorder on the live mic stream. */
  const startRecording = useCallback(async (): Promise<boolean> => {
    const stream = streamRef.current;
    if (!stream) return false;
    try {
      const deps = captureDeps ?? browserCaptureDeps();
      const recorder = deps.createRecorder(stream) as unknown as MediaRecorder;
      chunksRef.current = [];
      recorder.ondataavailable = (ev: BlobEvent) => {
        const data = (ev as unknown as { data?: Blob }).data;
        if (data && data.size > 0) chunksRef.current.push(data);
      };
      recorder.start();
      recorderRef.current = recorder;
      setMic('recording');
      return true;
    } catch {
      return false;
    }
  }, [captureDeps]);

  /** VAD poll loop: analyser frames → VadDetector → auto start/stop. */
  const startVadLoop = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const buf = new Float32Array(analyser.fftSize);
    vadRef.current = new VadDetector((ev) => {
      if (!mountedRef.current || !autoVadRef.current || phaseRef.current !== 'live') return;
      if (ev === 'speechstart') {
        if (!recorderRef.current && micRef.current === 'quiet') void startRecording();
      } else {
        if (recorderRef.current) void stopAndSend();
      }
    });
    vadTimerRef.current = setInterval(() => {
      const vad = vadRef.current;
      if (!vad) return;
      try {
        analyser.getFloatTimeDomainData(buf);
        vad.feed(buf);
      } catch {
        // analyser torn down
      }
    }, 33);
  }, [startRecording, stopAndSend]);

  const startCall = useCallback(async () => {
    setError(null);
    setApprovalNotice(false);
    setTurns([]);
    setElapsed(0);
    setPhase('connecting');
    try {
      const deps = captureDeps ?? browserCaptureDeps();
      const stream = await deps.getUserMedia({ audio: true });
      if (!mountedRef.current) {
        stream.getTracks().forEach((tr) => tr.stop());
        return;
      }
      streamRef.current = stream;
      // Analyser for the auto-VAD level meter (also useful as a mic check).
      try {
        const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (AC) {
          const ctx = new AC();
          audioCtxRef.current = ctx;
          const src = ctx.createMediaStreamSource(stream);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 2048;
          src.connect(analyser);
          analyserRef.current = analyser;
        }
      } catch {
        // VAD level unavailable — tap-to-talk still works.
      }
      const client = clientFactory
        ? clientFactory(handleEvent)
        : new VoiceCallClient(handleEvent);
      clientRef.current = client;
      await client.start(botId, {
        ...(sttProvider ? { sttProvider } : {}),
        ...(ttsProvider ? { ttsProvider } : {}),
      });
      if (autoVadRef.current && analyserRef.current) startVadLoop();
    } catch (err) {
      if (!mountedRef.current) return;
      const detail = err instanceof Error ? err.message : String(err);
      setError(t('call.startFailed').replace('{detail}', detail));
      setPhase('error');
      await teardown();
    }
  }, [botId, sttProvider, ttsProvider, captureDeps, clientFactory, handleEvent, startVadLoop, t, teardown]);

  const endCall = useCallback(() => {
    void teardown().then(() => {
      if (mountedRef.current) {
        setPhase('idle');
        setMic('quiet');
      }
    });
  }, [teardown]);

  const tapMic = useCallback(() => {
    if (phase !== 'live') return;
    if (autoVadRef.current) return; // VAD drives the mic
    if (mic === 'recording') void stopAndSend();
    else if (mic === 'quiet') void startRecording();
  }, [phase, mic, startRecording, stopAndSend]);

  const phaseLabel =
    phase === 'connecting'
      ? t('call.connecting')
      : mic === 'recording'
        ? t('call.listening')
        : mic === 'thinking'
          ? t('call.thinking')
          : mic === 'speaking'
            ? t('call.speaking')
            : null;

  const configuredProviders = providers.filter((p) => p.configured);
  const availableEngines = engines.filter((e) => e.available);

  // Realtime (speech-to-speech) mode owns its own lifecycle.
  if (realtimeActive) {
    return (
      <RealtimeCallView
        botId={botId}
        botName={botName}
        engine={engine}
        sttProvider={sttProvider || undefined}
        ttsProvider={ttsProvider || undefined}
        onExit={() => {
          setRealtimeActive(false);
          setPhase('idle');
          setMic('quiet');
        }}
      />
    );
  }

  return (
    <div className="call-panel card" role="region" aria-label={t('call.title')}>
      <div className="row-between">
        <h3 style={{ margin: 0 }}>
          📞 {t('call.title')}
          {botName ? <span className="small muted"> · {botName}</span> : null}
        </h3>
        {phase === 'live' || phase === 'connecting' ? (
          <button type="button" className="btn btn-danger btn-sm" onClick={endCall}>
            {t('call.end')}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => {
              if (mode === 'realtime') {
                setError(null);
                setRealtimeActive(true);
              } else {
                void startCall();
              }
            }}
          >
            {t('call.start')}
          </button>
        )}
      </div>

      {phase === 'idle' && (
        <>
          <p className="small muted" style={{ marginTop: 8 }}>
            {t('call.idleHint')}
          </p>
          <div className="call-providers" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 8 }}>
            <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="radio"
                name="call-mode"
                checked={mode === 'standard'}
                onChange={() => setMode('standard')}
              />
              {t('call.modeStandard')}
            </label>
            <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="radio"
                name="call-mode"
                checked={mode === 'realtime'}
                onChange={() => setMode('realtime')}
                disabled={availableEngines.length === 0}
              />
              {t('call.modeRealtime')}
            </label>
          </div>
          <p className="small muted" style={{ marginTop: 4 }}>
            {t('call.modeHint')}
          </p>
          {mode === 'realtime' && (
            <div className="call-providers" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 8 }}>
              <label className="small">
                {t('call.engineLabel')}:{' '}
                <select
                  value={engine}
                  onChange={(e) => setEngine(e.target.value as 'chunked' | 'openai-realtime')}
                  aria-label={t('call.engineLabel')}
                >
                  {engines.map((e) => (
                    <option key={e.id} value={e.id} disabled={!e.available}>
                      {e.label}
                      {e.available ? '' : ` — ${t('call.providerUnconfigured')}`}
                    </option>
                  ))}
                </select>
              </label>
              <span className="small muted">
                {engine === 'openai-realtime' ? t('call.engineRealtimeHint') : t('call.engineChunkedHint')}
              </span>
            </div>
          )}
          {mode === 'standard' && (
          <>
          <div className="call-providers" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 8 }}>
            <label className="small">
              {t('call.providerStt')}:{' '}
              <select value={sttProvider} onChange={(e) => setSttProvider(e.target.value)} aria-label={t('call.providerStt')}>
                <option value="">Auto (bot default)</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id} disabled={!p.configured}>
                    {p.label}
                    {p.configured ? '' : ` — ${t('call.providerUnconfigured')}`}
                  </option>
                ))}
              </select>
            </label>
            <label className="small">
              {t('call.providerTts')}:{' '}
              <select value={ttsProvider} onChange={(e) => setTtsProvider(e.target.value)} aria-label={t('call.providerTts')}>
                <option value="">Auto (bot default)</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id} disabled={!p.configured}>
                    {p.label}
                    {p.configured ? '' : ` — ${t('call.providerUnconfigured')}`}
                  </option>
                ))}
              </select>
            </label>
            <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={autoVad} onChange={(e) => setAutoVad(e.target.checked)} />
              {t('call.autoVad')}
            </label>
          </div>
          {configuredProviders.length === 1 && configuredProviders[0].id === 'mock' && (
            <p className="small muted" style={{ marginTop: 8 }}>
              {t('call.idleHint')}
            </p>
          )}
          </>
          )}
        </>
      )}

      {(phase === 'live' || phase === 'connecting') && (
        <>
          <div className="call-status" aria-live="polite">
            <span className={`call-dot phase-${mic}`} aria-hidden="true" />
            <strong>{phaseLabel ?? (autoVad ? t('call.autoVadHint') : t('call.tapToTalk'))}</strong>
            <span className="small muted" style={{ marginLeft: 8 }}>
              {t('call.callDuration')}: {fmtDuration(elapsed)}
            </span>
          </div>

          <div className="call-controls">
            <button
              type="button"
              className={`btn ${mic === 'recording' ? 'btn-danger' : 'btn-primary'} mic-big${mic === 'recording' ? ' recording' : ''}`}
              onClick={tapMic}
              disabled={phase !== 'live' || autoVad || mic === 'thinking' || mic === 'speaking'}
              aria-pressed={mic === 'recording'}
              title={autoVad ? t('call.autoVadHint') : undefined}
            >
              {mic === 'recording' ? t('call.stopAndSend') : t('call.tapToTalk')}
            </button>
          </div>

          {approvalNotice && (
            <div className="notice-box" role="status">
              {t('call.approvalWaiting')}
            </div>
          )}

          {error && (
            <div className="error-box" role="alert">
              {error}
            </div>
          )}

          <div className="call-transcript" aria-label={t('voice.transcript')}>
            {turns.length === 0 && <p className="small muted">{t('call.empty')}</p>}
            {turns.map((turn) => (
              <div key={turn.id} className="call-turn">
                <div className="call-line you">
                  <span className="call-speaker">{t('call.you')}</span>
                  <span className="call-text">{turn.transcript}</span>
                  <span className="call-time small muted">{fmtTime(turn.at)}</span>
                </div>
                {turn.replyText ? (
                  <div className="call-line bot">
                    <span className="call-speaker">{botName ?? t('call.bot')}</span>
                    <span className="call-text">{turn.replyText}</span>
                  </div>
                ) : (
                  <div className="call-line bot">
                    <span className="typing-dots" aria-label={t('call.thinking')}>
                      <i />
                      <i />
                      <i />
                    </span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {phase === 'error' && error && (
        <div className="error-box" role="alert" style={{ marginTop: 8 }}>
          {error}
        </div>
      )}
    </div>
  );
}
