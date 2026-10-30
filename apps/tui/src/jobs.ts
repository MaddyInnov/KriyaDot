// SPDX-License-Identifier: Apache-2.0
// Terminal job manager (#187): a tiny registry of background jobs (chat
// turns today; any long-running surface work can register) with status
// and cancellation. Pure logic — the Ink panel (components/JobsView.tsx)
// renders list() and calls cancel(id). The cancel callback is supplied
// by whoever started the job (e.g. aborting a turn's AbortController).

export type JobStatus = 'running' | 'done' | 'failed' | 'cancelled';

export interface JobInfo {
  id: string;
  label: string;
  status: JobStatus;
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

interface Job extends JobInfo {
  cancelFn?: () => void;
}

export class JobManager {
  private readonly jobs = new Map<string, Job>();
  private seq = 0;

  /** Register a running job. Returns its id (job-1, job-2, …). */
  start(label: string, cancelFn?: () => void, now: number = Date.now()): string {
    this.seq += 1;
    const id = `job-${this.seq}`;
    this.jobs.set(id, { id, label, status: 'running', startedAt: now, ...(cancelFn ? { cancelFn } : {}) });
    return id;
  }

  /** Mark a job finished. No-op for unknown or already-finished ids. */
  finish(id: string, status: Exclude<JobStatus, 'running'> = 'done', error?: string, now: number = Date.now()): boolean {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'running') return false;
    job.status = status;
    job.finishedAt = now;
    if (error) job.error = error;
    return true;
  }

  /**
   * Cancel a running job: invokes its cancel callback, then marks it
   * cancelled (unless the callback already finished it). False when the
   * job is unknown or not running.
   */
  cancel(id: string, now: number = Date.now()): boolean {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'running') return false;
    try {
      job.cancelFn?.();
    } catch {
      // a throwing cancel callback must not wedge the manager
    }
    if (job.status === 'running') {
      job.status = 'cancelled';
      job.finishedAt = now;
    }
    return true;
  }

  /** All jobs, newest first. Returns copies — callers cannot mutate the registry. */
  list(): JobInfo[] {
    return [...this.jobs.values()]
      .sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id))
      .map(({ cancelFn: _drop, ...info }) => info);
  }

  running(): JobInfo[] {
    return this.list().filter((j) => j.status === 'running');
  }

  /** Drop finished jobs (keeps running ones). Returns how many were pruned. */
  prune(): number {
    let n = 0;
    for (const [id, job] of this.jobs) {
      if (job.status !== 'running') {
        this.jobs.delete(id);
        n += 1;
      }
    }
    return n;
  }
}

/** Human duration for the panel: "3s", "2m 05s". */
export function formatJobDuration(job: JobInfo, now: number = Date.now()): string {
  const end = job.finishedAt ?? now;
  const secs = Math.max(0, Math.round((end - job.startedAt) / 1000));
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s`;
}
