// SPDX-License-Identifier: Apache-2.0
'use client';

// Workspace backup / restore / rollback panel (OpenMausBot parity P1 #19).
// One-click backup download, two-phase restore (dry-run preview, then
// confirm), rollback snapshots, and the never-backed-up secrets notice.

import { useCallback, useEffect, useRef, useState } from 'react';
import { authedFetch } from '../../lib/api';

interface DiffEntry {
  path: string;
  change: 'added' | 'overwritten' | 'unchanged';
  size: number;
}

interface RestoreDiff {
  entries: DiffEntry[];
  skippedSecrets: { path: string; reason: string }[];
  totals: { added: number; overwritten: number; unchanged: number; skippedSecrets: number };
}

interface Snapshot {
  name: string;
  size: number;
  createdAt: string;
}

const NEVER_BACKED_UP = [
  'Secret vault (vault.json) — values never leave the device',
  'Payment wallet (wallet.json)',
  'Encrypted provider API keys (providers.local.json) + machine key',
  'Connected-app account tokens (Composio, OAuth caches)',
  'Anything named like a token / secret / credential / private key',
  '.env files and key material (.pem, .key)',
];

function filenameFromDisposition(cd: string | null, fallback: string): string {
  const m = (cd || '').match(/filename="([^"]+)"/);
  return m?.[1] ?? fallback;
}

async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export default function BackupPanel() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [archiveB64, setArchiveB64] = useState<string | null>(null);
  const [archiveName, setArchiveName] = useState('');
  const [diff, setDiff] = useState<RestoreDiff | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [result, setResult] = useState<{ added: number; overwritten: number; snapshot: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadSnapshots = useCallback(async () => {
    try {
      const res = await authedFetch('/api/workspace/backups');
      if (res.ok) {
        const json = (await res.json()) as { snapshots: Snapshot[] };
        setSnapshots(json.snapshots);
      }
    } catch {
      // snapshots are best-effort
    }
  }, []);

  useEffect(() => {
    void loadSnapshots();
  }, [loadSnapshots]);

  const downloadBackup = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await authedFetch('/api/workspace/backup', { method: 'POST' });
      if (!res.ok) throw new Error(`Backup failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filenameFromDisposition(res.headers.get('content-disposition'), 'kriyadot-backup.zip');
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setNotice('Backup downloaded. Secrets were excluded — see the list below.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const previewRestore = async (file: File) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    setResult(null);
    try {
      const b64 = await fileToBase64(file);
      const res = await authedFetch('/api/workspace/restore/dry-run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ archive: b64 }),
      });
      const json = (await res.json()) as { ok: boolean; diff?: RestoreDiff; error?: string };
      if (!res.ok || !json.diff) throw new Error(json.error || `Dry-run failed (${res.status})`);
      setArchiveB64(b64);
      setArchiveName(file.name);
      setDiff(json.diff);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const confirmRestore = async () => {
    if (!archiveB64) return;
    if (!window.confirm(`Apply the restore from "${archiveName}"? A pre-restore snapshot is saved automatically.`)) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await authedFetch('/api/workspace/restore', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ archive: archiveB64, confirm: true }),
      });
      const json = (await res.json()) as {
        ok: boolean;
        added: number;
        overwritten: number;
        snapshot: string;
        error?: string;
      };
      if (!res.ok) throw new Error(json.error || `Restore failed (${res.status})`);
      setResult({ added: json.added, overwritten: json.overwritten, snapshot: json.snapshot });
      setDiff(null);
      setArchiveB64(null);
      setNotice(`Restore applied. Snapshot "${json.snapshot}" saved — roll back below if needed.`);
      await loadSnapshots();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const rollback = async (snapshot: string) => {
    if (!window.confirm(`Roll back to snapshot "${snapshot}"?`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await authedFetch('/api/workspace/restore/rollback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ snapshot }),
      });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok) throw new Error(json.error || `Rollback failed (${res.status})`);
      setNotice(`Rolled back to "${snapshot}".`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h3>Backup &amp; restore</h3>
      <p className="muted small">
        Snapshot your workspace files, notes, routines, bot configs and app state into one
        <code> .kriyadot-backup.zip</code> file. Restore previews every change first and always
        saves a pre-restore snapshot for rollback.
      </p>
      {error && <div className="error">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      <div className="row">
        <button className="btn btn-primary" onClick={downloadBackup} disabled={busy}>
          {busy ? 'Working…' : 'Download backup'}
        </button>
        <button className="btn" onClick={() => fileRef.current?.click()} disabled={busy}>
          Restore from file…
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".zip"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void previewRestore(f);
          }}
        />
      </div>

      {diff && (
        <div className="restore-preview">
          <h4>Restore preview — {archiveName}</h4>
          <p className="muted small">
            {diff.totals.added} added · {diff.totals.overwritten} overwritten ·{' '}
            {diff.totals.unchanged} unchanged · {diff.totals.skippedSecrets} secret files skipped
          </p>
          <table className="table">
            <thead>
              <tr>
                <th>File</th>
                <th>Change</th>
                <th>Size</th>
              </tr>
            </thead>
            <tbody>
              {diff.entries
                .filter((e) => e.change !== 'unchanged')
                .slice(0, 100)
                .map((e) => (
                  <tr key={e.path}>
                    <td className="mono small">{e.path}</td>
                    <td>{e.change}</td>
                    <td>{(e.size / 1024).toFixed(1)} KB</td>
                  </tr>
                ))}
            </tbody>
          </table>
          {diff.skippedSecrets.length > 0 && (
            <p className="muted small">
              Skipped (never restored): {diff.skippedSecrets.map((s) => s.path).join(', ')}
            </p>
          )}
          <div className="row">
            <button className="btn btn-primary" onClick={confirmRestore} disabled={busy}>
              Apply restore
            </button>
            <button
              className="btn"
              onClick={() => {
                setDiff(null);
                setArchiveB64(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {result && (
        <p className="muted small">
          Applied: {result.added} added, {result.overwritten} overwritten. Snapshot:{' '}
          <code>{result.snapshot}</code>
        </p>
      )}

      {snapshots.length > 0 && (
        <div>
          <h4>Rollback snapshots</h4>
          <ul className="list">
            {snapshots.map((s) => (
              <li key={s.name}>
                <code className="small">{s.name}</code>{' '}
                <span className="muted small">{(s.size / 1024).toFixed(0)} KB</span>{' '}
                <button className="btn btn-sm" onClick={() => rollback(s.name)} disabled={busy}>
                  Roll back
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <details>
        <summary className="small">Never backed up (secrets stay on this device)</summary>
        <ul className="muted small">
          {NEVER_BACKED_UP.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}
