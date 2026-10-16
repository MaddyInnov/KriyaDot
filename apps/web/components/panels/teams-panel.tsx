// SPDX-License-Identifier: Apache-2.0
'use client';

// Chief of Staff — Teams section (under Bots). Shows the chief card
// (current chief + Make/Remove chief), the team roster (👑 badge on the
// chief), the pending proposals inbox (approve/reject with operation
// summaries), and the incidents/escalations inbox (kind badges, resolve,
// retry via POST /incidents/:id/retry).

import React, { useCallback, useEffect, useState } from 'react';
import {
  approveChiefProposal,
  getChief,
  listChiefIncidents,
  listChiefProposals,
  rejectChiefProposal,
  resolveChiefIncident,
  retryChiefIncident,
  setChief,
  setChiefSections,
  type BotConfig,
  type ChiefIncidentDto,
  type ChiefInfo,
  type ChiefProposalDto,
  type ChiefProposalOpDto,
} from '../../lib/api';

const KIND_CHIP: Record<ChiefIncidentDto['kind'], string> = {
  incident: 'chip red',
  escalation: 'chip amber',
};

const STATUS_CHIP: Record<ChiefIncidentDto['status'], string> = {
  open: 'chip red',
  triaged: 'chip amber',
  resolved: 'chip green',
};

/** One-line summary of a proposal operation (exported for tests). */
export function opSummary(op: ChiefProposalOpDto): string {
  const fields = op.fields ?? {};
  const name =
    typeof fields.name === 'string' && fields.name ? ` (${fields.name})` : '';
  if (op.action === 'create') return `create ${(op.key ?? '').trim() || '?'}\u2009${name}`;
  if (op.action === 'update') return `update ${op.botId ?? '?'}\u2009${name}`;
  return `delete ${op.botId ?? '?'}`;
}

