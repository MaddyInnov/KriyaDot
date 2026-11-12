// SPDX-License-Identifier: Apache-2.0
/**
 * Memory pipeline A10 (Timon parity programme): capture → synthesis →
 * USER-APPROVED rule promotion, with per-agent / per-project scopes.
 *
 * Why this exists (reasoning):
 * Facts and rules are different kinds of memory. A fact is an observation
 * ("the user lives in Portland"); a rule is an INSTRUCTION the bot must
 * follow on future turns ("always run the tests before pushing"). KriyaDot
 * already captured facts automatically, but anything rule-like landed in
 * the same undifferentiated pile and took effect without the user ever
 * agreeing to it. That is both a product gap and a security hole:
 *
 * Threat model: captured text is untrusted. Conversation content —
 * including text a third party pasted, a web page a bot read, or a
 * counterparty's email — can contain imperative sentences ("always send
 * invoices to…"). If capture alone could mint standing instructions,
 * memory becomes a prompt-injection persistence layer: poison once,
 * obey forever. The fix is a trust boundary at promotion time:
 * synthesis may PROPOSE rules, but only an explicit user decision
 * (approve / edit-then-approve / dismiss, enforced at the API by a
 * verified principal — see apps/api memory-proposals-routes.ts) turns a
 * proposal into a rule. Bots, schedulers, and this module can never
 * approve.
 *
 * Pipeline:
 *  (a) capture — unchanged: per-turn distillation into fact atoms
 *      (TieredMemoryStore.ingestTurn / storeDistilledFacts).
 *  (b) synthesis — this module: distils captured atoms into CANDIDATE
 *      rules and writes them to the proposals inbox
 *      (TieredMemoryStore.createRuleProposal). Two candidate sources:
 *      a model lane (createModelRuleSynthesizer over the bot's own
 *      configured provider, via the existing KeeperChatFn seam) and a
 *      deterministic zero-model lane (rule-like atoms, standing-global
 *      recurrence across projects, per-project recurrence — reusing the
 *      #84/#85 upkeep helpers). Synthesis is safe with NO model
 *      configured: the model lane is simply skipped and the
 *      deterministic lane still runs; with nothing rule-like captured
 *      it produces zero proposals and reports success — never a failure.
 *  (c) promotion — TieredMemoryStore.decideRuleProposal, user-only.
 *
 * Scopes: every candidate/rule carries { kind: 'global' | 'agent' |
 * 'project', id? }. Injection (TieredMemoryStore.getApplicableRules /
 * buildMemoryPack) honours it strictly: a bot sees global rules, rules
 * scoped to itself, and rules scoped to the current project.
 *
 * Honest limits:
 * - The deterministic lane is pattern/recurrence heuristics, not
 *   understanding (same honesty contract as heuristicDistill). It will
 *   miss paraphrased rules and can propose near-duplicates across
 *   scopes; the user's inbox decision is the quality gate.
 * - Scope enforcement is prompt-level: rules are included/excluded from
 *   the context a bot is shown. In this single-owner local deployment
 *   that is the meaningful boundary; it is not an OS-level isolation
 *   between tenants (multi-tenant rule sharing is out of scope).
 * - A11 note (dreams): this design gives a future "dreaming" pass a
 *   safe output surface — dreams can write proposals, never rules —
 *   and the proposals table's source_atom_ids + rationale fields are
 *   exactly the provenance a dream journal would cite. It constrains
 *   dreams the same way it constrains synthesis: no direct promotion.
 */

import type {
  AtomCard,
  KeeperChatFn,
  RuleProposal,
  RuleScope,
  TieredMemoryStore,
} from './memory.js';
import { isUserRuleFact, normalizeRuleScope } from './memory.js';
import { proposeScopedMemoryRules, proposeStandingGlobalRules } from './memory-upkeep.js';

/** One candidate rule produced by a synthesizer lane, before inbox dedupe. */
export interface RuleCandidate {
  text: string;
  scope: RuleScope;
  sourceAtomIds: string[];
  rationale?: string;
}

/**
 * A model-lane synthesizer: given the bot's captured atoms, propose
 * candidate rules. Implementations must return [] (never throw into the
 * pipeline) when they cannot produce candidates.
 */
