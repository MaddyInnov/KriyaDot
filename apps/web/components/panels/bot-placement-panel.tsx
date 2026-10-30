// SPDX-License-Identifier: Apache-2.0
'use client';

/**
 * Bot placement selector (Front Door spec Part 5): "Runs on" — where this
 * bot executes. Three options with plain-language consequences, plus the
 * separate local-only privacy toggle (Part 4: never sync this bot's
 * history). Lives on the Bots page next to the other per-bot settings.
 *
 * Contract: GET /api/placement + PUT /api/placement/bots/:botId.
 * 409 conflicts surface inline:
 *  - run-in-flight       → "Stop the current run or wait for it to finish"
 *  - cloud-not-connected → prompt to connect cloud first
 * Cloud options are disabled when sync isn't configured.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  FrontdoorApiError,
  getPlacement,
  placementConflictMessage,
  updateBotPlacement,
  type BotPlacement,
  type BotPlacementRecord,
  type PlacementOverview,
} from '../../lib/frontdoor';

export const PLACEMENT_OPTIONS: Array<{
  value: BotPlacement;
  label: string;
  consequence: string;
}> = [
  {
    value: 'local',
    label: 'This device (fully local)',
    consequence: 'Runs only on this device, only while it is on. History can still sync for viewing elsewhere.',
  },
  {
    value: 'cloud-report',
    label: 'Cloud, report back',
    consequence: 'Keeps working while this app is closed; results sync back here.',
  },
  {
    value: 'cloud-only',
    label: 'Cloud only',
    consequence: 'Lives on your cloud instance; this app is a viewer.',
  },
];

export function BotPlacementPanel({ botId, botName }: { botId: string; botName?: string }) {
  const [overview, setOverview] = useState<PlacementOverview | null>(null);
  const [record, setRecord] = useState<BotPlacementRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState('');
  const [savedAt, setSavedAt] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getPlacement();
      setOverview(data);
      setRecord(data.bots.find((b) => b.botId === botId) ?? { botId, placement: 'local', localOnly: false });
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [botId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const syncConfigured = overview?.syncConfigured ?? false;

  const apply = async (patch: { placement?: BotPlacement; localOnly?: boolean }) => {
    if (!record || saving) return;
    setSaving(true);
    setConflict('');
    setError('');
    try {
      const updated = await updateBotPlacement(botId, patch);
      setRecord(updated);
      setSavedAt(new Date().toLocaleTimeString());
    } catch (err) {
      if (err instanceof FrontdoorApiError && err.status === 409) {
        setConflict(placementConflictMessage(err.code) ?? err.message);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card" style={{ marginBottom: 16 }} data-testid="bot-placement-panel">
      <h3 style={{ marginTop: 0 }}>Runs on</h3>
      <p className="small muted">
        Where {botName ? <strong>{botName}</strong> : 'this bot'} executes. Exactly one side runs
        it at a time — switching waits for a clean boundary, never double-runs.
      </p>
      {loading && <p className="muted">Loading placement…</p>}
      {!loading && error && !record && <div className="error-box">{error}</div>}
      {record && (
        <>
          <div role="radiogroup" aria-label="Runs on" style={{ display: 'grid', gap: 8 }}>
            {PLACEMENT_OPTIONS.map((opt) => {
              const needsCloud = opt.value !== 'local';
              const disabled = saving || (needsCloud && !syncConfigured);
              return (
                <label
                  key={opt.value}
                  className="small"
                  style={{
                    display: 'flex',
                    gap: 8,
                    alignItems: 'flex-start',
                    opacity: disabled && record.placement !== opt.value ? 0.55 : 1,
                  }}
                >
                  <input
                    type="radio"
                    name={`placement-${botId}`}
                    value={opt.value}
                    checked={record.placement === opt.value}
                    disabled={disabled}
                    onChange={() => void apply({ placement: opt.value })}
                  />
                  <span>
                    <strong>{opt.label}</strong>
                    <span className="muted" style={{ display: 'block' }}>{opt.consequence}</span>
                    {needsCloud && !syncConfigured && (
                      <span className="muted" style={{ display: 'block' }}>
                        Connect your cloud first — cloud options need a configured sync target.
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
          </div>

          <label
            className="small"
            style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 14 }}
          >
            <input
              type="checkbox"
              checked={record.localOnly}
              disabled={saving}
              onChange={(e) => void apply({ localOnly: e.target.checked })}
              aria-label="Local-only (never sync this bot's history)"
            />
            <span>
              <strong>Local-only (never sync this bot&apos;s history)</strong>
              <span className="muted" style={{ display: 'block' }}>
                Privacy: this bot&apos;s chats stay on this device and are excluded from cloud sync entirely.
              </span>
            </span>
          </label>

          {conflict && (
            <div className="error-box" role="alert" style={{ marginTop: 10 }}>
              {conflict}
            </div>
          )}
          {error && (
            <div className="error-box" role="alert" style={{ marginTop: 10 }}>
              {error}
            </div>
          )}
          {savedAt && !conflict && !error && (
            <p className="small muted" role="status" style={{ marginTop: 8 }}>
              Saved at {savedAt}.
            </p>
          )}
        </>
      )}
    </div>
  );
}
