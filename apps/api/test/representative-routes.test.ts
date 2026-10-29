// SPDX-License-Identifier: Apache-2.0
// Representative routes: policy + status CRUD, ask endpoint (fenced /
// refusal), audit listing, and the Pages shared-with-team flag that
// feeds the shared-notes fact source.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import {
  PeopleStore,
  RepresentativeService,
  RepresentativeStore,
  TeamInboxStore,
  type Person,
} from '@mvp/agent-runtime';
import { createRepresentativeRouter, sharedNotesFromPages } from '../src/representative-routes.js';
import { PageStore } from '../src/pages.js';

describe('representative-routes', () => {
  let dir: string;
  let base: string;
  let server: ReturnType<express.Express['listen']>;
  let people: PeopleStore;
  let store: RepresentativeStore;
  let ana: Person;
  let ben: Person;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'repr-api-'));
    people = new PeopleStore(dir);
    const inbox = new TeamInboxStore(dir);
    store = new RepresentativeStore(dir);
    ana = people.createPerson({ name: 'Ana Rao', email: 'ana@example.com' });
    ben = people.createPerson({ name: 'Ben Cole' });
    const pages = new PageStore(dir);
    const service = new RepresentativeService({
      people, store, inbox,
      getSharedNotes: (personId) => {
        const p = people.getPerson(personId);
        return p ? sharedNotesFromPages(pages, p) : [];
      },
    });
    // Seed a shared + an unshared page created by Ana.
    const shared = pages.create({ title: 'Shared launch notes', content: 'Beta ships Friday.', createdBy: ana.id });
    pages.setSharedWithTeam(shared.id, true);
    pages.create({ title: 'Private diary', content: 'Secret plans.', createdBy: ana.id });

    const app = express();
    app.use(express.json());
    app.use('/api', createRepresentativeRouter({ people, store, service, audit: vi.fn() }));
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  });
  afterEach(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  it('policy + status CRUD round-trips, with validation errors', async () => {
    const def = await call('GET', `/people/${ana.id}/representative-policy`);
    expect((def.json.policy as { enabled: boolean }).enabled).toBe(false);

    const put = await call('PUT', `/people/${ana.id}/representative-policy`, {
      enabled: true,
      allowedFactTypes: ['availability', 'shared-notes'],
      allowedAskers: { mode: 'team' },
    });
    expect(put.status).toBe(200);
    expect((put.json.policy as { allowedFactTypes: string[] }).allowedFactTypes).toEqual(['availability', 'shared-notes']);

    const badPolicy = await call('PUT', `/people/${ana.id}/representative-policy`, { allowedFactTypes: ['secrets'] });
    expect(badPolicy.status).toBe(400);

    const st = await call('PUT', `/people/${ana.id}/status`, {
      state: 'busy', note: 'In reviews', workingHours: { startHour: 10, endHour: 18, days: [1, 2, 3, 4, 5] },
    });
    expect(st.status).toBe(200);
    const got = await call('GET', `/people/${ana.id}/status`);
    expect((got.json.status as { state: string }).state).toBe('busy');

    const badStatus = await call('PUT', `/people/${ana.id}/status`, { state: 'napping' });
    expect(badStatus.status).toBe(400);
    expect((await call('GET', '/people/nope/status')).status).toBe(404);
  });

  it('ask endpoint: fenced shared-notes answer cites only shared pages; audit lists it', async () => {
    await call('PUT', `/people/${ana.id}/representative-policy`, {
      enabled: true, allowedFactTypes: ['shared-notes'], allowedAskers: { mode: 'team' },
    });
    const res = await call('POST', '/representative/ask', {
      personId: ana.id, askerId: ben.id, question: 'What notes has Ana shared about the launch?',
    });
    const answer = res.json.answer as { answered: boolean; text: string };
    expect(answer.answered).toBe(true);
    expect(answer.text).toContain('Shared launch notes');
    expect(answer.text).toContain('Beta ships Friday.');
    expect(answer.text).not.toContain('Private diary');
    expect(answer.text).not.toContain('Secret plans');

    const audit = await call('GET', `/people/${ana.id}/representative-audit`);
    expect((audit.json.audit as unknown[])).toHaveLength(1);
  });

  it('pages: shared flag defaults false, setSharedWithTeam + update path persist it', () => {
    const pages = new PageStore(dir);
    const pg = pages.create({ title: 'Doc', content: 'body', createdBy: ben.id });
    expect(pg.sharedWithTeam).toBe(false);
    expect(pages.listSharedWithTeam()).toHaveLength(1); // only Ana's shared page
    const flagged = pages.setSharedWithTeam(pg.id, true);
    expect(flagged.sharedWithTeam).toBe(true);
    expect(pages.listSharedWithTeam(ben.id).map((p) => p.title)).toEqual(['Doc']);
    const unflagged = pages.update(pg.id, { sharedWithTeam: false });
    expect(unflagged.sharedWithTeam).toBe(false);
    expect(pages.get(pg.id)?.sharedWithTeam).toBe(false);
  });
});
