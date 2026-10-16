// SPDX-License-Identifier: Apache-2.0
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  decideApproval,
  getApprovals,
  allowTool,
  getPeerApprovals,
  decidePeerApproval,
  getPeerGrants,
  revokePeerGrant,
} from '../../lib/api';
import type { ApprovalRecord, PeerApprovalCard, PeerGrant, PeerDecision } from '../../lib/api';
import { BulkBar, ShortcutHelp, useActivityShortcuts, type TriageHandlers } from '../activity/triage';
import { PeerOriginSecurityNote } from '../provenance-chip';

function fmtTs(ts: number): string {
  return new Date(ts).toLocaleString();
}

function peerActionVerb(action: PeerApprovalCard['actionType']): string {
  return action === 'ask' ? 'ask' : action === 'message' ? 'message' : 'delegate a subtask to';
}

function peerCountdown(expiresAt: number): string {
  const ms = Math.max(0, expiresAt - Date.now());
  const min = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  return `${min}:${String(sec).padStart(2, '0')}`;
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function ApprovalsPanel({ hideHeader = false }: { hideHeader?: boolean }) {
  const [pending, setPending] = useState<ApprovalRecord[]>([]);
  const [decided, setDecided] = useState<ApprovalRecord[]>([]);
  // --- Peer approval cards (OpenMausBot parity) ------------------------------
  const [peerPending, setPeerPending] = useState<PeerApprovalCard[]>([]);
  const [peerDecided, setPeerDecided] = useState<PeerApprovalCard[]>([]);
  const [peerGrants, setPeerGrants] = useState<PeerGrant[]>([]);
  const [error, setError] = useState('');
  const [acting, setActing] = useState<string>('');
  // --- Bulk triage state -------------------------------------------------
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** Local-only archive: no archive endpoint on the backend yet. */
  const [archived, setArchived] = useState<Set<string>>(new Set());
  const [focusIdx, setFocusIdx] = useState(0);
  const [helpOpen, setHelpOpen] = useState(false);
  const itemRefs = useRef<Array<HTMLDivElement | null>>([]);
  /** Set when j/k moves focus — only then do we move DOM focus (never on mount). */
  const focusFromKeys = useRef(false);

  const visible = pending.filter((a) => !archived.has(a.id));

  const refresh = useCallback(async () => {
    try {
      const [p, all, pp, ppAll, grants] = await Promise.all([
        getApprovals('pending'),
        getApprovals(),
        getPeerApprovals('pending'),
        getPeerApprovals(),
        getPeerGrants(),
      ]);
      setPending(p);
      setDecided(all.filter((a) => a.status !== 'pending').slice(0, 20));
      setPeerPending(pp);
      setPeerDecided(ppAll.filter((c) => c.status !== 'pending').slice(0, 20));
      setPeerGrants(grants);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, [refresh]);

  const decide = async (id: string, decision: 'approved' | 'denied') => {
    setActing(id);
    try {
      await decideApproval(id, decision);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActing('');
    }
  };

  /** "Always allow <tool>": persist an allow rule for the bot, then approve. */
  const alwaysAllow = async (a: ApprovalRecord) => {
    setActing(a.id);
    try {
      await allowTool(a.botId, a.toolName);
      await decideApproval(a.id, 'approved', `User chose "always allow ${a.toolName}"`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActing('');
    }
  };

  /** Decide a peer-approval card: allow (once), deny, or always-allow (per-pair grant). */
  const decidePeer = async (id: string, decision: PeerDecision) => {
    setActing(id);
    try {
      await decidePeerApproval(id, decision);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActing('');
    }
  };

  /** Revoke a per-pair always-allow grant. */
  const revokeGrant = async (g: PeerGrant) => {
    const key = `${g.senderBotId}→${g.targetBotId}:${g.actionType}`;
    setActing(key);
    try {
      await revokePeerGrant(g.senderBotId, g.targetBotId, g.actionType);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActing('');
    }
  };

  const decideMany = useCallback(
    async (ids: string[], decision: 'approved' | 'denied') => {
      for (const id of ids) {
        setActing(id);
        try {
          await decideApproval(id, decision);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
          break;
        }
      }
      setActing('');
      setSelected(new Set());
      await refresh();
    },
    [refresh],
  );

  /** IDs the focused/selected shortcuts act on: selection wins, else focused item. */
  const targetIds = useCallback((): string[] => {
    if (selected.size > 0) return [...selected];
    const item = visible[Math.min(focusIdx, Math.max(0, visible.length - 1))];
    return item ? [item.id] : [];
  }, [selected, visible, focusIdx]);

  const handlers: TriageHandlers = useMemo(
    () => ({
      refresh: () => void refresh(),
      'mark-done': () => {
        const ids = targetIds();
        if (ids.length > 0) void decideMany(ids, 'approved');
      },
      archive: () => {
        const ids = targetIds();
        if (ids.length > 0) {
          setArchived((prev) => new Set([...prev, ...ids]));
          setSelected(new Set());
        }
      },
      'toggle-select': () => {
        const item = visible[Math.min(focusIdx, Math.max(0, visible.length - 1))];
        if (!item) return;
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(item.id)) next.delete(item.id);
          else next.add(item.id);
          return next;
        });
      },
      'focus-next': () => {
        focusFromKeys.current = true;
        setFocusIdx((i) => Math.min(i + 1, Math.max(0, visible.length - 1)));
      },
      'focus-prev': () => {
        focusFromKeys.current = true;
        setFocusIdx((i) => Math.max(i - 1, 0));
      },
      'clear-selection': () => setSelected(new Set()),
      close: () => {
        setSelected(new Set());
        setHelpOpen(false);
      },
      'toggle-help': () => setHelpOpen((v) => !v),
    }),
    [refresh, decideMany, targetIds, visible, focusIdx],
  );

  useActivityShortcuts(true, handlers);

  // Keep keyboard focus on the focused card when j/k moves it.
  // Never steals focus on mount/refresh — only after a keyboard move.
  useEffect(() => {
    if (!focusFromKeys.current) return;
    focusFromKeys.current = false;
    const el = itemRefs.current[focusIdx];
    if (el && document.activeElement && !el.contains(document.activeElement)) {
      el.focus({ preventScroll: false });
    }
  }, [focusIdx]);

  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div>
      {!hideHeader && (
        <>
          <h1 className="page-title">Approvals</h1>
          <p className="page-sub">
            Human-in-the-loop gate for tool calls. Pending items refresh every 3 seconds.
          </p>
        </>
      )}
      {error && <div className="error-box">{error}</div>}

      <div className="row-between">
        <h3 className="mt0">Pending ({visible.length})</h3>
        <button
          className="btn btn-sm"
          onClick={() => setHelpOpen(true)}
          title="Keyboard shortcuts (?)"
          aria-label="Show keyboard shortcuts"
        >
          ⌨ ?
        </button>
      </div>
      <BulkBar
        count={selected.size}
        busy={acting !== ''}
        onApprove={() => void decideMany([...selected], 'approved')}
        onDeny={() => void decideMany([...selected], 'denied')}
        onArchive={() => {
          setArchived((prev) => new Set([...prev, ...selected]));
          setSelected(new Set());
        }}
        onClear={() => setSelected(new Set())}
      />
      {visible.length === 0 && <p className="muted">Nothing waiting for a decision.</p>}
      {visible.map((a, idx) => (
        <div
          key={a.id}
          ref={(el) => {
            itemRefs.current[idx] = el;
          }}
          tabIndex={-1}
          className={`card triage-item${idx === focusIdx ? ' triage-focused' : ''}${
            selected.has(a.id) ? ' triage-selected' : ''
          }`}
        >
          <div className="row-between">
            <div>
              <input
                type="checkbox"
                className="triage-check"
                checked={selected.has(a.id)}
                onChange={() => toggleOne(a.id)}
                onClick={() => setFocusIdx(idx)}
                aria-label={`Select approval ${a.toolName}`}
              />{' '}
              <strong className="mono">{a.toolName}</strong>{' '}
              <span className="chip amber">pending</span>
              {a.provenance && (
                <span className="chip small" title={`Decision provenance: ${a.provenance}`}>
                  {a.provenance === 'hard-floor-escalated' ? '🛡️ hard floor'
                    : a.provenance === 'reviewer' ? '🤖 reviewer'
                    : a.provenance === 'learned' ? '🧠 learned'
                    : a.provenance === 'standing-rule' ? '📏 standing rule'
                    : `· ${a.provenance}`}
                </span>
              )}
            </div>
            <span className="small muted">{fmtTs(a.ts)}</span>
          </div>
          <div className="small muted mt">
            bot <span className="mono">{a.botId}</span> · session{' '}
            <span className="mono">{a.sessionId}</span> · actor{' '}
            <span className="mono">{a.actor}</span>
          </div>
          <pre className="mono small mt" style={{ maxHeight: 160, overflow: 'auto' }}>
            {prettyJson(a.args)}
          </pre>
          <div className="approval-actions">
            <button
              className="btn btn-primary btn-sm"
              disabled={acting === a.id}
              onClick={() => void decide(a.id, 'approved')}
            >
              Approve
            </button>
            <button
              className="btn btn-danger btn-sm"
              disabled={acting === a.id}
              onClick={() => void decide(a.id, 'denied')}
            >
              Deny
            </button>
            <button
              className="btn btn-sm"
              disabled={acting === a.id}
              onClick={() => void alwaysAllow(a)}
              title={`Never ask for ${a.toolName} again on this bot, then approve this call.`}
            >
              Always allow {a.toolName}
            </button>
          </div>
        </div>
      ))}

      {/* --- Peer approval cards (OpenMausBot parity) ---------------------- */}
      <div className="row-between mt">
        <h3 className="mt0">Peer requests ({peerPending.length})</h3>
        <span className="small muted" title="Bot-to-bot requests: allow once, deny, or always allow a pair. Cards expire after 15 minutes.">
          bot → bot · 15-min expiry
        </span>
      </div>
      {peerPending.length === 0 && <p className="muted">No pending peer requests.</p>}
      {peerPending.map((c) => (
        <div key={c.id} className="card triage-item" style={{ borderLeft: '3px solid var(--accent, #7c6cf0)' }}>
          <div className="row-between">
            <div>
              <span className="chip" title="Peer approval card">🤝 peer</span>{' '}
              <strong>
                {c.senderBotName} <span className="muted">wants to {peerActionVerb(c.actionType)}</span> {c.targetBotName}
              </strong>
            </div>
            <span className="small muted">
              expires in {peerCountdown(c.expiresAt)} · {fmtTs(c.createdAt)}
            </span>
          </div>
          <div className="small muted mt">
            <span className="mono">{c.senderBotId}</span> → <span className="mono">{c.targetBotId}</span> · session{' '}
            <span className="mono">{c.sessionId}</span>
          </div>
          {c.preview && (
            <pre className="mono small mt" style={{ maxHeight: 120, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
              {c.preview}
            </pre>
          )}
          <PeerOriginSecurityNote note={c.provenance} />
          <div className="approval-actions">
            <button
              className="btn btn-primary btn-sm"
              disabled={acting === c.id}
              onClick={() => void decidePeer(c.id, 'allow')}
            >
              Allow
            </button>
            <button
              className="btn btn-danger btn-sm"
              disabled={acting === c.id}
              onClick={() => void decidePeer(c.id, 'deny')}
            >
              Deny
            </button>
            <button
              className="btn btn-sm"
              disabled={acting === c.id}
              onClick={() => void decidePeer(c.id, 'always-allow')}
              title={`Always allow ${c.senderBotName} → ${c.targetBotName} (${c.actionType}) without asking again. Revokable below.`}
            >
              Always allow
            </button>
          </div>
        </div>
      ))}

      {peerDecided.length > 0 && (
        <>
          <h4 className="mt">Recently decided peer requests</h4>
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Request</th>
                  <th>Status</th>
                  <th>Decided</th>
                </tr>
              </thead>
              <tbody>
                {peerDecided.map((c) => (
                  <tr key={c.id}>
                    <td className="small">
                      {c.senderBotName} → {c.targetBotName} ({peerActionVerb(c.actionType)})
                    </td>
                    <td>
                      <span className={`chip ${c.status === 'allowed' ? 'green' : c.status === 'denied' ? 'red' : 'gray'}`}>
                        {c.status}
                      </span>
                    </td>
                    <td className="small muted">{c.decidedAt ? fmtTs(c.decidedAt) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* --- Peer grants ------------------------------------------------- */}
      <div className="row-between mt">
        <h3 className="mt0">Peer grants ({peerGrants.length})</h3>
        <span className="small muted" title="Always-allow grants: this bot pair + action no longer asks for approval.">
          always-allow pairs
        </span>
      </div>
      {peerGrants.length === 0 && <p className="muted">No always-allow grants. Grant one from a peer card above.</p>}
      {peerGrants.length > 0 && (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>From</th>
                <th>To</th>
                <th>Action</th>
                <th>Granted</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {peerGrants.map((g) => {
                const key = `${g.senderBotId}→${g.targetBotId}:${g.actionType}`;
                return (
                  <tr key={key}>
                    <td className="mono small">{g.senderBotId}</td>
                    <td className="mono small">{g.targetBotId}</td>
                    <td className="small">{peerActionVerb(g.actionType)}</td>
                    <td className="small muted">{fmtTs(g.grantedAt)}</td>
                    <td>
                      <button
                        className="btn btn-sm"
                        disabled={acting === key}
                        onClick={() => void revokeGrant(g)}
                        title="Revoke: this pair will ask for approval again."
                      >
                        Revoke
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <h3 className="mt">Recently decided</h3>
      {decided.length === 0 && <p className="muted">No decisions yet.</p>}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Tool</th>
              <th>Status</th>
              <th>Bot</th>
              <th>Decided</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {decided.map((a) => (
              <tr key={a.id}>
                <td className="mono">{a.toolName}</td>
                <td>
                  <span className={`chip ${a.status === 'approved' ? 'green' : a.status === 'denied' ? 'red' : 'gray'}`}>
                    {a.status}
                  </span>
                </td>
                <td className="mono">{a.botId}</td>
                <td className="small muted">{a.decidedAt ? fmtTs(a.decidedAt) : '—'}</td>
                <td className="small muted truncate">{a.note ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ShortcutHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}
