// SPDX-License-Identifier: Apache-2.0
/**
 * Dreams (A11, Timon parity programme): an overnight self-improvement
 * PROPOSAL pass. Clean-room: behaviour only — no Timon (AGPL) code or
 * text was consulted or copied.
 *
 * Why this exists (reasoning):
 * A10 gave memory a safe output surface: synthesis may propose rules,
 * but only a verified user decision promotes them. Dreams extends the
 * same posture to OPERATIONAL self-improvement. Once a night (opt-in,
 * off by default) a deterministic pass reads the recent window of the
 * local audit/Activity trail and the bot's A10 memory, and turns
 * recurring patterns into a short ranked list of IMPROVEMENT LEADS:
 * a tool that keeps failing, approvals the user keeps denying, a rule
 * that was approved but never fired, a manual action repeated often
 * enough to be a routine candidate, a proposals inbox backlog.
 *
 * HARD RULE — propose-only: this module NEVER applies a change. It
 * cannot mint or edit a rule (decideRuleProposal in memory.ts is the
 * only rule-minting path and it requires a user decision), cannot
 * create or enable a routine, and cannot touch settings. Leads land in
 * a file-backed inbox (DreamLeadStore); the API layer maps a user's
 * Accept onto EXISTING safe artefacts only — an A10 rule proposal
 * (still pending, still user-gated) or a DISABLED routine draft — and
 * a lead with no safe mapping is simply acknowledged/archived on
 * accept. There is deliberately no apply path to invent.
 *
 * Scoring: transparent heuristics, deterministic given the same inputs
 * (same events + same memory signals + same window ⇒ same leads in the
 * same order; ties break on kind then key). No model is required. An
 * optional model summariser may rephrase the run's leads ONLY when the
 * host wires one (the bot's already-configured lane) and the user
 * enabled summarisation in settings; it is fail-closed — any failure
 * yields the deterministic output with no summary — and it can never
 * add, drop, or re-rank leads.
 *
 * Dismissals are signal: a dismissed lead's key is suppressed for a
 * cooling period (default 30 days), a snoozed lead until its snooze
 * expires, and a rule-type lead whose suggested text matches a rule
 * proposal the user already dismissed in A10's inbox is never
 * generated at all.
 *
 * Privacy: the pass reads only this instance's own audit trail and
 * memory (both already local). Nothing leaves the machine except —
 * when the user explicitly enabled it — the lead titles and evidence
 * COUNTS sent to the bot's already-configured model lane for
 * summarisation. The settings surface says exactly that.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KeeperChatFn, RuleScope, TieredMemoryStore } from './memory.js';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** One audit/Activity event, normalized by the host from its audit store. */
export interface DreamAuditEvent {
  /** Event time, epoch ms. */
  ts: number;
  /** The bot the event belongs to (host-resolved: detail.botId, else actor). */
  botId?: string;
  actor?: string;
  /** Audit action, e.g. 'tool.execute', 'approval.decided', 'memory.rule_synthesis'. */
  action: string;
  toolName?: string;
  /** Governance decision recorded on the event, when any ('denied', 'approved', …). */
  decision?: string;
  detail?: unknown;
}

/** The A10 memory signals a pass reads for one bot. */
export interface DreamMemorySignals {
  /** Approved rule atoms (id, text, when minted, material-use credit). */
  rules: Array<{ id: string; text: string; createdAt: number; useCredit?: number }>;
  /** How many A10 rule proposals sit pending in the inbox. */
  pendingProposalCount: number;
  /** Texts of rule proposals the user dismissed (never re-propose these). */
  dismissedRuleTexts: string[];
}

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------

export type DreamLeadKind =
  | 'recurring-failure'
  | 'approval-friction'
  | 'cooldown-refusal'
  | 'stale-rule'
  | 'manual-pattern'
  | 'proposal-backlog';

/**
 * The safe artefact a lead's Accept maps onto — resolved by the API
 * layer at decision time, never by the pass:
 * - 'rule'    → an A10 rule proposal (pending; promotion stays user-gated)
 * - 'routine' → a routine draft created DISABLED
 * - 'none'    → no safe mapping exists; Accept acknowledges/archives only
 */
export type DreamArtefact =
  | { type: 'rule'; text: string; scope: RuleScope }
  | { type: 'routine'; name: string; promptTemplate: string }
  | { type: 'none' };

