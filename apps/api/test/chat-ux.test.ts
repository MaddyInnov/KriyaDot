// SPDX-License-Identifier: Apache-2.0
// W8 tests: sign-in requests settled by "done" (d), reactions-as-answers
// (b), single-bot /goal scoping (f), and the streaming-TTS pipeline (h).
// Zero paid API usage: TTS is the mock provider.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { describe, expect, it } from 'vitest';
import { MockTTSProvider } from '@mvp/voice';
import {
  ReactionAnswerService,
  SignInRequestStore,
  isDoneMessage,
  mapReactionVerdict,
  settleSignInOnDone,
} from '../src/chat-ux.js';
import { MessageReactionStore } from '../src/message-reactions.js';
import { createMessageReactionsRouter } from '../src/message-reactions-routes.js';
import { GroupGoalStore, singleBotGoalInput } from '../src/group-goals.js';
import { StreamingTtsPipeline, type AudioChunkEvent } from '../src/chat-streaming-tts.js';

async function request(
  app: express.Express,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const http = await import('node:http');
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  } finally {
    server.close();
  }
}

// ---------------------------------------------------------------------------
// (d) done-settled sign-in
// ---------------------------------------------------------------------------

describe('sign-in requests (W8d)', () => {
  it('isDoneMessage matches exactly "done" (trimmed, case-insensitive)', () => {
    expect(isDoneMessage('done')).toBe(true);
    expect(isDoneMessage('  Done  ')).toBe(true);
    expect(isDoneMessage('DONE')).toBe(true);
    expect(isDoneMessage('done!')).toBe(false);
    expect(isDoneMessage('I am done')).toBe(false);
    expect(isDoneMessage('')).toBe(false);
    expect(isDoneMessage(42)).toBe(false);
  });

  it('store: pending lookup is scoped by bot + session', () => {
    const store = new SignInRequestStore();
    const r = store.create({ botId: 'b1', sessionId: 's1', cliId: 'claude', url: 'https://example.com/auth' });
    expect(store.pendingFor('b1', 's1')?.id).toBe(r.id);
    expect(store.pendingFor('b1', 's2')).toBeUndefined();
    expect(store.pendingFor('b2', 's1')).toBeUndefined();
    expect(store.listPending({ botId: 'b1' })).toHaveLength(1);
  });

  it('"done" completes the request when the status re-check says signed in', async () => {
    const store = new SignInRequestStore();
    const r = store.create({ botId: 'b1', sessionId: 's1', cliId: 'codex' });
    const outcome = await settleSignInOnDone({
      store,
      request: r,
      checkStatus: async () => ({ signedIn: true }),
    });
    expect(outcome.settled).toBe(true);
    expect(store.get(r.id)?.status).toBe('completed');
    expect(store.pendingFor('b1', 's1')).toBeUndefined();
  });

  it('"done" leaves the request pending when sign-in did not take', async () => {
    const store = new SignInRequestStore();
    const r = store.create({ botId: 'b1', sessionId: 's1', cliId: 'claude' });
    const outcome = await settleSignInOnDone({
      store,
      request: r,
      checkStatus: async () => ({ signedIn: false }),
    });
    expect(outcome.settled).toBe(false);
    expect(outcome.signedIn).toBe(false);
    expect(store.get(r.id)?.status).toBe('pending');
    expect(store.pendingFor('b1', 's1')?.id).toBe(r.id);
  });
});

// ---------------------------------------------------------------------------
// (b) reactions-as-answers
// ---------------------------------------------------------------------------

