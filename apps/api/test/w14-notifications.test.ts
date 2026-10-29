// SPDX-License-Identifier: Apache-2.0
// W14b notification triage: intake + persisted rules (muted app → batched
// silently; quiet hours → batched; allow-list / urgent keyword →
// surfaced), helper-model triage with a mock provider, push on urgent,
// digest accumulation for the daily brief, and the audit privacy rule
// (app + decision only — never titles or bodies).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  NotificationStore,
  NotificationTriageService,
  applyNotificationRules,
  createRoutingNotificationTriage,
  inQuietHours,
  parseNotificationTriage,
  validateNotificationSettings,
  type NotificationSettings,
  type NotificationTriageFn,
  type PhoneNotification,
} from '../src/notification-triage.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'w14-notif-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function notif(partial: Partial<PhoneNotification> = {}): PhoneNotification {
  // One minute ago — safely inside any digest window that ends "now".
  return {
    deviceId: 'phone_1',
    appPackage: 'com.example.chat',
    appName: 'Chat',
    title: 'You have a new message',
    ts: Date.now() - 60_000,
    ...partial,
  };
}

interface PushCall {
  kind: string;
  title: string;
  body: string;
}

function makeService(opts: {
  settings?: Partial<NotificationSettings>;
  triage?: NotificationTriageFn;
  audits?: Array<{ action: string; fields: Record<string, unknown> }>;
} = {}) {
  const store = new NotificationStore(dir);
  if (opts.settings) {
    store.setSettings(validateNotificationSettings({ ...store.getSettings(), ...opts.settings }));
  }
  const pushes: PushCall[] = [];
  const service = new NotificationTriageService({
    store,
    triage: opts.triage,
    push: {
      notify: async (req) => {
        pushes.push({ kind: req.kind, title: req.title, body: req.body });
        return { attempted: 1, sent: 1 };
      },
    },
    audit: opts.audits
      ? (action, fields) => opts.audits!.push({ action, fields: fields as Record<string, unknown> })
      : undefined,
  });
  return { store, service, pushes };
}

describe('notification rules', () => {
  it('muted app → batched silently (no inbox, no push; digest only)', async () => {
    const { store, service, pushes } = makeService({ settings: { mutedApps: ['com.example.chat'] } });
    const stored = await service.ingest(notif());
    expect(stored.decision).toBe('batched');
    expect(stored.reason).toBe('muted-app');
    expect(store.listInbox()).toHaveLength(0);
    expect(pushes).toHaveLength(0);
    expect(store.digestItems(0, Date.now() + 1000)).toHaveLength(1);
  });

  it('quiet hours → batched even for an urgent keyword; allow-list bypass is not applied inside quiet hours', async () => {
    const { service, pushes } = makeService({
      settings: { quietStart: '00:00', quietEnd: '23:59', allowedApps: ['com.example.chat'] },
    });
    const stored = await service.ingest(notif({ title: 'URGENT: fraud alert' }));
    expect(stored.decision).toBe('batched');
    expect(stored.reason).toBe('quiet-hours');
    expect(pushes).toHaveLength(0);
  });

  it('inQuietHours handles overnight windows', () => {
    const s = validateNotificationSettings({ quietStart: '22:00', quietEnd: '07:00' });
    const at = (h: number) => {
      const d = new Date();
      d.setHours(h, 30, 0, 0);
      return d;
    };
    expect(inQuietHours(s, at(23))).toBe(true);
    expect(inQuietHours(s, at(3))).toBe(true);
    expect(inQuietHours(s, at(12))).toBe(false);
  });

  it('allow-listed app → surfaced with a push + inbox item', async () => {
    const { store, service, pushes } = makeService({ settings: { allowedApps: ['com.example.chat'] } });
    const stored = await service.ingest(notif());
    expect(stored.decision).toBe('urgent');
    expect(stored.reason).toBe('allow-list');
    expect(store.listInbox()).toHaveLength(1);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.kind).toBe('needsInput');
  });

  it('urgent keyword in the title → surfaced (built-in and user keywords)', async () => {
    const a = makeService();
    expect((await a.service.ingest(notif({ title: 'Security alert: new sign-in' }))).decision).toBe('urgent');
    const b = makeService({ settings: { urgentKeywords: ['rent'] } });
    const stored = await b.service.ingest(notif({ title: 'Rent is due tomorrow' }));
    expect(stored.decision).toBe('urgent');
    expect(stored.reason).toBe('urgent-keyword');
  });

  it('applyNotificationRules leaves ordinary notifications undecided', () => {
    const s = validateNotificationSettings({});
    expect(applyNotificationRules(s, notif())).toEqual({ decision: 'undecided' });
  });
});

