// SPDX-License-Identifier: Apache-2.0
/**
 * Background specialist runs (Octomind parity).
 *
 * A turn can hand a self-contained task to a specialist bot — an
 * existing roster bot or an EPHEMERAL bot defined inline for this one
 * job — and keep working. The specialist runs in the background on its
 * own session; when it finishes, its result is injected into the
 * originating session at the start of the next turn ("result
 * injection"), so the originating bot continues with the findings in
 * context. Runs are listable and stoppable; stopping aborts the run's
 * turn via its AbortController.
 *
 * The registry is deliberately in-memory: background runs do not
 * survive a server restart (their sessions do — a lost run simply
 * never injects, which the origin bot can see from the run list).
 */

import { randomUUID } from 'node:crypto';

export type BackgroundRunStatus = 'running' | 'done' | 'failed' | 'stopped';

export interface BackgroundRunRecord {
  id: string;
  /** The bot doing the work (roster bot id, or the ephemeral bot's id). */
  botId: string;
  botName: string;
  ephemeral: boolean;
  originBotId: string;
  originSessionId: string;
  task: string;
  status: BackgroundRunStatus;
  result?: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
  /** When the result was injected into the origin session (once only). */
  injectedAt?: number;
}

export class BackgroundRunRegistry {
  private readonly runs = new Map<string, BackgroundRunRecord>();
  private readonly controllers = new Map<string, AbortController>();

  start(input: {
    botId: string;
    botName: string;
    ephemeral: boolean;
    originBotId: string;
    originSessionId: string;
    task: string;
  }): { record: BackgroundRunRecord; signal: AbortSignal } {
    const id = `bgr-${randomUUID().slice(0, 8)}`;
    const controller = new AbortController();
    const record: BackgroundRunRecord = {
      id,
      botId: input.botId,
      botName: input.botName,
      ephemeral: input.ephemeral,
      originBotId: input.originBotId,
      originSessionId: input.originSessionId,
      task: input.task,
      status: 'running',
      startedAt: Date.now(),
    };
    this.runs.set(id, record);
    this.controllers.set(id, controller);
    return { record, signal: controller.signal };
  }

  complete(id: string, result: string): void {
    const record = this.runs.get(id);
    if (!record || record.status !== 'running') return;
    record.status = 'done';
    record.result = result;
    record.finishedAt = Date.now();
    this.controllers.delete(id);
  }

  fail(id: string, error: string): void {
    const record = this.runs.get(id);
    if (!record || record.status !== 'running') return;
    record.status = 'failed';
    record.error = error;
    record.finishedAt = Date.now();
    this.controllers.delete(id);
  }

  /** Stop a running run (aborts its turn). Returns false if not running. */
  stop(id: string): boolean {
    const record = this.runs.get(id);
    if (!record || record.status !== 'running') return false;
    record.status = 'stopped';
    record.finishedAt = Date.now();
    this.controllers.get(id)?.abort();
    this.controllers.delete(id);
    return true;
  }

  get(id: string): BackgroundRunRecord | undefined {
    return this.runs.get(id);
  }

  list(filter: { originSessionId?: string; originBotId?: string; status?: BackgroundRunStatus } = {}): BackgroundRunRecord[] {
    return [...this.runs.values()]
      .filter(
        (r) =>
          (filter.originSessionId === undefined || r.originSessionId === filter.originSessionId) &&
          (filter.originBotId === undefined || r.originBotId === filter.originBotId) &&
          (filter.status === undefined || r.status === filter.status),
      )
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  /**
   * Finished runs for an origin session whose results have not been
   * injected yet. Marks them injected — injection happens exactly once.
   */
  drainInjectable(originSessionId: string): BackgroundRunRecord[] {
    const ready = [...this.runs.values()].filter(
      (r) =>
        r.originSessionId === originSessionId &&
        r.injectedAt === undefined &&
        (r.status === 'done' || r.status === 'failed' || r.status === 'stopped'),
    );
    for (const r of ready) r.injectedAt = Date.now();
    return ready.sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
  }
}

/** Render a finished run as the user-role injection message. */
export function renderRunInjection(record: BackgroundRunRecord): string {
  const head =
    record.status === 'done'
      ? `[Background run ${record.id} — ${record.botName} finished]`
      : record.status === 'failed'
        ? `[Background run ${record.id} — ${record.botName} FAILED: ${record.error ?? 'unknown error'}]`
        : `[Background run ${record.id} — ${record.botName} was stopped]`;
  const taskLine = `Task: ${record.task.slice(0, 300)}`;
  const body = record.status === 'done' ? `\n\nResult:\n${(record.result ?? '').slice(0, 6000)}` : '';
  return `${head}\n${taskLine}${body}`;
}
