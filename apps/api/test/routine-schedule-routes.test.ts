// SPDX-License-Identifier: Apache-2.0
// Routine scheduling API: schedule CRUD on routines, next-runs preview,
// and schedule enable/disable. HTTP-level tests with a live localhost
// server; no paid APIs.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerRoutineRoutes } from '../src/bot-routines.js';
import { RoutineHookStore } from '../src/routine-hooks.js';
import type { BotConfig } from '@mvp/agent-runtime';

const bots = [
  { id: 'worker', name: 'Worker', description: 'does work', systemPrompt: 's', provider: 'p', model: 'm', skills: [], tools: [], mcpServers: [] },
] as unknown as BotConfig[];

async function post(base: string, path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

async function patch(base: string, path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

async function get(base: string, path: string) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

describe('routine scheduling API', () => {
  let dir: string;
  let base: string;
  let server: { close(cb: () => void): void } | null = null;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'routine-sched-api-'));
    const app = express();
    app.use(express.json());
    const routinesRouter = express.Router();
    registerRoutineRoutes(routinesRouter, {
      dataDir: dir,
      getBots: () => bots,
      hookStore: new RoutineHookStore(dir),
      getBaseUrls: () => ({ publicBaseUrl: undefined, localPort: 4567 }),
    });
    app.use('/api/routines', routinesRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve()) as unknown as { close(cb: () => void): void };
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
    rmSync(dir, { recursive: true, force: true });
  });

  async function createRoutine(schedule?: unknown) {
    return post(base, '/api/routines', {
      name: 'scheduled',
      botId: 'worker',
      promptTemplate: 'do the thing',
      ...(schedule === undefined ? {} : { schedule }),
    });
  }

  it('creates a routine with a valid schedule', async () => {
    const { status, json } = await createRoutine({
      kind: 'daily', timezone: 'Asia/Kolkata', time: '09:00', weekdays: [1, 2, 3, 4, 5],
    });
    expect(status).toBe(201);
    expect(json.routine.schedule).toMatchObject({ kind: 'daily', time: '09:00' });
    expect(json.routine.nextRunAt).toEqual(expect.any(Number));
  });

  it('rejects an invalid schedule with 400', async () => {
    const { status, json } = await createRoutine({ kind: 'cron', timezone: 'UTC', expression: '0 9 30 2 *' });
    expect(status).toBe(400);
    expect(json.error).toMatch(/impossible/);
  });

  it('rejects an unknown timezone with 400', async () => {
    const { status } = await createRoutine({ kind: 'daily', timezone: 'Mars/Olympus', time: '09:00' });
    expect(status).toBe(400);
  });

  it('PATCH can set and clear the schedule', async () => {
    const created = await createRoutine();
    expect(created.status).toBe(201);
    const id = created.json.routine.id as string;

    const set = await patch(base, `/api/routines/${id}`, {
      schedule: { kind: 'interval', timezone: 'UTC', everyMinutes: 15 },
    });
    expect(set.status).toBe(200);
    expect(set.json.routine.schedule).toMatchObject({ kind: 'interval', everyMinutes: 15 });

    const cleared = await patch(base, `/api/routines/${id}`, { schedule: null });
    expect(cleared.status).toBe(200);
    expect(cleared.json.routine.schedule).toBeNull();
    expect(cleared.json.routine.nextRunAt).toBeNull();
  });

  it('PATCH rejects an invalid schedule without touching the old one', async () => {
    const created = await createRoutine({ kind: 'daily', timezone: 'UTC', time: '09:00' });
    const id = created.json.routine.id as string;
    const bad = await patch(base, `/api/routines/${id}`, {
      schedule: { kind: 'daily', timezone: 'UTC', time: '99:99' },
    });
    expect(bad.status).toBe(400);
    const after = await get(base, `/api/routines/${id}`);
    expect(after.json.routine.schedule).toMatchObject({ kind: 'daily', time: '09:00' });
  });

  it('GET /:id/next-runs previews upcoming runs', async () => {
    const created = await createRoutine({ kind: 'daily', timezone: 'UTC', time: '09:00' });
    const id = created.json.routine.id as string;
    const { status, json } = await get(base, `/api/routines/${id}/next-runs?n=3`);
    expect(status).toBe(200);
    expect(json.runs).toHaveLength(3);
    expect(json.runs[0]).toHaveProperty('at');
    expect(json.runs[0]).toHaveProperty('label');
    // Ascending order.
    expect(json.runs[0].at).toBeLessThan(json.runs[1].at);
  });

  it('GET /:id/next-runs 400s when there is no schedule', async () => {
    const created = await createRoutine();
    const { status } = await get(base, `/api/routines/${created.json.routine.id}/next-runs`);
    expect(status).toBe(400);
  });

  it('schedule enable/disable toggles firing eligibility', async () => {
    const created = await createRoutine({ kind: 'daily', timezone: 'UTC', time: '09:00' });
    const id = created.json.routine.id as string;

    const disabled = await post(base, `/api/routines/${id}/schedule/disable`, {});
    expect(disabled.status).toBe(200);
    expect(disabled.json.routine.schedule.enabled).toBe(false);
    expect(disabled.json.routine.nextRunAt).toBeNull();

    const enabled = await post(base, `/api/routines/${id}/schedule/enable`, {});
    expect(enabled.status).toBe(200);
    expect(enabled.json.routine.schedule.enabled).toBe(true);
    expect(enabled.json.routine.nextRunAt).toEqual(expect.any(Number));
  });

  it('enable/disable 400s when there is no schedule', async () => {
    const created = await createRoutine();
    const { status } = await post(base, `/api/routines/${created.json.routine.id}/schedule/enable`, {});
    expect(status).toBe(400);
  });

  it('list includes nextRunAt for scheduled routines', async () => {
    await createRoutine({ kind: 'daily', timezone: 'UTC', time: '09:00' });
    await createRoutine();
    const { json } = await get(base, '/api/routines');
    expect(json.routines).toHaveLength(2);
    const scheduled = json.routines.find((r: any) => r.schedule);
    const plain = json.routines.find((r: any) => !r.schedule);
    expect(scheduled.nextRunAt).toEqual(expect.any(Number));
    expect(plain.nextRunAt).toBeNull();
  });
});
