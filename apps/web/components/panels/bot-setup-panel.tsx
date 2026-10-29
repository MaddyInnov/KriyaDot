// SPDX-License-Identifier: Apache-2.0
'use client';

// "Set me up" (W12a): describe a bot in ONE sentence → the setup turn
// proposes a full config → ONE approval card → on approve, the bot and
// its suggested routines are created. Nothing exists before approval;
// discarding the proposal creates nothing (there is no server-side
// proposal state).

import React, { useState } from 'react';
import { kriyadotFetch } from '../../lib/kriyadot-api';

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await kriyadotFetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers || {}) },
  });
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new Error(body?.error || `${res.status} ${res.statusText}`);
  return body as T;
}

export interface BotSetupRoutineProposal {
  name: string;
  promptTemplate: string;
  schedule?: { kind: string; timezone?: string } & Record<string, unknown>;
  scheduleError?: string;
}

export interface BotSetupProposalView {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  persona?: string;
  provider: string;
  model: string;
  tools: string[];
  skills: string[];
  mcpServers: string[];
  routines: BotSetupRoutineProposal[];
  sourceSentence: string;
  droppedTools: string[];
  droppedMcpServers: string[];
}

interface ApplyResult {
  ok: boolean;
  bot: { id: string; name: string };
  routines: Array<{ id: string; name: string }>;
  skippedRoutines: Array<{ name: string; reason: string }>;
}

export function BotSetupPanel({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const [sentence, setSentence] = useState('');
  const [proposal, setProposal] = useState<BotSetupProposalView | null>(null);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'propose' | 'apply' | null>(null);

  const propose = async () => {
    setBusy('propose');
    setError(null);
    setResult(null);
    try {
      const res = await api<{ ok: boolean; proposal: BotSetupProposalView }>('/api/bots/setup/propose', {
        method: 'POST',
        body: JSON.stringify({ sentence: sentence.trim() }),
      });
      setProposal(res.proposal);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'proposal failed');
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    if (!proposal) return;
    setBusy('apply');
    setError(null);
    try {
      const res = await api<ApplyResult>('/api/bots/setup/apply', {
        method: 'POST',
        body: JSON.stringify({ proposal }),
      });
      setResult(res);
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'create failed');
    } finally {
      setBusy(null);
    }
  };

  const discard = () => {
    setProposal(null);
    setResult(null);
    setError(null);
    onCancel();
  };

  return (
    <div className="card bot-setup-panel">
      <div className="row-between">
        <strong>✨ Set me up — a new bot from one sentence</strong>
        <button type="button" className="btn btn-sm" onClick={discard}>
          Close
        </button>
      </div>
      <p className="small muted">
        Describe the bot you need. KriyaDot drafts a full configuration — name, instructions, tools,
        and routines — and shows it to you as one proposal. <strong>Nothing is created</strong> until
        you approve it.
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input
          className="input"
          style={{ flex: 1, minWidth: 260 }}
          placeholder="e.g. I need a bot that watches my Gmail and drafts replies every morning"
          value={sentence}
          onChange={(e) => setSentence(e.target.value)}
          aria-label="Describe your bot in one sentence"
        />
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy !== null || !sentence.trim()}
          onClick={() => void propose()}
        >
          {busy === 'propose' ? 'Drafting…' : 'Draft my bot'}
        </button>
      </div>
      {error && <div className="error-box" style={{ marginTop: 8 }}>{error}</div>}

      {proposal && !result && (
        <div className="bot-setup-proposal" style={{ marginTop: 12 }} role="group" aria-label="Proposed bot configuration">
          <h3 style={{ margin: '0 0 4px' }}>
            {proposal.name} <span className="small muted mono">{proposal.id}</span>
          </h3>
          {proposal.description && <p className="small" style={{ margin: '0 0 8px' }}>{proposal.description}</p>}
          <div className="small muted">
            {proposal.provider}/{proposal.model}
            {proposal.persona ? ` · persona ${proposal.persona}` : ''}
          </div>
          <h4 style={{ margin: '12px 0 4px' }}>Instructions</h4>
          <pre className="mono small" style={{ whiteSpace: 'pre-wrap', maxHeight: 160, overflow: 'auto' }}>
            {proposal.systemPrompt}
          </pre>
          <h4 style={{ margin: '12px 0 4px' }}>Tools ({proposal.tools.length})</h4>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {proposal.tools.map((t) => (
              <span key={t} className="chip mono">{t}</span>
            ))}
            {proposal.tools.length === 0 && <span className="small muted">No tools selected.</span>}
          </div>
          {proposal.droppedTools.length > 0 && (
            <p className="small muted">
              Not available, so left out: {proposal.droppedTools.join(', ')}
            </p>
          )}
          {proposal.skills.length > 0 && (
            <>
              <h4 style={{ margin: '12px 0 4px' }}>Skills</h4>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {proposal.skills.map((s) => (
                  <span key={s} className="chip mono">{s}</span>
                ))}
              </div>
            </>
          )}
          {proposal.mcpServers.length > 0 && (
            <>
              <h4 style={{ margin: '12px 0 4px' }}>Connected apps / MCP servers</h4>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {proposal.mcpServers.map((s) => (
                  <span key={s} className="chip mono">{s}</span>
                ))}
              </div>
            </>
          )}
          {proposal.droppedMcpServers.length > 0 && (
            <p className="small muted">
              Not configured here, so left out: {proposal.droppedMcpServers.join(', ')}
            </p>
          )}
          <h4 style={{ margin: '12px 0 4px' }}>Routines ({proposal.routines.length})</h4>
          {proposal.routines.length === 0 && <p className="small muted">No routines suggested.</p>}
          {proposal.routines.map((r, i) => (
            <div key={i} className="small" style={{ marginBottom: 6 }}>
              <strong>{r.name}</strong>{' '}
              <span className="muted">
                {r.schedule ? `· schedule: ${r.schedule.kind}` : '· manual / webhook only'}
                {r.scheduleError ? `· suggested schedule invalid (${r.scheduleError}) — will be created unscheduled` : ''}
              </span>
              <div className="mono" style={{ whiteSpace: 'pre-wrap' }}>{r.promptTemplate}</div>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={() => void apply()}>
              {busy === 'apply' ? 'Creating…' : `Approve — create ${proposal.name}${proposal.routines.length ? ` + ${proposal.routines.length} routine${proposal.routines.length === 1 ? '' : 's'}` : ''}`}
            </button>
            <button type="button" className="btn btn-danger" disabled={busy !== null} onClick={discard}>
              Discard — create nothing
            </button>
          </div>
        </div>
      )}

      {result && (
        <div className="small" style={{ marginTop: 12 }} role="status">
          <p>
            ✅ Created <strong>{result.bot.name}</strong> (<span className="mono">{result.bot.id}</span>)
            {result.routines.length > 0 &&
              ` with routine${result.routines.length === 1 ? '' : 's'}: ${result.routines.map((r) => r.name).join(', ')}`}
            .
          </p>
          {result.skippedRoutines.length > 0 && (
            <p className="muted">
              Skipped routines: {result.skippedRoutines.map((s) => `${s.name} (${s.reason})`).join('; ')}
            </p>
          )}
          <button type="button" className="btn btn-sm" onClick={discard}>
            Done
          </button>
        </div>
      )}
    </div>
  );
}
