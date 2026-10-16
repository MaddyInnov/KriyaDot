// SPDX-License-Identifier: Apache-2.0
// Per-bot voice-call settings (Codync parity: realtime voice calls).
// Lives in the bot editor's Model tab, under the model picker.

'use client';

import React from 'react';

import { useEffect, useState } from 'react';
import { useI18n } from '../../lib/i18n';
import {
  getVoiceCallProviders,
  type VoiceCallProviderInfo,
} from '../../lib/voice-call-client';
import { setBotVoice, type BotConfig, type VoiceSettings } from '../../lib/api';

export interface VoiceSettingsPanelProps {
  bot: BotConfig;
  onSaved: (botId: string, voice: VoiceSettings) => void;
}

const PROVIDER_IDS = ['mock', 'groq', 'openai'] as const;

export default function VoiceSettingsPanel({ bot, onSaved }: VoiceSettingsPanelProps) {
  const { t } = useI18n();
  const [providers, setProviders] = useState<VoiceCallProviderInfo[]>([]);
  const [stt, setStt] = useState<string>(bot.voice?.sttProvider ?? 'mock');
  const [tts, setTts] = useState<string>(bot.voice?.ttsProvider ?? 'mock');
  const [ttsVoice, setTtsVoice] = useState(bot.voice?.ttsVoice ?? '');
  const [autoVad, setAutoVad] = useState(bot.voice?.autoVad ?? false);
  const [sensitivity, setSensitivity] = useState(bot.voice?.vadSensitivity ?? 5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setStt(bot.voice?.sttProvider ?? 'mock');
    setTts(bot.voice?.ttsProvider ?? 'mock');
    setTtsVoice(bot.voice?.ttsVoice ?? '');
    setAutoVad(bot.voice?.autoVad ?? false);
    setSensitivity(bot.voice?.vadSensitivity ?? 5);
    setSaved(false);
    setError('');
  }, [bot.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    getVoiceCallProviders()
      .then(setProviders)
      .catch(() => setProviders([]));
  }, []);

  const configured = (id: string): boolean => providers.find((p) => p.id === id)?.configured ?? id === 'mock';

  const save = async () => {
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      const voice: VoiceSettings = {
        sttProvider: stt as VoiceSettings['sttProvider'],
        ttsProvider: tts as VoiceSettings['ttsProvider'],
        ...(ttsVoice.trim() ? { ttsVoice: ttsVoice.trim() } : {}),
        autoVad,
        vadSensitivity: sensitivity,
      };
      const res = await setBotVoice(bot.id, voice);
      onSaved(bot.id, res.voice ?? voice);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const providerLabel = (id: string): string => {
    const info = providers.find((p) => p.id === id);
    const label = info?.label ?? id;
    return configured(id) ? label : `${label} (${t('bots.voiceUnavailable')})`;
  };

  return (
    <div className="voice-settings card" style={{ marginTop: 16 }}>
      <h4 style={{ margin: '0 0 4px' }}>🎙 {t('bots.voiceTitle')}</h4>
      <p className="small muted" style={{ marginTop: 0 }}>
        {t('bots.voiceSubtitle')}
      </p>
      <div style={{ display: 'grid', gap: 12, maxWidth: 520 }}>
        <label className="small">
          {t('bots.voiceStt')}
          <select
            value={stt}
            onChange={(e) => setStt(e.target.value)}
            style={{ display: 'block', marginTop: 4, width: '100%' }}
            aria-label={t('bots.voiceStt')}
          >
            {PROVIDER_IDS.map((id) => (
              <option key={id} value={id} disabled={!configured(id)}>
                {providerLabel(id)}
              </option>
            ))}
          </select>
        </label>
        <label className="small">
          {t('bots.voiceTts')}
          <select
            value={tts}
            onChange={(e) => setTts(e.target.value)}
            style={{ display: 'block', marginTop: 4, width: '100%' }}
            aria-label={t('bots.voiceTts')}
          >
            {PROVIDER_IDS.map((id) => (
              <option key={id} value={id} disabled={!configured(id)}>
                {providerLabel(id)}
              </option>
            ))}
          </select>
        </label>
        <label className="small">
          {t('bots.voiceTtsVoice')}
          <input
            type="text"
            value={ttsVoice}
            onChange={(e) => setTtsVoice(e.target.value)}
            placeholder="alloy"
            maxLength={120}
            style={{ display: 'block', marginTop: 4, width: '100%' }}
            aria-label={t('bots.voiceTtsVoice')}
          />
          <span className="muted">{t('bots.voiceTtsVoiceHint')}</span>
        </label>
        <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" checked={autoVad} onChange={(e) => setAutoVad(e.target.checked)} />
          <span>
            {t('bots.voiceAutoVad')}
            <br />
            <span className="muted">{t('bots.voiceAutoVadHint')}</span>
          </span>
        </label>
        <label className="small">
          {t('bots.voiceSensitivity')}: {sensitivity}
          <input
            type="range"
            min={1}
            max={10}
            step={1}
            value={sensitivity}
            onChange={(e) => setSensitivity(Number(e.target.value))}
            style={{ display: 'block', width: '100%' }}
            aria-label={t('bots.voiceSensitivity')}
          />
        </label>
      </div>
      {error && (
        <div className="error-box" role="alert" style={{ marginTop: 12 }}>
          {error}
        </div>
      )}
      {saved && (
        <p className="small" role="status" style={{ color: 'var(--success, green)' }}>
          {t('bots.voiceSaved')}
        </p>
      )}
      <button type="button" className="btn btn-primary btn-sm" onClick={() => void save()} disabled={busy} style={{ marginTop: 8 }}>
        {busy ? t('common.loading') : t('bots.voiceSave')}
      </button>
    </div>
  );
}
