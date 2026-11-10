// SPDX-License-Identifier: Apache-2.0
// PC file access (2026-11-10): Settings → Permissions section where the
// USER grants bots read access to real PC folders (Desktop, Documents,
// any folder). Bots can never grant themselves access — the only other
// way a grant appears is the user approving a just-in-time request card
// with "Always allow" (scoped to that one bot, marked below).
//
// v1 is read-only: bots can list and read granted folders; nothing
// outside the workspace can be written through these grants.

'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  addPcGrant,
  getBots,
  getPcGrants,
  getPcSpecialFolders,
  revokePcGrant,
  type BotConfig,
  type PcFolderGrant,
  type PcSpecialFolder,
} from '../../lib/api';

const SPECIAL_LABELS: Record<PcSpecialFolder['name'], string> = {
  desktop: 'Desktop',
  documents: 'Documents',
  downloads: 'Downloads',
  home: 'Home folder',
};

export default function PcFileAccessPanel() {
  const [grants, setGrants] = useState<PcFolderGrant[]>([]);
  const [specials, setSpecials] = useState<PcSpecialFolder[]>([]);
  const [bots, setBots] = useState<BotConfig[]>([]);
  const [customPath, setCustomPath] = useState('');
  const [scope, setScope] = useState<string>('all');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [g, s, b] = await Promise.all([getPcGrants(), getPcSpecialFolders(), getBots()]);
      setGrants(g);
      setSpecials(s);
      setBots(b);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const botName = useCallback(
    (id: string) => bots.find((b) => b.id === id)?.name ?? id,
    [bots],
  );

  const add = useCallback(
    async (body: { path?: string; specialFolder?: string }) => {
      setBusy(true);
      setError('');
      try {
        await addPcGrant({ ...body, scope });
        setCustomPath('');
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [refresh, scope],
  );

  const revoke = useCallback(
    async (id: string) => {
      setBusy(true);
      setError('');
      try {
        await revokePcGrant(id);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  return (
    <section className="card mt" data-testid="pc-file-access-panel">
      <div className="row-between">
        <h3 className="mt0">PC file access</h3>
        <span className="small muted">read-only · you grant, bots can&apos;t</span>
      </div>
      <p className="small muted">
        Bots normally see only the app&apos;s workspace folder. Grant a folder here and bots can{' '}
        <strong>list and read</strong> it (for example, ask Scout to list your Desktop). Grants are
        read-only — nothing outside the workspace can be changed through them — and a bot can never
        grant itself access. When a bot tries an ungranted folder, you get an approval card in the
        approvals inbox instead: allow it once, always allow that folder for that bot, or deny it.
      </p>

      {error && (
        <p className="small" role="alert" style={{ color: 'var(--danger, #c0392b)' }}>
          {error}
        </p>
      )}

      <div className="row-between mt">
        <strong className="small">Quick add (folders on this PC)</strong>
        <label className="small muted">
          For{' '}
          <select
            className="input"
            aria-label="Grant scope"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            style={{ width: 'auto', display: 'inline-block' }}
          >
            <option value="all">All bots</option>
            {bots.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name} only
              </option>
            ))}
          </select>
        </label>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
        {specials.map((s) => (
          <button
            key={s.name}
            type="button"
            className="btn btn-sm"
            disabled={busy || !s.path || !s.exists}
            title={s.path ?? 'Could not be resolved on this machine'}
            onClick={() => void add({ specialFolder: s.name })}
          >
            + {SPECIAL_LABELS[s.name]}
            {s.path && <span className="muted"> · {s.path}</span>}
            {s.path && !s.exists && <span className="muted"> (not found)</span>}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <input
          type="text"
          className="input"
          placeholder="Or paste an absolute folder path — e.g. D:\Projects or /home/you/notes"
          value={customPath}
          onChange={(e) => setCustomPath(e.target.value)}
          style={{ flex: 1 }}
          aria-label="Custom folder path"
        />
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={busy || !customPath.trim()}
          onClick={() => void add({ path: customPath.trim() })}
        >
          Grant folder
        </button>
      </div>

      <h4 className="mb0 mt">Granted folders ({grants.length})</h4>
      {!loaded && <p className="small muted">Loading…</p>}
      {loaded && grants.length === 0 && (
        <p className="small muted">
          No folders granted yet. Until you grant one, bots can only work inside the workspace —
          and will ask with an approval card when they need a PC folder.
        </p>
      )}
      {grants.map((g) => (
        <div key={g.id} className="card triage-item" style={{ marginTop: 8 }}>
          <div className="row-between">
            <div>
              <code>{g.path}</code>{' '}
              <span className="chip" title="Who can use this grant">
                {g.scope === 'all' ? 'all bots' : `${botName(g.scope)} only`}
              </span>{' '}
              <span className="chip" title="How this grant was created">
                {g.createdVia === 'approval' ? 'via approval card' : 'via Settings'}
              </span>
              <div className="small muted">
                read-only · granted {new Date(g.createdAt).toLocaleString()}
              </div>
            </div>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={() => void revoke(g.id)}
            >
              Revoke
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}
