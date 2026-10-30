// SPDX-License-Identifier: Apache-2.0
/**
 * "Why was this suggested?" (SI-5): a lookup over the evidence stores
 * that already exist — idea provenance (scores/rationale/evidence
 * written by curation, I-6), the invocation decision log (routing /
 * skill-activation / tool / delegation decisions with rationales), and
 * the governance audit trail (injected by the host).
 *
 *   GET /why?subject=<idea-id | decision-id | free text>
 *     → { ok, subject, found, explanations: [...] }
 *
 * Each explanation names its source store, gives a plain summary and
 * carries the raw evidence (scores, matched context, rationale) so the
 * UI can show receipts, not vibes. Read-only: nothing here mutates.
 *
 * HOST WIRING (coordinator): mount alongside the decision router —
 *   app.use('/api', createWhyRouter({ dataDir, mdb, auditSearch }))
 * where auditSearch queries the governance audit log (optional).
 */
import express, { type Router } from 'express';
import { InvocationDecisionLog } from '@mvp/agent-runtime';
import { IdeaStore, type Idea } from '@mvp/muse-modules';
import type { ModuleDb } from '@mvp/muse-modules';

export interface WhyExplanation {
  source: 'idea' | 'decision' | 'audit';
  subject: string;
  summary: string;
  evidence: Record<string, unknown>;
  ts?: number;
}

export interface WhyAuditHit {
  action: string;
  actor?: string;
  detail?: unknown;
  ts?: number;
}

export interface WhyDeps {
  dataDir: string;
  mdb: ModuleDb;
  /** Optional host audit search (governance audit log). */
  auditSearch?: (query: string) => WhyAuditHit[] | Promise<WhyAuditHit[]>;
}

function ideaExplanation(idea: Idea): WhyExplanation {
  const parts: string[] = [`Suggested via ${idea.source}.`];
  if (idea.rationale) parts.push(idea.rationale);
  if (idea.scores) {
    parts.push(
      `Scores: fit ${idea.scores.fit.toFixed(2)}, feasibility ${idea.scores.feasibility.toFixed(2)}, novelty ${idea.scores.novelty.toFixed(2)} → rank ${idea.scores.rank.toFixed(2)}.`,
    );
  }
  if (idea.evidence?.length) parts.push(`Evidence: ${idea.evidence.join('; ')}.`);
  return {
    source: 'idea',
    subject: idea.id,
    summary: parts.join(' '),
    evidence: {
      title: idea.title,
      status: idea.status,
      source: idea.source,
      scores: idea.scores ?? null,
      rationale: idea.rationale ?? null,
      evidence: idea.evidence ?? [],
    },
    ts: idea.createdAt,
  };
}

/** Pure lookup core (unit-testable without HTTP). */
export async function explainSubject(deps: WhyDeps, subject: string): Promise<{ found: boolean; explanations: WhyExplanation[] }> {
  const query = subject.trim();
  if (!query) return { found: false, explanations: [] };
  const explanations: WhyExplanation[] = [];

  // Ideas: exact id first, then title substring.
  const ideas = new IdeaStore(deps.mdb);
  try {
    explanations.push(ideaExplanation(ideas.get(query)));
  } catch {
    const lower = query.toLowerCase();
    for (const idea of ideas.list().filter((i) => i.title.toLowerCase().includes(lower)).slice(0, 5)) {
      explanations.push(ideaExplanation(idea));
    }
  }

  // Invocation decisions: exact id, or subject/rationale containing the query.
  const log = new InvocationDecisionLog(deps.dataDir);
  const lower = query.toLowerCase();
  for (const entry of log.all()) {
    if (entry.id === query || entry.subject.toLowerCase().includes(lower) || entry.rationale.toLowerCase().includes(lower)) {
      explanations.push({
        source: 'decision',
        subject: entry.id,
        summary: `${entry.kind} decision on "${entry.subject}": ${entry.outcome} (confidence ${entry.confidence.toFixed(2)}). ${entry.rationale}`,
        evidence: {
          kind: entry.kind,
          outcome: entry.outcome,
          confidence: entry.confidence,
          rationale: entry.rationale,
          botId: entry.botId ?? null,
          judgedCorrect: entry.judgedCorrect ?? null,
          metadata: entry.metadata ?? null,
        },
        ts: entry.ts,
      });
      if (explanations.length >= 25) break;
    }
  }

  // Governance audit trail (host-injected).
  if (deps.auditSearch) {
    try {
      for (const hit of (await deps.auditSearch(query)).slice(0, 10)) {
        explanations.push({
          source: 'audit',
          subject: query,
          summary: `Audit: ${hit.action}${hit.actor ? ` by ${hit.actor}` : ''}.`,
          evidence: { action: hit.action, actor: hit.actor ?? null, detail: hit.detail ?? null },
          ts: hit.ts,
        });
      }
    } catch {
      // Audit evidence is best-effort; the other stores still answer.
    }
  }

  explanations.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
  return { found: explanations.length > 0, explanations };
}

export function createWhyRouter(deps: WhyDeps): Router {
  const router = express.Router();
  router.get('/why', async (req, res) => {
    const subject = typeof req.query.subject === 'string' ? req.query.subject : '';
    if (!subject.trim()) {
      res.status(400).json({ ok: false, error: 'subject query parameter is required' });
      return;
    }
    const result = await explainSubject(deps, subject);
    res.json({ ok: true, subject, ...result });
  });
  return router;
}
