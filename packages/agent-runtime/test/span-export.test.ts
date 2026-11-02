// SPDX-License-Identifier: Apache-2.0
// OH-7: SpanStore.onSpanEnd + attachSpanExporters (Langfuse + OTLP) with fake fetch.
import { afterEach, describe, expect, it } from 'vitest';
import { SpanStore, type Span } from '../src/spans.js';
import { attachSpanExporters } from '../src/span-export.js';
import { resolveOtlpConfig, spansToOtlpPayload } from '../src/otlp-exporter.js';

const stores: SpanStore[] = [];
function makeStore(): SpanStore {
  const s = new SpanStore(':memory:');
  stores.push(s);
  return s;
}
afterEach(() => { for (const s of stores.splice(0)) s.close(); });

function completeSpan(store: SpanStore): Span {
  const run = store.createRun({ sessionId: 'sess-1', botId: 'bot-1' });
  const span = store.startSpan({ runId: run.runId, sessionId: 'sess-1', kind: 'tool', name: 'read_file', botId: 'bot-1' });
  return store.endSpan(span.id, { status: 'ok' })!;
}

describe('SpanStore.onSpanEnd', () => {
  it('notifies on completion, supports unsubscribe, and swallows listener errors', () => {
    const store = makeStore();
    const seen: Span[] = [];
    const off = store.onSpanEnd((s) => seen.push(s));
    store.onSpanEnd(() => { throw new Error('listener boom'); });
    const ended = completeSpan(store);
    expect(seen.map((s) => s.id)).toEqual([ended.id]);
    expect(seen[0]!.status).toBe('ok');
    off();
    completeSpan(store);
    expect(seen).toHaveLength(1);
  });
});

describe('attachSpanExporters', () => {
  it('is a no-op handle when neither exporter is configured', async () => {
    const store = makeStore();
    let calls = 0;
    const handle = attachSpanExporters(store, {} as NodeJS.ProcessEnv, {
      fetchImpl: async () => { calls++; return new Response('{}'); },
    });
    expect(handle.exporters).toEqual([]);
    completeSpan(store);
    await handle.flush();
    handle.close();
    expect(calls).toBe(0);
  });

  it('sends completed spans to BOTH Langfuse and OTLP via fake fetch', async () => {
    const store = makeStore();
    const calls: Array<{ url: string; body: string }> = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push({ url, body: String(init?.body ?? '') });
      return new Response('{}', { status: 200 });
    };
    const handle = attachSpanExporters(store, {
      LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk', LANGFUSE_HOST: 'https://lf.example',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example', OTEL_EXPORTER_OTLP_HEADERS: 'x-api-key=abc',
    } as NodeJS.ProcessEnv, { fetchImpl: fetchImpl as never, flushIntervalMs: 0 });
    expect(handle.exporters).toEqual(['langfuse', 'otlp']);
    completeSpan(store);
    await handle.flush();
    handle.close();
    const lf = calls.find((c) => c.url === 'https://lf.example/api/public/ingestion');
    const ot = calls.find((c) => c.url === 'https://otel.example/v1/traces');
    expect(lf).toBeTruthy();
    expect(JSON.parse(lf!.body).batch.length).toBeGreaterThanOrEqual(2); // trace + span
    expect(ot).toBeTruthy();
    const otlp = JSON.parse(ot!.body) as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ name: string }> }> }> };
    expect(otlp.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.name).toBe('read_file');
  });

  it('exporter errors never propagate to the span path or flush()', async () => {
    const store = makeStore();
    const handle = attachSpanExporters(store, {
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example',
    } as NodeJS.ProcessEnv, {
      fetchImpl: (async () => { throw new Error('network down'); }) as never,
      flushIntervalMs: 0,
    });
    expect(() => completeSpan(store)).not.toThrow();
    await expect(handle.flush()).resolves.toBeUndefined();
    handle.close();
  });

  it('resolveOtlpConfig parses endpoint + headers and returns null when unset', () => {
    expect(resolveOtlpConfig({} as NodeJS.ProcessEnv)).toBeNull();
    expect(resolveOtlpConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://o.example/', OTEL_EXPORTER_OTLP_HEADERS: 'a=1, b=2' } as NodeJS.ProcessEnv))
      .toEqual({ endpoint: 'https://o.example', headers: { a: '1', b: '2' } });
    const payload = spansToOtlpPayload([{
      id: 's1', runId: 'r1', sessionId: 'sess', parentSpanId: null, kind: 'llm', name: 'llm:m',
      startedAt: 1000, endedAt: 2000, durationMs: 1000, status: 'ok', botId: 'b1',
    }]);
    expect(JSON.stringify(payload)).toContain('llm:m');
  });
});