export interface DreamLeadEvidence {
  /** How many events/atoms back this lead. The number the user judges by. */
  count: number;
  windowStart: number;
  windowEnd: number;
  /** Up to 3 example references (audit action/tool/time or atom:// ids). */
  examples: string[];
  /** Extra transparent numbers behind the score (age days, distinct days, …). */
  metrics: Record<string, number>;
}

export interface DreamLead {
  /** Stable dedupe/suppression key within a bot: kind + group identity. */
  key: string;
  kind: DreamLeadKind;
  botId: string;
  title: string;
  /** Human-readable suggested next step (never executed by the pass). */
  suggestedAction: string;
  evidence: DreamLeadEvidence;
  /** Deterministic heuristic score, 0–100. Higher = stronger evidence. */
  score: number;
  artefact: DreamArtefact;
}

export interface DreamThresholds {
  failureMin: number;
  denialMin: number;
  cooldownMin: number;
  manualMin: number;
  staleRuleDays: number;
  backlogMin: number;
  maxLeads: number;
}

export const DEFAULT_DREAM_THRESHOLDS: DreamThresholds = {
  failureMin: 3,
  denialMin: 3,
  cooldownMin: 2,
  manualMin: 4,
  staleRuleDays: 30,
  backlogMin: 5,
  maxLeads: 10,
};

// ---------------------------------------------------------------------------
// Deterministic analysis
// ---------------------------------------------------------------------------

export type DreamEventClass = 'failure' | 'denial' | 'cooldown' | 'other';

