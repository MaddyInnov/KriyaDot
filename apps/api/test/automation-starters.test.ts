// SPDX-License-Identifier: Apache-2.0
// Automation starters: 19 recipes, pure readiness classification, and the
// create route (which must persist a DISABLED routine via a real
// RoutineStore on a temp dir).
//
// Zero real network: the Composio client is an injected mock.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SecureVault } from '@mvp/vault';
import {
  AUTOMATION_STARTERS,
  automationStarterById,
  computeStarterReadiness,
  registerAutomationStartersRoutes,
  type AutomationStartersDeps,
  type StarterReadinessState,
} from '../src/automation-starters.js';
import { COMPOSIO_KEY_NAME, type ComposioClient } from '../src/composio.js';
import { writeAccountCache } from '../src/composio-accounts.js';
import { RoutineStore } from '../src/bot-routines.js';
import { validateRoutineSchedule, type EventSchedule } from '../src/routine-schedules.js';

const OWNER_TOKEN = 'test-owner-token';
const VALID_KEY = 'ak_valid-test-key';
const USER = 'default-user';

const bots = [
  { id: 'bot-1', name: 'Helper' },
  { id: 'bot-2', name: 'Coder' },
] as unknown as AutomationStartersDeps['bots'];

const ALL_SLUGS = [
  'canva',
  'googledrive',
  'instagram',
  'linkedin',
  'whatsapp',
  'googlesheets',
  'gmail',
  'googlecalendar',
  'slack',
  'github',
  'stripe',
  'notion',
  'youtube',
  'tiktok',
  'facebook',
  'figma',
  'shopify',
  'zoom',
];

function makeMockClient(overrides: Partial<ComposioClient> = {}): ComposioClient {
  return {
    validateApiKey: async () => ({ ok: true }),
    listApps: async () => ALL_SLUGS.map((appId) => ({ appId, name: appId })),
    createAuthLink: async () => ({ redirectUrl: 'https://example/link' }),
    listConnectedAccounts: async () => [],
    getConnectedAccount: async () => null,
    deleteConnectedAccount: async () => {},
    revokeConnectedAccount: async () => {},
    listTools: async () => [],
    executeTool: async () => ({ successful: true }),
    ...overrides,
  };
}

