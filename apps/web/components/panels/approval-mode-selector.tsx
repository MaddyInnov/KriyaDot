// SPDX-License-Identifier: Apache-2.0
// Per-bot approval mode selector (Atomic parity): plan / auto / bypass.
//
// 'bypass' is dangerous — it requires an explicit scary confirmation and
// shows a persistent warning. The catastrophic-command denylist still
// applies at the tool floor regardless of mode.
'use client';

import { useEffect, useState } from 'react';
import { setBotApprovalMode, type ApprovalMode, type BotConfig } from '../../lib/api';

const MODES: Array<{ id: ApprovalMode; label: string; blurb: string; danger?: boolean }> = [
  {
    id: 'plan',
    label: 'Plan approval',
    blurb: 'The agent presents a step-by-step plan and waits for your approval before acting.',
  },
  {
    id: 'auto',
    label: 'Automatic',
    blurb: 'Low-risk actions proceed under policy; risky actions still ask for approval.',
  },
  {
    id: 'acceptEdits',
    label: 'Accept edits',
    blurb: 'File edits and safe filesystem commands proceed automatically; anything else still asks for approval.',
  },
  {
    id: 'dontAsk',
    label: "Don't ask",
    blurb: 'Anything that would need approval is denied instead. Only explicitly allowed actions proceed.',
  },
  {
    id: 'bypass',
    label: 'Bypass (dangerous)',
    blurb: 'All approvals are auto-granted. Use only for fully trusted automation.',
    danger: true,
  },
];

export function ApprovalModeSelector({
  bot,
  onSaved,
}: {
  bot: BotConfig;
  onSaved: (botId: string, mode: ApprovalMode) => void;
}) {
  const [mode, setMode] = useState<ApprovalMode>(bot.approvalMode ?? 'auto');
  const [confirmBypass, setConfirmBypass] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState('');

  useEffect(() => {
    setMode(bot.approvalMode ?? 'auto');
    setConfirmBypass(false);
    setError('');
    setSavedAt('');
  }, [bot.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setError('');
    if (mode === 'bypass' && !confirmBypass) {
      setError('Bypass mode is dangerous — tick the confirmation to enable it.');
      return;
    }
    setSaving(true);
    try {
      const res = await setBotApprovalMode(bot.id, mode);
      setSavedAt(new Date().toLocaleTimeString());
      onSaved(bot.id, res.approvalMode);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="row-between">
        <strong>Approval mode — {bot.name}</strong>
        <span className="small muted mono">{bot.id}</span>
      </div>
      <p className="small muted">
        How this bot handles actions that need approval. <strong>Automatic</strong> is the default.
      </p>
      <div className="field">
        <label className="label">Mode</label>
        <select
          className="input"
          value={mode}
          onChange={(e) => {
            setMode(e.target.value as ApprovalMode);
            setConfirmBypass(false);
          }}
        >
          {MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </div>
      <p className="small muted" style={{ marginTop: 8 }}>
        {MODES.find((m) => m.id === mode)?.blurb}
      </p>
      {mode === 'bypass' && (
        <div
          className="card"
          style={{
            marginTop: 8,
            border: '2px solid var(--danger, #d33)',
            background: 'color-mix(in srgb, var(--danger, #d33) 8%, transparent)',
          }}
        >
          <strong style={{ color: 'var(--danger, #d33)' }}>⚠️ Dangerous mode</strong>
          <p className="small" style={{ margin: '8px 0' }}>
            In bypass mode this bot will execute <strong>any</strong> action without asking —
            file writes, shell commands, everything the tools allow. Only enable it for bots
            you fully trust, in workspaces you can afford to lose. The catastrophic-command
            denylist (e.g. <span className="mono">rm -rf /</span>) still applies and cannot be
            bypassed.
          </p>
          <label className="small" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={confirmBypass}
              onChange={(e) => setConfirmBypass(e.target.checked)}
            />
            I understand the risk and want bypass mode for this bot.
          </label>
        </div>
      )}
      {error && (
        <p className="small" style={{ color: 'var(--danger, #d33)' }}>
          {error}
        </p>
      )}
      <div className="row-between" style={{ marginTop: 8 }}>
        <button className="btn" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save approval mode'}
        </button>
        {savedAt && <span className="small muted">Saved {savedAt}</span>}
      </div>
    </div>
  );
}