function detailObject(detail: unknown): Record<string, unknown> | null {
  if (typeof detail === 'string') {
    try {
      const parsed = JSON.parse(detail) as unknown;
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return typeof detail === 'object' && detail !== null ? (detail as Record<string, unknown>) : null;
}

/** Classify one audit event for the dream heuristics. Pure and total. */
export function classifyDreamEvent(event: DreamAuditEvent): DreamEventClass {
  const action = event.action.toLowerCase();
  const decision = (event.decision ?? '').toLowerCase();
  const detail = detailObject(event.detail);
  const detailStatus = typeof detail?.['status'] === 'string' ? (detail['status'] as string).toLowerCase() : '';
  if (
    decision === 'cooldown' ||
    /cooldown|rate.?limit|too many requests|\b429\b/.test(action) ||
    detailStatus === 'cooldown'
  ) {
    return 'cooldown';
  }
  if (decision === 'denied' || decision === 'deny' || /(^|[._-])denied$/.test(action) || detailStatus === 'denied') {
    return 'denial';
  }
  if (
    /fail|error/.test(action) ||
    decision === 'error' ||
    decision === 'failed' ||
    detailStatus === 'failed' ||
    detailStatus === 'error' ||
    detail?.['ok'] === false
  ) {
    return 'failure';
  }
  return 'other';
}

function normText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function exampleOf(event: DreamAuditEvent): string {
  const when = Number.isFinite(event.ts) ? new Date(event.ts).toISOString() : 'unknown-time';
  return `${event.action}${event.toolName ? ` · ${event.toolName}` : ''} · ${when}`;
}

function distinctDays(events: DreamAuditEvent[]): number {
  return new Set(events.map((e) => new Date(e.ts).toISOString().slice(0, 10))).size;
}

const MANUAL_EXCLUDED_PREFIXES = ['memory.', 'dreams.', 'audit.'];
const MANUAL_EXCLUDED_ACTIONS = new Set(['tool.evaluate']);

/**
 * The deterministic core: same inputs ⇒ same ranked leads. Reads no
 * clock and no store — the window is an input. Rule-type leads whose
 * suggested text matches a dismissed A10 rule proposal are dropped
 * (the user's earlier "no" sticks, exactly as in A10 synthesis).
 */
export function analyzeDreamWindow(input: {
  botId: string;
  events: DreamAuditEvent[];
  memory: DreamMemorySignals;
  windowStart: number;
  windowEnd: number;
  thresholds?: Partial<DreamThresholds>;
}): DreamLead[] {
  const t: DreamThresholds = { ...DEFAULT_DREAM_THRESHOLDS, ...(input.thresholds ?? {}) };
  const { botId, windowStart, windowEnd } = input;
  const events = input.events.filter((e) => e.ts >= windowStart && e.ts <= windowEnd);
  const leads: DreamLead[] = [];

  const groups = new Map<string, { cls: DreamEventClass; label: string; events: DreamAuditEvent[] }>();
  for (const event of events) {
    const cls = classifyDreamEvent(event);
    if (cls === 'other') continue;
    const label = event.toolName ?? event.action;
    const key = `${cls}:${label}`;
    const group = groups.get(key) ?? { cls, label, events: [] };
    group.events.push(event);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    const count = group.events.length;
    const examples = group.events.slice(0, 3).map(exampleOf);
    const metrics = { distinctDays: distinctDays(group.events) };
    if (group.cls === 'failure' && count >= t.failureMin) {
      leads.push({
        key: `recurring-failure:${group.label}`,
        kind: 'recurring-failure',
        botId,
        title: `“${group.label}” failed ${count} times in the window`,
        suggestedAction: `Consider a rule for ${botId}: when ${group.label} fails, stop and report the error instead of retrying. Accepting creates that rule as a pending proposal for your review — it does not apply it.`,
        evidence: { count, windowStart, windowEnd, examples, metrics },
        score: Math.min(95, 40 + 10 * count),
        artefact: {
          type: 'rule',
          text: `When ${group.label} fails, stop and report the error instead of retrying repeatedly.`,
          scope: { kind: 'agent', id: botId },
        },
      });
    } else if (group.cls === 'denial' && count >= t.denialMin) {
      leads.push({
        key: `approval-friction:${group.label}`,
        kind: 'approval-friction',
        botId,
        title: `Approvals for “${group.label}” were denied ${count} times`,
        suggestedAction: `You keep denying ${group.label}. Consider a standing rule that ${botId} must not use it without your explicit confirmation. Accepting creates that rule as a pending proposal — it does not apply it.`,
        evidence: { count, windowStart, windowEnd, examples, metrics },
        score: Math.min(95, 35 + 10 * count),
        artefact: {
          type: 'rule',
          text: `Do not use ${group.label} without the user's explicit confirmation first.`,
          scope: { kind: 'agent', id: botId },
        },
      });
    } else if (group.cls === 'cooldown' && count >= t.cooldownMin) {
      leads.push({
        key: `cooldown-refusal:${group.label}`,
        kind: 'cooldown-refusal',
        botId,
        title: `“${group.label}” hit cooldown / refusal ${count} times`,
        suggestedAction: `Repeated cooldowns usually mean the call pattern is too aggressive. Review how ${botId} uses ${group.label}; there is no safe automatic fix, so accepting only acknowledges this lead.`,
        evidence: { count, windowStart, windowEnd, examples, metrics },
        score: Math.min(90, 30 + 8 * count),
        artefact: { type: 'none' },
      });
    }
  }

  // Repeated manual work: 'other' audit actions recurring often enough
  // to be a routine candidate. System bookkeeping actions are excluded.
  const manualGroups = new Map<string, DreamAuditEvent[]>();
  for (const event of events) {
    if (classifyDreamEvent(event) !== 'other') continue;
    if (MANUAL_EXCLUDED_ACTIONS.has(event.action)) continue;
    if (MANUAL_EXCLUDED_PREFIXES.some((p) => event.action.startsWith(p))) continue;
    const list = manualGroups.get(event.action) ?? [];
    list.push(event);
    manualGroups.set(event.action, list);
  }
  for (const [action, list] of manualGroups) {
    if (list.length < t.manualMin) continue;
    leads.push({
      key: `manual-pattern:${action}`,
      kind: 'manual-pattern',
      botId,
      title: `“${action}” was done manually ${list.length} times`,
      suggestedAction: `This looks like repeatable work. Accepting creates a DISABLED routine draft for ${botId} that you can review, edit, and enable yourself — nothing runs until you enable it.`,
      evidence: {
        count: list.length,
        windowStart,
        windowEnd,
        examples: list.slice(0, 3).map(exampleOf),
        metrics: { distinctDays: distinctDays(list) },
      },
      score: Math.min(90, 30 + 6 * list.length),
      artefact: {
        type: 'routine',
        name: `Draft: automate “${action}”`.slice(0, 120),
        promptTemplate: `Carry out the recurring “${action}” task for the user. (Draft created by the Dreams pass — review and edit before enabling.)`,
      },
    });
  }

  // Stale rules: approved, old, and never materially used (useCredit 0).
  for (const rule of input.memory.rules) {
    const ageDays = Math.floor((windowEnd - rule.createdAt) / 86_400_000);
    if (ageDays < t.staleRuleDays) continue;
    if ((rule.useCredit ?? 0) > 0) continue;
    leads.push({
      key: `stale-rule:${rule.id}`,
      kind: 'stale-rule',
      botId,
      title: `Approved rule never used in ${ageDays} days: “${rule.text.slice(0, 80)}”`,
      suggestedAction: `This rule was approved ${ageDays} days ago and has never fired. Consider reviewing or forgetting it in Memory. Accepting only acknowledges this lead — Dreams never edits rules.`,
      evidence: { count: 1, windowStart, windowEnd, examples: [`atom://${rule.id}`], metrics: { ageDays, useCredit: 0 } },
      score: Math.min(80, 25 + Math.min(ageDays, 30)),
      artefact: { type: 'none' },
    });
  }

  // Inbox backlog: A10 proposals waiting on the user.
  if (input.memory.pendingProposalCount >= t.backlogMin) {
    leads.push({
      key: 'proposal-backlog:rule-proposals',
      kind: 'proposal-backlog',
      botId,
      title: `${input.memory.pendingProposalCount} rule proposals are waiting for your decision`,
      suggestedAction: `Review the pending rule proposals in Workspace → Memory. Accepting only acknowledges this lead.`,
      evidence: {
        count: input.memory.pendingProposalCount,
        windowStart,
        windowEnd,
        examples: [],
        metrics: { pendingProposals: input.memory.pendingProposalCount },
      },
      score: Math.min(75, 20 + 3 * input.memory.pendingProposalCount),
      artefact: { type: 'none' },
    });
  }

  // A dismissed A10 rule proposal suppresses a matching rule-type lead.
  const dismissedTexts = new Set(input.memory.dismissedRuleTexts.map(normText));
  const kept = leads.filter(
    (lead) => !(lead.artefact.type === 'rule' && dismissedTexts.has(normText(lead.artefact.text))),
  );

  kept.sort(
    (a, b) => b.score - a.score || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  return kept.slice(0, t.maxLeads);
}

// ---------------------------------------------------------------------------
// Leads inbox (file-backed, the dreaming.ts / ingestion-settings idiom)
// ---------------------------------------------------------------------------

export type DreamLeadStatus = 'pending' | 'accepted' | 'dismissed' | 'snoozed';

export interface DreamLeadRecord extends DreamLead {
  id: string;
  status: DreamLeadStatus;
  createdAt: number;
  decidedAt?: number;
  /** The verified user id that decided (never a bot, never a raw client id alone). */
  decidedBy?: string;
  /** Set while snoozed; the lead resurfaces as a candidate after this time. */
  snoozedUntil?: number;
  /** What Accept actually created (set by the API layer's safe mapping). */
  acceptedArtefact?: { type: 'rule-proposal' | 'routine-draft' | 'acknowledged'; id?: string };
}

/** Default cooling period: a dismissed lead stays suppressed for 30 days. */
export const DEFAULT_DREAM_COOLING_MS = 30 * 86_400_000;

interface DreamLeadFile {
  leads: DreamLeadRecord[];
  lastRunAt: Record<string, number>;
}

export class DreamLeadStore {
  private readonly file: string;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, 'dreams-leads.json');
  }

  private readAll(): DreamLeadFile {
    try {
      if (!existsSync(this.file)) return { leads: [], lastRunAt: {} };
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<DreamLeadFile>;
      return { leads: parsed.leads ?? [], lastRunAt: parsed.lastRunAt ?? {} };
    } catch {
      return { leads: [], lastRunAt: {} };
    }
  }

  private writeAll(data: DreamLeadFile): void {
    // tmp + rename, the memory-ingestion settings-file idiom.
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmp, this.file);
  }

  /** True when a lead key must not be (re-)created for this bot right now. */
  isSuppressed(botId: string, key: string, now: number, coolingMs = DEFAULT_DREAM_COOLING_MS): boolean {
    for (const lead of this.readAll().leads) {
      if (lead.botId !== botId || lead.key !== key) continue;
      if (lead.status === 'pending') return true;
      if (lead.status === 'snoozed' && (lead.snoozedUntil ?? 0) > now) return true;
      if ((lead.status === 'dismissed' || lead.status === 'accepted') && lead.decidedAt !== undefined && now - lead.decidedAt < coolingMs) {
        return true;
      }
    }
    return false;
  }

  /** Add fresh leads, skipping suppressed keys. Returns what was created. */
  addLeads(leads: DreamLead[], now: number, coolingMs = DEFAULT_DREAM_COOLING_MS): { created: DreamLeadRecord[]; suppressed: number } {
    const data = this.readAll();
    const created: DreamLeadRecord[] = [];
    let suppressed = 0;
    const suppressedNow = (botId: string, key: string): boolean =>
      [...data.leads, ...created].some((lead) => {
        if (lead.botId !== botId || lead.key !== key) return false;
        if (lead.status === 'pending') return true;
        if (lead.status === 'snoozed' && (lead.snoozedUntil ?? 0) > now) return true;
        return (
          (lead.status === 'dismissed' || lead.status === 'accepted') &&
          lead.decidedAt !== undefined &&
          now - lead.decidedAt < coolingMs
        );
      });
    for (const lead of leads) {
      if (suppressedNow(lead.botId, lead.key)) {
        suppressed++;
        continue;
      }
      const record: DreamLeadRecord = { ...lead, id: randomUUID(), status: 'pending', createdAt: now };
      created.push(record);
      data.leads.push(record);
    }
    if (created.length > 0) {
      data.leads = data.leads.slice(-1000);
      this.writeAll(data);
    }
    return { created, suppressed };
  }

  list(botId: string, status: DreamLeadStatus | 'all' = 'pending', limit = 200): DreamLeadRecord[] {
    return this.readAll()
      .leads.filter((l) => l.botId === botId && (status === 'all' || l.status === status))
      .sort((a, b) => b.score - a.score || b.createdAt - a.createdAt)
      .slice(0, Math.min(Math.max(limit, 1), 1000));
  }

  get(botId: string, leadId: string): DreamLeadRecord | undefined {
    return this.readAll().leads.find((l) => l.botId === botId && l.id === leadId);
  }

  /**
   * Record the USER's decision on a pending lead. Accept does NOT apply
   * anything here — the API layer first resolves the lead's safe
   * artefact mapping and passes what it created as `acceptedArtefact`.
   * Throws on unknown or already-decided leads (fail-closed).
   */
  decideLead(
    botId: string,
    leadId: string,
    decision: {
      action: 'accept' | 'dismiss' | 'snooze';
      decidedBy: string;
      now?: number;
      snoozeMs?: number;
      acceptedArtefact?: DreamLeadRecord['acceptedArtefact'];
    },
  ): DreamLeadRecord {
    if (!decision.decidedBy.trim()) throw new Error('decidedBy (the deciding user) is required');
    const data = this.readAll();
    const lead = data.leads.find((l) => l.botId === botId && l.id === leadId);
    if (!lead) throw new Error(`Unknown dream lead "${leadId}"`);
    if (lead.status !== 'pending') throw new Error(`Dream lead "${leadId}" is already ${lead.status}`);
    const now = decision.now ?? Date.now();
    lead.decidedAt = now;
    lead.decidedBy = decision.decidedBy;
    if (decision.action === 'accept') {
      lead.status = 'accepted';
      lead.acceptedArtefact = decision.acceptedArtefact ?? { type: 'acknowledged' };
    } else if (decision.action === 'dismiss') {
      lead.status = 'dismissed';
    } else {
      lead.status = 'snoozed';
      lead.snoozedUntil = now + Math.max(decision.snoozeMs ?? 7 * 86_400_000, 60_000);
    }
    this.writeAll(data);
    return lead;
  }

  lastRunAt(botId: string): number | undefined {
    return this.readAll().lastRunAt[botId];
  }

  recordRun(botId: string, ts: number): void {
    const data = this.readAll();
    data.lastRunAt[botId] = ts;
    this.writeAll(data);
  }
}

