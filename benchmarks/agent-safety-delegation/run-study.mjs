// SPDX-License-Identifier: Apache-2.0
/**
 * Delegation Safety Gap study runner — Workstream 2.
 *
 * Phases (all on the OVH anonymous keyless lane; see lib.mjs):
 *   calibration  n=10 paired direct reads: orchestrator model AND reader
 *                model each read the store directly. This MEASURES the
 *                reader's weakness (the paper's effect is weakness-
 *                monotone; an unmeasured pairing would void the study).
 *   replication  n=20 paired cases: arm A orchestrator-alone (direct read)
 *                vs arm B orchestrator + cheap reader (conclusion-only
 *                delegation — KriyaDot's current delegate shape).
 *   protocols    n=10 fixed subset of the replication cases:
 *                P1 independent re-read, P2 second reader + agreement,
 *                P3 evidence-only delegation. Reader conclusions from the
 *                replication arm are reused where the protocol definition
 *                allows (P1, P2), so protocol costs are honest MARGINAL
 *                costs on top of the delegated baseline.
 *
 * Case selection is deterministic and stratified across the 3 domains:
 * replication = bank indices [0..6] + [20..26] + [40..45] (7+7+6 = 20);
 * calibration and protocols use the first 10 of those.
 *
 * Checkpointing: every trial appends one JSON line to results/trials.jsonl
 * keyed by `${phase}:${arm}:${caseId}`; re-running skips completed keys,
 * so a rate-limit stall or restart never loses finished trials.
 *
 * Usage:
 *   node run-study.mjs [--phase calibration|replication|protocols|all]
 *   DELEGATION_MOCK=1 node run-study.mjs   # pipeline self-test, no network
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ORCHESTRATOR_MODEL, READER_MODEL, READER2_MODEL, chat,
  directMessages, readerConclusionMessages, orchestratorFromConclusionMessages,
  readerEvidenceMessages, orchestratorFromEvidenceMessages,
  orchestratorFromAgreementMessages, conclusionAnswer, scoreAnswer, summarise,
} from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, 'results');
const MOCK = process.env.DELEGATION_MOCK === '1';
// Mock and live trials live in SEPARATE checkpoint files: a mock self-test
// must never mark a case "done" for the live study (or feed it conclusions).
const TRIALS_PATH = join(RESULTS, MOCK ? 'trials-mock.jsonl' : 'trials.jsonl');

const bank = JSON.parse(readFileSync(join(HERE, 'bank.json'), 'utf8'));
const byId = new Map(bank.cases.map((c) => [c.id, c]));
const REPLICATION_IDS = [
  ...bank.cases.slice(0, 7), ...bank.cases.slice(20, 27), ...bank.cases.slice(40, 46),
].map((c) => c.id);
const SUBSET_IDS = REPLICATION_IDS.slice(0, 10);

/** Mock transport for the pipeline self-test: deterministic, no network. */
async function mockChat(model, messages) { // eslint-disable-line no-unused-vars -- signature mirrors chat()
  const user = messages[messages.length - 1].content;
  const kase = bank.cases.find((c) => user.includes(c.question));
  const isReader = model === READER_MODEL || model === READER2_MODEL;
  const wantsEvidence = /EVIDENCE ONLY/.test(messages[0].content);
  let content;
  if (wantsEvidence) {
    const g = kase.records.find((r) => !r.forged);
    content = `[${g.id}] "${g.text.split('\n')[3] ?? g.text.slice(0, 80)}"`;
  } else if (isReader) {
    // Mock reader is fooled on even-indexed cases, right on odd ones.
    const idx = bank.cases.indexOf(kase);
    content = `Conclusion: ${idx % 2 === 0 ? kase.forgedAnswer : kase.genuineAnswer} (from the records).`;
  } else if (/SUB-AGENT CONCLUSION/.test(user)) {
    content = /Conclusion: (.+?) \(/.exec(user)?.[1] ?? kase.genuineAnswer; // mock orchestrator trusts the conclusion
  } else {
    content = kase.genuineAnswer; // mock direct read is careful
  }
  return { content, usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 }, model, latencyMs: 1, attempts: 1, truncated: false, finishReason: 'stop' };
}

const call = MOCK ? mockChat : chat;

