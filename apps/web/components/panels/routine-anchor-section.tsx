// SPDX-License-Identifier: Apache-2.0
'use client';

/**
 * Routine anchor + reporting controls (Front Door spec Part 5, the
 * AUTOMATION ANCHOR RULE): time-based/unattended automations anchor to
 * the CLOUD by default whenever a cloud instance is connected, because
 * their defining trait is firing while the local machine may be off.
 *
 * The control offers Automatic (recommended) / This device / Cloud and
 * always shows the RESOLVED anchor in the API's exact plain words
 * ("Runs in your cloud — fires even while your PC is off" / "Runs on
 * this device — only while it's on"). After a save the API response is
 * authoritative; before it, the preview mirrors the server rule
 * (time-based schedule + cloud connected → cloud).
 *
 * Honesty surfaces:
 *  - anchorWarning (local + time-based + no cloud): "only while this PC
 *    is on" + connecting cloud fixes it.
 *  - free-tier caveat (cloud tier free + cloud anchor + time-critical):
 *    a sleeping free Studio can add a wake delay; Lightning Pro removes it.
 *
 * Reporting: Instant / Daily digest / Both + optional quiet hours.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  anchorLabel,
  anchorWarningPreview,
  executorForPlacement,
  getPlacement,
  patchRoutinePlacement,
  resolveAnchorPreview,
  showFreeTierCaveat,
  type PlacementOverview,
  type ReportingMode,
  type RoutineAnchor,
  type RoutineAnchorChoice,
  type RoutineReporting,
} from '../../lib/frontdoor';

export interface AnchorRoutineLike {
  id: string;
  botId: string;
  schedule?: { kind: string } | null;
  anchor?: RoutineAnchor;
  anchorWarning?: boolean;
  reporting?: RoutineReporting;
}

const REPORTING_OPTIONS: Array<{ value: ReportingMode; label: string }> = [
  { value: 'instant', label: 'Instant' },
  { value: 'daily', label: 'Daily digest' },
  { value: 'both', label: 'Both' },
];

export function RoutineAnchorSection({
  routine,
  onChanged,
}: {
  routine: AnchorRoutineLike;
  onChanged?: (patch: { anchor?: RoutineAnchor; anchorWarning?: boolean; reporting?: RoutineReporting }) => void;
}) {
  const [overview, setOverview] = useState<PlacementOverview | null>(null);
  const [choice, setChoice] = useState<RoutineAnchorChoice>(routine.anchor ?? 'auto');
  const [savedAnchor, setSavedAnchor] = useState<RoutineAnchor | undefined>(routine.anchor);
  const [savedWarning, setSavedWarning] = useState<boolean | undefined>(routine.anchorWarning);
  // Until the user edits the choice, the server's resolved anchor/warning
  // (initial props or the last save response) are authoritative; after an
  // edit, the preview mirrors the server rule until the next save.
  const [dirty, setDirty] = useState(false);
  const [mode, setMode] = useState<ReportingMode>(routine.reporting?.mode ?? 'instant');
  const [quietStart, setQuietStart] = useState(routine.reporting?.quietStart ?? '');
  const [quietEnd, setQuietEnd] = useState(routine.reporting?.quietEnd ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [savedAt, setSavedAt] = useState('');

  // Reset when switching routines.
  useEffect(() => {
    setChoice(routine.anchor ?? 'auto');
    setSavedAnchor(routine.anchor);
    setSavedWarning(routine.anchorWarning);
    setMode(routine.reporting?.mode ?? 'instant');
    setQuietStart(routine.reporting?.quietStart ?? '');
    setQuietEnd(routine.reporting?.quietEnd ?? '');
    setDirty(false);
    setError('');
    setSavedAt('');
  }, [routine.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let cancelled = false;
    getPlacement()
      .then((data) => {
        if (!cancelled) setOverview(data);
      })
      .catch(() => {
        if (!cancelled) setOverview(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const cloudConnected = overview?.syncConfigured ?? false;
  const cloudTier = overview?.cloudTier;
  const botExecutor = useMemo(
    () => executorForPlacement(overview?.bots.find((b) => b.botId === routine.botId)?.placement),
    [overview, routine.botId],
  );

  // Unedited: the server's resolved anchor wins. Edited: preview with
  // the same rule the server applies.
  const resolved: RoutineAnchor =
    !dirty && savedAnchor !== undefined
      ? savedAnchor
      : resolveAnchorPreview({
          choice,
          scheduleKind: routine.schedule?.kind,
          cloudConnected,
          botExecutor,
        });

  const warning =
    !dirty && savedWarning !== undefined
      ? savedWarning
      : anchorWarningPreview({
          resolvedAnchor: resolved,
          scheduleKind: routine.schedule?.kind,
          cloudConnected,
        });

  const freeCaveat = showFreeTierCaveat({
    cloudTier,
    resolvedAnchor: resolved,
    scheduleKind: routine.schedule?.kind,
  });

  const save = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const reporting: RoutineReporting = {
        mode,
        ...(quietStart ? { quietStart } : {}),
        ...(quietEnd ? { quietEnd } : {}),
      };
      const res = await patchRoutinePlacement(routine.id, {
        anchor: choice === 'auto' ? null : choice,
        reporting,
      });
      const r = res.routine as { anchor?: RoutineAnchor; anchorWarning?: boolean; reporting?: RoutineReporting };
      if (r.anchor) setSavedAnchor(r.anchor);
      setSavedWarning(r.anchorWarning);
      setDirty(false);
      setSavedAt(new Date().toLocaleTimeString());
      onChanged?.({ anchor: r.anchor, anchorWarning: r.anchorWarning, reporting: r.reporting ?? reporting });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  }, [choice, mode, quietStart, quietEnd, routine.id, onChanged]);

  return (
    <div className="routine-anchor-section" data-testid="routine-anchor-section">
      <label className="field-label">Runs where (anchor)</label>
      <div role="radiogroup" aria-label="Routine anchor" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {(
          [
            { value: 'auto', label: 'Automatic (recommended)' },
            { value: 'local', label: 'This device' },
            { value: 'cloud', label: 'Cloud' },
          ] as Array<{ value: RoutineAnchorChoice; label: string }>
        ).map((opt) => (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={choice === opt.value}
            className={`weekday-chip${choice === opt.value ? ' on' : ''}`}
            disabled={opt.value === 'cloud' && !cloudConnected}
            title={opt.value === 'cloud' && !cloudConnected ? 'Connect your cloud first' : undefined}
            onClick={() => {
              setChoice(opt.value);
              setDirty(true);
            }}
          >
            {opt.label}
          </button>
        ))}
      </div>
      <p className="small" role="status" style={{ marginTop: 6 }}>
        {anchorLabel(resolved)}
      </p>
      {warning && (
        <p className="small" role="alert" style={{ color: 'var(--warn, #e65100)' }}>
          ⚠️ This schedule only fires while this PC is on. Connect your cloud to anchor it in the
          cloud so it fires even while your PC is off.
        </p>
      )}
      {freeCaveat && (
        <p className="small muted" role="note">
          Free-tier note: your cloud Studio sleeps when idle, so a time-critical run can see a wake
          delay. Lightning Pro removes the sleep restriction.
        </p>
      )}

      <label className="field-label" style={{ marginTop: 10 }}>Reporting</label>
      <div role="radiogroup" aria-label="Reporting mode" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {REPORTING_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={mode === opt.value}
            className={`weekday-chip${mode === opt.value ? ' on' : ''}`}
            onClick={() => setMode(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>
      <div className="sched-row" style={{ marginTop: 8 }}>
        <label className="field-label">
          Quiet hours start <span className="muted">(optional)</span>
          <input type="time" className="text-input" value={quietStart} onChange={(e) => setQuietStart(e.target.value)} aria-label="Quiet hours start" />
        </label>
        <label className="field-label">
          Quiet hours end <span className="muted">(optional)</span>
          <input type="time" className="text-input" value={quietEnd} onChange={(e) => setQuietEnd(e.target.value)} aria-label="Quiet hours end" />
        </label>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="sched-actions">
        <button type="button" className="btn-primary" onClick={() => void save()} disabled={busy}>
          {busy ? 'Saving…' : 'Save anchor & reporting'}
        </button>
        {savedAt && <span className="small muted">Saved at {savedAt}.</span>}
      </div>
    </div>
  );
}
