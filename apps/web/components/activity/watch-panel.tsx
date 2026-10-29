// SPDX-License-Identifier: Apache-2.0
'use client';

// Proactive account watching (W5) — watch-rule management.
//
// Lives in Activity (next to the briefing): a rule watches one connected
// app (Gmail / Slack / GitHub / Stripe / Calendar) on an interval; new
// items are triaged by a cheap helper model and only flagged items
// surface as "needs you" entries in the Approvals inbox (with a push).
// This panel is the CRUD surface for rules plus the watcher run log
// ("checked N, surfaced M") — quiet polls leave only a run row here.

import { useCallback, useEffect, useState } from 'react';
import {
  authedFetch,
  createWatchRule,
  deleteWatchRule,
  getWatchRules,
  getWatchRuns,
  runWatchRuleNow,
  updateWatchRule,
} from '../../lib/api';
import type { WatchAppId, WatchKind, WatchRule, WatchRuleInput, WatchRun } from '../../lib/api';

const APPS: Array<{ id: WatchAppId; label: string }> = [
  { id: 'gmail', label: 'Gmail' },
  { id: 'slack', label: 'Slack' },
  { id: 'github', label: 'GitHub' },
  { id: 'stripe', label: 'Stripe' },
  { id: 'googlecalendar', label: 'Google Calendar' },
];

const KINDS: Array<{ id: WatchKind; label: string }> = [
  { id: 'needs-reply', label: 'Needs my reply' },
  { id: 'payment-failed', label: 'Payment failed' },
  { id: 'review-requested', label: 'Review requested' },
  { id: 'meeting-conflict', label: 'Meeting conflict' },
  { id: 'mention', label: 'Mentions me' },
  { id: 'custom', label: 'Custom instruction' },
];

interface AccountView {
  id: string;
  toolkitSlug: string;
  label?: string;
  status: string;
}

interface FormState {
  name: string;
  app: WatchAppId;
  accountId: string;
  kind: WatchKind;
  instruction: string;
  intervalMinutes: number;
  dailyCap: number;
  channelId: string;
  repo: string;
  calendarId: string;
}

const EMPTY_FORM: FormState = {
  name: '',
  app: 'gmail',
  accountId: '',
  kind: 'needs-reply',
  instruction: '',
  intervalMinutes: 240,
  dailyCap: 10,
  channelId: '',
  repo: '',
  calendarId: '',
};

function fmtTs(ts?: number | null): string {
  return ts ? new Date(ts).toLocaleString() : '—';
}

