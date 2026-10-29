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
  getCredentialProposals,
  decideCredentialProposal,
  getWatchItems,
  dismissWatchItem,
  draftWatchItem,
} from '../../lib/api';
import type { ApprovalRecord, PeerApprovalCard, PeerGrant, PeerDecision, CredentialProposal, WatchItem } from '../../lib/api';
import { BulkBar, ShortcutHelp, useActivityShortcuts, type TriageHandlers } from '../activity/triage';
import { PeerOriginSecurityNote } from '../provenance-chip';

function fmtTs(ts: number): string {
  return new Date(ts).toLocaleString();
}

function peerActionVerb(action: PeerApprovalCard['actionType']): string {
  return action === 'ask' ? 'ask' : action === 'message' ? 'message' : 'delegate a subtask to';
}

function peerCountdown(expiresAt: number | null): string {
  if (expiresAt === null) return 'No expiry';
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
  // --- Credential proposal cards (a bot needs a secret it doesn't have) ---
  const [credPending, setCredPending] = useState<CredentialProposal[]>([]);
  // --- Watch items (W5): proactive account watching "needs you" entries ---
  const [watchNew, setWatchNew] = useState<WatchItem[]>([]);
  const [watchActioned, setWatchActioned] = useState<WatchItem[]>([]);
  const [watchOpenId, setWatchOpenId] = useState<string | null>(null);
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
      const [p, all, pp, ppAll, grants, creds, wNew, wActioned] = await Promise.all([
        getApprovals('pending'),
        getApprovals(),
        getPeerApprovals('pending'),
        getPeerApprovals(),
        getPeerGrants(),
        getCredentialProposals('pending'),
        getWatchItems('new').catch(() => [] as WatchItem[]),
        getWatchItems('actioned').catch(() => [] as WatchItem[]),
      ]);
      setPending(p);
      setDecided(all.filter((a) => a.status !== 'pending').slice(0, 20));
      setPeerPending(pp);
      setPeerDecided(ppAll.filter((c) => c.status !== 'pending').slice(0, 20));
      setPeerGrants(grants);
      setCredPending(creds);
      setWatchNew(wNew);
      setWatchActioned(wActioned.slice(0, 10));
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

  /** Watch items: one-tap Draft reply (bot drafts, draft stored on the item). */
  const draftWatch = async (id: string) => {
    setActing(id);
    try {
      await draftWatchItem(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActing('');
    }
  };

  /** Watch items: Dismiss is terminal — the item never resurfaces. */
  const dismissWatch = async (id: string) => {
    setActing(id);
    try {
      await dismissWatchItem(id);
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
              {(a.neverExpire === true || a.expiresAt === null) && (
                <span className="chip blue" title="This approval never expires">No expiry</span>
              )}
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
            {a.toolName === 'request_purchase' ? (
              <span className="small muted" title="Purchases are always approved individually — there is no always-allow for buying.">
                🛒 Purchases always need individual approval
              </span>
            ) : (
              <button
                className="btn btn-sm"
                disabled={acting === a.id}
                onClick={() => void alwaysAllow(a)}
                title={`Never ask for ${a.toolName} again on this bot, then approve this call.`}
              >
                Always allow {a.toolName}
              </button>
            )}
          </div>
        </div>
      ))}

      {/* --- Watch items (W5): flagged by proactive account watching.
          Only items a helper-model triage flagged land here; each carries
          one-tap Draft reply / Dismiss / Open (context) actions. ------- */}
      <div className="row-between mt">
        <h3 className="mt0">Needs you — watched accounts ({watchNew.length})</h3>
        <span className="small muted" title="Items flagged by your watch rules (Activity → Watch). Manage rules there.">
          proactive watching
        </span>
      </div>
      {watchNew.length === 0 && <p className="muted">Nothing flagged by your watch rules.</p>}
      {watchNew.map((item) => (
        <div key={item.id} className="card triage-item" style={{ borderLeft: '3px solid var(--accent, #7c6cf0)' }}>
          <div className="row-between">
            <div>
              <span className="chip" title="Watch item">👀 {item.app}</span>{' '}
              <span className={`chip ${item.urgency === 'high' ? 'red' : item.urgency === 'medium' ? 'amber' : 'gray'}`}>
                {item.urgency}
              </span>{' '}
              <strong>{item.summary}</strong>
            </div>
            <span className="small muted">{fmtTs(item.surfacedAt)}</span>
          </div>
          {item.reason && <div className="small mt">Why: {item.reason}</div>}
          {item.suggestedAction && (
            <div className="small muted">Suggested: {item.suggestedAction}</div>
          )}
          {watchOpenId === item.id && (
            <div className="mt">
              <div className="small muted">
                rule <span className="mono">{item.ruleId}</span> · source{' '}
                <span className="mono">{item.sourceItemId}</span> · kind{' '}
                <span className="mono">{item.sourceKind}</span>
                {item.itemTs ? ` · ${fmtTs(item.itemTs)}` : ''}
              </div>
              {Object.entries(item.fields).filter(([, v]) => v).length > 0 && (
                <pre className="mono small mt" style={{ maxHeight: 160, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
                  {Object.entries(item.fields)
                    .filter(([, v]) => v)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join('\n')}
                </pre>
              )}
              {item.draftText && (
                <>
                  <div className="small mt"><strong>Draft reply</strong></div>
                  <pre className="mono small mt" style={{ maxHeight: 200, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
                    {item.draftText}
                  </pre>
                </>
              )}
            </div>
          )}
          <div className="approval-actions">
            <button
              className="btn btn-primary btn-sm"
              disabled={acting === item.id}
              onClick={() => void draftWatch(item.id)}
            >
              Draft reply
            </button>
            <button
              className="btn btn-sm"
              disabled={acting === item.id}
              onClick={() => void dismissWatch(item.id)}
            >
              Dismiss
            </button>
            <button
              className="btn btn-sm"
              onClick={() => setWatchOpenId(watchOpenId === item.id ? null : item.id)}
            >
              {watchOpenId === item.id ? 'Close' : 'Open'}
            </button>
          </div>
        </div>
      ))}
      {watchActioned.length > 0 && (
        <>
          <h4 className="mt">Recently actioned watch items</h4>
          {watchActioned.map((item) => (
            <div key={item.id} className="card">
              <div className="row-between">
                <div>
                  <span className="chip green">actioned</span>{' '}
                  <span className="chip small">{item.app}</span>{' '}
                  <span className="small">{item.summary}</span>
                </div>
                <button
                  className="btn btn-sm"
                  onClick={() => setWatchOpenId(watchOpenId === item.id ? null : item.id)}
                >
                  {watchOpenId === item.id ? 'Close' : 'Open'}
                </button>
              </div>
              {watchOpenId === item.id && item.draftText && (
                <pre className="mono small mt" style={{ maxHeight: 200, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
                  {item.draftText}
                </pre>
              )}
            </div>
          ))}
        </>
      )}

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
              {c.expiresAt === null ? 'No expiry' : `expires in ${peerCountdown(c.expiresAt)}`} · {fmtTs(c.createdAt)}
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

      {/* --- Credential proposal cards: a bot needs a secret it doesn't have.
          Fulfill writes the value straight to the vault and resumes the turn;
          the value never lands in the proposals DB or the audit trail. ---- */}
      <CredentialProposalsSection
        cards={credPending}
        acting={acting}
        setActing={setActing}
        refresh={refresh}
      />

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

function CredentialProposalsSection({
  cards,
  acting,
  setActing,
  refresh,
}: {
  cards: CredentialProposal[];
  acting: string;
  setActing: (s: string) => void;
  refresh: () => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  if (cards.length === 0) return null;

  const decide = async (id: string, decision: 'fulfill' | 'deny') => {
    const value = values[id] ?? '';
    if (decision === 'fulfill' && !value) return;
    setActing(id);
    try {
      await decideCredentialProposal(id, decision, decision === 'fulfill' ? value : undefined);
      setValues((v) => {
        const next = { ...v };
        delete next[id];
        return next;
      });
      await refresh();
    } finally {
      setActing('');
    }
  };

  return (
    <>
      <div className="row-between mt">
        <h3 className="mt0">Credential requests ({cards.length})</h3>
        <span className="small muted" title="A bot asked for a secret it doesn't have. Supply it once — it goes straight to the vault.">
          bot → vault · 15-min expiry
        </span>
      </div>
      {cards.map((c) => (
        <div key={c.id} className="card triage-item" style={{ borderLeft: '3px solid var(--warn, #c90)' }}>
          <div className="row-between">
            <div>
              <span className="chip" title="Credential proposal card">🔑 credential</span>{' '}
              <strong>{c.label || c.key}</strong>
              <div className="small muted">
                {c.botId} needs <code>{c.key}</code>
                {c.reason ? ` — ${c.reason}` : ''}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <input
              type="password"
              className="input"
              placeholder="Paste the secret value"
              autoComplete="off"
              value={values[c.id] ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, [c.id]: e.target.value }))}
              style={{ flex: 1 }}
            />
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={acting === c.id || !(values[c.id] ?? '').trim()}
              onClick={() => void decide(c.id, 'fulfill')}
            >
              Save to vault
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={acting === c.id}
              onClick={() => void decide(c.id, 'deny')}
            >
              Deny
            </button>
          </div>
        </div>
      ))}
    </>
  );
}
