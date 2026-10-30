// SPDX-License-Identifier: Apache-2.0
// Shelly smart-plug control + metering over the LOCAL HTTP API
// (Muse parity audit §4.14, DV-15).
//
// Two device generations, one client, auto-detected via GET /shelly:
//   - Gen2+ (Plus/Pro/Gen3): JSON-RPC at /rpc — Switch.Set / Switch.GetStatus
//     (live power metering: apower W, voltage, current, cumulative energy),
//     Switch.GetConfig / Switch.SetConfig, Schedule.List/Create/Delete.
//   - Gen1: REST — /relay/<n>?turn=on|off|toggle, /status (meters[].power),
//     /settings, /settings/relay/<n> (name), schedule via /settings +
//     relay `schedule_rules` is Gen1-shaped; this client exposes Gen1
//     schedules read-only and says so (rule editing differs per firmware).
//
// The transport is injectable (tests: mock; production: direct fetch or —
// recommended — the DV-13 home proxy's proxyTransport(), so the per-host
// first-use approval governs every Shelly call too).
//
// Governance: switching/config/schedule mutations are device control →
// require-approval via shellyPolicyRules() when used through the tool.

import type { BotPolicyRule, ToolContext, ToolDefinition } from '@mvp/agent-runtime';
import type { HttpTransport } from './home-control-proxy.js';
import { PAUSED_MESSAGE } from './system-pause.js';

export function shellyPolicyRules(): BotPolicyRule[] {
  return [
    {
      id: 'shelly-control-approval',
      toolPattern: '^shelly_control$',
      effect: 'require-approval',
      reason:
        'Switching a smart plug, changing its config or editing its schedules controls a physical device on the user\'s network; needs human approval. (Reads ride the same rule: one tool, one gate.)',
    },
  ];
}

export interface ShellyInfo {
  generation: 1 | 2;
  type?: string;
  mac?: string;
  model?: string;
  firmware?: string;
  authEnabled?: boolean;
}

export interface ShellyRelayStatus {
  relay: number;
  on: boolean;
  /** Instantaneous power draw in watts (metering plugs only). */
  powerW?: number;
  voltageV?: number;
  currentA?: number;
  /** Cumulative energy in watt-hours (Gen2 reports aenergy.total in Wh). */
  energyWh?: number;
  temperatureC?: number;
}

export interface ShellySchedule {
  id: number;
  enabled: boolean;
  timespec?: string;
  calls?: unknown[];
  /** Gen1 read-back shape, when Gen2 RPC is absent. */
  raw?: unknown;
}

export class ShellyError extends Error {
  constructor(message: string, readonly httpStatus?: number) {
    super(message);
    this.name = 'ShellyError';
  }
}

export interface ShellyClientDeps {
  host: string;
  transport: HttpTransport;
  /** Force a generation; default auto-detects once via /shelly. */
  generation?: 1 | 2;
}

export class ShellyClient {
  private detected: ShellyInfo | null = null;

  constructor(private readonly deps: ShellyClientDeps) {
    if (deps.generation) this.detected = { generation: deps.generation };
  }

  private base(): string {
    const h = this.deps.host;
    return /^https?:\/\//i.test(h) ? h.replace(/\/$/, '') : `http://${h}`;
  }

  private async request(method: 'GET' | 'POST', path: string, body?: string): Promise<{ status: number; json: unknown }> {
    const res = await this.deps.transport({ method, url: `${this.base()}${path}`, body });
    let json: unknown = null;
    try { json = JSON.parse(res.bodyText) as unknown; } catch { /* non-JSON body */ }
    if (res.status < 200 || res.status >= 300) {
      throw new ShellyError(`Shelly ${method} ${path} failed with HTTP ${res.status}`, res.status);
    }
    return { status: res.status, json };
  }

  /** Detect generation + identity via GET /shelly (cached). */
  async info(): Promise<ShellyInfo> {
    if (this.detected) return this.detected;
    const { json } = await this.request('GET', '/shelly');
    if (!json || typeof json !== 'object') throw new ShellyError('Shelly /shelly returned no JSON — is this a Shelly device?');
    const j = json as Record<string, unknown>;
    const gen = typeof j['gen'] === 'number' ? (j['gen'] as number) : 1;
    this.detected = {
      generation: gen >= 2 ? 2 : 1,
      type: typeof j['type'] === 'string' ? j['type'] : undefined,
      mac: typeof j['mac'] === 'string' ? j['mac'] : undefined,
      model: typeof j['model'] === 'string' ? j['model'] : undefined,
      firmware: typeof j['fw'] === 'string' ? j['fw'] : typeof j['ver'] === 'string' ? (j['ver'] as string) : undefined,
      authEnabled: typeof j['auth'] === 'boolean' ? j['auth'] : undefined,
    };
    return this.detected;
  }

