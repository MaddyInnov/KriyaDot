// SPDX-License-Identifier: Apache-2.0
'use client';

// Skills panel (OpenMausBot parity P1 #20): user skill lifecycle UI.
// - Skill list with status badges (draft/active/disabled), scope, and
//   enable/disable/delete actions.
// - Review queue: learned-skill proposals (approve → saved disabled, or
//   discard) and disabled skills awaiting enable.
// - Authoring form: create a new skill (always starts DISABLED).
// - Per-bot attachment: add/remove a skill from a bot's skill list.
//
// Security note shown in the UI: new skills start disabled and can never
// affect a bot until a human enables them — skills carry instructions, so
// this is the prompt-injection boundary.

import React, { useCallback, useEffect, useState } from 'react';
import { authedFetch } from '../../lib/api';

interface SkillScopeDto {
  type: 'global' | 'bots';
  botIds?: string[];
}

interface SkillDto {
  name: string;
  description: string;
  version: string;
  status: 'draft' | 'active' | 'disabled' | 'rejected';
  scope: SkillScopeDto;
  source: string;
  createdAt: string;
  updatedAt: string;
  createdByBot?: string;
  approvalId?: string;
  reviewedAt?: string;
  reviewedBy?: string;
  draftContent?: string;
  content?: string;
}

interface BotDto {
  id: string;
  name: string;
  skills?: string[];
}

const api = (path: string, init?: RequestInit): Promise<unknown> =>
  authedFetch(path, init).then(async (res) => {
    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new Error(`API ${res.status}: ${detail || res.statusText}`);
    }
    return res.json() as Promise<unknown>;
  });

const STATUS_LABEL: Record<SkillDto['status'], string> = {
  draft: 'Draft proposal',
  active: 'Active',
  disabled: 'Disabled',
  rejected: 'Rejected',
};

const STATUS_CLASS: Record<SkillDto['status'], string> = {
  draft: 'warn-box',
  active: 'info-box',
  disabled: 'badge',
  rejected: 'error-box',
};

export function scopeLabel(scope: SkillScopeDto): string {
  if (scope.type === 'global') return 'Global';
  const ids = scope.botIds ?? [];
  return ids.length ? `Bots: ${ids.join(', ')}` : 'Bots: (none)';
}

export function StatusBadge({ status }: { status: SkillDto['status'] }): React.ReactElement {
  return (
    <span className={`badge ${STATUS_CLASS[status]}`} style={{ display: 'inline-block' }}>
      {STATUS_LABEL[status]}
    </span>
  );
}

