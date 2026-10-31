// SPDX-License-Identifier: Apache-2.0
'use client';

// Activity → Work (Muse parity audit §2 + §4.1, ACT-1..ACT-10): the
// consumer view of agent work. A header with the companion's avatar, its
// name, and one live plain-language status sentence; below it, a
// day-grouped list of what the agent did, titled in the user's own words.
// Status is shown with icons (animated while running), not text chips.
// Clicking a row opens the run: a plain-language summary header on top of
// the existing recorded trace (waterfall + replay) for observability runs.
//
// Data: GET /api/work-panel/live, /api/work-panel/items,
// /api/work-panel/runs/:runId (apps/api/src/work-panel.ts).

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { authedFetch } from '../../lib/api';
import { petDisplayName, usePet, type PetMood } from '../../lib/pet';
import { Pet } from '../pet/Pet';
import { RunsPanel } from './runs-panel';
import { fmtCents, fmtDuration } from './runs-waterfall';
import { useCollapsed } from '../../lib/use-collapsed';
import { CollapseChevron } from '../collapse';

export type WorkItemStatus =
  | 'running'
  | 'writing'
  | 'queued'
  | 'completed'
  | 'failed'
  | 'needs-input'
  | 'cancelled';

export interface WorkItem {
  runId: string;
  source: 'observability' | 'routine' | 'background';
  title: string;
  outcome: string;
  status: WorkItemStatus;
  timestamp: number;
  endedAt: number | null;
  botId: string;
  botName: string;
  sessionId?: string;
  attempts: Array<Record<string, unknown>>;
}

export interface WorkDayGroup {
  date: string;
  label: string;
  items: WorkItem[];
}

export interface LiveStatusData {
  sentence: string;
  idle: boolean;
  runningCount: number;
  running: WorkItem[];
  generatedAt: number;
}

export interface WorkRunSummary {
  runId: string;
  source: string;
  title: string;
  asked: string;
  happened: string;
  outcome: string;
  status: WorkItemStatus;
  botId: string;
  botName: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  costCents: number | null;
  attempts: Array<Record<string, unknown>>;
}

async function apiJson<T>(path: string): Promise<T> {
  const res = await authedFetch(path);
  if (!res.ok) throw new Error(`${res.status}: ${await res.text().catch(() => res.statusText)}`);
  return res.json() as Promise<T>;
}

export function isActiveWorkStatus(status: WorkItemStatus): boolean {
  return status === 'running' || status === 'writing' || status === 'queued';
}

// ---------------------------------------------------------------------------
// Status iconography (ACT-4) — icons only in this view, no outcome chips.
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<WorkItemStatus, string> = {
  running: 'Running',
  writing: 'Writing',
  queued: 'Queued',
  completed: 'Completed',
  failed: 'Failed',
  'needs-input': 'Needs your input',
  cancelled: 'Stopped',
};

