// SPDX-License-Identifier: Apache-2.0
'use client';

// Per-channel richness (OpenMausBot parity): each messaging channel gets
// {instructions, workingFolder, responderRules} in one editable surface.
// Lives on the Providers page (no new top-level nav).

import { useCallback, useEffect, useState } from 'react';
import { authedFetch } from '../../lib/api';

interface ChannelConfig {
  instructions: string;
  workingFolder: string;
  responderRules: string;
}

interface ChannelEntry {
  id: string;
  config: ChannelConfig;
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await authedFetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers || {}) },
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text().catch(() => res.statusText)}`);
  return res.json() as Promise<T>;
}

export function ChannelsPanel() {
  const [channels, setChannels] = useState<ChannelEntry[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [draft, setDraft] = useState<ChannelConfig>({ instructions: '', workingFolder: '', responderRules: '' });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await apiJson<{ ok: boolean; channels: ChannelEntry[] }>('/api/messaging/channels');
      setChannels(data.channels);
      if (!selected && data.channels.length > 0) {
        setSelected(data.channels[0].id);
        setDraft(data.channels[0].config);
      } else if (selected) {
        const cur = data.channels.find((c) => c.id === selected);
        if (cur) setDraft(cur.config);
      }
      setNotice('');
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  }, [selected]);

  useEffect(() => {
    void load();
  }, []);

  const pick = (id: string) => {
    setSelected(id);
    const cur = channels.find((c) => c.id === id);
    if (cur) setDraft(cur.config);
  };

  const save = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await apiJson(`/api/messaging/channels/${selected}`, {
        method: 'PUT',
        body: JSON.stringify(draft),
      });
      setNotice(`Saved channel config for ${selected}. Instructions reach the bot on inbound mentions.`);
      await load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h2>Channels</h2>
      <p className="muted small">
        Per-channel shared instructions, working folder, and responder rules. Applied to the bot&apos;s
        context when it answers mentions on that channel.
      </p>
      {notice && <p className="small muted">{notice}</p>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        {channels.map((c) => (
          <button
            key={c.id}
            type="button"
            className={`btn btn-sm${selected === c.id ? ' btn-primary' : ''}`}
            onClick={() => pick(c.id)}
          >
            {c.id}
          </button>
        ))}
      </div>
      {selected && (
        <>
          <label className="small muted">Instructions (added to bot context)</label>
          <textarea
            rows={3}
            style={{ width: '100%' }}
            value={draft.instructions}
            onChange={(e) => setDraft((d) => ({ ...d, instructions: e.target.value }))}
            placeholder="e.g. Reply in the chat's language. Keep answers short."
          />
          <label className="small muted" style={{ marginTop: 8, display: 'block' }}>Working folder</label>
          <input
            className="input"
            style={{ width: '100%' }}
            value={draft.workingFolder}
            onChange={(e) => setDraft((d) => ({ ...d, workingFolder: e.target.value }))}
            placeholder="/path/to/channel/workspace"
          />
          <label className="small muted" style={{ marginTop: 8, display: 'block' }}>Responder rules</label>
          <textarea
            rows={3}
            style={{ width: '100%' }}
            value={draft.responderRules}
            onChange={(e) => setDraft((d) => ({ ...d, responderRules: e.target.value }))}
            placeholder="e.g. Never mention internal tooling. Escalate refunds to a human."
          />
          <div style={{ marginTop: 8 }}>
            <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void save()}>
              Save channel config
            </button>
          </div>
        </>
      )}
    </div>
  );
}
