// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { Router } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HealthSyncError, HealthSyncStore, validateHealthSample } from '../src/health-sync.js';
import { registerHealthSyncRoutes } from '../src/health-sync-routes.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'health-sync-'));
}

const T0 = 1_760_000_000_000;

function sample(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    externalId: 'hc-rec-1', type: 'steps', value: 8431, unit: 'count',
    startAt: T0, endAt: T0 + 3_600_000, source: 'com.google.android.gms',
    ...overrides,
  };
}

describe('validateHealthSample', () => {
  it('accepts scalar + blood_pressure shapes and defaults endAt to startAt', () => {
    const s = validateHealthSample(sample());
    expect(s.type).toBe('steps');
    expect(s.value).toBe(8431);
    const point = validateHealthSample(sample({ externalId: 'hr-1', type: 'heart_rate', value: 72, unit: 'bpm', endAt: undefined }));
    expect(point.endAt).toBe(point.startAt);
    const bp = validateHealthSample(sample({
      externalId: 'bp-1', type: 'blood_pressure', value: { systolic: 118, diastolic: 76 }, unit: 'mmHg',
    }));
    expect(bp.value).toEqual({ systolic: 118, diastolic: 76 });
  });

  it('rejects unknown types, non-finite values, bad windows and bad ids', () => {
    expect(() => validateHealthSample(sample({ type: 'mood' }))).toThrow(HealthSyncError);
    expect(() => validateHealthSample(sample({ value: Number.NaN }))).toThrow(/finite/);
    expect(() => validateHealthSample(sample({ value: { systolic: 118 } }))).toThrow(HealthSyncError);
    expect(() => validateHealthSample(sample({ endAt: T0 - 1 }))).toThrow(/endAt/);
    expect(() => validateHealthSample(sample({ externalId: '' }))).toThrow(/externalId/);
    expect(() => validateHealthSample(sample({ type: 'blood_pressure', value: 118 }))).toThrow(/systolic/);
  });
});

describe('HealthSyncStore ingest/query/summary', () => {
  it('ingests idempotently per (deviceId, externalId) and summarizes per type', () => {
    const store = new HealthSyncStore(tmpDir());
    const batch = [
      sample(),
      sample({ externalId: 'hr-1', type: 'heart_rate', value: 72, unit: 'bpm' }),
      sample({ externalId: 'sl-1', type: 'sleep', value: 27_000_000, unit: 'ms', endAt: T0 + 27_000_000 }),
    ];
    expect(store.ingest('pixel-1', batch)).toEqual({ inserted: 3, duplicates: 0 });
    // Retry of the same batch (companion reconnect) duplicates nothing.
    expect(store.ingest('pixel-1', batch)).toEqual({ inserted: 0, duplicates: 3 });
    // Same externalId from a DIFFERENT device is a distinct sample.
    expect(store.ingest('iphone-1', [sample()])).toEqual({ inserted: 1, duplicates: 0 });

    const summary = store.summary('pixel-1');
    expect(summary.map((s) => s.type).sort()).toEqual(['heart_rate', 'sleep', 'steps']);
    expect(summary.find((s) => s.type === 'steps')?.count).toBe(1);

    const onlyHr = store.query({ deviceId: 'pixel-1', types: ['heart_rate'] });
    expect(onlyHr).toHaveLength(1);
    expect(onlyHr[0].value).toBe(72);
    expect(store.query({ deviceId: 'pixel-1', since: T0 + 1 })).toHaveLength(0);
    expect(() => store.ingest('pixel-1', [])).toThrow(/non-empty/);
    expect(() => store.ingest('pixel-1', [sample({ type: 'nope' })])).toThrow(HealthSyncError);
  });
});

describe('HealthSyncStore scoped erasure (DV-4)', () => {
  function seeded(): HealthSyncStore {
    const store = new HealthSyncStore(tmpDir());
    store.ingest('pixel-1', [
      sample(),
      sample({ externalId: 'hr-1', type: 'heart_rate', value: 72, unit: 'bpm' }),
      sample({ externalId: 'sl-1', type: 'sleep', value: 100, unit: 'ms' }),
      sample({ externalId: 'sl-old', type: 'sleep', value: 50, unit: 'ms', startAt: T0 - 86_400_000, endAt: T0 - 86_000_000 }),
    ]);
    store.ingest('iphone-1', [sample({ externalId: 'sl-9', type: 'sleep', value: 90, unit: 'ms' })]);
    return store;
  }

  it('per-type erase deletes only that type, only for the scoped device', () => {
    const store = seeded();
    expect(store.erase({ deviceId: 'pixel-1', types: ['sleep'] })).toEqual({ deleted: 2 });
    expect(store.query({ deviceId: 'pixel-1' }).map((s) => s.type).sort()).toEqual(['heart_rate', 'steps']);
    // Other device's sleep samples are untouched.
    expect(store.query({ deviceId: 'iphone-1', types: ['sleep'] })).toHaveLength(1);
  });

  it('before-scoped erase deletes only older samples', () => {
    const store = seeded();
    expect(store.erase({ types: ['sleep'], before: T0 })).toEqual({ deleted: 1 });
    expect(store.query({ types: ['sleep'] })).toHaveLength(2);
  });

  it('an unscoped erase is REFUSED; confirmAll is required for a full wipe', () => {
    const store = seeded();
    expect(() => store.erase({})).toThrow(expect.objectContaining({ code: 'unscoped_erase_refused' }));
    expect(store.query({})).toHaveLength(5);
    expect(store.erase({ confirmAll: true })).toEqual({ deleted: 5 });
    expect(store.query({})).toHaveLength(0);
  });
});

describe('health-sync routes', () => {
  let base = '';
  let server: ReturnType<express.Express['listen']>;

  beforeAll(async () => {
    const store = new HealthSyncStore(tmpDir());
    const app = express();
    app.use(express.json());
    const router = Router();
    registerHealthSyncRoutes(router, { store });
    app.use('/api/health-sync', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.on('listening', r));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/api/health-sync`;
  });

  afterAll(() => server.close());

  it('ingest → query → summary → scoped erase over HTTP', async () => {
    const post = await fetch(`${base}/samples`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'pixel-1', samples: [sample(), sample({ externalId: 'sl-1', type: 'sleep', value: 100, unit: 'ms' })] }),
    });
    expect(post.status).toBe(201);
    expect(((await post.json()) as { inserted: number }).inserted).toBe(2);

    const bad = await fetch(`${base}/samples`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'pixel-1', samples: [sample({ type: 'mood' })] }),
    });
    expect(bad.status).toBe(400);

    const summary = (await (await fetch(`${base}/summary?deviceId=pixel-1`)).json()) as { summary: Array<{ type: string }> };
    expect(summary.summary.map((s) => s.type).sort()).toEqual(['sleep', 'steps']);

    const unscoped = await fetch(`${base}/samples`, {
      method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(unscoped.status).toBe(400);
    expect(((await unscoped.json()) as { error: string }).error).toBe('unscoped_erase_refused');

    const erased = (await (await fetch(`${base}/samples`, {
      method: 'DELETE', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'pixel-1', types: ['sleep'] }),
    })).json()) as { deleted: number };
    expect(erased.deleted).toBe(1);

    const remaining = (await (await fetch(`${base}/samples?deviceId=pixel-1`)).json()) as { samples: unknown[] };
    expect(remaining.samples).toHaveLength(1);
  });
});
