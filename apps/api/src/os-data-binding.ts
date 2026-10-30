// SPDX-License-Identifier: Apache-2.0
// OS-apps data binding (Muse parity audit §4.14, DV-9).
//
// KriyaDot has TWO sources for the user's contacts and calendar:
//   - 'os'       — the OS apps' own data, read live from the paired phone's
//                  Calendar/Contacts providers via the existing phone data
//                  queries (phone-data-tools.ts). This is the phone's
//                  Calendar app and Contacts app data, not a copy.
//   - 'kriyadot' — KriyaDot's own stores (CalendarEventStore in tasks.ts;
//                  contacts come from an injected local source — KriyaDot
//                  has no standalone contacts store, so without one the
//                  kriyadot contacts provider honestly reports unavailable).
//
// This module is the binding layer between them:
//   - explicit per-kind source selection (BindingConfigStore, persisted to
//     <dataDir>/os-binding.json, default 'os' — the OS apps are canonical),
//   - transparent fallback: when the selected source is unavailable or
//     errors, the other source serves the read and the result SAYS so
//     (`source`, `fellBack: true`) — silent substitution would be a lie,
//   - one provider interface so tools/routes never care which side answered.
//
// Governance: bound reads expose the same personal data as the phone data
// tools → require-approval via osBindingPolicyRules().

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Request, Response, Router } from 'express';
import type { BotPolicyRule, ToolContext, ToolDefinition } from '@mvp/agent-runtime';
import type { PhoneDataDispatcher } from './phone-data-tools.js';
import { PAUSED_MESSAGE } from './system-pause.js';

export function osBindingPolicyRules(): BotPolicyRule[] {
  return [
    {
      id: 'os-binding-approval',
      toolPattern: '^bound_(contacts|calendar)$',
      effect: 'require-approval',
      reason:
        'Bound contacts/calendar reads expose personal data from the user\'s OS apps or KriyaDot stores; needs human approval like the phone data tools.',
    },
  ];
}

export type BoundKind = 'contacts' | 'calendar';
export type BoundSource = 'os' | 'kriyadot';

export interface BoundContact {
  name: string;
  phone?: string;
  email?: string;
}

export interface BoundEvent {
  title: string;
  start: number;
  end?: number;
  location?: string;
}

export interface PersonalDataProvider {
  readonly id: BoundSource;
  /** Cheap availability check (device online / store readable). */
  isAvailable(kind: BoundKind): Promise<boolean>;
  searchContacts(query: string | undefined, limit: number): Promise<BoundContact[]>;
  listEvents(daysAhead: number, limit: number): Promise<BoundEvent[]>;
}

export interface BoundResult<T> {
  source: BoundSource;
  /** True when the SELECTED source failed/unavailable and the other served. */
  fellBack: boolean;
  /** Why the selected source did not serve, when fellBack (or on total failure). */
  selectedError?: string;
  results: T[];
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/** OS source: the paired phone's own Calendar/Contacts apps, via data queries. */
export function createPhoneOsProvider(deps: {
  dispatcher: PhoneDataDispatcher;
  resolveDeviceId?: (requested?: string) => string | undefined;
}): PersonalDataProvider {
  const device = (): string | undefined => deps.resolveDeviceId?.(undefined);
  return {
    id: 'os',
    async isAvailable() {
      const id = device();
      return !!id && deps.dispatcher.isOnline(id);
    },
    async searchContacts(query, limit) {
      const id = device();
      if (!id) throw new Error('no paired phone is online');
      const r = await deps.dispatcher.dispatchDataQuery(id, 'contacts', { ...(query ? { query } : {}), limit });
      if (!r.ok) throw new Error(`phone contacts query failed: ${r.error ?? 'unknown error'}`);
      const rows = (r.data as { contacts?: unknown[] } | null)?.contacts ?? [];
      return rows.filter((c): c is Record<string, unknown> => !!c && typeof c === 'object').map((c) => ({
        name: String(c['name'] ?? ''),
        phone: typeof c['phone'] === 'string' ? c['phone'] : undefined,
        email: typeof c['email'] === 'string' ? c['email'] : undefined,
      }));
    },
    async listEvents(daysAhead, limit) {
      const id = device();
      if (!id) throw new Error('no paired phone is online');
      const r = await deps.dispatcher.dispatchDataQuery(id, 'calendar', { daysAhead, limit });
      if (!r.ok) throw new Error(`phone calendar query failed: ${r.error ?? 'unknown error'}`);
      const rows = (r.data as { events?: unknown[] } | null)?.events ?? [];
      return rows.filter((e): e is Record<string, unknown> => !!e && typeof e === 'object').map((e) => ({
        title: String(e['title'] ?? ''),
        start: typeof e['start'] === 'number' ? e['start'] : 0,
        end: typeof e['end'] === 'number' ? e['end'] : undefined,
        location: typeof e['location'] === 'string' ? e['location'] : undefined,
      }));
    },
  };
}

/**
 * KriyaDot source: its own stores. Calendar reads CalendarEventStore-shaped
 * rows (startsAt ISO strings); contacts need an injected local source —
 * KriyaDot has no contacts store today, so by default contacts report
 * unavailable here (and the binding falls back to the OS source).
 */
export function createKriyaDotProvider(deps: {
  listLocalEvents: () => Array<{ title: string; startsAt: string; endsAt?: string; location?: string }>;
  listLocalContacts?: (query: string | undefined, limit: number) => BoundContact[];
  now?: () => number;
}): PersonalDataProvider {
  const now = deps.now ?? (() => Date.now());
  return {
    id: 'kriyadot',
    async isAvailable(kind) {
      if (kind === 'contacts') return typeof deps.listLocalContacts === 'function';
      return true; // the local events store is always readable
    },
    async searchContacts(query, limit) {
      if (!deps.listLocalContacts) throw new Error('KriyaDot has no local contacts store');
      return deps.listLocalContacts(query, limit);
    },
    async listEvents(daysAhead, limit) {
      const from = now();
      const to = from + daysAhead * 24 * 60 * 60 * 1000;
      return deps.listLocalEvents()
        .map((e) => ({
          title: e.title,
          start: Date.parse(e.startsAt),
          end: e.endsAt ? Date.parse(e.endsAt) : undefined,
          location: e.location,
        }))
        .filter((e) => Number.isFinite(e.start) && e.start >= from - 24 * 60 * 60 * 1000 && e.start <= to)
        .sort((a, b) => a.start - b.start)
        .slice(0, limit);
    },
  };
}

// ---------------------------------------------------------------------------
// Binding configuration (explicit source selection, persisted)
// ---------------------------------------------------------------------------

export type BindingConfig = Record<BoundKind, BoundSource>;

const DEFAULT_BINDING: BindingConfig = { contacts: 'os', calendar: 'os' };

export class BindingConfigStore {
  private readonly file: string;
  private config: BindingConfig;

