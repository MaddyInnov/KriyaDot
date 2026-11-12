// SPDX-License-Identifier: Apache-2.0
'use client';

/**
 * Dreams section (A11, Timon parity programme) — the Workspace → Memory
 * surface for the overnight self-improvement proposal pass, sitting
 * directly under the A10 rule-proposals inbox it feeds.
 *
 * Posture, stated in the UI because the user must be able to judge it:
 * - OFF by default. Nothing runs until the user enables it here.
 * - PROPOSE-ONLY. The nightly pass reads this bot's local audit trail
 *   and memory (both stay on this machine) and writes improvement
 *   LEADS. It never applies a change: Accept routes a lead to the
 *   existing safe artefacts — a pending rule proposal in the A10 inbox
 *   above, or a routine draft created DISABLED — and leads with no
 *   safe mapping are only acknowledged.
 * - Every lead carries its evidence (counts + examples) and a
 *   deterministic score. Dismiss is remembered: similar leads are
 *   suppressed for a cooling period. Snooze hides a lead for a week.
 * - Optional model summary is a second opt-in: when on, lead titles
 *   and evidence counts are sent to this bot's already-configured
 *   model provider for summarisation. Nothing else leaves the machine.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  decideDreamLead,
  getDreams,
  runDreamsNow,
  saveDreamSettings,
  type DreamLeadRecord,
  type DreamSettingsRecord,
} from '../../lib/api';

export const DREAMS_PRIVACY_COPY =
  'Dreams is off by default. When enabled, a nightly pass reads this bot\u2019s audit trail and memory — both stored on this machine — and proposes improvement leads here. It never applies changes itself.';
export const DREAMS_SUMMARY_COPY =
  'Model summary sends lead titles and evidence counts to this bot\u2019s already-configured model provider. Nothing else leaves this machine.';
export const DREAMS_EMPTY_STATE =
  'No improvement leads yet. Runs happen nightly when Dreams is enabled, or use “Run Dreams now” to test the pass.';

const KIND_LABEL: Record<DreamLeadRecord['kind'], string> = {
  'recurring-failure': 'Recurring failure',
  'approval-friction': 'Approval friction',
  'cooldown-refusal': 'Cooldown / refusal',
  'stale-rule': 'Stale rule',
  'manual-pattern': 'Manual pattern',
  'proposal-backlog': 'Proposals backlog',
};

function acceptNotice(lead: DreamLeadRecord): string {
  if (lead.acceptedArtefact?.type === 'rule-proposal') {
    return 'Accepted — a pending rule proposal was created in the Rule proposals inbox above. It is not a rule until you approve it there.';
  }
  if (lead.acceptedArtefact?.type === 'routine-draft') {
    return 'Accepted — a DISABLED routine draft was created. Review and enable it in Routines when ready.';
  }
  return 'Accepted — lead acknowledged and archived. No change was made.';
}

export function MemoryDreamsSection({ botId }: { botId: string }) {
  const [settings, setSettings] = useState<DreamSettingsRecord | null>(null);
  const [leads, setLeads] = useState<DreamLeadRecord[]>([]);
  const [lastRunAt, setLastRunAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const refresh = useCallback(async () => {
    if (!botId) return;
    setLoading(true);
    setError('');
    try {
      const res = await getDreams(botId);
      setSettings(res.settings);
      setLeads(res.leads ?? []);
      setLastRunAt(res.lastRunAt);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [botId]);

  useEffect(() => {
    setNotice('');
    void refresh();
  }, [refresh]);

  const saveSettings = useCallback(
    async (patch: Partial<Pick<DreamSettingsRecord, 'enabled' | 'hour' | 'minute' | 'summarise'>>) => {
      if (!botId) return;
      setError('');
      try {
        const res = await saveDreamSettings(botId, patch);
        setSettings(res.settings);
        setNotice(
          patch.enabled === true
            ? 'Dreams enabled — the nightly pass will propose leads here. It never applies changes.'
            : patch.enabled === false
              ? 'Dreams disabled — no nightly pass will run.'
              : 'Dreams settings saved.',
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [botId],
  );

  const runNow = useCallback(async () => {
    if (!botId) return;
    setRunning(true);
    setError('');
    setNotice('');
    try {
      const res = await runDreamsNow(botId);
      setNotice(
        res.created.length > 0
          ? `Dreams pass proposed ${res.created.length} lead(s) from ${res.considered} audit events. Nothing was applied.`
          : `Dreams pass ran over ${res.considered} audit events — no new leads.`,
      );
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }, [botId, refresh]);

  const decide = useCallback(
    async (lead: DreamLeadRecord, action: 'accept' | 'dismiss' | 'snooze') => {
      setBusyId(lead.id);
      setError('');
      try {
        const res = await decideDreamLead(botId, lead.id, action, action === 'snooze' ? 7 : undefined);
        setLeads((prev) => prev.filter((l) => l.id !== lead.id));
        setNotice(
          action === 'accept'
            ? acceptNotice(res.lead)
            : action === 'dismiss'
              ? 'Lead dismissed — similar leads are suppressed for a cooling period.'
              : 'Lead snoozed for 7 days.',
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyId(null);
      }
    },
    [botId],
  );

  if (!botId) return <p className="muted">Pick a bot first.</p>;

  return (
    <div className="memory-dreams">
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        {DREAMS_PRIVACY_COPY}
      </p>

      {settings ? (
        <div style={{ display: 'grid', gap: 8, marginBottom: 10 }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={(e) => void saveSettings({ enabled: e.target.checked })}
              aria-label="Enable nightly Dreams pass"
            />
            Enable the nightly Dreams pass for this bot
          </label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
            <span className="muted">Run at (local time)</span>
            <input
              type="number"
              min={0}
              max={23}
              value={settings.hour}
              disabled={!settings.enabled}
              onChange={(e) => setSettings({ ...settings, hour: Number(e.target.value) })}
              onBlur={() => void saveSettings({ hour: settings.hour })}
              aria-label="Dreams run hour"
              style={{ width: 64 }}
            />
            <span>:</span>
            <input
              type="number"
              min={0}
              max={59}
              value={settings.minute}
              disabled={!settings.enabled}
              onChange={(e) => setSettings({ ...settings, minute: Number(e.target.value) })}
              onBlur={() => void saveSettings({ minute: settings.minute })}
              aria-label="Dreams run minute"
              style={{ width: 64 }}
            />
            <button type="button" onClick={() => void runNow()} disabled={running || loading} style={{ marginLeft: 'auto' }}>
              {running ? 'Running…' : 'Run Dreams now'}
            </button>
          </div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
            <input
              type="checkbox"
              checked={settings.summarise}
              onChange={(e) => void saveSettings({ summarise: e.target.checked })}
              aria-label="Enable model summary of dream leads"
            />
            Summarise new leads with the bot&rsquo;s model
          </label>
          <p className="muted" style={{ fontSize: 12, margin: 0 }}>
            {DREAMS_SUMMARY_COPY}
            {lastRunAt ? ` Last run: ${new Date(lastRunAt).toLocaleString()}.` : ' Never run yet.'}
          </p>
        </div>
      ) : null}

      {error ? (
        <p role="alert" style={{ color: 'var(--danger, #c00)' }}>
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" style={{ color: 'var(--success, #2a7)' }}>
          {notice}
        </p>
      ) : null}

      {loading && leads.length === 0 ? (
        <p className="muted">Loading leads…</p>
      ) : leads.length === 0 ? (
        <p className="muted">{DREAMS_EMPTY_STATE}</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }} aria-label="Pending dream leads">
          {leads.map((lead) => (
            <li key={lead.id} style={{ border: '1px solid var(--border, #ddd)', borderRadius: 8, padding: '10px 12px' }}>
              <div style={{ whiteSpace: 'pre-wrap', fontWeight: 500 }}>{lead.title}</div>
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                <span className="chip gray">{KIND_LABEL[lead.kind]}</span>
                {` · score ${lead.score} · evidence: ${lead.evidence.count} event${lead.evidence.count === 1 ? '' : 's'}`}
                {lead.evidence.examples.length > 0 ? ` · e.g. ${lead.evidence.examples[0]}` : ''}
              </div>
              <div style={{ fontSize: 13, marginTop: 6 }}>{lead.suggestedAction}</div>
              <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                <button type="button" disabled={busyId === lead.id} onClick={() => void decide(lead, 'accept')}>
                  Accept
                </button>
                <button type="button" disabled={busyId === lead.id} onClick={() => void decide(lead, 'dismiss')}>
                  Dismiss
                </button>
                <button type="button" disabled={busyId === lead.id} onClick={() => void decide(lead, 'snooze')}>
                  Snooze 7 days
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
