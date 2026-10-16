// SPDX-License-Identifier: Apache-2.0
'use client';

// Managed local LLM panel (Atomic Agent parity) — Settings → Local LLM.
// Zero-config llama.cpp: download the stock binary, pick a curated GGUF
// model, start/stop the local server (127.0.0.1 only).

import { useEffect, useState } from 'react';
import { kriyadotFetch } from '../../lib/kriyadot-api';

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await kriyadotFetch(path, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers || {}) } });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error || `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

interface CuratedModelEntry {
  id: string;
  name: string;
  sizeBytes: number;
  params: string;
  contextLength: number;
  blurb: string;
  downloaded: boolean;
}

interface LocalLlmStatus {
  installed: boolean;
  running: boolean;
  port: number;
  model: string | null;
  pid: number | null;
  startedAt: number | null;
  gpu: { kind: string; detail: string };
  asset: { file: string } | null;
  models: CuratedModelEntry[];
  storageBytes: number;
  logTail: string[];
  restarts: number;
  lastError: string | null;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function LocalLlmPanel() {
  const [status, setStatus] = useState<LocalLlmStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await api<{ ok: boolean; status: LocalLlmStatus }>('/api/local-llm/status');
      setStatus(res.status);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load status');
    }
  };

  useEffect(() => {
    void load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const run = async (label: string, path: string, body?: unknown) => {
    setBusy(label);
    setError(null);
    try {
      await api(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : `${label} failed`);
    } finally {
      setBusy(null);
    }
  };

  if (!status) {
    return <p className="muted">{error ?? 'Loading local LLM status…'}</p>;
  }

  const stateLabel = status.running ? 'Running' : status.installed ? 'Installed (stopped)' : 'Not installed';
  const stateColor = status.running ? 'var(--ok, #2f9e44)' : 'var(--muted)';

  return (
    <div>
      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}

      <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <span
          style={{
            display: 'inline-block',
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: stateColor,
          }}
          aria-label={stateLabel}
        />
        <strong>{stateLabel}</strong>
        {status.running && status.model && <span className="muted small">model: {status.model}</span>}
        <span className="muted small">GPU: {status.gpu.detail} ({status.gpu.kind})</span>
        <span className="muted small">port: {status.port}</span>
        <span className="muted small">disk: {fmtBytes(status.storageBytes)}</span>
      </div>

      {status.lastError && !status.running && (
        <div className="error" style={{ marginBottom: 12 }}>{status.lastError}</div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        {!status.installed && (
          <button
            type="button"
            className="btn"
            disabled={busy !== null}
            onClick={() => run('Downloading llama.cpp…', '/api/local-llm/download-binary')}
          >
            {busy === 'Downloading llama.cpp…' ? 'Downloading…' : 'Download llama.cpp'}
          </button>
        )}
        {status.installed && !status.running && (
          <button
            type="button"
            className="btn"
            disabled={busy !== null || !status.models.some((m) => m.downloaded)}
            onClick={() => run('Starting…', '/api/local-llm/start')}
            title={status.models.some((m) => m.downloaded) ? 'Start the local server' : 'Download a model first'}
          >
            {busy === 'Starting…' ? 'Starting…' : 'Start server'}
          </button>
        )}
        {status.running && (
          <>
            <button type="button" className="btn" disabled={busy !== null} onClick={() => run('Stopping…', '/api/local-llm/stop')}>
              Stop server
            </button>
            <button type="button" className="btn" disabled={busy !== null} onClick={() => run('Restarting…', '/api/local-llm/restart')}>
              Restart
            </button>
          </>
        )}
      </div>

      <h3 style={{ margin: '12px 0 8px' }}>Models</h3>
      <p className="muted small" style={{ marginBottom: 8 }}>
        Curated small GGUF models only — the list is pinned in the app; arbitrary URLs are never accepted.
      </p>
      <table className="table">
        <thead>
          <tr><th>Model</th><th>Size</th><th>Context</th><th></th></tr>
        </thead>
        <tbody>
          {status.models.map((m) => (
            <tr key={m.id}>
              <td>
                <div>{m.name}</div>
                <div className="muted small">{m.blurb}</div>
              </td>
              <td className="muted small">{fmtBytes(m.sizeBytes)}</td>
              <td className="muted small">{(m.contextLength / 1024).toFixed(0)}k</td>
              <td>
                {m.downloaded ? (
                  <span className="muted small">downloaded</span>
                ) : (
                  <button
                    type="button"
                    className="btn small"
                    disabled={busy !== null}
                    onClick={() => run(`Downloading ${m.name}…`, '/api/local-llm/download-model', { modelId: m.id })}
                  >
                    {busy === `Downloading ${m.name}…` ? 'Downloading…' : 'Download'}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {status.logTail.length > 0 && (
        <>
          <h3 style={{ margin: '12px 0 8px' }}>Server log</h3>
          <pre className="muted small" style={{ maxHeight: 160, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
            {status.logTail.join('\n')}
          </pre>
        </>
      )}

      <p className="muted small" style={{ marginTop: 12 }}>
        Stock llama.cpp (no forks). Binaries come from the project's official GitHub releases;
        checksums are verified on install. The server binds 127.0.0.1 only and never leaves your machine.
        Once running, pick <strong>Local LLM (llama.cpp)</strong> in any bot's model picker.
      </p>
    </div>
  );
}
