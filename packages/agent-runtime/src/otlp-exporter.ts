// SPDX-License-Identifier: Apache-2.0
/**
 * OH-7: OTLP/JSON span exporter — sibling of langfuse-exporter.ts with
 * the same contract: fire-and-forget, interval + on-demand flush, and
 * NEVER throws into the turn path. Configured via
 * OTEL_EXPORTER_OTLP_ENDPOINT (+ optional OTEL_EXPORTER_OTLP_HEADERS
 * as comma-separated key=value pairs). Posts to
 * <endpoint>/v1/traces unless the endpoint already ends in /v1/traces.
 */
import type { Span } from './spans.js';
import type { FetchLike } from './langfuse-exporter.js';

export type { FetchLike };

export interface OtlpConfig {
  endpoint: string;
  headers: Record<string, string>;
}

export function resolveOtlpConfig(env: NodeJS.ProcessEnv = process.env): OtlpConfig | null {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!endpoint) return null;
  const headers: Record<string, string> = {};
  const raw = env.OTEL_EXPORTER_OTLP_HEADERS?.trim();
  if (raw) {
    for (const part of raw.split(',')) {
      const eq = part.indexOf('=');
      if (eq > 0) headers[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
  }
  return { endpoint: endpoint.replace(/\/$/, ''), headers };
}

function traceUrl(endpoint: string): string {
  return endpoint.endsWith('/v1/traces') ? endpoint : `${endpoint}/v1/traces`;
}

const ns = (ms: number): string => String(Math.round(ms * 1_000_000));

/** Map spans to an OTLP/JSON ExportTraceServiceRequest payload (pure). */
export function spansToOtlpPayload(spans: Span[]): Record<string, unknown> {
  const byRun = new Map<string, Span[]>();
  for (const s of spans) {
    const list = byRun.get(s.runId) ?? [];
    list.push(s);
    byRun.set(s.runId, list);
  }
  return {
    resourceSpans: [...byRun.entries()].map(([runId, runSpans]) => ({
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: 'kriyadot-agent-runtime' } },
        ],
      },
      scopeSpans: [{
        scope: { name: 'kriyadot.spans' },
        spans: runSpans.map((s) => ({
          traceId: runId,
          spanId: s.id,
          ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
          name: s.name,
          kind: 1,
          startTimeUnixNano: ns(s.startedAt),
          endTimeUnixNano: ns(s.endedAt ?? s.startedAt),
          status: { code: s.status === 'error' ? 2 : 1, ...(s.error ? { message: s.error } : {}) },
          attributes: [
            { key: 'kriyadot.kind', value: { stringValue: s.kind } },
            { key: 'kriyadot.bot_id', value: { stringValue: s.botId } },
            { key: 'kriyadot.session_id', value: { stringValue: s.sessionId } },
            ...(typeof s.costCents === 'number'
              ? [{ key: 'kriyadot.cost_cents', value: { doubleValue: s.costCents } }]
              : []),
          ],
        })),
      }],
    })),
  };
}

export interface OtlpExporterOptions {
  config?: OtlpConfig | null;
  fetchImpl?: FetchLike;
  batchSize?: number;
  flushIntervalMs?: number;
  onError?: (err: Error) => void;
}

export class OtlpExporter {
  private readonly config: OtlpConfig | null;
  private readonly fetchImpl: FetchLike;
  private readonly batchSize: number;
  private readonly onError?: (err: Error) => void;
  private queue: Span[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<void> | null = null;

  constructor(opts: OtlpExporterOptions = {}) {
    this.config = opts.config !== undefined ? opts.config : resolveOtlpConfig();
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

  enqueue(spans: Span | Span[]): void {
    if (!this.config) return;
    try {
      this.queue.push(...(Array.isArray(spans) ? spans : [spans]));
      if (this.queue.length >= this.batchSize) void this.flush();
    } catch { /* never throw into the turn path */ }
  }

  async flush(): Promise<{ sent: number }> {
    if (!this.config || this.queue.length === 0) return { sent: 0 };
    if (this.flushing) { await this.flushing; return { sent: 0 }; }
    const batch = this.queue.splice(0, this.queue.length);
    const run = (async (): Promise<{ sent: number }> => {
      try {
        const res = await this.fetchImpl(traceUrl(this.config!.endpoint), {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...this.config!.headers },
          body: JSON.stringify(spansToOtlpPayload(batch)),
        });
        if (!res.ok) throw new Error(`OTLP export HTTP ${res.status}`);
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
