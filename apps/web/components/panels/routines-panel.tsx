// SPDX-License-Identifier: Apache-2.0
'use client';

/**
 * Per-bot routines panel (Codync parity: public webhook ingress).
 *
 * Lists the bot's routines. Each routine expands to show its public webhook
 * URL + secret (reveal / regenerate with confirmation / copy) and the recent
 * delivery log (timestamp, status, event type).
 *
 * Reachability note (also in the API): the API binds to 127.0.0.1, so the
 * public URL only works for external senders (GitHub etc.) when a tunnel
 * (Tailscale / cloudflared / ngrok) fronts the API port and
 * KRIYADOT_PUBLIC_URL is set. LAN senders can use the local URL directly.
 */

import { useCallback, useEffect, useState } from 'react';
import { kriyadotFetch } from '../../lib/kriyadot-api';

interface RoutineSchedule {
  kind: 'once' | 'daily' | 'cron' | 'interval';
  timezone: string;
  enabled: boolean;
  overlap: 'skip' | 'queue';
  runAt?: string;
  time?: string;
  weekdays?: number[];
  expression?: string;
  everyMinutes?: number;
  anchorTime?: string;
  windowStart?: string;
  windowEnd?: string;
  endsAt?: string;
}

interface Routine {
  id: string;
  name: string;
  botId: string;
  enabled: boolean;
  schedule?: RoutineSchedule | null;
  nextRunAt?: number | null;
}

interface NextRun {
  at: number;
  atIso: string;
  label: string;
}

const COMMON_TIMEZONES = [
  'UTC',
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Karachi',
  'Asia/Dhaka',
  'Asia/Singapore',
  'Asia/Jakarta',
  'Asia/Manila',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Australia/Sydney',
  'Pacific/Auckland',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'Europe/Moscow',
  'Africa/Cairo',
  'Africa/Lagos',
  'America/Sao_Paulo',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Toronto',
  'Pacific/Honolulu',
];

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function describeScheduleClient(s: RoutineSchedule): string {
  switch (s.kind) {
    case 'once':
      return `Once at ${s.runAt}`;
    case 'daily': {
      const days = s.weekdays && s.weekdays.length < 7
        ? s.weekdays.map((d) => WEEKDAY_LABELS[d]).join('/')
        : 'daily';
      return `${days} at ${s.time}`;
    }
    case 'cron':
      return `Cron \`${s.expression}\``;
    case 'interval': {
      let d = `Every ${s.everyMinutes} min`;
      if (s.anchorTime) d += ` from ${s.anchorTime}`;
      if (s.windowStart) d += `, ${s.windowStart}–${s.windowEnd}`;
      return d;
    }
  }
}

interface HookInfo {
  routineId: string;
  url: string | null;
  localUrl: string;
  hasSecret: boolean;
  connected: boolean;
  queueDepth: number;
  secret?: string;
}

interface Delivery {
  id: string;
  eventType: string;
  status: 'pending' | 'processing' | 'done' | 'failed';
  attempts: number;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

const STATUS_LABEL: Record<Delivery['status'], string> = {
  pending: '⏳ queued',
  processing: '⚙️ running',
  done: '✅ done',
  failed: '❌ failed',
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await kriyadotFetch(path, init);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
  return (await res.json()) as T;
}

function copyText(text: string, done: () => void) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}

function fallbackCopy(text: string, done: () => void) {
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    done();
  } catch {
    // ignore
  }
  document.body.removeChild(ta);
}

