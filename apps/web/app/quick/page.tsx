// SPDX-License-Identifier: Apache-2.0
'use client';

// CA-27: Desktop quick entry — the page the Tauri companion window
// loads (see apps/desktop/src-tauri/src/quick_entry.rs) and the route
// `kriyadot://quick` / `kriyadot://repo/<path>?prompt=…` deep links map
// to (apps/web/lib/desktop-bridge.ts). One prompt box, one bot, send
// goes to POST /api/chat like every other surface — same governance.

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { authedFetch } from '../../lib/api';

function QuickEntryInner() {
  const params = useSearchParams();
  const [prompt, setPrompt] = useState(params.get('prompt') ?? '');
  const repo = params.get('repo');
  const [reply, setReply] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const message = repo ? `[repo: ${repo}] ${prompt}` : prompt;
      const res = await authedFetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ botId: 'coder', message }),
      });
      if (!res.ok) throw new Error(`request failed (${res.status})`);
      const body = (await res.json().catch(() => ({}))) as { text?: string; response?: string };
      setReply(body.text ?? body.response ?? '(no text reply — open the main window for the full thread)');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'send failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h1 className="page-title">Quick entry</h1>
      <p className="page-sub">Ask KriyaDot without opening the full app.{repo ? ` Repo: ${repo}` : ''}</p>
      <textarea
        aria-label="Prompt"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={4}
        placeholder="What should the agent do?"
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send(); }}
      />
      <div>
        <button type="button" onClick={() => void send()} disabled={busy || !prompt.trim()}>
          {busy ? 'Working…' : 'Send (Ctrl/Cmd+Enter)'}
        </button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {reply ? <pre aria-label="Agent reply">{reply}</pre> : null}
    </div>
  );
}

export default function QuickEntryPage() {
  return (
    <Suspense fallback={<p>Loading…</p>}>
      <QuickEntryInner />
    </Suspense>
  );
}