  constructor(dataDir: string) {
    this.file = join(dataDir, 'os-binding.json');
    this.config = { ...DEFAULT_BINDING };
    try {
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<BindingConfig>;
        for (const kind of ['contacts', 'calendar'] as BoundKind[]) {
          if (raw[kind] === 'os' || raw[kind] === 'kriyadot') this.config[kind] = raw[kind] as BoundSource;
        }
      }
    } catch { /* corrupt config → defaults; never crash the binding layer */ }
  }

  get(kind: BoundKind): BoundSource {
    return this.config[kind];
  }

  all(): BindingConfig {
    return { ...this.config };
  }

  set(kind: BoundKind, source: BoundSource): BindingConfig {
    if (source !== 'os' && source !== 'kriyadot') throw new Error('"source" must be "os" or "kriyadot"');
    this.config[kind] = source;
    mkdirSync(join(this.file, '..'), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.config, null, 2), 'utf8');
    return this.all();
  }
}

// ---------------------------------------------------------------------------
// Binding service (selection + honest fallback)
// ---------------------------------------------------------------------------

export class BoundPersonalDataService {
  constructor(
    private readonly providers: Record<BoundSource, PersonalDataProvider>,
    private readonly config: BindingConfigStore,
  ) {}

  private async serve<T>(
    kind: BoundKind,
    run: (p: PersonalDataProvider) => Promise<T[]>,
  ): Promise<BoundResult<T>> {
    const selected = this.config.get(kind);
    const other: BoundSource = selected === 'os' ? 'kriyadot' : 'os';
    const order: Array<{ source: BoundSource; provider: PersonalDataProvider }> = [
      { source: selected, provider: this.providers[selected] },
      { source: other, provider: this.providers[other] },
    ];
    let selectedError: string | undefined;
    for (const [i, { source, provider }] of order.entries()) {
      try {
        if (!(await provider.isAvailable(kind))) throw new Error(`${source} source unavailable for ${kind}`);
        const results = await run(provider);
        return { source, fellBack: i > 0, ...(selectedError ? { selectedError } : {}), results };
      } catch (e) {
        if (i === 0) selectedError = e instanceof Error ? e.message : String(e);
      }
    }
    throw new Error(`both contact/calendar sources failed for ${kind}: ${selectedError ?? 'unknown error'}`);
  }

  searchContacts(query: string | undefined, limit: number): Promise<BoundResult<BoundContact>> {
    return this.serve('contacts', (p) => p.searchContacts(query, limit));
  }

  listCalendar(daysAhead: number, limit: number): Promise<BoundResult<BoundEvent>> {
    return this.serve('calendar', (p) => p.listEvents(daysAhead, limit));
  }
}

