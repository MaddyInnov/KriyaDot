// SPDX-License-Identifier: Apache-2.0
// StartersSection (W4): ready-made automation recipes for a selected bot.
// Fetches GET /api/connected-apps/starters?botId= and creates routines via
// POST /api/connected-apps/starters/:id/create — created DISABLED, with an
// honest note pointing at Bots → Routines to review and enable. The
// highlightApp prop (from a card's "Automate it") filters/highlights the
// recipes that need that app.

'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  createStarter,
  fetchStarters,
  triggerKindLabel,
  type StarterRecipe,
  type WebBot,
} from '../../lib/connected-apps';
import './connected-apps.css';

export interface StartersSectionProps {
  bots: WebBot[];
  highlightApp?: string | null;
}

export function StartersSection({ bots, highlightApp }: StartersSectionProps) {
  const [botId, setBotId] = useState('');
  const [starters, setStarters] = useState<StarterRecipe[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [created, setCreated] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!botId && bots.length > 0) setBotId(bots[0].id);
  }, [bots, botId]);

  const refresh = useCallback(async (forBotId: string) => {
    if (!forBotId) {
      setStarters([]);
      return;
    }
    try {
      setError(null);
      const data = await fetchStarters(forBotId);
      setStarters(data.starters ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh(botId);
  }, [botId, refresh]);

  const create = async (starter: StarterRecipe) => {
    if (!botId) return;
    setBusy(starter.id);
    setError(null);
    setNotice('');
    try {
      const data = await createStarter(starter.id, botId);
      setCreated((prev) => ({ ...prev, [starter.id]: true }));
      setNotice(
        `Created "${data.name ?? starter.name}" disabled — review and enable it in Bots → Routines.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const shown = highlightApp
    ? starters.filter((s) =>
        s.requiredApps.some((a) => a.toLowerCase() === highlightApp.toLowerCase()),
      )
    : starters;

  return (
    <div className="card" id="ca-starters">
      <div className="row-between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0 }}>Automations you can start</h2>
        <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <strong>Bot</strong>
          <select
            className="input"
            aria-label="Bot for automations"
            value={botId}
            onChange={(e) => setBotId(e.target.value)}
            disabled={bots.length === 0}
          >
            {bots.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="small muted">
        Ready-made routines that use your connected apps. Creating one never turns it on.
        {highlightApp ? ` Showing recipes that use ${highlightApp}.` : ''}
      </p>
      {error && (
        <p className="small" style={{ color: 'var(--red, #c0392b)' }}>
          {error}
        </p>
      )}
      {notice && (
        <p className="small">
          {notice}{' '}
          <a href="/bots">Open Bots → Routines</a>
        </p>
      )}
      {bots.length === 0 && <p className="small muted">No bots yet — create one on the Bots page.</p>}
      {bots.length > 0 && shown.length === 0 && (
        <p className="small muted">
          {highlightApp ? 'No automations use that app yet.' : 'No automations available for this bot yet.'}
        </p>
      )}
      <div className="ca-grid">
        {shown.map((starter) => {
          const highlighted = Boolean(
            highlightApp &&
              starter.requiredApps.some((a) => a.toLowerCase() === highlightApp.toLowerCase()),
          );
          return (
            <div
              key={starter.id}
              className={`ca-card${highlighted ? ' ca-highlight' : ''}`}
              data-testid={`starter-${starter.id}`}
            >
              <div className="row-between">
                <strong>{starter.name}</strong>
                <span className="chip gray">{triggerKindLabel(starter.triggerKind)}</span>
              </div>
              {starter.description && <p className="small muted" style={{ margin: 0 }}>{starter.description}</p>}
              <div className="ca-caps">
                {starter.requiredApps.map((req) => {
                  const missing = starter.missing?.includes(req);
                  return (
                    <span key={req} className={`chip ${missing ? 'amber' : 'green'}`}>
                      {req}
                      {missing ? ' — missing' : ' — ready'}
                    </span>
                  );
                })}
              </div>
              {!starter.ready && starter.missing?.length > 0 && (
                <p className="small muted" style={{ margin: 0 }}>
                  Connect {starter.missing.join(', ')} first to use this automation.
                </p>
              )}
              <div>
                <button
                  className="btn btn-sm btn-primary"
                  disabled={busy === starter.id || !starter.ready || Boolean(created[starter.id])}
                  onClick={() => void create(starter)}
                >
                  {created[starter.id] ? 'Created (disabled)' : 'Create (disabled)'}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default StartersSection;
