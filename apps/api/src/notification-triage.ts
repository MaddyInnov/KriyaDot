// SPDX-License-Identifier: Apache-2.0
// Notification triage (W14b): notifications from the paired phone are
// streamed to the server (phone.ts wire message { type:'notification' })
// and sorted into "needs you now" vs "read in the morning brief".
//
// Privacy posture (follows the remote-screen rules — when in doubt, less):
//   - Intake carries { appPackage, appName?, title, ts } ONLY. Notification
//     bodies are sensitive: the wire validator drops them, this module's
//     types have no body field, and nothing here persists one.
//   - Audit entries record the app name + the triage decision — never the
//     notification title or any content.
//
// Flow:
//   1. Rules first (persisted user settings): per-app mute list → batched
//      silently; quiet hours → batched; allow-listed app or an urgent
//      keyword in the title → surfaced.
//   2. Otherwise a cheap helper model decides (routeModel 'simple-qa',
//      the W5 triage pattern): urgent → surfaced, anything else → batched.
//      No triage function wired / no verdict → batched (fail quiet).
//   3. Surfaced → a "needs you" item in this store's inbox + a push via
//      the existing PushService ('needsInput'). Batched → accumulated for
//      the daily brief's notifications digest section (briefing.ts reads
//      NotificationStore.digestItems).

import express from 'express';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createProvider, routeModel, type LLMProvider } from '@mvp/agent-runtime';
import { openDb } from '@mvp/agent-runtime';
import type { PushService } from './push.js';
import type { BriefingItem } from './briefing.js';

// ---------------------------------------------------------------------------
// Types + settings
// ---------------------------------------------------------------------------

/** One phone notification event. Deliberately NO body field. */
export interface PhoneNotification {
  deviceId: string;
  appPackage: string;
  appName?: string;
  title: string;
  ts: number;
}

export type NotificationDecision = 'urgent' | 'batched';

export interface StoredNotification {
  id: string;
  deviceId: string;
  appPackage: string;
  appName?: string;
  title: string;
  ts: number;
  decision: NotificationDecision;
  /** Why: 'muted-app' | 'quiet-hours' | 'allow-list' | 'urgent-keyword' | 'model' | 'default'. */
  reason: string;
}

export interface NotificationSettings {
  /** App packages that never surface (batched silently). */
  mutedApps: string[];
  /** App packages whose notifications always surface. */
  allowedApps: string[];
  /** Extra title keywords (case-insensitive) that mark a notification urgent. */
  urgentKeywords: string[];
  /** Quiet hours window "HH:MM" local; null = no quiet hours. */
  quietStart: string | null;
  quietEnd: string | null;
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  mutedApps: [],
  allowedApps: [],
  urgentKeywords: [],
  quietStart: null,
  quietEnd: null,
};

/** Built-in urgent keywords, always active in addition to user keywords. */
export const BUILTIN_URGENT_KEYWORDS = [
  'urgent',
  'otp',
  'one-time',
  'verification code',
  'fraud',
  'security alert',
  'payment failed',
  'delivery failed',
];

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function validateNotificationSettings(input: unknown): NotificationSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('settings must be an object');
  }
  const raw = input as Record<string, unknown>;
  const strList = (v: unknown, name: string, max: number): string[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
      throw new Error(`"${name}" must be an array of strings`);
    }
    return [...new Set((v as string[]).map((s) => s.trim()).filter(Boolean))].slice(0, max);
  };
  const time = (v: unknown, name: string): string | null => {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string' || !TIME_RE.test(v)) throw new Error(`"${name}" must be "HH:MM" (24h) or null`);
    return v;
  };
  return {
    mutedApps: strList(raw.mutedApps, 'mutedApps', 200),
    allowedApps: strList(raw.allowedApps, 'allowedApps', 200),
    urgentKeywords: strList(raw.urgentKeywords, 'urgentKeywords', 100),
    quietStart: time(raw.quietStart, 'quietStart'),
    quietEnd: time(raw.quietEnd, 'quietEnd'),
  };
}