function WeekdayPicker({ value, onChange }: { value: number[]; onChange: (v: number[]) => void }) {
  const toggle = (d: number) => {
    onChange(value.includes(d) ? value.filter((x) => x !== d) : [...value, d].sort((a, b) => a - b));
  };
  return (
    <div className="weekday-picker">
      {WEEKDAY_LABELS.map((label, d) => (
        <button
          key={label}
          type="button"
          className={`weekday-chip${value.includes(d) ? ' on' : ''}`}
          onClick={() => toggle(d)}
          aria-pressed={value.includes(d)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function TimezoneField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <>
      <input
        className="text-input"
        list="kriyadot-timezones"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Asia/Kolkata"
        spellCheck={false}
      />
      <datalist id="kriyadot-timezones">
        {COMMON_TIMEZONES.map((tz) => (
          <option key={tz} value={tz} />
        ))}
      </datalist>
      <p className="muted small">IANA timezone — all times below are read in this zone, not server-local.</p>
    </>
  );
}

function ScheduleBuilder({
  routineId,
  initial,
  onSaved,
  onCancel,
}: {
  routineId: string;
  initial: RoutineSchedule | null;
  onSaved: (routine: Routine) => void;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<RoutineSchedule['kind']>(initial?.kind ?? 'daily');
  const [timezone, setTimezone] = useState(initial?.timezone ?? 'Asia/Kolkata');
  const [overlap, setOverlap] = useState<'skip' | 'queue'>(initial?.overlap ?? 'skip');
  const [onceRunAt, setOnceRunAt] = useState(initial?.runAt?.slice(0, 16) ?? '');
  const [dailyTime, setDailyTime] = useState(initial?.time ?? '09:00');
  const [dailyWeekdays, setDailyWeekdays] = useState<number[]>(initial?.weekdays ?? [1, 2, 3, 4, 5]);
  const [cronExpr, setCronExpr] = useState(initial?.expression ?? '0 9 * * *');
  const [everyMinutes, setEveryMinutes] = useState(String(initial?.everyMinutes ?? 30));
  const [anchorTime, setAnchorTime] = useState(initial?.anchorTime ?? '');
  const [useWindow, setUseWindow] = useState(Boolean(initial?.windowStart));
  const [windowStart, setWindowStart] = useState(initial?.windowStart ?? '09:00');
  const [windowEnd, setWindowEnd] = useState(initial?.windowEnd ?? '18:00');
  const [useWeekdays, setUseWeekdays] = useState(Boolean(initial?.weekdays));
  const [intervalWeekdays, setIntervalWeekdays] = useState<number[]>(initial?.weekdays ?? [1, 2, 3, 4, 5]);
  const [endsAt, setEndsAt] = useState(initial?.endsAt?.slice(0, 16) ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const build = (): RoutineSchedule => {
    const base = { timezone: timezone.trim(), enabled: initial?.enabled ?? true, overlap };
    switch (kind) {
      case 'once':
        if (!onceRunAt) throw new Error('Pick a date and time');
        return { ...base, kind, runAt: onceRunAt };
      case 'daily':
        if (dailyWeekdays.length === 0) throw new Error('Pick at least one weekday');
        return { ...base, kind, time: dailyTime, weekdays: dailyWeekdays };
      case 'cron':
        if (!cronExpr.trim()) throw new Error('Enter a cron expression');
        return { ...base, kind, expression: cronExpr.trim() };
      case 'interval': {
        const mins = Number(everyMinutes);
        if (!Number.isInteger(mins) || mins < 1 || mins > 10080) {
          throw new Error('Every N minutes must be an integer 1..10080');
        }
        const s: RoutineSchedule = { ...base, kind, everyMinutes: mins };
        if (anchorTime) s.anchorTime = anchorTime;
        if (useWindow) {
          s.windowStart = windowStart;
          s.windowEnd = windowEnd;
        }
        if (useWeekdays) {
          if (intervalWeekdays.length === 0) throw new Error('Pick at least one weekday');
          s.weekdays = intervalWeekdays;
        }
        if (endsAt) s.endsAt = endsAt;
        return s;
      }
    }
  };

  const onSave = async () => {
    setBusy(true);
    setError('');
    try {
      const schedule = build();
      const res = await api<{ routine: Routine }>(`/api/routines/${encodeURIComponent(routineId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ schedule }),
      });
      onSaved(res.routine);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="schedule-builder">
      <div className="sched-row">
        <label className="field-label">
          Type
          <select className="text-input" value={kind} onChange={(e) => setKind(e.target.value as RoutineSchedule['kind'])}>
            <option value="once">Once — a specific date &amp; time</option>
            <option value="daily">Daily — time + weekdays</option>
            <option value="cron">Cron — 5-field expression</option>
            <option value="interval">Interval — every N minutes</option>
          </select>
        </label>
        <label className="field-label">
          Timezone
          <TimezoneField value={timezone} onChange={setTimezone} />
        </label>
      </div>

      {kind === 'once' && (
        <label className="field-label">
          Run at <span className="muted">(in {timezone || '…'})</span>
          <input type="datetime-local" className="text-input" value={onceRunAt} onChange={(e) => setOnceRunAt(e.target.value)} />
        </label>
      )}

      {kind === 'daily' && (
        <>
          <label className="field-label">
            Time <span className="muted">(in {timezone || '…'})</span>
            <input type="time" className="text-input" value={dailyTime} onChange={(e) => setDailyTime(e.target.value)} />
          </label>
          <label className="field-label">Weekdays</label>
          <WeekdayPicker value={dailyWeekdays} onChange={setDailyWeekdays} />
        </>
      )}

      {kind === 'cron' && (
        <label className="field-label">
          Expression <span className="muted">— minute hour day-of-month month day-of-week</span>
          <input
            className="text-input mono"
            value={cronExpr}
            onChange={(e) => setCronExpr(e.target.value)}
            placeholder="0 9 * * 1-5"
            spellCheck={false}
          />
        </label>
      )}

      {kind === 'interval' && (
        <>
          <div className="sched-row">
            <label className="field-label">
              Every N minutes
              <input
                type="number"
                className="text-input"
                min={1}
                max={10080}
                value={everyMinutes}
                onChange={(e) => setEveryMinutes(e.target.value)}
              />
            </label>
            <label className="field-label">
              Anchor time <span className="muted">(optional)</span>
              <input type="time" className="text-input" value={anchorTime} onChange={(e) => setAnchorTime(e.target.value)} />
            </label>
          </div>
          <label className="check-row">
            <input type="checkbox" checked={useWindow} onChange={(e) => setUseWindow(e.target.checked)} />
            Only within a wall-clock window
          </label>
          {useWindow && (
            <div className="sched-row">
              <label className="field-label">
                Window start
                <input type="time" className="text-input" value={windowStart} onChange={(e) => setWindowStart(e.target.value)} />
              </label>
              <label className="field-label">
                Window end
                <input type="time" className="text-input" value={windowEnd} onChange={(e) => setWindowEnd(e.target.value)} />
              </label>
            </div>
          )}
          <label className="check-row">
            <input type="checkbox" checked={useWeekdays} onChange={(e) => setUseWeekdays(e.target.checked)} />
            Only on selected weekdays
          </label>
          {useWeekdays && <WeekdayPicker value={intervalWeekdays} onChange={setIntervalWeekdays} />}
          <label className="field-label">
            Ends at <span className="muted">(optional, in {timezone || '…'})</span>
            <input type="datetime-local" className="text-input" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
          </label>
        </>
      )}

      <label className="field-label">
        If a run is still going when the next one is due
        <select className="text-input" value={overlap} onChange={(e) => setOverlap(e.target.value as 'skip' | 'queue')}>
          <option value="skip">Skip the new run</option>
          <option value="queue">Run it anyway (queue)</option>
        </select>
      </label>

      {error && <p className="error">{error}</p>}
      <div className="sched-actions">
        <button type="button" className="btn-primary" onClick={() => void onSave()} disabled={busy}>
          {busy ? 'Saving…' : initial ? 'Update schedule' : 'Save schedule'}
        </button>
        <button type="button" className="btn-ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function ScheduleSection({ routine, onChanged }: { routine: Routine; onChanged: (r: Routine) => void }) {
  const [editing, setEditing] = useState(false);
  const [runs, setRuns] = useState<NextRun[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const loadRuns = useCallback(async () => {
    if (!routine.schedule) {
      setRuns(null);
      return;
    }
    try {
      const res = await api<{ runs: NextRun[] }>(
        `/api/routines/${encodeURIComponent(routine.id)}/next-runs?n=5`,
      );
      setRuns(res.runs);
    } catch {
      setRuns(null);
    }
  }, [routine.id, routine.schedule]);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns, routine.schedule]);

  const toggleEnabled = async () => {
    if (!routine.schedule) return;
    setBusy(true);
    setError('');
    try {
      const action = routine.schedule.enabled ? 'disable' : 'enable';
      const res = await api<{ routine: Routine }>(
        `/api/routines/${encodeURIComponent(routine.id)}/schedule/${action}`,
        { method: 'POST' },
      );
      onChanged(res.routine);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Toggle failed');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await api<{ routine: Routine }>(`/api/routines/${encodeURIComponent(routine.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ schedule: null }),
      });
      onChanged(res.routine);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Remove failed');
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <ScheduleBuilder
        routineId={routine.id}
        initial={routine.schedule ?? null}
        onSaved={(r) => {
          onChanged(r);
          setEditing(false);
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }

  if (!routine.schedule) {
    return (
      <div className="schedule-empty">
        <p className="muted small">No schedule — this routine only fires via webhook or manually.</p>
        <button type="button" className="btn-ghost small" onClick={() => setEditing(true)}>
          ＋ Add schedule
        </button>
      </div>
    );
  }

  const s = routine.schedule;
  return (
    <div className="schedule-summary">
      <div className="sched-head">
        <span className={`routine-badge${s.enabled ? '' : ' paused'}`}>{s.enabled ? 'scheduled' : 'paused'}</span>
        <code className="mono small">{describeScheduleClient(s)}</code>
      </div>
      <p className="muted small">
        Timezone <code>{s.timezone}</code>
        {' · '}overlap: <code>{s.overlap}</code>
      </p>
      {runs && runs.length > 0 && (
        <div className="next-runs">
          <label className="field-label">Next runs</label>
          <ul>
            {runs.map((r) => (
              <li key={r.at}>
                <code className="mono small">{r.label}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
      {runs && runs.length === 0 && (
        <p className="muted small">No upcoming runs (a one-shot schedule in the past, or past its end).</p>
      )}
      {error && <p className="error">{error}</p>}
      <div className="sched-actions">
        <button type="button" className="btn-ghost small" onClick={() => void toggleEnabled()} disabled={busy}>
          {s.enabled ? 'Pause schedule' : 'Resume schedule'}
        </button>
        <button type="button" className="btn-ghost small" onClick={() => setEditing(true)} disabled={busy}>
          Edit
        </button>
        <button type="button" className="btn-ghost small danger" onClick={() => void remove()} disabled={busy}>
          Remove
        </button>
      </div>
    </div>
  );
}

function RoutineRow({ routine, botId, onChanged }: { routine: Routine; botId: string; onChanged: (r: Routine) => void }) {
  const [open, setOpen] = useState(false);
  const [hook, setHook] = useState<HookInfo | null>(null);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const [confirmRegen, setConfirmRegen] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const [h, d] = await Promise.all([
        api<{ hook: HookInfo }>(`/api/routines/${encodeURIComponent(routine.id)}/hook`),
        api<{ deliveries: Delivery[] }>(`/api/routines/${encodeURIComponent(routine.id)}/deliveries?limit=20`),
      ]);
      setHook(h.hook);
      setDeliveries(d.deliveries);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load webhook info');
    } finally {
      setBusy(false);
    }
  }, [routine.id]);

  useEffect(() => {
    if (open && !hook) void load();
  }, [open, hook, load]);

  const onReveal = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await api<{ hook: HookInfo }>(`/api/routines/${encodeURIComponent(routine.id)}/hook/reveal`, {
        method: 'POST',
      });
      setHook(res.hook);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reveal failed');
    } finally {
      setBusy(false);
    }
  };

  const onRegenerate = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await api<{ hook: HookInfo }>(`/api/routines/${encodeURIComponent(routine.id)}/hook/regenerate`, {
        method: 'POST',
      });
      setHook(res.hook);
      setConfirmRegen(false);
      void loadDeliveries();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Regenerate failed');
    } finally {
      setBusy(false);
    }
  };

  const loadDeliveries = useCallback(async () => {
    try {
      const d = await api<{ deliveries: Delivery[] }>(
        `/api/routines/${encodeURIComponent(routine.id)}/deliveries?limit=20`,
      );
      setDeliveries(d.deliveries);
    } catch {
      // ignore — non-fatal
    }
  }, [routine.id]);

  const doCopy = (label: string, text: string) => copyText(text, () => {
    setCopied(label);
    setTimeout(() => setCopied(''), 1500);
  });

  const displayUrl = hook?.url ?? hook?.localUrl ?? '';

  return (
    <div className="routine-row">
      <button
        type="button"
        className="routine-row-head"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="routine-name">{routine.name}</span>
        <span className={`routine-badge${routine.enabled ? '' : ' paused'}`}>
          {routine.enabled ? 'on' : 'paused'}
        </span>
        {routine.schedule && (
          <span className={`routine-badge${routine.schedule.enabled ? '' : ' paused'}`} title={routine.schedule ? describeScheduleClient(routine.schedule) : ''}>
            ⏰ {routine.schedule.enabled ? 'scheduled' : 'sched. paused'}
          </span>
        )}
        {routine.nextRunAt && (
          <span className="muted small" title={new Date(routine.nextRunAt).toString()}>
            next {new Date(routine.nextRunAt).toLocaleString()}
          </span>
        )}
        {hook?.connected && <span className="routine-badge connected">connected</span>}
        <span className="routine-chev">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="routine-detail">
          {busy && !hook && <p className="muted">Loading…</p>}
          {error && <p className="error">{error}</p>}
          <ScheduleSection routine={routine} onChanged={onChanged} />
          <hr className="section-sep" />
          {hook && (
            <>
              <label className="field-label">
                Public webhook URL
                <span className="muted"> — POST JSON here to run the routine</span>
              </label>
              <div className="copy-row">
                <code className="url-box">{displayUrl}</code>
                <button type="button" className="btn-ghost" onClick={() => doCopy('url', displayUrl)}>
                  {copied === 'url' ? 'Copied ✓' : 'Copy'}
                </button>
              </div>
              {!hook.url && (
                <p className="muted small">
                  Public URL is unset — set <code>KRIYADOT_PUBLIC_URL</code> and use a tunnel
                  (Tailscale / cloudflared / ngrok) so external senders can reach this PC.
                  LAN senders can use the local URL above.
                </p>
              )}
              <label className="field-label">Secret</label>
              <div className="copy-row">
                {hook.secret ? (
                  <>
                    <code className="url-box secret">{hook.secret}</code>
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => doCopy('secret', hook.secret as string)}
                    >
                      {copied === 'secret' ? 'Copied ✓' : 'Copy'}
                    </button>
                  </>
                ) : (
                  <>
                    <code className="url-box secret masked">•••••••• (hidden)</code>
                    <button type="button" className="btn-ghost" onClick={onReveal} disabled={busy}>
                      Reveal
                    </button>
                  </>
                )}
                {confirmRegen ? (
                  <>
                    <button type="button" className="btn-danger" onClick={onRegenerate} disabled={busy}>
                      Confirm regenerate
                    </button>
                    <button type="button" className="btn-ghost" onClick={() => setConfirmRegen(false)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <button type="button" className="btn-ghost" onClick={() => setConfirmRegen(true)}>
                    Regenerate
                  </button>
                )}
              </div>
              <p className="muted small">
                GitHub: paste the URL as the payload URL, content type{' '}
                <code>application/json</code>, secret = the key above. The routine also
                accepts <code>Authorization: Bearer &lt;secret&gt;</code> or an{' '}
                <code>X-Signature-256</code> HMAC.
              </p>

              <div className="deliveries-head">
                <label className="field-label">Recent deliveries</label>
                <button type="button" className="btn-ghost small" onClick={() => void loadDeliveries()}>
                  Refresh
                </button>
              </div>
              {deliveries.length === 0 ? (
                <p className="muted small">No deliveries yet.</p>
              ) : (
                <table className="deliveries-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Event</th>
                      <th>Status</th>
                      <th>Tries</th>
                    </tr>
                  </thead>
                  <tbody>
                    {deliveries.map((d) => (
                      <tr key={d.id} title={d.error ?? ''}>
                        <td>{new Date(d.createdAt).toLocaleString()}</td>
                        <td>
                          <code>{d.eventType}</code>
                        </td>
                        <td>{STATUS_LABEL[d.status]}</td>
                        <td>{d.attempts}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function RoutinesPanel({ botId }: { botId: string }) {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const res = await api<{ routines: Routine[] }>('/api/routines');
      setRoutines(res.routines.filter((r) => r.botId === botId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load routines');
    } finally {
      setBusy(false);
    }
  }, [botId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onRoutineChanged = useCallback((updated: Routine) => {
    setRoutines((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
  }, []);

  return (
    <section className="panel routines-panel" aria-label="Routines and webhooks">
      <div className="panel-head">
        <h3>🔁 Routines & webhooks</h3>
        <button type="button" className="btn-ghost small" onClick={() => void refresh()} disabled={busy}>
          Refresh
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {busy && routines.length === 0 && <p className="muted">Loading…</p>}
      {!busy && routines.length === 0 && !error && (
        <p className="muted small">
          No routines for this bot yet. Ask the bot “I want a routine that…” to create one —
          each routine gets a public webhook URL automatically.
        </p>
      )}
      {routines.map((r) => (
        <RoutineRow key={r.id} routine={r} botId={botId} onChanged={onRoutineChanged} />
      ))}
    </section>
  );
}
