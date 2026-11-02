// SPDX-License-Identifier: Apache-2.0
// OH-2 eval: labeled queries over the SEEDED subagent-profile roster
// (155 profiles, loadSubagentProfiles) — keyword-only vs blended
// (trigram embedder = the real offline lane). Measured 2026-11-02:
//   keyword-only:    top-1 15/28, top-3 17/28
//   blended-trigram: top-1 18/28, top-3 20/28
// Floors below sit one notch under the measured values so roster edits
// trip the guard only on a real regression, not a tie reshuffle.
import { describe, expect, it } from 'vitest';
import { loadSubagentProfiles } from '../src/subagent-profiles.js';
import { TrigramEmbedder } from '../src/hybrid-search.js';
import { rankBotsByIntent, keywordScoresForBots, type RankableBot } from '../src/discovery.js';

export const SEMANTIC_EVAL_QUERIES: Array<{ query: string; expected: string }> = [
  { query: 'design a REST API for our payments service', expected: 'engineering-api-designer' },
  { query: 'build the frontend architecture for a React dashboard', expected: 'engineering-frontend-architect' },
  { query: 'debug a slow SQL database query and fix indexing', expected: 'engineering-database-engineer' },
  { query: 'set up CI/CD pipelines and Kubernetes deployments', expected: 'engineering-devops-engineer' },
  { query: 'improve site reliability and reduce incident downtime', expected: 'engineering-sre-specialist' },
  { query: 'write automated QA tests for our web app', expected: 'engineering-qa-automation-engineer' },
  { query: 'audit our application security for vulnerabilities', expected: 'engineering-security-engineer' },
  { query: 'create business intelligence dashboards and reports', expected: 'data-bi-developer' },
  { query: 'forecast future demand using historical data', expected: 'data-forecasting-analyst' },
  { query: 'process natural language text for sentiment analysis', expected: 'data-nlp-specialist' },
  { query: 'design user research studies and interview users', expected: 'product-ux-researcher' },
  { query: 'plan the product roadmap for next quarter', expected: 'product-roadmap-planner' },
  { query: 'reduce churn among subscribers', expected: 'product-churn-analyst' },
  { query: 'coordinate logistics and shipping schedules', expected: 'ops-logistics-coordinator' },
  { query: 'review contracts and legal terms for the company', expected: 'ops-contract-reviewer' },
  { query: 'run payroll for employees', expected: 'ops-payroll-specialist' },
  { query: 'do a literature review of published research papers', expected: 'research-literature-reviewer' },
  { query: 'fact check claims in an article before publication', expected: 'research-fact-checker' },
  { query: 'write a whitepaper on industry trends', expected: 'writing-whitepaper-writer' },
  { query: 'write SEO blog content that ranks on Google', expected: 'writing-seo-writer' },
  { query: 'handle billing support tickets from customers', expected: 'support-billing-support-specialist' },
  { query: 'process a refund for an unhappy customer', expected: 'support-refund-specialist' },
  { query: 'prepare a financial analysis of quarterly revenue', expected: 'business-financial-analyst' },
  { query: 'plan an ad campaign and measure its performance', expected: 'business-ad-campaign-analyst' },
  { query: 'help customers succeed and renew their accounts', expected: 'ops-customer-success-manager' },
  { query: 'run A/B experimentation analysis on the new feature', expected: 'data-experimentation-analyst' },
  { query: 'make our website load faster', expected: 'engineering-performance-engineer' },
  { query: 'keep hackers out of our systems', expected: 'engineering-security-engineer' },
];

describe('OH-2 eval: keyword-only vs blended-trigram over the seeded roster', () => {
  it('measures both lanes and keeps blended at or above the recorded floors', async () => {
    const profiles = loadSubagentProfiles();
    expect(profiles.length).toBeGreaterThanOrEqual(150);
    const bots: RankableBot[] = profiles.map((p) => ({
      id: p.id, name: p.name, description: `${p.specialty}. ${p.description}`,
    }));
    // Every expected id must exist in the seeded roster.
    for (const q of SEMANTIC_EVAL_QUERIES) expect(bots.some((b) => b.id === q.expected)).toBe(true);

    const emb = new TrigramEmbedder();
    let kwTop1 = 0, kwTop3 = 0, blTop1 = 0, blTop3 = 0;
    for (const { query, expected } of SEMANTIC_EVAL_QUERIES) {
      const kwScores = keywordScoresForBots(query, bots);
      const kwRanked = [...bots]
        .sort((a, b) => (kwScores.get(b.id)! - kwScores.get(a.id)!) || (a.id < b.id ? -1 : 1))
        .map((b) => b.id);
      const blended = await rankBotsByIntent(query, bots, emb, { topK: 3, blend: { keywordScores: kwScores } });
      const blIds = blended.map((h) => h.item.id);
      if (kwRanked[0] === expected) kwTop1++;
      if (kwRanked.slice(0, 3).includes(expected)) kwTop3++;
      if (blIds[0] === expected) blTop1++;
      if (blIds.includes(expected)) blTop3++;
    }
    const n = SEMANTIC_EVAL_QUERIES.length;
    // eslint-disable-next-line no-console
    console.log(`OH-2 eval (n=${n}): keyword top1=${kwTop1} top3=${kwTop3}; blended-trigram top1=${blTop1} top3=${blTop3}`);
    expect(kwTop1).toBeGreaterThanOrEqual(14);
    expect(kwTop3).toBeGreaterThanOrEqual(16);
    expect(blTop1).toBeGreaterThanOrEqual(17);
    expect(blTop3).toBeGreaterThanOrEqual(19);
    expect(blTop1).toBeGreaterThanOrEqual(kwTop1);
  });
});
