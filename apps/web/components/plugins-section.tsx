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
  permissions: { network?: boolean; env?: string[]; fs?: { read?: string[]; write?: string[] } };
  ui?: { dir: string; title: string };
  publisher?: string;
  secrets?: string[];
  /** A9 signature provenance: only "verified" means a trusted publisher signed these exact bytes. */
  signature?: { status: string; keyId?: string };
  provider?: { providerId: string; baseUrl: string };
  enabled: boolean;
  installedAt: number;
  sourceType: string;
}

type InstallSource = 'dir' | 'zip' | 'package' | 'url';

/** A9: the honest one-line signature label for a plugin card. */
function signatureLabel(p: InstalledPluginDto): string {
  switch (p.signature?.status) {
    case 'verified':
      return `Signature: verified (trusted publisher key ${p.signature?.keyId ?? ''}) — origin proven, behaviour still governed by approval + sandbox`;
    case 'unsigned':
      return 'Signature: UNSIGNED — installed via the explicit untrusted-install approval';
    case 'untrusted-key':
      return 'Signature: signed by an UNTRUSTED publisher key — installed via the explicit untrusted-install approval';
    case 'invalid':
      return 'Signature: INVALID at install — installed via the explicit untrusted-install approval';
    case 'local-directory':
      return 'Signature: local directory install (no package signature)';
    default:
      return 'Signature: not recorded (installed before signature provenance)';
  }
}

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
      setNotice('Plugin installed. Executable plugins run as short-lived stdio processes with a scrubbed environment, confined by the host kernel sandbox (Landlock on Linux, Seatbelt on macOS) to their own directory plus any filesystem paths they declare, with network access only if they declare it. On a host without a kernel sandbox, plugins with restrictive declarations are refused rather than run unconfined. Installs are approval-gated — only install plugins you trust.');
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
        Third-party plugins extend KriyaDot with tools, hooks, skills, channels, UI panels, and declarative
        providers. Installs are approval-gated on the server; executable plugins run as short-lived stdio
        processes with a scrubbed environment, confined by the host kernel sandbox (Landlock on Linux,
        Seatbelt on macOS) to their own directory plus any filesystem paths they declare in their manifest,
        with network access only if they declare it. On a host without a kernel sandbox backend (including
        Windows, which has no backend), a plugin whose declared permissions are restrictive will refuse to
        run rather than run unconfined.
      </p>
      <p>
        Signed packages (.kdpkg) are verified at install against trusted publisher keys: a verified
        signature proves the package came from that publisher unmodified — it does NOT prove the plugin is
        safe; approval and the sandbox remain the behaviour controls. Unsigned or unverifiable packages are
        refused unless you explicitly approve an untrusted install, and such plugins stay labelled
        unverified below, permanently. Installing takes effect immediately — no restart.
      </p>

      {error ? <p role="alert" style={{ color: 'crimson' }}>{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}

      <form onSubmit={install} style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
        <label>
          Source{' '}
          <select value={source} onChange={(e) => setSource(e.target.value as InstallSource)}>
            <option value="dir">Local directory</option>
            <option value="zip">.zip file</option>
            <option value="package">Signed package (.kdpkg)</option>
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
                {plugin.permissions.network ? ' · Network: declared' : ' · Network: denied (sandbox)'}
                {plugin.permissions.env?.length ? ` · Env: ${plugin.permissions.env.join(', ')}` : ''}
                {plugin.permissions.fs?.read?.length ? ` · FS read: ${plugin.permissions.fs.read.join(', ')}` : ''}
                {plugin.permissions.fs?.write?.length ? ` · FS write: ${plugin.permissions.fs.write.join(', ')}` : ''}
                {plugin.secrets?.length ? ` · Secrets (names only): ${plugin.secrets.join(', ')}` : ''}
                {plugin.provider ? ` · Provider: ${plugin.provider.providerId} → ${plugin.provider.baseUrl}` : ''}
              </p>
              <p style={{ margin: '0.25rem 0', fontSize: '0.85em' }}>{signatureLabel(plugin)}</p>
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
