// SPDX-License-Identifier: Apache-2.0
// Health data sync + scoped erasure (Muse parity audit §4.14: DV-4).
//
// The Android companion / phone-agent reads Health Connect on the
// user's phone and pushes samples here; the iOS companion posts the
// same shapes from HealthKit (DV-2). This module is the API-side sync
// surface:
//
//   * ingest: batched, validated samples, idempotent per
//     (deviceId, externalId) so companion retries never duplicate.
//   * query / summary: read back per device + type, time-windowed.
//   * ERASE: scoped deletion ONLY. An erase must name at least one
//     scope dimension (deviceId, one or more sample types, or a
//     before-timestamp) — or pass confirmAll:true explicitly. An
//     unscoped erase is refused, so "delete my health data" can never
//     silently become "delete everyone's everything" through a missing
//     field. Per-type erasure (e.g. only sleep) leaves other types
//     untouched, and tests prove it.
//
// Storage: SQLite (health-sync.db in the API data dir), mirroring
// PhoneStore. Values are numbers for scalar types; blood_pressure uses
// a { systolic, diastolic } object. No health data leaves this store
// except through the authenticated routes in health-sync-routes.ts.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '@mvp/agent-runtime';

/** Sample types accepted from Health Connect / HealthKit bridges. */
export const HEALTH_SAMPLE_TYPES = [
  'steps',
  'distance',
  'heart_rate',
  'resting_heart_rate',
  'sleep',
  'weight',
  'height',
  'blood_oxygen',
  'blood_pressure',
  'blood_glucose',
  'active_calories',
  'exercise',
  'respiratory_rate',
  'body_temperature',
] as const;

export type HealthSampleType = (typeof HEALTH_SAMPLE_TYPES)[number];

const TYPE_SET: ReadonlySet<string> = new Set(HEALTH_SAMPLE_TYPES);

export type HealthValue = number | { systolic: number; diastolic: number };

export interface HealthSample {
  /** Stable id from the source (Health Connect record id / HealthKit UUID). Dedupes re-syncs. */
  externalId: string;
  type: HealthSampleType;
  value: HealthValue;
  /** Canonical unit for the type (bpm, count, ms, kg, %, mmHg, mmol/L, kcal…). */
  unit: string;
  startAt: number;
  endAt: number;
  /** Originating app / source label reported by the bridge, if any. */
  source?: string;
}

export interface StoredHealthSample extends HealthSample {
  deviceId: string;
  receivedAt: number;
}

export class HealthSyncError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

const MAX_BATCH = 500;
const MAX_EXTERNAL_ID = 128;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Validate + normalize one inbound sample. Throws HealthSyncError('invalid_sample'). */
export function validateHealthSample(raw: unknown): HealthSample {
  if (!raw || typeof raw !== 'object') throw new HealthSyncError('invalid_sample', 'sample must be an object');
  const s = raw as Record<string, unknown>;
  if (typeof s.externalId !== 'string' || s.externalId.length === 0 || s.externalId.length > MAX_EXTERNAL_ID) {
    throw new HealthSyncError('invalid_sample', 'externalId must be a non-empty string ≤ 128 chars');
  }
  if (typeof s.type !== 'string' || !TYPE_SET.has(s.type)) {
    throw new HealthSyncError('invalid_sample', `type must be one of: ${HEALTH_SAMPLE_TYPES.join(', ')}`);
  }
  let value: HealthValue;
  if (s.type === 'blood_pressure') {
    const v = s.value as { systolic?: unknown; diastolic?: unknown } | null;
    if (!v || typeof v !== 'object' || !isFiniteNumber(v.systolic) || !isFiniteNumber(v.diastolic)) {
      throw new HealthSyncError('invalid_sample', 'blood_pressure value must be { systolic, diastolic } numbers');
    }
    value = { systolic: v.systolic, diastolic: v.diastolic };
  } else {
    if (!isFiniteNumber(s.value)) throw new HealthSyncError('invalid_sample', 'value must be a finite number');
    value = s.value;
  }
  if (typeof s.unit !== 'string' || s.unit.length === 0 || s.unit.length > 32) {
    throw new HealthSyncError('invalid_sample', 'unit must be a non-empty string ≤ 32 chars');
  }
  if (!isFiniteNumber(s.startAt) || s.startAt <= 0) {
    throw new HealthSyncError('invalid_sample', 'startAt must be a positive epoch-ms number');
  }
  const endAt = s.endAt === undefined ? s.startAt : s.endAt;
  if (!isFiniteNumber(endAt) || endAt < s.startAt) {
    throw new HealthSyncError('invalid_sample', 'endAt must be ≥ startAt');
  }
  return {
    externalId: s.externalId,
    type: s.type as HealthSampleType,
    value,
    unit: s.unit,
    startAt: s.startAt,
    endAt,
    ...(typeof s.source === 'string' && s.source.length > 0 ? { source: s.source.slice(0, 128) } : {}),
  };
}

interface SampleRow {
  device_id: string;
  external_id: string;
  type: string;
  value_json: string;
  unit: string;
  start_at: number;
  end_at: number;
  source: string | null;
  received_at: number;
}

function rowToSample(row: SampleRow): StoredHealthSample {
  return {
    deviceId: row.device_id,
    externalId: row.external_id,
    type: row.type as HealthSampleType,
    value: JSON.parse(row.value_json) as HealthValue,
    unit: row.unit,
    startAt: row.start_at,
    endAt: row.end_at,
    ...(row.source ? { source: row.source } : {}),
    receivedAt: row.received_at,
  };
}