export default function SkillsPanel(): React.ReactElement {
  const [skills, setSkills] = useState<SkillDto[]>([]);
  const [seedSkills, setSeedSkills] = useState<string[]>([]);
  const [proposals, setProposals] = useState<SkillDto[]>([]);
  const [disabledQueue, setDisabledQueue] = useState<SkillDto[]>([]);
  const [bots, setBots] = useState<BotDto[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, string>>({});
  // Authoring form
  const [showForm, setShowForm] = useState(false);
  const [fName, setFName] = useState('');
  const [fDesc, setFDesc] = useState('');
  const [fInstructions, setFInstructions] = useState('');
  const [fExamples, setFExamples] = useState('');
  const [fScope, setFScope] = useState('');
  // Attach
  const [attachBot, setAttachBot] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const list = (await api('/api/skills')) as { skills: SkillDto[]; seedSkills: string[] };
      setSkills(list.skills ?? []);
      setSeedSkills(list.seedSkills ?? []);
      const queue = (await api('/api/skills/review/queue')) as {
        proposals: SkillDto[];
        disabled: SkillDto[];
      };
      setProposals(queue.proposals ?? []);
      setDisabledQueue(queue.disabled ?? []);
      const botList = (await api('/api/bots')) as BotDto[] | { bots: BotDto[] };
      setBots(Array.isArray(botList) ? botList : (botList.bots ?? []));
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (label: string, fn: () => Promise<unknown>, doneMsg?: string) => {
      setBusy(label);
      setError('');
      setNotice('');
      try {
        await fn();
        await load();
        if (doneMsg) setNotice(doneMsg);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy('');
      }
    },
    [load],
  );

  const toggleExpand = useCallback(
    async (skill: SkillDto) => {
      if (expanded === skill.name) {
        setExpanded(null);
        return;
      }
      setExpanded(skill.name);
      if (skill.status === 'draft' && skill.draftContent) {
        setDetail((d) => ({ ...d, [skill.name]: skill.draftContent as string }));
        return;
      }
      if (!detail[skill.name]) {
        try {
          const data = (await api(`/api/skills/${encodeURIComponent(skill.name)}`)) as {
            skill: SkillDto;
          };
          const content = data.skill.draftContent ?? data.skill.content ?? '';
          setDetail((d) => ({ ...d, [skill.name]: content }));
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    },
    [expanded, detail],
  );

  const createSkill = useCallback(async () => {
    const scope =
      fScope.trim() === '' || fScope.trim().toLowerCase() === 'global'
        ? 'global'
        : fScope
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
    await run(`create:${fName}`, () =>
      api('/api/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: fName.trim(),
          description: fDesc.trim(),
          instructions: fInstructions.trim(),
          ...(fExamples.trim() ? { examples: fExamples.trim() } : {}),
          scope,
        }),
      }),
      `Skill "${fName.trim()}" created DISABLED — enable it when ready.`,
    );
    setShowForm(false);
    setFName('');
    setFDesc('');
    setFInstructions('');
    setFExamples('');
    setFScope('');
  }, [fName, fDesc, fInstructions, fExamples, fScope, run]);

  const attach = useCallback(
    async (skillName: string) => {
      const botId = attachBot[skillName];
      if (!botId) return;
      await run(`attach:${skillName}`, () =>
        api(`/api/skills/${encodeURIComponent(skillName)}/attach`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ botId }),
        }),
        `Skill "${skillName}" attached to bot "${botId}".`,
      );
    },
    [attachBot, run],
  );

  const detach = useCallback(
    async (skillName: string, botId: string) => {
      await run(`detach:${skillName}`, () =>
        api(`/api/skills/${encodeURIComponent(skillName)}/attach/${encodeURIComponent(botId)}`, {
          method: 'DELETE',
        }),
      );
    },
    [run],
  );

  const renderSkillRow = (skill: SkillDto, opts: { proposal?: boolean } = {}): React.ReactElement => (
    <div className="card" style={{ marginBottom: 12 }} key={skill.name}>
      <div className="row-between">
        <div>
          <strong>{skill.name}</strong> <span className="small muted">v{skill.version}</span>{' '}
          <StatusBadge status={skill.status} />{' '}
          <span className="small muted">
            {scopeLabel(skill.scope)} · {skill.source}
            {skill.createdByBot ? ` · by ${skill.createdByBot}` : ''}
          </span>
          <div className="small" style={{ marginTop: 4 }}>
            {skill.description}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <button className="btn btn-sm" onClick={() => void toggleExpand(skill)}>
            {expanded === skill.name ? 'Hide' : 'View'}
          </button>
          {opts.proposal && (
            <>
              <button
                className="btn btn-sm btn-primary"
                disabled={!!busy}
                onClick={() =>
                  void run(`approve:${skill.name}`, () =>
                    api(`/api/skills/proposals/${encodeURIComponent(skill.name)}/approve`, { method: 'POST' }),
                    `Proposal approved — "${skill.name}" saved DISABLED.`,
                  )
                }
              >
                Approve
              </button>
              <button
                className="btn btn-sm"
                disabled={!!busy}
                onClick={() =>
                  void run(`discard:${skill.name}`, () =>
                    api(`/api/skills/proposals/${encodeURIComponent(skill.name)}/discard`, { method: 'POST' }),
                  )
                }
              >
                Discard
              </button>
            </>
          )}
          {skill.status === 'disabled' && (
            <button
              className="btn btn-sm btn-primary"
              disabled={!!busy}
              onClick={() =>
                void run(`enable:${skill.name}`, () =>
                  api(`/api/skills/${encodeURIComponent(skill.name)}/enable`, { method: 'POST' }),
                  `Skill "${skill.name}" enabled.`,
                )
              }
            >
              Enable
            </button>
          )}
          {skill.status === 'active' && (
            <button
              className="btn btn-sm"
              disabled={!!busy}
              onClick={() =>
                void run(`disable:${skill.name}`, () =>
                  api(`/api/skills/${encodeURIComponent(skill.name)}/disable`, { method: 'POST' }),
                )
              }
            >
              Disable
            </button>
          )}
          {(skill.status === 'disabled' || skill.status === 'rejected') && (
            <button
              className="btn btn-sm"
              disabled={!!busy}
              onClick={() => {
                if (window.confirm(`Delete skill "${skill.name}" permanently?`)) {
                  void run(`delete:${skill.name}`, () =>
                    api(`/api/skills/${encodeURIComponent(skill.name)}`, { method: 'DELETE' }),
                  );
                }
              }}
            >
              Delete
            </button>
          )}
        </div>
      </div>
      {expanded === skill.name && (
        <pre className="code-block" style={{ marginTop: 8, maxHeight: 320, overflow: 'auto' }}>
          {detail[skill.name] ?? 'Loading…'}
        </pre>
      )}
      {(skill.status === 'active' || skill.status === 'disabled') && bots.length > 0 && (
        <div className="small" style={{ marginTop: 8 }}>
          <span className="muted">Attached to: </span>
          {bots
            .filter((b) => (b.skills ?? []).includes(skill.name))
            .map((b) => (
              <span key={b.id} style={{ marginRight: 8 }}>
                {b.name}{' '}
                <button
                  className="btn btn-sm" style={{ padding: "0 6px", fontSize: "0.75rem" }}
                  disabled={!!busy}
                  onClick={() => void detach(skill.name, b.id)}
                  title={`Detach from ${b.name}`}
                >
                  ✕
                </button>
              </span>
            ))}
          {bots.filter((b) => (b.skills ?? []).includes(skill.name)).length === 0 && (
            <span className="muted">(none)</span>
          )}{' '}
          <select
            className="input" style={{ width: "auto", display: "inline-block" }}
            value={attachBot[skill.name] ?? ''}
            onChange={(e) => setAttachBot((m) => ({ ...m, [skill.name]: e.target.value }))}
            aria-label={`Attach ${skill.name} to bot`}
          >
            <option value="">Attach to bot…</option>
            {bots.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>{' '}
          <button className="btn btn-sm" disabled={!!busy || !attachBot[skill.name]} onClick={() => void attach(skill.name)}>
            Attach
          </button>
          {skill.status === 'disabled' && (
            <span className="small muted" style={{ marginLeft: 8 }}>
              Disabled skills stay inert even when attached — enable first.
            </span>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div>
      <div className="warn-box" style={{ marginBottom: 16 }}>
        <strong>Security boundary:</strong> new and learned skills start <strong>disabled</strong> — no bot can use
        them until you explicitly enable them here. Skills carry instructions, so review every proposal before
        approving.
      </div>

      {error && <div className="error-box">{error}</div>}
      {notice && <div className="info-box">{notice}</div>}
      {busy && <div className="small muted">Working: {busy}…</div>}

      <div className="row-between" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Review queue</h2>
        <button className="btn btn-sm btn-primary" onClick={() => setShowForm((v) => !v)}>
          {showForm ? 'Cancel' : '+ New skill'}
        </button>
      </div>

      {showForm && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ marginTop: 0 }}>Author a skill</h3>
          <div className="field">
            <label className="label" htmlFor="sk-name">Name</label>
            <input
              id="sk-name"
              className="input"
              value={fName}
              onChange={(e) => setFName(e.target.value)}
              placeholder="pdf-triage"
            />
          </div>
          <div className="field">
            <label className="label" htmlFor="sk-desc">Description</label>
            <input
              id="sk-desc"
              className="input"
              value={fDesc}
              onChange={(e) => setFDesc(e.target.value)}
              placeholder="One-line summary shown in the skill list"
            />
          </div>
          <div className="field">
            <label className="label" htmlFor="sk-instr">Instructions</label>
            <textarea
              id="sk-instr"
              className="input"
              rows={8}
              value={fInstructions}
              onChange={(e) => setFInstructions(e.target.value)}
              placeholder="The full skill instructions (SKILL.md body)…"
            />
          </div>
          <div className="field">
            <label className="label" htmlFor="sk-ex">Examples (optional)</label>
            <textarea
              id="sk-ex"
              className="input"
              rows={3}
              value={fExamples}
              onChange={(e) => setFExamples(e.target.value)}
              placeholder="Usage examples…"
            />
          </div>
          <div className="field">
            <label className="label" htmlFor="sk-scope">Scope (optional)</label>
            <input
              id="sk-scope"
              className="input"
              value={fScope}
              onChange={(e) => setFScope(e.target.value)}
              placeholder="global (default) or comma-separated bot ids"
            />
          </div>
          <button
            className="btn btn-primary"
            disabled={!!busy || !fName.trim() || !fDesc.trim() || !fInstructions.trim()}
            onClick={() => void createSkill()}
          >
            Create skill (starts disabled)
          </button>
        </div>
      )}

      {proposals.length === 0 && disabledQueue.length === 0 && (
        <p className="small muted">Nothing awaiting review. Learned-skill proposals from your bots will appear here.</p>
      )}
      {proposals.map((s) => renderSkillRow(s, { proposal: true }))}
      {disabledQueue.filter((s) => s.status === 'disabled').map((s) => renderSkillRow(s))}

      <h2 style={{ marginTop: 24 }}>Active skills</h2>
      {skills.filter((s) => s.status === 'active').length === 0 && (
        <p className="small muted">No active skills.</p>
      )}
      {skills.filter((s) => s.status === 'active').map((s) => renderSkillRow(s))}

      <h2 style={{ marginTop: 24 }}>Built-in skills</h2>
      <p className="small muted">
        Shipped with KriyaDot — always available, managed by the platform (read-only here).
      </p>
      <div className="small">{seedSkills.length ? seedSkills.join(', ') : '(none found)'}</div>
    </div>
  );
}
