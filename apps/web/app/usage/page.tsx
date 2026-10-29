// SPDX-License-Identifier: Apache-2.0
'use client';

// Usage dashboard: token usage and cost breakdown (backed by
// GET /api/billing/usage/breakdown), spend-cap configuration with
// progress bars (GET/PUT /api/billing/usage/spend-caps), and the
// append-only usage ledger with CSV export
// (GET /api/billing/usage/ledger[.csv]).

import { useCallback, useEffect, useState } from 'react';
import { authedFetch, getBots } from '../../lib/api';
import type { BotConfig } from '../../lib/api';

interface FeatureSlice {
  feature: string;
  events: number;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
}

interface StepSlice {
  step: string;
  feature: string;
  events: number;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
}

interface BreakdownResponse {
  period: string;
  since: number;
  until: number;
  byFeature: FeatureSlice[];
  byStep: StepSlice[];
  totals: { events: number; inputTokens: number; outputTokens: number; costCents: number };
}

interface SpendCapConfig {
  global: { dailyCents: number | null; monthlyCents: number | null };
  bots: Record<string, { dailyCents: number | null; monthlyCents: number | null }>;
}

interface SpendCapStatus {
  scope: 'global' | 'bot';
  botId: string | null;
  period: 'day' | 'month';
  capCents: number | null;
  spentCents: number;
  exceeded: boolean;
  periodStart: number;
  periodEnd: number;
}

