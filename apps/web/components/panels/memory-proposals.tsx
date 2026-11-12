// SPDX-License-Identifier: Apache-2.0
'use client';

/**
 * Rule proposals inbox (A10, Timon parity programme) — the Workspace →
 * Memory surface for the capture → synthesis → user-approved promotion
 * pipeline.
 *
 * Facts are captured automatically; a synthesis pass (scheduled + the
 * "Synthesize now" button) distils them into CANDIDATE rules that land
 * here as pending proposals. Nothing becomes a standing rule until the
 * user approves it — approve as-is, edit the text then approve, or
 * dismiss (a dismissed rule is not re-proposed verbatim). Every proposal
 * shows its scope: Global, a specific Agent, or a specific Project.
 * Approved rules are injected into that scope's turns and cited as
 * "Rule" in the Memory-used note.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  decideRuleProposal,
  getRuleProposals,
  ruleScopeLabel,
  synthesizeRuleProposals,
  type RuleProposalRecord,
} from '../../lib/api';

export const PROPOSALS_EMPTY_STATE =
  'Facts are captured automatically; synthesis proposes rules here — nothing becomes a standing rule until you approve it.';

export function MemoryProposalsSection({ botId }: { botId: string }) {
  const [proposals, setProposals] = useState<RuleProposalRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [synthesizing, setSynthesizing] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');

  const refresh = useCallback(async () => {
    if (!botId) return;
    setLoading(true);
    setError('');
    try {
      const res = await getRuleProposals(botId, 'pending');
      setProposals(res.proposals ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [botId]);

  useEffect(() => {
    setEditingId(null);
    setNotice('');
    void refresh();
  }, [refresh]);

  const decide = useCallback(
    async (proposal: RuleProposalRecord, action: 'approve' | 'dismiss', text?: string) => {
      setBusyId(proposal.id);
      setError('');
      try {
        await decideRuleProposal(botId, proposal.id, action, text);
        setProposals((prev) => prev.filter((p) => p.id !== proposal.id));
        setEditingId(null);
        setNotice(
          action === 'approve'
            ? `Rule approved (${ruleScopeLabel(proposal.scope)}) — it now applies to matching turns.`
            : 'Proposal dismissed — it will not be proposed again verbatim.',
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyId(null);
      }
    },
    [botId],
  );

  const synthesize = useCallback(async () => {
    if (!botId) return;
    setSynthesizing(true);
    setError('');
    setNotice('');
    try {
      const res = await synthesizeRuleProposals(botId);
      setNotice(
        res.created.length > 0
          ? `Synthesis proposed ${res.created.length} new candidate rule(s) for your review.`
          : 'Synthesis ran — no new candidate rules from the memories captured so far.',
      );
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSynthesizing(false);
    }
  }, [botId, refresh]);

  if (!botId) return <p className="muted">Pick a bot first.</p>;

  return (
    <div className="memory-proposals">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
        <span className="muted" style={{ flex: 1, fontSize: 13 }}>
          Candidate rules distilled from captured memories. Only your approval turns one into a
          standing rule.
        </span>
        <button type="button" onClick={() => void synthesize()} disabled={synthesizing || loading}>
          {synthesizing ? 'Synthesizing…' : 'Synthesize now'}
        </button>
      </div>

      {error ? (
        <p role="alert" style={{ color: 'var(--danger, #c00)' }}>
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" style={{ color: 'var(--success, #2a7)' }}>
          {notice}
        </p>
      ) : null}

      {loading && proposals.length === 0 ? (
        <p className="muted">Loading proposals…</p>
      ) : proposals.length === 0 ? (
        <p className="muted">{PROPOSALS_EMPTY_STATE}</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }} aria-label="Pending rule proposals">
          {proposals.map((p) => (
            <li
              key={p.id}
              style={{ border: '1px solid var(--border, #ddd)', borderRadius: 8, padding: '10px 12px' }}
            >
              <div style={{ whiteSpace: 'pre-wrap', fontWeight: 500 }}>{p.text}</div>
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                <span className="chip gray">{ruleScopeLabel(p.scope)}</span>
                {p.rationale ? ` · ${p.rationale}` : ''}
                {` · ${new Date(p.createdAt).toLocaleDateString()}`}
                {p.sourceAtomIds.length > 0 ? ` · from ${p.sourceAtomIds.length} memor${p.sourceAtomIds.length === 1 ? 'y' : 'ies'}` : ''}
              </div>
              {editingId === p.id ? (
                <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
                  <textarea
                    rows={2}
                    style={{ width: '100%' }}
                    value={editDraft}
                    onChange={(e) => setEditDraft(e.target.value)}
                    aria-label={`Edit rule text: ${p.text}`}
                  />
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      type="button"
                      disabled={busyId === p.id || !editDraft.trim()}
                      onClick={() => void decide(p, 'approve', editDraft.trim())}
                    >
                      Approve edited rule
                    </button>
                    <button type="button" onClick={() => setEditingId(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                  <button type="button" disabled={busyId === p.id} onClick={() => void decide(p, 'approve')}>
                    Approve
                  </button>
                  <button
                    type="button"
                    disabled={busyId === p.id}
                    onClick={() => {
                      setEditingId(p.id);
                      setEditDraft(p.text);
                    }}
                  >
                    Edit &amp; approve
                  </button>
                  <button type="button" disabled={busyId === p.id} onClick={() => void decide(p, 'dismiss')}>
                    Dismiss
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
