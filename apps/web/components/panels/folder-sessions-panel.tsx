// SPDX-License-Identifier: Apache-2.0
'use client';

// CA-34: Folder sessions panel (Workspace destination).
// "Open folder as agent workspace": bundle a bot + workspace folder +
// routines + placement as one shareable folder-session unit. Export
// produces the JSON unit; Import posts it to
// POST /api/folder-sessions/import (registered per the Wave-6 wiring
// note) and reports the materialization plan or the server's error.

import { useState } from 'react';
import { authedFetch } from '../../lib/api';
import { buildFolderSessionJson, isSafeFolderPath } from '../../lib/folder-session';

export default function FolderSessionsPanel() {
  const [name, setName] = useState('');
  const [folder, setFolder] = useState('');
  const [botId, setBotId] = useState('coder');
  const [placement, setPlacement] = useState<'local' | 'cloud-report' | 'cloud-only'>('local');
  const [status, setStatus] = useState<string | null>(null);
  const [exported, setExported] = useState('');

  const draft = () => ({
    id: name.toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '') || 'folder-session',
    name, folder, botId, systemPrompt: 'You are the agent for this folder workspace.', placement,
  });

  const doExport = () => {
    if (!isSafeFolderPath(folder)) { setStatus('Folder must be a safe relative path (no "..", no absolute paths).'); return; }
    setExported(JSON.stringify(buildFolderSessionJson(draft()), null, 2));
    setStatus('Exported — share this JSON unit; importing it recreates bot + workspace + placement together.');
  };

  const doImport = async () => {
    if (!isSafeFolderPath(folder)) { setStatus('Folder must be a safe relative path.'); return; }
    try {
      const res = await authedFetch('/api/folder-sessions/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildFolderSessionJson(draft())),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; plan?: { workspacePath?: string } };
      if (!res.ok) throw new Error(body.error ?? `import failed (${res.status})`);
      setStatus(`Imported. Workspace: ${body.plan?.workspacePath ?? folder}`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'import failed');
    }
  };

  return (
    <div>
      <h2>Folder sessions</h2>
      <p className="page-sub">Open a folder as an agent workspace: one shareable unit with the bot, routines and placement bundled.</p>
      <label>Session name <input value={name} onChange={(e) => setName(e.target.value)} placeholder="My project" /></label>
      <label>Folder (relative to the workspace root) <input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="projects/my-project" /></label>
      <label>Bot <input value={botId} onChange={(e) => setBotId(e.target.value)} /></label>
      <label>Placement{' '}
        <select value={placement} onChange={(e) => setPlacement(e.target.value as typeof placement)}>
          <option value="local">This device</option>
          <option value="cloud-report">Cloud, report back</option>
          <option value="cloud-only">Cloud only</option>
        </select>
      </label>
      <div>
        <button type="button" onClick={doExport}>Export unit</button>{' '}
        <button type="button" onClick={doImport}>Import / open folder</button>
      </div>
      {status ? <p role="status">{status}</p> : null}
      {exported ? <pre aria-label="Folder session JSON">{exported}</pre> : null}
    </div>
  );
}