describe('reactions-as-answers (W8b)', () => {
  it('maps 👍/👎 only', () => {
    expect(mapReactionVerdict('👍')).toBe('approved');
    expect(mapReactionVerdict('👎')).toBe('denied');
    expect(mapReactionVerdict('❤️')).toBeNull();
    expect(mapReactionVerdict('')).toBeNull();
  });

  function makeService() {
    const approvals = new Map<string, string>([['appr-1', 'pending']]);
    const widgets = new Map<string, { status: string; kind: string; interactive: boolean }>([
      ['w-confirm', { status: 'pending', kind: 'confirm', interactive: true }],
      ['w-done', { status: 'answered', kind: 'confirm', interactive: true }],
      ['w-display', { status: 'pending', kind: 'table', interactive: false }],
    ]);
    const decided: Array<{ id: string; decision: string }> = [];
    const settled: Array<{ id: string; value: unknown }> = [];
    const audits: Array<Record<string, unknown>> = [];
    const svc = new ReactionAnswerService({
      getApprovalStatus: (id) => approvals.get(id),
      decideApproval: (id, decision) => {
        decided.push({ id, decision });
        approvals.set(id, decision);
      },
      getWidget: (id) => widgets.get(id),
      settleWidget: (id, value) => {
        settled.push({ id, value });
        const w = widgets.get(id);
        if (w) w.status = 'answered';
      },
      audit: (_a, fields) => audits.push(fields),
    });
    return { svc, decided, settled, audits };
  }

  it('👍 on a pending approval approves it via the decision path (reaction-sourced)', async () => {
    const { svc, decided, audits } = makeService();
    const res = await svc.resolve({ sessionId: 's1', messageId: 'm1', emoji: '👍', approvalId: 'appr-1' });
    expect(res).toEqual({ kind: 'approval', id: 'appr-1', verdict: 'approved', source: 'reaction' });
    expect(decided).toEqual([{ id: 'appr-1', decision: 'approved' }]);
    expect(JSON.stringify(audits)).toContain('reaction');
  });

  it('👎 on a pending confirm widget settles it with confirmed:false', async () => {
    const { svc, settled } = makeService();
    const res = await svc.resolve({ sessionId: 's1', messageId: 'm2', emoji: '👎', widgetId: 'w-confirm' });
    expect(res?.verdict).toBe('denied');
    expect(settled).toEqual([{ id: 'w-confirm', value: { confirmed: false } }]);
  });

  it('resolves nothing for ordinary messages, non-verdict emoji, settled or display targets', async () => {
    const { svc, decided, settled } = makeService();
    expect(await svc.resolve({ sessionId: 's1', messageId: 'm', emoji: '👍' })).toBeNull();
    expect(await svc.resolve({ sessionId: 's1', messageId: 'm', emoji: '❤️', approvalId: 'appr-1' })).toBeNull();
    expect(await svc.resolve({ sessionId: 's1', messageId: 'm', emoji: '👍', widgetId: 'w-done' })).toBeNull();
    expect(await svc.resolve({ sessionId: 's1', messageId: 'm', emoji: '👍', widgetId: 'w-display' })).toBeNull();
    expect(await svc.resolve({ sessionId: 's1', messageId: 'm', emoji: '👍', approvalId: 'missing' })).toBeNull();
    expect(decided).toEqual([]);
    expect(settled).toEqual([]);
  });

  it('router: POST reaction with a target resolves it; without a target stores only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'w8-react-router-'));
    const store = new MessageReactionStore(dir);
    const { svc, decided } = makeService();
    const app = express();
    app.use(express.json());
    app.use('/api/chat/:sessionId/messages', createMessageReactionsRouter({ store, reactionAnswers: svc }));

    const plain = await request(app, 'POST', '/api/chat/s1/messages/m-plain/reactions', { emoji: '👍' });
    expect(plain.status).toBe(200);
    expect(plain.json.added).toBe(true);
    expect(plain.json.resolved).toBeUndefined();
    expect(decided).toEqual([]);

    const targeted = await request(app, 'POST', '/api/chat/s1/messages/m-card/reactions', {
      emoji: '👎',
      approvalId: 'appr-1',
    });
    expect(targeted.status).toBe(200);
    expect(targeted.json.resolved).toMatchObject({ kind: 'approval', verdict: 'denied', source: 'reaction' });
    expect(decided).toEqual([{ id: 'appr-1', decision: 'denied' }]);
    store.close();
  });
});

// ---------------------------------------------------------------------------
// (f) single-bot /goal scoping
// ---------------------------------------------------------------------------

