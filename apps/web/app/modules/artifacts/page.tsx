// SPDX-License-Identifier: Apache-2.0
'use client';

import { useCallback, useState } from 'react';
import { MODULES_BASE, api, fmtTs, PageHeader, ErrorBox, EmptyState, Markdown, useModuleData } from '../lib';
import { authedFetch } from '../../../lib/api';

interface Artifact {
  id: string;
  title: string;
  version: number;
  content: string;
  createdAt: number;
  updatedAt: number;
}

interface ArtifactVersion {
  version: number;
  content: string;
  createdAt: number;
}

export default function ArtifactsPage() {
  const loadArtifacts = useCallback(() => api(`${MODULES_BASE}/artifacts`) as Promise<Artifact[]>, []);
  const { data: artifacts, error, refresh } = useModuleData(loadArtifacts);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Artifact | null>(null);
  const [versions, setVersions] = useState<ArtifactVersion[]>([]);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [viewVersion, setViewVersion] = useState<number | null>(null);

  const create = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      await api(`${MODULES_BASE}/artifacts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), content }),
      });
      setTitle('');
      setContent('');
      refresh();
    } finally {
      setBusy(false);
    }
  };

  const openArtifact = async (a: Artifact) => {
    const full = (await api(`${MODULES_BASE}/artifacts/${a.id}`)) as Artifact;
    setSelected(full);
    setEditing(false);
    setViewVersion(null);
    const v = (await api(`${MODULES_BASE}/artifacts/${a.id}/versions`)) as ArtifactVersion[];
    setVersions(v);
  };

  const saveEdit = async () => {
    if (!selected) return;
    const updated = (await api(`${MODULES_BASE}/artifacts/${selected.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: editContent }),
    })) as Artifact;
    setSelected(updated);
    setEditing(false);
    refresh();
    const v = (await api(`${MODULES_BASE}/artifacts/${selected.id}/versions`)) as ArtifactVersion[];
    setVersions(v);
  };

  const downloadExport = async (format: 'html' | 'csv' | 'pdf' | 'docx' | 'xlsx') => {
    if (!selected) return;
    const res = await authedFetch(`${MODULES_BASE}/artifacts/${selected.id}/export?format=${format}`);
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${selected.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.${format}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const shownVersion = viewVersion === null ? null : versions.find((v) => v.version === viewVersion);

  return (
    <div>
      <PageHeader title="Artifacts" sub="Durable documents with full version history." onRefresh={refresh} />
      <ErrorBox error={error} />

      <div className="card">
        <strong>New artifact</strong>
        <input
          className="input mt"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title"
        />
        <textarea
          className="input mt"
          rows={4}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Markdown content…"
        />
        <div className="mt">
          <button className="btn btn-sm" disabled={busy || !title.trim()} onClick={() => void create()}>
            Create artifact
          </button>
        </div>
      </div>

      <div className="grid-2 mt">
        {(artifacts ?? []).map((a) => (
          <div className="card" key={a.id}>
            <div className="row-between">
              <strong>{a.title}</strong>
              <span className="small muted">v{a.version}</span>
            </div>
            <p className="small muted mt">Updated {fmtTs(a.updatedAt)}</p>
            <div className="mt">
              <button className="btn btn-sm" onClick={() => void openArtifact(a)}>
                Open
              </button>
            </div>
          </div>
        ))}
      </div>
      {(artifacts ?? []).length === 0 && <EmptyState text="No artifacts yet. Create one above." />}

      {selected && (
        <div className="card mt">
          <div className="row-between">
            <strong>
              {selected.title} <span className="small muted">v{shownVersion?.version ?? selected.version}</span>
            </strong>
            <button className="btn btn-sm" onClick={() => setSelected(null)}>
              Close
            </button>
          </div>
          {editing ? (
            <div className="mt">
              <textarea
                className="input"
                rows={12}
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
              />
              <div className="row-between mt">
                <button className="btn btn-sm" onClick={() => setEditing(false)}>
                  Cancel
                </button>
                <button className="btn btn-sm" onClick={() => void saveEdit()}>
                  Save new version
                </button>
              </div>
            </div>
          ) : (
            <div className="mt">
              <Markdown src={shownVersion?.content ?? selected.content} />
              <div className="row-between mt">
                <div>
                  <span className="small muted">Versions: </span>
                  {versions.map((v) => (
                    <button
                      key={v.version}
                      className={`btn btn-sm${(viewVersion ?? selected.version) === v.version ? ' active' : ''}`}
                      onClick={() => setViewVersion(v.version === selected.version ? null : v.version)}
                      style={{ marginRight: 4 }}
                    >
                      v{v.version}
                    </button>
                  ))}
                </div>
                <span>
                  <span className="small muted">Export: </span>
                  {(['html', 'pdf', 'docx', 'xlsx', 'csv'] as const).map((f) => (
                    <button
                      key={f}
                      className="btn btn-sm"
                      style={{ marginRight: 4 }}
                      onClick={() => void downloadExport(f)}
                    >
                      {f.toUpperCase()}
                    </button>
                  ))}
                  <button
                    className="btn btn-sm"
                    onClick={() => {
                      setEditContent(selected.content);
                      setEditing(true);
                    }}
                  >
                    Edit
                  </button>
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