// ---------------------------------------------------------------------------
// Tools + routes (register-style; mounted per the wiring note)
// ---------------------------------------------------------------------------

export interface OsBindingToolDeps {
  service: BoundPersonalDataService;
  audit?: (action: string, fields: { actor?: string; toolName?: string; detail?: unknown; sessionId?: string }) => void;
  isPaused?: () => boolean;
}

function boundedInt(args: Record<string, unknown>, name: string, def: number, min: number, max: number): number {
  const v = args[name];
  if (v === undefined || v === null) return def;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`"${name}" must be a number`);
  return Math.max(min, Math.min(max, Math.floor(v)));
}

export function createOsBindingTools(deps: OsBindingToolDeps): ToolDefinition[] {
  const contacts: ToolDefinition = {
    name: 'bound_contacts',
    description:
      'Search contacts through the DV-9 binding layer: reads the configured source (the phone OS Contacts app by default, or KriyaDot\'s store) and falls back to the other source when the selected one is unavailable — the result names the source that served. Requires human approval.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional name search text' },
        limit: { type: 'number', description: 'Max contacts (1-200, default 50)' },
      },
      required: [],
      additionalProperties: false,
    },
    handler: async (args, ctx: ToolContext) => {
      if (deps.isPaused?.()) throw new Error(`paused: ${PAUSED_MESSAGE}`);
      const q = typeof args['query'] === 'string' && args['query'] ? (args['query'] as string) : undefined;
      const out = await deps.service.searchContacts(q, boundedInt(args, 'limit', 50, 1, 200));
      try {
        deps.audit?.('os_binding.read', { actor: ctx.botId, toolName: 'bound_contacts', sessionId: ctx.sessionId, detail: { kind: 'contacts', source: out.source, fellBack: out.fellBack } });
      } catch { /* audit must never break the tool */ }
      return { ok: true, kind: 'contacts', source: out.source, fellBack: out.fellBack, selectedError: out.selectedError, contacts: out.results };
    },
  };
  const calendar: ToolDefinition = {
    name: 'bound_calendar',
    description:
      'List upcoming calendar events through the DV-9 binding layer: configured source first (the phone OS Calendar app by default, or KriyaDot\'s own events store), honest fallback to the other source. Requires human approval.',
    parameters: {
      type: 'object',
      properties: {
        daysAhead: { type: 'number', description: 'How many days ahead to look (1-31, default 7)' },
        limit: { type: 'number', description: 'Max events (1-200, default 50)' },
      },
      required: [],
      additionalProperties: false,
    },
    handler: async (args, ctx: ToolContext) => {
      if (deps.isPaused?.()) throw new Error(`paused: ${PAUSED_MESSAGE}`);
      const out = await deps.service.listCalendar(boundedInt(args, 'daysAhead', 7, 1, 31), boundedInt(args, 'limit', 50, 1, 200));
      try {
        deps.audit?.('os_binding.read', { actor: ctx.botId, toolName: 'bound_calendar', sessionId: ctx.sessionId, detail: { kind: 'calendar', source: out.source, fellBack: out.fellBack } });
      } catch { /* audit must never break the tool */ }
      return { ok: true, kind: 'calendar', source: out.source, fellBack: out.fellBack, selectedError: out.selectedError, events: out.results };
    },
  };
  return [contacts, calendar];
}

export function registerOsBindingTools(registry: Map<string, ToolDefinition>, deps: OsBindingToolDeps): void {
  for (const tool of createOsBindingTools(deps)) {
    if (!registry.has(tool.name)) registry.set(tool.name, tool);
  }
}

/** Routes: GET/PUT the per-kind source selection. Mount under /os-binding. */
export function registerOsBindingRoutes(
  router: Router,
  deps: { config: BindingConfigStore; audit?: (action: string, fields: { detail?: unknown }) => void },
): void {
  router.get('/binding', (_req: Request, res: Response) => {
    res.json({ ok: true, binding: deps.config.all(), sources: ['os', 'kriyadot'] });
  });
  router.put('/binding/:kind', (req: Request, res: Response) => {
    const kind = req.params['kind'];
    if (kind !== 'contacts' && kind !== 'calendar') {
      res.status(400).json({ error: 'invalid_kind', detail: 'kind must be contacts or calendar' });
      return;
    }
    const source = (req.body as { source?: unknown } | undefined)?.source;
    if (source !== 'os' && source !== 'kriyadot') {
      res.status(400).json({ error: 'invalid_source', detail: 'source must be "os" or "kriyadot"' });
      return;
    }
    const binding = deps.config.set(kind, source);
    try { deps.audit?.('os_binding.set', { detail: { kind, source } }); } catch { /* ignore */ }
    res.json({ ok: true, binding });
  });
}