// ---------------------------------------------------------------------------
// Optional model summarisation (fail-closed; never alters leads)
// ---------------------------------------------------------------------------

export type DreamSummarizer = (input: { botId: string; leads: DreamLead[] }) => Promise<string | undefined>;

const DREAM_SUMMARY_SYSTEM_PROMPT = `You summarise an AI assistant's overnight improvement leads for its owner.
Write at most 3 short sentences. Use ONLY the lead titles and evidence counts given — never invent numbers, never suggest that anything was applied or changed: every lead is a proposal awaiting the owner's decision.`;

export function createModelDreamSummarizer(chat: KeeperChatFn): DreamSummarizer {
  return async ({ leads }) => {
    if (leads.length === 0) return undefined;
    try {
      const lines = leads.map((l) => `- ${l.title} (evidence count: ${l.evidence.count}, score: ${l.score})`).join('\n');
      const raw = await chat(DREAM_SUMMARY_SYSTEM_PROMPT, `Improvement leads:\n${lines}`.slice(0, 4000));
      const text = raw.trim().slice(0, 1000);
      return text || undefined;
    } catch {
      return undefined; // fail-closed: deterministic output stands alone
    }
  };
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

export interface DreamPassDeps {
  memory: TieredMemoryStore;
  leads: DreamLeadStore;
  /** Host-supplied audit/Activity read for one bot's window (local only). */
  auditEvents: (botId: string, since: number, until: number) => DreamAuditEvent[] | Promise<DreamAuditEvent[]>;
  /** Optional model lane. Only consulted when provided AND leads were created. */
  summarizer?: DreamSummarizer;
  thresholds?: Partial<DreamThresholds>;
  coolingMs?: number;
  now?: () => number;
}

export interface DreamPassResult {
  botId: string;
  ok: true;
  windowStart: number;
  windowEnd: number;
  /** Leads newly written to the inbox by this run. */
  created: DreamLeadRecord[];
  /** Candidate leads skipped because their key is suppressed. */
  suppressed: number;
  /** Audit events considered in the window. */
  considered: number;
  /** Model summary of the created leads, when a summariser ran successfully. */
  summary?: string;
  lane: 'deterministic' | 'deterministic+model';
}

/**
 * Run one Dreams pass for a bot. PROPOSE-ONLY: the only writes are to
 * the DreamLeadStore (new pending leads + the run watermark). Rules,
 * routines, settings, and memory atoms are read, never mutated — the
 * propose-only test snapshots them before/after to prove it.
 *
 * Window: `opts.since` … `opts.until`, defaulting to (last recorded
 * run … now), or the last 24h for a first run.
 */
export async function runDreamPass(
  deps: DreamPassDeps,
  botId: string,
  opts: { since?: number; until?: number } = {},
): Promise<DreamPassResult> {
  const now = deps.now ?? (() => Date.now());
  const until = opts.until ?? now();
  const since = opts.since ?? deps.leads.lastRunAt(botId) ?? until - 86_400_000;

  const events = await deps.auditEvents(botId, since, until);
  const memory: DreamMemorySignals = {
    rules: deps.memory.listRuleAtoms(botId, 500).map((a) => ({
      id: a.id,
      text: a.fact,
      createdAt: a.createdAt,
      ...(typeof a.useCredit === 'number' ? { useCredit: a.useCredit } : {}),
    })),
    pendingProposalCount: deps.memory.listRuleProposals(botId, 'pending', 1000).length,
    dismissedRuleTexts: deps.memory.listRuleProposals(botId, 'dismissed', 1000).map((p) => p.text),
  };

  const candidates = analyzeDreamWindow({
    botId,
    events,
    memory,
    windowStart: since,
    windowEnd: until,
    ...(deps.thresholds ? { thresholds: deps.thresholds } : {}),
  });
  const { created, suppressed } = deps.leads.addLeads(candidates, until, deps.coolingMs);
  deps.leads.recordRun(botId, until);

  let summary: string | undefined;
  if (deps.summarizer && created.length > 0) {
    try {
      summary = await deps.summarizer({ botId, leads: created });
    } catch {
      summary = undefined; // a broken lane never fails the pass
    }
  }

  return {
    botId,
    ok: true,
    windowStart: since,
    windowEnd: until,
    created,
    suppressed,
    considered: events.length,
    ...(summary ? { summary } : {}),
    lane: summary ? 'deterministic+model' : 'deterministic',
  };
}