describe('AUTOMATION_STARTERS definitions', () => {
  it('defines exactly the 19 required recipes with unique ids', () => {
    expect(AUTOMATION_STARTERS).toHaveLength(19);
    expect(new Set(AUTOMATION_STARTERS.map((r) => r.id)).size).toBe(19);
    expect(AUTOMATION_STARTERS.map((r) => r.id)).toEqual([
      'canva-design-archive-post',
      'whatsapp-lead-digest',
      'instagram-engagement-digest',
      'linkedin-content-pipeline',
      'gmail-important-mail-note',
      'morning-brief',
      'slack-channel-digest',
      'github-repo-digest',
      'stripe-payments-digest',
      'drive-document-intake',
      'notion-action-items',
      'youtube-channel-digest',
      'tiktok-content-digest',
      'facebook-page-digest',
      'figma-handoff-digest',
      'shopify-store-digest',
      'zoom-meeting-followup',
      'cross-social-weekly-report',
      'sheets-kpi-snapshot',
    ]);
    // Categories: existing 5 keep their assigned values, new ones are set.
    expect(automationStarterById('canva-design-archive-post')?.category).toBe('content');
    expect(automationStarterById('whatsapp-lead-digest')?.category).toBe('communication');
    expect(automationStarterById('instagram-engagement-digest')?.category).toBe('content');
    expect(automationStarterById('linkedin-content-pipeline')?.category).toBe('content');
    expect(automationStarterById('gmail-important-mail-note')?.category).toBe('communication');
    for (const r of AUTOMATION_STARTERS) {
      expect(['content', 'communication', 'work', 'business', 'development'], r.id).toContain(r.category);
    }
    expect(automationStarterById('gmail-important-mail-note')?.triggerKind).toBe('event');
    for (const r of AUTOMATION_STARTERS) {
      if (r.id !== 'gmail-important-mail-note') expect(r.triggerKind).toBe('schedule');
      expect(r.approvalNote.length).toBeGreaterThan(20);
    }
    expect(automationStarterById('canva-design-archive-post')).toMatchObject({
      requiredApps: ['canva', 'googledrive', 'instagram', 'linkedin'],
      optionalApps: ['instagram', 'linkedin'],
    });
    expect(automationStarterById('whatsapp-lead-digest')).toMatchObject({
      requiredApps: ['whatsapp'],
      optionalApps: ['googlesheets'],
    });
  });

  it('whatsapp description is honest: it polls via Composio, no event trigger exists', () => {
    const wa = automationStarterById('whatsapp-lead-digest')!;
    expect(wa.description).toContain('no WhatsApp event trigger');
    expect(wa.description.toLowerCase()).toContain('poll');
  });

  it('every prompt template routes through discovery, drafts-only, and carries {{payload}}', () => {
    for (const r of AUTOMATION_STARTERS) {
      expect(r.promptTemplate, r.id).toContain('composio_list_actions');
      expect(r.promptTemplate, r.id).toContain('use only an action slug that tool returns');
      expect(r.promptTemplate, r.id).toContain('prepare a draft and stop for my approval');
      expect(r.promptTemplate, r.id).toContain('{{payload}}');
      // No concrete Composio action slugs anywhere user-facing.
      for (const text of [r.promptTemplate, r.description, r.approvalNote, r.name]) {
        expect(text, r.id).not.toMatch(/[A-Z]{3,}_[A-Z_]+/);
      }
      // RoutineStore caps prompt templates at 4000 chars.
      expect(r.promptTemplate.length, r.id).toBeLessThan(4000);
    }
  });

  it('static schedules use the real routine-schedules shapes and validate', () => {
    const canva = automationStarterById('canva-design-archive-post')!;
    expect(canva.schedule).toMatchObject({ kind: 'daily', time: '18:00' });
    expect(validateRoutineSchedule(canva.schedule)).toMatchObject({ kind: 'daily', time: '18:00' });

    const wa = automationStarterById('whatsapp-lead-digest')!;
    expect(wa.schedule).toMatchObject({ kind: 'interval', everyMinutes: 30 });
    expect(validateRoutineSchedule(wa.schedule)).toMatchObject({ kind: 'interval', everyMinutes: 30 });

    const insta = automationStarterById('instagram-engagement-digest')!;
    expect(insta.schedule).toMatchObject({ kind: 'daily', time: '09:00' });
    expect(validateRoutineSchedule(insta.schedule)).toMatchObject({ kind: 'daily' });

    const linkedin = automationStarterById('linkedin-content-pipeline')!;
    expect(linkedin.schedule).toMatchObject({ kind: 'cron', expression: '0 10 * * 1' });
    expect(validateRoutineSchedule(linkedin.schedule)).toMatchObject({ kind: 'cron' });
  });

  it('every static schedule validates, uses Asia/Kolkata, and new recipes match their spec', () => {
    for (const r of AUTOMATION_STARTERS) {
      if (r.schedule) {
        expect(r.schedule.timezone, r.id).toBe('Asia/Kolkata');
        expect(validateRoutineSchedule(r.schedule), r.id).toMatchObject({ kind: r.schedule.kind });
      }
    }
    expect(automationStarterById('morning-brief')).toMatchObject({
      category: 'work',
      requiredApps: ['gmail', 'googlecalendar'],
      schedule: { kind: 'daily', time: '08:00', weekdays: [0, 1, 2, 3, 4, 5, 6] },
    });
    expect(automationStarterById('slack-channel-digest')?.schedule).toMatchObject({ kind: 'daily', time: '19:00' });
    expect(automationStarterById('github-repo-digest')?.schedule).toMatchObject({ kind: 'cron', expression: '0 9 * * 1' });
    expect(automationStarterById('stripe-payments-digest')?.schedule).toMatchObject({ kind: 'daily', time: '20:00' });
    expect(automationStarterById('drive-document-intake')?.schedule).toMatchObject({ kind: 'interval', everyMinutes: 120 });
    expect(automationStarterById('notion-action-items')?.schedule).toMatchObject({ kind: 'daily', time: '09:00' });
    expect(automationStarterById('youtube-channel-digest')?.schedule).toMatchObject({ kind: 'cron', expression: '0 10 * * 1' });
    expect(automationStarterById('tiktok-content-digest')?.schedule).toMatchObject({ kind: 'cron', expression: '0 10 * * 2' });
    expect(automationStarterById('facebook-page-digest')?.schedule).toMatchObject({ kind: 'daily', time: '09:00' });
    expect(automationStarterById('figma-handoff-digest')?.schedule).toMatchObject({ kind: 'daily', time: '18:00' });
    expect(automationStarterById('shopify-store-digest')?.schedule).toMatchObject({ kind: 'daily', time: '21:00' });
    expect(automationStarterById('zoom-meeting-followup')?.schedule).toMatchObject({ kind: 'interval', everyMinutes: 60 });
    expect(automationStarterById('cross-social-weekly-report')).toMatchObject({
      category: 'content',
      requiredApps: ['instagram', 'facebook'],
      optionalApps: ['tiktok', 'youtube'],
      schedule: { kind: 'cron', expression: '0 18 * * 0' },
    });
    expect(automationStarterById('sheets-kpi-snapshot')).toMatchObject({
      category: 'business',
      requiredApps: ['googlesheets'],
      optionalApps: ['googledrive'],
      schedule: { kind: 'cron', expression: '0 17 * * 5' },
    });
    // Guard rails baked into specific templates.
    expect(automationStarterById('sheets-kpi-snapshot')!.promptTemplate).toContain('never guess a sheet');
    expect(automationStarterById('sheets-kpi-snapshot')!.promptTemplate).toContain('stop and ask');
    expect(automationStarterById('slack-channel-digest')!.promptTemplate).toContain('stop and ask');
    expect(automationStarterById('shopify-store-digest')!.promptTemplate.toLowerCase()).toContain('do not change any order');
    expect(automationStarterById('cross-social-weekly-report')!.description).toContain('included only when they are connected');
  });

  it('gmail scheduleFor binds the resolved account, and returns null without one', () => {
    const gmail = automationStarterById('gmail-important-mail-note')!;
    const withAccount = gmail.scheduleFor?.({ accountIdFor: (slug) => (slug === 'gmail' ? 'ca_gmail1' : undefined) });
    expect(withAccount).toMatchObject({
      kind: 'event',
      app: 'gmail',
      accountId: 'ca_gmail1',
      pollMinutes: 15,
      dailyCap: 20,
    });
    expect(validateRoutineSchedule(withAccount)).toMatchObject({ kind: 'event', app: 'gmail' });
    const without = gmail.scheduleFor?.({ accountIdFor: () => undefined });
    expect(without).toBeNull();
  });
});

