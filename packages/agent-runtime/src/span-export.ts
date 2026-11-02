// SPDX-License-Identifier: Apache-2.0
/**
 * OH-7: attachSpanExporters — one-call wiring from a SpanStore to every
 * configured exporter (Langfuse + OTLP). Subscribes to span completion
 * via SpanStore.onSpanEnd and enqueues each finished span. When NEITHER
 * exporter is configured, returns a no-op handle (no subscription).
 * Exporter errors never propagate (exporters themselves never throw;
 * the subscription additionally guards).
 */
import type { SpanStore } from './spans.js';
import { LangfuseExporter, resolveLangfuseConfig, type FetchLike } from './langfuse-exporter.js';
import { OtlpExporter, resolveOtlpConfig } from './otlp-exporter.js';

export interface SpanExportHandle {
  /** Which exporters are live: any of 'langfuse' | 'otlp'. Empty = no-op. */
  readonly exporters: readonly string[];
  flush(): Promise<void>;
  close(): void;
}

export interface AttachSpanExportersOptions {
  fetchImpl?: FetchLike;
  flushIntervalMs?: number;
  batchSize?: number;
  onError?: (err: Error) => void;
}

export function attachSpanExporters(
  store: SpanStore,
  env: NodeJS.ProcessEnv = process.env,
  opts: AttachSpanExportersOptions = {},
): SpanExportHandle {
  const langfuseConfig = resolveLangfuseConfig(env);
  const otlpConfig = resolveOtlpConfig(env);
  if (!langfuseConfig && !otlpConfig) {
    return { exporters: [], flush: async () => {}, close: () => {} };
  }
  const exporters: Array<LangfuseExporter | OtlpExporter> = [];
  const names: string[] = [];
  if (langfuseConfig) {
    exporters.push(new LangfuseExporter({ config: langfuseConfig, fetchImpl: opts.fetchImpl, flushIntervalMs: opts.flushIntervalMs, batchSize: opts.batchSize, onError: opts.onError }));
    names.push('langfuse');
  }
  if (otlpConfig) {
    exporters.push(new OtlpExporter({ config: otlpConfig, fetchImpl: opts.fetchImpl, flushIntervalMs: opts.flushIntervalMs, batchSize: opts.batchSize, onError: opts.onError }));
    names.push('otlp');
  }
  const unsubscribe = store.onSpanEnd((span) => {
    for (const ex of exporters) {
      try { ex.enqueue(span); } catch { /* exporters never throw; belt + braces */ }
    }
  });
  return {
    exporters: names,
    async flush() {
      for (const ex of exporters) { try { await ex.flush(); } catch { /* never propagate */ } }
    },
    close() {
      try { unsubscribe(); } catch { /* ignore */ }
      for (const ex of exporters) { try { ex.close(); } catch { /* ignore */ } }
    },
  };
}
