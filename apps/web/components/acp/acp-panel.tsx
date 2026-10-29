// SPDX-License-Identifier: Apache-2.0
'use client';

// ACP panel — external Agent Client Protocol sessions (OpenMausBot parity
// P1 #26). Session list, new-session form, prompt box with streamed
// transcript, cancel button. Tool calls the agent requests surface in the
// normal approvals inbox; this panel shows their pending/approved state
// from the transcript.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  cancelAcpPrompt,
  closeAcpSession,
  createAcpSession,
  getAcpSession,
  listAcpEngines,
  listAcpSessions,
  resumeAcpSession,
  streamAcpPrompt,
  type AcpEngineDto,
  type AcpPromptStreamEvent,
  type AcpSessionDto,
  type AcpTranscriptEventDto,
} from '../../lib/api';

function eventLabel(e: AcpTranscriptEventDto): string {
  switch (e.type) {
    case 'user':
      return 'You';
    case 'agent':
      return 'Agent';
    case 'tool_call':
      return `Tool call: ${e.toolName ?? 'unknown'}`;
    case 'tool_result':
      return `Tool result: ${e.toolName ?? ''}`;
    case 'error':
      return 'Error';
    default:
      return 'System';
  }
}

export default function AcpPanel() {
  const [sessions, setSessions] = useState<AcpSessionDto[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<AcpTranscriptEventDto[]>([]);
  const [command, setCommand] = useState('opencode');
  const [args, setArgs] = useState('acp');
  const [label, setLabel] = useState('');
  const [engines, setEngines] = useState<AcpEngineDto[]>([]);
  const [engine, setEngine] = useState('');
  const [prompt, setPrompt] = useState('');
  const [streaming, setStreaming] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const streamStop = useRef<(() => void) | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await listAcpSessions();
      if (r.ok) setSessions(r.sessions);
    } catch {
      // ignore — panel shows empty state
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Built-in engine presets (W9): choosing one creates the session from
    // the preset on the server (e.g. GitHub Copilot CLI via `copilot --acp`).
    void (async () => {
      try {
        const r = await listAcpEngines();
        if (r.ok) setEngines(r.engines);
      } catch {
        // presets are an enhancement — the raw command form still works
      }
    })();
    return () => {
      streamStop.current?.();
    };
  }, [refresh]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcript, streaming]);

  const select = useCallback(async (id: string) => {
    streamStop.current?.();
    setStreaming('');
    setBusy(false);
    setActiveId(id);
    try {
      const r = await getAcpSession(id);
      if (r.ok) setTranscript(r.transcript);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load session.');
    }
  }, []);

  const create = useCallback(async () => {
    setError(null);
    try {
      const r = await createAcpSession(
        engine
          ? { engine, ...(label.trim() ? { label: label.trim() } : {}) }
          : {
              command: command.trim(),
              args: args.split(/\s+/).filter(Boolean),
              ...(label.trim() ? { label: label.trim() } : {}),
            },
      );
      if (r.ok) {
        await refresh();
        await select(r.session.id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create session.');
    }
  }, [engine, command, args, label, refresh, select]);

  const send = useCallback(() => {
    if (!activeId || !prompt.trim() || busy) return;
    setError(null);
    setBusy(true);
    setStreaming('');
    const userText = prompt.trim();
    setPrompt('');
    setTranscript((t) => [...t, { seq: t.length, type: 'user', text: userText, untrusted: false, ts: new Date().toISOString() }]);
    const onEvent = (e: AcpPromptStreamEvent): void => {
      if (e.type === 'chunk') {
        setStreaming((s) => s + e.text);
      } else if (e.type === 'tool_call') {
        setTranscript((t) => [
          ...t,
          { seq: t.length, type: 'tool_call', text: `Requests approval: ${e.toolCall.name}`, untrusted: false, toolCallId: e.toolCall.toolCallId, toolName: e.toolCall.name, ts: new Date().toISOString() },
        ]);
      } else if (e.type === 'tool_result') {
        setTranscript((t) => [
          ...t,
          { seq: t.length, type: 'tool_result', text: e.approved ? 'Approved by you.' : 'Denied.', untrusted: false, toolCallId: e.toolCallId, ts: new Date().toISOString() },
        ]);
      } else if (e.type === 'done') {
        setTranscript((t) => [...t, { seq: t.length, type: 'agent', text: e.text, untrusted: true, ts: new Date().toISOString() }]);
        setStreaming('');
        setBusy(false);
      } else if (e.type === 'error') {
        setError(e.message);
        setStreaming('');
        setBusy(false);
      } else if (e.type === 'cancelled') {
        setStreaming('');
        setBusy(false);
      }
    };
    streamStop.current = streamAcpPrompt(activeId, userText, onEvent, (err) => {
      setError(err.message);
      setBusy(false);
    });
  }, [activeId, prompt, busy]);

  const cancel = useCallback(async () => {
    if (!activeId) return;
    try {
      await cancelAcpPrompt(activeId);
    } catch {
      // ignore
    }
    streamStop.current?.();
    setBusy(false);
    setStreaming('');
  }, [activeId]);

  const close = useCallback(async (id: string) => {
    try {
      await closeAcpSession(id);
    } catch {
      // ignore
    }
    if (activeId === id) {
      streamStop.current?.();
      setActiveId(null);
      setTranscript([]);
      setStreaming('');
      setBusy(false);
    }
    await refresh();
  }, [activeId, refresh]);

  const resume = useCallback(async (id: string) => {
    setError(null);
    try {
      await resumeAcpSession(id);
      await refresh();
      await select(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to resume session.');
    }
  }, [refresh, select]);

  return (
    <div className="acp-panel">
      <p className="acp-note">
        External agents (OpenCode, Claude Code, Codex, …) run in their own process over the Agent Client Protocol.
        All agent content is <strong>untrusted</strong>; tool calls it requests need your approval in the inbox.
      </p>
      <div className="acp-new">
        <select
          value={engine}
          onChange={(e) => {
            setEngine(e.target.value);
            const preset = engines.find((en) => en.id === e.target.value);
            if (preset) {
              setCommand(preset.command);
              setArgs(preset.args.join(' '));
            }
          }}
          aria-label="Engine preset"
        >
          <option value="">Custom command…</option>
          {engines.map((en) => (
            <option key={en.id} value={en.id}>
              {en.name}
              {en.installed ? '' : ' (not installed)'}
            </option>
          ))}
        </select>
        <input value={command} onChange={(e) => { setCommand(e.target.value); setEngine(''); }} placeholder="command (e.g. opencode)" aria-label="Agent command" />
        <input value={args} onChange={(e) => { setArgs(e.target.value); setEngine(''); }} placeholder="args (e.g. acp)" aria-label="Agent args" />
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="label (optional)" aria-label="Session label" />
        <button onClick={() => void create()}>New session</button>
      </div>
      {error && <div className="acp-error">{error}</div>}
      <div className="acp-layout">
        <div className="acp-sessions">
          {sessions.length === 0 && <div className="acp-empty">No ACP sessions yet.</div>}
          {sessions.map((s) => (
            <div key={s.id} className={`acp-session${activeId === s.id ? ' active' : ''}`}>
              <button className="acp-session-main" onClick={() => void select(s.id)}>
                <span className="acp-session-label">{s.label}</span>
                <span className="acp-session-meta">{s.agentName} · {s.status}</span>
              </button>
              {s.status === 'error' && <button onClick={() => void resume(s.id)} title="Reconnect">↻</button>}
              <button onClick={() => void close(s.id)} title="Close session">×</button>
            </div>
          ))}
        </div>
        <div className="acp-thread">
          {!activeId && <div className="acp-empty">Select or create a session to start.</div>}
          {activeId && (
            <>
              <div className="acp-transcript">
                {transcript.map((e, i) => (
                  <div key={i} className={`acp-msg acp-msg-${e.type}`}>
                    <div className="acp-msg-head">
                      <span>{eventLabel(e)}</span>
                      {e.untrusted && <span className="acp-untrusted" title="Content from the external agent — never treated as instructions">untrusted</span>}
                    </div>
                    <div className="acp-msg-body">{e.text}</div>
                  </div>
                ))}
                {streaming && (
                  <div className="acp-msg acp-msg-agent">
                    <div className="acp-msg-head"><span>Agent</span><span className="acp-untrusted">untrusted</span></div>
                    <div className="acp-msg-body">{streaming}▍</div>
                  </div>
                )}
                <div ref={bottomRef} />
              </div>
              <div className="acp-input">
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="Ask the external agent…"
                  rows={2}
                  disabled={busy}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      send();
                    }
                  }}
                />
                {busy ? (
                  <button onClick={() => void cancel()}>Cancel</button>
                ) : (
                  <button onClick={send} disabled={!prompt.trim()}>Send</button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