export function StatusIcon({ status, size = 20 }: { status: WorkItemStatus; size?: number }) {
  const label = STATUS_LABEL[status];
  if (status === 'running') {
    return (
      <span
        role="img"
        aria-label={label}
        title={label}
        data-status-icon="running"
        className="work-status-icon work-status-running"
        style={{ width: size, height: size }}
      />
    );
  }
  if (status === 'writing') {
    return (
      <svg
        role="img"
        aria-label={label}
        data-status-icon="writing"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--accent, #7c6cf0)"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <title>{label}</title>
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
        <path d="M14 3v5h5" />
        <path d="M9 13h6M9 17h4" className="work-writing-lines" />
      </svg>
    );
  }
  if (status === 'completed') {
    return (
      <svg
        role="img"
        aria-label={label}
        data-status-icon="completed"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--green, #16a34a)"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <title>{label}</title>
        <circle cx="12" cy="12" r="9" />
        <path d="m8.5 12.5 2.5 2.5 5-5.5" />
      </svg>
    );
  }
  if (status === 'failed') {
    return (
      <svg
        role="img"
        aria-label={label}
        data-status-icon="failed"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--red, #dc2626)"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <title>{label}</title>
        <circle cx="12" cy="12" r="9" />
        <path d="m9 9 6 6M15 9l-6 6" />
      </svg>
    );
  }
  if (status === 'needs-input') {
    return (
      <svg
        role="img"
        aria-label={label}
        data-status-icon="needs-input"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--amber, #d97706)"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <title>{label}</title>
        <circle cx="12" cy="12" r="9" />
        <path d="M9.5 9.3A2.6 2.6 0 1 1 12 12.4c-.8.25-1 .8-1 1.6" />
        <circle cx="12" cy="17" r="0.5" fill="var(--amber, #d97706)" />
      </svg>
    );
  }
  // queued / cancelled: a quiet clock / stop circle.
  return (
    <svg
      role="img"
      aria-label={label}
      data-status-icon={status}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--muted, #888)"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <title>{label}</title>
      <circle cx="12" cy="12" r="9" />
      {status === 'queued' ? <path d="M12 7v5l3 2" /> : <path d="M9 9h6v6H9z" />}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Header (ACT-1 + ACT-10) — presentational, unit-tested without fetching.
// ---------------------------------------------------------------------------

export function WorkPanelHeader({
  petId,
  agentName,
  sentence,
  idle,
}: {
  petId: Parameters<typeof Pet>[0]['pet'];
  agentName: string;
  sentence: string;
  idle: boolean;
}) {
  const mood: PetMood = idle ? 'idle' : 'working';
  return (
    <div
      data-testid="work-panel-header"
      className="card"
      style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}
    >
      <Pet pet={petId} size={52} mood={mood} variant="2d" label={agentName} />
      <div style={{ flex: 1, minWidth: 200 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 17 }}>{agentName}</strong>
          <Link href="/preferences" className="small" aria-label="Edit companion avatar and name">
            Edit
          </Link>
        </div>
        <p data-testid="live-status-sentence" className="small" style={{ margin: '4px 0 0' }} aria-live="polite">
          {sentence}
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rows + day groups (ACT-3 / ACT-5 / ACT-8) — presentational.
// ---------------------------------------------------------------------------

export function WorkItemRow({
  item,
  selected = false,
  onSelect,
}: {
  item: WorkItem;
  selected?: boolean;
  onSelect?: (item: WorkItem) => void;
}) {
  const active = isActiveWorkStatus(item.status);
  return (
    <li
      data-testid="work-item-row"
      data-run-id={item.runId}
      data-status={item.status}
      className={`card work-row${active ? ' work-row-running' : ''}${selected ? ' work-row-selected' : ''}`}
      style={{
        marginBottom: 8,
        cursor: onSelect ? 'pointer' : undefined,
        ...(active
          ? { borderColor: 'var(--accent, #7c6cf0)', boxShadow: '0 0 0 1px var(--accent, #7c6cf0)' }
          : {}),
        ...(selected ? { outline: '2px solid var(--accent, #7c6cf0)' } : {}),
      }}
      onClick={onSelect ? () => onSelect(item) : undefined}
      onKeyDown={
        onSelect
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect(item);
              }
            }
          : undefined
      }
      role={onSelect ? 'button' : undefined}
      tabIndex={onSelect ? 0 : undefined}
      aria-label={`${item.title} — ${STATUS_LABEL[item.status]}`}
    >
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <StatusIcon status={item.status} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.title}</div>
          <div className="small muted" style={{ marginTop: 2 }}>
            {item.outcome}
          </div>
          <div className="small muted" style={{ marginTop: 2 }}>
            {item.botName} · {new Date(item.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
            {item.attempts.length > 1 ? ` · tried ${item.attempts.length} times` : ''}
          </div>
        </div>
      </div>
    </li>
  );
}

export function WorkDayGroupView({
  group,
  selectedRunId,
  onSelect,
}: {
  group: WorkDayGroup;
  selectedRunId?: string | null;
  onSelect?: (item: WorkItem) => void;
}) {
  // Collapse pass: each day group collapses/expands with the shared
  // pattern, persisted per day (`kriyadot:collapse:work-day:<date>`).
  const dayCol = useCollapsed(`work-day:${group.date}`);
  return (
    <section data-testid="work-day-group" data-day-label={group.label} aria-label={group.label}>
      <h3 className="small" style={{ margin: '16px 0 8px', textTransform: 'uppercase', letterSpacing: 0.4 }}>
        <button
          type="button"
          className="work-day-head"
          aria-expanded={!dayCol.collapsed}
          onClick={dayCol.toggle}
          title={dayCol.collapsed ? `Show ${group.label}` : `Hide ${group.label}`}
        >
          <CollapseChevron collapsed={dayCol.collapsed} />
          <span>{group.label}</span>
          <span className="work-day-count">
            {group.items.length} {group.items.length === 1 ? 'item' : 'items'}
          </span>
        </button>
      </h3>
      {!dayCol.collapsed && (
        <ul className="list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {group.items.map((item) => (
            <WorkItemRow
              key={`${item.source}:${item.runId}`}
              item={item}
              selected={selectedRunId === item.runId}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Run detail: plain-language summary header (ACT-6) over the recorded trace.
// ---------------------------------------------------------------------------

export function RunSummaryHeader({ summary }: { summary: WorkRunSummary }) {
  return (
    <div data-testid="run-summary-header" className="card">
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <StatusIcon status={summary.status} size={24} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <strong style={{ fontSize: 16 }}>{summary.title}</strong>
          <p className="small" style={{ margin: '6px 0 0' }}>
            <strong>You asked:</strong> {summary.asked}
          </p>
          <p className="small" style={{ margin: '4px 0 0' }}>
            <strong>What happened:</strong> {summary.happened}
          </p>
          <p className="small muted" style={{ margin: '6px 0 0' }}>
            {summary.botName} · {new Date(summary.startedAt).toLocaleString()} · took{' '}
            {fmtDuration(summary.durationMs)}
            {summary.costCents !== null ? ` · cost ${fmtCents(summary.costCents)}` : ''}
            {summary.attempts.length > 1 ? ` · tried ${summary.attempts.length} times` : ''}
          </p>
        </div>
      </div>
    </div>
  );
}

function WorkRunDetail({ item, onBack }: { item: WorkItem; onBack: () => void }) {
  const [summary, setSummary] = useState<WorkRunSummary | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    apiJson<{ summary: WorkRunSummary }>(`/api/work-panel/runs/${encodeURIComponent(item.runId)}`)
      .then((data) => {
        if (!cancelled) setSummary(data.summary);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [item.runId]);

  return (
    <div>
      <button type="button" className="btn btn-sm" onClick={onBack}>
        ← All work
      </button>
      {error && <div className="error" style={{ marginTop: 12 }}>{error}</div>}
      {!summary && !error && <p className="muted">Loading summary…</p>}
      {summary && (
        <div style={{ marginTop: 12 }}>
          <RunSummaryHeader summary={summary} />
        </div>
      )}
      {item.source === 'observability' ? (
        <div style={{ marginTop: 16 }}>
          <RunsPanel initialRunId={item.runId} />
        </div>
      ) : (
        <p className="small muted" style={{ marginTop: 12 }}>
          This was a {item.source === 'routine' ? 'scheduled task' : 'background job'} — the summary
          above is the full record for it.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel (fetching wrapper)
// ---------------------------------------------------------------------------

const WORK_PANEL_CSS = `
@keyframes work-spin { to { transform: rotate(360deg); } }
@keyframes work-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
.work-status-running {
  display: inline-block; flex-shrink: 0; border-radius: 50%;
  border: 2.5px solid var(--track, rgba(127,127,127,0.3));
  border-top-color: var(--accent, #7c6cf0);
  animation: work-spin 0.9s linear infinite;
}
.work-writing-lines { animation: work-pulse 1.4s ease-in-out infinite; }
`;

export function WorkPanel({ variant = 'grouped' }: { variant?: 'grouped' | 'history' }) {
  const { choice } = usePet();
  const agentName = petDisplayName(choice);
  const [live, setLive] = useState<LiveStatusData | null>(null);
  const [groups, setGroups] = useState<WorkDayGroup[]>([]);
  const [flatItems, setFlatItems] = useState<WorkItem[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<WorkItem | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const [liveData, itemsData] = await Promise.all([
        apiJson<LiveStatusData>('/api/work-panel/live'),
        apiJson<{ groups: WorkDayGroup[]; items: WorkItem[] }>('/api/work-panel/items'),
      ]);
      setLive(liveData);
      setGroups(itemsData.groups);
      setFlatItems(itemsData.items);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // ACT-5: while anything is running, keep the list fresh on its own.
  const anythingRunning = (live?.runningCount ?? 0) > 0;
  useEffect(() => {
    if (!anythingRunning) return;
    timer.current = setInterval(() => {
      void load();
    }, 4000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [anythingRunning, load]);

  if (selected) {
    return <WorkRunDetail item={selected} onBack={() => setSelected(null)} />;
  }

  const sentence = live?.sentence ?? (loading ? 'Checking what is running…' : 'Nothing running right now');

  return (
    <div data-testid="work-panel">
      <style>{WORK_PANEL_CSS}</style>
      <WorkPanelHeader petId={choice.id} agentName={agentName} sentence={sentence} idle={live?.idle ?? true} />
      {error && <div className="error" style={{ marginTop: 12 }}>{error}</div>}
      {loading && !live && <p className="muted">Loading work…</p>}
      {!loading && !error && flatItems.length === 0 && (
        <p className="muted" style={{ marginTop: 14 }}>
          Nothing here yet — when your agent does something for you, it will show up here in plain words.
        </p>
      )}
      {variant === 'history' ? (
        <ul className="list" style={{ listStyle: 'none', padding: 0, margin: '14px 0 0' }}>
          {flatItems.map((item) => (
            <WorkItemRow key={`${item.source}:${item.runId}`} item={item} onSelect={setSelected} />
          ))}
        </ul>
      ) : (
        groups.map((group) => (
          <WorkDayGroupView key={group.date} group={group} onSelect={setSelected} />
        ))
      )}
    </div>
  );
}
