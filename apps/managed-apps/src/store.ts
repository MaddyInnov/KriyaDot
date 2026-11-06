// SPDX-License-Identifier: Apache-2.0
// Managed Apps persistence, in MANAGED_APPS_DATA_DIR:
//
//   usage.jsonl  — append-only metering, ONE line per execution attempt:
//                  { ts, accountId, toolkit, action, ok, kind }.
//                  Count-only by design: tool arguments and results are
//                  NEVER written here (or anywhere in this service).
//   store.json   — small JSON file (atomic tmp+rename, mode 0600) holding
//                  service-side account labels and pending connect-link
//                  labels, keyed by the server-derived entity id. It holds
//                  NO provider tokens — Composio keeps those.
//
// Month bucketing is by the UTC month of each record's ts.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type ExecutionKind = 'chat' | 'routine' | 'watch';

export interface MeterRecord {
  /** ISO timestamp of the execution attempt. */
  ts: string;
  /** KriyaDot account id (the customer), from the verified token. */
  accountId: string;
  /** Toolkit slug the action ran against. */
  toolkit: string;
  /** Tool/action slug that was executed. */
  action: string;
  /** True when Composio reported success. */
  ok: boolean;
  kind: ExecutionKind;
}

export interface PendingLabel {
  entityId: string;
  toolkitSlug: string;
  label?: string;
  requestedAt: number;
  /** Connected-account ids already known when the link was created. */
  seenIds: string[];
}

interface StoreFile {
  /** labels[entityId][connectedAccountId] = label */
  labels: Record<string, Record<string, string>>;
  pending: PendingLabel[];
}

const EXECUTION_KINDS: readonly string[] = ['chat', 'routine', 'watch'];

/** Normalize an untrusted kind value: anything unknown becomes 'chat'. */
export function normalizeKind(value: unknown): ExecutionKind {
  return typeof value === 'string' && EXECUTION_KINDS.includes(value) ? (value as ExecutionKind) : 'chat';
}

/** 'YYYY-MM' UTC month key for an ISO timestamp (or a Date). */
export function monthKeyOf(ts: string | Date): string {
  const iso = typeof ts === 'string' ? ts : ts.toISOString();
  return iso.slice(0, 7);
}

function emptyStore(): StoreFile {
  return { labels: {}, pending: [] };
}

export class ManagedStore {
  private readonly dataDir: string;
  private readonly storeFile: string;
  private readonly meterFile: string;
  private state: StoreFile;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    mkdirSync(dataDir, { recursive: true });
    this.storeFile = join(dataDir, 'store.json');
    this.meterFile = join(dataDir, 'usage.jsonl');
    if (existsSync(this.storeFile)) {
      try {
        const parsed = JSON.parse(readFileSync(this.storeFile, 'utf8')) as Partial<StoreFile>;
        this.state = {
          labels: parsed.labels && typeof parsed.labels === 'object' ? parsed.labels : {},
          pending: Array.isArray(parsed.pending) ? parsed.pending : [],
        };
      } catch {
        this.state = emptyStore();
      }
    } else {
      this.state = emptyStore();
    }
  }

  /** Path of the append-only metering file (tests assert on its contents). */
  get usageFilePath(): string {
    return this.meterFile;
  }

  /** Path of the labels/pending JSON store. */
  get storeFilePath(): string {
    return this.storeFile;
  }

  get dataDirectory(): string {
    return this.dataDir;
  }

  private save(): void {
    const tmp = `${this.storeFile}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(tmp, this.storeFile);
  }

  // ---- labels --------------------------------------------------------------

  getLabel(entityId: string, accountId: string): string | undefined {
    return this.state.labels[entityId]?.[accountId];
  }

  setLabel(entityId: string, accountId: string, label: string): void {
    const perEntity = (this.state.labels[entityId] ??= {});
    perEntity[accountId] = label;
    this.save();
  }

  deleteLabel(entityId: string, accountId: string): void {
    const perEntity = this.state.labels[entityId];
    if (perEntity && accountId in perEntity) {
      delete perEntity[accountId];
      this.save();
    }
  }

  // ---- pending connect-link labels ------------------------------------------

  addPending(pending: PendingLabel): void {
    this.state.pending.push(pending);
    this.save();
  }

  listPending(entityId: string): PendingLabel[] {
    return this.state.pending.filter((p) => p.entityId === entityId);
  }

  removePending(entityId: string, toolkitSlug: string, requestedAt: number): void {
    const before = this.state.pending.length;
    this.state.pending = this.state.pending.filter(
      (p) => !(p.entityId === entityId && p.toolkitSlug === toolkitSlug && p.requestedAt === requestedAt),
    );
    if (this.state.pending.length !== before) this.save();
  }

  // ---- metering (append-only JSONL, count-only) ------------------------------

  appendMeter(record: MeterRecord): void {
    appendFileSync(this.meterFile, JSON.stringify(record) + '\n', { mode: 0o600 });
  }

  /** All metering records (corrupt lines are skipped, never fatal). */
  readMeter(): MeterRecord[] {
    let raw: string;
    try {
      raw = readFileSync(this.meterFile, 'utf8');
    } catch {
      return [];
    }
    const out: MeterRecord[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as MeterRecord;
        if (parsed && typeof parsed.accountId === 'string' && typeof parsed.ts === 'string') out.push(parsed);
      } catch {
        // Skip a torn final line rather than failing usage reads.
      }
    }
    return out;
  }

  /** Execution count for one customer in one UTC month ('YYYY-MM'). */
  countFor(accountId: string, month: string): number {
    return this.readMeter().filter((r) => r.accountId === accountId && monthKeyOf(r.ts) === month).length;
  }

  /** Execution count across ALL customers in one UTC month. */
  totalFor(month: string): number {
    return this.readMeter().filter((r) => monthKeyOf(r.ts) === month).length;
  }
}