/** Is `date` inside the quiet-hours window? Handles overnight windows. */
export function inQuietHours(settings: NotificationSettings, date: Date): boolean {
  if (!settings.quietStart || !settings.quietEnd) return false;
  const cur = date.getHours() * 60 + date.getMinutes();
  const [sh, sm] = settings.quietStart.split(':').map(Number);
  const [eh, em] = settings.quietEnd.split(':').map(Number);
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  if (start === end) return false;
  if (start < end) return cur >= start && cur < end;
  return cur >= start || cur < end; // overnight, e.g. 22:00 → 07:00
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface NotificationRow {
  id: string;
  device_id: string;
  app_package: string;
  app_name: string | null;
  title: string;
  ts: number;
  decision: string;
  reason: string;
}

function rowToNotification(r: NotificationRow): StoredNotification {
  return {
    id: r.id,
    deviceId: r.device_id,
    appPackage: r.app_package,
    ...(r.app_name ? { appName: r.app_name } : {}),
    title: r.title,
    ts: r.ts,
    decision: r.decision === 'urgent' ? 'urgent' : 'batched',
    reason: r.reason,
  };
}

export class NotificationStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = openDb(join(dataDir, 'notifications.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        app_package TEXT NOT NULL,
        app_name TEXT,
        title TEXT NOT NULL,
        ts INTEGER NOT NULL,
        decision TEXT NOT NULL,
        reason TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_notifications_ts ON notifications(ts DESC);
      CREATE INDEX IF NOT EXISTS idx_notifications_decision ON notifications(decision, ts DESC);
      CREATE TABLE IF NOT EXISTS notification_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  record(n: PhoneNotification, decision: NotificationDecision, reason: string): StoredNotification {
    const stored: StoredNotification = {
      id: `notif_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      deviceId: n.deviceId,
      appPackage: n.appPackage,
      ...(n.appName ? { appName: n.appName } : {}),
      title: n.title.slice(0, 300),
      ts: n.ts,
      decision,
      reason,
    };
    this.db
      .prepare(
        'INSERT INTO notifications (id, device_id, app_package, app_name, title, ts, decision, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(stored.id, stored.deviceId, stored.appPackage, stored.appName ?? null, stored.title, stored.ts, stored.decision, stored.reason);
    return stored;
  }

  /** The "needs you" inbox: surfaced (urgent) notifications, newest first. */
  listInbox(limit = 100): StoredNotification[] {
    const rows = this.db
      .prepare("SELECT * FROM notifications WHERE decision = 'urgent' ORDER BY ts DESC LIMIT ?")
      .all(Math.max(1, Math.min(500, limit))) as unknown as NotificationRow[];
    return rows.map(rowToNotification);
  }

  listRecent(limit = 100): StoredNotification[] {
    const rows = this.db
      .prepare('SELECT * FROM notifications ORDER BY ts DESC LIMIT ?')
      .all(Math.max(1, Math.min(500, limit))) as unknown as NotificationRow[];
    return rows.map(rowToNotification);
  }

  /** Batched notifications since `since`, as daily-brief digest items. */
  digestItems(since: number, now: number, limit = 20): BriefingItem[] {
    const rows = this.db
      .prepare("SELECT * FROM notifications WHERE decision = 'batched' AND ts >= ? AND ts <= ? ORDER BY ts DESC LIMIT ?")
      .all(since, now, Math.max(1, Math.min(100, limit))) as unknown as NotificationRow[];
    return rows.map((r) => ({
      id: `notification-${r.id}`,
      title: r.title || '(notification)',
      detail: r.app_name ?? r.app_package,
      ts: r.ts,
      kind: 'notification',
    }));
  }

  getSettings(): NotificationSettings {
    const row = this.db
      .prepare("SELECT value FROM notification_settings WHERE key = 'settings'")
      .get() as { value: string } | undefined;
    if (!row) return { ...DEFAULT_NOTIFICATION_SETTINGS };
    try {
      return { ...DEFAULT_NOTIFICATION_SETTINGS, ...validateNotificationSettings(JSON.parse(row.value)) };
    } catch {
      return { ...DEFAULT_NOTIFICATION_SETTINGS };
    }
  }

  setSettings(settings: NotificationSettings): NotificationSettings {
    const valid = validateNotificationSettings(settings);
    this.db
      .prepare(
        "INSERT INTO notification_settings (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(JSON.stringify(valid));
    return valid;
  }
}

// ---------------------------------------------------------------------------
// Rule pass (pure)
// ---------------------------------------------------------------------------

export type RuleOutcome =
  | { decision: 'batched'; reason: 'muted-app' | 'quiet-hours' }
  | { decision: 'urgent'; reason: 'allow-list' | 'urgent-keyword' }
  | { decision: 'undecided' };

/** Deterministic rules. 'undecided' falls through to the helper model. */
export function applyNotificationRules(
  settings: NotificationSettings,
  n: PhoneNotification,
  now: Date = new Date(n.ts),
): RuleOutcome {
  if (settings.mutedApps.includes(n.appPackage)) return { decision: 'batched', reason: 'muted-app' };
  if (inQuietHours(settings, now)) return { decision: 'batched', reason: 'quiet-hours' };
  if (settings.allowedApps.includes(n.appPackage)) return { decision: 'urgent', reason: 'allow-list' };
  const title = n.title.toLowerCase();
  const keywords = [...BUILTIN_URGENT_KEYWORDS, ...settings.urgentKeywords.map((k) => k.toLowerCase())];
  if (keywords.some((k) => k && title.includes(k))) return { decision: 'urgent', reason: 'urgent-keyword' };
  return { decision: 'undecided' };
}

// ---------------------------------------------------------------------------
// Helper-model triage (W5 pattern: routeModel simple-qa, strict JSON)
// ---------------------------------------------------------------------------

export type NotificationTriageFn = (n: PhoneNotification) => Promise<{ urgent: boolean } | null>;

export function parseNotificationTriage(text: string): { urgent: boolean } | null {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    if (typeof v.urgent !== 'boolean') return null;
    return { urgent: v.urgent };
  } catch {
    return null;
  }
}

export function createRoutingNotificationTriage(deps: {
  providerFactory?: (providerId: string) => LLMProvider;
  route?: () => { providerId: string; modelId: string };
} = {}): NotificationTriageFn {
  const factory = deps.providerFactory ?? ((id: string) => createProvider(id));
  return async (n) => {
    try {
      const route = deps.route?.() ?? routeModel({ taskType: 'simple-qa', providerHint: undefined });
      const provider = factory(route.providerId);
      const res = await provider.chat(
        [
          {
            role: 'system',
            content:
              'You triage phone notifications for a busy user. Decide whether the notification needs ' +
              'the user\'s immediate attention. Answer with STRICT JSON only: {"urgent": boolean}. ' +
              'When in doubt, answer false — the user wants a quiet phone.',
          },
          {
            role: 'user',
            content: `App: ${n.appName ?? n.appPackage}\nTitle: ${n.title}`,
          },
        ],
        [],
        { model: route.modelId, signal: AbortSignal.timeout(30_000) },
      );
      return parseNotificationTriage(res.content ?? '');
    } catch {
      return null;
    }
  };
}

// ---------------------------------------------------------------------------
// Triage service
// ---------------------------------------------------------------------------

export interface NotificationTriageDeps {
  store: NotificationStore;
  /** Helper-model triage for rule-undecided notifications (optional). */
  triage?: NotificationTriageFn;
  /** Existing push path (W5): urgent items send one 'needsInput' push. */
  push?: Pick<PushService, 'notify'>;
  /** Bot id/name used for the push (the Chief by default). */
  pushBotId?: string;
  pushBotName?: string;
  /** Audit sink: app name + decision ONLY — never titles or bodies. */
  audit?: (action: string, fields: { actor?: string; toolName?: string; detail?: unknown }) => void;
  now?: () => number;
}

export class NotificationTriageService {
  constructor(private readonly deps: NotificationTriageDeps) {}

  /** Intake one notification event from the phone socket. Never throws. */
  async ingest(raw: PhoneNotification): Promise<StoredNotification> {
    // Defensive shape clamp — the wire validator already bounded these,
    // but direct callers (tests, future transports) get the same limits.
    const n: PhoneNotification = {
      deviceId: String(raw.deviceId ?? '').slice(0, 128),
      appPackage: String(raw.appPackage ?? '').slice(0, 128),
      ...(raw.appName ? { appName: String(raw.appName).slice(0, 64) } : {}),
      title: String(raw.title ?? '').slice(0, 300),
      ts: Number.isFinite(raw.ts) ? raw.ts : (this.deps.now?.() ?? Date.now()),
    };
    const settings = this.deps.store.getSettings();
    const ruled = applyNotificationRules(settings, n, new Date(n.ts));
    let decision: NotificationDecision;
    let reason: string;
    if (ruled.decision !== 'undecided') {
      decision = ruled.decision;
      reason = ruled.reason;
    } else if (this.deps.triage) {
      let verdict: { urgent: boolean } | null = null;
      try {
        verdict = await this.deps.triage(n);
      } catch {
        verdict = null; // triage infra failure → fail quiet (batched)
      }
      decision = verdict?.urgent ? 'urgent' : 'batched';
      reason = 'model';
    } else {
      decision = 'batched';
      reason = 'default';
    }
    const stored = this.deps.store.record(n, decision, reason);
    try {
      this.deps.audit?.('notification.triaged', {
        actor: 'system',
        toolName: 'notifications',
        // App + decision only. No title, no body — ever.
        detail: { app: n.appName ?? n.appPackage, decision, reason },
      });
    } catch {
      // Audit must never break intake.
    }
    if (decision === 'urgent' && this.deps.push) {
      try {
        await this.deps.push.notify({
          kind: 'needsInput',
          botId: this.deps.pushBotId ?? 'chief',
          botName: this.deps.pushBotName ?? 'Chief',
          title: `${n.appName ?? n.appPackage} needs you`,
          body: n.title.slice(0, 200),
        });
      } catch {
        // Push is best-effort; the inbox entry is the durable record.
      }
    }
    return stored;
  }
}

// ---------------------------------------------------------------------------
// HTTP surface: settings + inbox (mounted under /api/notifications)
// ---------------------------------------------------------------------------

export interface NotificationRouteDeps {
  store: NotificationStore;
  service?: NotificationTriageService;
  audit?: NotificationTriageDeps['audit'];
}

function errorBody(error: string): { error: string } {
  return { error };
}

export function registerNotificationRoutes(router: express.Router, deps: NotificationRouteDeps): void {
  const r = express.Router();

  r.get('/settings', (_req: Request, res: Response) => {
    res.json({ ok: true, settings: deps.store.getSettings() });
  });

  r.put('/settings', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { settings?: unknown };
      const settings = deps.store.setSettings(validateNotificationSettings(body.settings ?? req.body));
      try {
        deps.audit?.('notification.settings_updated', {
          actor: 'user',
          toolName: 'notifications',
          detail: {
            mutedApps: settings.mutedApps.length,
            allowedApps: settings.allowedApps.length,
            quietHours: Boolean(settings.quietStart && settings.quietEnd),
          },
        });
      } catch {
        // ignore
      }
      res.json({ ok: true, settings });
    } catch (err) {
      res.status(400).json(errorBody(err instanceof Error ? err.message : 'invalid settings'));
    }
  });

  r.get('/inbox', (req: Request, res: Response) => {
    const limit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 100;
    res.json({ ok: true, items: deps.store.listInbox(Number.isFinite(limit) ? limit : 100) });
  });

  r.get('/digest', (req: Request, res: Response) => {
    const now = Date.now();
    res.json({ ok: true, items: deps.store.digestItems(now - 24 * 60 * 60 * 1000, now) });
  });

  // Manual intake (used by tests and non-WS transports). Same service path
  // as the socket handler, so rules/triage/push apply identically.
  r.post('/intake', async (req: Request, res: Response) => {
    if (!deps.service) {
      res.status(501).json(errorBody('notification triage service is not wired'));
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const stored = await deps.service.ingest({
      deviceId: typeof body.deviceId === 'string' ? body.deviceId : 'manual',
      appPackage: typeof body.appPackage === 'string' ? body.appPackage : '',
      ...(typeof body.appName === 'string' ? { appName: body.appName } : {}),
      title: typeof body.title === 'string' ? body.title : '',
      ts: typeof body.ts === 'number' ? body.ts : Date.now(),
    });
    res.status(201).json({ ok: true, notification: stored });
  });

  router.use('/notifications', r);
}