export default function TeamsPanel({ bots, onRosterChanged }: { bots: BotConfig[]; onRosterChanged: () => void }) {
  const [chief, setChiefInfo] = useState<ChiefInfo | null>(null);
  const [proposals, setProposals] = useState<ChiefProposalDto[]>([]);
  const [incidents, setIncidents] = useState<ChiefIncidentDto[]>([]);
  const [incidentFilter, setIncidentFilter] = useState<'open' | 'all'>('open');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [makeChiefId, setMakeChiefId] = useState('');
  const [sectionsInput, setSectionsInput] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const [c, p, i] = await Promise.all([
        getChief(),
        listChiefProposals('pending'),
        listChiefIncidents(incidentFilter === 'open' ? 'open' : undefined),
      ]);
      setChiefInfo(c);
      setProposals(p.proposals);
      setIncidents(i.incidents);
      setSectionsInput(c.managedSections.join(', '));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [incidentFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const withBusy = async (key: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    setError('');
    try {
      await fn();
      await load();
      onRosterChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const chiefBot = chief?.chiefBotId ? bots.find((b) => b.id === chief.chiefBotId) : undefined;

  return (
    <div>
      {error && <div className="error-box">{error}</div>}

      {/* Chief card */}
      <div className="card">
        <div className="row-between">
          <strong>👑 Chief of Staff</strong>
          <span className="small muted">
            {chiefBot ? `in charge: ${chiefBot.name}` : 'no chief assigned'}
          </span>
        </div>
        <p className="small muted">
          The chief is the user's primary contact for its sections: it coordinates the
          specialist bots, files failed delegations as incidents, relays user-only
          gates as escalations, and proposes (never applies) roster changes.
        </p>
        <div className="row-between" style={{ gap: 8, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <select
              className="input"
              value={makeChiefId}
              onChange={(e) => setMakeChiefId(e.target.value)}
              aria-label="Choose chief bot"
            >
              <option value="">Choose a bot…</option>
              {bots.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name} ({b.id})
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-sm"
              disabled={!makeChiefId || busy !== ''}
              onClick={() => void withBusy('make-chief', () => setChief(makeChiefId).then(() => undefined))}
            >
              {busy === 'make-chief' ? '…' : 'Make chief'}
            </button>
          </div>
          {chief?.chiefBotId && (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={busy !== ''}
              onClick={() => void withBusy('remove-chief', () => setChief(null).then(() => undefined))}
            >
              {busy === 'remove-chief' ? '…' : 'Remove chief'}
            </button>
          )}
        </div>
        <div className="field" style={{ marginTop: 8 }}>
          <label className="label">Managed sections (comma-separated, max 8)</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              className="input"
              value={sectionsInput}
              onChange={(e) => setSectionsInput(e.target.value)}
              placeholder="support, sales"
              aria-label="Managed sections"
            />
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy !== ''}
              onClick={() =>
                void withBusy('sections', () =>
                  setChiefSections(
                    sectionsInput
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean),
                  ).then(() => undefined),
                )
              }
            >
              {busy === 'sections' ? '…' : 'Save'}
            </button>
          </div>
        </div>
      </div>

      {/* Team roster */}
      <div className="card">
        <strong>Team roster</strong>
        <p className="small muted">Every bot the chief can coordinate. The roster is refreshed in the chief's prompt every turn.</p>
        {bots.length === 0 && <p className="small muted">No bots yet.</p>}
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {bots.map((b) => (
            <li key={b.id} className="row-between" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
              <div>
                <span className="bot-name">
                  {b.chiefOfStaff || chief?.chiefBotId === b.id ? '👑 ' : ''}
                  {b.name}
                </span>{' '}
                <span className="small muted mono">{b.id}</span>
                <div className="small muted">{b.description}</div>
              </div>
              {chief?.chiefBotId === b.id && <span className="chip blue">chief</span>}
            </li>
          ))}
        </ul>
      </div>

      {/* Proposals inbox */}
      <div className="card">
        <div className="row-between">
          <strong>Pending proposals</strong>
          <span className="small muted">{proposals.length} awaiting your decision</span>
        </div>
        {proposals.length === 0 && <p className="small muted">No pending proposals. The chief proposes roster changes here for your approval.</p>}
        {proposals.map((p) => (
          <div key={p.id} className="card" style={{ marginTop: 8 }}>
            <div className="row-between">
              <div>
                <strong>{p.kind}</strong>{' '}
                {p.suggestion && <span className="chip gray">suggestion</span>}{' '}
                <span className="small muted mono">{p.id}</span>
              </div>
              <span className="small muted">{new Date(p.createdAt).toLocaleString()}</span>
            </div>
            <p className="small">{p.reason}</p>
            <ul className="small mono" style={{ paddingLeft: 18 }}>
              {p.operations.map((op, i) => (
                <li key={i}>{opSummary(op)}</li>
              ))}
            </ul>
            {p.newTeams && p.newTeams.length > 0 && (
              <p className="small muted">New teams: {p.newTeams.join(', ')}</p>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy !== ''}
                onClick={() => void withBusy(`approve-${p.id}`, () => approveChiefProposal(p.id).then(() => undefined))}
              >
                {busy === `approve-${p.id}` ? '…' : 'Approve & apply'}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={busy !== ''}
                onClick={() => void withBusy(`reject-${p.id}`, () => rejectChiefProposal(p.id).then(() => undefined))}
              >
                {busy === `reject-${p.id}` ? '…' : 'Reject'}
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Incidents / escalations inbox */}
      <div className="card">
        <div className="row-between">
          <strong>Incidents & escalations</strong>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              type="button"
              className={`btn btn-sm${incidentFilter === 'open' ? '' : ' btn-ghost'}`}
              onClick={() => setIncidentFilter('open')}
            >
              Open
            </button>
            <button
              type="button"
              className={`btn btn-sm${incidentFilter === 'all' ? '' : ' btn-ghost'}`}
              onClick={() => setIncidentFilter('all')}
            >
              All
            </button>
          </div>
        </div>
        {incidents.length === 0 && <p className="small muted">Inbox clear. Failed delegations land here as incidents; gates only you can lift land here as escalations.</p>}
        {incidents.map((inc) => (
          <div key={inc.id} className="card" style={{ marginTop: 8 }}>
            <div className="row-between">
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span className={KIND_CHIP[inc.kind]}>{inc.kind === 'incident' ? '🚨 incident' : '⏫ escalation'}</span>
                <span className={STATUS_CHIP[inc.status]}>{inc.status}</span>
                <span className="small muted mono">{inc.id}</span>
              </div>
              <span className="small muted">{new Date(inc.updatedAt).toLocaleString()}</span>
            </div>
            <p className="small">{inc.summary}</p>
            <p className="small muted">
              {inc.targetBotName ?? inc.targetBotId ? `Target: ${inc.targetBotName ?? inc.targetBotId} · ` : ''}
              Attempts: {inc.attempts}
              {inc.threadId ? ` · Thread: ${inc.threadId}` : ''}
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              {inc.threadId && inc.status !== 'resolved' && (
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy !== ''}
                  onClick={() => void withBusy(`retry-${inc.id}`, () => retryChiefIncident(inc.id).then(() => undefined))}
                  title="Re-run the stored brief as a new attempt (retry_thread)"
                >
                  {busy === `retry-${inc.id}` ? '…' : 'Retry'}
                </button>
              )}
              {inc.status !== 'resolved' && (
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  disabled={busy !== ''}
                  onClick={() => void withBusy(`resolve-${inc.id}`, () => resolveChiefIncident(inc.id).then(() => undefined))}
                >
                  {busy === `resolve-${inc.id}` ? '…' : 'Resolve'}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