export function WatchPanel() {
  const [rules, setRules] = useState<WatchRule[]>([]);
  const [runs, setRuns] = useState<WatchRun[]>([]);
  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [r, runLog] = await Promise.all([getWatchRules(), getWatchRuns()]);
      setRules(r);
      setRuns(runLog.slice(0, 20));
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Connected accounts for the dropdown (best-effort; free-text fallback).
    void (async () => {
      try {
        const res = await authedFetch('/api/composio/accounts');
        if (res.ok) {
          const data = (await res.json()) as { accounts?: AccountView[] };
          setAccounts(data.accounts ?? []);
        }
      } catch {
        // Accounts list is a convenience only.
      }
    })();
  }, [refresh]);

  const appAccounts = accounts.filter((a) => a.toolkitSlug === form.app);

  const buildInput = (): WatchRuleInput => {
    const input: WatchRuleInput = {
      app: form.app,
      accountId: form.accountId.trim(),
      kind: form.kind,
      instruction: form.instruction.trim() || undefined,
      intervalMinutes: form.intervalMinutes,
      dailyCap: form.dailyCap,
    };
    if (form.name.trim()) input.name = form.name.trim();
    if (form.app === 'slack') input.channelId = form.channelId.trim();
    if (form.app === 'github') input.repo = form.repo.trim();
    if (form.app === 'googlecalendar' && form.calendarId.trim()) input.calendarId = form.calendarId.trim();
    return input;
  };

  const submit = async () => {
    setBusy('save');
    try {
      if (editingId) await updateWatchRule(editingId, buildInput());
      else await createWatchRule(buildInput());
      setForm(EMPTY_FORM);
      setEditingId(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const startEdit = (rule: WatchRule) => {
    setEditingId(rule.id);
    setForm({
      name: rule.name,
      app: rule.app,
      accountId: rule.accountId,
      kind: rule.kind,
      instruction: rule.instruction,
      intervalMinutes: rule.intervalMinutes,
      dailyCap: rule.dailyCap,
      channelId: rule.channelId ?? '',
      repo: rule.repo ?? '',
      calendarId: rule.calendarId ?? '',
    });
  };

  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  return (
    <div>
      <h3 className="mt0">Watch rules — proactive account watching</h3>
      <p className="small muted">
        Each rule polls a connected app on its interval. A cheap helper model triages new items
        against the flag instruction; only items that need you surface in the Approvals inbox
        (with a push). Everything else stays quiet — polls are logged below.
      </p>
      {error && <div className="error-box">{error}</div>}

      <div className="card">
        <h4 className="mt0">{editingId ? 'Edit watch rule' : 'New watch rule'}</h4>
        <div className="grid-2">
          <label className="small">
            Name (optional)
            <input
              className="input"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Work inbox — needs reply"
            />
          </label>
          <label className="small">
            App
            <select
              className="input"
              value={form.app}
              onChange={(e) => setForm({ ...form, app: e.target.value as WatchAppId, accountId: '' })}
            >
              {APPS.map((a) => (
                <option key={a.id} value={a.id}>{a.label}</option>
              ))}
            </select>
          </label>
          <label className="small">
            Connected account
            {appAccounts.length > 0 ? (
              <select
                className="input"
                value={form.accountId}
                onChange={(e) => setForm({ ...form, accountId: e.target.value })}
              >
                <option value="">Select an account…</option>
                {appAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label ?? a.id} ({a.status})
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="input"
                value={form.accountId}
                onChange={(e) => setForm({ ...form, accountId: e.target.value })}
                placeholder="Composio account id"
              />
            )}
          </label>
          <label className="small">
            Flag
            <select
              className="input"
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value as WatchKind })}
            >
              {KINDS.map((k) => (
                <option key={k.id} value={k.id}>{k.label}</option>
              ))}
            </select>
          </label>
          {form.app === 'slack' && (
            <label className="small">
              Channel id
              <input
                className="input"
                value={form.channelId}
                onChange={(e) => setForm({ ...form, channelId: e.target.value })}
                placeholder="C0123…"
              />
            </label>
          )}
          {form.app === 'github' && (
            <label className="small">
              Repository
              <input
                className="input"
                value={form.repo}
                onChange={(e) => setForm({ ...form, repo: e.target.value })}
                placeholder="owner/name"
              />
            </label>
          )}
          {form.app === 'googlecalendar' && (
            <label className="small">
              Calendar id (optional)
              <input
                className="input"
                value={form.calendarId}
                onChange={(e) => setForm({ ...form, calendarId: e.target.value })}
                placeholder="primary"
              />
            </label>
          )}
          <label className="small">
            Check every (minutes, 30–1440)
            <input
              className="input"
              type="number"
              min={30}
              max={1440}
              value={form.intervalMinutes}
              onChange={(e) => setForm({ ...form, intervalMinutes: Number(e.target.value) || 240 })}
            />
          </label>
          <label className="small">
            Daily surface cap
            <input
              className="input"
              type="number"
              min={1}
              max={100}
              value={form.dailyCap}
              onChange={(e) => setForm({ ...form, dailyCap: Number(e.target.value) || 10 })}
            />
          </label>
        </div>
        <label className="small">
          Flag instruction{form.kind === 'custom' ? ' (required for custom)' : ' (optional detail)'}
          <textarea
            className="input"
            rows={2}
            value={form.instruction}
            onChange={(e) => setForm({ ...form, instruction: e.target.value })}
            placeholder="e.g. Only flag emails from customers asking about invoices"
          />
        </label>
        <div className="approval-actions">
          <button className="btn btn-primary btn-sm" disabled={busy === 'save' || !form.accountId.trim()} onClick={() => void submit()}>
            {editingId ? 'Save rule' : 'Create rule'}
          </button>
          {editingId && (
            <button
              className="btn btn-sm"
              onClick={() => {
                setEditingId(null);
                setForm(EMPTY_FORM);
              }}
            >
              Cancel edit
            </button>
          )}
        </div>
      </div>

      <h4 className="mt">Rules ({rules.length})</h4>
      {rules.length === 0 && <p className="muted">No watch rules yet. Create one above.</p>}
      {rules.map((rule) => (
        <div key={rule.id} className="card">
          <div className="row-between">
            <div>
              <strong>{rule.name}</strong>{' '}
              <span className={`chip ${rule.enabled ? 'green' : 'gray'}`}>{rule.enabled ? 'watching' : 'paused'}</span>{' '}
              <span className="chip small">{rule.app}</span>{' '}
              <span className="chip small">{rule.kind}</span>
            </div>
            <span className="small muted">owner bot <span className="mono">{rule.botId}</span></span>
          </div>
          <div className="small muted mt">
            account <span className="mono">{rule.accountId}</span> · every {rule.intervalMinutes}m · cap{' '}
            {rule.dailyCap}/day
            {rule.instruction ? ` · “${rule.instruction}”` : ''}
          </div>
          <div className="small muted">
            last checked {fmtTs(rule.state?.lastPollAt)} · last surfaced {fmtTs(rule.state?.lastSurfacedAt)}
            {rule.state?.lastError ? ` · last error: ${rule.state.lastError}` : ''}
            {rule.state?.capBlocked ? ' · daily cap reached (backlog resumes tomorrow)' : ''}
          </div>
          <div className="approval-actions">
            <button className="btn btn-sm" disabled={busy === rule.id} onClick={() => void act(rule.id, () => runWatchRuleNow(rule.id))}>
              Check now
            </button>
            <button
              className="btn btn-sm"
              disabled={busy === rule.id}
              onClick={() => void act(rule.id, () => updateWatchRule(rule.id, { enabled: !rule.enabled }))}
            >
              {rule.enabled ? 'Pause' : 'Resume'}
            </button>
            <button className="btn btn-sm" onClick={() => startEdit(rule)}>
              Edit
            </button>
            <button
              className="btn btn-danger btn-sm"
              disabled={busy === rule.id}
              onClick={() => void act(rule.id, () => deleteWatchRule(rule.id))}
            >
              Delete
            </button>
          </div>
        </div>
      ))}

      <h4 className="mt">Watcher activity</h4>
      {runs.length === 0 && <p className="muted">No polls yet.</p>}
      {runs.length > 0 && (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>When</th>
                <th>Rule</th>
                <th>Checked</th>
                <th>Surfaced</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id}>
                  <td className="small muted">{fmtTs(run.startedAt)}</td>
                  <td className="mono small">{run.ruleId}</td>
                  <td className="small">{run.checked}</td>
                  <td className="small">{run.surfaced}</td>
                  <td className="small muted">
                    {run.error ? `error: ${run.error}` : run.note ?? (run.capBlocked > 0 ? `cap reached (${run.capBlocked} waiting)` : '—')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
