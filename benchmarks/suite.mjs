// SPDX-License-Identifier: Apache-2.0
/**
 * KriyaDot public benchmark pack — task definitions (OH-6).
 *
 * 13 tasks in 6 families. Every scorer is deterministic — no model
 * grades anything:
 *
 *  a. chat-routing (4)      — the REAL Universal router decision
 *     (`decideUniversalRoute` from apps/api/dist/universal.js, which
 *     internally uses `scoreBotsForRouting` from the agent-runtime
 *     dist) over fixture bots carrying `routeKeywords`. Scorer =
 *     expected bot id (+ expected path for the fallback case).
 *  b. tool-spill (1)        — a >=100 KB synthetic tool result through
 *     the runtime's ToolSpillStore spill/compression path
 *     (agent-runtime dist; the compression stage landed in parallel
 *     as OH-1 during this pack's authoring, and this task is coded
 *     against the resulting current dist API). Scorer = three equal
 *     parts: (1) the model-facing payload (compressed result +
 *     handle instructions from `formatForModel`) stays under an
 *     8,192-byte bound — the compressed body itself is capped at
 *     4,000 chars by the store's default
 *     DEFAULT_COMPRESSION_MAX_CHARS; (2) the full original is
 *     retrievable, byte-for-byte, through the store's paged `read()`
 *     API; (3) the store's `search()` API finds a tail marker in the
 *     stored original.
 *  c. coding-fix (2)        — reused verbatim from the existing suite
 *     (packages/agent-runtime/benchmarks/tasks/tasks.mjs), scored by
 *     that suite's own sandbox-execution scorers.
 *  d. memory-recall (2)     — a TieredMemoryStore seeded in a temp
 *     directory; scorer = expected atom in the top-k of recallHybrid.
 *  e. workflow-run (1)      — a real headless run of the shipped
 *     `sequentialPipelineTemplate` through WorkflowRunner from
 *     @mvp/workflows dist, with stub governance / agent-runtime
 *     (the template uses only trigger/set/code nodes, so no model
 *     and no tool is ever invoked). Scorer = run status succeeded
 *     AND the final node's output matches the expected transform.
 *  f. provider tasks (3)    — extract-values x2 + follow-instructions
 *     x1, reused verbatim from the existing suite (see c).
 *
 * Families a, b, d, e are harness tasks: they exercise deterministic
 * KriyaDot code directly and behave identically in mock and real
 * mode. Families c and f are provider tasks: in mock mode the repo's
 * MockProvider replays each task's canned known-good answer
 * (`mockScript` in the upstream tasks.mjs); in real mode a real
 * provider answers the prompt itself. Mock scores for c/f validate
 * the harness + scorers + reporting pipeline — they are NOT evidence
 * about any real model's ability. See README.md.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

import { TieredMemoryStore, ToolSpillStore } from '../packages/agent-runtime/dist/index.js';
import { decideUniversalRoute } from '../apps/api/dist/universal.js';
import { TASKS as UPSTREAM_TASKS } from '../packages/agent-runtime/benchmarks/tasks/tasks.mjs';

const require = createRequire(import.meta.url);
// @mvp/workflows dist is CommonJS — load it through require, the same
// way the API server consumes it.
const { WorkflowRunner, sequentialPipelineTemplate } = require('../packages/workflows/dist/index.js');

export const PASS_THRESHOLD = 0.99;

// ---------------------------------------------------------------------------
// (a) Chat routing fixtures
// ---------------------------------------------------------------------------

const CHIEF = {
  id: 'chief',
  name: 'Chief',
  description: 'Chief of Staff coordinating the whole team and delegating work',
  routeKeywords: ['planning', 'coordination'],
};
const ROUTING_BOTS = [
  CHIEF,
  {
    id: 'coder',
    name: 'Coder',
    description: 'Writes and debugs code, programming in typescript',
    routeKeywords: ['code', 'debug', 'typescript', 'bug'],
  },
  {
    id: 'writer',
    name: 'Writer',
    description: 'Writes essays, blogs, articles and marketing copy',
    routeKeywords: ['essay', 'blog', 'article', 'writing'],
  },
  {
    id: 'finance',
    name: 'Finance Analyst',
    description: 'Budgets, invoices, finance, accounting and taxes',
    routeKeywords: ['finance', 'budget', 'invoice', 'tax'],
  },
];

function routingTask(id, message, expectedBotId, expectedPath) {
  return {
    id,
    category: 'chat-routing',
    kind: 'harness',
    description: `Universal router sends "${message}" to ${expectedBotId} (${expectedPath}).`,
    async run() {
      const decision = decideUniversalRoute(message, ROUTING_BOTS, CHIEF);
      const botOk = decision.botId === expectedBotId;
      const pathOk = decision.path === expectedPath;
      return {
        score: botOk && pathOk ? 1 : botOk ? 0.5 : 0,
        detail:
          `routed to ${decision.botId} via ${decision.via} (path=${decision.path}, ` +
          `confidence=${decision.confidence}); expected ${expectedBotId}/${expectedPath}`,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// (b) Tool spill / compression path (current dist API)
// ---------------------------------------------------------------------------

const SPILL_MODEL_PAYLOAD_MAX_BYTES = 8192;

const spillTask = {
  id: 'tool-spill-huge-result',
  category: 'tool-spill',
  kind: 'harness',
  description:
    'A 120,018-byte synthetic tool result goes through ToolSpillStore spill/compression: the model-facing payload (compressed body capped at 4,000 chars by the store default, plus handle instructions) must stay under 8,192 bytes, the full original must be retrievable byte-for-byte via paged read(), and search() must find the tail marker in the stored original.',
  async run() {
    const dir = mkdtempSync(join(tmpdir(), 'kriyadot-bench-spill-'));
    const store = new ToolSpillStore(dir);
    const tailMarker = 'NEEDLE_TAIL_MARKER';
    const original = `${'x'.repeat(120_000)}${tailMarker}`;
    const originalBytes = Buffer.byteLength(original, 'utf8');
    const ref = store.maybeSpill('huge_result_tool', original);
    if (!ref) return { score: 0, detail: `result of ${originalBytes} bytes did not spill` };

    const modelPayload = store.formatForModel('huge_result_tool', ref);
    const payloadBytes = Buffer.byteLength(modelPayload, 'utf8');
    const payloadOk = payloadBytes <= SPILL_MODEL_PAYLOAD_MAX_BYTES;

    // Paged retrieval of the full original.
    let retrieved = '';
    let offset = 0;
    let pages = 0;
    for (;;) {
      const page = store.read(ref.id, offset, 8000);
      if (!page) break;
      retrieved += page.content;
      pages += 1;
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
      if (pages > 100) break; // safety bound; 16 pages expected
    }
    const retrievalOk = retrieved === original && retrieved.includes(tailMarker);

    // Search API over the stored original.
    const searchResult = typeof store.search === 'function' ? store.search(ref.id, tailMarker) : null;
    const searchOk = !!searchResult && searchResult.totalMatches >= 1 && searchResult.matches.some((m) => m.excerpt.includes(tailMarker));

    const score = (payloadOk ? 1 : 0) + (retrievalOk ? 1 : 0) + (searchOk ? 1 : 0);
    return {
      score: score / 3,
      detail:
        `original ${originalBytes} bytes spilled as ${ref.id}; model payload ${payloadBytes} bytes ` +
        `(bound ${SPILL_MODEL_PAYLOAD_MAX_BYTES}, ${payloadOk ? 'ok' : 'OVER'}; store-reported modelBytes=${ref.modelBytes}, ` +
        `compressionRatio=${ref.compressionRatio}); paged read retrieved ${Buffer.byteLength(retrieved, 'utf8')} bytes in ` +
        `${pages} pages, byte-identical=${retrievalOk}; search('${tailMarker}') totalMatches=${searchResult ? searchResult.totalMatches : 'no search API'}, ok=${searchOk}`,
    };
  },
};

// ---------------------------------------------------------------------------
// (d) Memory recall
// ---------------------------------------------------------------------------

function memoryTask(id, query, expectedFactFragment) {
  return {
    id,
    category: 'memory-recall',
    kind: 'harness',
    description: `Seeded TieredMemoryStore: recallHybrid top-5 for "${query}" must contain the atom matching "${expectedFactFragment}".`,
    async run() {
      const dir = mkdtempSync(join(tmpdir(), 'kriyadot-bench-memory-'));
      const store = new TieredMemoryStore(dir);
      const botId = 'bench-bot';
      store.storeAtom(botId, { fact: 'The user deployment window is every Friday at 18:00 UTC', entities: ['deployment'], confidence: 0.9 }, 'seed-1');
      store.storeAtom(botId, { fact: 'The user prefers dark roast coffee in the morning', entities: ['coffee'], confidence: 0.9 }, 'seed-2');
      store.storeAtom(botId, { fact: 'The project codename for the mobile launch is Falcon', entities: ['Falcon'], confidence: 0.9 }, 'seed-3');
      const hits = store.recallHybrid(botId, query, 5);
      const rank = hits.findIndex((h) => h.atom.fact.includes(expectedFactFragment));
      return {
        score: rank === 0 ? 1 : rank > 0 ? 0.5 : 0,
        detail:
          rank >= 0
            ? `expected atom at rank ${rank + 1} of ${hits.length} hits`
            : `expected atom not in top-5; hits were: ${hits.map((h) => h.atom.fact).join(' | ') || '(none)'}`,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// (e) Workflow run (real headless run, not a dry-run)
// ---------------------------------------------------------------------------

const workflowTask = {
  id: 'workflow-sequential-pipeline',
  category: 'workflow-run',
  kind: 'harness',
  description:
    'Real headless run of the shipped sequentialPipelineTemplate (trigger -> set -> code -> set) through WorkflowRunner from @mvp/workflows dist, with stub governance/agent-runtime (the template invokes no model and no tool). Scorer: run succeeds and the summary node output equals the expected transform.',
  async run() {
    const dir = mkdtempSync(join(tmpdir(), 'kriyadot-bench-workflow-'));
    const governanceStub = {
      evaluate: async () => ({ action: 'allow' }),
      requestApproval: () => 'bench-approval',
      awaitDecision: async () => 'approved',
      audit: () => {},
    };
    const agentRuntimeStub = {
      runTurn: async () => {
        throw new Error('agentRuntime.runTurn must not be called by this template');
      },
    };
    const runner = new WorkflowRunner({
      dbPath: join(dir, 'workflows.db'),
      agentRuntime: agentRuntimeStub,
      governance: governanceStub,
      tools: new Map(),
      bots: new Map(),
    });
    try {
      runner.register(sequentialPipelineTemplate);
      const started = await runner.startRun(sequentialPipelineTemplate.id, { title: 'hello', items: ['a', 'b'] });
      const done = await runner.awaitRun(started.id, 15_000);
      const summary = done.nodeStates?.summary?.output;
      const expected = { title: 'hello', count: 2, upper: ['A', 'B'] };
      const outputOk = JSON.stringify(summary) === JSON.stringify(expected);
      return {
        score: done.status === 'succeeded' && outputOk ? 1 : 0,
        detail: `run ${done.id} status=${done.status}; summary output=${JSON.stringify(summary)}; expected ${JSON.stringify(expected)}`,
      };
    } finally {
      runner.close();
    }
  },
};

// ---------------------------------------------------------------------------
// (c) + (f) Provider tasks reused from the existing suite
// ---------------------------------------------------------------------------

const REUSED_IDS = [
  'fix-bug-cart-discount', // (c) coding fix
  'fix-bug-clamp-range', //   (c) coding fix
  'extract-invoice-fields', // (f) extract-values
  'extract-event-dates', //    (f) extract-values
  'follow-json-only', //       (f) follow-instructions
];

const providerTasks = REUSED_IDS.map((id) => {
  const upstream = UPSTREAM_TASKS.find((t) => t.id === id);
  if (!upstream) throw new Error(`upstream task ${id} not found in packages/agent-runtime/benchmarks/tasks/tasks.mjs`);
  return {
    id: upstream.id,
    category: upstream.category,
    kind: 'provider',
    description: upstream.description,
    upstream,
  };
});

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

export const SUITE = [
  routingTask('route-code-to-coder', 'please debug this typescript code, there is a bug in my function', 'coder', 'specialist'),
  routingTask('route-writing-to-writer', 'write an essay and a blog article about gardens', 'writer', 'specialist'),
  routingTask('route-finance-to-finance', 'prepare a finance budget and check this invoice and tax', 'finance', 'specialist'),
  routingTask('route-unmatched-to-anchor', 'what is the weather today', 'chief', 'direct'),
  spillTask,
  ...providerTasks.slice(0, 2), // the two coding-fix tasks
  memoryTask('memory-recall-deployment-window', 'when is the deployment window', 'deployment window is every Friday'),
  memoryTask('memory-recall-project-codename', 'what is the codename for the mobile launch', 'codename for the mobile launch is Falcon'),
  workflowTask,
  ...providerTasks.slice(2),
];