  private async rpc<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const { json } = await this.request('POST', '/rpc', JSON.stringify({ id: 1, method, params }));
    if (json && typeof json === 'object' && 'error' in json) {
      const err = (json as { error?: { message?: string } }).error;
      throw new ShellyError(`Shelly RPC ${method} failed: ${err?.message ?? 'unknown error'}`);
    }
    return (json as { result: T }).result;
  }

  /** Switch a relay on/off (or toggle on Gen1). Returns the fresh status. */
  async setRelay(relay: number, on: boolean): Promise<ShellyRelayStatus> {
    const info = await this.info();
    if (info.generation >= 2) {
      await this.rpc('Switch.Set', { id: relay, on });
    } else {
      await this.request('GET', `/relay/${relay}?turn=${on ? 'on' : 'off'}`);
    }
    return this.relayStatus(relay);
  }

  async toggleRelay(relay: number): Promise<ShellyRelayStatus> {
    const current = await this.relayStatus(relay);
    return this.setRelay(relay, !current.on);
  }

  /** Relay state + live metering. */
  async relayStatus(relay: number): Promise<ShellyRelayStatus> {
    const info = await this.info();
    if (info.generation >= 2) {
      const s = await this.rpc<Record<string, unknown>>('Switch.GetStatus', { id: relay });
      const aenergy = (s['aenergy'] as Record<string, unknown> | undefined) ?? {};
      return {
        relay,
        on: s['output'] === true,
        powerW: num(s['apower']),
        voltageV: num(s['voltage']),
        currentA: num(s['current']),
        energyWh: num(aenergy['total']),
        temperatureC: num((s['temperature'] as Record<string, unknown> | undefined)?.['tC']),
      };
    }
    const { json } = await this.request('GET', '/status');
    const j = (json ?? {}) as Record<string, unknown>;
    const relays = (j['relays'] as Array<Record<string, unknown>> | undefined) ?? [];
    const meters = (j['meters'] as Array<Record<string, unknown>> | undefined) ?? [];
    const r = relays[relay] ?? {};
    const m = meters[relay] ?? {};
    return {
      relay,
      on: r['ison'] === true,
      powerW: num(m['power']),
      energyWh: num(m['total']) !== undefined ? (num(m['total']) as number) / 60 : undefined, // Gen1 total is watt-minutes → Wh
      temperatureC: num(j['temperature']),
    };
  }

  /** Device config relevant to plug control (name + relay names). */
  async getConfig(relay: number): Promise<Record<string, unknown>> {
    const info = await this.info();
    if (info.generation >= 2) {
      const [sys, sw] = await Promise.all([
        this.rpc<Record<string, unknown>>('Sys.GetConfig'),
        this.rpc<Record<string, unknown>>('Switch.GetConfig', { id: relay }),
      ]);
      return { system: sys, switch: sw };
    }
    const { json } = await this.request('GET', '/settings');
    return (json ?? {}) as Record<string, unknown>;
  }

  /** Rename the device / a relay (the config write most automations need). */
  async setName(relay: number, name: string): Promise<void> {
    if (!name || name.length > 64) throw new Error('"name" must be 1-64 chars');
    const info = await this.info();
    if (info.generation >= 2) {
      await this.rpc('Switch.SetConfig', { id: relay, config: { name } });
    } else {
      await this.request('GET', `/settings/relay/${relay}?name=${encodeURIComponent(name)}`);
    }
  }

  /** Schedules (Gen2: full RPC; Gen1: read-only view + honest note). */
  async listSchedules(): Promise<{ schedules: ShellySchedule[]; editable: boolean; note?: string; rawSettings?: unknown }> {
    const info = await this.info();
    if (info.generation >= 2) {
      const r = await this.rpc<{ jobs: Array<Record<string, unknown>> }>('Schedule.List');
      return {
        schedules: (r.jobs ?? []).map((j) => ({
          id: Number(j['id']),
          enabled: j['enable'] === true,
          timespec: typeof j['timespec'] === 'string' ? j['timespec'] : undefined,
          calls: Array.isArray(j['calls']) ? j['calls'] : undefined,
        })),
        editable: true,
      };
    }
    const { json } = await this.request('GET', '/settings');
    const j = (json ?? {}) as Record<string, unknown>;
    return {
      schedules: [],
      editable: false,
      note: 'Gen1 Shelly schedules use per-relay schedule_rules in /settings; this client reports them raw instead of guessing an edit shape.',
      rawSettings: j,
    };
  }

  /** Create a Gen2 schedule that sets this relay at a cron-like timespec (e.g. "0 30 7 * * MON-FRI"). */
  async createSchedule(relay: number, timespec: string, on: boolean): Promise<{ id: number }> {
    const info = await this.info();
    if (info.generation < 2) {
      throw new ShellyError('schedule creation needs a Gen2+ Shelly (RPC Schedule.Create); Gen1 schedule editing is not supported by this client');
    }
    if (!timespec || timespec.length > 64) throw new Error('"timespec" must be 1-64 chars (e.g. "0 30 7 * * MON-FRI")');
    const r = await this.rpc<{ id: number }>('Schedule.Create', {
      enable: true,
      timespec,
      calls: [{ method: 'Switch.Set', params: { id: relay, on } }],
    });
    return { id: r.id };
  }

  async deleteSchedule(id: number): Promise<void> {
    const info = await this.info();
    if (info.generation < 2) throw new ShellyError('schedule deletion needs a Gen2+ Shelly');
    await this.rpc('Schedule.Delete', { id });
  }
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export interface ShellyToolDeps {
  /** Build a client per call (transport choice lives with the coordinator — proxy or direct). */
  createClient: (host: string) => ShellyClient;
  audit?: (action: string, fields: { actor?: string; toolName?: string; detail?: unknown; sessionId?: string }) => void;
  isPaused?: () => boolean;
}