describe('single-bot goal input (W8f)', () => {
  it('coordinator is the bot itself when no chief is set; no workers', () => {
    const input = singleBotGoalInput({
      bots: [{ id: 'solo' }, { id: 'other' }],
      botId: 'solo',
      title: 'Research X',
      sessionId: 'sess-1',
    });
    expect(input.coordinatorBotId).toBe('solo');
    expect(input.workerBotIds).toEqual([]);
    expect(input.sessionId).toBe('sess-1');
  });

  it('coordinator is the chief when set; the chatted bot is the sole worker', () => {
    const input = singleBotGoalInput({
      bots: [{ id: 'chief', chiefOfStaff: true }, { id: 'worker' }],
      botId: 'worker',
      title: 'Do the thing',
    });
    expect(input.coordinatorBotId).toBe('chief');
    expect(input.workerBotIds).toEqual(['worker']);
  });

  it('persists the session link on the goal record', () => {
    const dir = mkdtempSync(join(tmpdir(), 'w8-goal-store-'));
    const store = new GroupGoalStore(dir);
    const goal = store.createGoal(
      singleBotGoalInput({ bots: [{ id: 'solo' }], botId: 'solo', title: 'Goal title', sessionId: 'sess-9' }),
    );
    expect(goal.sessionId).toBe('sess-9');
    expect(store.listGoals(50, { sessionId: 'sess-9' })).toHaveLength(1);
    expect(store.listGoals(50, { sessionId: 'other' })).toHaveLength(0);
    store.close();
  });
});

// ---------------------------------------------------------------------------
// (h) streaming TTS pipeline
// ---------------------------------------------------------------------------

describe('StreamingTtsPipeline (W8h)', () => {
  it('emits sentence 1 before the rest of the reply has arrived, in order', async () => {
    const events: AudioChunkEvent[] = [];
    const synthesized: string[] = [];
    const pipeline = new StreamingTtsPipeline({
      tts: new MockTTSProvider(),
      emit: (e) => {
        events.push(e);
      },
      onError: () => {},
    });
    // Wrap synthesize to record order via a subclass-free probe: use the
    // mock's determinism — instead track through emitted chunk text.
    pipeline.push('First sentence is here. Second one is still coming');
    // Let the first sentence's synthesis complete while sentence 2 is
    // still only a partial buffer (no terminator yet).
    await new Promise((r) => setTimeout(r, 25));
    expect(events.map((e) => e.text)).toEqual(['First sentence is here.']);
    expect(events[0]!.seq).toBe(0);
    expect(events[0]!.mimeType).toBe('audio/wav');
    expect(Buffer.from(events[0]!.audioBase64, 'base64').length).toBeGreaterThan(44);

    pipeline.push(' along now. And a third follows!');
    await pipeline.finish();
    expect(events.map((e) => e.text)).toEqual([
      'First sentence is here.',
      'Second one is still coming along now.',
      'And a third follows!',
    ]);
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2]);
    void synthesized;
  });

  it('flushes a trailing partial sentence on finish', async () => {
    const events: AudioChunkEvent[] = [];
    const pipeline = new StreamingTtsPipeline({
      tts: new MockTTSProvider(),
      emit: (e) => events.push(e),
    });
    pipeline.push('No terminator on this reply');
    await pipeline.finish();
    expect(events).toHaveLength(1);
    expect(events[0]!.text).toBe('No terminator on this reply');
  });

  it('a failing sentence is skipped and later sentences still emit in order', async () => {
    const events: AudioChunkEvent[] = [];
    const errors: string[] = [];
    let calls = 0;
    const flaky = {
      name: 'mock',
      synthesize: async (text: string) => {
        calls += 1;
        if (calls === 1) throw new Error('tts unavailable');
        return new MockTTSProvider().synthesize(text);
      },
    };
    const pipeline = new StreamingTtsPipeline({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tts: flaky as any,
      emit: (e) => events.push(e),
      onError: (_err, sentence) => errors.push(sentence),
    });
    pipeline.push('This one fails badly. This one works fine.');
    await pipeline.finish();
    expect(errors).toEqual(['This one fails badly.']);
    expect(events.map((e) => e.text)).toEqual(['This one works fine.']);
    expect(events[0]!.seq).toBe(1); // order preserved: seq 0 was the failed sentence
  });
});