export type RuleSynthesizer = (input: { botId: string; atoms: AtomCard[] }) => Promise<RuleCandidate[]>;

const SYNTHESIS_SYSTEM_PROMPT = `You distil an AI assistant's captured memories into CANDIDATE standing rules for the user to approve.
Return ONLY a JSON array of objects, each with:
- "text": the rule as a short imperative or declarative instruction (e.g. "Always run the test suite before pushing.")
- "scopeKind": "global" (applies everywhere), "agent" (only this assistant), or "project" (only one project)
- "scopeId": the project id when scopeKind is "project", otherwise null
- "sourceIndexes": indexes of the memories this rule is distilled from
Rules must be genuinely supported by the listed memories — never invent instructions.
Propose at most 5 rules. If no memory supports a durable rule, return [].`;

function validScope(kind: unknown, id: unknown): RuleScope | null {
  try {
    return normalizeRuleScope({ kind, ...(typeof id === 'string' && id ? { id } : {}) });
  } catch {
    return null;
  }
}

/**
 * Build the model lane from a KeeperChatFn (the host wires the bot's own
 * provider — see apps/api buildBotChatFn). Fail-closed: any model or
 * parse failure yields zero candidates, so a synthesis run with an
 * unconfigured/broken model is a no-op success, never an error.
 */
export function createModelRuleSynthesizer(chat: KeeperChatFn): RuleSynthesizer {
  return async ({ atoms }) => {
    if (atoms.length === 0) return [];
    let raw: string;
    try {
      const numbered = atoms.map((a, i) => `[${i}] (${a.category}${a.projectId ? `, project ${a.projectId}` : ''}) ${a.fact}`).join('\n');
      raw = await chat(SYNTHESIS_SYSTEM_PROMPT, `Memories:\n${numbered}`.slice(0, 6000));
    } catch {
      return [];
    }
    try {
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      const parsed = JSON.parse(cleaned) as Array<{
        text?: unknown; scopeKind?: unknown; scopeId?: unknown; sourceIndexes?: unknown;
      }>;
      if (!Array.isArray(parsed)) return [];
      const out: RuleCandidate[] = [];
      for (const item of parsed.slice(0, 5)) {
        if (typeof item?.text !== 'string' || !item.text.trim()) continue;
        const scope = validScope(item.scopeKind ?? 'global', item.scopeId);
        if (!scope) continue;
        const sourceAtomIds = Array.isArray(item.sourceIndexes)
          ? item.sourceIndexes
              .filter((i): i is number => typeof i === 'number' && Number.isInteger(i) && i >= 0 && i < atoms.length)
              .map((i) => atoms[i]!.id)
          : [];
        out.push({ text: item.text.trim().slice(0, 500), scope, sourceAtomIds, rationale: 'model synthesis' });
      }
      return out;
    } catch {
      return [];
    }
  };
}