export interface HealthQuery {
  deviceId?: string;
  types?: HealthSampleType[];
  since?: number;
  until?: number;
  limit?: number;
}

export interface HealthEraseScope {
  deviceId?: string;
  types?: HealthSampleType[];
  /** Delete samples whose startAt is strictly before this epoch-ms. */
  before?: number;
  /** Required to erase with NO other scope dimension. Never implied. */
  confirmAll?: boolean;
}

export class HealthSyncStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = openDb(join(dataDir, 'health-sync.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS health_samples (
        device_id TEXT NOT NULL,
        external_id TEXT NOT NULL,
        type TEXT NOT NULL,
        value_json TEXT NOT NULL,
        unit TEXT NOT NULL,
        start_at INTEGER NOT NULL,
        end_at INTEGER NOT NULL,
        source TEXT,
        received_at INTEGER NOT NULL,
        PRIMARY KEY (device_id, external_id)
      );
      CREATE INDEX IF NOT EXISTS idx_health_type_start ON health_samples(type, start_at DESC);
      CREATE INDEX IF NOT EXISTS idx_health_device_start ON health_samples(device_id, start_at DESC);
    `);
  }

  /**
   * Ingest a validated batch for one device. Idempotent: a sample whose
   * (deviceId, externalId) is already stored counts as a duplicate and
   * is NOT overwritten (first write wins — the source is authoritative
   * for its own record ids).
   */
  ingest(deviceId: string, rawSamples: unknown[]): { inserted: number; duplicates: number } {
    if (typeof deviceId !== 'string' || deviceId.length === 0 || deviceId.length > 128) {
      throw new HealthSyncError('invalid_device', 'deviceId must be a non-empty string ≤ 128 chars');
    }
    if (!Array.isArray(rawSamples) || rawSamples.length === 0) {
      throw new HealthSyncError('invalid_batch', 'samples must be a non-empty array');
    }
    if (rawSamples.length > MAX_BATCH) {
      throw new HealthSyncError('invalid_batch', `batch exceeds ${MAX_BATCH} samples`);
    }
    const samples = rawSamples.map(validateHealthSample);
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO health_samples
         (device_id, external_id, type, value_json, unit, start_at, end_at, source, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = Date.now();
    let inserted = 0;
    for (const s of samples) {
      const r = stmt.run(
        deviceId, s.externalId, s.type, JSON.stringify(s.value), s.unit,
        s.startAt, s.endAt, s.source ?? null, now,
      );
      if (r.changes > 0) inserted += 1;
    }
    return { inserted, duplicates: samples.length - inserted };
  }

  query(q: HealthQuery = {}): StoredHealthSample[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.deviceId) { where.push('device_id = ?'); params.push(q.deviceId); }
    if (q.types && q.types.length > 0) {
      for (const t of q.types) {
        if (!TYPE_SET.has(t)) throw new HealthSyncError('invalid_type', `unknown health type: ${t}`);
      }
      where.push(`type IN (${q.types.map(() => '?').join(', ')})`);
      params.push(...q.types);
    }
    if (q.since !== undefined) { where.push('start_at >= ?'); params.push(q.since); }
    if (q.until !== undefined) { where.push('start_at <= ?'); params.push(q.until); }
    const limit = Math.min(Math.max(q.limit ?? 200, 1), 2000);
    const sql = `SELECT * FROM health_samples ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY start_at DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...(params as never[]), limit) as unknown as SampleRow[];
    return rows.map(rowToSample);
  }

  /** Per-type counts + newest sample time, for one device or all devices. */
  summary(deviceId?: string): Array<{ type: HealthSampleType; count: number; latestStartAt: number }> {
    const rows = (deviceId
      ? this.db.prepare(
          'SELECT type, COUNT(*) AS n, MAX(start_at) AS latest FROM health_samples WHERE device_id = ? GROUP BY type ORDER BY type',
        ).all(deviceId)
      : this.db.prepare(
          'SELECT type, COUNT(*) AS n, MAX(start_at) AS latest FROM health_samples GROUP BY type ORDER BY type',
        ).all()) as unknown as Array<{ type: string; n: number; latest: number }>;
    return rows.map((r) => ({ type: r.type as HealthSampleType, count: r.n, latestStartAt: r.latest }));
  }

  /**
   * Scoped erasure. Refuses an unscoped delete: at least one of
   * deviceId / types / before must be present, or confirmAll must be
   * explicitly true. Returns the number of samples deleted.
   */
  erase(scope: HealthEraseScope): { deleted: number } {
    const types = scope.types ?? [];
    for (const t of types) {
      if (!TYPE_SET.has(t)) throw new HealthSyncError('invalid_type', `unknown health type: ${t}`);
    }
    const hasScope = Boolean(scope.deviceId) || types.length > 0 || scope.before !== undefined;
    if (!hasScope && scope.confirmAll !== true) {
      throw new HealthSyncError(
        'unscoped_erase_refused',
        'erase requires a scope (deviceId, types, or before) or explicit confirmAll:true',
      );
    }
    const where: string[] = [];
    const params: unknown[] = [];
    if (scope.deviceId) { where.push('device_id = ?'); params.push(scope.deviceId); }
    if (types.length > 0) {
      where.push(`type IN (${types.map(() => '?').join(', ')})`);
      params.push(...types);
    }
    if (scope.before !== undefined) { where.push('start_at < ?'); params.push(scope.before); }
    const sql = `DELETE FROM health_samples ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
    const r = this.db.prepare(sql).run(...(params as never[]));
    return { deleted: Number(r.changes) };
  }
}
