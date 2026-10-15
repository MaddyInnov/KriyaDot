// SPDX-License-Identifier: Apache-2.0
// Live runtime meter ("eyes for your AI"): a human-readable, server-rendered
// health page mounted at `/_kriyadot/` on the API server. Dependency-free —
// plain HTML string, no framework, no JS; auto-refreshes via meta refresh.
//
// Shows queue depth, in-flight turns, latency percentiles, error/retry
// rates, token cost, per-bot activity, and recent runs — all from the
// in-memory TelemetryCollector (metadata-tier only). Deliberately NOT part
// of the web app's 6 top-level nav destinations: it is server-side only.
//
// PII posture: the page renders counts, ids, and normalized names only.
// Queue depth is a number — message bodies are never rendered.

import type {
  TelemetryBotSummary,
  TelemetryCollector,
  TelemetryRunRecord,
  TelemetrySummary,
} from '@mvp/agent-runtime';

export interface KriyaDotMeterInput {
  /** Platform version string shown in the header. */
  version: string;
  /** Number of chat messages currently waiting in the queue. */
  queueDepth: number;
  /** Live telemetry collector (read-only access). */
  telemetry: TelemetryCollector;
}

/** Escape everything interpolated into the HTML. */
function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function fmtPct(ratio: number): string {
  if (!Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(1)}%`;
}

function fmtUsd(usd: number): string {
  if (!Number.isFinite(usd)) return '—';
  return `$${usd.toFixed(4)}`;
}

function fmtInt(n: number): string {
  return Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—';
}

function fmtTime(ts: number | null): string {
  if (ts === null || !Number.isFinite(ts)) return '—';
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

function shortId(id: string): string {
  return id.length > 20 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id;
}

function statusBadge(status: TelemetryRunRecord['status']): string {
  const cls =
    status === 'ok' ? 'ok' : status === 'running' ? 'run' : status === 'interrupted' ? 'warn' : 'err';
  return `<span class="badge ${cls}">${esc(status)}</span>`;
}

function summaryCards(summary: TelemetrySummary, queueDepth: number): string {
  const cards: Array<[string, string]> = [
    ['Queue depth', fmtInt(queueDepth)],
    ['Active turns', fmtInt(summary.inflight)],
    ['Runs (window)', fmtInt(summary.windowRuns)],
    ['Error rate', fmtPct(summary.errorRate)],
    ['Retry rate', fmtPct(summary.retryRate)],
    ['p50 latency', fmtMs(summary.p50LatencyMs)],
    ['p95 latency', fmtMs(summary.p95LatencyMs)],
    ['Tokens (window)', fmtInt(summary.totalTokens)],
    ['Cost (window)', fmtUsd(summary.totalCostUsd)],
  ];
  return cards
    .map(
      ([label, value]) =>
        `<div class="card"><div class="card-label">${esc(label)}</div><div class="card-value">${esc(value)}</div></div>`,
    )
    .join('');
}

function botTable(bots: TelemetryBotSummary[]): string {
  if (bots.length === 0) return '<p class="empty">No completed runs yet.</p>';
  const rows = bots
    .map(
      (b) => `<tr>
        <td><code>${esc(b.id)}</code></td>
        <td class="num">${fmtInt(b.runs)}</td>
        <td class="num">${fmtPct(b.errorRate)}</td>
        <td class="num">${fmtMs(b.avgLatencyMs)}</td>
        <td class="num">${fmtInt(b.totalTokens)}</td>
        <td class="num">${fmtUsd(b.totalCostUsd)}</td>
        <td>${esc(fmtTime(b.lastSeenAt))}</td>
      </tr>`,
    )
    .join('');
  return `<table>
    <thead><tr><th>Bot</th><th>Runs</th><th>Err %</th><th>Avg latency</th><th>Tokens</th><th>Cost</th><th>Last seen</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function runTable(runs: TelemetryRunRecord[]): string {
  if (runs.length === 0) return '<p class="empty">No runs recorded yet.</p>';
  const rows = runs
    .map((r) => {
      const who = r.kind === 'bot-turn' ? (r.botId ?? '—') : (r.workflowId ?? '—');
      const failedSteps = r.steps.filter((s) => !s.ok).length;
      return `<tr>
        <td><code title="${esc(r.id)}">${esc(shortId(r.id))}</code></td>
        <td>${esc(r.kind)}</td>
        <td><code>${esc(who)}</code></td>
        <td>${statusBadge(r.status)}</td>
        <td class="num">${fmtMs(r.durationMs ?? 0)}</td>
        <td class="num">${fmtInt(r.steps.length)}${failedSteps > 0 ? ` <span class="err-step">(${fmtInt(failedSteps)} failed)</span>` : ''}</td>
        <td class="num">${fmtInt(r.totalTokens)}</td>
        <td class="num">${fmtUsd(r.costUsd)}</td>
        <td class="num">${fmtInt(r.retries)}</td>
      </tr>`;
    })
    .join('');
  return `<table>
    <thead><tr><th>Run</th><th>Kind</th><th>Bot / workflow</th><th>Status</th><th>Duration</th><th>Steps</th><th>Tokens</th><th>Cost</th><th>Retries</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/**
 * Render the full `/_kriyadot/` page. Pure function of the collector snapshot
 * (plus queue depth) — no I/O, no secrets, no message bodies.
 */
export function renderKriyaDotMeter(input: KriyaDotMeterInput): string {
  const summary = input.telemetry.summary();
  const bots = input.telemetry.botSummaries();
  const recent = input.telemetry.listRuns({ limit: 25 });
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + 'Z';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="5">
<title>KriyaDot runtime meter</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #0d1117; color: #c9d1d9; margin: 0; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 14px; margin: 28px 0 10px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.08em; }
  .sub { color: #8b949e; font-size: 12px; margin-bottom: 20px; }
  .cards { display: flex; flex-wrap: wrap; gap: 10px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 10px 14px; min-width: 120px; }
  .card-label { font-size: 11px; color: #8b949e; margin-bottom: 4px; }
  .card-value { font-size: 20px; font-weight: 600; }
  table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid #21262d; }
  th { color: #8b949e; font-weight: 600; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  th:nth-child(n+4), td:nth-child(n+4) { text-align: right; }
  code { background: #161b22; padding: 1px 5px; border-radius: 4px; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
  .badge.ok { background: #1a3a24; color: #3fb950; }
  .badge.run { background: #1c2f4a; color: #58a6ff; }
  .badge.warn { background: #3a2f16; color: #d29922; }
  .badge.err { background: #3d1d1d; color: #f85149; }
  .err-step { color: #f85149; }
  .empty { color: #8b949e; font-size: 13px; }
  .foot { margin-top: 32px; color: #6e7681; font-size: 11px; }
  a { color: #58a6ff; }
</style>
</head>
<body>
  <h1>KriyaDot runtime meter</h1>
  <div class="sub">v${esc(input.version)} &middot; ${esc(now)} &middot; auto-refreshes every 5 s &middot; read-only telemetry (metadata only)</div>

  <h2>Live</h2>
  <div class="cards">${summaryCards(summary, input.queueDepth)}</div>

  <h2>Per-bot activity</h2>
  ${botTable(bots)}

  <h2>Recent runs</h2>
  ${runTable(recent)}

  <div class="foot">Raw data: MCP resources <code>kriyadot://telemetry/summary</code>, <code>kriyadot://telemetry/runs</code>, <code>kriyadot://telemetry/bots</code> (read-only). JSON health: <a href="/api/health">/api/health</a>.</div>
</body>
</html>`;
}
