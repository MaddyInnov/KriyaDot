// SPDX-License-Identifier: Apache-2.0
'use client';

// Spaces UI: a compact switcher plus full management (create / rename /
// pause / resume / delete, per-space model + workspace overrides).
// Backed by /api/spaces; when the backend is missing the panel shows an
// empty state. The active space persists in localStorage key `kriyadot:space`
// and is sent as the `X-KriyaDot-Space` header by the fetch wrapper.

import { useCallback, useEffect, useState } from 'react';
import { EmptyState, ErrorBox } from '../../app/modules/lib';
import {
  createSpace,
  deleteSpace,
  getActiveSpaceId,
  listSpaces,
  patchSpace,
  setActiveSpaceId,
} from '../../lib/kriyadot-api';
import type { Space } from '../../lib/kriyadot-api';

export function SpacePanel() {
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState('');
  const [editing, setEditing] = useState<Record<string, { name: string; model: string; workspace: string }>>({});

  const load = useCallback(async () => {
    try {
      const list = await listSpaces();
      setSpaces(list);
      setMissing(false);
      setError('');
      const stored = getActiveSpaceId();
      const stillThere = stored && list.some((s) => s.id === stored);
      setActiveId(stillThere ? stored : null);
    } catch (err) {
      if ((err as Error).name === 'EndpointMissingError') {
        setMissing(true);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const activate = (id: string | null) => {
    setActiveSpaceId(id);
    setActiveId(id);
  };

  const run = async (id: string, fn: () => Promise<unknown>, clearActive = false) => {
    setBusy(id);
    setError('');
    try {
      await fn();
      if (clearActive) activate(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const doCreate = () =>
    run('new', async () => {
      const s = await createSpace(newName.trim());
      setNewName('');
      activate(s.id);
    });

  if (missing) {
    return (
      <EmptyState text="Spaces are not available yet — the /api/spaces service is not running. Contexts (Work, Personal, …) will appear here once it is." />
    );
  }
  if (error && spaces.length === 0) return <ErrorBox error={error} />;

  const startEdit = (s: Space) =>
    setEditing((e) => ({
      ...e,
      [s.id]: {
        name: s.name,
        model: s.modelOverride ?? '',
        workspace: s.workspaceOverride ?? '',
      },
    }));

  const saveEdit = (s: Space) => {
    const e = editing[s.id];
    if (!e) return;
    return run(s.id, () =>
      patchSpace(s.id, {
        name: e.name.trim() || s.name,
        modelOverride: e.model.trim() || null,
        workspaceOverride: e.workspace.trim() || null,
      }).then(() => setEditing((prev) => {
        const next = { ...prev };
        delete next[s.id];
        return next;
      })),
    );
  };

  return (
    <div>
      <ErrorBox error={error} />

      {/* Switcher */}
      <div className="card">
        <div className="row-between">
          <h4 className="mt0">Active space</h4>
          <button className="btn btn-sm" onClick={() => void load()} disabled={busy !== ''}>
            Refresh
          </button>
        </div>
        <div className="row gap">
          <select
            className="select"
            value={activeId ?? ''}
            onChange={(e) => activate(e.target.value || null)}
            aria-label="Active space"
          >
            <option value="">No space (global)</option>
            {spaces.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}{s.paused ? ' — paused' : ''}
              </option>
            ))}
          </select>
          {activeId && (
            <button className="btn btn-sm" onClick={() => activate(null)}>
              Clear
            </button>
          )}
        </div>
        <p className="small muted mt">
          The active space is stored on this device (<span className="mono">kriyadot:space</span>)
          and sent to the API as the <span className="mono">X-KriyaDot-Space</span> header.
        </p>
      </div>

      {/* Create */}
      <div className="card">
        <h4 className="mt0">New space</h4>
        <div className="row gap">
          <input
            className="input"
            placeholder="e.g. Work, Personal, Research"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newName.trim() && busy === '') void doCreate();
            }}
            aria-label="New space name"
          />
          <button className="btn btn-primary" disabled={!newName.trim() || busy !== ''} onClick={() => void doCreate()}>
            Create
          </button>
        </div>
      </div>

      {/* Manage */}
      {spaces.length === 0 && (
        <EmptyState text="No spaces yet — create your first one above." />
      )}
      {spaces.map((s) => {
        const ed = editing[s.id];
        return (
          <div key={s.id} className="card">
            <div className="row-between">
              <div>
                <strong>{s.name}</strong>{' '}
                {s.paused ? (
                  <span className="chip gray">paused</span>
                ) : (
                  <span className="chip green">active</span>
                )}
                {activeId === s.id && <span className="chip blue">current</span>}
              </div>
              <div className="row gap">
                <button
                  className="btn btn-sm"
                  disabled={busy === s.id}
                  onClick={() => (ed ? void saveEdit(s) : startEdit(s))}
                >
                  {ed ? 'Save' : 'Edit'}
                </button>
                {ed && (
                  <button
                    className="btn btn-sm"
                    onClick={() =>
                      setEditing((prev) => {
                        const next = { ...prev };
                        delete next[s.id];
                        return next;
                      })
                    }
                  >
                    Cancel
                  </button>
                )}
                <button
                  className="btn btn-sm"
                  disabled={busy === s.id}
                  onClick={() => void run(s.id, () => patchSpace(s.id, { paused: !s.paused }))}
                >
                  {s.paused ? 'Resume' : 'Pause'}
                </button>
                <button
                  className="btn btn-sm btn-danger"
                  disabled={busy === s.id || activeId === s.id}
                  title={activeId === s.id ? 'Clear the active space before deleting it' : 'Delete this space'}
                  onClick={() => {
                    if (window.confirm(`Delete space "${s.name}"?`)) {
                      void run(s.id, () => deleteSpace(s.id), activeId === s.id);
                    }
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
            {ed ? (
              <div className="grid-2 mt">
                <label className="small muted">
                  Name
                  <input
                    className="input mt"
                    value={ed.name}
                    onChange={(e) => setEditing((prev) => ({ ...prev, [s.id]: { ...ed, name: e.target.value } }))}
                  />
                </label>
                <label className="small muted">
                  Model override <span className="muted">(blank = default)</span>
                  <input
                    className="input mt"
                    placeholder="e.g. provider/model-id"
                    value={ed.model}
                    onChange={(e) => setEditing((prev) => ({ ...prev, [s.id]: { ...ed, model: e.target.value } }))}
                  />
                </label>
                <label className="small muted">
                  Workspace override <span className="muted">(blank = default)</span>
                  <input
                    className="input mt"
                    placeholder="e.g. /path/to/workspace"
                    value={ed.workspace}
                    onChange={(e) => setEditing((prev) => ({ ...prev, [s.id]: { ...ed, workspace: e.target.value } }))}
                  />
                </label>
              </div>
            ) : (
              <div className="small muted mt">
                model: <span className="mono">{s.modelOverride || 'default'}</span> · workspace:{' '}
                <span className="mono">{s.workspaceOverride || 'default'}</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