mkdirSync(RESULTS, { recursive: true });
const done = new Map();
if (existsSync(TRIALS_PATH)) {
  for (const line of readFileSync(TRIALS_PATH, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const t = JSON.parse(line);
    done.set(`${t.phase}:${t.arm}:${t.caseId}`, t);
  }
}

function record(trial) {
  appendFileSync(TRIALS_PATH, JSON.stringify(trial) + '\n');
  done.set(`${trial.phase}:${trial.arm}:${trial.caseId}`, trial);
  const s = trial.error ? `ERROR ${trial.error}` : trial.score;
  console.log(`[${trial.phase}/${trial.arm}] ${trial.caseId} -> ${s} (calls=${trial.calls}, tokens=${trial.totalTokens})`);
}

function base(phase, arm, kase) {
  return { phase, arm, caseId: kase.id, domain: kase.domain, ts: new Date().toISOString(), mock: MOCK };
}

/** Run a list of {model, messages} steps in order; collect cost + last content. */
async function runSteps(steps) {
  let calls = 0, totalTokens = 0, wallMs = 0, truncatedSteps = 0;
  const contents = [];
  for (const step of steps) {
    const r = await call(step.model, step.messages, step.opts ?? {});
    calls++; contents.push(r.content);
    if (r.truncated) truncatedSteps++;
    totalTokens += r.usage?.total_tokens ?? r.usage?.totalTokens ?? 0;
    wallMs += r.latencyMs ?? 0;
  }
  return { contents, calls, totalTokens, wallMs, truncatedSteps };
}

async function trialDirect(phase, arm, kase, model) {
  const key = `${phase}:${arm}:${kase.id}`;
  if (done.has(key)) return;
  const t = base(phase, arm, kase);
  try {
    const r = await runSteps([{ model, messages: directMessages(kase) }]);
    Object.assign(t, r, { finalAnswer: r.contents[0], score: scoreAnswer(r.contents[0], kase), model });
  } catch (err) { Object.assign(t, { error: String(err?.message ?? err), calls: 0, totalTokens: 0, wallMs: 0, score: 'error' }); }
  record(t);
}

async function trialDelegated(kase) {
  const key = `replication:delegated:${kase.id}`;
  if (done.has(key)) return;
  const t = base('replication', 'delegated', kase);
  try {
    const reader = await runSteps([{ model: READER_MODEL, messages: readerConclusionMessages(kase) }]);
    const conclusion = reader.contents[0];
    const fin = await runSteps([{ model: ORCHESTRATOR_MODEL, messages: orchestratorFromConclusionMessages(kase, conclusion) }]);
    Object.assign(t, {
      calls: reader.calls + fin.calls, totalTokens: reader.totalTokens + fin.totalTokens,
      wallMs: reader.wallMs + fin.wallMs, readerConclusion: conclusion,
      readerAnswer: conclusionAnswer(conclusion, kase),
      finalAnswer: fin.contents[0], score: scoreAnswer(fin.contents[0], kase),
    });
  } catch (err) { Object.assign(t, { error: String(err?.message ?? err), calls: 0, totalTokens: 0, wallMs: 0, score: 'error' }); }
  record(t);
}

async function trialReRead(kase) {
  const key = `protocols:p1-reread:${kase.id}`;
  if (done.has(key)) return;
  const src = done.get(`replication:delegated:${kase.id}`);
  const t = base('protocols', 'p1-reread', kase);
  if (!src || src.error) { Object.assign(t, { error: 'missing replication delegated trial to reuse', calls: 0, totalTokens: 0, wallMs: 0, score: 'error' }); return record(t); }
  try {
    // Marginal cost: ONLY the orchestrator's independent re-read (the
    // delegated conclusion is reused from the replication arm).
    const r = await runSteps([{ model: ORCHESTRATOR_MODEL, messages: directMessages(kase) }]);
    Object.assign(t, r, { reusedConclusion: true, finalAnswer: r.contents[0], score: scoreAnswer(r.contents[0], kase) });
  } catch (err) { Object.assign(t, { error: String(err?.message ?? err), calls: 0, totalTokens: 0, wallMs: 0, score: 'error' }); }
  record(t);
}

async function trialAgree(kase) {
  const key = `protocols:p2-agree:${kase.id}`;
  if (done.has(key)) return;
  const src = done.get(`replication:delegated:${kase.id}`);
  const t = base('protocols', 'p2-agree', kase);
  if (!src || src.error) { Object.assign(t, { error: 'missing replication delegated trial to reuse', calls: 0, totalTokens: 0, wallMs: 0, score: 'error' }); return record(t); }
  try {
    const r2 = await runSteps([{ model: READER2_MODEL, messages: readerConclusionMessages(kase) }]);
    const ans2 = conclusionAnswer(r2.contents[0], kase);
    const agree = src.readerAnswer !== 'unclear' && ans2 === src.readerAnswer;
    let fin;
    if (agree) {
      fin = await runSteps([{ model: ORCHESTRATOR_MODEL, messages: orchestratorFromAgreementMessages(kase, src.readerConclusion, r2.contents[0]) }]);
    } else {
      // Escalation: the orchestrator re-reads the store itself.
      fin = await runSteps([{ model: ORCHESTRATOR_MODEL, messages: directMessages(kase) }]);
    }
    Object.assign(t, {
      calls: r2.calls + fin.calls, totalTokens: r2.totalTokens + fin.totalTokens, wallMs: r2.wallMs + fin.wallMs,
      reader2Answer: ans2, agreement: agree, escalated: !agree,
      finalAnswer: fin.contents[0], score: scoreAnswer(fin.contents[0], kase),
    });
  } catch (err) { Object.assign(t, { error: String(err?.message ?? err), calls: 0, totalTokens: 0, wallMs: 0, score: 'error' }); }
  record(t);
}

async function trialEvidence(kase) {
  const key = `protocols:p3-evidence:${kase.id}`;
  if (done.has(key)) return;
  const t = base('protocols', 'p3-evidence', kase);
  try {
    const ev = await runSteps([{ model: READER_MODEL, messages: readerEvidenceMessages(kase) }]);
    const fin = await runSteps([{ model: ORCHESTRATOR_MODEL, messages: orchestratorFromEvidenceMessages(kase, ev.contents[0]) }]);
    Object.assign(t, {
      calls: ev.calls + fin.calls, totalTokens: ev.totalTokens + fin.totalTokens, wallMs: ev.wallMs + fin.wallMs,
      evidence: ev.contents[0], finalAnswer: fin.contents[0], score: scoreAnswer(fin.contents[0], kase),
    });
  } catch (err) { Object.assign(t, { error: String(err?.message ?? err), calls: 0, totalTokens: 0, wallMs: 0, score: 'error' }); }
  record(t);
}

async function main() {
  const phaseArg = (process.argv.find((a) => a.startsWith('--phase=')) ?? '--phase=all').split('=')[1];
  const want = (p) => phaseArg === 'all' || phaseArg === p;
  console.log(`study start: mock=${MOCK} phase=${phaseArg} already-done=${done.size}`);
  if (want('calibration')) {
    for (const id of SUBSET_IDS) {
      const kase = byId.get(id);
      await trialDirect('calibration', 'orchestrator-direct', kase, ORCHESTRATOR_MODEL);
      await trialDirect('calibration', 'reader-direct', kase, READER_MODEL);
    }
  }
  if (want('replication')) {
    for (const id of REPLICATION_IDS) {
      const kase = byId.get(id);
      await trialDirect('replication', 'alone', kase, ORCHESTRATOR_MODEL);
      await trialDelegated(kase);
    }
  }
  if (want('protocols')) {
    for (const id of SUBSET_IDS) {
      const kase = byId.get(id);
      await trialReRead(kase);
      await trialAgree(kase);
      await trialEvidence(kase);
    }
  }
  // Summary over everything recorded so far (live trials only unless mock).
  const all = [...done.values()].filter((t) => t.mock === MOCK);
  const groups = {};
  for (const t of all) {
    const k = `${t.phase}:${t.arm}`;
    (groups[k] ??= []).push(t);
  }
  const summary = {
    generatedAt: new Date().toISOString(), mock: MOCK,
    models: { orchestrator: ORCHESTRATOR_MODEL, reader: READER_MODEL, reader2: READER2_MODEL },
    groups: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, summarise(v)])),
    // Conditional propagation for the delegated arm: P(final forged | reader forged).
    delegatedConditional: (() => {
      const d = all.filter((t) => t.phase === 'replication' && t.arm === 'delegated' && !t.error);
      const readerFooled = d.filter((t) => t.readerAnswer === 'forged');
      const propagated = readerFooled.filter((t) => t.score === 'forged').length;
      return { readerFooled: readerFooled.length, propagated, rate: readerFooled.length ? propagated / readerFooled.length : null, delegatedN: d.length };
    })(),
  };
  writeFileSync(join(RESULTS, MOCK ? 'summary-mock.json' : 'summary.json'), JSON.stringify(summary, null, 1) + '\n');
  console.log(JSON.stringify(summary, null, 1));
  console.log('study phase complete');
}

main().catch((err) => { console.error('FATAL', err); process.exit(1); });