interface LedgerEvent {
  id: string;
  ts: number;
  sessionId: string;
  botId: string;
  feature: string;
  step: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

function fmtUsd(cents: number): string {
  return `$${(cents / 100).toFixed(4)}`;
}

function fmtUsdShort(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** USD cents → editable dollar string (empty when null). */
function centsToDollars(cents: number | null): string {
  return cents === null ? '' : (cents / 100).toFixed(2);
}

/** Editable dollar string → USD cents, or null to clear the cap. */
function dollarsToCents(v: string): number | null | 'invalid' {
  const t = v.trim();
  if (t === '') return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return 'invalid';
  return Math.round(n * 100);
}

// ---- Spend caps -----------------------------------------------------------

function CapProgress({ status, label }: { status: SpendCapStatus; label: string }) {
  const cap = status.capCents ?? 0;
  const pct = cap > 0 ? Math.min(100, (status.spentCents / cap) * 100) : 0;
  return (
    <div className="cap-row">
      <div className="cap-row-head">
        <span className="cap-label">{label}</span>
        <span className={`cap-amount${status.exceeded ? ' exceeded' : ''}`}>
          {fmtUsdShort(status.spentCents)} / {fmtUsdShort(cap)}
          {status.exceeded && ' — cap reached'}
        </span>
      </div>
      <div className="cap-bar" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
        <div className={`cap-bar-fill${status.exceeded ? ' exceeded' : ''}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function SpendCapsSection({ bots }: { bots: BotConfig[] }) {
  const [config, setConfig] = useState<SpendCapConfig | null>(null);
  const [statuses, setStatuses] = useState<SpendCapStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState('');
  // Editable inputs, keyed by field.
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [botPick, setBotPick] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await authedFetch('/api/billing/usage/spend-caps');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { config: SpendCapConfig; statuses: SpendCapStatus[] };
      setConfig(json.config);
      setStatuses(json.statuses);
      const next: Record<string, string> = {
        'global:day': centsToDollars(json.config.global.dailyCents),
        'global:month': centsToDollars(json.config.global.monthlyCents),
      };
      for (const [botId, c] of Object.entries(json.config.bots)) {
        next[`bot:${botId}:day`] = centsToDollars(c.dailyCents);
        next[`bot:${botId}:month`] = centsToDollars(c.monthlyCents);
      }
      setInputs(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (scope: 'global' | 'bot', botId: string | undefined, period: 'day' | 'month', key: string) => {
    const parsed = dollarsToCents(inputs[key] ?? '');
    if (parsed === 'invalid') {
      setError('Enter a non-negative dollar amount, or leave blank for unlimited.');
      return;
    }
    setSaving(key);
    setError('');
    try {
      const res = await authedFetch('/api/billing/usage/spend-caps', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope, botId, period, capCents: parsed }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving('');
    }
  };

  const setInput = (key: string, v: string) => setInputs((p) => ({ ...p, [key]: v }));
  const botName = (id: string) => bots.find((b) => b.id === id)?.name ?? id;

  const globalStatuses = statuses.filter((s) => s.scope === 'global');
  const botStatuses = statuses.filter((s) => s.scope === 'bot');

  return (
    <section className="usage-section">
      <h2>Spend caps</h2>
      <p className="muted small">
        Hard stops, not advisories: when spend plus the estimated cost of the next model call would exceed a cap,
        the call is blocked before it runs and you get a push notification. Blank = unlimited.
      </p>
      {loading && <p className="muted">Loading caps…</p>}
      {error && <p className="error">{error}</p>}
      {config && !loading && (
        <>
          <h3>Account-wide</h3>
          {(['day', 'month'] as const).map((period) => {
            const key = `global:${period}`;
            const status = globalStatuses.find((s) => s.period === period);
            return (
              <div key={key} className="cap-editor">
                <div className="cap-editor-row">
                  <label htmlFor={`${key}-input`}>{period === 'day' ? 'Daily' : 'Monthly'} cap (USD)</label>
                  <input
                    id={`${key}-input`}
                    className="input-sm"
                    inputMode="decimal"
                    placeholder="Unlimited"
                    value={inputs[key] ?? ''}
                    onChange={(e) => setInput(key, e.target.value)}
                  />
                  <button className="btn btn-sm" disabled={saving === key} onClick={() => void save('global', undefined, period, key)}>
                    {saving === key ? 'Saving…' : 'Save'}
                  </button>
                </div>
                {status && <CapProgress status={status} label={period === 'day' ? 'Today' : 'This month'} />}
              </div>
            );
          })}

          <h3>Per-bot overrides</h3>
          <div className="cap-editor-row">
            <select className="input-sm" value={botPick} onChange={(e) => setBotPick(e.target.value)} aria-label="Bot">
              <option value="">Select a bot…</option>
              {bots.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
          {botPick &&
            (['day', 'month'] as const).map((period) => {
              const key = `bot:${botPick}:${period}`;
              const status = botStatuses.find((s) => s.botId === botPick && s.period === period);
              return (
                <div key={key} className="cap-editor">
                  <div className="cap-editor-row">
                    <label htmlFor={`${key}-input`}>
                      {botName(botPick)} — {period === 'day' ? 'daily' : 'monthly'} cap (USD)
                    </label>
                    <input
                      id={`${key}-input`}
                      className="input-sm"
                      inputMode="decimal"
                      placeholder="Unlimited"
                      value={inputs[key] ?? ''}
                      onChange={(e) => setInput(key, e.target.value)}
                    />
                    <button className="btn btn-sm" disabled={saving === key} onClick={() => void save('bot', botPick, period, key)}>
                      {saving === key ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                  {status && <CapProgress status={status} label={period === 'day' ? 'Today' : 'This month'} />}
                </div>
              );
            })}
        </>
      )}
    </section>
  );
}

// ---- Usage ledger ----------------------------------------------------------

function LedgerSection() {
  const [events, setEvents] = useState<LedgerEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await authedFetch('/api/billing/usage/ledger?limit=100');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setEvents((await res.json()) as LedgerEvent[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const downloadCsv = async () => {
    setDownloading(true);
    try {
      const res = await authedFetch('/api/billing/usage/ledger.csv');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'kriyadot-usage-ledger.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <section className="usage-section">
      <div className="section-head">
        <h2>Usage ledger</h2>
        <button className="btn btn-sm" disabled={downloading} onClick={() => void downloadCsv()}>
          {downloading ? 'Preparing…' : 'Download CSV'}
        </button>
      </div>
      <p className="muted small">Append-only record of every metered event — the same ledger the spend-cap enforcer reads.</p>
      {loading && <p className="muted">Loading ledger…</p>}
      {error && <p className="error">{error}</p>}
      {!loading && events.length === 0 && <p className="muted">No metered events yet.</p>}
      {events.length > 0 && (
        <table className="usage-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Bot</th>
              <th>Feature</th>
              <th>Step</th>
              <th>Model</th>
              <th>Tokens in/out</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id}>
                <td className="mono small">{new Date(e.ts).toLocaleString()}</td>
                <td className="mono">{e.botId || '—'}</td>
                <td>{e.feature}</td>
                <td className="mono small">{e.step}</td>
                <td className="mono small">{e.model ?? '—'}</td>
                <td>
                  {fmtTokens(e.inputTokens)} / {fmtTokens(e.outputTokens)}
                </td>
                <td>{fmtUsd(e.costCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ---- Purchases (W6: approval-gated purchasing) ------------------------------

interface PurchaseIntentView {
  id: string;
  botId: string;
  itemDescription: string;
  merchantName: string;
  amountCents: number;
  currency: string;
  totalCents: number;
  checkoutUrl: string;
  status: string;
  executionMethod: string;
  blockReason: string | null;
  failureReason: string | null;
  note: string | null;
  ledgerRef: string | null;
  createdAt: number;
}

interface PurchaseSettingsView {
  stripeLinkEnabled: boolean;
  stripeLinkConfigured: boolean;
  stripeLinkRef: string | null;
}

function fmtMoney(cents: number, currency: string): string {
  return `${currency} ${(cents / 100).toFixed(2)}`;
}

function PurchasesSection() {
  const [intents, setIntents] = useState<PurchaseIntentView[]>([]);
  const [settings, setSettings] = useState<PurchaseSettingsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [acting, setActing] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [listRes, settingsRes] = await Promise.all([
        authedFetch('/api/billing/purchases?limit=50'),
        authedFetch('/api/billing/purchases/settings'),
      ]);
      if (!listRes.ok) throw new Error(`HTTP ${listRes.status}`);
      if (!settingsRes.ok) throw new Error(`HTTP ${settingsRes.status}`);
      setIntents((await listRes.json()) as PurchaseIntentView[]);
      setSettings((await settingsRes.json()) as PurchaseSettingsView);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const post = async (path: string, body: Record<string, unknown>) => {
    const res = await authedFetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  };

  const act = async (key: string, fn: () => Promise<void>) => {
    setActing(key);
    setError('');
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActing('');
    }
  };

  const toggleStripeLink = async (enabled: boolean) => {
    setActing('stripe-toggle');
    setError('');
    try {
      const res = await authedFetch('/api/billing/purchases/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stripeLinkEnabled: enabled }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSettings((await res.json()) as PurchaseSettingsView);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActing('');
    }
  };

  const statusChip = (s: string): string =>
    s === 'completed' ? 'green' : s === 'pending-approval' || s === 'awaiting-user-confirm' ? 'amber' : s === 'blocked' || s === 'denied' || s === 'failed' ? 'red' : 'gray';

  return (
    <section className="usage-section">
      <h2>Purchases</h2>
      <p className="muted small">
        Bots can request purchases with the <span className="mono">request_purchase</span> tool, but nothing is ever
        charged without your approval: every purchase raises its own approval card (Approvals inbox) and is executed
        only after you approve it. Securities/crypto trading and transfers between your own accounts are hard-blocked,
        and spend caps apply. With Stripe Link off, an approved purchase opens the merchant checkout in the bot&apos;s
        browser and stops <strong>before</strong> the pay step — you finish the payment yourself.
      </p>

      <div className="cap-editor">
        <div className="cap-editor-row">
          <label htmlFor="stripe-link-toggle">
            <input
              id="stripe-link-toggle"
              type="checkbox"
              checked={settings?.stripeLinkEnabled ?? false}
              disabled={acting === 'stripe-toggle' || !settings}
              onChange={(e) => void toggleStripeLink(e.target.checked)}
            />{' '}
            Pay with Stripe Link
          </label>
          {settings?.stripeLinkConfigured && <span className="chip green">linked</span>}
        </div>
        <p className="muted small">
          When on, approved purchases can complete via Stripe Link. Your payment details stay in Stripe Link and the
          vault — bots never see card numbers or credentials, only an opaque Link reference, and only after you
          approve each purchase individually.
        </p>
      </div>

      {loading && <p className="muted">Loading purchases…</p>}
      {error && <p className="error">{error}</p>}
      {!loading && intents.length === 0 && <p className="muted">No purchase requests yet.</p>}
      {intents.length > 0 && (
        <table className="usage-table">
          <thead>
            <tr>
              <th>Requested</th>
              <th>Item</th>
              <th>Merchant</th>
              <th>Total</th>
              <th>Method</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {intents.map((p) => (
              <tr key={p.id}>
                <td className="mono small">
                  {new Date(p.createdAt).toLocaleString()}
                  <br />
                  <span className="muted">bot {p.botId}</span>
                </td>
                <td>
                  {p.itemDescription}
                  <br />
                  <a href={p.checkoutUrl} target="_blank" rel="noreferrer" className="small">
                    View item ↗
                  </a>
                  {p.blockReason && <div className="small error">{p.blockReason}</div>}
                  {p.failureReason && <div className="small error">{p.failureReason}</div>}
                  {p.note && <div className="small muted">{p.note}</div>}
                </td>
                <td>{p.merchantName}</td>
                <td>{fmtMoney(p.totalCents, p.currency)}</td>
                <td className="mono small">{p.executionMethod}</td>
                <td>
                  <span className={`chip ${statusChip(p.status)}`}>{p.status}</span>
                  {p.ledgerRef && <div className="small muted mono">ledger {p.ledgerRef.slice(0, 18)}…</div>}
                </td>
                <td>
                  {p.status === 'pending-approval' && (
                    <div className="approval-actions">
                      <button
                        className="btn btn-primary btn-sm"
                        disabled={acting === p.id}
                        onClick={() => void act(p.id, () => post(`/api/billing/purchases/${p.id}/decide`, { decision: 'approved' }))}
                      >
                        Approve &amp; pay
                      </button>
                      <button
                        className="btn btn-danger btn-sm"
                        disabled={acting === p.id}
                        onClick={() => void act(p.id, () => post(`/api/billing/purchases/${p.id}/decide`, { decision: 'denied' }))}
                      >
                        Deny
                      </button>
                    </div>
                  )}
                  {p.status === 'awaiting-user-confirm' && (
                    <div className="approval-actions">
                      <button
                        className="btn btn-primary btn-sm"
                        disabled={acting === p.id}
                        onClick={() => void act(p.id, () => post(`/api/billing/purchases/${p.id}/confirm-completion`, { outcome: 'completed' }))}
                      >
                        I completed payment
                      </button>
                      <button
                        className="btn btn-sm"
                        disabled={acting === p.id}
                        onClick={() => void act(p.id, () => post(`/api/billing/purchases/${p.id}/confirm-completion`, { outcome: 'failed' }))}
                      >
                        Payment failed / abandoned
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ---- Run outcomes (W13: per-bot success rates from the span store) ---------

interface BotOutcomeStats {
  botId: string;
  total: number;
  running: number;
  success: number;
  failed: number;
  cancelled: number;
  needsInput: number;
  successRate: number;
}

function OutcomesSection() {
  const [byBot, setByBot] = useState<BotOutcomeStats[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    authedFetch('/api/observability/outcomes')
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as { byBot: BotOutcomeStats[] };
      })
      .then((json) => {
        if (!cancelled) setByBot(json.byBot);
      })
      .catch(() => {
        if (!cancelled) setByBot([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (byBot === null) return null;
  return (
    <>
      <h2>Run outcomes by bot</h2>
      {byBot.length === 0 ? (
        <p className="muted">
          No recorded runs yet. Outcomes (success / failed / cancelled / needs-input) appear here once
          bots complete turns — see Activity → Runs for the span traces.
        </p>
      ) : (
        <table className="usage-table">
          <thead>
            <tr>
              <th>Bot</th>
              <th>Runs</th>
              <th>Success</th>
              <th>Failed</th>
              <th>Cancelled</th>
              <th>Needs input</th>
              <th>Success rate</th>
            </tr>
          </thead>
          <tbody>
            {byBot.map((b) => (
              <tr key={b.botId}>
                <td className="mono">{b.botId}</td>
                <td>{b.total}</td>
                <td>{b.success}</td>
                <td>{b.failed}</td>
                <td>{b.cancelled}</td>
                <td>{b.needsInput}</td>
                <td>{`${Math.round(b.successRate * 100)}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

// ---- Page -------------------------------------------------------------------

export default function UsagePage() {
  const [period, setPeriod] = useState<'day' | 'week' | 'month' | 'all'>('month');
  const [data, setData] = useState<BreakdownResponse | null>(null);
  const [bots, setBots] = useState<BotConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await authedFetch(`/api/billing/usage/breakdown?period=${period}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as BreakdownResponse;
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    getBots()
      .then(setBots)
      .catch(() => setBots([]));
  }, []);

  return (
    <div className="page usage-page">
      <div className="page-header">
        <h1>Usage &amp; costs</h1>
        <div className="period-picker">
          {(['day', 'week', 'month', 'all'] as const).map((p) => (
            <button
              key={p}
              className={`btn btn-sm${period === p ? ' btn-primary' : ''}`}
              onClick={() => setPeriod(p)}
            >
              {p[0].toUpperCase() + p.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {loading && <p className="muted">Loading usage…</p>}
      {error && <p className="error">Failed to load usage: {error}</p>}

      {data && !loading && (
        <>
          <div className="usage-cards">
            <div className="usage-card">
              <div className="usage-card-label">Total tokens</div>
              <div className="usage-card-value">{fmtTokens(data.totals.inputTokens + data.totals.outputTokens)}</div>
              <div className="usage-card-sub">
                ↑ {fmtTokens(data.totals.inputTokens)} in · ↓ {fmtTokens(data.totals.outputTokens)} out
              </div>
            </div>
            <div className="usage-card">
              <div className="usage-card-label">Estimated cost</div>
              <div className="usage-card-value">{fmtUsd(data.totals.costCents)}</div>
              <div className="usage-card-sub">{data.totals.events} metered events</div>
            </div>
          </div>

          <h2>By step</h2>
          {data.byStep.length === 0 ? (
            <p className="muted">No usage in this period.</p>
          ) : (
            <table className="usage-table">
              <thead>
                <tr>
                  <th>Step</th>
                  <th>Feature</th>
                  <th>Events</th>
                  <th>Tokens</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {data.byStep.map((s) => (
                  <tr key={`${s.feature}:${s.step}`}>
                    <td className="mono">{s.step}</td>
                    <td>{s.feature}</td>
                    <td>{s.events}</td>
                    <td>{fmtTokens(s.inputTokens + s.outputTokens)}</td>
                    <td>{fmtUsd(s.costCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h2>By feature</h2>
          {data.byFeature.length === 0 ? (
            <p className="muted">No usage in this period.</p>
          ) : (
            <table className="usage-table">
              <thead>
                <tr>
                  <th>Feature</th>
                  <th>Events</th>
                  <th>Tokens</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {data.byFeature.map((f) => (
                  <tr key={f.feature}>
                    <td className="mono">{f.feature}</td>
                    <td>{f.events}</td>
                    <td>{fmtTokens(f.inputTokens + f.outputTokens)}</td>
                    <td>{fmtUsd(f.costCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      <OutcomesSection />
      <SpendCapsSection bots={bots} />
      <PurchasesSection />
      <LedgerSection />
    </div>
  );
}
