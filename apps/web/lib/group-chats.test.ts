// SPDX-License-Identifier: Apache-2.0
// Client contract tests for the group room robustness API surface
// (OpenMausBot parity): URL/query construction, methods, and response
// mapping for the new endpoints. authedFetch is mocked; no network.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: Array<{ path: string; init?: RequestInit }> = [];

vi.mock('./api', () => ({
  authedFetch: vi.fn(async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    // Echo fixtures per endpoint.
    if (path.endsWith('/status')) return json({ ok: true, status: { hold: 'held', queue: [] } });
    if (path.endsWith('/settings') && init?.method === 'PUT')
      return json({ ok: true, settings: { ...body, turnTimeoutMin: 45 } });
    if (path.endsWith('/settings')) return json({ ok: true, settings: { turnTimeoutMin: 30 } });
    if (path.endsWith('/hold')) return json({ ok: true, status: { hold: 'held' } });
    if (path.endsWith('/halt')) return json({ ok: true, status: { hold: 'halted' } });
    if (path.endsWith('/release')) return json({ ok: true, status: { hold: 'active' } });
    if (path.endsWith('/queue') && init?.method === 'DELETE') return json({ ok: true, cleared: 2 });
    if (path.endsWith('/queue')) return json({ ok: true, queue: [{ id: 'q1', text: 'hi' }] });
    if (path.includes('/failures/') && path.endsWith('/retry'))
      return json({ ok: true, message: { id: 'm1', text: 'recovered' } });
    if (path.endsWith('/failures')) return json({ ok: true, failures: [{ id: 'f1' }] });
    if (path.includes('/messages')) {
      if (path.includes('queue=1')) return json({ ok: true, queued: true, position: 2, userMessage: { id: 'u1' } });
      return json({ ok: true, queued: false, userMessage: { id: 'u1' }, replies: [], timedOut: false, failures: [] });
    }
    return json({ ok: true });
  }),
}));

function json(payload: unknown): Response {
  return { ok: true, json: async () => payload } as Response;
}

import {
  clearRoomQueue,
  getRoomSettings,
  getRoomStatus,
  haltRoom,
  holdRoom,
  listRoomFailures,
  listRoomQueue,
  releaseRoom,
  retryRoomFailure,
  sendGroupMessage,
  updateRoomSettings,
} from './group-chats';

beforeEach(() => {
  calls.length = 0;
});

describe('room robustness client', () => {
  it('builds the ?queue=1 and ?timeoutMin= query string', async () => {
    const r = await sendGroupMessage('grp_x', 'hello', { queue: true, timeoutMin: 15 });
    expect(calls[0].path).toBe('/api/groups/grp_x/messages?queue=1&timeoutMin=15');
    expect(calls[0].init?.method).toBe('POST');
    expect(r.queued).toBe(true);
    expect(r.position).toBe(2);
  });

  it('sends a plain message without a query string', async () => {
    const r = await sendGroupMessage('grp_x', 'hello');
    expect(calls[0].path).toBe('/api/groups/grp_x/messages');
    expect(r.queued).toBe(false);
  });

  it('maps status, settings, and hold actions', async () => {
    expect((await getRoomStatus('g1')).hold).toBe('held');
    expect(calls[0].init?.method).toBe(undefined);

    await updateRoomSettings('g1', { turnTimeoutMin: 45 });
    expect(calls[1].path).toBe('/api/groups/g1/settings');
    expect(calls[1].init?.method).toBe('PUT');
    expect(JSON.parse(calls[1].init?.body as string)).toEqual({ turnTimeoutMin: 45 });

    expect((await getRoomSettings('g1')).turnTimeoutMin).toBe(30);
    expect((await holdRoom('g1')).hold).toBe('held');
    expect((await haltRoom('g1')).hold).toBe('halted');
    expect((await releaseRoom('g1')).hold).toBe('active');
  });

  it('maps queue and failure endpoints', async () => {
    expect(await listRoomQueue('g1')).toHaveLength(1);
    expect(await clearRoomQueue('g1')).toBe(2);
    expect(calls[1].init?.method).toBe('DELETE');

    expect(await listRoomFailures('g1')).toHaveLength(1);
    const msg = await retryRoomFailure('g1', 'f1');
    expect(msg.id).toBe('m1');
    expect(calls[3].path).toBe('/api/groups/g1/failures/f1/retry');
    expect(calls[3].init?.method).toBe('POST');
  });
});
