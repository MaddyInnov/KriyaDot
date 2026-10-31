// SPDX-License-Identifier: Apache-2.0
'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  exportN8nWorkflow,
  getRunHealth,
  getRuns,
  getWorkflows,
  importN8nWorkflow,
  runWorkflow,
} from '../../lib/api';
import type {
  HealthScore,
  RunHealth,
  UnmappedN8nNode,
  WorkflowDefinition,
  WorkflowRun,
} from '../../lib/api';
import {
  dryRunWorkflowById,
  dryRunWorkflowDefinition,
  exportWorkflowFile,
  importWorkflowFile,
  isAbsent,
} from '../../lib/octomind-api';
import {
  detectWorkflowFileKind,
  normalizeDryRunPlan,
  parseWorkflowJsonFile,
  serializeWorkflowJson,
  serializeWorkflowToml,
  type DryRunView,
} from '../../lib/octomind-web';
import { GuideHint } from '../../components/guide/hint';
import { useCollapsed } from '../../lib/use-collapsed';
import { CollapseChevron } from '../../components/collapse';

function downloadText(filename: string, text: string, type: string) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function fmtTs(ts: number): string {
  return new Date(ts).toLocaleString();
}

function statusChip(status: WorkflowRun['status']) {
  const cls =
    status === 'succeeded' ? 'green' : status === 'failed' ? 'red' : status === 'paused' ? 'amber' : 'blue';
  return <span className={`chip ${cls}`}>{status}</span>;
}

/** Run-health verdict chip (feature #2): turns the runs log into a coach. */
function healthChip(score?: HealthScore) {
  if (!score) return <span className="chip gray">—</span>;
  const cls = score === 'good' ? 'green' : score === 'needs-work' ? 'amber' : 'red';
  const label = score === 'good' ? 'Good' : score === 'needs-work' ? 'Needs work' : 'Poor';
  return <span className={`chip ${cls}`}>{label}</span>;
}

const SEVERITY_CLS: Record<string, string> = { critical: 'red', warning: 'amber', info: 'gray' };

