// SPDX-License-Identifier: Apache-2.0
'use client';

/**
 * Local session viewer (#170 /analyze, Activity destination): pick a
 * session → transcript + context composition + token/cost summary.
 * Everything comes from the local KriyaDot API on this machine —
 * nothing is uploaded anywhere (stated in the UI copy below, as the
 * Octomind /analyze contract requires).
 */
import { useEffect, useState } from 'react';
import { loadSessionAnalyze } from '../../lib/octomind-api';
import { CommandResultCard } from '../chat/command-result-card';

interface ViewerMessage { role: string; content: string; ts?: string }

function messagesFromPayload(payload: Record<string, unknown> | undefined): ViewerMessage[] {
  const arr = payload?.messages;
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null)
    .map((m) => ({
      role: typeof m.role === 'string' ? m.role : 'message',
      content: typeof m.content === 'string' ? m.content : typeof m.text === 'string' ? m.text : JSON.stringify(m),
      ...(typeof m.ts === 'string' ? { ts: m.ts } : {}),
    }));
}

export function SessionAnalyzePanel({ initialSessionId = '' }: { initialSessionId?: string }) {
  const [sessionId, setSessionId] = useState(initialSessionId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [source, setSource] = useState('');
  const [context, setContext] = useState<Record<string, unknown> | null>(null);
  const [summary, setSummary] = useState<Record<string, unknown> | null>(null);
  const [messages, setMessages] = useState<ViewerMessage[]>([]);

  const load = async (sid: string) => {
    if (!sid.trim()) return;
    setBusy(true);
    setError('');
    try {
      const res = await loadSessionAnalyze(sid.trim());
      setSource(res.source);
      if (res.payload) {
        const payloadMsgs = messagesFromPayload(res.payload);
        setMessages(payloadMsgs.length > 0 ? payloadMsgs : res.messages);
        const { messages: _m, transcript: _t, ...rest } = res.payload;
        setSummary(rest);
        setContext(res.context && res.context !== res.payload ? res.context : null);
      } else {
        setMessages(res.messages);
        setContext(res.context);
        setSummary(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setMessages([]);
      setContext(null);
      setSummary(null);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { if (initialSessionId) void load(initialSessionId); }, [initialSessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <h3 style={{ marginTop: 0 }}>Session viewer (/analyze)</h3>
      <p className="small muted">
        Local only: this viewer reads the transcript, context composition and token/cost
        summary from your local KriyaDot API. <strong>Nothing is uploaded</strong> — no session
        data leaves this machine.
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input
          className="input mono"
          style={{ flex: '0 1 360px' }}
          value={sessionId}
          onChange={(e) => setSessionId(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void load(sessionId); }}
          placeholder="Session id (a chat conversation id)"
          aria-label="Session id to analyze"
        />
        <button type="button" className="btn btn-primary btn-sm" disabled={busy || !sessionId.trim()} onClick={() => void load(sessionId)}>
          {busy ? 'Loading…' : 'View session'}
        </button>
      </div>
      {error && <div className="error-box" style={{ marginTop: 8 }}>{error}</div>}
      {source && !error && (
        <p className="small muted" style={{ marginTop: 8 }}>
          Source: {source === 'analyze-endpoint' ? 'GET /api/sessions/:id/analyze' : 'local fallback (session context + thread messages endpoints)'}.
        </p>
      )}
      {summary && <CommandResultCard title="Token / cost / context summary" payload={summary} />}
      {context && <CommandResultCard title="Context composition" payload={context} />}
      {messages.length > 0 && (
        <div className="card" style={{ marginTop: 12 }}>
          <strong>Transcript ({messages.length} messages)</strong>
          <div style={{ marginTop: 8, display: 'grid', gap: 10 }}>
            {messages.map((m, i) => (
              <div key={i}>
                <div className="small muted">
                  <strong>{m.role}</strong>{m.ts ? ` · ${new Date(m.ts).toLocaleString()}` : ''}
                </div>
                <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{m.content}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