const SHELLY_ACTIONS = ['info', 'status', 'on', 'off', 'toggle', 'set_name', 'get_config', 'list_schedules', 'create_schedule', 'delete_schedule'] as const;

export function createShellyTools(deps: ShellyToolDeps): ToolDefinition[] {
  return [
    {
      name: 'shelly_control',
      description:
        'Control a Shelly smart plug on the user\'s own network over its local HTTP API: on/off/toggle, live power metering (status), device/relay config + rename, and Gen2 schedules. Requires human approval. When wired through the DV-13 home proxy, first contact with the host also needs the one-time host grant.',
      parameters: {
        type: 'object',
        properties: {
          host: { type: 'string', description: 'Shelly host or host:port (e.g. 192.168.1.41)' },
          action: { type: 'string', enum: [...SHELLY_ACTIONS], description: 'What to do' },
          relay: { type: 'number', description: 'Relay index (default 0)' },
          name: { type: 'string', description: 'New name (set_name)' },
          timespec: { type: 'string', description: 'Schedule timespec like "0 30 7 * * MON-FRI" (create_schedule)' },
          on: { type: 'boolean', description: 'Target state for create_schedule' },
          scheduleId: { type: 'number', description: 'Schedule id (delete_schedule)' },
        },
        required: ['host', 'action'],
        additionalProperties: false,
      },
      handler: async (args, ctx: ToolContext) => {
        if (deps.isPaused?.()) throw new Error(`paused: ${PAUSED_MESSAGE}`);
        const host = args['host'];
        const action = args['action'];
        if (typeof host !== 'string' || !host) throw new Error('"host" is required');
        if (typeof action !== 'string' || !(SHELLY_ACTIONS as readonly string[]).includes(action)) {
          throw new Error(`"action" must be one of ${SHELLY_ACTIONS.join(' | ')}`);
        }
        const relay = typeof args['relay'] === 'number' ? Math.max(0, Math.floor(args['relay'])) : 0;
        const client = deps.createClient(host);
        let result: unknown;
        switch (action) {
          case 'info': result = await client.info(); break;
          case 'status': result = await client.relayStatus(relay); break;
          case 'on': result = await client.setRelay(relay, true); break;
          case 'off': result = await client.setRelay(relay, false); break;
          case 'toggle': result = await client.toggleRelay(relay); break;
          case 'get_config': result = await client.getConfig(relay); break;
          case 'set_name': {
            if (typeof args['name'] !== 'string') throw new Error('"name" is required for set_name');
            await client.setName(relay, args['name']);
            result = { ok: true };
            break;
          }
          case 'list_schedules': result = await client.listSchedules(); break;
          case 'create_schedule': {
            if (typeof args['timespec'] !== 'string') throw new Error('"timespec" is required for create_schedule');
            result = await client.createSchedule(relay, args['timespec'], args['on'] !== false);
            break;
          }
          case 'delete_schedule': {
            if (typeof args['scheduleId'] !== 'number') throw new Error('"scheduleId" is required for delete_schedule');
            await client.deleteSchedule(Math.floor(args['scheduleId']));
            result = { ok: true };
            break;
          }
        }
        try {
          deps.audit?.('shelly.control', {
            actor: ctx.botId, toolName: 'shelly_control', sessionId: ctx.sessionId,
            detail: { host, action, relay },
          });
        } catch { /* audit must never break the tool */ }
        return { ok: true, host, action, result };
      },
    } satisfies ToolDefinition,
  ];
}

export function registerShellyTools(registry: Map<string, ToolDefinition>, deps: ShellyToolDeps): void {
  for (const tool of createShellyTools(deps)) {
    if (!registry.has(tool.name)) registry.set(tool.name, tool);
  }
}
