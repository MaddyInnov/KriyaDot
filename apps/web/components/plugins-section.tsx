// SPDX-License-Identifier: Apache-2.0
'use client';

// Plugins section for the Marketplace page (Octop parity §2.17): list
// installed plugins with their kinds/permissions/state, install from a
// local directory, a .zip file, or a URL (installs pass through the
// server-side approval hook — deny-by-default), uninstall, and
// enable/disable toggles. UI plugins link to their sandboxed panel.
//
// Mount (parent, in apps/web/app/marketplace/page.tsx):
//   import PluginsSection from '../../components/plugins-section';
//   ... add a 'plugins' tab and render <PluginsSection /> for it.

import React, { useCallback, useEffect, useState } from 'react';
import { authedFetch } from '../lib/api';

interface InstalledPluginDto {
  id: string;
  name: string;
  version: string;
  description: string;
  kinds: string[];
  permissions: { network?: boolean; env?: string[] };
  ui?: { dir: string; title: string };
  enabled: boolean;
  installedAt: number;
  sourceType: string;
}

type InstallSource = 'dir' | 'zip' | 'url';

const api = (path: string, init?: RequestInit): Promise<unknown> =>
  authedFetch(path, init).then(async (res) => {
    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new Error(`API ${res.status}: ${detail || res.statusText}`);
    }
    return res.json() as Promise<unknown>;
  });

const post = (path: string, data?: unknown): Promise<unknown> =>
  api(path, {
    method: 'POST',
    headers: data === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });

export default function PluginsSection(): React.JSX.Element {
  const [plugins, setPlugins] = useState<InstalledPluginDto[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [source, setSource] = useState<InstallSource>('dir');
  const [path, setPath] = useState('');

  const load = useCallback(async () => {
    try {
      const data = (await api('/api/plugins')) as { plugins: InstalledPluginDto[] };
      setPlugins(data.plugins ?? []);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const install = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!path.trim()) return;
    setBusy('install');
    setError('');
    setNotice('');
    try {
      await post('/api/plugins/install', { source, path: path.trim() });
      setPath('');
      setNotice('Plugin installed. Executable plugins run as sandboxed stdio processes per invocation.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const toggle = async (plugin: InstalledPluginDto) => {
    setBusy(plugin.id);
    setError('');
    try {
      await post(`/api/plugins/${encodeURIComponent(plugin.id)}/${plugin.enabled ? 'disable' : 'enable'}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const uninstall = async (plugin: InstalledPluginDto) => {
    setBusy(plugin.id);
    setError('');
    try {
      await api(`/api/plugins/${encodeURIComponent(plugin.id)}`, { method: 'DELETE' });
      setNotice(`Uninstalled ${plugin.name}.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  return (
    <section aria-label="Plugins">
      <h2>Plugins</h2>
      <p>
        Third-party plugins extend KriyaDot with tools, hooks, skills, channels, and UI panels. Installs are
        approval-gated on the server; executable plugins run as short-lived stdio processes with a scrubbed
        environment.
      </p>

      {error ? <p role="alert" style={{ color: 'crimson' }}>{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}

      <form onSubmit={install} style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
        <label>
          Source{' '}
          <select value={source} onChange={(e) => setSource(e.target.value as InstallSource)}>
            <option value="dir">Local directory</option>
            <option value="zip">.zip file</option>
            <option value="url">URL</option>
          </select>
        </label>
        <label style={{ flex: '1 1 20rem' }}>
          Path / URL{' '}
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder={source === 'url' ? 'https://example.com/my-plugin.zip' : '/path/to/plugin'}
            style={{ width: '100%' }}
          />
        </label>
        <button type="submit" disabled={busy === 'install' || !path.trim()}>
          {busy === 'install' ? 'Installing…' : 'Install plugin'}
        </button>
      </form>

      {plugins.length === 0 ? (
        <p>No plugins installed yet.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: '0.75rem' }}>
          {plugins.map((plugin) => (
            <li key={plugin.id} style={{ border: '1px solid #ccc', borderRadius: 8, padding: '0.75rem 1rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
                <strong>
                  {plugin.name} <small>v{plugin.version}</small>
                </strong>
                <span>{plugin.enabled ? 'Enabled' : 'Disabled'}</span>
              </div>
              <p style={{ margin: '0.25rem 0' }}>{plugin.description}</p>
              <p style={{ margin: '0.25rem 0', fontSize: '0.85em' }}>
                Kinds: {plugin.kinds.join(', ')} · Source: {plugin.sourceType}
                {plugin.permissions.network ? ' · Network: declared' : ''}
                {plugin.permissions.env?.length ? ` · Env: ${plugin.permissions.env.join(', ')}` : ''}
              </p>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                <button type="button" onClick={() => void toggle(plugin)} disabled={busy === plugin.id}>
                  {plugin.enabled ? 'Disable' : 'Enable'}
                </button>
                <button type="button" onClick={() => void uninstall(plugin)} disabled={busy === plugin.id}>
                  Uninstall
                </button>
                {plugin.ui && plugin.enabled ? (
                  <a href={`/api/plugins/${encodeURIComponent(plugin.id)}/ui/`} target="_blank" rel="noreferrer">
                    Open panel: {plugin.ui.title}
                  </a>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