describe('computeStarterReadiness', () => {
  const full: StarterReadinessState = {
    platformConfigured: true,
    catalogSlugs: new Set(ALL_SLUGS),
    activeAccountSlugs: new Set(ALL_SLUGS),
    enabledSlugsForBot: new Set(ALL_SLUGS),
  };

  it('all gates passed → ready, optional apps never block', () => {
    const canva = automationStarterById('canva-design-archive-post')!;
    // instagram/linkedin have no account and are not enabled — optional.
    const state: StarterReadinessState = {
      ...full,
      activeAccountSlugs: new Set(['canva', 'googledrive']),
      enabledSlugsForBot: new Set(['canva', 'googledrive']),
    };
    expect(computeStarterReadiness(canva, state)).toEqual({ ready: true, missing: [] });
  });

  it('platform not configured blocks every required slug with the platform kind', () => {
    const gmail = automationStarterById('gmail-important-mail-note')!;
    const out = computeStarterReadiness(gmail, { ...full, platformConfigured: false });
    expect(out.ready).toBe(false);
    expect(out.missing).toEqual([{ slug: 'gmail', need: 'platform_not_configured' }]);
  });

  it('catalog → account → enablement precedence per slug', () => {
    const gmail = automationStarterById('gmail-important-mail-note')!;
    expect(
      computeStarterReadiness(gmail, { ...full, catalogSlugs: new Set() }).missing,
    ).toEqual([{ slug: 'gmail', need: 'not_in_catalog' }]);
    expect(
      computeStarterReadiness(gmail, { ...full, activeAccountSlugs: new Set() }).missing,
    ).toEqual([{ slug: 'gmail', need: 'account_not_connected' }]);
    expect(
      computeStarterReadiness(gmail, { ...full, enabledSlugsForBot: new Set() }).missing,
    ).toEqual([{ slug: 'gmail', need: 'not_enabled_for_bot' }]);
  });

  it('morning-brief: missing one required app blocks with that slug only', () => {
    const brief = automationStarterById('morning-brief')!;
    const out = computeStarterReadiness(brief, {
      ...full,
      activeAccountSlugs: new Set(['gmail']), // googlecalendar has no account
    });
    expect(out).toEqual({
      ready: false,
      missing: [{ slug: 'googlecalendar', need: 'account_not_connected' }],
    });
    expect(computeStarterReadiness(brief, full)).toEqual({ ready: true, missing: [] });
  });

  it('cross-social-weekly-report: optional apps never block', () => {
    const cross = automationStarterById('cross-social-weekly-report')!;
    const state: StarterReadinessState = {
      ...full,
      catalogSlugs: new Set(['instagram', 'facebook']),
      activeAccountSlugs: new Set(['instagram', 'facebook']),
      enabledSlugsForBot: new Set(['instagram', 'facebook']),
    };
    expect(computeStarterReadiness(cross, state)).toEqual({ ready: true, missing: [] });
  });

  it('sheets-kpi-snapshot: ready with googlesheets only (drive is optional)', () => {
    const kpi = automationStarterById('sheets-kpi-snapshot')!;
    const state: StarterReadinessState = {
      ...full,
      catalogSlugs: new Set(['googlesheets']),
      activeAccountSlugs: new Set(['googlesheets']),
      enabledSlugsForBot: new Set(['googlesheets']),
    };
    expect(computeStarterReadiness(kpi, state)).toEqual({ ready: true, missing: [] });
    // And without googlesheets it blocks on that required slug alone.
    expect(computeStarterReadiness(kpi, { ...state, activeAccountSlugs: new Set() })).toEqual({
      ready: false,
      missing: [{ slug: 'googlesheets', need: 'account_not_connected' }],
    });
  });

  it('reports each blocking slug once (canva recipe)', () => {
    const canva = automationStarterById('canva-design-archive-post')!;
    const out = computeStarterReadiness(canva, {
      ...full,
      activeAccountSlugs: new Set(['canva']), // googledrive missing an account
    });
    expect(out).toEqual({
      ready: false,
      missing: [{ slug: 'googledrive', need: 'account_not_connected' }],
    });
  });
});