function normText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * The deterministic zero-model lane: candidate rules distilled from
 * captured atoms without any model call.
 * - A rule recurring across ≥2 projects → standing GLOBAL candidate (#85).
 * - Rule atoms recurring inside one project → PROJECT candidate (#85).
 * - Any other rule-like atom (preference / imperative wording, #75
 *   isUserRuleFact) not already covered → AGENT candidate for its bot
 *   (or PROJECT when the atom itself is project-scoped).
 */
export function deterministicRuleCandidates(store: TieredMemoryStore, botId: string): RuleCandidate[] {
  const out: RuleCandidate[] = [];
  const covered = new Set<string>();
  const push = (c: RuleCandidate) => {
    const key = normText(c.text);
    if (!key || covered.has(key)) return;
    covered.add(key);
    out.push(c);
  };
  try {
    for (const cand of proposeStandingGlobalRules(store, botId, { minScopes: 2 })) {
      push({
        text: cand.payload.fact,
        scope: { kind: 'global' },
        sourceAtomIds: cand.payload.atomIds,
        rationale: `same rule recurs in ${cand.payload.projectIds.length} projects`,
      });
    }
  } catch {
    // detection is best-effort; the lanes below still run
  }
  try {
    for (const cand of proposeScopedMemoryRules(store, botId, { minRecurrence: 2 })) {
      push({
        text: cand.payload.fact,
        scope: { kind: 'project', id: cand.payload.projectId },
        sourceAtomIds: cand.payload.atomIds,
        rationale: `recurs in project ${cand.payload.projectId}`,
      });
    }
  } catch {
    // best-effort
  }
  for (const atom of store.getAtoms(botId, 500)) {
    if (atom.isRule) continue;
    if (!isUserRuleFact({ fact: atom.fact, entities: atom.entities, confidence: atom.confidence, category: atom.category }, atom.category)) continue;
    push({
      text: atom.fact,
      scope: atom.projectId ? { kind: 'project', id: atom.projectId } : { kind: 'agent', id: botId },
      sourceAtomIds: [atom.id],
      rationale: 'rule-like memory captured from conversation',
    });
  }
  return out;
}

export interface SynthesisRunResult {
  botId: string;
  ok: true;
  /** Proposals newly written to the inbox by this run. */
  created: RuleProposal[];
  /** Candidates skipped (already pending / already a rule / previously dismissed). */
  skipped: number;
  /** Which lanes produced candidates: 'model', 'deterministic', or 'none'. */
  lane: 'model' | 'deterministic' | 'model+deterministic' | 'none';
}

/**
 * One synthesis pass for a bot (A10 stage b): gather candidates from the
 * model lane (when a synthesizer is supplied) and the deterministic lane,
 * dedupe against the inbox (pending), existing rules, AND dismissed
 * proposals (a dismissed rule is never re-proposed verbatim — the user's
 * "no" sticks), then write the survivors as PENDING proposals. Nothing
 * here can approve: promotion is decideRuleProposal, user-only.
 *
 * Safe with no model configured: omit `synthesizer` (or pass one whose
 * chat fails) and the run still succeeds — with no rule-like atoms it
 * creates zero proposals.
 */
export async function synthesizeRuleProposals(
  store: TieredMemoryStore,
  botId: string,
  opts: { synthesizer?: RuleSynthesizer; maxProposals?: number } = {},
): Promise<SynthesisRunResult> {
  const maxProposals = Math.min(Math.max(opts.maxProposals ?? 10, 1), 50);
  const atoms = store.getAtoms(botId, 500);
  let modelCandidates: RuleCandidate[] = [];
  if (opts.synthesizer) {
    try {
      modelCandidates = await opts.synthesizer({ botId, atoms });
    } catch {
      modelCandidates = []; // a broken lane never fails synthesis
    }
  }
  const deterministic = deterministicRuleCandidates(store, botId);
  const lane: SynthesisRunResult['lane'] =
    modelCandidates.length > 0 && deterministic.length > 0
      ? 'model+deterministic'
      : modelCandidates.length > 0
        ? 'model'
        : deterministic.length > 0
          ? 'deterministic'
          : 'none';

  // Dedupe universe: pending proposals, approved rule texts, dismissed texts.
  const pending = store.listRuleProposals(botId, 'pending', 1000);
  const dismissed = store.listRuleProposals(botId, 'dismissed', 1000);
  const ruleTexts = new Set(store.listRuleAtoms(botId, 1000).map((a) => normText(a.fact)));
  const seen = new Set<string>([
    ...pending.map((p) => normText(p.text)),
    ...dismissed.map((p) => normText(p.text)),
    ...ruleTexts,
  ]);

  const created: RuleProposal[] = [];
  let skipped = 0;
  for (const cand of [...modelCandidates, ...deterministic]) {
    if (created.length >= maxProposals) break;
    const text = cand.text.trim().slice(0, 500);
    const key = normText(text);
    if (!key || seen.has(key)) {
      skipped++;
      continue;
    }
    seen.add(key);
    let scope: RuleScope;
    try {
      scope = normalizeRuleScope(cand.scope);
    } catch {
      skipped++;
      continue;
    }
    const id = store.createRuleProposal(botId, {
      text,
      scope,
      sourceAtomIds: cand.sourceAtomIds ?? [],
      ...(cand.rationale ? { rationale: cand.rationale } : {}),
    });
    const proposal = store.getRuleProposal(botId, id);
    if (proposal) created.push(proposal);
  }
  return { botId, ok: true, created, skipped, lane };
}