export default function WorkflowsPage() {
  const router = useRouter();
  const [defs, setDefs] = useState<WorkflowDefinition[]>([]);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState<string>('');
  // Per-definition run form state.
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [idemKeys, setIdemKeys] = useState<Record<string, string>>({});
  // Expandable health diagnosis per run (feature #2).
  const [expanded, setExpanded] = useState<string | null>(null);
  const [diagnoses, setDiagnoses] = useState<Record<string, RunHealth>>({});
  const [diagLoading, setDiagLoading] = useState<string | null>(null);
  // n8n interchange.
  const [importing, setImporting] = useState(false);
  const [importReport, setImportReport] = useState<UnmappedN8nNode[] | null>(null);
  const [importedName, setImportedName] = useState('');
  const [exportingId, setExportingId] = useState('');
  // kriyadot.workflow file import/export (#143) + dry-run (#151).
  const [fileBusy, setFileBusy] = useState(false);
  const [fileNote, setFileNote] = useState('');
  const [dryRunFor, setDryRunFor] = useState<WorkflowDefinition | null>(null);
  const [dryRunView, setDryRunView] = useState<DryRunView | null>(null);
  const [dryRunBusy, setDryRunBusy] = useState(false);
  const [dryRunError, setDryRunError] = useState('');
  // Declutter: definitions are the primary focus; run history is one tab away.
  const [view, setView] = useState<'workflows' | 'runs'>('workflows');
  // Collapse pass: the dry-run plan card collapses to its header with the
  // shared pattern (`kriyadot:collapse:wf-dryrun`).
  const dryCol = useCollapsed('wf-dryrun');

  const refresh = useCallback(async () => {
    try {
      const [d, r] = await Promise.all([getWorkflows(), getRuns()]);
      setDefs(d);
      setRuns(r);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const toggleDiagnosis = (runId: string) => {
    if (expanded === runId) {
      setExpanded(null);
      return;
    }
    setExpanded(runId);
    if (!diagnoses[runId] && diagLoading !== runId) {
      setDiagLoading(runId);
      getRunHealth(runId)
        .then((h) => setDiagnoses((d) => ({ ...d, [runId]: h })))
        .catch((err) => setError(err instanceof Error ? err.message : String(err)))
        .finally(() => setDiagLoading(null));
    }
  };

  const start = async (def: WorkflowDefinition) => {    const rawInput = (inputs[def.id] ?? '').trim();
    let input: unknown;
    if (rawInput) {
      try {
        input = JSON.parse(rawInput) as unknown;
      } catch {
        setError(`Invalid JSON input for workflow "${def.id}"`);
        return;
      }
    }
    const idem = (idemKeys[def.id] ?? '').trim() || undefined;
    setStarting(def.id);
    try {
      const { runId } = await runWorkflow(def.id, input, idem);
      router.push(`/workflows/${runId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting('');
    }
  };

  /** Import a kriyadot.workflow file (JSON or TOML) via the import-file endpoint. */
  const importKriyadotFile = async (file: File) => {
    setFileBusy(true);
    setFileNote('');
    setError('');
    try {
      const text = await file.text();
      const format = detectWorkflowFileKind(text, file.name);
      if (format === 'json') parseWorkflowJsonFile(text); // local validation → clear errors before upload
      const res = await importWorkflowFile({ format, content: text, filename: file.name });
      const name = (res.workflow as { name?: string } | undefined)?.name ?? file.name;
      setFileNote(`Imported workflow file "${name}" (${format.toUpperCase()}).`);
      await refresh();
    } catch (err) {
      setError(
        isAbsent(err)
          ? 'Workflow file import is not available yet: POST /api/workflows/import has not landed on this API. The file was validated locally only; nothing was registered.'
          : err instanceof Error ? err.message : String(err),
      );
    } finally {
      setFileBusy(false);
    }
  };

  /** Export one workflow as a kriyadot.workflow file; local serializer is the fallback. */
  const exportKriyadotFile = async (def: WorkflowDefinition, format: 'json' | 'toml') => {
    setFileBusy(true);
    setError('');
    try {
      let text: string;
      try {
        text = await exportWorkflowFile(def.id, format);
      } catch (err) {
        if (!isAbsent(err)) throw err;
        // Endpoint absent: serialize the definition we already hold locally.
        text = format === 'json' ? serializeWorkflowJson(def) : serializeWorkflowToml(def);
      }
      downloadText(`${def.id}.workflow.${format === 'json' ? 'json' : 'toml'}`, text, format === 'json' ? 'application/json' : 'text/plain');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setFileBusy(false);
    }
  };

  /** Dry-run (#151): ask the API for the execution plan — spawns nothing. */
  const dryRun = async (def: WorkflowDefinition) => {
    setDryRunFor(def);
    setDryRunView(null);
    setDryRunError('');
    setDryRunBusy(true);
    try {
      let raw: unknown;
      try {
        raw = await dryRunWorkflowById(def.id);
      } catch (err) {
        if (!isAbsent(err)) throw err;
        raw = await dryRunWorkflowDefinition(def);
      }
      setDryRunView(normalizeDryRunPlan(raw));
    } catch (err) {
      setDryRunError(
        isAbsent(err)
          ? 'Workflow dry-run is not available yet: neither POST /api/workflows/:id/dry-run nor POST /api/workflows/dry-run has landed on this API. Nothing was run.'
          : err instanceof Error ? err.message : String(err),
      );
    } finally {
      setDryRunBusy(false);
    }
  };

  const importFile = async (file: File) => {
    setImporting(true);
    setImportReport(null);
    setImportedName('');
    try {
      const text = await file.text();
      const n8nJson = JSON.parse(text) as unknown;
      const { workflow, unmapped } = await importN8nWorkflow(n8nJson);
      setImportedName(workflow.name);
      setImportReport(unmapped);
      setError('');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  };

  const exportFile = async (def: WorkflowDefinition) => {
    setExportingId(def.id);
    try {
      const n8nJson = await exportN8nWorkflow(def.id);
      const blob = new Blob([JSON.stringify(n8nJson, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${def.id}-n8n.json`;
      a.click();
      URL.revokeObjectURL(url);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setExportingId('');
    }
  };

  return (
    <div>
      <h1 className="page-title">Workflows</h1>
      <p className="page-sub dc-compact-sub">Registered workflow definitions and their runs.</p>
      {error && <div className="error-box">{error}</div>}

      <div className="tabs" role="tablist" aria-label="Workflows sections">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'workflows'}
          className={`tab${view === 'workflows' ? ' active' : ''}`}
          onClick={() => setView('workflows')}
        >
          Workflows
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'runs'}
          className={`tab${view === 'runs' ? ' active' : ''}`}
          onClick={() => setView('runs')}
        >
          Runs
        </button>
      </div>

      {view === 'workflows' && (
        <>
      <details className="dc-details">
        <summary>Import &amp; interchange — n8n and KriyaDot workflow files</summary>
      <div className="card mt">
        <div className="row-between" style={{ flexWrap: 'wrap', gap: 8 }}>
          <div>
            <strong>n8n interchange</strong>
            <p className="small muted mt0">
              Import a standard n8n workflow export — common nodes map best-effort; unmapped
              nodes are reported below (never silently dropped).
            </p>
          </div>
          <label className="btn btn-sm" style={{ cursor: 'pointer' }}>
            {importing ? 'Importing…' : 'Import n8n JSON'}
            <input
              type="file"
              accept="application/json,.json"
              style={{ display: 'none' }}
              disabled={importing}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void importFile(f);
              }}
            />
          </label>
        </div>
        {importedName && (
          <p className="small mt">
            Imported <strong>{importedName}</strong>
            {importReport && importReport.length === 0 && ' — every node mapped cleanly.'}
          </p>
        )}
        {importReport && importReport.length > 0 && (
          <div className="mt">
            <strong className="small">Unmapped nodes ({importReport.length})</strong>
            <table className="tbl mt">
              <thead>
                <tr>
                  <th>Node</th>
                  <th>n8n type</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {importReport.map((u, i) => (
                  <tr key={i}>
                    <td>{u.name}</td>
                    <td className="mono small">{u.n8nType}</td>
                    <td className="small muted">{u.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card mt">
        <div className="row-between" style={{ flexWrap: 'wrap', gap: 8 }}>
          <div>
            <strong>KriyaDot workflow files</strong>
            <p className="small muted mt0">
              Import or export the versioned <span className="mono">kriyadot.workflow</span> file
              format — JSON or TOML. Per-step role/model/toolset/skills travel in the file.
            </p>
          </div>
          <label className="btn btn-sm" style={{ cursor: 'pointer' }}>
            {fileBusy ? 'Working…' : 'Import workflow file (.json / .toml)'}
            <input
              type="file"
              accept="application/json,text/plain,.json,.toml"
              style={{ display: 'none' }}
              disabled={fileBusy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void importKriyadotFile(f);
              }}
            />
          </label>
        </div>
        {fileNote && <p className="small mt">{fileNote}</p>}
      </div>
      </details>

      {dryRunFor && (
        <div className="card mt" role="dialog" aria-label={`Dry-run plan for ${dryRunFor.name}`}>
          <div className="row-between" style={{ flexWrap: 'wrap', gap: 8 }}>
            <button
              type="button"
              className="work-day-head"
              aria-expanded={!dryCol.collapsed}
              onClick={dryCol.toggle}
              title={dryCol.collapsed ? 'Expand the dry-run plan' : 'Collapse the dry-run plan'}
            >
              <CollapseChevron collapsed={dryCol.collapsed} />
              <strong>Dry-run plan — {dryRunFor.name}</strong>
            </button>
            <button type="button" className="btn btn-sm" onClick={() => { setDryRunFor(null); setDryRunView(null); setDryRunError(''); }}>
              Close
            </button>
          </div>
          {!dryCol.collapsed && (
            <>
          <p className="small muted">Validation + execution plan only — a dry run spawns nothing and costs nothing.</p>
          {dryRunBusy && <p className="small muted">Building the plan…</p>}
          {dryRunError && <div className="error-box">{dryRunError}</div>}
          {dryRunView && (
            <div>
              {dryRunView.errors.length > 0 && (
                <div className="error-box">
                  <strong>Validation errors</strong>
                  <ul style={{ margin: '4px 0', paddingLeft: 18 }}>
                    {dryRunView.errors.map((e, i) => <li key={i}>{e}</li>)}
                  </ul>
                </div>
              )}
              {dryRunView.warnings.length > 0 && (
                <p className="small">Warnings: {dryRunView.warnings.join('; ')}</p>
              )}
              <p className="small">
                Steps: {dryRunView.steps.length}
                {dryRunView.estimatedCostUsd !== null && <> · Cost figure reported by the API: ${dryRunView.estimatedCostUsd}</>}
                {dryRunView.skipped.length > 0 && <> · Skipped (unreachable): {dryRunView.skipped.join(', ')}</>}
              </p>
              <ol style={{ paddingLeft: 20 }}>
                {dryRunView.steps.map((s) => (
                  <li key={s.id} className="small" style={{ marginBottom: 4 }}>
                    <strong>{s.name}</strong> <span className="muted mono">{s.id}{s.type ? ` · ${s.type}` : ''}</span>
                    {s.detail && <span className="muted"> — {s.detail}</span>}
                  </li>
                ))}
              </ol>
              {dryRunView.steps.length === 0 && dryRunView.errors.length === 0 && (
                <p className="small muted">The API returned an empty plan for this workflow.</p>
              )}
            </div>
          )}
            </>
          )}
        </div>
      )}

      <div className="grid-2">
        {defs.map((d) => (
          <div key={d.id} className="card">
            <div className="row-between">
              <strong>{d.name}</strong>
              <span className="chip gray mono">{d.id}</span>
            </div>
            {d.description && <p className="small muted">{d.description}</p>}
            <p className="small muted">
              {d.nodes.length} node(s): {d.nodes.map((n) => n.id).join(', ')}
            </p>
            <button
              className="btn btn-primary btn-sm"
              disabled={starting === d.id}
              onClick={() => void start(d)}
            >
              {starting === d.id ? 'Starting…' : 'Run'}
            </button>{' '}
            <button
              className="btn btn-sm"
              disabled={dryRunBusy && dryRunFor?.id === d.id}
              onClick={() => void dryRun(d)}
              title="Dry-run: validate and show the execution plan — spawns nothing"
            >
              {dryRunBusy && dryRunFor?.id === d.id ? 'Planning…' : 'Dry-run'}
            </button>
            <details className="dc-mini">
              <summary>Run options &amp; exports</summary>
            <div className="field">
              <label className="label" htmlFor={`input-${d.id}`}>
                Input JSON (optional)
              </label>
              <textarea
                id={`input-${d.id}`}
                className="textarea"
                rows={2}
                placeholder='{"key": "value"}'
                value={inputs[d.id] ?? ''}
                onChange={(e) => setInputs((s) => ({ ...s, [d.id]: e.target.value }))}
              />
            </div>
            <div className="field">
              <label className="label" htmlFor={`idem-${d.id}`}>
                Idempotency key (optional)
              </label>
              <input
                id={`idem-${d.id}`}
                className="input"
                placeholder="unique key per logical run"
                value={idemKeys[d.id] ?? ''}
                onChange={(e) => setIdemKeys((s) => ({ ...s, [d.id]: e.target.value }))}
              />
            </div>
            <button
              className="btn btn-sm"
              disabled={exportingId === d.id}
              onClick={() => void exportFile(d)}
              title="Download this workflow in n8n format (best-effort)"
            >
              {exportingId === d.id ? 'Exporting…' : 'Export n8n'}
            </button>{' '}
            <button
              className="btn btn-sm"
              disabled={fileBusy}
              onClick={() => void exportKriyadotFile(d, 'json')}
              title="Download the kriyadot.workflow JSON file"
            >
              Export JSON
            </button>{' '}
            <button
              className="btn btn-sm"
              disabled={fileBusy}
              onClick={() => void exportKriyadotFile(d, 'toml')}
              title="Download the kriyadot.workflow TOML file"
            >
              Export TOML
            </button>
            </details>
          </div>
        ))}
      </div>
      {defs.length === 0 && (
        <>
          <p className="muted">No workflow definitions registered.</p>
          <GuideHint
            articleId="workflows"
            text="No workflows yet — import one, install one from the Marketplace, or draw your first on the canvas."
          />
        </>
      )}
        </>
      )}

      {view === 'runs' && (
        <>
      <h3 className="mt">Runs</h3>
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Run</th>
              <th>Workflow</th>
              <th>Status</th>
              <th>Health</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {runs.flatMap((r) => {
              const isOpen = expanded === r.id;
              const diag = diagnoses[r.id];
              const rows = [
                <tr key={r.id}>
                  <td>
                    <Link href={`/workflows/${r.id}`} className="mono" style={{ color: 'var(--accent)' }}>
                      {r.id.slice(0, 8)}…
                    </Link>
                  </td>
                  <td className="mono">{r.workflowId}</td>
                  <td>{statusChip(r.status)}</td>
                  <td>
                    <button
                      className="btn btn-sm"
                      onClick={() => toggleDiagnosis(r.id)}
                      aria-expanded={isOpen}
                      aria-label={`Health diagnosis for run ${r.id.slice(0, 8)}`}
                      title="Show diagnosis and suggested fixes"
                    >
                      {healthChip(r.healthScore)} {isOpen ? '▾' : '▸'}
                    </button>
                  </td>
                  <td className="small muted">{fmtTs(r.createdAt)}</td>
                </tr>,
              ];
              if (isOpen) {
                rows.push(
                  <tr key={`${r.id}-diag`}>
                    <td colSpan={5} style={{ background: 'var(--bg-subtle, transparent)' }}>
                      {diagLoading === r.id && !diag ? (
                        <p className="small muted">Loading diagnosis…</p>
                      ) : diag ? (
                        <div>
                          <strong className="small">Health diagnosis</strong>
                          {diag.findings.length === 0 ? (
                            <p className="small muted">Clean run — no issues detected.</p>
                          ) : (
                            <ul className="brief-list">
                              {diag.findings.map((f, i) => (
                                <li key={i} className="brief-item">
                                  <div className="row gap">
                                    <span className={`chip ${SEVERITY_CLS[f.severity] ?? 'gray'}`}>{f.severity}</span>
                                    <strong className="small">{f.title}</strong>
                                    {f.nodeId && <span className="small muted mono">{f.nodeId}</span>}
                                  </div>
                                  <div className="brief-item-detail small">{f.detail}</div>
                                  <div className="brief-item-detail small">
                                    <strong>Fix:</strong> {f.fix}
                                  </div>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      ) : (
                        <p className="small muted">Diagnosis unavailable.</p>
                      )}
                    </td>
                  </tr>,
                );
              }
              return rows;
            })}
            {runs.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  No runs yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
        </>
      )}
    </div>
  );
}