describe('automation-starters routes', () => {
  let dir: string;
  let store: RoutineStore;
  let audit: ReturnType<typeof vi.fn>;
  let server: { close(cb: () => void): void } | null = null;
  let baseUrl = '';

  function makeDeps(overrides: Partial<AutomationStartersDeps> = {}): AutomationStartersDeps {
    return {
      config: { dataDir: dir } as unknown as AutomationStartersDeps['config'],
      governance: { audit } as unknown as AutomationStartersDeps['governance'],
      bots,
      loopbackToken: OWNER_TOKEN,
      composioClient: makeMockClient(),
      routineStoreFactory: () => store,
      ...overrides,
    };
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'automation-starters-'));
    store = new RoutineStore(dir);
    audit = vi.fn();
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerAutomationStartersRoutes(router, makeDeps());
    app.use('/api', router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve()) as unknown as { close(cb: () => void): void };
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}/api`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  });

  async function call(method: string, path: string, body?: unknown, auth = true) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(auth ? { authorization: `Bearer ${OWNER_TOKEN}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, json };
  }

  it('requires a verified principal (401 without one)', async () => {
    expect((await call('GET', '/automation-starters', undefined, false)).status).toBe(401);
    expect((await call('POST', '/automation-starters/canva-design-archive-post/create', { botId: 'bot-1' }, false)).status).toBe(401);
  });

  it('GET lists all 19 starters with category; unconfigured platform → platform missing kinds', async () => {
    const { status, json } = await call('GET', '/automation-starters');
    expect(status).toBe(200);
    const starters = json.starters as Array<Record<string, unknown>>;
    expect(starters).toHaveLength(19);
    expect(starters.map((s) => s.id)).toEqual(AUTOMATION_STARTERS.map((r) => r.id));
    for (const s of starters) {
      const recipe = AUTOMATION_STARTERS.find((r) => r.id === s.id)!;
      expect(s.category, String(s.id)).toBe(recipe.category);
    }
    expect(starters.find((s) => s.id === 'morning-brief')?.category).toBe('work');
    expect(starters.find((s) => s.id === 'github-repo-digest')?.category).toBe('development');
    for (const s of starters) {
      expect(s.ready).toBe(false);
      const missing = s.missing as Array<{ slug: string; need: string }>;
      expect(missing.length).toBeGreaterThan(0);
      expect(missing.every((m) => m.need === 'platform_not_configured')).toBe(true);
    }
    // No botId → enablement is not part of the verdict (platform fires first anyway).
    expect((await call('GET', '/automation-starters?botId=nope')).status).toBe(404);
  });

  it('GET with a key + connected+enabled whatsapp → whatsapp starter ready, gmail blocked at account', async () => {
    new SecureVault(dir, USER, USER).create(COMPOSIO_KEY_NAME, VALID_KEY, 'Composio API key (test)');
    writeFileSync(
      join(dir, 'composio-enables.json'),
      JSON.stringify({ 'bot-1': { whatsapp: true } }),
    );
    // Re-register routes with a client that has a WhatsApp account.
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerAutomationStartersRoutes(
      router,
      makeDeps({
        composioClient: makeMockClient({
          listConnectedAccounts: async () => [
            { id: 'ca_wa1', toolkitSlug: 'whatsapp', toolkitName: 'WhatsApp', status: 'ACTIVE' },
          ],
        }),
      }),
    );
    app.use('/api2', router);
    const srv = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => srv.once('listening', () => resolve()));
    const port = (srv.address() as AddressInfo).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api2/automation-starters?botId=bot-1`, {
        headers: { authorization: `Bearer ${OWNER_TOKEN}` },
      });
      const json = (await res.json()) as { starters: Array<Record<string, unknown>> };
      const wa = json.starters.find((s) => s.id === 'whatsapp-lead-digest');
      expect(wa).toMatchObject({ ready: true, missing: [] });
      const gmail = json.starters.find((s) => s.id === 'gmail-important-mail-note');
      expect(gmail).toMatchObject({
        ready: false,
        missing: [{ slug: 'gmail', need: 'account_not_connected' }],
      });
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });

  it('POST create (daily recipe) persists a DISABLED routine with the schedule applied + audits', async () => {
    const { status, json } = await call('POST', '/automation-starters/canva-design-archive-post/create', { botId: 'bot-1' });
    expect(status).toBe(200);
    expect(json).toMatchObject({
      ok: true,
      name: 'Canva design archive + social drafts',
      enabled: false,
      triggerKind: 'schedule',
      scheduleApplied: true,
    });
    const routine = store.get(json.routineId as string);
    expect(routine).toBeDefined();
    expect(routine!.enabled).toBe(false);
    expect(routine!.botId).toBe('bot-1');
    expect(routine!.schedule).toMatchObject({ kind: 'daily', time: '18:00' });
    expect(routine!.promptTemplate).toContain('composio_list_actions');
    expect(audit).toHaveBeenCalledWith(
      'automation_starter.created',
      expect.objectContaining({
        detail: expect.objectContaining({ starterId: 'canva-design-archive-post', scheduleApplied: true }),
      }),
    );
  });

  it('POST create morning-brief persists a DISABLED routine with the daily schedule applied', async () => {
    const { status, json } = await call('POST', '/automation-starters/morning-brief/create', { botId: 'bot-1' });
    expect(status).toBe(200);
    expect(json).toMatchObject({
      ok: true,
      name: 'Morning brief',
      enabled: false,
      triggerKind: 'schedule',
      scheduleApplied: true,
    });
    const routine = store.get(json.routineId as string);
    expect(routine).toBeDefined();
    expect(routine!.enabled).toBe(false);
    expect(routine!.botId).toBe('bot-1');
    expect(routine!.schedule).toMatchObject({ kind: 'daily', time: '08:00' });
    expect(routine!.promptTemplate).toContain('{{payload}}');
    expect(audit).toHaveBeenCalledWith(
      'automation_starter.created',
      expect.objectContaining({
        detail: expect.objectContaining({ starterId: 'morning-brief', scheduleApplied: true }),
      }),
    );
  });

  it('POST create gmail WITHOUT a cached account → manual routine (no schedule), still disabled', async () => {
    const { status, json } = await call('POST', '/automation-starters/gmail-important-mail-note/create', { botId: 'bot-1' });
    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, enabled: false, triggerKind: 'event', scheduleApplied: false });
    const routine = store.get(json.routineId as string);
    expect(routine!.enabled).toBe(false);
    expect(routine!.schedule ?? null).toBeNull();
  });

  it('POST create gmail WITH an ACTIVE cached account → event schedule applied', async () => {
    writeAccountCache(dir, USER, {
      ca_gmail1: { toolkitSlug: 'gmail', status: 'ACTIVE', firstSeenAt: 1, updatedAt: 1 },
    });
    const { status, json } = await call('POST', '/automation-starters/gmail-important-mail-note/create', { botId: 'bot-2' });
    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, enabled: false, triggerKind: 'event', scheduleApplied: true });
    const routine = store.get(json.routineId as string);
    expect(routine!.enabled).toBe(false);
    expect(routine!.schedule).toMatchObject({
      kind: 'event',
      app: 'gmail',
      accountId: 'ca_gmail1',
      pollMinutes: 15,
      dailyCap: 20,
    } satisfies Partial<EventSchedule>);
  });

  it('POST create 404s: unknown recipe, unknown bot; 400 without botId', async () => {
    expect((await call('POST', '/automation-starters/nope/create', { botId: 'bot-1' })).status).toBe(404);
    expect((await call('POST', '/automation-starters/canva-design-archive-post/create', { botId: 'nope' })).status).toBe(404);
    expect((await call('POST', '/automation-starters/canva-design-archive-post/create', {})).status).toBe(400);
    expect(store.list()).toHaveLength(0);
  });
});