describe('helper-model triage (mock provider, zero paid usage)', () => {
  it('parseNotificationTriage accepts strict JSON only', () => {
    expect(parseNotificationTriage('{"urgent": true}')).toEqual({ urgent: true });
    expect(parseNotificationTriage('sure, urgent!')).toBeNull();
    expect(parseNotificationTriage('{"urgent": "yes"}')).toBeNull();
  });

  it('model verdict urgent → surfaced; not urgent / no verdict → batched', async () => {
    const urgent = makeService({ triage: async () => ({ urgent: true }) });
    expect((await urgent.service.ingest(notif())).decision).toBe('urgent');

    const calm = makeService({ triage: async () => ({ urgent: false }) });
    expect((await calm.service.ingest(notif())).decision).toBe('batched');

    const silent = makeService({ triage: async () => null });
    const stored = await silent.service.ingest(notif());
    expect(stored.decision).toBe('batched');
    expect(stored.reason).toBe('model');
  });

  it('createRoutingNotificationTriage parses a mock provider reply', async () => {
    const triage = createRoutingNotificationTriage({
      route: () => ({ providerId: 'mock', modelId: 'mock-model' }),
      providerFactory: () =>
        ({
          chat: async () => ({ content: '{"urgent": true}' }),
        }) as never,
    });
    await expect(triage(notif())).resolves.toEqual({ urgent: true });
  });

  it('with no triage wired, undecided notifications batch by default', async () => {
    const { service } = makeService();
    const stored = await service.ingest(notif());
    expect(stored.decision).toBe('batched');
    expect(stored.reason).toBe('default');
  });
});

describe('digest + settings + audit privacy', () => {
  it('batched notifications accumulate into the brief digest; urgent ones do not', async () => {
    const { store, service } = makeService({ settings: { allowedApps: ['com.example.bank'] } });
    await service.ingest(notif({ title: 'Chat message one' }));
    await service.ingest(notif({ title: 'Chat message two' }));
    await service.ingest(notif({ appPackage: 'com.example.bank', appName: 'Bank', title: 'Statement ready' }));
    const digest = store.digestItems(0, Date.now() + 1000);
    expect(digest).toHaveLength(2);
    expect(digest.every((d) => d.kind === 'notification')).toBe(true);
  });

  it('settings persist across store reopen', () => {
    const a = new NotificationStore(dir);
    a.setSettings(validateNotificationSettings({ mutedApps: ['com.x'], quietStart: '22:00', quietEnd: '07:00' }));
    const b = new NotificationStore(dir);
    expect(b.getSettings().mutedApps).toEqual(['com.x']);
    expect(b.getSettings().quietStart).toBe('22:00');
  });

  it('audit records app + decision only — never the title', async () => {
    const audits: Array<{ action: string; fields: Record<string, unknown> }> = [];
    const { service } = makeService({ audits });
    await service.ingest(notif({ title: 'My landlord about the secret rent deal' }));
    expect(audits).toHaveLength(1);
    const json = JSON.stringify(audits[0]);
    expect(json).toContain('Chat');
    expect(json).toContain('batched');
    expect(json).not.toContain('landlord');
    expect(json).not.toContain('secret rent');
  });
});
