// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { LangfuseExporter, resolveLangfuseConfig, spansToLangfuseEvents } from '../src/langfuse-exporter.js';
import type { Span } from '../src/spans.js';

const span = (over: Partial<Span> = {}): Span => ({
  id: 'span_1', runId: 'run_1', sessionId: 'sess_1', parentSpanId: null, kind: 'llm', name: 'groq:llama',
  startedAt: 1_700_000_000_000, endedAt: 1_700_000_001_000, durationMs: 1000, status: 'ok', botId: 'b1',
  costCents: 250, payload: { input: { prompt: 'hi' }, output: { content: 'hello' } }, ...over,
});

describe('spansToLangfuseEvents', () => {
  it('maps one trace per run plus a span observation per span', () => {
    const events = spansToLangfuseEvents([
      span(), span({ id: 'span_2', kind: 'tool', name: 'read_file', parentSpanId: 'span_1' }),
      span({ id: 'span_3', runId: 'run_2', status: 'error', error: 'boom' }),
    ]);
    expect(events.filter((e) => e.type === 'trace-create')).toHaveLength(2);
    const obs = events.filter((e) => e.type === 'span-create');
    expect(obs).toHaveLength(3);
    expect(obs[0].body).toMatchObject({ id: 'span_1', traceId: 'run_1', usage: { totalCost: 2.5 }, input: { prompt: 'hi' } });
    expect(obs[1].body.parentObservationId).toBe('span_1');
    expect(obs[2].body).toMatchObject({ level: 'ERROR', statusMessage: 'boom' });
  });
});

describe('LangfuseExporter', () => {
  it('batches and flushes with Basic auth to the ingestion endpoint', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const ex = new LangfuseExporter({
      config: { host: 'https://lf.example', publicKey: 'pk', secretKey: 'sk' },
      fetchImpl: async (url, init) => { calls.push({ url, init }); return new Response('{}', { status: 207 }); },
      flushIntervalMs: 0,
    });
    ex.enqueue([span(), span({ id: 'span_2' })]);
    expect(ex.pending).toBe(2);
    await expect(ex.flush()).resolves.toEqual({ sent: 2 });
    expect(ex.pending).toBe(0);
    expect(calls[0].url).toBe('https://lf.example/api/public/ingestion');
    expect((calls[0].init?.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from('pk:sk').toString('base64')}`);
    const body = JSON.parse(String(calls[0].init?.body)) as { batch: unknown[] };
    expect(body.batch).toHaveLength(3); // 1 trace + 2 spans
  });

  it('auto-flushes at the batch size and swallows send failures', async () => {
    const errors: Error[] = [];
    let attempts = 0;
    const ex = new LangfuseExporter({
      config: { host: 'https://lf.example', publicKey: 'pk', secretKey: 'sk' },
      fetchImpl: async () => { attempts++; throw new Error('network down'); },
      batchSize: 2, flushIntervalMs: 0, onError: (e) => errors.push(e),
    });
    ex.enqueue(span());
    ex.enqueue(span({ id: 'span_2' })); // reaches batch size → flush attempt
    await ex.flush();
    expect(attempts).toBeGreaterThanOrEqual(1);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    await expect(ex.flush()).resolves.toEqual({ sent: 0 }); // never throws
  });

  it('is a silent no-op when unconfigured', async () => {
    expect(resolveLangfuseConfig({} as NodeJS.ProcessEnv)).toBeNull();
    let called = 0;
    const ex = new LangfuseExporter({
      config: null, flushIntervalMs: 0,
      fetchImpl: async () => { called++; return new Response('{}'); },
    });
    expect(ex.configured).toBe(false);
    ex.enqueue(span());
    expect(ex.pending).toBe(0);
    await expect(ex.flush()).resolves.toEqual({ sent: 0 });
    expect(called).toBe(0);
  });
});
