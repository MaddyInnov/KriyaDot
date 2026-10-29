// SPDX-License-Identifier: Apache-2.0
// Langfuse export (Octop #183): batch span-store spans (spans.ts shape)
// into Langfuse ingestion events and POST them to
// <LANGFUSE_HOST>/api/public/ingestion with Basic auth
// (LANGFUSE_PUBLIC_KEY : LANGFUSE_SECRET_KEY).
//
// Mapping: each run's root/turn span becomes a `trace-create`; every span
// becomes a `span-create` observation under its run's trace, with the
// parent span linked when present. Span payloads are already redacted +
// size-capped by the span store, and are forwarded as observation
// input/output only when they are small objects.
//
// Failure contract: the exporter NEVER throws into the turn path. Sends
// are fire-and-forget with swallowed errors, flushing is interval-based
// plus on-demand, and when unconfigured every method is a silent no-op.

import type { Span } from './spans.js';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface LangfuseConfig {
  host: string;
  publicKey: string;
  secretKey: string;
}

export function resolveLangfuseConfig(env: NodeJS.ProcessEnv = process.env): LangfuseConfig | null {
  const publicKey = env.LANGFUSE_PUBLIC_KEY?.trim();
  const secretKey = env.LANGFUSE_SECRET_KEY?.trim();
  if (!publicKey || !secretKey) return null;
  return { host: (env.LANGFUSE_HOST?.trim() || 'https://cloud.langfuse.com').replace(/\/$/, ''), publicKey, secretKey };
}

export interface LangfuseEvent {
  id: string;
  type: 'trace-create' | 'span-create';
  timestamp: string;
  body: Record<string, unknown>;
}

const iso = (ms: number): string => new Date(ms).toISOString();

function traceIdFor(span: Span): string {
  return span.runId;
}

function observationBody(span: Span): Record<string, unknown> {
  const body: Record<string, unknown> = {
    id: span.id,
    traceId: traceIdFor(span),
    name: span.name,
    startTime: iso(span.startedAt),
    level: span.status === 'error' ? 'ERROR' : 'DEFAULT',
    metadata: { kind: span.kind, botId: span.botId, sessionId: span.sessionId, status: span.status },
  };
  if (span.parentSpanId) body.parentObservationId = span.parentSpanId;
  if (span.endedAt !== null) body.endTime = iso(span.endedAt);
  if (typeof span.costCents === 'number') body.usage = { totalCost: span.costCents / 100 };
  if (span.error) body.statusMessage = span.error;
  if (span.payload !== null && typeof span.payload === 'object') {
    const p = span.payload as { input?: unknown; output?: unknown };
    if (p.input !== undefined) body.input = p.input;
    if (p.output !== undefined) body.output = p.output;
  }
  return body;
}

/** Map a batch of spans to Langfuse ingestion events (pure). */
export function spansToLangfuseEvents(spans: Span[]): LangfuseEvent[] {
  const events: LangfuseEvent[] = [];
  const tracedRuns = new Set<string>();
  const sorted = [...spans].sort((a, b) => a.startedAt - b.startedAt);
  for (const span of sorted) {
    if (!tracedRuns.has(span.runId)) {
      tracedRuns.add(span.runId);
      events.push({
        id: `trace-${span.runId}`,
        type: 'trace-create',
        timestamp: iso(span.startedAt),
        body: {
          id: span.runId,
          name: span.name,
          timestamp: iso(span.startedAt),
          sessionId: span.sessionId,
          metadata: { botId: span.botId, kind: span.kind },
        },
      });
    }
    events.push({
      id: `span-${span.id}`,
      type: 'span-create',
      timestamp: iso(span.startedAt),
      body: observationBody(span),
    });
  }
  return events;
}

export interface LangfuseExporterOptions {
  config?: LangfuseConfig | null;
  fetchImpl?: FetchLike;
  /** Flush when the queue reaches this many spans (default 100). */
  batchSize?: number;
  /** Interval flush in ms (default 10s; 0 disables the timer). */
  flushIntervalMs?: number;
  onError?: (err: Error) => void;
}

export class LangfuseExporter {
  private readonly config: LangfuseConfig | null;
  private readonly fetchImpl: FetchLike;
  private readonly batchSize: number;
  private readonly onError?: (err: Error) => void;
  private queue: Span[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<void> | null = null;

  constructor(opts: LangfuseExporterOptions = {}) {
    this.config = opts.config !== undefined ? opts.config : resolveLangfuseConfig();
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.batchSize = Math.max(1, opts.batchSize ?? 100);
    this.onError = opts.onError;
    const interval = opts.flushIntervalMs ?? 10_000;
    if (this.config && interval > 0) {
      this.timer = setInterval(() => { void this.flush(); }, interval);
      (this.timer as unknown as { unref?: () => void }).unref?.();
    }
  }

  get configured(): boolean { return this.config !== null; }
  get pending(): number { return this.queue.length; }

  /** Queue spans for export. No-op when unconfigured. Never throws. */
  enqueue(spans: Span | Span[]): void {
    if (!this.config) return;
    try {
      this.queue.push(...(Array.isArray(spans) ? spans : [spans]));
      if (this.queue.length >= this.batchSize) void this.flush();
    } catch { /* never throw into the turn path */ }
  }

  /** Send everything queued. Resolves quietly on failure. Never throws. */
  async flush(): Promise<{ sent: number }> {
    if (!this.config || this.queue.length === 0) return { sent: 0 };
    if (this.flushing) { await this.flushing; return { sent: 0 }; }
    const batch = this.queue.splice(0, this.queue.length);
    const run = (async (): Promise<{ sent: number }> => {
      try {
        const events = spansToLangfuseEvents(batch);
        const auth = Buffer.from(`${this.config!.publicKey}:${this.config!.secretKey}`).toString('base64');
        const res = await this.fetchImpl(`${this.config!.host}/api/public/ingestion`, {
          method: 'POST',
          headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
          body: JSON.stringify({ batch: events }),
        });
        if (!res.ok) throw new Error(`Langfuse ingestion HTTP ${res.status}`);
        return { sent: batch.length };
      } catch (err) {
        try { this.onError?.(err instanceof Error ? err : new Error(String(err))); } catch { /* ignore */ }
        return { sent: 0 };
      } finally {
        this.flushing = null;
      }
    })();
    this.flushing = run.then(() => undefined);
    return run;
  }

  close(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}
