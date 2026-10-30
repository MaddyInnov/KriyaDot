// SPDX-License-Identifier: Apache-2.0
'use client';

/**
 * Layers editor (#41, Bots destination): edits BotConfig.layers — the
 * staged orchestration pipeline around a bot's main turn. Each stage has
 * a kind (prepare/review), a role, a model (+ optional provider), an
 * input mode, an output mode and a prompt.
 *
 * Save path: PUT /api/bots/:id/layers {layers} (the per-field bot
 * settings pattern used by /persona, /model, /voice). There is NO
 * generic bot-update endpoint in the API today, and the per-field
 * endpoints whitelist their own field — so if the layers route has not
 * landed, the save fails with the route's 404 shown verbatim below
 * rather than silently dropping the stages.
 */
import { useEffect, useState } from 'react';
import type { BotConfig } from '../../lib/api';
import { setBotLayers, type LayerStage } from '../../lib/octomind-api';

const KINDS = ['prepare', 'review'] as const;
const INPUT_MODES = [
  { value: '', label: 'Default for kind' },
  { value: 'user', label: 'User message' },
  { value: 'draft', label: 'Draft answer' },
  { value: 'user+draft', label: 'User message + draft answer' },
] as const;
const OUTPUT_MODES = [
  { value: '', label: 'Fixed by kind (legacy default)' },
  { value: 'replace', label: 'Replace (stage output replaces its input)' },
  { value: 'augment', label: 'Augment (stage output is added as context)' },
  { value: 'advise', label: 'Advise only (never replaces the answer)' },
] as const;

function blankStage(n: number): LayerStage {
  return { name: `stage-${n}`, kind: n === 1 ? 'prepare' : 'review', prompt: '', inputMode: '', outputMode: '' };
}

export function LayersEditor({
  bot,
  onSaved,
}: {
  bot: BotConfig;
  onSaved: (botId: string, layers: LayerStage[]) => void;
}) {
  const [stages, setStages] = useState<LayerStage[]>(() => bot.layers ?? []);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setStages(bot.layers ?? []);
    setError('');
    setNote('');
  }, [bot.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const setStage = (idx: number, patch: Partial<LayerStage>) =>
    setStages((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));

  const save = async () => {
    setError('');
    setNote('');
    const cleaned: LayerStage[] = [];
    const names = new Set<string>();
    for (const s of stages) {
      if (!s.name.trim()) { setError('Every stage needs a name.'); return; }
      if (names.has(s.name.trim())) { setError(`Duplicate stage name "${s.name.trim()}".`); return; }
      names.add(s.name.trim());
      cleaned.push({
        name: s.name.trim(),
        kind: s.kind || 'prepare',
        prompt: s.prompt ?? '',
        ...(s.role?.trim() ? { role: s.role.trim() } : {}),
        ...(s.model?.trim() ? { model: s.model.trim() } : {}),
        ...(s.providerId?.trim() ? { providerId: s.providerId.trim() } : {}),
        ...(s.inputMode ? { inputMode: s.inputMode } : {}),
        ...(s.outputMode ? { outputMode: s.outputMode } : {}),
      });
    }
    setSaving(true);
    try {
      const res = await setBotLayers(bot.id, cleaned);
      const saved = res.layers ?? cleaned;
      setStages(saved);
      onSaved(bot.id, saved);
      setNote(`Saved via ${res.via} at ${new Date().toLocaleTimeString()}.`);
    } catch (err) {
      setError(
        `Could not save layers: ${err instanceof Error ? err.message : String(err)} ` +
          'If this is a 404, the API does not accept BotConfig.layers yet — there is no generic ' +
          'bot-update endpoint, and the other per-field endpoints drop unknown fields, so the ' +
          'stages cannot be persisted from the web until PUT /api/bots/:id/layers lands.',
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h3 style={{ marginTop: 0 }}>Layers — staged orchestration</h3>
      <p className="small muted">
        Stages run around this bot&apos;s main turn: <strong>prepare</strong> stages shape the
        request before the loop; <strong>review</strong> stages see the draft answer and may
        revise it. Each stage can carry its own role, model, input mode and output mode.
        No stages → single-stage turns (previous behaviour).
      </p>
      {stages.length === 0 && <p className="small muted">No layers configured for {bot.name}.</p>}
      {stages.map((s, i) => (
        <div key={i} className="card" style={{ marginBottom: 10, padding: '12px 14px' }}>
          <div className="grid-2">
            <div className="field">
              <label className="label">Stage name</label>
              <input className="input mono" value={s.name} onChange={(e) => setStage(i, { name: e.target.value })} placeholder="prepare-context" />
            </div>
            <div className="field">
              <label className="label">Kind</label>
              <select className="select" value={s.kind} onChange={(e) => setStage(i, { kind: e.target.value })}>
                {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </div>
            <div className="field">
              <label className="label">Role (optional)</label>
              <input className="input" value={s.role ?? ''} onChange={(e) => setStage(i, { role: e.target.value })} placeholder="e.g. fact-checker" />
            </div>
            <div className="field">
              <label className="label">Model (optional — default: turn model)</label>
              <input className="input mono" value={s.model ?? ''} onChange={(e) => setStage(i, { model: e.target.value })} placeholder="model id" />
            </div>
            <div className="field">
              <label className="label">Provider id (optional)</label>
              <input className="input mono" value={s.providerId ?? ''} onChange={(e) => setStage(i, { providerId: e.target.value })} placeholder="provider id" />
            </div>
            <div className="field">
              <label className="label">Input mode</label>
              <select className="select" value={s.inputMode ?? ''} onChange={(e) => setStage(i, { inputMode: e.target.value })}>
                {INPUT_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>
            <div className="field">
              <label className="label">Output mode</label>
              <select className="select" value={s.outputMode ?? ''} onChange={(e) => setStage(i, { outputMode: e.target.value })}>
                {OUTPUT_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>
          </div>
          <div className="field">
            <label className="label">Stage prompt</label>
            <textarea className="textarea" rows={3} value={s.prompt ?? ''} onChange={(e) => setStage(i, { prompt: e.target.value })} placeholder="What this stage should do…" />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn btn-sm" disabled={i === 0} onClick={() => setStages((p) => { const n = [...p]; [n[i - 1], n[i]] = [n[i]!, n[i - 1]!]; return n; })}>↑ Move up</button>
            <button type="button" className="btn btn-sm" disabled={i === stages.length - 1} onClick={() => setStages((p) => { const n = [...p]; [n[i + 1], n[i]] = [n[i]!, n[i + 1]!]; return n; })}>↓ Move down</button>
            <button type="button" className="btn btn-danger btn-sm" onClick={() => setStages((p) => p.filter((_, j) => j !== i))}>Remove stage</button>
          </div>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-sm" onClick={() => setStages((p) => [...p, blankStage(p.length + 1)])}>Add stage</button>
        <button type="button" className="btn btn-primary btn-sm" disabled={saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save layers'}
        </button>
        {note && <span className="small muted">{note}</span>}
      </div>
      {error && <div className="error-box" style={{ marginTop: 8 }}>{error}</div>}
    </div>
  );
}
