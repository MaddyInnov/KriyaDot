// SPDX-License-Identifier: Apache-2.0
// Representative assistant: policy matrix, status store, deterministic
// fact assembly with provenance fencing, owner notification + audit.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PeopleStore, TeamInboxStore, type Person } from '../src/people.js';
import {
  RepresentativeService,
  RepresentativeStore,
  classifyRepresentativeQuestion,
} from '../src/representative.js';
import { createAnswerForPersonTool } from '../src/tools/representative.js';
import type { BotConfig } from '../src/types.js';

function bot(id: string, ownerId?: string): BotConfig {
  return {
    id, name: `Bot ${id}`, description: 'd', systemPrompt: 'p', provider: 'groq', model: 'm',
    skills: [], tools: [], mcpServers: [], ...(ownerId ? { ownerId } : {}),
  } as BotConfig;
}

describe('representative assistant', () => {
  let dir: string;
  let people: PeopleStore;
  let inbox: TeamInboxStore;
  let store: RepresentativeStore;
  let ana: Person;
  let ben: Person;
  let service: RepresentativeService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'repr-'));
    people = new PeopleStore(dir);
    inbox = new TeamInboxStore(dir);
    store = new RepresentativeStore(dir);
    ana = people.createPerson({ name: 'Ana Rao', email: 'ana@example.com', channels: { handles: { telegram: 'ana_tg' } } });
    ben = people.createPerson({ name: 'Ben Cole' });
    service = new RepresentativeService({
      people, store, inbox,
      getBots: () => [bot('ana-bot', ana.id), bot('ben-bot', ben.id)],
      getBotActivity: (botId) => botId === 'ana-bot'
        ? { botId, botName: 'Bot ana-bot', summary: 'Running read_file (step 2)' }
        : undefined,
      getSharedNotes: (personId) => personId === ana.id
        ? [{ id: 'pg1', title: 'Launch checklist', excerpt: 'Ship the beta on Friday after QA sign-off.' }]
        : [],
    });
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const enableAll = (over: Record<string, unknown> = {}): void => {
    store.setPolicy(ana.id, {
      enabled: true,
      allowedFactTypes: ['availability', 'status', 'shared-notes', 'public-profile'],
      allowedAskers: { mode: 'team' },
      requireOwnerNotify: true,
      ...over,
    });
  };

  it('classifies questions into fact types and scope', () => {
    expect(classifyRepresentativeQuestion('Is Ana available tomorrow?')).toBe('availability');
    expect(classifyRepresentativeQuestion('What is Ana working on right now?')).toBe('status');
    expect(classifyRepresentativeQuestion('What shared notes does Ana have about the launch?')).toBe('shared-notes');
    expect(classifyRepresentativeQuestion('What is Ana\'s email?')).toBe('public-profile');
    expect(classifyRepresentativeQuestion('Does Ana approve of the budget?')).toBeNull();
  });

  it('refuses when the representative is disabled (default), and audits it', async () => {
    const res = await service.answer({ personId: ana.id, askerId: ben.id, question: 'Is Ana available?' });
    expect(res.answered).toBe(false);
    expect(res.refusal).toContain('not enabled');
    expect(res.offerRelay).toBe(true);
    const audit = store.listAudit(ana.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.outcome).toBe('refused');
  });

  it('refuses askers who are not allowed (unknown asker under team mode; non-listed under people mode)', async () => {
    enableAll();
    const stranger = await service.answer({ personId: ana.id, askerId: 'per_unknown', question: 'Is Ana available?' });
    expect(stranger.answered).toBe(false);
    expect(stranger.refusal).toContain('not a team member');

    enableAll({ allowedAskers: { mode: 'people', personIds: ['someone-else'] } });
    const benRes = await service.answer({ personId: ana.id, askerId: ben.id, question: 'Is Ana available?' });
    expect(benRes.answered).toBe(false);
    expect(benRes.refusal).toContain('not on the representative allowed list');
  });

  it('refuses fact types the owner did not enable', async () => {
    enableAll({ allowedFactTypes: ['status'] });
    const res = await service.answer({ personId: ana.id, askerId: ben.id, question: 'What is Ana\'s email?' });
    expect(res.answered).toBe(false);
    expect(res.factType).toBe('public-profile');
    expect(res.refusal).toContain('not enabled their representative to share public-profile');
  });

  it('refuses out-of-scope questions and offers relay', async () => {
    enableAll();
    const res = await service.answer({ personId: ana.id, askerId: ben.id, question: 'Does Ana think we should hire more people?' });
    expect(res.answered).toBe(false);
    expect(res.factType).toBeNull();
    expect(res.offerRelay).toBe(true);
    expect(res.refusal).toContain('outside what');
  });

  it('answers availability from the person-set status + working hours, fenced with sources', async () => {
    enableAll();
    store.setStatus(ana.id, {
      state: 'focus',
      note: 'Deep work on the launch',
      workingHours: { startHour: 9, endHour: 17, days: [1, 2, 3, 4, 5], timezone: 'Asia/Kolkata' },
    });
    const res = await service.answer({ personId: ana.id, askerId: ben.id, question: 'When is Ana available?' });
    expect(res.answered).toBe(true);
    expect(res.text).toContain(`Answered by Ana Rao's representative from person-status`);
    expect(res.text).toContain('status is focus');
    expect(res.text).toContain('Working hours: 9:00–17:00');
    expect(res.text).toContain('no calendar events are read');
    expect(res.facts.every((f) => f.source === 'person-status')).toBe(true);
  });

  it('says so when no status was set (never invents availability)', async () => {
    enableAll();
    const res = await service.answer({ personId: ana.id, askerId: ben.id, question: 'Is Ana free?' });
    expect(res.answered).toBe(true);
    expect(res.text).toContain('has not set a status');
  });

  it('answers status with bot activity and shared-notes only from shared pages', async () => {
    enableAll();
    const status = await service.answer({ personId: ana.id, askerId: ben.id, question: 'What is Ana working on?' });
    expect(status.text).toContain('Running read_file (step 2)');

    const notes = await service.answer({ personId: ana.id, askerId: ben.id, question: 'What notes has Ana shared about the launch?' });
    expect(notes.text).toContain('Launch checklist');
    expect(notes.text).toContain('Ship the beta on Friday');

    const benNotes = await service.answer({ personId: ben.id, askerId: ana.id, question: 'What notes has Ben shared?' });
    // Ben's representative is disabled by default.
    expect(benNotes.answered).toBe(false);
  });

  it('answers public-profile from directory fields only', async () => {
    enableAll();
    const res = await service.answer({ personId: ana.id, askerId: ben.id, question: 'How do I contact Ana — what is her email?' });
    expect(res.answered).toBe(true);
    expect(res.text).toContain('ana@example.com');
    expect(res.text).toContain('telegram');
  });

  it('creates an owner FYI inbox item per answer when requireOwnerNotify, audit always', async () => {
    enableAll();
    await service.answer({ personId: ana.id, askerId: ben.id, question: 'Is Ana available?' });
    const items = inbox.listItems({ personId: ana.id, kind: 'fyi' });
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toContain('representative answered');
    expect(store.listAudit(ana.id)[0]!.outcome).toBe('answered');

    enableAll({ requireOwnerNotify: false });
    await service.answer({ personId: ana.id, askerId: ben.id, question: 'Is Ana available?' });
    expect(inbox.listItems({ personId: ana.id, kind: 'fyi' })).toHaveLength(1); // no new item
    expect(store.listAudit(ana.id)).toHaveLength(2); // audit still recorded
  });

  it('polish may rephrase the summary but cited facts stay verbatim', async () => {
    enableAll();
    const polished = new RepresentativeService({
      people, store, inbox,
      polish: () => 'Polished summary line.',
    });
    const res = await polished.answer({ personId: ana.id, askerId: ben.id, question: 'Is Ana free?' });
    expect(res.text).toContain('Polished summary line.');
    expect(res.text).toContain('has not set a status'); // verbatim fact bullet survives
  });

  it('status routes data: set/get round-trip and validation', () => {
    const s = store.setStatus(ana.id, { state: 'ooo', until: 123456, note: 'On leave' });
    expect(s.state).toBe('ooo');
    expect(store.getStatus(ana.id)?.note).toBe('On leave');
    expect(() => store.setStatus(ana.id, { state: 'sleeping' })).toThrow(/free\|busy\|focus\|ooo/);
    expect(() => store.setPolicy(ana.id, { allowedFactTypes: ['secrets'] })).toThrow();
  });

  it('answer_for_person tool: resolves names, returns fenced answer / refusal shape', async () => {
    enableAll();
    const tool = createAnswerForPersonTool({ people, representative: service });
    const ctx = { botId: 'chief', sessionId: 's1' } as never;
    const ok = await tool.handler({ person: 'Ana Rao', question: 'Is Ana available?', asker: ben.id }, ctx) as Record<string, unknown>;
    expect(ok.answered).toBe(true);
    expect(String(ok.text)).toContain("Ana Rao's representative");
    const bad = await tool.handler({ person: 'Nobody', question: 'hi', asker: ben.id }, ctx) as Record<string, unknown>;
    expect(String(bad.error)).toContain('Unknown person');
    const spy = vi.fn();
    void spy;
  });
});
